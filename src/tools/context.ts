import type { z } from "zod";
import type { Config } from "../config.js";
import type { Adapters } from "../adapters/types.js";
import type { Ledger } from "../adapters/ledger.js";
import type { TraceLogger } from "../trace/logger.js";
import type { InsightMemory } from "../memory/store.js";
import type { RunState } from "../types.js";

export interface Owners {
  [role: string]: { name: string; asanaAssigneeGid: string | null };
}

export interface ToolContext {
  cfg: Config;
  state: RunState;
  adapters: Adapters;
  ledger: Ledger;
  logger: TraceLogger;
  memory: InsightMemory;
  owners: Owners;
  runDir: string;
  reportUrl: string;
}

/** A tool error the model should see and adapt to (returned as isError: true, never thrown out of the run). */
export class ToolError extends Error {}

export interface ToolDef<S extends z.ZodRawShape = z.ZodRawShape> {
  name: string;
  description: string;
  shape: S;
  handler: (args: z.infer<z.ZodObject<S>>, ctx: ToolContext) => Promise<unknown>;
  /** One-line summary for the trace. */
  summarize?: (result: unknown) => string;
}

export function defineTool<S extends z.ZodRawShape>(def: ToolDef<S>): ToolDef<S> {
  return def;
}

export const SERVER_NAME = "campaign";
export const fq = (name: string) => `mcp__${SERVER_NAME}__${name}`;
export const shortName = (name: string) => name.replace(`mcp__${SERVER_NAME}__`, "");
