import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { describe, expect, it, vi } from "vitest";
import { fetchWithRetry, httpJson, HttpError } from "../src/adapters/retry.js";
import { Ledger } from "../src/adapters/ledger.js";
import { createAsanaTask, postSlackSummary } from "../src/tools/actions.js";
import { makeCtx } from "./helpers.js";
import type { Finding } from "../src/types.js";

const res = (status: number, body = "{}", headers: Record<string, string> = {}) => new Response(body, { status, headers });
const noSleep = { sleep: async () => {}, random: () => 0.5 };

describe("fetchWithRetry", () => {
  it("retries a 429 and succeeds on the next attempt", async () => {
    const f = vi.fn().mockResolvedValueOnce(res(429)).mockResolvedValueOnce(res(200, '{"ok":true}'));
    const retries: unknown[] = [];
    const r = await fetchWithRetry(f, { ...noSleep, onRetry: (i) => retries.push(i) });
    expect(r.status).toBe(200);
    expect(f).toHaveBeenCalledTimes(2);
    expect(retries).toEqual([{ attempt: 1, status: 429, delayMs: 125, error: undefined }]);
  });
  it("does not retry a 400", async () => {
    const f = vi.fn().mockResolvedValue(res(400));
    expect((await fetchWithRetry(f, noSleep)).status).toBe(400);
    expect(f).toHaveBeenCalledTimes(1);
  });
  it("gives up after 3 attempts on 5xx", async () => {
    const f = vi.fn().mockResolvedValue(res(503));
    expect((await fetchWithRetry(f, noSleep)).status).toBe(503);
    expect(f).toHaveBeenCalledTimes(3);
  });
  it("retries network errors and honours Retry-After", async () => {
    const delays: number[] = [];
    const f = vi.fn().mockRejectedValueOnce(new TypeError("fetch failed")).mockResolvedValueOnce(res(429, "{}", { "retry-after": "2" })).mockResolvedValueOnce(res(200));
    await fetchWithRetry(f, { ...noSleep, onRetry: (i) => delays.push(i.delayMs) });
    expect(delays).toEqual([125, 2000]);
  });
  it("exponential backoff grows and is capped", async () => {
    const delays: number[] = [];
    const f = vi.fn().mockResolvedValue(res(500));
    await fetchWithRetry(f, { attempts: 5, baseMs: 1000, maxMs: 3000, sleep: async () => {}, random: () => 0.999, onRetry: (i) => delays.push(i.delayMs) });
    expect(delays).toEqual([999, 1998, 2997, 2997]);
  });
  it("httpJson throws HttpError with the status", async () => {
    const fetchImpl = vi.fn().mockResolvedValue(res(401, '{"message":"bad token"}'));
    await expect(httpJson("https://api.example.com/x", {}, { ...noSleep, fetchImpl })).rejects.toBeInstanceOf(HttpError);
  });
});

describe("Ledger", () => {
  it("runs a side effect once per key, across instances", async () => {
    const file = path.join(fs.mkdtempSync(path.join(os.tmpdir(), "ledger-")), "l.json");
    const fn = vi.fn().mockResolvedValue({ gid: "1" });
    expect((await new Ledger(file).once("k", fn)).replayed).toBe(false);
    expect((await new Ledger(file).once("k", fn)).replayed).toBe(true);
    expect(fn).toHaveBeenCalledTimes(1);
  });
});

describe("idempotent tools", () => {
  const finding = { finding_id: "F-installs-network-Meta-wow" } as Finding;

  it("the same Asana task twice in a run is created once", async () => {
    const ctx = makeCtx();
    ctx.state.findings[finding.finding_id] = finding;
    const spy = vi.spyOn(ctx.adapters.asana, "createTask");
    const args = { title: "Audit the Meta install path", notes: "Check the store listing.", assigneeRole: "ua" as const, dueInDays: 2, findingIds: [finding.finding_id] };
    const a = (await createAsanaTask.handler(args, ctx)) as { gid: string };
    const b = (await createAsanaTask.handler(args, ctx)) as { gid: string; replayed: boolean };
    expect(b.gid).toBe(a.gid);
    expect(b.replayed).toBe(true);
    expect(spy).toHaveBeenCalledTimes(1);
    expect(ctx.state.tasks).toHaveLength(1);
  });

  it("handlers enforce the task cap and finding ids too (defence in depth)", async () => {
    const ctx = makeCtx({ maxAsanaTasks: 1 });
    ctx.state.findings[finding.finding_id] = finding;
    await createAsanaTask.handler({ title: "Task number one", notes: "notes notes", assigneeRole: "ua", dueInDays: 1, findingIds: [finding.finding_id] }, ctx);
    await expect(createAsanaTask.handler({ title: "Task number two", notes: "notes notes", assigneeRole: "ua", dueInDays: 1, findingIds: [finding.finding_id] }, ctx)).rejects.toThrow(/cap/);
    await expect(createAsanaTask.handler({ title: "Task number three", notes: "notes notes", assigneeRole: "ua", dueInDays: 1, findingIds: ["F-made-up"] }, ctx)).rejects.toThrow(/Unknown finding/);
  });

  it("REQUIRE_APPROVAL queues tasks instead of creating them", async () => {
    const ctx = makeCtx({ requireApproval: true });
    ctx.state.findings[finding.finding_id] = finding;
    const spy = vi.spyOn(ctx.adapters.asana, "createTask");
    const r = (await createAsanaTask.handler({ title: "Queued task", notes: "notes notes", assigneeRole: "ua", dueInDays: 1, findingIds: [finding.finding_id] }, ctx)) as { status: string };
    expect(r.status).toBe("pending_approval");
    expect(spy).not.toHaveBeenCalled();
    expect(fs.existsSync(path.join(ctx.runDir, "pending_tasks.json"))).toBe(true);
  });

  it("Slack posts once per run and refuses channels outside the allow-list", async () => {
    const ctx = makeCtx();
    const spy = vi.spyOn(ctx.adapters.slack, "postMessage");
    await postSlackSummary.handler({ headline: "Weekly summary", bullets: ["one bullet"] }, ctx);
    const again = (await postSlackSummary.handler({ headline: "Weekly summary", bullets: ["one bullet"] }, ctx)) as { replayed: boolean };
    expect(again.replayed).toBe(true);
    expect(spy).toHaveBeenCalledTimes(1);

    const bad = makeCtx({ slack: { channelId: "C-GENERAL", allowedChannels: ["C-GROWTH"] } });
    await expect(postSlackSummary.handler({ headline: "Weekly summary", bullets: ["x y z"] }, bad)).rejects.toThrow(/not in SLACK_ALLOWED_CHANNELS/);
  });
});
