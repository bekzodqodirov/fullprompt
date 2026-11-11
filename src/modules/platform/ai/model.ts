import Anthropic from '@anthropic-ai/sdk';

/**
 * The narrow slice of the Anthropic Messages API the assistant loop needs,
 * as an injectable function — integration tests script it and drive the tool
 * loop deterministically, which is also why CI (no key) can prove every
 * branch except the wire itself. Same stance as `intake-ai.ts`: no key means
 * an honest «not configured», never a crash.
 */

export interface ModelToolSpec {
  name: string;
  description: string;
  input_schema: Record<string, unknown>;
  /**
   * Constrain the call's arguments to the schema exactly (the schema then
   * needs `additionalProperties: false` and `required`). The AI sotuvchi's
   * terminal `compose_reply` is the one caller: a customer-bound reply whose
   * fields are policy inputs must not arrive half-shaped.
   */
  strict?: boolean;
}

export type ModelBlock =
  /**
   * `cache`: a cache breakpoint after this block — everything before it, the
   * system prompt included, is billed once and read at a tenth of the price
   * by the next request that repeats it byte for byte. The AI sotuvchi marks
   * its opening chat block (#1622): every tool round of one run re-sends it.
   */
  | { type: 'text'; text: string; cache?: true }
  | { type: 'tool_use'; id: string; name: string; input: Record<string, unknown> }
  | { type: 'tool_result'; tool_use_id: string; content: string; is_error?: boolean }
  /**
   * A block this seam does not model — a thinking block, above all — carried
   * back to the API exactly as it came. The API's rule is to pass them back
   * unchanged across a tool loop; dropping them was harmless for the staff
   * assistant's short questions and is not a bet worth making on a loop that
   * drafts a customer's reply. Nothing but `realCallModel` looks inside.
   */
  | { type: 'opaque'; raw: unknown };

export interface ModelMessage {
  role: 'user' | 'assistant';
  content: ModelBlock[];
}

export interface ModelRequest {
  model: string;
  system: string;
  /**
   * The STABLE head of the system prompt (persona, rules, style guide),
   * rendered before `system` behind a cache breakpoint, so a busy day of
   * drafts pays for it once per cache window instead of once per message.
   * Anything that varies per request belongs in `system`, after it — one
   * changed byte in the cached prefix re-bills all of it.
   */
  systemCached?: string;
  messages: ModelMessage[];
  tools: ModelToolSpec[];
  maxTokens: number;
}

/** What one call cost, in the API's own four numbers. */
export interface ModelUsage {
  inputTokens: number;
  outputTokens: number;
  cacheReadTokens: number;
  cacheWriteTokens: number;
}

export interface ModelResponse {
  stopReason: string | null;
  content: ModelBlock[];
  /** Optional so a scripted test model need not invent one. */
  usage?: ModelUsage;
}

export type CallModel = (req: ModelRequest) => Promise<ModelResponse>;

export function aiConfigured(): boolean {
  return Boolean(process.env.ANTHROPIC_API_KEY);
}

/**
 * Tier by cost: the analyst writes SQL against a 60-table card and earns the
 * frontier model; a staff lookup is a sentence over three wrappers and does
 * not. Both strings match the models the codebase already calls.
 */
export const ANALYST_MODEL = 'claude-opus-5';
export const STAFF_MODEL = 'claude-sonnet-5';

/**
 * What a model call costs, in dollars per MILLION tokens — the provider's
 * LIST prices for the two models above, read from its API reference
 * (2026-11-03). Keyed by the constants, so a model change moves its price
 * with it or — when the new model has no entry — the screens print calls and
 * no dollars: `approxMicroUsd` answers null rather than guess.
 *
 * An APPROXIMATION and printed as one («≈»): list prices of ANSWERED calls
 * only. Not in it: an attempt the SDK retried, a call that timed out after
 * the provider had already worked on it, and any discount on the account.
 * None of the pressed calls billed with it sends a cache breakpoint, so the
 * two token counts are a call's whole bill.
 */
