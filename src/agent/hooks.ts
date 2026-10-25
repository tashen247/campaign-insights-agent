/**
 * Guardrails. Pure decision logic (easy to unit test) plus an adapter that turns it into SDK hook callbacks.
 * Every tool call passes through `pre` before its handler runs, in both the live SDK path and the offline driver.
 */
import type { HookCallbackMatcher, HookEvent } from "@anthropic-ai/claude-agent-sdk";
import type { ToolContext } from "../tools/context.js";
import { SERVER_NAME, shortName } from "../tools/context.js";

export const SDK_INTERNAL_TOOLS = ["StructuredOutput"];

export type Decision = { action: "allow" } | { action: "deny"; reason: string } | { action: "stop"; reason: string };

export interface Guardrails {
  pre(toolName: string, input: unknown): Decision;
  post(toolName: string): void;
}

export function createGuardrails(ctx: ToolContext): Guardrails {
  const { state, cfg, logger } = ctx;

  const block = (tool: string, reason: string, rule: string): Decision => {
    logger.log("guardrail_block", { tool, reason, rule });
    return { action: "deny", reason };
  };

  return {
    pre(toolName, rawInput) {
      const input = (rawInput ?? {}) as Record<string, unknown>;
      const name = shortName(toolName);

      if (state.stopReason) return { action: "stop", reason: state.stopReason };

      // outputFormat is delivered through the SDK's own StructuredOutput tool. It is how the final report
      // arrives, so it is always allowed and does not count against the tool-call cap.
      if (SDK_INTERNAL_TOOLS.includes(toolName)) return { action: "allow" };

      if (!toolName.startsWith(`mcp__${SERVER_NAME}__`)) {
        return block(toolName, "Only the campaign tools are available in this run.", "tool_allowlist");
      }

      state.toolCalls += 1;
      if (state.toolCalls > cfg.maxToolCalls) {
        state.stopReason = `Tool-call cap reached (${cfg.maxToolCalls}).`;
        logger.log("guardrail_block", { tool: name, reason: state.stopReason, rule: "max_tool_calls" });
        return { action: "stop", reason: state.stopReason };
      }
      logger.log("tool_call", { tool: name, n: state.toolCalls, input });

      if (!state.plan && name !== "submit_plan") {
        return block(name, "Call submit_plan first: no other tool runs until a plan exists.", "plan_first");
      }

      if (name === "submit_plan" && state.plan) {
        if (!input.reason) return block(name, "A plan exists. Revising it needs a reason.", "plan_revision_reason");
        if (state.planRevisions >= 1) return block(name, "The plan can be revised only once.", "plan_revision_limit");
      }

      if (name === "create_asana_task") {
        if (state.tasks.length >= cfg.maxAsanaTasks) return block(name, `Task cap reached (${cfg.maxAsanaTasks} per run).`, "asana_cap");
        const ids = Array.isArray(input.findingIds) ? (input.findingIds as string[]) : [];
        if (ids.length === 0) return block(name, "Every task must cite at least one finding_id.", "cite_findings");
        const unknown = ids.filter((id) => !(id in state.findings));
        if (unknown.length) return block(name, `Unknown finding_id(s): ${unknown.join(", ")}.`, "cite_findings");
      }

      if (name === "post_slack_summary" && state.slack) {
        return block(name, "This run has already posted to Slack (one post per run).", "slack_once");
      }

      return { action: "allow" };
    },
    post() {
      /* results are traced in the tool wrapper; nothing else to do */
    },
  };
}

/** SDK hook callbacks backed by the guardrails above. */
export function sdkHooks(g: Guardrails): Partial<Record<HookEvent, HookCallbackMatcher[]>> {
  return {
    PreToolUse: [
      {
        hooks: [
          async (input) => {
            if (input.hook_event_name !== "PreToolUse") return {};
            const d = g.pre(input.tool_name, input.tool_input);
            if (d.action === "allow") return {};
            const deny = {
              hookEventName: "PreToolUse" as const,
              permissionDecision: "deny" as const,
              permissionDecisionReason: d.reason,
            };
            return d.action === "stop" ? { continue: false, stopReason: d.reason, hookSpecificOutput: deny } : { hookSpecificOutput: deny };
          },
        ],
      },
    ],
    PostToolUse: [
      {
        hooks: [
          async (input) => {
            if (input.hook_event_name === "PostToolUse") g.post(input.tool_name);
            return {};
          },
        ],
      },
    ],
  };
}
