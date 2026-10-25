import fs from "node:fs";
import path from "node:path";
import { z } from "zod";
import { defineTool, ToolError } from "./context.js";
import { assertFindingsExist } from "./analysis.js";
import { hash } from "../adapters/ledger.js";
import { addDays } from "../util/dates.js";
import type { CreatedTask } from "../types.js";

export const ROLES = ["ua", "creative", "analytics"] as const;

export const createAsanaTask = defineTool({
  name: "create_asana_task",
  description:
    "Create one Asana task for a recommended action, assigned by role. Must cite at least one finding_id from analyze_metrics. Max 5 per run. Create none if nothing is anomalous.",
  shape: {
    title: z.string().min(5).max(120),
    notes: z.string().min(10).max(2000),
    assigneeRole: z.enum(ROLES),
    dueInDays: z.number().int().min(0).max(30),
    findingIds: z.array(z.string()).min(1),
  },
  async handler(args, ctx) {
    const { state, cfg, ledger, adapters, owners, reportUrl, runDir } = ctx;
    // Repeated here as well as in the PreToolUse hook: parallel calls can pass the hook before either handler runs.
    assertFindingsExist(args.findingIds, state.findings);
    const key = `asana:${state.runId}:${hash(args.title)}`;
    const prior = ledger.get<CreatedTask>(key);
    if (prior) {
      // Same title in the same run (a retry or a resumed run): return the earlier task, write nothing.
      if (!state.tasks.some((t) => t.gid === prior.gid)) state.tasks.push(prior);
      return { gid: prior.gid, url: prior.url, status: prior.status, replayed: true };
    }
    if (state.tasks.length >= cfg.maxAsanaTasks) throw new ToolError(`Task cap reached (${cfg.maxAsanaTasks} per run).`);

    const owner = owners[args.assigneeRole];
    const notes = `${args.notes}\n\nEvidence: ${args.findingIds.join(", ")}\nReport: ${reportUrl}\nOwner role: ${owner?.name ?? args.assigneeRole}\n(created by campaign-insights-agent run ${state.runId})`;
    const dueOn = addDays(new Date().toISOString().slice(0, 10), args.dueInDays);

    let task: CreatedTask;
    if (cfg.requireApproval) {
      const file = path.join(runDir, "pending_tasks.json");
      const pending: unknown[] = fs.existsSync(file) ? JSON.parse(fs.readFileSync(file, "utf8")) : [];
      const gid = `pending-${pending.length + 1}`;
      pending.push({ gid, key, name: args.title, notes, assigneeGid: owner?.asanaAssigneeGid ?? null, dueOn, assigneeRole: args.assigneeRole, findingIds: args.findingIds });
      fs.writeFileSync(file, JSON.stringify(pending, null, 2));
      task = { gid, url: `${reportUrl.replace(/\/report$/, "")}/approve`, title: args.title, assigneeRole: args.assigneeRole, findingIds: args.findingIds, status: "pending_approval" };
      ledger.set(key, task);
    } else {
      const { value } = await ledger.once(key, async () => {
        const r = await adapters.asana.createTask({ name: args.title, notes, assigneeGid: owner?.asanaAssigneeGid ?? null, dueOn });
        return { ...r, title: args.title, assigneeRole: args.assigneeRole, findingIds: args.findingIds, status: "created" } satisfies CreatedTask;
      });
      task = value;
    }
    state.tasks.push(task);
    return { gid: task.gid, url: task.url, status: task.status, tasksRemaining: cfg.maxAsanaTasks - state.tasks.length };
  },
  summarize: (r) => {
    const t = r as { gid: string; status: string };
    return `${t.status} ${t.gid}`;
  },
});

export const postSlackSummary = defineTool({
  name: "post_slack_summary",
  description:
    "Post the run summary to the team's Slack channel (the channel is fixed by configuration). One post per run. The report link is added for you.",
  shape: {
    headline: z.string().min(5).max(200),
    bullets: z.array(z.string().min(3).max(300)).min(1).max(8),
  },
  async handler(args, { state, cfg, ledger, adapters, reportUrl }) {
    const channel = cfg.slack.channelId;
    if (!cfg.slack.allowedChannels.includes(channel)) throw new ToolError(`Channel ${channel} is not in SLACK_ALLOWED_CHANNELS.`);
    const key = `slack:${state.runId}`;
    const text = [`*${args.headline}*`, ...args.bullets.map((b) => `• ${b}`), `<${reportUrl}|Full report> · run ${state.runId}`].join("\n");
    const { value, replayed } = await ledger.once(key, () => adapters.slack.postMessage({ channel, text }));
    state.slack = value;
    return { ...value, replayed };
  },
  summarize: (r) => `posted ${(r as { permalink: string }).permalink}`,
});
