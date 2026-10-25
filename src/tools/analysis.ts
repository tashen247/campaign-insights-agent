import { z } from "zod";
import { defineTool, ToolError } from "./context.js";
import { analyze, AnalysisError } from "../analysis/metrics.js";
import { GROUP_BYS, METRICS, type Finding } from "../types.js";

const forModel = (f: Finding) => ({
  finding_id: f.finding_id,
  segment: f.segment,
  ...(f.segment_label ? { segment_label: f.segment_label } : {}),
  display: f.display,
  flags: f.flags,
  anomaly: f.anomaly,
});

export const analyzeMetrics = defineTool({
  name: "analyze_metrics",
  description: [
    "Deterministic analysis over the loaded data. Compares the latest period with the previous one (wow = last 7 days vs the 7 before; dod = last day vs the day before)",
    "and scores each segment against its trailing history (z-score). Flags: anomaly (|change| >= 20% and |z| >= 3, or a zero-run),",
    "zero_run (2+ days at zero after a non-zero period - often a tracking problem), sustained_decline (3 weekly falls of 5%+).",
    "Metrics: installs, spend, cpi (spend/installs), cvr (installs/clicks), ctr (clicks/impressions), signups, signup_rate (signups/installs).",
    "signups and signup_rate need get_campaign_metrics first and only group by network or campaign.",
    "Quote the display strings exactly; never compute numbers yourself.",
  ].join(" "),
  shape: {
    metric: z.enum(METRICS),
    groupBy: z.enum(GROUP_BYS),
    compare: z.enum(["wow", "dod"]).default("wow"),
    until: z.string().regex(/^\d{4}-\d{2}-\d{2}$/).optional().describe("End of the current window. Defaults to the last date in the data."),
  },
  async handler(args, { state }) {
    let out;
    try {
      out = analyze({ facts: state.facts, signups: state.signups, campaigns: state.campaigns, ...args });
    } catch (e) {
      if (e instanceof AnalysisError) throw new ToolError(e.message);
      throw e;
    }
    for (const f of [out.total, ...out.segments]) state.findings[f.finding_id] = f;
    return {
      metric: out.metric,
      groupBy: out.groupBy,
      compare: out.compare,
      current_window: out.current_window,
      previous_window: out.previous_window,
      total: forModel(out.total),
      segments: out.segments.map(forModel),
      anomalies: out.anomalies,
      thresholds: {
        min_change: `${out.thresholds.minAbsPct * 100}%`,
        min_abs_z: String(out.thresholds.minAbsZ),
        zero_run_days: String(out.thresholds.zeroRunDays),
        sustained_decline: `${out.thresholds.sustainedDeclineWeeks} weekly falls of 5%+`,
      },
    };
  },
  summarize: (r) => {
    const o = r as { metric: string; groupBy: string; anomalies: string[] };
    return `${o.metric} by ${o.groupBy}: ${o.anomalies.length} anomalies${o.anomalies.length ? " (" + o.anomalies.slice(0, 2).join(", ") + ")" : ""}`;
  },
});

export const recallPastFindings = defineTool({
  name: "recall_past_findings",
  description: "Look up anomalies recorded on earlier runs, newest first. Filter by metric and/or segment (network, campaign id, geo or creative id).",
  shape: { campaignId: z.string().optional(), metric: z.string().optional(), segment: z.string().optional() },
  async handler(args, { memory }) {
    const past = memory.query(args);
    if (!past.length) return { past_findings: [], note: "No earlier findings match." };
    return { past_findings: past };
  },
  summarize: (r) => `${(r as { past_findings: unknown[] }).past_findings.length} past findings`,
});

export function assertFindingsExist(ids: string[], known: Record<string, unknown>) {
  const unknown = ids.filter((id) => !(id in known));
  if (unknown.length) throw new ToolError(`Unknown finding_id(s): ${unknown.join(", ")}. Cite ids returned by analyze_metrics.`);
}
