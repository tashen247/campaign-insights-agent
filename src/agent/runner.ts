import fs from "node:fs";
import path from "node:path";
import crypto from "node:crypto";
import { loadConfig, type Config } from "../config.js";
import { createAdapters, ConfigError } from "../adapters/index.js";
import { fetchWithRetry } from "../adapters/retry.js";
import { Ledger } from "../adapters/ledger.js";
import { TraceLogger, type TraceEvent } from "../trace/logger.js";
import { InsightMemory } from "../memory/store.js";
import { TOOL_DEFS } from "../tools/index.js";
import type { Owners, ToolContext } from "../tools/context.js";
import { createGuardrails } from "./hooks.js";
import { systemPrompt, userPrompt } from "./prompts.js";
import { fallbackReport, renderMarkdown, reportJsonSchema, reportText, validateReport, type Report } from "./report.js";
import { crossCheckNumbers } from "../analysis/numbers.js";
import { OfflineDriver } from "./drivers/offline.js";
import { SdkDriver } from "./drivers/sdk.js";
import type { AgentDriver, DriverResult } from "./drivers/types.js";
import type { RunState } from "../types.js";

export type RunStatus = "running" | "succeeded" | "succeeded_with_warnings" | "stopped" | "failed";

export interface RunOptions {
  brief: string;
  requestedBy?: string;
  scenario?: string;
  offline?: boolean;
  runId?: string;
  callbackUrl?: string;
  cfg?: Config;
  driver?: AgentDriver;
  quiet?: boolean;
  onEvent?: (e: TraceEvent) => void;
}

export interface RunOutcome {
  runId: string;
  status: RunStatus;
  runDir: string;
  report: Report;
  costUsd: number;
  numTurns: number;
  reportUrl: string;
  driver: string;
  warnings: string[];
  numberCheck: { checked: number; unverified: string[]; approximations: string[] };
  state: RunState;
}

export const newRunId = () => {
  const d = new Date().toISOString().replace(/[-:]/g, "").replace("T", "-").slice(0, 15);
  return `${d}-${crypto.randomBytes(2).toString("hex")}`;
};

export function writeStatus(runDir: string, data: Record<string, unknown>) {
  fs.writeFileSync(path.join(runDir, "status.json"), JSON.stringify({ updatedAt: new Date().toISOString(), ...data }, null, 2));
}

export function pickDriver(cfg: Config, offline: boolean): AgentDriver {
  if (offline) return new OfflineDriver();
  if (!cfg.anthropicApiKey) throw new ConfigError("ANTHROPIC_API_KEY is not set. Set it, or run with --offline for the model-free baseline.");
  return new SdkDriver(cfg.model);
}

