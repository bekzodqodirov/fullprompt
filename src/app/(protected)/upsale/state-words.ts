import type { UpsaleRow, UpsaleState } from '@/modules/wms/calc/upsale-service';

/**
 * What /upsale says about ONE row's state, and why it waits — PURE and
 * type-only in its imports, so a unit test loads it without a database (the
 * `workspaces.test.ts` precedent), and the keys it hands out are checked
 * against all four bundles there (#163: a runtime key is invisible to the
 * literal-key fence).
 */

/**
 * The chip's colour per state. «Payable» is deliberately NOT brand: on this
 * screen «ready to pay» is the ordinary state, and painting the commonest row
 * red makes the table a wall of alarms — which is how the one row that DOES
 * need attention («the cargo is not paid for») stops being visible. An
 * unknown (`not_computed`) is a warning, never the neutral grey of a settled
 * fact.
 */
export const STATE_CLASS: Record<UpsaleState, string> = {
  paid: 'chip chip-good',
  payable: 'chip chip-neutral',
  awaiting_payment: 'chip chip-warn',
  no_invoice: 'chip chip-neutral',
  no_cargo: 'chip chip-neutral',
  no_deal: 'chip chip-neutral',
  not_computed: 'chip chip-warn',
};

export type StateKey =
  | 'stPaid'
  | 'stPayable'
  | 'stAwaiting'
  | 'stNoInvoice'
  | 'stNoCargo'
  | 'stNoDeal'
  | 'stNotComputed'
  | 'stCargoLost';

export const STATE_KEY: Record<UpsaleState, StateKey> = {
  paid: 'stPaid',
  payable: 'stPayable',
  awaiting_payment: 'stAwaiting',
  no_invoice: 'stNoInvoice',
  no_cargo: 'stNoCargo',
  no_deal: 'stNoDeal',
  not_computed: 'stNotComputed',
};

/**
 * The chip's word for ONE row: prixods arrived and none of their cartons is
 * live any more → «Yuk qolmagan», not «Yuk kelmagan» (owner-UX-6) — the same
 * state, two different facts about the cargo.
 */
export function stateKeyOf(row: Pick<UpsaleRow, 'state' | 'cargoReceipts'>): StateKey {
  return row.state === 'no_cargo' && row.cargoReceipts > 0 ? 'stCargoLost' : STATE_KEY[row.state];
}

export type HintKey =
  | 'fifoToOpen'
  | 'fifoToOpenOlder'
  | 'fifoPricedElsewhere'
  | 'fifoUncovered'
  | 'fifoNoLive'
  | 'fifoNotComputed';

export const HINT_KEYS: readonly HintKey[] = [
  'fifoToOpen',
  'fifoToOpenOlder',
  'fifoPricedElsewhere',
  'fifoUncovered',
  'fifoNoLive',
  'fifoNotComputed',
];

/**
 * Why a row waits, in words — or null. Money only where round 91 already
 * shows this client's money (`seesMoney`, rule 10): a seller reading another
 * manager's client gets the chip and the rule sentence, never a figure.
 */
export function hintOf(
  row: Pick<UpsaleRow, 'state' | 'cargoReceipts' | 'cargoWalk'>,
  opts: { seesMoney: boolean; money: (usd: number) => string },
): { key: HintKey; values: Record<string, string | number> } | null {
  const w = row.cargoWalk;
  if (row.state === 'not_computed') return { key: 'fifoNotComputed', values: {} };
  if (row.state === 'no_cargo' && row.cargoReceipts > 0 && w && w.cartons === 0) return { key: 'fifoNoLive', values: {} };
  if (row.state === 'no_invoice' && w && w.uncovered > 0) {
    return w.uncoveredElsewhere > 0
      ? { key: 'fifoPricedElsewhere', values: { uncovered: w.uncovered, cartons: w.cartons } }
      : { key: 'fifoUncovered', values: { uncovered: w.uncovered, cartons: w.cartons } };
  }
  if (row.state === 'awaiting_payment' && w && opts.seesMoney && w.toOpenUsd !== null && w.toOpenUsd > 0.009) {
    return { key: w.olderOwedElsewhere ? 'fifoToOpenOlder' : 'fifoToOpen', values: { amount: opts.money(w.toOpenUsd) } };
  }
  return null;
}
