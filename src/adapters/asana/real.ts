import type { AsanaAdapter, AsanaTaskInput } from "../types.js";
import { httpJson, type RetryOptions } from "../retry.js";

export class RealAsana implements AsanaAdapter {
  constructor(
    private readonly pat: string,
    private readonly projectGid: string,
    private readonly retry: RetryOptions = {},
  ) {}
  async createTask(t: AsanaTaskInput) {
    const body = {
      data: {
        name: t.name,
        notes: t.notes,
        projects: [this.projectGid],
        due_on: t.dueOn,
        ...(t.assigneeGid ? { assignee: t.assigneeGid } : {}),
      },
    };
    const res = await httpJson<{ data: { gid: string; permalink_url?: string } }>(
      "https://app.asana.com/api/1.0/tasks?opt_fields=gid,permalink_url",
      { method: "POST", headers: { authorization: `Bearer ${this.pat}`, "content-type": "application/json" }, body: JSON.stringify(body) },
      this.retry,
    );
    return { gid: res.data.gid, url: res.data.permalink_url ?? `https://app.asana.com/0/${this.projectGid}/${res.data.gid}` };
  }
}
