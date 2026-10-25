import { z } from "zod";
import { ROLES } from "../tools/actions.js";
import type { Finding, RunState } from "../types.js";

export const ReportSchema = z.object({
  headline: z.string().min(5).describe("One sentence answer to the brief, quoting display strings."),
  diagnosis: z.string().min(10).describe("2-5 sentences: what moved, where, and the most likely cause, with finding_ids in brackets."),
  no_anomaly: z.boolean().describe("true when analysis found nothing anomalous"),
  findings: z
    .array(z.object({ finding_id: z.string(), summary: z.string() }))
    .max(8)
    .describe("Ranked, most likely root cause first."),
  recommendations: z
    .array(
      z.object({
        title: z.string(),
        rationale: z.string(),
        owner_role: z.enum(ROLES),
        priority: z.enum(["high", "medium", "low"]),
        finding_ids: z.array(z.string()).min(1),
      }),
    )
    .max(6),
  limitations: z.array(z.string()).describe("Caveats, data gaps, anything you could not check."),
});

export type Report = z.infer<typeof ReportSchema>;

/** JSON Schema for outputFormat. Draft-07 without a $schema key: the CLI's validator rejects the 2020-12 meta-schema URI zod emits by default. */
export const reportJsonSchema = (): Record<string, unknown> => {
  const { $schema: _drop, ...schema } = z.toJSONSchema(ReportSchema, { target: "draft-7" }) as Record<string, unknown>;
  void _drop;
  return schema;
};

export interface ValidatedReport {
  report: Report;
  problems: string[];
}

/** zod-validate the model's structured output, then drop anything that cites a finding the run never produced. */
export function validateReport(raw: unknown, state: RunState): ValidatedReport | null {
  const parsed = ReportSchema.safeParse(raw);
  if (!parsed.success) return null;
  const r = parsed.data;
  const problems: string[] = [];
  const known = (id: string) => id in state.findings;
  const findings = r.findings.filter((f) => {
    if (known(f.finding_id)) return true;
    problems.push(`Dropped finding with unknown id ${f.finding_id}.`);
    return false;
  });
  const recommendations = r.recommendations.filter((rec) => {
    const bad = rec.finding_ids.filter((id) => !known(id));
    if (bad.length === 0) return true;
    problems.push(`Dropped recommendation "${rec.title}": cited unknown finding(s) ${bad.join(", ")}.`);
    return false;
  });
  return { report: { ...r, findings, recommendations }, problems };
}

/** Built from state when the model produced no usable structured output (limit hit, error, invalid JSON). */
export function fallbackReport(state: RunState, reason: string): Report {
  const anomalies = rankedAnomalies(state).slice(0, 5);
  return {
    headline: anomalies.length ? `Run ended early (${reason}). ${anomalies.length} anomalies were found before it stopped.` : `Run ended early (${reason}).`,
    diagnosis: anomalies.length
      ? "The agent did not finish its write-up. The findings below come straight from the deterministic analysis and have not been interpreted."
      : "The agent stopped before any anomaly was found.",
    no_anomaly: anomalies.length === 0,
    findings: anomalies.map((f) => ({ finding_id: f.finding_id, summary: findingLine(f) })),
    recommendations: [],
    limitations: [reason],
  };
}

export function rankedAnomalies(state: RunState): Finding[] {
  return Object.values(state.findings)
    .filter((f) => f.anomaly && f.groupBy !== "total")
    .sort((a, b) => b.score - a.score || a.finding_id.localeCompare(b.finding_id));
}

export function findingLine(f: Finding): string {
  const seg = f.groupBy === "total" ? "overall" : `${f.groupBy} ${f.segment}`;
  return `${f.metric} for ${seg}: ${f.display.previous} → ${f.display.current} (${f.display.pct_change}, z ${f.display.z})${f.flags.length > 1 ? " [" + f.flags.filter((x) => x !== "anomaly").join(", ") + "]" : ""}`;
}

