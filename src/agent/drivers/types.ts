import type { Config } from "../../config.js";
import type { ToolContext, ToolDef } from "../../tools/context.js";
import type { Guardrails } from "../hooks.js";

export interface DriverInput {
  cfg: Config;
  systemPrompt: string;
  userPrompt: string;
  toolDefs: ToolDef[];
  ctx: ToolContext;
  guardrails: Guardrails;
  outputSchema: Record<string, unknown>;
}

export interface DriverResult {
  structured: unknown | null;
  /** SDK result subtype ("success", "error_max_turns", "error_max_budget_usd", ...) or "offline". */
  subtype: string;
  costUsd: number;
  numTurns: number;
  error?: string;
}

export interface AgentDriver {
  readonly name: string;
  readonly model: string | null;
  run(input: DriverInput): Promise<DriverResult>;
}
