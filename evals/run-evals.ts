/**
 *   npm run eval                     live model, 3 repeats per scenario  -> evals/results.md
 *   npm run eval -- --offline        deterministic baseline, 1 repeat    -> evals/results-offline.md
 *   npm run eval -- --repeat 5 --scenario geo_cpi_spike
 * Target: at least 5 of 6 scenarios pass every check on every repeat.
 */
import fs from "node:fs";
import path from "node:path";
import { loadConfig } from "../src/config.js";
import { runAgent } from "../src/agent/runner.js";
import { grade, type Check, type EvalCase } from "./grade.js";

const argv = process.argv.slice(2);
const offline = argv.includes("--offline");
const flag = (k: string) => {
  const i = argv.indexOf(`--${k}`);
  return i >= 0 ? argv[i + 1] : undefined;
};
const repeat = Number(flag("repeat") ?? (offline ? 1 : 3));
const only = flag("scenario");
const TARGET = 5;

async function main() {
  const cfg = loadConfig();
  const dir = path.join(cfg.root, "evals", "cases");
  const cases = fs
    .readdirSync(dir)
    .filter((f) => f.endsWith(".json"))
    .map((f) => JSON.parse(fs.readFileSync(path.join(dir, f), "utf8")) as EvalCase)
    .filter((c) => !only || c.scenario === only)
    .sort((a, b) => a.scenario.localeCompare(b.scenario));

  const rows: { scenario: string; passes: number; runs: number; cost: number[]; turns: number[]; failed: string[] }[] = [];
  for (const c of cases) {
    const row = { scenario: c.scenario, passes: 0, runs: 0, cost: [] as number[], turns: [] as number[], failed: [] as string[] };
    for (let i = 1; i <= repeat; i++) {
      const runId = `eval-${c.scenario.replace(/_/g, "-")}-${i}-${Date.now().toString(36)}`;
      const o = await runAgent({ brief: c.brief, scenario: c.scenario, offline, runId, cfg, quiet: true });
      const checks: Check[] = grade(o, c, cfg.maxBudgetUsd, cfg.maxAsanaTasks);
      const ok = checks.every((x) => x.pass);
      row.runs += 1;
      row.passes += ok ? 1 : 0;
      row.cost.push(o.costUsd);
      row.turns.push(o.numTurns);
      for (const x of checks.filter((x) => !x.pass)) row.failed.push(`${x.name}${x.detail ? ` (${x.detail})` : ""}`);
      console.log(`${ok ? "PASS" : "FAIL"} ${c.scenario} #${i} ${runId}${ok ? "" : " → " + checks.filter((x) => !x.pass).map((x) => x.name).join(", ")}`);
    }
    rows.push(row);
  }

  const avg = (xs: number[]) => (xs.length ? xs.reduce((a, b) => a + b, 0) / xs.length : 0);
  const fully = rows.filter((r) => r.passes === r.runs).length;
  const md = [
    `# Eval results (${offline ? "offline baseline, no model" : `live model: ${cfg.model}`})`,
    "",
    `Generated ${new Date().toISOString()} · ${repeat} repeat(s) per scenario · target ≥ ${TARGET} of 6 scenarios passing every repeat.`,
    "",
    "| Scenario | Pass rate | Avg cost | Avg turns | Failed checks |",
    "|---|---|---|---|---|",
    ...rows.map((r) => `| ${r.scenario} | ${r.passes}/${r.runs} | $${avg(r.cost).toFixed(4)} | ${avg(r.turns).toFixed(1)} | ${[...new Set(r.failed)].join("; ") || "—"} |`),
    "",
    `**${fully} of ${rows.length} scenarios passed every repeat.** Checks: completed, plan_first, root_cause_top2 (or no_anomaly_called), recommendations_cited, min_recommendations, task_cap, slack_once, ignored_injection, no_invented_numbers, under_budget.`,
    "",
  ].join("\n");
  const out = path.join(cfg.root, "evals", offline ? "results-offline.md" : "results.md");
  fs.writeFileSync(out, md);
  console.log(`\n${fully}/${rows.length} scenarios fully passing → ${path.relative(cfg.root, out)}`);
  if (!only && fully < Math.min(TARGET, rows.length)) process.exitCode = 1;
}

main().catch((e) => {
  console.error(e);
  process.exitCode = 1;
});
