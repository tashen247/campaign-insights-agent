import fs from "node:fs";
import { parse } from "csv-parse/sync";
import type { FactRow } from "../types.js";

const REQUIRED = ["date", "network", "campaign_id", "geo", "creative_id", "impressions", "clicks", "installs", "spend"] as const;

export class CsvError extends Error {}

/** Parse an attribution export. Validates the header and every numeric field. */
export function parseAdSpendCsv(text: string): FactRow[] {
  const records = parse(text, { columns: true, skip_empty_lines: true, trim: true }) as Record<string, string>[];
  if (records.length === 0) return [];
  const cols = Object.keys(records[0]);
  const missing = REQUIRED.filter((c) => !cols.includes(c));
  if (missing.length) throw new CsvError(`CSV is missing columns: ${missing.join(", ")}`);
  return records.map((r, i) => {
    if (!/^\d{4}-\d{2}-\d{2}$/.test(r.date)) throw new CsvError(`Row ${i + 2}: bad date "${r.date}"`);
    const n = (k: string) => {
      const v = Number(r[k]);
      if (!Number.isFinite(v) || v < 0) throw new CsvError(`Row ${i + 2}: bad ${k} "${r[k]}"`);
      return v;
    };
    return {
      date: r.date,
      network: r.network,
      campaign_id: r.campaign_id,
      geo: r.geo,
      creative_id: r.creative_id,
      impressions: n("impressions"),
      clicks: n("clicks"),
      installs: n("installs"),
      spend: n("spend"),
    };
  });
}

export function loadAdSpendCsv(file: string): FactRow[] {
  return parseAdSpendCsv(fs.readFileSync(file, "utf8"));
}

export function summariseFacts(rows: FactRow[]) {
  const dates = rows.map((r) => r.date).sort();
  const uniq = (k: keyof FactRow) => [...new Set(rows.map((r) => String(r[k])))].sort();
  return {
    rows: rows.length,
    since: dates[0] ?? null,
    until: dates[dates.length - 1] ?? null,
    networks: uniq("network"),
    campaigns: uniq("campaign_id"),
    geos: uniq("geo"),
    creatives: uniq("creative_id"),
  };
}
