#!/usr/bin/env tsx
/**
 *   npm run demo -- "Why did installs drop last week?" [--offline] [--scenario meta_install_drop] [--quiet]
 *   npm run trace <runId>
 */
import fs from "node:fs";
import path from "node:path";
import { loadConfig } from "./config.js";
import { runAgent } from "./agent/runner.js";
import { readTrace } from "./trace/logger.js";
import { describe, formatTimeline } from "./trace/print.js";

function parseArgs(argv: string[]) {
  const flags: Record<string, string | boolean> = {};
  const positional: string[] = [];
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    if (a.startsWith("--")) {
      const [k, v] = a.slice(2).split("=");
      if (v !== undefined) flags[k] = v;
      else if (argv[i + 1] && !argv[i + 1].startsWith("--") && ["scenario", "run-id", "requested-by"].includes(k)) flags[k] = argv[++i];
      else flags[k] = true;
    } else positional.push(a);
  }
  return { flags, positional };
}

async function main() {
  const [cmd, ...rest] = process.argv.slice(2);
  const { flags, positional } = parseArgs(rest);
  const cfg = loadConfig();

  if (cmd === "trace") {
    const id = positional[0] ?? latestRun(cfg.runsDir);
    if (!id) throw new Error("usage: npm run trace <runId>");
    const file = path.join(cfg.runsDir, id, "trace.jsonl");
    if (!fs.existsSync(file)) throw new Error(`no trace at ${file}`);
    console.log(formatTimeline(readTrace(file)));
    return;
  }

  if (cmd === "demo") {
    const brief = positional.join(" ") || "Why did installs drop last week?";
    const quiet = !!flags.quiet;
    const outcome = await runAgent({
      brief,
      requestedBy: (flags["requested-by"] as string) ?? "cli",
      offline: !!flags.offline,
      scenario: flags.scenario as string | undefined,
      runId: flags["run-id"] as string | undefined,
      cfg,
      quiet,
      onEvent: quiet ? undefined : (e) => console.log(`${String(e.t_ms).padStart(6)}ms  ${describe(e)}`),
    });
    console.log(`\n${outcome.status.toUpperCase()} · ${outcome.report.headline}`);
    console.log(`report: ${path.relative(process.cwd(), path.join(outcome.runDir, "report.md"))}`);
    console.log(`trace:  npm run trace ${outcome.runId}`);
    console.log(`cost:   $${outcome.costUsd.toFixed(4)} · ${outcome.numTurns} turns · ${outcome.state.toolCalls} tool calls`);
    if (outcome.status === "failed") process.exitCode = 1;
    return;
  }

  console.log('usage:\n  npm run demo -- "<brief>" [--offline] [--scenario <name>]\n  npm run trace <runId>');
  process.exitCode = 1;
}

function latestRun(dir: string): string | undefined {
  if (!fs.existsSync(dir)) return undefined;
  return fs
    .readdirSync(dir)
    .filter((d) => fs.existsSync(path.join(dir, d, "trace.jsonl")))
    .sort()
    .pop();
}

main().catch((e) => {
  console.error(`error: ${(e as Error).message}`);
  process.exitCode = 1;
});
