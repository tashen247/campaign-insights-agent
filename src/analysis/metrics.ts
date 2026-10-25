/**
 * Deterministic analysis. All maths lives here; the model only interprets the output.
 * Pure functions: same inputs, same findings, same finding_ids.
 */
import { mean, sampleStandardDeviation } from "simple-statistics";
import type { Campaign, Compare, FactRow, Finding, FindingFlag, GroupBy, Metric, SignupRow, Window } from "../types.js";
import { fmtDelta, fmtPct, fmtValue, fmtZ, slug } from "./format.js";
import { addDays } from "../util/dates.js";

export class AnalysisError extends Error {}

export const THRESHOLDS = {
  minAbsPct: 0.2, // a change must be at least 20% to count
  minAbsZ: 3, // ...and at least 3 standard deviations from trailing history
  bigPctWithoutHistory: 0.5,
  zeroRunDays: 2,
  sustainedDeclineWeeks: 3,
  sustainedDeclineTotal: -0.2,
};

const COUNT_METRICS: Metric[] = ["installs", "signups"];
const SIGNUP_METRICS: Metric[] = ["signups", "signup_rate"];

interface Sums {
  impressions: number;
  clicks: number;
  installs: number;
  spend: number;
  signups: number;
}
const zero = (): Sums => ({ impressions: 0, clicks: 0, installs: 0, spend: 0, signups: 0 });

export function metricValue(metric: Metric, s: Sums): number | null {
  switch (metric) {
    case "installs":
      return s.installs;
    case "spend":
      return s.spend;
    case "signups":
      return s.signups;
    case "cpi":
      return s.installs > 0 ? s.spend / s.installs : null;
    case "cvr":
      return s.clicks > 0 ? s.installs / s.clicks : null;
    case "ctr":
      return s.impressions > 0 ? s.clicks / s.impressions : null;
    case "signup_rate":
      return s.installs > 0 ? s.signups / s.installs : null;
  }
}

export interface AnalyzeInput {
  facts: FactRow[];
  signups: SignupRow[];
  campaigns: Campaign[];
  metric: Metric;
  groupBy: GroupBy;
  compare: Compare;
  until?: string;
}

export interface AnalyzeOutput {
  metric: Metric;
  groupBy: GroupBy;
  compare: Compare;
  current_window: Window;
  previous_window: Window;
  thresholds: typeof THRESHOLDS;
  total: Finding;
  segments: Finding[];
  anomalies: string[];
}

function segKey(groupBy: GroupBy, f: FactRow): string {
  switch (groupBy) {
    case "network":
      return f.network;
    case "campaign":
      return f.campaign_id;
    case "geo":
      return f.geo;
    case "creative":
      return f.creative_id;
  }
}

class Index {
  private m = new Map<string, Sums>();
  add(seg: string, date: string, part: Partial<Sums>) {
    const k = seg + "\u0000" + date;
    let s = this.m.get(k);
    if (!s) this.m.set(k, (s = zero()));
    for (const [key, v] of Object.entries(part)) s[key as keyof Sums] += v as number;
  }
  sum(seg: string, w: Window): Sums {
    const out = zero();
    for (let d = w.since; d <= w.until; d = addDays(d, 1)) {
      const s = this.m.get(seg + "\u0000" + d);
      if (s) for (const k of Object.keys(out) as (keyof Sums)[]) out[k] += s[k];
    }
    return out;
  }
}

function windows(compare: Compare, until: string, minDate: string) {
  const span = compare === "wow" ? 7 : 1;
  const cur: Window = { since: addDays(until, -(span - 1)), until };
  const prev: Window = { since: addDays(cur.since, -span), until: addDays(cur.since, -1) };
  const history: Window[] = [];
  const maxHist = compare === "wow" ? 12 : 28;
  for (let k = 1; k <= maxHist; k++) {
    const w: Window = { since: addDays(cur.since, -span * k), until: addDays(cur.until, -span * k) };
    if (w.since < minDate) break;
    history.push(w);
  }
  return { cur, prev, history };
}

