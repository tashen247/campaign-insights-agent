/**
 * OfflineDriver: a deterministic, model-free agent. It runs a fixed plan through exactly the same guardrails,
 * tool handlers, trace and report path as the live model, and writes its recommendations from templates.
 * Uses: the integration-test stub, a baseline for the evals, and `npm run demo -- --offline` with no API key.
 */
import { fq, type ToolContext } from "../../tools/context.js";
import { parseInput, wrapHandler } from "../../tools/index.js";
import { rankedAnomalies, findingLine, type Report } from "../report.js";
import type { Finding, Metric, GroupBy } from "../../types.js";
import { slug } from "../../analysis/format.js";
import type { AgentDriver, DriverInput, DriverResult } from "./types.js";

class StopRun extends Error {}

type Call = (name: string, input: Record<string, unknown>) => Promise<{ ok: boolean; data: unknown }>;

const ANALYSES: [Metric, GroupBy][] = [
  ["installs", "network"],
  ["cvr", "network"],
  ["cpi", "network"],
  ["installs", "campaign"],
  ["installs", "creative"],
  ["ctr", "creative"],
  ["cpi", "geo"],
  ["spend", "geo"],
  ["signup_rate", "network"],
];

type Role = "ua" | "creative" | "analytics";
interface Rec {
  title: string;
  rationale: string;
  owner_role: Role;
  priority: "high" | "medium" | "low";
  finding_ids: string[];
}

export class OfflineDriver implements AgentDriver {
  readonly name = "offline";
  readonly model = null;

  async run(input: DriverInput): Promise<DriverResult> {
    const { ctx, guardrails, toolDefs } = input;
    const call: Call = async (name, args) => {
      const def = toolDefs.find((d) => d.name === name);
      if (!def) throw new Error(`unknown tool ${name}`);
      const d = guardrails.pre(fq(name), args);
      if (d.action === "stop") throw new StopRun(d.reason);
      if (d.action === "deny") return { ok: false, data: { error: d.reason } };
      const parsed = parseInput(def, args);
      if (!parsed.ok) {
        ctx.logger.log("tool_result", { tool: name, ok: false, ms: 0, error: parsed.error });
        return { ok: false, data: { error: parsed.error } };
      }
      const res = await wrapHandler(def, ctx)(parsed.data);
      guardrails.post(fq(name));
      return { ok: !res.isError, data: JSON.parse(res.content[0].text) };
    };

    try {
      const report = await this.work(call, ctx);
      return { structured: report, subtype: "success", costUsd: 0, numTurns: 0 };
    } catch (e) {
      if (e instanceof StopRun) return { structured: null, subtype: "stopped_by_guardrail", costUsd: 0, numTurns: 0, error: e.message };
      throw e;
    }
  }

