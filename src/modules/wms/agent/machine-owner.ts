/**
 * «May the machine touch this card?» (SPEC-P2-v2 K3) — ONE predicate, pure, asked by every act the AI does by
 * itself on a card: the calculation it submits (`calc_foreign`, §1.1), the VED price it states (§2.3), the offer it
 * writes onto a card (§2.4) and the funnel stage it moves (§3.2). A colleague's lead, deal or client is never the
 * machine's: his ✅ may still act there, the machine never does.
 *
 *   lead   — its owner is nobody, or the holder;
 *   deal   — its owner AND its client's seller are each nobody, or the holder;
 *   client — its seller is nobody, or the holder.
 *
 * The holder is the account the reply left from — `agent_config.owner_user_id` at the moment of the act; the stage
 * mover passes the OUTBOX row's `manager_user_id`, since `setAgentOwner` may have moved the config since (crm 1).
 */
export type MachineCard =
  | { kind: 'lead'; ownerId: string | null }
  | { kind: 'deal'; ownerId: string | null; clientSellerId: string | null }
  | { kind: 'client'; sellerId: string | null };

const mineOrNobody = (id: string | null, holderId: string) => id === null || id === holderId;

export function machineMayTouch(card: MachineCard, holderId: string): boolean {
  switch (card.kind) {
    case 'lead':
      return mineOrNobody(card.ownerId, holderId);
    case 'deal':
      return mineOrNobody(card.ownerId, holderId) && mineOrNobody(card.clientSellerId, holderId);
    case 'client':
      return mineOrNobody(card.sellerId, holderId);
  }
}
