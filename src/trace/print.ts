import type { TraceEvent } from "./logger.js";

const short = (v: unknown, n = 90) => {
  const s = typeof v === "string" ? v : JSON.stringify(v);
  return s.length > n ? s.slice(0, n - 1) + "…" : s;
};

export function describe(e: TraceEvent): string {
  switch (e.type) {
    case "run_start":
      return `run ${e.runId} · driver=${e.driver} · scenario=${e.scenario} · brief="${short(e.brief, 60)}"`;
    case "plan":
      return `plan r${e.revision}: ${(e.steps as { tool: string }[]).map((s) => s.tool).join(" → ")}`;
    case "tool_call":
      return `→ ${e.tool} ${short(e.input, 70)}`;
    case "tool_result":
      return `${e.ok ? "✓" : "✗"} ${e.tool} (${e.ms}ms) ${short(e.summary ?? e.error ?? "", 70)}`;
    case "guardrail_block":
      return `⛔ ${e.tool}: ${e.reason}`;
    case "retry":
      return `↻ ${e.source} attempt ${e.attempt} status=${e.status} wait=${e.delayMs}ms`;
    case "turn":
      return `· model turn ${e.turn}${e.text ? ` "${short(e.text, 70)}"` : ""}`;
    case "cost":
      return `$ ${Number(e.total_cost_usd).toFixed(4)} · turns=${e.num_turns} · ${e.subtype}`;
    case "final":
      return `■ ${e.status}: ${short(e.headline, 80)}`;
    case "error":
      return `! ${short(e.message, 100)}`;
  }
}

export function formatTimeline(events: TraceEvent[]): string {
  const lines = events.map((e) => `${String(e.t_ms).padStart(7)}ms  ${describe(e)}`);
  const cost = events.find((e) => e.type === "cost");
  const calls = events.filter((e) => e.type === "tool_call").length;
  const blocks = events.filter((e) => e.type === "guardrail_block").length;
  lines.push("", `tool calls: ${calls} · guardrail blocks: ${blocks} · cost: ${cost ? "$" + Number(cost.total_cost_usd).toFixed(4) : "n/a"}`);
  return lines.join("\n");
}