  private async work(call: Call, ctx: ToolContext): Promise<Report> {
    await call("submit_plan", {
      steps: [
        { id: "1", goal: "Load the attribution export", tool: "load_ad_spend_csv" },
        { id: "2", goal: "Load campaigns and sign-ups from HubSpot", tool: "get_campaign_metrics" },
        { id: "3", goal: "Find which segments moved week over week", tool: "analyze_metrics" },
        { id: "4", goal: "Check whether this has happened before", tool: "recall_past_findings" },
        { id: "5", goal: "Open tasks for the top actions", tool: "create_asana_task" },
        { id: "6", goal: "Post the summary", tool: "post_slack_summary" },
      ],
    });
    await call("load_ad_spend_csv", {});
    await call("list_campaigns", {});
    await call("get_campaign_metrics", { granularity: "week" });
    for (const [metric, groupBy] of ANALYSES) await call("analyze_metrics", { metric, groupBy, compare: "wow" });

    const { state } = ctx;
    const total = state.findings["F-installs-total-wow"];
    const anomalies = rankedAnomalies(state);
    const netOfCampaign = new Map(state.campaigns.map((c) => [c.id, c.network]));
    const netOfCreative = new Map(state.facts.map((f) => [f.creative_id, f.network]));
    const networkOf = (f: Finding): string | null =>
      f.groupBy === "network" ? f.segment : f.groupBy === "campaign" ? netOfCampaign.get(f.segment) ?? null : f.groupBy === "creative" ? netOfCreative.get(f.segment) ?? null : null;
    const installsDown = (net: string) => {
      const f = state.findings[`F-installs-network-${net}-wow`];
      return !!f && f.anomaly && (f.pct_change ?? 0) < 0;
    };

    // Group anomalies into "stories" keyed by likely cause.
    const stories = new Map<string, { kind: string; seg: string; lead: Finding; ids: string[]; score: number }>();
    const add = (kind: string, seg: string, f: Finding) => {
      const key = `${kind}:${seg}`;
      const s = stories.get(key);
      if (!s) stories.set(key, { kind, seg, lead: f, ids: [f.finding_id], score: f.score });
      else if (s.ids.length < 4 && !s.ids.includes(f.finding_id)) s.ids.push(f.finding_id);
    };
    const tracking = new Set(anomalies.filter((f) => f.flags.includes("zero_run")).map(networkOf).filter(Boolean) as string[]);
    for (const f of anomalies) {
      const net = networkOf(f);
      if (net && tracking.has(net)) add("tracking", net, f);
      else if (f.groupBy === "creative" && (f.metric === "ctr" || f.flags.includes("sustained_decline"))) add("creative", f.segment, f);
      else if (net && installsDown(net)) add("conversion", net, f);
      else if (f.groupBy === "geo" && (f.metric === "cpi" || f.metric === "spend")) add("geo_cost", f.segment, f);
      else if (net && f.metric === "cpi") add("network_cost", net, f);
      else if (f.metric === "signup_rate" && net && tracking.has(net)) add("tracking", net, f);
    }
    // For a conversion story, lead with the install drop itself (what the marketer asked about).
    for (const s of stories.values()) {
      const inst = state.findings[`F-installs-network-${s.seg}-wow`];
      if (s.kind === "conversion" && inst && s.ids.includes(inst.finding_id)) {
        s.lead = inst;
        s.ids = [inst.finding_id, ...s.ids.filter((id) => id !== inst.finding_id)];
      }
    }
    // A story that is only a knock-on of a bigger one (e.g. a geo CPI bump caused by a network-wide drop) ranks below it.
    const ranked = [...stories.values()].sort((a, b) => b.score - a.score);
    const order = ["tracking", "creative", "conversion", "geo_cost", "network_cost"];
    ranked.sort((a, b) => order.indexOf(a.kind) - order.indexOf(b.kind) || b.score - a.score);
    // If the lead story is a network-wide conversion or tracking problem, cost bumps elsewhere are knock-on effects.
    const lead = ranked[0];
    const independent = ranked.filter((s, i) => i === 0 || !(lead && ["tracking", "conversion"].includes(lead.kind) && ["geo_cost", "network_cost"].includes(s.kind)));
    const primary = independent.slice(0, 2);

    let past: { date: string; pct_change: string }[] = [];
    if (primary[0]) {
      const r = await call("recall_past_findings", { metric: primary[0].lead.metric, segment: primary[0].seg });
      past = ((r.data as { past_findings?: { date: string; pct_change: string }[] }).past_findings ?? []).slice(0, 1);
    }

    const recs: Rec[] = primary.flatMap((s) => templates(s.kind, s.seg, s.ids.map((id) => state.findings[id]), state.findings));
    const chosen = recs.slice(0, 4);

    for (const rec of chosen.slice(0, 3)) {
      await call("create_asana_task", { title: rec.title, notes: rec.rationale, assigneeRole: rec.owner_role, dueInDays: rec.priority === "high" ? 2 : 5, findingIds: rec.finding_ids });
    }

    const findingsOut = [...new Set(primary.flatMap((s) => s.ids))].slice(0, 6).map((id) => ({ finding_id: id, summary: findingLine(state.findings[id]) }));
    const noAnomaly = anomalies.length === 0;
    const totalLine = total ? `Installs ${total.display.pct_change} week over week (${total.display.previous} → ${total.display.current})` : "Installs analysed";
    const headline = noAnomaly
      ? `No significant change last week: ${totalLine.toLowerCase()}, within normal range.`
      : `${totalLine}; main driver: ${describeStory(primary[0].kind, primary[0].seg)}.`;
    const diagnosis = noAnomaly
      ? "No segment moved by 20% or more against its trailing history, and no zero-runs or sustained declines were flagged. No action needed."
      : [
          ...primary.map((s) => `${cap(describeStory(s.kind, s.seg))}: ${findingLine(s.lead)} [${s.lead.finding_id}].`),
          past[0] ? `A similar move was recorded on ${past[0].date} (${past[0].pct_change}).` : "",
        ]
          .filter(Boolean)
          .join(" ");

    await call("post_slack_summary", {
      headline,
      bullets: noAnomaly ? ["No anomalies flagged across network, campaign, geo or creative.", "No tasks created."] : [...primary.map((s) => `${cap(describeStory(s.kind, s.seg))}: ${findingLine(s.lead)}`), `${state.tasks.length} Asana tasks opened.`],
    });

    return {
      headline,
      diagnosis,
      no_anomaly: noAnomaly,
      findings: findingsOut,
      recommendations: chosen,
      limitations: ["Written by the deterministic offline baseline, not the model: recommendations come from templates."],
    };
  }
}

