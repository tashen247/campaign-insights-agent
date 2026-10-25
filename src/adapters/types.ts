import type { Campaign, SignupRow } from "../types.js";

export interface HubSpotAdapter {
  listCampaigns(range: { since?: string; until?: string }): Promise<Campaign[]>;
  getSignups(q: { campaignIds?: string[]; since?: string; until?: string }): Promise<SignupRow[]>;
}

export interface AsanaTaskInput {
  name: string;
  notes: string;
  assigneeGid?: string | null;
  dueOn: string;
}

export interface AsanaAdapter {
  createTask(t: AsanaTaskInput): Promise<{ gid: string; url: string }>;
}

export interface SlackAdapter {
  postMessage(m: { channel: string; text: string; blocks?: unknown[] }): Promise<{ ts: string; permalink: string }>;
}

export interface Adapters {
  hubspot: HubSpotAdapter;
  asana: AsanaAdapter;
  slack: SlackAdapter;
  adSpendCsvPath: string;
}
