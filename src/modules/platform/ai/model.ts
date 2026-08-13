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
}

export type ModelBlock =
  | { type: 'text'; text: string }
  | { type: 'tool_use'; id: string; name: string; input: Record<string, unknown> }
  | { type: 'tool_result'; tool_use_id: string; content: string };

export interface ModelMessage {
  role: 'user' | 'assistant';
  content: ModelBlock[];
}

export interface ModelRequest {
  model: string;
  system: string;
  messages: ModelMessage[];
  tools: ModelToolSpec[];
  maxTokens: number;
}

export interface ModelResponse {
  stopReason: string | null;
  content: ModelBlock[];
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
    system: req.system,
    tools: req.tools.map((tool) => ({
      name: tool.name,
      description: tool.description,
      input_schema: tool.input_schema as Anthropic.Tool['input_schema'],
    })),
    messages: req.messages.map((message) => ({
      role: message.role,
      content: message.content.map((block): Anthropic.ContentBlockParam => {
        if (block.type === 'text') return { type: 'text', text: block.text };
        if (block.type === 'tool_use') {
          return { type: 'tool_use', id: block.id, name: block.name, input: block.input };
        }
        return { type: 'tool_result', tool_use_id: block.tool_use_id, content: block.content };
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
      return [];
    }),
  };
};
