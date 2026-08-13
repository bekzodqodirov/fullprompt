'use server';

import { getActor } from '@/modules/platform/rbac/authorize';
import { askAssistant, type AskOutcome } from '@/modules/platform/ai/assistant';

export interface AiTurn {
  role: 'user' | 'assistant';
  text: string;
}

/**
 * One question from the /ai screen. The toolset is rebuilt from THIS
 * request's actor — roles, grants, warehouses — never from anything the
 * browser sent, and the client's history is accepted as plain prior TEXT
 * only: a hand-crafted tool block posted from devtools is structurally not
 * representable here, so it cannot be replayed into the model.
 */
export async function askAiAction(input: {
  question: string;
  history: AiTurn[];
}): Promise<AskOutcome> {
  const actor = await getActor();
  if (!actor) return { status: 'error' };

  const history = Array.isArray(input.history)
    ? input.history
        .filter(
          (turn): turn is AiTurn =>
            Boolean(turn) &&
            (turn.role === 'user' || turn.role === 'assistant') &&
            typeof turn.text === 'string',
        )
        .slice(-8)
    : [];
  const question = typeof input.question === 'string' ? input.question : '';

  return askAssistant({ actor, question, history, surface: 'web' });
}
