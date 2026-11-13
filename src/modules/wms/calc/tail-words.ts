/**
 * WHO a refusal's tail is addressed to — the ONE place it is decided
 * (docs/IKKI-ESHIK.md §3.5, M9). A leaf with no imports, because three
 * renderers print a tail — the customs line and the road (`ai-reply.ts`),
 * the yolkira tariff answer (`prefill-reply.ts`) and the 📊 block
 * (`estimate.ts`'s `refused_measure`) — and a tail worded in one of them and
 * not the others is the reply that asks the seller in one line and tells him
 * the VED will ask in the next.
 *
 * Two fixers (§0.1(7)): a fact only the customer has (a count, a weight, the
 * city, the brutto) is the SELLER's; a baza, a law, a tariff hole is the
 * VED's. Until the two doors, the seller's tail sent him to the customer —
 * «mijozdan so‘rab, «➕» bilan yuboring». Where NOBODY asks the seller
 * (`noAsk`), the VED does, so the seller's tail says so and the VED's own
 * tails are what they always were. Since docs/AI-SORAYDI.md §3.4 A1 (his 4a
 * of 2026-11-11, review JR-13) that is the plain door («🧮», his 2a/3a) — and
 * the AI door's card copy when the seller's own copy reached nobody; the AI
 * door's answer asks again, in the NULL door's words, and a request from
 * before the doors (NULL) keeps today's words exactly (§0.2).
 */

/** Who can fix a refusal: a fact only the seller or the customer has, or one
 * the VED decides (docs/SAKKIZ-R2.md §2.5). */
export type FreightTail = 'seller' | 'ved';

/** Who reads a rendering: the seller in his chat, or anybody on the card's lenta. */
export type ReplyAudience = 'chat' | 'lenta';

/**
 * The tail of a refused road — WHO fixes it (§0.1(7)), in the words of the
 * reader's own way to act (docs/SAKKIZ-R3.md §2.5). The seller in his chat
 * has «➕ Shu so‘rovga qo‘shish» under this very message, so he is pointed
 * at it; the lenta's reader stands on the card, where writing the figure
 * down is the way. The VED's tail is the same on both.
 */
export const FREIGHT_TAIL_WORDS: Record<FreightTail, Record<ReplyAudience, string>> = {
  seller: {
    chat: '— mijozdan so‘rab, «➕ Shu so‘rovga qo‘shish» bilan yuboring',
    lenta: '— mijozdan so‘rab, kartadagi lentaga yozing',
  },
  ved: { chat: '— VED xodimi hisoblaydi', lenta: '— VED xodimi hisoblaydi' },
};

/**
 * The tail of a refused CUSTOMS line — the same two fixers as the road's,
 * worded for a line (the VED «qo‘yadi» a baza; the road he «hisoblaydi»).
 * The seller's words follow the road's, and the Taxminiy block's own
 * (`refused_measure`), so a reply that says the count is missing says once
 * who gets it — in each reader's words.
 */
export const CUSTOMS_TAIL_WORDS: Record<FreightTail, Record<ReplyAudience, string>> = {
  seller: FREIGHT_TAIL_WORDS.seller,
  ved: { chat: '— VED xodimi qo‘yadi', lenta: '— VED xodimi qo‘yadi' },
};

/**
 * The seller's tail where nobody asks him (§3.5): the VED does. In his chat
 * «sizdan» — he is the one asked; on the lenta, which the VED reads, the
 * plain door's own summary words (§2.1, «↳ kg yo‘q — VED xodimi so‘raydi»).
 */
export const SELLER_TAIL_NO_ASK: Record<ReplyAudience, string> = {
  chat: '— VED xodimi sizdan so‘raydi',
  lenta: '— VED xodimi so‘raydi',
};

/** The tail for one refusal: the map's own words, or — where nobody asks him — the seller's «VED asks». */
export function tailWords(
  words: Record<FreightTail, Record<ReplyAudience, string>>,
  tail: FreightTail,
  audience: ReplyAudience,
  noAsk: boolean,
): string {
  return noAsk && tail === 'seller' ? SELLER_TAIL_NO_ASK[audience] : words[tail][audience];
}
