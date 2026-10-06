/**
 * Where the lenta's note box writes — one pure answer, so a test can ask it.
 *
 * A calculator's note goes on the CARD — the lead or the deal — never on the
 * client (review access-money-4/-5): the client entity would make him a
 * participant of every later note on that client from any card, and the
 * action admits him only on a calc card. A caller's `noteOn` (the karta,
 * review access-4) does the same for a reader the CRM grant admits. Elsewhere
 * a deal card's note belongs to THIS job — two deals with one client are two
 * conversations — then the client, then the lead.
 */
export function feedNoteTarget(input: {
  viaCalc: boolean;
  calcCard: { entityType: 'lead' | 'deal'; entityId: string } | null;
  noteOn: { entityType: 'lead' | 'deal'; entityId: string } | null;
  dealId: string | null;
  clientId: string | null;
  leadId: string | null;
}): { entityType: 'lead' | 'deal' | 'client'; entityId: string } {
  if (input.viaCalc && input.calcCard) return input.calcCard;
  if (input.noteOn) return input.noteOn;
  if (input.dealId) return { entityType: 'deal', entityId: input.dealId };
  if (input.clientId) return { entityType: 'client', entityId: input.clientId };
  return { entityType: 'lead', entityId: input.leadId! };
}
