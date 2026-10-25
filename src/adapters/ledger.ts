import fs from "node:fs";
import crypto from "node:crypto";

/**
 * Side-effect ledger: one JSON file per run. Before writing to Asana or Slack we look up a deterministic key;
 * if it's there, the earlier result is returned and nothing is written again. That makes a run idempotent per runId.
 */
export class Ledger {
  private data: Record<string, unknown>;
  constructor(private readonly file: string) {
    this.data = fs.existsSync(file) ? JSON.parse(fs.readFileSync(file, "utf8")) : {};
  }
  get<T>(key: string): T | undefined {
    return this.data[key] as T | undefined;
  }
  set(key: string, value: unknown): void {
    this.data[key] = value;
    fs.writeFileSync(this.file, JSON.stringify(this.data, null, 2));
  }
  async once<T>(key: string, fn: () => Promise<T>): Promise<{ value: T; replayed: boolean }> {
    const prev = this.get<T>(key);
    if (prev !== undefined) return { value: prev, replayed: true };
    const value = await fn();
    this.set(key, value);
    return { value, replayed: false };
  }
}

export const hash = (s: string) => crypto.createHash("sha256").update(s.trim().toLowerCase()).digest("hex").slice(0, 12);
