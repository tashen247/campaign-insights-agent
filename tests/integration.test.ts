import fs from "node:fs";
import path from "node:path";
import { describe, expect, it } from "vitest";
import { runAgent } from "../src/agent/runner.js";
import { readTrace } from "../src/trace/logger.js";
import { OfflineDriver } from "../src/agent/drivers/offline.js";
import type { AgentDriver, DriverInput } from "../src/agent/drivers/types.js";
import { grade, type EvalCase } from "../evals/grade.js";
import { REPO, tmpConfig } from "./helpers.js";

const cases = fs
  .readdirSync(path.join(REPO, "evals/cases"))
  .map((f) => JSON.parse(fs.readFileSync(path.join(REPO, "evals/cases", f), "utf8")) as EvalCase);

describe("full offline runs (recorded-model stub)", () => {
  it.each(cases.map((c) => [c.scenario, c] as const))("%s passes every eval check", async (_s, c) => {
    const cfg = tmpConfig();
    const o = await runAgent({ brief: c.brief, scenario: c.scenario, offline: true, cfg, quiet: true, runId: `it-${c.scenario.replace(/_/g, "-")}` });
    const failed = grade(o, c, cfg.maxBudgetUsd, cfg.maxAsanaTasks).filter((x) => !x.pass);
    expect(failed).toEqual([]);
  });

  it("writes the trace in the right order and all outputs to disk", async () => {
    const cfg = tmpConfig();
    const o = await runAgent({ brief: "Why did installs drop last week?", offline: true, cfg, quiet: true, runId: "it-order" });
    const ev = readTrace(path.join(o.runDir, "trace.jsonl"));
    const types = ev.map((e) => e.type);
    expect(types[0]).toBe("run_start");
    expect(types.at(-1)).toBe("final");
    expect(ev.find((e) => e.type === "tool_call")?.tool).toBe("submit_plan");
    expect(types.indexOf("plan")).toBeLessThan(types.findIndex((t, i) => t === "tool_call" && ev[i].tool !== "submit_plan"));
    expect(types.indexOf("cost")).toBeLessThan(types.indexOf("final"));
    for (const f of ["report.md", "report.json", "state.json", "status.json", "side_effects.json", "asana.json", "slack.json"]) expect(fs.existsSync(path.join(o.runDir, f))).toBe(true);
    expect(o.state.tasks.length).toBeGreaterThanOrEqual(3);
    expect(o.report.recommendations.length).toBeGreaterThanOrEqual(3);
    // recall: the seeded memory has a Meta install drop from 2026-09-14
    expect(o.report.diagnosis).toContain("2026-09-14");
    // cross-run memory: this run's anomalies are now recallable
    expect(fs.readFileSync(path.join(cfg.memoryDir, "insights.jsonl"), "utf8")).toContain("it-order");
  });

  it("re-running the same runId does not create duplicate tasks or posts", async () => {
    const cfg = tmpConfig();
    await runAgent({ brief: "Why did installs drop last week?", offline: true, cfg, quiet: true, runId: "it-idem" });
    await runAgent({ brief: "Why did installs drop last week?", offline: true, cfg, quiet: true, runId: "it-idem" });
    const dir = path.join(cfg.runsDir, "it-idem");
    expect(JSON.parse(fs.readFileSync(path.join(dir, "asana.json"), "utf8"))).toHaveLength(3);
    expect(JSON.parse(fs.readFileSync(path.join(dir, "slack.json"), "utf8"))).toHaveLength(1);
  });

  it("stops cleanly at the tool-call cap and says so in the report", async () => {
    const cfg = tmpConfig({ maxToolCalls: 6 });
    const o = await runAgent({ brief: "Why did installs drop last week?", offline: true, cfg, quiet: true, runId: "it-cap" });
    expect(o.status).toBe("stopped");
    expect(o.report.limitations.join(" ")).toMatch(/Tool-call cap reached \(6\)/);
    expect(fs.readFileSync(path.join(o.runDir, "report.md"), "utf8")).toMatch(/Tool-call cap/);
  });

  it("reports a maxTurns / budget stop from the SDK", async () => {
    for (const [subtype, text] of [["error_max_turns", /maxTurns/], ["error_max_budget_usd", /maxBudgetUsd/]] as const) {
      const driver: AgentDriver = { name: "fake", model: "fake", run: async () => ({ structured: null, subtype, costUsd: 0.5, numTurns: 20 }) };
      const o = await runAgent({ brief: "b?", cfg: tmpConfig(), driver, quiet: true });
      expect(o.status).toBe("stopped");
      expect(o.report.limitations.join(" ")).toMatch(text);
    }
  });

  it("drops recommendations that cite findings the run never produced", async () => {
    const offline = new OfflineDriver();
    const driver: AgentDriver = {
      name: "tampered",
      model: null,
      async run(input: DriverInput) {
        const r = await offline.run(input);
        const s = r.structured as { recommendations: { finding_ids: string[]; title: string }[] };
        s.recommendations.push({ ...s.recommendations[0], title: "Invented", finding_ids: ["F-made-up-wow"] });
        return r;
      },
    };
    const o = await runAgent({ brief: "Why did installs drop last week?", cfg: tmpConfig(), driver, quiet: true });
    expect(o.status).toBe("succeeded_with_warnings");
    expect(o.report.recommendations.map((r) => r.title)).not.toContain("Invented");
    expect(o.warnings.join(" ")).toMatch(/F-made-up-wow/);
  });

  it("refuses a live run without an API key", async () => {
    await expect(runAgent({ brief: "b?", cfg: tmpConfig({ anthropicApiKey: undefined }) })).rejects.toThrow(/ANTHROPIC_API_KEY/);
  });
});
