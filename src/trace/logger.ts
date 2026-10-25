import fs from "node:fs";

export type TraceType =
  | "run_start"
  | "plan"
  | "tool_call"
  | "tool_result"
  | "retry"
  | "guardrail_block"
  | "turn"
  | "cost"
  | "final"
  | "error";

export interface TraceEvent {
  ts: string;
  t_ms: number;
  runId: string;
  type: TraceType;
  [k: string]: unknown;
}

export class TraceLogger {
  private readonly t0 = Date.now();
  readonly events: TraceEvent[] = [];
  constructor(
    readonly runId: string,
    private readonly file: string,
    private readonly stream: ((e: TraceEvent) => void) | null = null,
  ) {}

  log(type: TraceType, data: Record<string, unknown> = {}): TraceEvent {
    const e: TraceEvent = { ts: new Date().toISOString(), t_ms: Date.now() - this.t0, runId: this.runId, type, ...data };
    this.events.push(e);
    fs.appendFileSync(this.file, JSON.stringify(e) + "\n");
    this.stream?.(e);
    return e;
  }
}

export function readTrace(file: string): TraceEvent[] {
  return fs
    .readFileSync(file, "utf8")
    .split("\n")
    .filter(Boolean)
    .map((l) => JSON.parse(l) as TraceEvent);
}
