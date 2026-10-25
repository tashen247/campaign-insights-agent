export type Network = string;

/** One row of the attribution export (installs, clicks, spend by day and segment). */
export interface FactRow {
  date: string; // YYYY-MM-DD
  network: Network;
  campaign_id: string;
  geo: string;
  creative_id: string;
  impressions: number;
  clicks: number;
  installs: number;
  spend: number;
}

/** Sign-ups (HubSpot contacts created) per campaign per day. */
export interface SignupRow {
  date: string;
  campaign_id: string;
  signups: number;
}

export interface Campaign {
  id: string;
  name: string;
  network: Network;
  owner: string;
}

export const METRICS = ["installs", "spend", "cpi", "cvr", "ctr", "signups", "signup_rate"] as const;
export type Metric = (typeof METRICS)[number];

export const GROUP_BYS = ["network", "campaign", "geo", "creative"] as const;
export type GroupBy = (typeof GROUP_BYS)[number];

export type Compare = "wow" | "dod";

export type FindingFlag = "anomaly" | "zero_run" | "sustained_decline";

export interface Window {
  since: string;
  until: string;
}

export interface Finding {
  finding_id: string;
  metric: Metric;
  groupBy: GroupBy | "total";
  segment: string;
  segment_label?: string;
  compare: Compare;
  current_window: Window;
  previous_window: Window;
  current: number | null;
  previous: number | null;
  delta: number | null;
  pct_change: number | null;
  z: number | null;
  flags: FindingFlag[];
  anomaly: boolean;
  score: number;
  /** Pre-formatted strings. The model is told to quote these and never compute its own numbers. */
  display: {
    current: string;
    previous: string;
    delta: string;
    pct_change: string;
    z: string;
  };
}

export interface PlanStep {
  id: string;
  goal: string;
  tool: string;
}

export interface CreatedTask {
  gid: string;
  url: string;
  title: string;
  assigneeRole: string;
  findingIds: string[];
  status: "created" | "pending_approval";
}

export interface RunState {
  runId: string;
  brief: string;
  requestedBy: string;
  plan: PlanStep[] | null;
  planRevisions: number;
  datasets: {
    ad_spend?: { rows: number; since: string; until: string; source: string };
    hubspot_signups?: { rows: number; since: string; until: string };
    campaigns?: { count: number };
  };
  facts: FactRow[];
  signups: SignupRow[];
  campaigns: Campaign[];
  findings: Record<string, Finding>;
  tasks: CreatedTask[];
  slack: { ts: string; permalink: string } | null;
  toolCalls: number;
  stopReason: string | null;
}
