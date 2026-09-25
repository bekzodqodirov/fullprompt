/**
 * Which client-ledger row a person may void (owner, 2026-09-25, Q19: the kassa
 * is its holders' — «kassaga mas'ul odam», his Q6 rule). Zero imports: the
 * ledger page draws the ✖ with it, and `nonHolderVoidableSql`
 * (finance/service.ts) is the same list written as the void's CLAIM, so the
 * button and the door cannot disagree (#513) — a unit test holds them to one
 * truth table.
 *
 * A kassa holder (`mayPickTill` — finance.expenses) voids any row. Anybody
 * else voids only what moves no till of ours:
 * - a PRICE (charge) — pricing stays the VED's (DECISIONS #108);
 * - a settlement half (a payment routed through a firm, `partner_id` set) —
 *   no till opened (#415), and the three-cornered settlement stays his (D2);
 * - their OWN payment while nobody has placed it into a kassa yet — the typo
 *   the VED can still take back under the «records without a kassa, the
 *   accountant places it» default. Once placed, it is cash in a drawer.
 * Everything else — a placed payment, a refund, somebody else's unplaced
 * payment, and any kind a later round adds (e.g. «Kompensatsiya») — is the
 * holders'. An ALLOW-list on purpose: a new kind is refused until somebody
 * decides otherwise.
 *
 * A «kurs farqi» row (0103) is NOBODY's ✖, the kassa holders' included:
 * the system writes it when a currency closes and voids it when the cycle
 * reopens (Q14), so a hand void would be undone by the next write — and the
 * accountant's own dollar close (Q24 b) has its own undo, `voidFxClose`.
 * `voidTransaction` refuses it for everyone (`fx_system_row`) before its
 * claim; this says the same thing to the button.
 */
export interface LedgerRowFacts {
  type: string;
  accountId: string | null;
  partnerId: string | null;
  createdBy: string;
}

export function mayVoidLedgerRow(
  row: LedgerRowFacts,
  door: { mayMoveTill: boolean; actorId: string },
): boolean {
  if (row.type === 'fx_diff') return false;
  if (door.mayMoveTill) return true;
  if (row.type === 'charge') return true;
  if (row.type === 'payment' && row.partnerId !== null) return true;
  return row.type === 'payment' && row.accountId === null && row.createdBy === door.actorId;
}
