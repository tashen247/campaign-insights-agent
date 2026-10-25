import fs from "node:fs";
import type { SlackAdapter } from "../types.js";

export class MockSlack implements SlackAdapter {
  constructor(
    private readonly file: string,
    private readonly print = true,
  ) {}
  async postMessage(m: { channel: string; text: string; blocks?: unknown[] }) {
    const ts = `${Math.floor(Date.now() / 1000)}.000100`;
    const permalink = `https://example.slack.com/archives/${m.channel}/p${ts.replace(".", "")}`;
    const list: unknown[] = fs.existsSync(this.file) ? JSON.parse(fs.readFileSync(this.file, "utf8")) : [];
    list.push({ ...m, ts, permalink });
    fs.writeFileSync(this.file, JSON.stringify(list, null, 2));
    if (this.print) console.log(`\n[mock slack → ${m.channel}]\n${m.text}\n`);
    return { ts, permalink };
  }
}