export async function runAgent(opts: RunOptions): Promise<RunOutcome> {
  const cfg = opts.cfg ?? loadConfig();
  const scenario = opts.scenario ?? cfg.scenario;
  const runId = opts.runId ?? newRunId();
  if (!/^[A-Za-z0-9_-]{4,64}$/.test(runId)) throw new ConfigError("runId must be 4-64 characters of letters, digits, - or _.");
  const driver = opts.driver ?? pickDriver(cfg, !!opts.offline);
  const runDir = path.join(cfg.runsDir, runId);
  fs.mkdirSync(runDir, { recursive: true });

  const logger = new TraceLogger(runId, path.join(runDir, "trace.jsonl"), opts.onEvent ?? null);
  const state: RunState = {
    runId,
    brief: opts.brief,
    requestedBy: opts.requestedBy ?? "cli",
    plan: null,
    planRevisions: 0,
    datasets: {},
    facts: [],
    signups: [],
    campaigns: [],
    findings: {},
    tasks: [],
    slack: null,
    toolCalls: 0,
    stopReason: null,
  };
  const retry = { onRetry: (i: { attempt: number; status: number | null; delayMs: number; error?: string }) => logger.log("retry", { source: "adapter", ...i }) };
  const adapters = createAdapters(cfg, runDir, retry, { scenario, quiet: opts.quiet });
  const ownersFile = path.join(cfg.root, "config", "owners.json");
  const owners: Owners = fs.existsSync(ownersFile) ? JSON.parse(fs.readFileSync(ownersFile, "utf8")) : {};
  const reportUrl = `${cfg.publicBaseUrl}/runs/${runId}/report`;
  const memory = new InsightMemory(cfg.memoryDir);
  const ctx: ToolContext = { cfg, state, adapters, ledger: new Ledger(path.join(runDir, "side_effects.json")), logger, memory, owners, runDir, reportUrl };
  const guardrails = createGuardrails(ctx);

  writeStatus(runDir, { runId, status: "running", brief: opts.brief });
  logger.log("run_start", { brief: opts.brief, requestedBy: state.requestedBy, driver: driver.name, model: driver.model, scenario, mockMode: cfg.mockMode, limits: { maxTurns: cfg.maxTurns, maxBudgetUsd: cfg.maxBudgetUsd, maxToolCalls: cfg.maxToolCalls, maxAsanaTasks: cfg.maxAsanaTasks } });

  let result: DriverResult;
  try {
    result = await driver.run({ cfg, systemPrompt: systemPrompt(cfg), userPrompt: userPrompt(opts.brief, state.requestedBy, reportUrl), toolDefs: TOOL_DEFS, ctx, guardrails, outputSchema: reportJsonSchema() });
  } catch (e) {
    logger.log("error", { message: (e as Error).message ?? String(e) });
    result = { structured: null, subtype: "driver_error", costUsd: 0, numTurns: 0, error: (e as Error).message ?? String(e) };
  }
  logger.log("cost", { total_cost_usd: result.costUsd, num_turns: result.numTurns, subtype: result.subtype });

  // Build the report: validated model output, or a fallback straight from state.
  const warnings: string[] = [];
  const limitReasons: Record<string, string> = {
    error_max_turns: `Stopped at maxTurns (${cfg.maxTurns}).`,
    error_max_budget_usd: `Stopped at maxBudgetUsd ($${cfg.maxBudgetUsd.toFixed(2)}).`,
    error_max_structured_output_retries: "The model could not produce a valid structured report.",
    stopped_by_guardrail: state.stopReason ?? "Stopped by a guardrail.",
  };
  let report: Report;
  const validated = result.structured ? validateReport(result.structured, state) : null;
  if (validated) {
    report = validated.report;
    warnings.push(...validated.problems);
  } else {
    const reason = limitReasons[result.subtype] ?? state.stopReason ?? (result.error ? `Run error: ${result.error}` : "No valid structured report was returned.");
    report = fallbackReport(state, reason);
  }
  if (state.stopReason && !report.limitations.includes(state.stopReason)) report.limitations.push(state.stopReason);
  if (warnings.length) report.limitations.push(...warnings);

  const sources = [
    opts.brief,
    ...logger.events.filter((e) => e.type === "tool_result" && e.ok).map((e) => JSON.stringify(e.result)),
    ...Object.values(state.findings).map((f) => JSON.stringify(f)),
  ];
  const numberCheck = crossCheckNumbers(reportText(report), sources);
  if (numberCheck.unverified.length) warnings.push(`Unverified numbers: ${numberCheck.unverified.join(", ")}`);

  let status: RunStatus;
  if ((result.subtype === "driver_error" || result.error) && !validated && Object.keys(state.findings).length === 0) status = "failed";
  else if (!validated) status = "stopped";
  else status = warnings.length ? "succeeded_with_warnings" : "succeeded";

  const meta = { runId, status, driver: driver.name, model: driver.model, scenario, costUsd: result.costUsd, numTurns: result.numTurns, toolCalls: state.toolCalls, reportUrl, numberCheck };
  fs.writeFileSync(path.join(runDir, "report.json"), JSON.stringify({ ...meta, report, tasks: state.tasks, slack: state.slack, warnings }, null, 2));
  fs.writeFileSync(path.join(runDir, "report.md"), renderMarkdown(report, state, meta));
  const { facts: _f, signups: _s, ...slim } = state;
  void _f;
  void _s;
  fs.writeFileSync(path.join(runDir, "state.json"), JSON.stringify(slim, null, 2));
  memory.appendFindings(runId, Object.values(state.findings));

  logger.log("final", { status, headline: report.headline, tasks: state.tasks.length, slack: !!state.slack, warnings });
  writeStatus(runDir, { runId, status, headline: report.headline, reportUrl, costUsd: result.costUsd });

  if (opts.callbackUrl) {
    try {
      await fetchWithRetry(
        () => fetch(opts.callbackUrl!, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ runId, status, headline: report.headline, reportUrl, costUsd: result.costUsd, tasks: state.tasks.length }) }),
        retry,
      );
    } catch (e) {
      logger.log("error", { message: `callback failed: ${(e as Error).message}` });
    }
  }

  return { runId, status, runDir, report, costUsd: result.costUsd, numTurns: result.numTurns, reportUrl, driver: driver.name, warnings, numberCheck, state };
}
