# Campaign insights · eval-meta-install-drop-1-mvnyw67r

> **Brief:** Why did installs drop last week?  
> Requested by cli · status **succeeded** · driver sdk (claude-sonnet-5-5) · scenario meta_install_drop

## Installs fell "-10.6%" week over week ("18,615" vs "20,832"), and the whole drop comes from Meta ("-50.8%", "3,201" vs "6,500").

Meta installs halved in 2026-10-12 to 2026-10-18 [F-installs-network-Meta-wow], in both Retargeting "-50.5%" [F-installs-campaign-cmp_meta_rtg-wow] and Prospecting "-50.9%" [F-installs-campaign-cmp_meta_pros-wow]. CTR was flat, but CVR collapsed to "11.02%" (Retargeting, "-51.0%") [F-cvr-campaign-cmp_meta_rtg-wow] and "13.10%" (Prospecting, "-47.7%") [F-cvr-campaign-cmp_meta_pros-wow]. The drop hit all four Meta creatives equally, e.g. MP-UGC-A "-51.7%" [F-installs-creative-MP_UGC_A-wow]. This points to a post-click problem (store listing, link or attribution), not creative fatigue. A similar Meta drop on 2026-09-14 was traced to a store-listing change.

_Data: fixtures/scenarios/meta_install_drop/ad_spend.csv, 2026-08-24 to 2026-10-18._

## Findings

| # | Finding | Previous | Current | Change | z | Flags | Note |
|---|---|---|---|---|---|---|---|
| 1 | `F-installs-network-Meta-wow` | 6,500 | 3,201 | -50.8% | -14.7 | anomaly | Meta installs 3,201 vs 6,500 (-50.8%), z -14.7; the only network flagged. Spend was only -8.7%. |
| 2 | `F-cvr-campaign-cmp_meta_rtg-wow` | 22.49% | 11.02% | -51.0% | -25.4 | anomaly | Meta Retargeting CVR 11.02% vs 22.49% (-51.0%) with CTR flat. |
| 3 | `F-cvr-campaign-cmp_meta_pros-wow` | 25.07% | 13.10% | -47.7% | -15.4 | anomaly | Meta Prospecting CVR 13.10% vs 25.07% (-47.7%) with CTR flat. |
| 4 | `F-installs-campaign-cmp_meta_rtg-wow` | 2,443 | 1,209 | -50.5% | -19.5 | anomaly | Meta Retargeting installs 1,209 vs 2,443 (-50.5%). |
| 5 | `F-installs-campaign-cmp_meta_pros-wow` | 4,057 | 1,992 | -50.9% | -10.0 | anomaly | Meta Prospecting installs 1,992 vs 4,057 (-50.9%). |
| 6 | `F-installs-creative-MP_UGC_A-wow` | 2,248 | 1,085 | -51.7% | -10.5 | anomaly | All four Meta creatives fell about 50%, so this is not a single-creative issue. Example: MP-UGC-A -51.7%. |

## Recommendations

1. **Audit Meta store listing and click-to-install path** (high, owner: ua)  
   CVR halved while CTR stayed flat. A similar drop on 2026-09-14 came from a store-listing change.  
   Evidence: `F-installs-network-Meta-wow`, `F-cvr-campaign-cmp_meta_rtg-wow`, `F-cvr-campaign-cmp_meta_pros-wow`
2. **Verify Meta install attribution and tracking** (high, owner: analytics)  
   Rule out under-counted installs from MMP, SDK or tracking-link changes. Signup rate is stable, so remaining installs look normal.  
   Evidence: `F-installs-campaign-cmp_meta_rtg-wow`, `F-installs-campaign-cmp_meta_pros-wow`
3. **Review Meta budgets while CVR is depressed** (medium, owner: ua)  
   Spend is almost unchanged while installs halved, so efficiency is lost. A temporary cap may be worth it.  
   Evidence: `F-installs-network-Meta-wow`, `F-installs-creative-MP_UGC_A-wow`

## Actions taken

- Asana [mock-0001](https://app.asana.com/0/mock/mock-0001) · created · ua · Audit Meta store listing / click-to-install path (CVR halved)
- Asana [mock-0002](https://app.asana.com/0/mock/mock-0002) · created · analytics · Verify Meta install attribution/SDK/MMP link tracking
- Asana [mock-0003](https://app.asana.com/0/mock/mock-0003) · created · ua · Review Meta budgets while CVR is depressed
- Slack: https://example.slack.com/archives/C0MOCKCHAN/p1792941213000100

## Plan

1. Load ad spend data — `load_ad_spend_csv`
2. Load campaigns and signups — `list_campaigns, get_campaign_metrics`
3. Installs by network, then drill into cvr/cpi/ctr by campaign/geo/creative — `analyze_metrics`
4. Check past findings — `recall_past_findings`
5. Create Asana tasks and post Slack — `create_asana_task, post_slack_summary`

## Limitations

- The data has no store-listing change log, tracking-template history or platform (iOS/Android) split, so the root cause is inferred, not confirmed.
- Geo installs fell about 10% in every market, but none was flagged. This looks like the Meta decline spread across geos, not a geo-specific problem.
- Total installs and total CVR were not flagged by the tool, so I treat them as context only.
- Meta spend (-8.7%) was not flagged either.

---
Cost $0.1153 · 19 model turns · 17 tool calls · 31 numbers cross-checked (1 hedged approximations). Trace: `runs/eval-meta-install-drop-1-mvnyw67r/trace.jsonl` (`npm run trace eval-meta-install-drop-1-mvnyw67r`).
