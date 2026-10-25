import path from "node:path";
import { scenarioDir, type Config } from "../config.js";
import type { Adapters } from "./types.js";
import type { RetryOptions } from "./retry.js";
import { MockHubSpot } from "./hubspot/mock.js";
import { RealHubSpot } from "./hubspot/real.js";
import { MockAsana } from "./asana/mock.js";
import { RealAsana } from "./asana/real.js";
import { MockSlack } from "./slack/mock.js";
import { RealSlack } from "./slack/real.js";

export class ConfigError extends Error {}

/** Mocks by default. With MOCK_MODE=false each integration needs its credentials. */
export function createAdapters(cfg: Config, runDir: string, retry: RetryOptions, opts: { scenario?: string; quiet?: boolean } = {}): Adapters {
  const dir = scenarioDir(cfg, opts.scenario ?? cfg.scenario);
  if (cfg.mockMode) {
    return {
      hubspot: new MockHubSpot(dir),
      asana: new MockAsana(path.join(runDir, "asana.json")),
      slack: new MockSlack(path.join(runDir, "slack.json"), !opts.quiet),
      adSpendCsvPath: path.join(dir, "ad_spend.csv"),
    };
  }
  const missing: string[] = [];
  if (!cfg.hubspot.token) missing.push("HUBSPOT_ACCESS_TOKEN");
  if (!cfg.asana.pat) missing.push("ASANA_PAT");
  if (!cfg.asana.projectGid) missing.push("ASANA_PROJECT_GID");
  if (!cfg.slack.botToken) missing.push("SLACK_BOT_TOKEN");
  if (missing.length) throw new ConfigError(`MOCK_MODE=false but these are not set: ${missing.join(", ")}`);
  return {
    hubspot: new RealHubSpot(cfg.hubspot.token!, cfg.hubspot.campaignProperty, retry),
    asana: new RealAsana(cfg.asana.pat!, cfg.asana.projectGid!, retry),
    slack: new RealSlack(cfg.slack.botToken!, retry),
    adSpendCsvPath: path.join(cfg.root, "data", "ad_spend.csv"),
  };
}
