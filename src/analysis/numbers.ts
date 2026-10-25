/**
 * "No invented numbers" check. Every number in the report text must appear somewhere in the tool outputs.
 * Numbers are normalised first: $, commas, %, pp and sign are stripped, so "-44.2%" in a tool output
 * matches "44.2%" or "fell 44.2 percent" in the report.
 * A hedged approximation ("about 50%") passes only when it is within 5% of a number a tool returned;
 * an unhedged number has to match exactly.
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

/** "about 50%", "~50%", "roughly 50%", "nearly 50%": an explicitly hedged approximation. */
const HEDGED = /(?:\b(?:about|around|approximately|approx\.?|roughly|nearly|almost)\s+|~\s*)[-+]?\$?(\d[\d,]*(?:\.\d+)?)/gi;
const APPROX_TOLERANCE = 0.05; // within 5% of a number some tool actually returned

export function crossCheckNumbers(reportText: string, sources: string[]): { checked: number; unverified: string[]; approximations: string[] } {
  const allowed = new Set(sources.flatMap(extractNumbers));
  const allowedNums = [...allowed].map(Number);
  const hedged = new Set([...reportText.matchAll(HEDGED)].map((m) => normalise(m[1])).filter((x): x is string => x !== null));
  const found = extractNumbers(reportText).filter((n) => !isTrivial(n));
  const approximations: string[] = [];
  const unverified: string[] = [];
  for (const n of new Set(found)) {
    if (allowed.has(n)) continue;
    const v = Number(n);
    if (hedged.has(n) && allowedNums.some((a) => a !== 0 && Math.abs(Math.abs(a) - v) / Math.abs(a) <= APPROX_TOLERANCE)) approximations.push(n);
    else unverified.push(n);
  }
  return { checked: found.length, unverified, approximations };
}
