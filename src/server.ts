/**
 * HTTP API for n8n (or anything else).
 *   POST /runs                 { brief, requestedBy?, callbackUrl?, scenario?, offline? } -> 202 { runId, statusUrl, reportUrl }
 *   GET  /runs/:id             status + report.json once finished
 *   GET  /runs/:id/report      report.md (text/markdown)
 *   POST /runs/:id/approve     create tasks queued while REQUIRE_APPROVAL=true
 *   GET  /health
 */
import fs from "node:fs";
import path from "node:path";
import Fastify from "fastify";
import { z } from "zod";
import { loadConfig, type Config } from "./config.js";
import { newRunId, pickDriver, runAgent, writeStatus } from "./agent/runner.js";
import { createAdapters } from "./adapters/index.js";
import { Ledger } from "./adapters/ledger.js";

const RunBody = z.object({
  brief: z.string().min(3).max(500),
  requestedBy: z.string().max(100).optional(),
  callbackUrl: z.string().url().optional(),
  scenario: z.string().regex(/^[a-z_]+$/).optional(),
  offline: z.boolean().optional(),
});

const ID = /^[A-Za-z0-9_-]{4,64}$/;

export function buildServer(cfg: Config = loadConfig()) {
  const app = Fastify({ logger: { level: process.env.LOG_LEVEL ?? "info" } });
  const running = new Map<string, Promise<unknown>>();

  app.get("/health", async () => ({ ok: true, mockMode: cfg.mockMode, model: cfg.model }));

  app.post("/runs", async (req, reply) => {
    const parsed = RunBody.safeParse(req.body);
    if (!parsed.success) return reply.code(400).send({ error: parsed.error.issues.map((i) => i.message).join("; ") });
    const body = parsed.data;
    if (body.scenario && !fs.existsSync(path.join(cfg.fixturesDir, "scenarios", body.scenario))) return reply.code(400).send({ error: `unknown scenario ${body.scenario}` });
    let driver;
    try {
      driver = pickDriver(cfg, !!body.offline);
    } catch (e) {
      return reply.code(400).send({ error: (e as Error).message });
    }
    const runId = newRunId();
    fs.mkdirSync(path.join(cfg.runsDir, runId), { recursive: true });
    writeStatus(path.join(cfg.runsDir, runId), { runId, status: "queued", brief: body.brief });
    // Return straight away; the run continues in the background and calls callbackUrl when done.
    const p = runAgent({ ...body, runId, cfg, driver, quiet: true })
      .catch((e) => {
        req.log.error({ runId, err: e }, "run failed");
        writeStatus(path.join(cfg.runsDir, runId), { runId, status: "failed", error: (e as Error).message });
        if (body.callbackUrl)
          return fetch(body.callbackUrl, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ runId, status: "failed", error: (e as Error).message }) }).catch(() => undefined);
      })
      .finally(() => running.delete(runId));
    running.set(runId, p);
    return reply.code(202).send({ runId, statusUrl: `${cfg.publicBaseUrl}/runs/${runId}`, reportUrl: `${cfg.publicBaseUrl}/runs/${runId}/report` });
  });

  app.get<{ Params: { id: string } }>("/runs/:id", async (req, reply) => {
    const { id } = req.params;
    if (!ID.test(id)) return reply.code(400).send({ error: "bad id" });
    const dir = path.join(cfg.runsDir, id);
    const statusFile = path.join(dir, "status.json");
    if (!fs.existsSync(statusFile)) return reply.code(404).send({ error: "not found" });
    const status = JSON.parse(fs.readFileSync(statusFile, "utf8"));
    const reportFile = path.join(dir, "report.json");
    return { ...status, report: fs.existsSync(reportFile) ? JSON.parse(fs.readFileSync(reportFile, "utf8")) : null };
  });

  app.get<{ Params: { id: string } }>("/runs/:id/report", async (req, reply) => {
    const { id } = req.params;
    if (!ID.test(id)) return reply.code(400).send({ error: "bad id" });
    const file = path.join(cfg.runsDir, id, "report.md");
    if (!fs.existsSync(file)) return reply.code(404).send({ error: "report not ready" });
    return reply.type("text/markdown; charset=utf-8").send(fs.readFileSync(file, "utf8"));
  });

  app.post<{ Params: { id: string } }>("/runs/:id/approve", async (req, reply) => {
    const { id } = req.params;
    if (!ID.test(id)) return reply.code(400).send({ error: "bad id" });
    const dir = path.join(cfg.runsDir, id);
    const pendingFile = path.join(dir, "pending_tasks.json");
    if (!fs.existsSync(pendingFile)) return reply.code(404).send({ error: "no pending tasks" });
    type Pending = { gid: string; key: string; name: string; notes: string; assigneeGid: string | null; dueOn: string };
    const pending = JSON.parse(fs.readFileSync(pendingFile, "utf8")) as Pending[];
    const adapters = createAdapters(cfg, dir, {}, { quiet: true });
    const ledger = new Ledger(path.join(dir, "side_effects.json"));
    const created = [];
    for (const p of pending) {
      const { value } = await ledger.once(`${p.key}:approved`, () => adapters.asana.createTask({ name: p.name, notes: p.notes, assigneeGid: p.assigneeGid, dueOn: p.dueOn }));
      created.push({ pending: p.gid, ...value });
    }
    return { approved: created.length, tasks: created };
  });

  return app;
}

const isMain = process.argv[1] && path.resolve(process.argv[1]).endsWith(path.join("src", "server.ts"));
if (isMain) {
  const cfg = loadConfig();
  buildServer(cfg)
    .listen({ port: cfg.port, host: "0.0.0.0" })
    .catch((e) => {
      console.error(e);
      process.exit(1);
    });
}
