import fs from "node:fs";
import path from "node:path";
import type { Finding } from "../types.js";

export interface PastFinding {
  date: string; // end of the window the finding is about
  runId: string;
  finding_id: string;
  metric: string;
  groupBy: string;
  segment: string;
  pct_change: string;
  summary: string;
}

/**
 * Cross-run memory: memory/insights.jsonl. On first use it is seeded from memory/seed.jsonl
 * (a committed example history) so the demo can show recall without a previous run.
 */
export class InsightMemory {
  private readonly file: string;
  constructor(private readonly dir: string) {
    this.file = path.join(dir, "insights.jsonl");
  }
  private ensure() {
    if (fs.existsSync(this.file)) return;
    fs.mkdirSync(this.dir, { recursive: true });
    const seed = path.join(this.dir, "seed.jsonl");
    fs.writeFileSync(this.file, fs.existsSync(seed) ? fs.readFileSync(seed, "utf8") : "");
  }
  all(): PastFinding[] {
    this.ensure();
    return fs
      .readFileSync(this.file, "utf8")
      .split("\n")
      .filter(Boolean)
      .map((l) => JSON.parse(l) as PastFinding);
  }
  query(q: { campaignId?: string; metric?: string; segment?: string }): PastFinding[] {
    return this.all()
      .filter((f) => (!q.metric || f.metric === q.metric) && (!q.segment || f.segment === q.segment) && (!q.campaignId || f.segment === q.campaignId))
      .sort((a, b) => b.date.localeCompare(a.date))
      .slice(0, 20);
  }
  appendFindings(runId: string, findings: Finding[]) {
    this.ensure();
    const known = new Set(this.all().map((f) => `${f.date}|${f.finding_id}`));
    const lines = findings
      .filter((f) => f.anomaly && f.groupBy !== "total" && !known.has(`${f.current_window.until}|${f.finding_id}`))
      .map((f) =>
        JSON.stringify({
          date: f.current_window.until,
          runId,
          finding_id: f.finding_id,
          metric: f.metric,
          groupBy: f.groupBy,
          segment: f.segment,
          pct_change: f.display.pct_change,
          summary: `${f.metric} ${f.compare} for ${f.groupBy} ${f.segment}: ${f.display.previous} → ${f.display.current} (${f.display.pct_change})`,
        } satisfies PastFinding),
      );
    if (lines.length) fs.appendFileSync(this.file, lines.join("\n") + "\n");
  }
}
