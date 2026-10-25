import { describe, expect, it } from "vitest";
import { analyze, AnalysisError, metricValue } from "../src/analysis/metrics.js";
import { addDays } from "../src/util/dates.js";
import type { FactRow, SignupRow } from "../src/types.js";

/** 6 weeks of flat data for two networks, with optional per-day overrides. */
function facts(over: (net: string, day: number) => Partial<FactRow> = () => ({})): FactRow[] {
  const rows: FactRow[] = [];
  for (let d = 0; d < 42; d++) {
    for (const net of ["Meta", "Google"]) {
      const wiggle = 1 + ((d * 7 + (net === "Meta" ? 3 : 5)) % 5) / 100; // tiny deterministic noise
      rows.push({ date: addDays("2026-09-07", d), network: net, campaign_id: `c-${net}`, geo: "ZA", creative_id: `cr-${net}`, impressions: 10000, clicks: Math.round(200 * wiggle), installs: Math.round(50 * wiggle), spend: 100, ...over(net, d) });
    }
  }
  return rows;
}

describe("metricValue", () => {
  it("derives ratios and guards zero denominators", () => {
    const s = { impressions: 1000, clicks: 50, installs: 10, spend: 25, signups: 4 };
    expect(metricValue("cpi", s)).toBe(2.5);
    expect(metricValue("cvr", s)).toBe(0.2);
    expect(metricValue("ctr", s)).toBe(0.05);
    expect(metricValue("signup_rate", s)).toBe(0.4);
    expect(metricValue("cpi", { ...s, installs: 0 })).toBeNull();
  });
});

describe("analyze (week over week)", () => {
  it("computes deltas, pct change and flags a planted drop", () => {
    const rows = facts((net, d) => (net === "Meta" && d >= 35 ? { installs: 25 } : {}));
    const out = analyze({ facts: rows, signups: [], campaigns: [], metric: "installs", groupBy: "network", compare: "wow" });
    expect(out.current_window).toEqual({ since: "2026-10-12", until: "2026-10-18" });
    expect(out.previous_window).toEqual({ since: "2026-10-05", until: "2026-10-11" });
    const meta = out.segments.find((s) => s.segment === "Meta")!;
    expect(meta.finding_id).toBe("F-installs-network-Meta-wow");
    expect(meta.current).toBe(175);
    expect(meta.pct_change).toBeLessThan(-0.45);
    expect(meta.anomaly).toBe(true);
    expect(meta.z!).toBeLessThan(-3);
    expect(meta.display.pct_change).toMatch(/^-\d+\.\d%$/);
    const google = out.segments.find((s) => s.segment === "Google")!;
    expect(google.anomaly).toBe(false);
    expect(out.segments[0].segment).toBe("Meta"); // ranked first
    expect(out.anomalies).toEqual(["F-installs-network-Meta-wow"]);
  });

  it("z-score uses trailing weekly history", () => {
    const rows = facts();
    const out = analyze({ facts: rows, signups: [], campaigns: [], metric: "installs", groupBy: "network", compare: "wow" });
    for (const s of out.segments) {
      expect(s.anomaly).toBe(false);
      expect(Math.abs(s.pct_change!)).toBeLessThan(0.1);
    }
  });

  it("flags a zero-run as a likely tracking problem", () => {
    const rows = facts((net, d) => (net === "Google" && d >= 38 && d <= 40 ? { installs: 0 } : {}));
    const out = analyze({ facts: rows, signups: [], campaigns: [], metric: "installs", groupBy: "network", compare: "wow" });
    const g = out.segments.find((s) => s.segment === "Google")!;
    expect(g.flags).toContain("zero_run");
    expect(g.anomaly).toBe(true);
  });

  it("flags a sustained decline", () => {
    const factor = [1, 1, 1, 0.85, 0.65, 0.4];
    const rows = facts((net, d) => (net === "Meta" ? { clicks: Math.round(200 * factor[Math.floor(d / 7)]) } : {}));
    const out = analyze({ facts: rows, signups: [], campaigns: [], metric: "ctr", groupBy: "network", compare: "wow" });
    expect(out.segments.find((s) => s.segment === "Meta")!.flags).toContain("sustained_decline");
  });

  it("is deterministic", () => {
    const rows = facts((net, d) => (net === "Meta" && d >= 35 ? { installs: 25 } : {}));
    const a = analyze({ facts: rows, signups: [], campaigns: [], metric: "cpi", groupBy: "network", compare: "wow" });
    const b = analyze({ facts: rows, signups: [], campaigns: [], metric: "cpi", groupBy: "network", compare: "wow" });
    expect(a).toEqual(b);
  });

  it("supports day over day", () => {
    const out = analyze({ facts: facts(), signups: [], campaigns: [], metric: "installs", groupBy: "network", compare: "dod" });
    expect(out.current_window).toEqual({ since: "2026-10-18", until: "2026-10-18" });
    expect(out.segments[0].finding_id).toMatch(/-dod$/);
  });

  it("joins HubSpot sign-ups for signup_rate by network", () => {
    const rows = facts();
    const signups: SignupRow[] = rows.map((r) => ({ date: r.date, campaign_id: r.campaign_id, signups: 10 }));
    const merged = new Map<string, SignupRow>();
    for (const s of signups) merged.set(`${s.date}|${s.campaign_id}`, s);
    const out = analyze({ facts: rows, signups: [...merged.values()], campaigns: [{ id: "c-Meta", name: "Meta", network: "Meta", owner: "x" }, { id: "c-Google", name: "G", network: "Google", owner: "x" }], metric: "signup_rate", groupBy: "network", compare: "wow" });
    expect(out.segments.map((s) => s.segment).sort()).toEqual(["Google", "Meta"]);
    expect(out.total.current).toBeGreaterThan(0);
  });

  it("refuses impossible requests with a clear error", () => {
    expect(() => analyze({ facts: facts(), signups: [], campaigns: [], metric: "signups", groupBy: "geo", compare: "wow" })).toThrow(AnalysisError);
    expect(() => analyze({ facts: [], signups: [], campaigns: [], metric: "installs", groupBy: "geo", compare: "wow" })).toThrow(/load_ad_spend_csv/);
    expect(() => analyze({ facts: facts(), signups: [], campaigns: [], metric: "installs", groupBy: "geo", compare: "wow", until: "2027-01-01" })).toThrow(/outside/);
  });
});