export const MODEL_USD_PER_MTOK: Readonly<Record<string, { input: number; output: number }>> = {
  [ANALYST_MODEL]: { input: 5, output: 25 },
  [STAFF_MODEL]: { input: 2, output: 10 },
};

export interface ModelTokens {
  model: string;
  inputTokens: number;
  outputTokens: number;
}

/**
 * Token counts → millionths of a dollar. Dollars per million tokens IS
 * micro-dollars per token, so the sum stays in integers until it is shown.
 * Null as soon as a row that spent tokens names a model with no price.
 */
export function approxMicroUsd(rows: readonly ModelTokens[]): number | null {
  let micro = 0;
  for (const row of rows) {
    if (row.inputTokens === 0 && row.outputTokens === 0) continue;
    const price = MODEL_USD_PER_MTOK[row.model];
    if (!price) return null;
    micro += row.inputTokens * price.input + row.outputTokens * price.output;
  }
  return Math.round(micro);
}

/** Micro-dollars as dollars to the cent — what a screen prints after «≈ $». */
export function microUsdToUsd(micro: number): number {
  return Math.round(micro / 10_000) / 100;
}

/**
 * One model call's ceiling. The SDK's own default is ~10 minutes, which is
 * far too long for a question a person is waiting on — and round 97's lesson
 * is that an un-deadlined network call is the failure that looks like a hang
 * rather than an error. Sized so the loop's whole wall clock (120 s) is still
 * the outer bound.
 */
const CALL_TIMEOUT_MS = 60_000;

export const realCallModel: CallModel = async (req) => {
  const client = new Anthropic({ timeout: CALL_TIMEOUT_MS, maxRetries: 1 });
  const response = await client.messages.create({
    model: req.model,
    max_tokens: req.maxTokens,
    // A plain string when nothing is cached — byte for byte what this seam
    // always sent, so the staff assistant's requests do not change shape.
    system: req.systemCached
      ? [
          { type: 'text', text: req.systemCached, cache_control: { type: 'ephemeral' } },
          { type: 'text', text: req.system },
        ]
      : req.system,
    tools: req.tools.map((tool) => ({
      name: tool.name,
      description: tool.description,
      input_schema: tool.input_schema as Anthropic.Tool['input_schema'],
      ...(tool.strict ? { strict: true } : {}),
    })),
    messages: req.messages.map((message) => ({
      role: message.role,
      content: message.content.map((block): Anthropic.ContentBlockParam => {
        if (block.type === 'text') {
          return block.cache
            ? { type: 'text', text: block.text, cache_control: { type: 'ephemeral' } }
            : { type: 'text', text: block.text };
        }
        if (block.type === 'tool_use') {
          return { type: 'tool_use', id: block.id, name: block.name, input: block.input };
        }
        if (block.type === 'opaque') return block.raw as Anthropic.ContentBlockParam;
        return {
          type: 'tool_result',
          tool_use_id: block.tool_use_id,
          content: block.content,
          ...(block.is_error ? { is_error: true } : {}),
        };
      }),
    })),
  });
  return {
    stopReason: response.stop_reason,
    content: response.content.flatMap((block): ModelBlock[] => {
      if (block.type === 'text') return [{ type: 'text', text: block.text }];
      if (block.type === 'tool_use') {
        return [
          {
            type: 'tool_use',
            id: block.id,
            name: block.name,
            input: (block.input ?? {}) as Record<string, unknown>,
          },
        ];
      }
      // Thinking (and anything newer) goes back as it came — see `opaque`.
      return [{ type: 'opaque', raw: block }];
    }),
    usage: {
      inputTokens: response.usage?.input_tokens ?? 0,
      outputTokens: response.usage?.output_tokens ?? 0,
      cacheReadTokens: response.usage?.cache_read_input_tokens ?? 0,
      cacheWriteTokens: response.usage?.cache_creation_input_tokens ?? 0,
    },
  };
};
