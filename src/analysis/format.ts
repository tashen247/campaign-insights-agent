import type { Metric } from "../types.js";

const intFmt = new Intl.NumberFormat("en-US", { maximumFractionDigits: 0 });
const moneyFmt = new Intl.NumberFormat("en-US", { minimumFractionDigits: 2, maximumFractionDigits: 2 });

export function fmtValue(metric: Metric, v: number | null): string {
  if (v === null || !Number.isFinite(v)) return "n/a";
  switch (metric) {
    case "installs":
    case "signups":
      return intFmt.format(Math.round(v));
    case "spend":
      return "$" + intFmt.format(Math.round(v));
    case "cpi":
      return "$" + moneyFmt.format(v);
    case "cvr":
    case "ctr":
    case "signup_rate":
      return (v * 100).toFixed(2) + "%";
  }
}

export function fmtDelta(metric: Metric, d: number | null): string {
  if (d === null || !Number.isFinite(d)) return "n/a";
  const sign = d > 0 ? "+" : d < 0 ? "-" : "";
  const abs = Math.abs(d);
  switch (metric) {
    case "cvr":
    case "ctr":
    case "signup_rate":
      return `${sign}${(abs * 100).toFixed(2)}pp`;
    default:
      return sign + fmtValue(metric, abs);
  }
}

export function fmtPct(p: number | null): string {
  if (p === null || !Number.isFinite(p)) return "n/a";
  const sign = p > 0 ? "+" : p < 0 ? "-" : "";
  return `${sign}${Math.abs(p * 100).toFixed(1)}%`;
}

export function fmtZ(z: number | null): string {
  if (z === null || !Number.isFinite(z)) return "n/a";
  return (z > 0 ? "+" : z < 0 ? "-" : "") + Math.abs(z).toFixed(1);
}

export function slug(s: string): string {
  return s.replace(/[^A-Za-z0-9]+/g, "_").replace(/^_|_$/g, "").slice(0, 40) || "x";
}
