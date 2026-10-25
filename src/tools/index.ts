import { createSdkMcpServer, tool } from "@anthropic-ai/claude-agent-sdk";
import { z } from "zod";
import { SERVER_NAME, ToolError, fq, type ToolContext, type ToolDef } from "./context.js";
import { getRunState, submitPlan } from "./plan.js";
import { getCampaignMetrics, listCampaigns, loadAdSpend } from "./data.js";
import { analyzeMetrics, recallPastFindings } from "./analysis.js";
import { createAsanaTask, postSlackSummary } from "./actions.js";

export const TOOL_DEFS: ToolDef[] = [
  submitPlan,
  getRunState,
  listCampaigns,
  getCampaignMetrics,
  loadAdSpend,
  analyzeMetrics,
  recallPastFindings,
  createAsanaTask,
  postSlackSummary,
] as unknown as ToolDef[];

export const ALLOWED_TOOLS = TOOL_DEFS.map((d) => fq(d.name));

export interface ToolCallResult {
  content: { type: "text"; text: string }[];
  isError?: boolean;
  [k: string]: unknown;
}

/** Runs a tool handler, traces the result, and turns errors into isError results the model can read. */
export function wrapHandler(def: ToolDef, ctx: ToolContext) {
  return async (args: unknown): Promise<ToolCallResult> => {
    const t0 = Date.now();
    try {
      const result = await def.handler(args as never, ctx);
      ctx.logger.log("tool_result", { tool: def.name, ok: true, ms: Date.now() - t0, summary: def.summarize?.(result) ?? null, result });
      return { content: [{ type: "text", text: JSON.stringify(result) }] };
    } catch (e) {
      const known = e instanceof ToolError;
      const message = known ? (e as Error).message : `Internal error in ${def.name}: ${(e as Error).message ?? String(e)}`;
      ctx.logger.log("tool_result", { tool: def.name, ok: false, ms: Date.now() - t0, error: message });
      if (!known) ctx.logger.log("error", { message, tool: def.name });
      return { content: [{ type: "text", text: JSON.stringify({ error: message }) }], isError: true };
    }
  };
}

export function createCampaignServer(ctx: ToolContext) {
  return createSdkMcpServer({
    name: SERVER_NAME,
    version: "1.0.0",
    tools: TOOL_DEFS.map((d) => tool(d.name, d.description, d.shape, wrapHandler(d, ctx) as never)),
  });
}

/** Validate input with the tool's zod shape (used by the offline driver; the SDK validates for the live model). */
export function parseInput(def: ToolDef, input: unknown): { ok: true; data: unknown } | { ok: false; error: string } {
  const r = z.object(def.shape).safeParse(input ?? {});
  return r.success ? { ok: true, data: r.data } : { ok: false, error: r.error.issues.map((i) => `${i.path.join(".")}: ${i.message}`).join("; ") };
}
