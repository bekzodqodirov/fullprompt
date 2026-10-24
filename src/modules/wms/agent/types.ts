import type { CalcFacts, CalcSection } from '../calc/intake';
import type { PolicyMemory } from './policy-input';
import type { PolicyResult } from './policy';

/** The shapes a draft row stores — shared by the writer, the card and the decision. */

export type ComposedAction =
  | {
      type: 'calc_submit';
      section: CalcSection;
      facts: CalcFacts;
      // No certificate: his 9 (2026-10-24) — the company obtains it itself, every agent job lands with it.
      /**
       * The cargo starts at none of our China warehouses (his third set «3»):
       * the landing takes the China column and its note says the factory leg
       * is extra. Decided by the run that wrote the reply which said so; an
       * action stored before it has none, which reads as false.
       */
      fromOurWarehouse: boolean;
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