export interface ReportMeta {
  runId: string;
  status: string;
  driver: string;
  model: string | null;
  scenario: string;
  costUsd: number;
  numTurns: number;
  toolCalls: number;
  reportUrl: string;
  numberCheck: { checked: number; unverified: string[]; approximations?: string[] };
}

const esc = (s: string) => s.replace(/\|/g, "\\|").replace(/\n/g, " ");

export function renderMarkdown(r: Report, state: RunState, m: ReportMeta): string {
  const L: string[] = [];
  L.push(`# Campaign insights · ${m.runId}`, "");
  L.push(`> **Brief:** ${state.brief}  `, `> Requested by ${state.requestedBy} · status **${m.status}** · driver ${m.driver}${m.model ? ` (${m.model})` : ""} · scenario ${m.scenario}`, "");
  L.push(`## ${r.headline}`, "", r.diagnosis, "");
  if (state.datasets.ad_spend) L.push(`_Data: ${state.datasets.ad_spend.source}, ${state.datasets.ad_spend.since} to ${state.datasets.ad_spend.until}._`, "");

  L.push("## Findings", "");
  if (r.findings.length === 0) L.push("No anomalous findings.", "");
  else {
    L.push("| # | Finding | Previous | Current | Change | z | Flags | Note |", "|---|---|---|---|---|---|---|---|");
    r.findings.forEach((f, i) => {
      const d = state.findings[f.finding_id];
      L.push(`| ${i + 1} | \`${f.finding_id}\` | ${d.display.previous} | ${d.display.current} | ${d.display.pct_change} | ${d.display.z} | ${d.flags.join(", ")} | ${esc(f.summary)} |`);
    });
    L.push("");
  }

  L.push("## Recommendations", "");
  if (r.recommendations.length === 0) L.push("None.", "");
  r.recommendations.forEach((rec, i) => {
    L.push(`${i + 1}. **${rec.title}** (${rec.priority}, owner: ${rec.owner_role})  `, `   ${rec.rationale}  `, `   Evidence: ${rec.finding_ids.map((x) => "`" + x + "`").join(", ")}`);
  });
  L.push("");

  L.push("## Actions taken", "");
  if (state.tasks.length === 0) L.push("- No Asana tasks created.");
  for (const t of state.tasks) L.push(`- Asana [${t.gid}](${t.url}) · ${t.status} · ${t.assigneeRole} · ${t.title}`);
  L.push(state.slack ? `- Slack: ${state.slack.permalink}` : "- No Slack post.", "");

  if (state.plan) {
    L.push("## Plan" + (state.planRevisions ? ` (revised ${state.planRevisions}x)` : ""), "");
    state.plan.forEach((s) => L.push(`${s.id}. ${s.goal} — \`${s.tool}\``));
    L.push("");
  }

  const lim = [...r.limitations];
  if (m.numberCheck.unverified.length) lim.push(`Numbers not found in any tool output: ${m.numberCheck.unverified.join(", ")}.`);
  if (lim.length) {
    L.push("## Limitations", "");
    lim.forEach((x) => L.push(`- ${x}`));
    L.push("");
  }

  L.push("---", `Cost $${m.costUsd.toFixed(4)} · ${m.numTurns} model turns · ${m.toolCalls} tool calls · ${m.numberCheck.checked} numbers cross-checked${m.numberCheck.approximations?.length ? ` (${m.numberCheck.approximations.length} hedged approximations)` : ""}. Trace: \`runs/${m.runId}/trace.jsonl\` (\`npm run trace ${m.runId}\`).`);
  return L.join("\n") + "\n";
}

/** All human-readable text in the report, for the number cross-check. */
export function reportText(r: Report): string {
  return [r.headline, r.diagnosis, ...r.findings.map((f) => f.summary), ...r.recommendations.flatMap((x) => [x.title, x.rationale])].join("\n");
}
