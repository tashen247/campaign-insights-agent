import path from "node:path";

export interface Config {
  root: string;
  anthropicApiKey: string | undefined;
  model: string;
  /** "hermetic" (default): the agent subprocess gets a minimal env. "inherit": it gets the full parent env. */
  agentEnv: "hermetic" | "inherit";
  mockMode: boolean;
  scenario: string;
  maxBudgetUsd: number;
  maxTurns: number;
  maxToolCalls: number;
  maxAsanaTasks: number;
  requireApproval: boolean;
  /** When set, every route except /health needs header x-api-key with this value. */
  apiKey: string | undefined;
  publicBaseUrl: string;
  port: number;
  hubspot: { token?: string; campaignProperty: string };
  asana: { pat?: string; projectGid?: string };
  slack: { botToken?: string; channelId: string; allowedChannels: string[] };
  runsDir: string;
  memoryDir: string;
  fixturesDir: string;
}

function bool(v: string | undefined, d: boolean): boolean {
  if (v === undefined || v === "") return d;
  return ["1", "true", "yes", "on"].includes(v.toLowerCase());
}

function num(v: string | undefined, d: number): number {
  const n = v === undefined || v === "" ? NaN : Number(v);
  return Number.isFinite(n) ? n : d;
}

export function loadConfig(overrides: Partial<Config> = {}, env: NodeJS.ProcessEnv = process.env): Config {
  const root = overrides.root ?? process.cwd();
  const channelId = env.SLACK_CHANNEL_ID || "C0MOCKCHAN";
  const allowed = (env.SLACK_ALLOWED_CHANNELS || channelId)
    .split(",")
    .map((s) => s.trim())
    .filter(Boolean);
  const base: Config = {
    root,
    anthropicApiKey: env.ANTHROPIC_API_KEY || undefined,
    model: env.CLAUDE_MODEL || "claude-sonnet-5-5",
    agentEnv: env.AGENT_ENV === "inherit" ? "inherit" : "hermetic",
    mockMode: bool(env.MOCK_MODE, true),
    scenario: env.SCENARIO || "meta_install_drop",
    maxBudgetUsd: num(env.MAX_BUDGET_USD, 0.5),
    maxTurns: num(env.MAX_TURNS, 20),
    maxToolCalls: num(env.MAX_TOOL_CALLS, 25),
    maxAsanaTasks: num(env.MAX_ASANA_TASKS, 5),
    requireApproval: bool(env.REQUIRE_APPROVAL, false),
    apiKey: env.AGENT_API_KEY || undefined,
    publicBaseUrl: (env.PUBLIC_BASE_URL || `http://localhost:${num(env.PORT, 3000)}`).replace(/\/$/, ""),
    port: num(env.PORT, 3000),
    hubspot: { token: env.HUBSPOT_ACCESS_TOKEN || undefined, campaignProperty: env.HUBSPOT_CAMPAIGN_PROPERTY || "campaign_id" },
    asana: { pat: env.ASANA_PAT || undefined, projectGid: env.ASANA_PROJECT_GID || undefined },
    slack: { botToken: env.SLACK_BOT_TOKEN || undefined, channelId, allowedChannels: allowed },
    runsDir: path.join(root, "runs"),
    memoryDir: path.join(root, "memory"),
    fixturesDir: path.join(root, "fixtures"),
  };
  return { ...base, ...overrides };
}

export function scenarioDir(cfg: Config, scenario = cfg.scenario): string {
  return path.join(cfg.fixturesDir, "scenarios", scenario);
}

export const TENANT_ID = /^[A-Za-z0-9_-]{1,64}$/;

/**
 * Where a run's cross-run memory lives. Without a tenant it is the shared memory/ folder (CLI, n8n).
 * With a tenant (a multi-client host such as the Tash Tech Platform) each client gets its own
 * memory/tenants/<tenant>/, so one client's history is never recalled in another client's report.
 */
export function memoryDirFor(cfg: Config, tenant?: string): string {
  if (!tenant) return cfg.memoryDir;
  if (!TENANT_ID.test(tenant)) throw new Error("tenant must be 1-64 letters, digits, - or _");
  return path.join(cfg.memoryDir, "tenants", tenant);
}
