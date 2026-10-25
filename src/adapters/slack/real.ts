import type { SlackAdapter } from "../types.js";
import { HttpError, httpJson, type RetryOptions } from "../retry.js";

export class RealSlack implements SlackAdapter {
  constructor(
    private readonly token: string,
    private readonly retry: RetryOptions = {},
  ) {}
  private async call<T extends { ok: boolean; error?: string }>(method: string, body: Record<string, unknown>): Promise<T> {
    const res = await httpJson<T>(
      `https://slack.com/api/${method}`,
      { method: "POST", headers: { authorization: `Bearer ${this.token}`, "content-type": "application/json; charset=utf-8" }, body: JSON.stringify(body) },
      this.retry,
    );
    if (!res.ok) throw new HttpError(`Slack ${method}: ${res.error ?? "unknown_error"}`, 200);
    return res;
  }
  async postMessage(m: { channel: string; text: string; blocks?: unknown[] }) {
    const posted = await this.call<{ ok: boolean; error?: string; ts: string; channel: string }>("chat.postMessage", { channel: m.channel, text: m.text, blocks: m.blocks, unfurl_links: false });
    const link = await this.call<{ ok: boolean; error?: string; permalink: string }>("chat.getPermalink", { channel: posted.channel, message_ts: posted.ts });
    return { ts: posted.ts, permalink: link.permalink };
  }
}
