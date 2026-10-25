/**
 * "No invented numbers" check. Every number in the report text must appear somewhere in the tool outputs.
 * Numbers are normalised first: $, commas, %, pp and sign are stripped, so "-44.2%" in a tool output
 * matches "44.2%" or "fell 44.2 percent" in the report.
 */
const DATE = /\b\d{4}-\d{2}-\d{2}\b/g;
const MONTH = "(?:Jan|Feb|Mar|Apr|May|Jun|Jul|Aug|Sep|Sept|Oct|Nov|Dec)[a-z]*\\.?";
const TEXT_DATE = new RegExp(`\\b(?:${MONTH}\\s+\\d{1,2}(?:\\s*[-–]\\s*\\d{1,2})?|\\d{1,2}(?:\\s*[-–]\\s*\\d{1,2})?\\s+${MONTH})\\b`, "gi");
const IDENT = /\b[A-Za-z][A-Za-z0-9]*(?:[-_][A-Za-z0-9]+)+\b/g; // F-installs-network-Meta-wow, TT-DANCE-A, cmp-meta-pros, run ids
const NUM = /(?<![\w.])[-+]?\$?\d[\d,]*(?:\.\d+)?(?:%|pp)?(?![\w])/g;

export function normalise(token: string): string | null {
  const t = token.replace(/[$,+\-%]|pp$/g, "");
  if (!/^\d+(?:\.\d+)?$/.test(t)) return null;
  const n = Number(t);
  return Number.isFinite(n) ? String(n) : null;
}

export function extractNumbers(text: string): string[] {
  const cleaned = text.replace(DATE, " ").replace(TEXT_DATE, " ").replace(IDENT, " ");
  return (cleaned.match(NUM) ?? []).map(normalise).filter((x): x is string => x !== null);
}

export function isTrivial(n: string): boolean {
  const v = Number(n);
  if (Number.isInteger(v) && v >= 0 && v <= 10) return true; // counts like "3 tasks", "week 8"
  if (Number.isInteger(v) && v >= 1990 && v <= 2100) return true; // years
  return false;
}

export function crossCheckNumbers(reportText: string, sources: string[]): { checked: number; unverified: string[] } {
  const allowed = new Set(sources.flatMap(extractNumbers));
  const found = extractNumbers(reportText).filter((n) => !isTrivial(n));
  const unverified = [...new Set(found.filter((n) => !allowed.has(n)))];
  return { checked: found.length, unverified };
}
