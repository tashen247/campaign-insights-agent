import path from "node:path";
import { describe, expect, it } from "vitest";
import { CsvError, loadAdSpendCsv, parseAdSpendCsv, summariseFacts } from "../src/data/facts.js";
import { crossCheckNumbers, extractNumbers } from "../src/analysis/numbers.js";
import { REPO } from "./helpers.js";

const HEADER = "date,network,campaign_id,geo,creative_id,impressions,clicks,installs,spend";

describe("CSV parsing", () => {
  it("parses rows into numbers", () => {
    const rows = parseAdSpendCsv(`${HEADER}\n2026-10-01,Meta,c1,ZA,cr1,1000,20,5,12.50\n`);
    expect(rows).toEqual([{ date: "2026-10-01", network: "Meta", campaign_id: "c1", geo: "ZA", creative_id: "cr1", impressions: 1000, clicks: 20, installs: 5, spend: 12.5 }]);
  });
  it("rejects missing columns and bad values", () => {
    expect(() => parseAdSpendCsv("date,network\n2026-10-01,Meta\n")).toThrow(CsvError);
    expect(() => parseAdSpendCsv(`${HEADER}\n2026-10-01,Meta,c1,ZA,cr1,abc,20,5,1\n`)).toThrow(/impressions/);
    expect(() => parseAdSpendCsv(`${HEADER}\n01/10/2026,Meta,c1,ZA,cr1,1,1,1,1\n`)).toThrow(/date/);
  });
  it("loads the generated fixture", () => {
    const rows = loadAdSpendCsv(path.join(REPO, "fixtures/scenarios/meta_install_drop/ad_spend.csv"));
    const s = summariseFacts(rows);
    expect(s.since).toBe("2026-08-24");
    expect(s.until).toBe("2026-10-18");
    expect(s.networks).toEqual(["AppLovin", "Google", "Meta", "TikTok"]);
    expect(s.geos).toHaveLength(5);
    expect(s.creatives).toHaveLength(12);
  });
});

describe("number cross-check", () => {
  it("normalises formatting and ignores ids, dates and small counts", () => {
    expect(extractNumbers("Installs fell -44.2% ($2.14 → $4,290) on 2026-10-12 in TT-DANCE-A, 3 tasks")).toEqual(["44.2", "2.14", "4290", "3"]);
  });
  it("ignores written-out dates but flags rounded numbers", () => {
    expect(extractNumbers("since Oct 12, between 12-18 October and 5 Sept")).toEqual([]);
    expect(crossCheckNumbers("Meta fell 50% from Oct 12", [JSON.stringify({ pct: "-50.8%" })]).unverified).toEqual(["50"]);
  });
  it("accepts a hedged approximation only when it is close to a real number", () => {
    const src = [JSON.stringify({ pct: "-50.8%" })];
    expect(crossCheckNumbers("Meta fell about 50%", src)).toMatchObject({ unverified: [], approximations: ["50"] });
    expect(crossCheckNumbers("Meta fell ~50%", src)).toMatchObject({ unverified: [], approximations: ["50"] });
    expect(crossCheckNumbers("Meta fell about 40%", src).unverified).toEqual(["40"]);
  });
  it("passes numbers that came from tools and fails invented ones", () => {
    const sources = [JSON.stringify({ display: { pct_change: "-44.2%", current: "$4.29", previous: "1,204" } })];
    expect(crossCheckNumbers("Installs dropped 44.2% to 1,204; CPI hit $4.29.", sources).unverified).toEqual([]);
    expect(crossCheckNumbers("Installs dropped 45% and CPI doubled to $4.30.", sources).unverified).toEqual(["45", "4.3"]);
  });
});
