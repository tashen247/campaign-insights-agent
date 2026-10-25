import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { loadConfig, type Config } from "../src/config.js";
import { createAdapters } from "../src/adapters/index.js";
import { Ledger } from "../src/adapters/ledger.js";
import { TraceLogger } from "../src/trace/logger.js";
import { InsightMemory } from "../src/memory/store.js";
import type { ToolContext } from "../src/tools/context.js";
import type { RunState } from "../src/types.js";

export const REPO = path.resolve(import.meta.dirname, "..");

export function tmpConfig(over: Partial<Config> = {}): Config {
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), "cia-"));
  fs.mkdirSync(path.join(tmp, "memory"), { recursive: true });
  fs.copyFileSync(path.join(REPO, "memory", "seed.jsonl"), path.join(tmp, "memory", "seed.jsonl"));
  return loadConfig({ root: REPO, runsDir: path.join(tmp, "runs"), memoryDir: path.join(tmp, "memory"), ...over }, {} as NodeJS.ProcessEnv);
}

export function emptyState(runId = "test-run"): RunState {
  return { runId, brief: "test", requestedBy: "test", plan: null, planRevisions: 0, datasets: {}, facts: [], signups: [], campaigns: [], findings: {}, tasks: [], slack: null, toolCalls: 0, stopReason: null };
}

export function makeCtx(over: Partial<Config> = {}, scenario = "meta_install_drop"): ToolContext {
  const cfg = tmpConfig(over);
  const runDir = path.join(cfg.runsDir, "test-run");
  fs.mkdirSync(runDir, { recursive: true });
  const logger = new TraceLogger("test-run", path.join(runDir, "trace.jsonl"));
  return {
    cfg,
    state: emptyState(),
    adapters: createAdapters(cfg, runDir, {}, { scenario, quiet: true }),
    ledger: new Ledger(path.join(runDir, "side_effects.json")),
    logger,
    memory: new InsightMemory(cfg.memoryDir),
    owners: { ua: { name: "UA", asanaAssigneeGid: null }, creative: { name: "Creative", asanaAssigneeGid: null }, analytics: { name: "Analytics", asanaAssigneeGid: null } },
    runDir,
    reportUrl: "http://localhost:3000/runs/test-run/report",
  };
}
