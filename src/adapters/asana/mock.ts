import fs from "node:fs";
import type { AsanaAdapter, AsanaTaskInput } from "../types.js";

export class MockAsana implements AsanaAdapter {
  constructor(private readonly file: string) {}
  async createTask(t: AsanaTaskInput) {
    const list: unknown[] = fs.existsSync(this.file) ? JSON.parse(fs.readFileSync(this.file, "utf8")) : [];
    const gid = `mock-${String(list.length + 1).padStart(4, "0")}`;
    const task = { gid, url: `https://app.asana.com/0/mock/${gid}`, ...t };
    list.push(task);
    fs.writeFileSync(this.file, JSON.stringify(list, null, 2));
    return { gid, url: task.url };
  }
}
