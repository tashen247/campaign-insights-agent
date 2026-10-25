# Campaign insights · live-demo-2

> **Brief:** Why did installs drop last week?  
> Requested by cli · status **succeeded_with_warnings** · driver sdk (claude-sonnet-5-5) · scenario meta_install_drop

## Installs fell -10.6% last week (18,615 vs 20,832), almost entirely because Meta dropped -50.8% (3,201 vs 6,500).

Meta is the only network flagged as an anomaly. Both Meta campaigns fell about 50% [F-installs-campaign-cmp_meta_pros-wow, F-installs-campaign-cmp_meta_rtg-wow], and so did all four Meta creatives [F-installs-creative-MP_UGC_A-wow]. Meta CVR fell from 24.03% to 12.23% [F-cvr-network-Meta-wow] while spend only dipped -8.7%, so the same spend bought far fewer installs. Sign-up rate stayed flat, which points to a click-to-install problem such as a store listing, attribution or landing change, not a sign-up tracking fault. A similar Meta drop on 2026-09-14 was traced to a store-listing change [F-installs-network-Meta-wow].

_Data: fixtures/scenarios/meta_install_drop/ad_spend.csv, 2026-08-24 to 2026-10-18._

## Findings

| # | Finding | Previous | Current | Change | z | Flags | Note |
|---|---|---|---|---|---|---|---|
| 1 | `F-installs-network-Meta-wow` | 6,500 | 3,201 | -50.8% | -14.7 | anomaly | Meta installs 3,201 vs 6,500 (-50.8%, z -14.7). Past Meta drop on 2026-09-14 was a store-listing change. |
| 2 | `F-cvr-network-Meta-wow` | 24.03% | 12.23% | -49.1% | -29.2 | anomaly | Meta CVR 12.23% vs 24.03% (-49.1%, z -29.2); this is the mechanism, since spend only fell -8.7%. |
| 3 | `F-installs-campaign-cmp_meta_pros-wow` | 4,057 | 1,992 | -50.9% | -10.0 | anomaly | Meta Prospecting installs 1,992 vs 4,057 (-50.9%). |
| 4 | `F-installs-campaign-cmp_meta_rtg-wow` | 2,443 | 1,209 | -50.5% | -19.5 | anomaly | Meta Retargeting installs 1,209 vs 2,443 (-50.5%). |
| 5 | `F-installs-creative-MP_UGC_A-wow` | 2,248 | 1,085 | -51.7% | -10.5 | anomaly | All four Meta creatives dropped about 50% (MP-UGC-A -51.7%, MP-STATIC-B -49.9%, MR-CAROUSEL-A -50.7%, MR-VIDEO-B -50.3%), which suggests a shared cause. |

## Recommendations

1. **Investigate Meta CVR collapse** (high, owner: ua)  
   CVR halved on both Meta campaigns with spend nearly flat. Check store listing, links and campaign changes from Oct 12.  
   Evidence: `F-installs-network-Meta-wow`, `F-cvr-network-Meta-wow`, `F-installs-campaign-cmp_meta_pros-wow`, `F-installs-campaign-cmp_meta_rtg-wow`
2. **Review the four Meta creatives** (medium, owner: creative)  
   The uniform ~50% drop suggests delivery or approval problems, not fatigue. Confirm creative status.  
   Evidence: `F-installs-creative-MP_UGC_A-wow`, `F-installs-creative-MP_STATIC_B-wow`, `F-installs-creative-MR_CAROUSEL_A-wow`, `F-installs-creative-MR_VIDEO_B-wow`
3. **Verify Meta attribution after Oct 12** (high, owner: analytics)  
   Rule out postback or SDK gaps between click and install.  
   Evidence: `F-cvr-network-Meta-wow`

## Actions taken

- Asana [mock-0001](https://app.asana.com/0/mock/mock-0001) · created · ua · Investigate Meta CVR collapse (12.23% vs 24.03%)
- Asana [mock-0002](https://app.asana.com/0/mock/mock-0002) · created · creative · Review Meta creatives MP-UGC-A, MP-STATIC-B, MR-CAROUSEL-A, MR-VIDEO-B
- Asana [mock-0003](https://app.asana.com/0/mock/mock-0003) · created · analytics · Verify Meta click-to-install attribution after Oct 12
- Slack: https://example.slack.com/archives/C0MOCKCHAN/p1792940659000100

## Plan

1. Load ad spend data — `load_ad_spend_csv`
2. Load campaigns and signups — `list_campaigns + get_campaign_metrics`
3. Installs by network, then drill into cvr/cpi/ctr by campaign/geo/creative — `analyze_metrics`
4. Check past findings — `recall_past_findings`
5. Create Asana tasks and Slack post — `create_asana_task, post_slack_summary`

## Limitations

- I did not check CTR or CVR by creative or geo, so I can't say which Meta placements or creatives lost conversion.
- The cause is inferred from patterns and the earlier store-listing incident. No change log was available to confirm it.
- The total install decline (-10.6%) and the geo declines were not flagged as anomalies by the tool. They are context and follow from the Meta drop.
- Only 3 of a possible 5 Asana tasks were created.
- Numbers not found in any tool output: 50, 12.

---
Cost $0.1035 · 18 model turns · 16 tool calls · 32 numbers cross-checked. Trace: `runs/live-demo-2/trace.jsonl` (`npm run trace live-demo-2`).
