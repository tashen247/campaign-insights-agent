# campaign-insights-agent

![ci](https://github.com/tashen247/campaign-insights-agent/actions/workflows/ci.yml/badge.svg)

One question in; out come a ranked diagnosis, evidence-cited recommendations, up to five Asana tasks and one Slack summary, every step traced and costed (about $0.09 a run).

Ask *"Why did installs drop last week?"* in an n8n form, a webhook or the CLI. A Claude Agent SDK agent writes a plan, pulls campaign data from HubSpot and an attribution export, runs deterministic checks, and comes back with a ranked diagnosis, evidence-backed recommendations, Asana tasks assigned by role and one Slack summary. Every step, tool call, guardrail block and cent is in a JSONL trace.

![Demo: one question in, diagnosis, Asana tasks and Slack summary out](docs/demo.gif)

```
$ npm run demo -- "Why did installs drop last week?"
     0ms  run 20261025-150512-8c1e · driver=sdk · scenario=meta_install_drop
  5131ms  → submit_plan {"steps":[{"id":"1","goal":"Load ad spend data",...
  5153ms  plan r0: load_ad_spend_csv → list_campaigns → get_campaign_metrics → analyze_metrics → ...
 11604ms  ✓ analyze_metrics installs by network: 1 anomalies (F-installs-network-Meta-wow)
 13659ms  ✓ analyze_metrics cvr by network: 1 anomalies (F-cvr-network-Meta-wow)
 26161ms  ✓ create_asana_task created mock-0001
 32233ms  ✓ post_slack_summary posted https://example.slack.com/archives/...
 32557ms  $ 0.1035 · turns=18 · success

SUCCEEDED · Installs fell -10.6% last week (18,615 vs 20,832), almost entirely because Meta dropped -50.8% (3,201 vs 6,500).
```

Full reports and traces from live runs are in [`docs/examples/`](docs/examples/).

## Why I built it

I've spent 24 years building integration and messaging systems. I wanted to see how far an agent could take a growth question on its own, end to end, safely: not a dashboard someone still has to read, but the diagnosis, the actions and the owners, with a record of how it got there.

## How it works

```mermaid
flowchart LR
  U[Marketer: n8n Form / Webhook] --> N[n8n workflow]
  N -->|POST /runs + callbackUrl| API[Fastify API: 202 runId]
  API --> R[Runner]
  R --> SDK[SdkDriver: Claude Agent SDK]
  R --> OFF[OfflineDriver: deterministic baseline]
  SDK <--> MCP[In-process MCP server: 9 campaign tools]
  OFF --> MCP
  MCP --> HS[HubSpot: real or mock]
  MCP --> CSV[Attribution CSV]
  MCP --> AN[Analysis: pure TypeScript]
  MCP --> AS[Asana: real or mock]
  MCP --> SL[Slack: real or mock]
  R --> TR[(runs/id: trace.jsonl, report.md, report.json)]
  API -->|POST resume URL| N
  N --> SL2[Slack: link to report]
```

**The loop**

1. **Plan first.** The first tool call must be `submit_plan`. A `PreToolUse` hook denies every other tool until a plan exists, and allows one revision with a reason. The trace proves the order.
2. **Load.** `load_ad_spend_csv` (installs, clicks, impressions, spend by day, network, campaign, geo and creative) plus `list_campaigns` and `get_campaign_metrics` (HubSpot campaign registry and sign-ups). HubSpot is a CRM, so it supplies campaigns and sign-ups. Installs and spend come from the attribution export, the way they would from AppsFlyer or Adjust.
3. **Analyse.** `analyze_metrics` does week-over-week (or day-over-day) deltas, z-scores against trailing history, zero-runs and sustained declines, in TypeScript. Each finding gets a stable id (`F-installs-network-Meta-wow`) and pre-formatted display strings.
4. **Remember.** `recall_past_findings` reads `memory/insights.jsonl`, so the agent can say "a similar drop on 2026-09-14 was traced to a store-listing change". Every run appends its anomalies.
5. **Act.** `create_asana_task` (cited findings, role-based owner, due date) and one `post_slack_summary`.
6. **Report.** The final answer comes back as JSON through `outputFormat`. It is validated with zod, cross-checked against the run's findings, and rendered to `report.md`.

**Tools** (MCP server `campaign`): `submit_plan`, `get_run_state`, `list_campaigns`, `get_campaign_metrics`, `load_ad_spend_csv`, `analyze_metrics`, `recall_past_findings`, `create_asana_task`, `post_slack_summary`. The SDK's built-in tools are switched off (`tools: []`, plus `disallowedTools` as a second layer), each campaign tool is allow-listed by full name, and `permissionMode: "dontAsk"` denies anything else.

## Quick start

Node 22+.

```bash
npm install
npm run demo -- "Why did installs drop last week?" --offline   # no API key: deterministic baseline
cp .env.example .env                                            # add ANTHROPIC_API_KEY
npm run demo -- "Why did installs drop last week?"              # live model, mock integrations
npm run trace <runId>                                           # timeline, tool calls, cost
```

Other scenarios: `--scenario geo_cpi_spike | creative_fatigue | tracking_outage | no_anomaly | prompt_injection`. Run outputs land in `runs/<runId>/`: `trace.jsonl`, `report.md`, `report.json`, `state.json`, `side_effects.json`, and the mock `asana.json` and `slack.json`.

**Real sandboxes.** Set `MOCK_MODE=false` and fill in the HubSpot private-app token (developer test account), an Asana PAT and project gid, a Slack bot token, channel id and allow-list, then put your attribution export at `data/ad_spend.csv`. The real adapters use `fetch` behind one retry wrapper.

**API.** `npm start` serves:

| Endpoint | What it does |
|---|---|
| `POST /runs` `{ brief, requestedBy?, callbackUrl?, scenario?, offline? }` | Returns `202 { runId }` straight away and runs in the background. POSTs `{ runId, status, headline, reportUrl, costUsd, tasks }` to `callbackUrl` when done. |
| `GET /runs/:id` | Status plus `report.json` |
| `GET /runs/:id/report` | `report.md` |
| `POST /runs/:id/approve` | Creates tasks queued while `REQUIRE_APPROVAL=true` |
| `GET /health` | Liveness |

## The n8n workflow

`docker compose up` starts the agent on :3000 and n8n on :5678. Import [`n8n/campaign-insights.json`](n8n/campaign-insights.json) (also mounted at `/workflows` in the container):

**Webhook / Form / Monday 08:00 schedule → Normalise brief → Start agent run (HTTP POST with `callbackUrl = $execution.resumeUrl`) → Wait (resume on webhook call) → Run succeeded? → Slack: report link / Slack: run failed**

The resume URL is different for every execution, so it travels in the request body, not in an env var. Set your Slack credential and channel id on the two Slack nodes. I've run it end to end with `docker compose` (n8n 1.123): Webhook → agent run → Wait resumed by the agent's callback → IF → Slack ([screenshot](docs/n8n-run.png); Slack nodes deactivated because no workspace was connected). To try it without an API key, send `"offline": true` in the webhook body. The Form trigger works locally. A Slack slash command needs a public URL and a 3-second ack, so put a tunnel (cloudflared or ngrok) in front of n8n if you want one.

## Guardrails and cost controls

| Control | Where |
|---|---|
| Plan before anything else; one revision, with a reason | `PreToolUse` hook |
| Only campaign tools; built-ins removed | `tools: []`, explicit `allowedTools`, `disallowedTools`, `dontAsk`, hook allow-list |
| At most 5 Asana tasks, 1 Slack post | Hook **and** tool handler. Parallel tool calls can pass the hook before either handler runs. |
| Every task cites findings that exist in this run | Hook and handler |
| Slack channel is configuration, never a tool input, and must be allow-listed | Slack tool + adapter |
| Idempotent per run: replaying a run never duplicates a task or post | `runs/<id>/side_effects.json` ledger |
| Optional human approval before tasks are created | `REQUIRE_APPROVAL=true`, `POST /runs/:id/approve` |
| `maxTurns: 20`, `maxBudgetUsd: 0.50`, hard stop after 25 tool calls | SDK options + hook (`continue: false`) |
| A stop at any limit still produces a report that says which limit | Runner fallback report |
| Untrusted data stays data | Prompt rule + `prompt_injection` eval |
| Retries: 3 attempts, exponential backoff with full jitter, 429/5xx/network only, `Retry-After` honoured | `src/adapters/retry.ts` |
| The SDK's agent subprocess gets a minimal environment | `AGENT_ENV=hermetic` (default) |

**Why the maths isn't done by the model.** A language model asked to "compare last week with the week before" will do arithmetic in its head, and sometimes it gets it wrong in a convincing way. Here every number comes from `analyze_metrics`, which is pure, deterministic and unit-tested. The tool returns display strings (`"-50.8%"`, `"$4.06"`) and the prompt tells the model to quote them, never to compute or round. The runner then checks that every number in the report appears in some tool output, and the evals fail any run that invents one.

## Evals

`npm run eval` runs 6 seeded scenarios against the live model (3 repeats by default). `npm run eval -- --offline` runs the deterministic baseline, which CI runs on every push.

Each run must pass: `completed`, `plan_first`, `root_cause_top2` (or, for `no_anomaly`, no anomaly claimed and no tasks), `recommendations_cited`, `min_recommendations`, `task_cap`, `slack_once`, `ignored_injection` (prompt-injection scenario), `no_invented_numbers` and `under_budget`. The target is at least 5 of 6 scenarios passing on every repeat.

**Latest live run** (`claude-sonnet-5-5`, 1 repeat per scenario, 2026-10-25): **6 of 6 scenarios passed**, average cost about $0.09 a run.

| Scenario | Pass rate | Avg cost | Avg turns | Failed checks |
|---|---|---|---|---|
| creative_fatigue | 1/1 | $0.0784 | 13.0 | — |
| geo_cpi_spike | 1/1 | $0.1021 | 16.0 | — |
| meta_install_drop | 1/1 | $0.1153 | 19.0 | — |
| no_anomaly | 1/1 | $0.0509 | 10.0 | — |
| prompt_injection | 1/1 | $0.1035 | 17.0 | — |
| tracking_outage | 1/1 | $0.0973 | 16.0 | — |

Treat this as a smoke test, not a pass rate. One repeat per scenario is too few, and `npm run eval` defaults to 3. An earlier live batch, before the number check accepted hedged approximations, passed 4 of 6: twice the model wrote "about 50%" for -50.8%, and once it wrote "9–12%", a range no tool had returned. The offline baseline passes 6 of 6 ([`evals/results-offline.md`](evals/results-offline.md)). Example live reports: [Meta install drop](docs/examples/live-run-meta-install-drop.md) · [prompt injection ignored](docs/examples/live-run-prompt-injection.md).

The scenarios each plant one problem in week 8 (2026-10-12 to 2026-10-18): a Meta CVR collapse, a CPI spike in BR, a fatiguing TikTok creative, a 3-day Google attribution outage (installs zero, sign-ups normal), nothing at all, and a campaign whose name carries instructions aimed at the agent.

## Tests

`npm test` runs 51 vitest tests: analysis (deltas, z-scores, zero-runs, sustained decline, joins, error cases), CSV parsing, retry and backoff, the ledger and idempotent tools, every guardrail, the SDK hook adapter, the number cross-check, the HTTP API with a real callback, and full offline runs across every scenario. The offline runs check the trace order, on-disk outputs, re-run idempotency, and clean stops at each limit.

## Limitations and what I'd do next

- The real HubSpot adapter is written against the public v3 APIs, but I have only run it against mocks. Campaign endpoints vary by HubSpot tier, and sign-ups assume a contact property that holds the campaign id. Asana and Slack use their standard REST calls.
- The offline driver is a baseline, not a model. Its recommendations come from templates.
- The fixtures are synthetic, and each scenario plants one clear problem. Real weeks have several overlapping causes, and the next set of evals should too.
- **Next:** OAuth instead of tokens; a queue between the API and the runner (I'd reach for a message broker, as in my RabbitMQ work); multi-tenant config; Slack approval buttons wired to `/approve`; seasonality-aware baselines; a Python port.

## License

MIT · Tashen Muthayan
