import { describe, expect, it } from "vitest";
import http from "node:http";
import type { AddressInfo } from "node:net";
import { buildServer } from "../src/server.js";
import { tmpConfig } from "./helpers.js";

describe("HTTP API", () => {
  it("accepts a run (202), runs it in the background and calls back", async () => {
    // a tiny callback receiver standing in for n8n's Wait-node resume URL
    const received: unknown[] = [];
    const cb = http.createServer((req, res) => {
      let body = "";
      req.on("data", (c) => (body += c));
      req.on("end", () => {
        received.push(JSON.parse(body));
        res.end("ok");
      });
    });
    await new Promise<void>((r) => cb.listen(0, r));
    const callbackUrl = `http://127.0.0.1:${(cb.address() as AddressInfo).port}/resume`;

    const app = buildServer(tmpConfig());
    const post = await app.inject({ method: "POST", url: "/runs", payload: { brief: "Why did installs drop last week?", offline: true, callbackUrl } });
    expect(post.statusCode).toBe(202);
    const { runId } = post.json();

    let status = "";
    for (let i = 0; i < 50 && !["succeeded", "succeeded_with_warnings", "failed", "stopped"].includes(status); i++) {
      await new Promise((r) => setTimeout(r, 100));
      status = (await app.inject({ url: `/runs/${runId}` })).json().status;
    }
    expect(status).toBe("succeeded");
    const report = await app.inject({ url: `/runs/${runId}/report` });
    expect(report.headers["content-type"]).toMatch(/markdown/);
    expect(report.body).toContain("Campaign insights");
    for (let i = 0; i < 20 && received.length === 0; i++) await new Promise((r) => setTimeout(r, 50));
    expect(received[0]).toMatchObject({ runId, status: "succeeded" });
    cb.close();
    await app.close();
  });

  it("validates input", async () => {
    const app = buildServer(tmpConfig());
    expect((await app.inject({ method: "POST", url: "/runs", payload: { brief: "x" } })).statusCode).toBe(400);
    expect((await app.inject({ method: "POST", url: "/runs", payload: { brief: "hello there", scenario: "nope" } })).statusCode).toBe(400);
    expect((await app.inject({ url: "/runs/..%2Fetc" })).statusCode).toBe(400);
    expect((await app.inject({ url: "/runs/does-not-exist" })).statusCode).toBe(404);
    await app.close();
  });
});
