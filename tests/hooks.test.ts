import { describe, expect, it } from "vitest";
import { createGuardrails, sdkHooks } from "../src/agent/hooks.js";
import { fq } from "../src/tools/context.js";
import { makeCtx } from "./helpers.js";
import type { Finding } from "../src/types.js";

const plan = { steps: [{ id: "1", goal: "load data", tool: "load_ad_spend_csv" }] };

function setup(over = {}) {
  const ctx = makeCtx(over);
  const g = createGuardrails(ctx);
  const blocks = () => ctx.logger.events.filter((e) => e.type === "guardrail_block").map((e) => e.rule);
  return { ctx, g, blocks };
}

describe("guardrails", () => {
  it("blocks every tool until a plan exists", () => {
    const { ctx, g, blocks } = setup();
    expect(g.pre(fq("load_ad_spend_csv"), {})).toMatchObject({ action: "deny" });
    expect(g.pre(fq("submit_plan"), plan)).toEqual({ action: "allow" });
    ctx.state.plan = plan.steps;
    expect(g.pre(fq("load_ad_spend_csv"), {})).toEqual({ action: "allow" });
    expect(blocks()).toEqual(["plan_first"]);
  });

  it("blocks built-in and foreign tools", () => {
    const { g, blocks } = setup();
    expect(g.pre("Bash", { command: "ls" })).toMatchObject({ action: "deny" });
    expect(g.pre("mcp__other__thing", {})).toMatchObject({ action: "deny" });
    expect(blocks()).toEqual(["tool_allowlist", "tool_allowlist"]);
  });

  it("allows one plan revision, with a reason", () => {
    const { ctx, g } = setup();
    ctx.state.plan = plan.steps;
    expect(g.pre(fq("submit_plan"), plan)).toMatchObject({ action: "deny" });
    expect(g.pre(fq("submit_plan"), { ...plan, reason: "found a tracking issue" })).toEqual({ action: "allow" });
    ctx.state.planRevisions = 1;
    expect(g.pre(fq("submit_plan"), { ...plan, reason: "again" })).toMatchObject({ action: "deny" });
  });

  it("blocks the 6th Asana task and tasks citing unknown findings", () => {
    const { ctx, g, blocks } = setup();
    ctx.state.plan = plan.steps;
    ctx.state.findings["F-x"] = { finding_id: "F-x" } as Finding;
    const task = { title: "t", notes: "n", assigneeRole: "ua", dueInDays: 1, findingIds: ["F-x"] };
    expect(g.pre(fq("create_asana_task"), { ...task, findingIds: ["F-nope"] })).toMatchObject({ action: "deny" });
    expect(g.pre(fq("create_asana_task"), { ...task, findingIds: [] })).toMatchObject({ action: "deny" });
    for (let i = 0; i < 5; i++) ctx.state.tasks.push({ gid: String(i), url: "", title: "", assigneeRole: "ua", findingIds: [], status: "created" });
    expect(g.pre(fq("create_asana_task"), task)).toMatchObject({ action: "deny", reason: expect.stringMatching(/cap/) });
    expect(blocks()).toEqual(["cite_findings", "cite_findings", "asana_cap"]);
  });

  it("allows one Slack post", () => {
    const { ctx, g } = setup();
    ctx.state.plan = plan.steps;
    expect(g.pre(fq("post_slack_summary"), {})).toEqual({ action: "allow" });
    ctx.state.slack = { ts: "1", permalink: "x" };
    expect(g.pre(fq("post_slack_summary"), {})).toMatchObject({ action: "deny" });
  });

  it("stops the run after the tool-call cap", () => {
    const { ctx, g } = setup({ maxToolCalls: 3 });
    ctx.state.plan = plan.steps;
    for (let i = 0; i < 3; i++) expect(g.pre(fq("get_run_state"), {})).toEqual({ action: "allow" });
    expect(g.pre(fq("get_run_state"), {})).toMatchObject({ action: "stop" });
    expect(ctx.state.stopReason).toMatch(/cap/);
    expect(g.pre(fq("get_run_state"), {})).toMatchObject({ action: "stop" });
  });

  it("traces every attempted call", () => {
    const { ctx, g } = setup();
    g.pre(fq("submit_plan"), plan);
    expect(ctx.logger.events.filter((e) => e.type === "tool_call").map((e) => e.tool)).toEqual(["submit_plan"]);
  });
});

describe("SDK hook adapter", () => {
  const base = { session_id: "s", transcript_path: "/t", cwd: "/", tool_use_id: "u1" };
  const signal = new AbortController().signal;

  it("maps deny and stop to PreToolUse hook output", async () => {
    const ctx = makeCtx({ maxToolCalls: 1 });
    const hook = sdkHooks(createGuardrails(ctx)).PreToolUse![0].hooks[0];
    const denied = await hook({ ...base, hook_event_name: "PreToolUse", tool_name: fq("list_campaigns"), tool_input: {} }, "u1", { signal });
    expect(denied).toEqual({ hookSpecificOutput: { hookEventName: "PreToolUse", permissionDecision: "deny", permissionDecisionReason: expect.stringMatching(/submit_plan/) } });
    const stopped = await hook({ ...base, hook_event_name: "PreToolUse", tool_name: fq("submit_plan"), tool_input: plan }, "u2", { signal });
    expect(stopped).toMatchObject({ continue: false, stopReason: expect.stringMatching(/cap/) });
  });

  it("returns an empty object (no override) when allowed", async () => {
    const ctx = makeCtx();
    const hook = sdkHooks(createGuardrails(ctx)).PreToolUse![0].hooks[0];
    expect(await hook({ ...base, hook_event_name: "PreToolUse", tool_name: fq("submit_plan"), tool_input: plan }, "u1", { signal })).toEqual({});
  });
});

describe("SDK-internal tools", () => {
  it("lets the StructuredOutput tool through without counting it (it carries the final report)", () => {
    const ctx = makeCtx();
    const g = createGuardrails(ctx);
    expect(g.pre("StructuredOutput", { headline: "x" })).toEqual({ action: "allow" });
    expect(ctx.state.toolCalls).toBe(0);
  });
});
