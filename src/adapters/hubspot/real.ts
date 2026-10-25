/**
 * HubSpot adapter over the public REST API with a private-app token.
 * - Campaigns: GET /marketing/v3/campaigns (name and owner come from properties).
 * - Sign-ups: POST /crm/v3/objects/contacts/search on createdate, grouped by a contact property that holds the
 *   campaign id (HUBSPOT_CAMPAIGN_PROPERTY, default "campaign_id").
 * Endpoint availability depends on your HubSpot tier; check against your developer test account.
 */
import type { Campaign, SignupRow } from "../../types.js";
import type { HubSpotAdapter } from "../types.js";
import { httpJson, type RetryOptions } from "../retry.js";

const BASE = "https://api.hubapi.com";

export class RealHubSpot implements HubSpotAdapter {
  constructor(
    private readonly token: string,
    private readonly campaignProperty: string,
    private readonly retry: RetryOptions = {},
  ) {}

  private headers() {
    return { authorization: `Bearer ${this.token}`, "content-type": "application/json" };
  }

  async listCampaigns(): Promise<Campaign[]> {
    const out: Campaign[] = [];
    let after: string | undefined;
    do {
      const url = new URL(BASE + "/marketing/v3/campaigns");
      url.searchParams.set("limit", "100");
      url.searchParams.set("properties", "hs_name,hs_owner,hs_utm");
      if (after) url.searchParams.set("after", after);
      type Page = { results: { id: string; properties?: Record<string, string> }[]; paging?: { next?: { after: string } } };
      const page = await httpJson<Page>(url.toString(), { headers: this.headers() }, this.retry);
      for (const r of page.results) {
        const p = r.properties ?? {};
        out.push({ id: r.id, name: p.hs_name ?? r.id, network: guessNetwork(p.hs_utm ?? p.hs_name ?? ""), owner: p.hs_owner ?? "unassigned" });
      }
      after = page.paging?.next?.after;
    } while (after);
    return out;
  }

  async getSignups(q: { campaignIds?: string[]; since?: string; until?: string }): Promise<SignupRow[]> {
    const counts = new Map<string, number>();
    let after: string | undefined;
    const filters: Record<string, unknown>[] = [{ propertyName: this.campaignProperty, operator: "HAS_PROPERTY" }];
    if (q.since) filters.push({ propertyName: "createdate", operator: "GTE", value: `${q.since}T00:00:00Z` });
    if (q.until) filters.push({ propertyName: "createdate", operator: "LTE", value: `${q.until}T23:59:59Z` });
    if (q.campaignIds?.length) filters.push({ propertyName: this.campaignProperty, operator: "IN", values: q.campaignIds });
    do {
      type Page = { results: { properties: Record<string, string> }[]; paging?: { next?: { after: string } } };
      const page = await httpJson<Page>(
        BASE + "/crm/v3/objects/contacts/search",
        {
          method: "POST",
          headers: this.headers(),
          body: JSON.stringify({ filterGroups: [{ filters }], properties: ["createdate", this.campaignProperty], limit: 100, after }),
        },
        this.retry,
      );
      for (const r of page.results) {
        const date = (r.properties.createdate ?? "").slice(0, 10);
        const cid = r.properties[this.campaignProperty];
        if (!date || !cid) continue;
        const k = `${date}|${cid}`;
        counts.set(k, (counts.get(k) ?? 0) + 1);
      }
      after = page.paging?.next?.after;
    } while (after);
    return [...counts.entries()].map(([k, n]) => {
      const [date, campaign_id] = k.split("|");
      return { date, campaign_id, signups: n };
    });
  }
}

function guessNetwork(s: string): string {
  const t = s.toLowerCase();
  if (t.includes("meta") || t.includes("facebook") || t.includes("instagram")) return "Meta";
  if (t.includes("google") || t.includes("uac")) return "Google";
  if (t.includes("tiktok")) return "TikTok";
  if (t.includes("applovin")) return "AppLovin";
  return "Other";
}