export function analyze(input: AnalyzeInput): AnalyzeOutput {
  const { facts, signups, campaigns, metric, groupBy, compare } = input;
  const needsSignups = SIGNUP_METRICS.includes(metric);
  const needsFacts = metric !== "signups";
  if (needsSignups && (groupBy === "geo" || groupBy === "creative")) {
    throw new AnalysisError(`${metric} comes from HubSpot sign-ups, which are per campaign. Use groupBy "network" or "campaign".`);
  }
  if (needsFacts && facts.length === 0) throw new AnalysisError("Attribution data not loaded. Call load_ad_spend_csv first.");
  if (needsSignups && signups.length === 0) throw new AnalysisError("HubSpot sign-ups not loaded. Call get_campaign_metrics first.");

  const netOf = new Map(campaigns.map((c) => [c.id, c.network]));
  const labelOf = new Map(campaigns.map((c) => [c.id, c.name]));
  for (const f of facts) if (!netOf.has(f.campaign_id)) netOf.set(f.campaign_id, f.network);

  const idx = new Index();
  const segs = new Set<string>();
  let maxDate = "";
  let minDate = "9999-99-99";
  for (const f of facts) {
    const s = segKey(groupBy, f);
    segs.add(s);
    const part = { impressions: f.impressions, clicks: f.clicks, installs: f.installs, spend: f.spend };
    idx.add(s, f.date, part);
    idx.add("ALL", f.date, part);
    if (f.date > maxDate) maxDate = f.date;
    if (f.date < minDate) minDate = f.date;
  }
  if (needsSignups) {
    for (const r of signups) {
      const s = groupBy === "campaign" ? r.campaign_id : netOf.get(r.campaign_id) ?? "unknown";
      segs.add(s);
      idx.add(s, r.date, { signups: r.signups });
      idx.add("ALL", r.date, { signups: r.signups });
      if (!needsFacts) {
        if (r.date > maxDate) maxDate = r.date;
        if (r.date < minDate) minDate = r.date;
      }
    }
  }

  const until = input.until ?? maxDate;
  if (input.until && (input.until > maxDate || input.until < minDate)) {
    throw new AnalysisError(`until=${input.until} is outside the loaded data (${minDate}..${maxDate}).`);
  }
  const { cur, prev, history } = windows(compare, until, minDate);
  if (prev.since < minDate) throw new AnalysisError(`Not enough history before ${cur.since} for a ${compare} comparison.`);

  const build = (seg: string, gb: GroupBy | "total"): Finding => {
    const c = metricValue(metric, idx.sum(seg, cur));
    const p = metricValue(metric, idx.sum(seg, prev));
    const hist = history.map((w) => metricValue(metric, idx.sum(seg, w))).filter((v): v is number => v !== null);
    let z: number | null = null;
    if (c !== null && hist.length >= 3) {
      const sd = sampleStandardDeviation(hist);
      if (sd > 0) z = (c - mean(hist)) / sd;
    }
    const delta = c !== null && p !== null ? c - p : null;
    const pct = delta !== null && p ? delta / Math.abs(p) : null;
    const flags: FindingFlag[] = [];

    if (COUNT_METRICS.includes(metric) && p !== null && p > 0) {
      let run = 0;
      let best = 0;
      for (let d = cur.since; d <= cur.until; d = addDays(d, 1)) {
        const v = metricValue(metric, idx.sum(seg, { since: d, until: d })) ?? 0;
        run = v === 0 ? run + 1 : 0;
        best = Math.max(best, run);
      }
      if (best >= THRESHOLDS.zeroRunDays) flags.push("zero_run");
    }

    if (compare === "wow" && c !== null) {
      const weekly = [c, ...history.slice(0, THRESHOLDS.sustainedDeclineWeeks).map((w) => metricValue(metric, idx.sum(seg, w)))];
      if (weekly.length === THRESHOLDS.sustainedDeclineWeeks + 1 && weekly.every((v) => v !== null)) {
        const v = weekly as number[]; // v[0] = current, v[3] = 3 weeks before
        // each of the last three weekly steps must fall by at least 5%
        const step = (a: number, b: number) => b > 0 && (a - b) / b <= -0.05;
        const declining = step(v[0], v[1]) && step(v[1], v[2]) && step(v[2], v[3]);
        if (declining && v[3] > 0 && (v[0] - v[3]) / v[3] <= THRESHOLDS.sustainedDeclineTotal) flags.push("sustained_decline");
      }
    }

    const bigMove = pct !== null && Math.abs(pct) >= THRESHOLDS.minAbsPct;
    const anomaly =
      flags.includes("zero_run") ||
      (bigMove && z !== null && Math.abs(z) >= THRESHOLDS.minAbsZ) ||
      (bigMove && z === null && Math.abs(pct!) >= THRESHOLDS.bigPctWithoutHistory);
    if (anomaly) flags.unshift("anomaly");

    const absZ = z === null ? 0 : Math.min(Math.abs(z), 50);
    const absPct = pct === null ? 0 : Math.min(Math.abs(pct), 5);
    const score = anomaly ? 100 + absZ + absPct * 10 + (flags.includes("zero_run") ? 20 : 0) : absPct * 10 + Math.min(absZ, 3);

    const finding_id = gb === "total" ? `F-${metric}-total-${compare}` : `F-${metric}-${gb}-${slug(seg)}-${compare}`;
    const label = gb === "campaign" ? labelOf.get(seg) : undefined;
    return {
      finding_id,
      metric,
      groupBy: gb,
      segment: gb === "total" ? "ALL" : seg,
      ...(label ? { segment_label: label.slice(0, 160) } : {}),
      compare,
      current_window: cur,
      previous_window: prev,
      current: round(c),
      previous: round(p),
      delta: round(delta),
      pct_change: round(pct, 4),
      z: round(z, 2),
      flags,
      anomaly,
      score: Math.round(score * 100) / 100,
      display: { current: fmtValue(metric, c), previous: fmtValue(metric, p), delta: fmtDelta(metric, delta), pct_change: fmtPct(pct), z: fmtZ(z) },
    };
  };

  const segments = [...segs].sort().map((s) => build(s, groupBy)).sort((a, b) => b.score - a.score || a.segment.localeCompare(b.segment));
  return {
    metric,
    groupBy,
    compare,
    current_window: cur,
    previous_window: prev,
    thresholds: THRESHOLDS,
    total: build("ALL", "total"),
    segments,
    anomalies: segments.filter((s) => s.anomaly).map((s) => s.finding_id),
  };
}

function round(v: number | null, dp = 4): number | null {
  if (v === null || !Number.isFinite(v)) return null;
  const f = 10 ** dp;
  return Math.round(v * f) / f;
}
