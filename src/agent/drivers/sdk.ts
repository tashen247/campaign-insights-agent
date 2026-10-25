import { query, type Options, type SDKMessage, type SDKUserMessage } from "@anthropic-ai/claude-agent-sdk";
import { createCampaignServer, ALLOWED_TOOLS } from "../../tools/index.js";
import { SERVER_NAME } from "../../tools/context.js";
import { sdkHooks } from "../hooks.js";
import type { AgentDriver, DriverInput, DriverResult } from "./types.js";

/** The live agent: Claude via the Agent SDK, with only our in-process MCP tools available. */
export class SdkDriver implements AgentDriver {
  readonly name = "sdk";
  constructor(readonly model: string) {}

  async run(input: DriverInput): Promise<DriverResult> {
    const { cfg, ctx, guardrails } = input;
    const server = createCampaignServer(ctx);

    const options: Options = {
      model: this.model,
      systemPrompt: input.systemPrompt,
      mcpServers: { [SERVER_NAME]: server },
      tools: [], // no built-in tools at all
      allowedTools: ALLOWED_TOOLS, // explicit names, not a wildcard
      disallowedTools: ["Bash", "Write", "Edit", "WebFetch", "WebSearch"], // second layer
      permissionMode: "dontAsk", // anything not pre-allowed is denied, never prompted
      settingSources: [], // ignore local settings files
      maxTurns: cfg.maxTurns,
      maxBudgetUsd: cfg.maxBudgetUsd,
      hooks: sdkHooks(guardrails),
      outputFormat: { type: "json_schema", schema: input.outputSchema },
      cwd: ctx.runDir,
      env: cfg.agentEnv === "inherit" ? { ...process.env } : hermeticEnv(),
    };

    // Streaming input (an async iterable) is the safe mode for in-process SDK MCP servers.
    // Keep the input open until the result arrives, then let it end.
    let finish!: () => void;
    const done = new Promise<void>((r) => (finish = r));
    async function* prompt(): AsyncGenerator<SDKUserMessage> {
      yield { type: "user", message: { role: "user", content: input.userPrompt }, parent_tool_use_id: null };
      await done;
    }

    const q = query({ prompt: prompt(), options });
    let turn = 0;
    const seen = new Set<string>();
    let assistantError: string | null = null;
    const out: DriverResult = { structured: null, subtype: "unknown", costUsd: 0, numTurns: 0 };
    try {
      for await (const m of q as AsyncIterable<SDKMessage>) {
        if (m.type === "assistant") {
          // streamed messages arrive one content block at a time; count a turn once per message id
          const id = m.message.id ?? m.uuid;
          if (!seen.has(id)) {
            seen.add(id);
            turn += 1;
          }
          if (m.error) assistantError = String(m.error);
          const blocks = (m.message.content ?? []) as { type: string; text?: string; name?: string }[];
          const text = blocks.filter((b) => b.type === "text").map((b) => b.text).join(" ").trim();
          const tools = blocks.filter((b) => b.type === "tool_use").map((b) => b.name);
          ctx.logger.log("turn", { turn, text: text.slice(0, 400) || null, tool_uses: tools, usage: m.message.usage ?? null });
        } else if (m.type === "system" && m.subtype === "api_retry") {
          ctx.logger.log("retry", { source: "anthropic_api", attempt: m.attempt, status: m.error_status, delayMs: m.retry_delay_ms });
        } else if (m.type === "result") {
          out.subtype = m.subtype;
          out.costUsd = m.total_cost_usd;
          out.numTurns = m.num_turns;
          if (m.subtype === "success") out.structured = m.structured_output ?? tryJson(m.result);
          else out.error = "errors" in m && Array.isArray(m.errors) ? m.errors.join("; ") : m.subtype;
          if (!out.structured && assistantError) out.error = `${assistantError}: ${m.subtype === "success" ? m.result : out.error}`;
          break;
        }
      }
    } finally {
      finish();
      q.close();
    }
    return out;
  }
}

/**
 * The agent subprocess gets only what it needs, not the parent's whole environment.
 * Keeps runs reproducible (no stray settings or plugins from the host) and keeps the prompt small.
 */
const PASS_THROUGH = ["PATH", "HOME", "TMPDIR", "LANG", "ANTHROPIC_API_KEY", "ANTHROPIC_BASE_URL", "ANTHROPIC_AUTH_TOKEN", "HTTPS_PROXY", "HTTP_PROXY", "NO_PROXY", "https_proxy", "http_proxy", "no_proxy", "NODE_EXTRA_CA_CERTS", "SSL_CERT_FILE"];
export function hermeticEnv(src: NodeJS.ProcessEnv = process.env): Record<string, string> {
  const env: Record<string, string> = { CLAUDE_AGENT_SDK_CLIENT_APP: "campaign-insights-agent/0.1.0", CLAUDE_CODE_MAX_RETRIES: "3" };
  for (const k of PASS_THROUGH) if (src[k]) env[k] = src[k]!;
  return env;
}

function tryJson(s: string | undefined): unknown {
  if (!s) return null;
  try {
    return JSON.parse(s);
  } catch {
    return null;
  }
}
