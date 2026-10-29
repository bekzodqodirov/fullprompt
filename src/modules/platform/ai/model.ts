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
  | { type: 'text'; text: string }
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
        if (block.type === 'text') return { type: 'text', text: block.text };
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
