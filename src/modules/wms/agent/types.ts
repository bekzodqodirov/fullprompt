import type { CalcFacts, CalcSection } from '../calc/intake';
import type { PolicyMemory } from './policy-input';
import type { PolicyResult } from './policy';

/** The shapes a draft row stores — shared by the writer, the card and the decision. */

export type ComposedAction =
  | {
      type: 'calc_submit';
      section: CalcSection;
      facts: CalcFacts;
      certificate: 'bor' | 'yoq' | 'bilmaydi' | null;
      /** tg_messages ids the model cited — the only messages that reach the lenta (leak-12). */
      citedMessageIds: string[];
    }
  | { type: 'set_followup'; date: string; note: string }
  | { type: 'mute'; reason: string };

/** What the card shows of the chat — kept on the draft, so a refresh needs no re-read. */
export interface CardMemory {
  customerLabel: string;
  lastOut: string | null;
  customerLines: string[];
}

export interface DraftPolicyJson {
  blocks: PolicyResult['blocks'];
  warnings: PolicyResult['warnings'];
  ledger: PolicyResult['ledger'];
  memory: PolicyMemory;
  card: CardMemory;
  notes: string[];
}

