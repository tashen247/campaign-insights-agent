import { z } from "zod";
import { defineTool, ToolError } from "./context.js";

export const submitPlan = defineTool({
  name: "submit_plan",
  description:
    "Submit your plan before doing anything else. Ordered steps, each with a goal and the tool you expect to use. You may revise the plan once by calling this again with a reason.",
  shape: {
    steps: z
      .array(z.object({ id: z.string().min(1), goal: z.string().min(3), tool: z.string().min(1) }))
      .min(1)
      .max(20),
    reason: z.string().optional().describe("Required when revising an existing plan."),
  },
  async handler(args, ctx) {
    const { state, logger } = ctx;
    if (state.plan && !args.reason) throw new ToolError("A plan already exists. To revise it, call submit_plan again with a reason.");
    if (state.plan && state.planRevisions >= 1) throw new ToolError("The plan can be revised only once.");
    const revision = state.plan ? state.planRevisions + 1 : 0;
    if (state.plan) state.planRevisions += 1;
    state.plan = args.steps;
    logger.log("plan", { revision, steps: args.steps, reason: args.reason ?? null });
    return { accepted: true, revision };
  },
  summarize: (r) => `accepted r${(r as { revision: number }).revision}`,
});

export const getRunState = defineTool({
  name: "get_run_state",
  description: "Return the current run state: plan, datasets loaded, findings so far (ids and headline numbers), tasks created and Slack post.",
  shape: {},
  async handler(_args, { state, cfg }) {
    return {
      runId: state.runId,
      plan: state.plan,
      planRevisions: state.planRevisions,
      datasets: state.datasets,
      findings: Object.values(state.findings)
        .filter((f) => f.anomaly || f.groupBy === "total")
        .map((f) => ({ finding_id: f.finding_id, pct_change: f.display.pct_change, flags: f.flags })),
      findingCount: Object.keys(state.findings).length,
      tasks: state.tasks.map((t) => ({ gid: t.gid, title: t.title, status: t.status })),
      tasksRemaining: Math.max(0, cfg.maxAsanaTasks - state.tasks.length),
      slack: state.slack,
      toolCalls: state.toolCalls,
      toolCallsRemaining: Math.max(0, cfg.maxToolCalls - state.toolCalls),
    };
  },
});
