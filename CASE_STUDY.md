# Case study: campaign-insights-agent

*Tashen Muthayan · Tash Tech Solutions portfolio project · October 2026*

## Problem

Growth teams lose a morning each week working out why a number moved, then turning that into tasks. The dashboard shows installs are down. Someone still has to slice it by network, campaign, geo and creative, decide whether it's real or a tracking fault, write it up, open tickets and tell the channel. I wanted one sentence in and that whole loop out, with a record of every step.

## Constraints I set myself

- **Runs on sample data.** `npm run demo -- --offline` works with nothing but Node. Mock integrations are the default.
- **Under $0.50 a run**, enforced by the SDK (`maxBudgetUsd`), not hoped for.
- **No invented numbers.** Every figure in the output has to be traceable to a tool result.
- **Auditable.** A marketer or an engineer can replay what happened from `trace.jsonl`.
- **Safe side effects.** Capped, idempotent, attributable to a run, optionally held for approval.

## Design decisions

**Plan-first hook.** The first call must be `submit_plan`, and a `PreToolUse` hook denies everything else until a plan exists. That gives a cheap checkpoint. The trace shows what the agent intended before it acted, which makes a bad run easy to diagnose.

**Deterministic analysis tools.** All maths lives in `analyze_metrics`, a pure TypeScript function with stable finding ids and pre-formatted display strings. The model decides what to look at and what it means. It never does arithmetic.

**Capped side effects, enforced twice.** The hook blocks the 6th Asana task and the 2nd Slack post. The tool handlers check again, because parallel tool calls can pass the hook before either handler has run. A per-run ledger keys every write (`asana:<runId>:<hash(title)>`, `slack:<runId>`), so re-running a run never duplicates anything. The Slack channel is configuration, never a tool argument, so no prompt can redirect it.

**A driver seam.** The runner talks to an `AgentDriver`. `SdkDriver` wraps `query()`. `OfflineDriver` is a deterministic, model-free agent that walks the same hooks, handlers, trace and report path. It doubles as the integration-test stub, the eval baseline and the no-key demo. CI runs the full eval suite against it on every push, so the plumbing is tested without spending tokens.

**n8n for orchestration, the agent for reasoning.** n8n owns triggers, the wait and the notification. The agent owns the thinking. The handoff is a 202 plus a per-execution resume URL in the request body, so a run can take as long as it needs without holding an HTTP connection open.

## What went wrong and how I fixed it

The offline baseline passed everything. The first live runs found four problems that no amount of mocking would have surfaced:

1. **The CLI rejected my output schema.** zod v4's `toJSONSchema` stamps a draft 2020-12 `$schema` URI, and the SDK's CLI validator doesn't know that meta-schema, so the process exited before the first turn. Fix: emit draft-07 and drop the `$schema` key.
2. **My own guardrail blocked the final answer.** `outputFormat` delivers the report through an SDK-internal `StructuredOutput` tool. My allow-list hook denied it three times, and the run ended with no report. The fallback report still came out, clearly marked "stopped", which is the behaviour I wanted for every failure mode. Fix: let SDK-internal tools through without counting them against the cap, plus a test so it stays fixed. ([before](docs/examples/live-run-before-number-fix.trace.txt))
3. **The subprocess inherited the host environment.** The Agent SDK runs its agent as a child process, and that process picked up host settings that inflated the first prompt to around 18k tokens. Fix: a hermetic environment by default (PATH, HOME, auth and proxy variables only), with `AGENT_ENV=inherit` as an opt-out.
4. **The model rounded.** The first good live report said Meta campaigns "fell about 50%", where the tool said -50.8%. The number cross-check caught it ([report](docs/examples/live-run-before-number-fix.md)), along with a false positive: "Oct 12" read as the number 12. Fix: a sharper prompt rule ("write -50.8%, never about 50% or halved"), and written-out dates stripped before checking. The offline baseline had already caught a similar false positive in my own template text ("20% or more"), so the tool now returns its thresholds as display strings too.

## Results

- **Live evals** (`claude-sonnet-5-5`, 1 repeat per scenario): 6 of 6 scenarios passed every check, after the fixes above. The batch before the final number-check change passed 4 of 6. I'd want 3+ repeats before quoting a rate.
- **Cost:** $0.05 to $0.12 a run, about $0.09 on average, well under the $0.50 cap. The no-anomaly brief is cheapest, because the agent stops once nothing is flagged.
- **Turns:** 10 to 19 model turns, and 15 to 17 tool calls on the anomaly scenarios. Every run's first call was `submit_plan`.
- **Prompt injection:** the model ignored the instructions planted in a campaign name, flagged them under limitations, and created only cited, capped tasks.
- **Offline baseline:** 6 of 6, at zero cost, in CI on every push.

## What I'd do in production

- **OAuth** for HubSpot, Asana and Slack instead of long-lived tokens, with per-tenant credentials.
- **A queue between the API and the runner.** I'd reach for a message broker, as in my RabbitMQ work, so runs survive restarts and can be rate-limited per tenant.
- **Multi-tenant config:** owners, channels, thresholds and budgets per team.
- **Slack approval buttons** wired to `POST /runs/:id/approve`, so `REQUIRE_APPROVAL` is a one-click flow.
- **Better baselines:** seasonality and day-of-week aware expectations instead of a trailing mean.
- **Richer evals:** overlapping causes, noisier weeks, and judged quality of the recommendations, not just whether they cite evidence.
