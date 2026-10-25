import fs from "node:fs";
import path from "node:path";
import type { Campaign, SignupRow } from "../../types.js";
import type { HubSpotAdapter } from "../types.js";

export class MockHubSpot implements HubSpotAdapter {
  constructor(private readonly dir: string) {}
  private read<T>(f: string): T {
    return JSON.parse(fs.readFileSync(path.join(this.dir, f), "utf8")) as T;
  }
  async listCampaigns(): Promise<Campaign[]> {
    return this.read<Campaign[]>("hubspot_campaigns.json");
  }
  async getSignups(q: { campaignIds?: string[]; since?: string; until?: string }): Promise<SignupRow[]> {
    const ids = q.campaignIds?.length ? new Set(q.campaignIds) : null;
    return this.read<SignupRow[]>("hubspot_signups.json").filter(
      (r) => (!ids || ids.has(r.campaign_id)) && (!q.since || r.date >= q.since) && (!q.until || r.date <= q.until),
    );
  }
}
