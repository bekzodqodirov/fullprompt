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

/**
 * Whether the calculation a draft landed was priced FROM our China warehouses
 * (his third set «3») — read off the draft's stored actions, the one record
 * of what the customer was told. Every reader asks this: the landing's zone
 * and note, and the price the VED's answer becomes («💵 Narx yozaman»), which
 * must say the same condition and that the factory leg is extra. `=== true`:
 * an action stored before the flag existed carries none, and none is no.
 */
export function calcFromOurWarehouse(actions: unknown): boolean {
  if (!Array.isArray(actions)) return false;
  return actions.some(
    (a: unknown) =>
      typeof a === 'object' &&
      a !== null &&
      (a as { type?: unknown }).type === 'calc_submit' &&
      (a as { fromOurWarehouse?: unknown }).fromOurWarehouse === true,
  );
}

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

