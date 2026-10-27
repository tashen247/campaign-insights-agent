import fs from "node:fs";
import path from "node:path";
import { describe, expect, it } from "vitest";
import { buildServer } from "../src/server.js";
import { memoryDirFor } from "../src/config.js";
import { tmpConfig } from "./helpers.js";

const done = ["succeeded", "succeeded_with_warnings", "failed", "stopped"];

async function waitFor(app: ReturnType<typeof buildServer>, runId: string, headers: Record<string, string>) {
  let status = "";
  for (let i = 0; i < 80 && !done.includes(status); i++) {
    await new Promise((r) => setTimeout(r, 100));
    status = (await app.inject({ url: `/runs/${runId}`, headers })).json().status;
  }
  return status;
}

describe("multi-client hosting", () => {
  it("requires the API key on every route but /health when AGENT_API_KEY is set", async () => {
    const app = buildServer(tmpConfig({ apiKey: "s3cret-key" }));
    expect((await app.inject({ url: "/health" })).statusCode).toBe(200);
    expect((await app.inject({ method: "POST", url: "/runs", payload: { brief: "Why did installs drop?", offline: true } })).statusCode).toBe(401);
    expect((await app.inject({ url: "/runs/abcd", headers: { "x-api-key": "wrong" } })).statusCode).toBe(401);
    expect((await app.inject({ url: "/runs/abcd", headers: { "x-api-key": "s3cret-key" } })).statusCode).toBe(404);
    await app.close();
  });

  it("keeps each tenant's memory and runs to itself", async () => {
    const cfg = tmpConfig();
    const app = buildServer(cfg);
    const post = await app.inject({ method: "POST", url: "/runs", payload: { brief: "Why did installs drop last week?", offline: true, tenant: "t1" } });
    expect(post.statusCode).toBe(202);
    const { runId } = post.json();
    expect(await waitFor(app, runId, { "x-tenant": "t1" })).toBe("succeeded");

    // another tenant, or no tenant, cannot see the run or its report
    expect((await app.inject({ url: `/runs/${runId}`, headers: { "x-tenant": "t2" } })).statusCode).toBe(404);
    expect((await app.inject({ url: `/runs/${runId}` })).statusCode).toBe(404);
    expect((await app.inject({ url: `/runs/${runId}/report`, headers: { "x-tenant": "t2" } })).statusCode).toBe(404);
    expect((await app.inject({ url: `/runs/${runId}/report`, headers: { "x-tenant": "t1" } })).statusCode).toBe(200);

    // the run's findings went to t1's memory only, never to the shared file or another tenant
    const t1 = path.join(memoryDirFor(cfg, "t1"), "insights.jsonl");
    expect(fs.readFileSync(t1, "utf8")).toContain(runId);
    const shared = path.join(cfg.memoryDir, "insights.jsonl");
    expect(fs.existsSync(shared) ? fs.readFileSync(shared, "utf8") : "").not.toContain(runId);
    expect(fs.existsSync(path.join(memoryDirFor(cfg, "t2"), "insights.jsonl"))).toBe(false);
    await app.close();
  });

  it("starts a real (non-mock) tenant's memory empty instead of the demo history", async () => {
    const cfg = tmpConfig({ mockMode: false });
    const { InsightMemory } = await import("../src/memory/store.js");
    const mem = new InsightMemory(memoryDirFor(cfg, "client-a"), null);
    expect(mem.all()).toEqual([]);
    expect(() => memoryDirFor(cfg, "../escape")).toThrow();
  });

  it("marks approved tasks as created in report.json", async () => {
    const app = buildServer(tmpConfig({ requireApproval: true }));
    const { runId } = (await app.inject({ method: "POST", url: "/runs", payload: { brief: "Why did installs drop last week?", offline: true, tenant: "t1" } })).json();
    const h = { "x-tenant": "t1" };
    expect(await waitFor(app, runId, h)).toBe("succeeded");
    const before = (await app.inject({ url: `/runs/${runId}`, headers: h })).json().report.tasks;
    expect(before.length).toBeGreaterThan(0);
    expect(before.every((t: { status: string }) => t.status === "pending_approval")).toBe(true);
    expect((await app.inject({ method: "POST", url: `/runs/${runId}/approve`, headers: { "x-tenant": "t2" } })).statusCode).toBe(404);
    const approved = (await app.inject({ method: "POST", url: `/runs/${runId}/approve`, headers: h })).json();
    expect(approved.approved).toBe(before.length);
    const after = (await app.inject({ url: `/runs/${runId}`, headers: h })).json().report.tasks;
    expect(after.every((t: { status: string; gid: string }) => t.status === "created" && !t.gid.startsWith("pending-"))).toBe(true);
    await app.close();
  });

  it("rejects a malformed tenant id", async () => {
    const app = buildServer(tmpConfig());
    expect((await app.inject({ method: "POST", url: "/runs", payload: { brief: "hello there", offline: true, tenant: "../x" } })).statusCode).toBe(400);
    await app.close();
  });
});