const cap = (s: string) => s.charAt(0).toUpperCase() + s.slice(1);

function describeStory(kind: string, seg: string): string {
  switch (kind) {
    case "tracking":
      return `a likely attribution outage on ${seg}`;
    case "creative":
      return `creative fatigue on ${seg}`;
    case "conversion":
      return `a click-to-install conversion drop on ${seg}`;
    case "geo_cost":
      return `rising acquisition cost in ${seg}`;
    default:
      return `rising CPI on ${seg}`;
  }
}

function templates(kind: string, seg: string, fs: Finding[], all: Record<string, Finding>): Rec[] {
  const lead = fs[0];
  const ids = fs.map((f) => f.finding_id);
  const d = lead.display;
  const pick = (id: string) => (all[id] ? [id] : []);
  switch (kind) {
    case "tracking":
      return [
        { title: `Fix install attribution for ${seg}`, rationale: `Installs on ${seg} hit zero on consecutive days while clicks and spend carried on (${d.previous} → ${d.current}, ${d.pct_change}). Check the MMP postback and SDK integration for ${seg}, then backfill.`, owner_role: "analytics", priority: "high", finding_ids: ids },
        { title: `Freeze ${seg} bid changes until tracking is restored`, rationale: `Automated bidding on ${seg} will read the gap as lost installs and cut bids. Hold changes and exclude the outage days from optimisation.`, owner_role: "ua", priority: "medium", finding_ids: [lead.finding_id] },
      ];
    case "creative":
      return [
        { title: `Refresh creative ${seg}`, rationale: `${lead.metric.toUpperCase()} on ${seg} went ${d.previous} → ${d.current} (${d.pct_change}) after a run of weekly declines, the usual sign of fatigue. Ship a new variant and rotate this one out.`, owner_role: "creative", priority: "high", finding_ids: ids },
        { title: `Move ${seg} budget to the stronger creative`, rationale: `Until the refresh lands, shift spend away from ${seg} within the same campaign.`, owner_role: "ua", priority: "medium", finding_ids: [lead.finding_id] },
      ];
    case "conversion": {
      const cvr = all[`F-cvr-network-${seg}-wow`];
      const cpi = all[`F-cpi-network-${seg}-wow`];
      const inst = all[`F-installs-network-${seg}-wow`];
      return [
        { title: `Audit the ${seg} install path`, rationale: `Click-to-install CVR on ${seg} went ${cvr?.display.previous ?? d.previous} → ${cvr?.display.current ?? d.current} (${cvr?.display.pct_change ?? d.pct_change}) while clicks held. Check store-listing changes, deep links and SKAN/postback settings on the ${seg} campaigns.`, owner_role: "ua", priority: "high", finding_ids: [...pick(`F-cvr-network-${seg}-wow`), ...pick(`F-installs-network-${seg}-wow`)].length ? [...pick(`F-cvr-network-${seg}-wow`), ...pick(`F-installs-network-${seg}-wow`)] : ids },
        { title: `Reconcile ${seg} installs with store consoles`, rationale: `Compare attributed ${seg} installs (${inst?.display.current ?? d.current}) with App Store and Play Console for the same week to rule out a measurement gap.`, owner_role: "analytics", priority: "medium", finding_ids: inst ? [inst.finding_id] : ids },
        { title: `Cap ${seg} spend until CPI recovers`, rationale: `CPI on ${seg} went ${cpi?.display.previous ?? "n/a"} → ${cpi?.display.current ?? "n/a"} (${cpi?.display.pct_change ?? "n/a"}). Hold budgets flat and route incremental spend to networks without anomalies.`, owner_role: "ua", priority: "medium", finding_ids: cpi ? [cpi.finding_id] : ids },
      ];
    }
    case "geo_cost": {
      const c = all[`F-cpi-geo-${slug(seg)}-wow`];
      const cd = c?.display ?? d;
      return [
        { title: `Review bids and targets in ${seg}`, rationale: `CPI in ${seg} went ${cd.previous} → ${cd.current} (${cd.pct_change}). Check for bid or tROAS target changes and auction pressure in ${seg}, network by network.`, owner_role: "ua", priority: "high", finding_ids: ids },
        { title: `Check ${seg} spend reporting`, rationale: `Confirm the ${seg} spend figures with the network dashboards before acting on them.`, owner_role: "analytics", priority: "low", finding_ids: [lead.finding_id] },
      ];
    }
    default:
      return [{ title: `Review ${seg} bidding`, rationale: `${lead.metric} on ${seg}: ${d.previous} → ${d.current} (${d.pct_change}).`, owner_role: "ua", priority: "medium", finding_ids: ids }];
  }
}
