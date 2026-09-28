/**
 * The statuses of a carton that is still OURS to answer for — on a shelf,
 * planned or being loaded onto a truck, on the road, or waiting for its owner
 * at the handover door. Not yet `issued`, and neither `lost` (the ledger's
 * compensation story, 0105) nor `void`.
 *
 * One list, because it was six: the cabinet kept a private copy, the bot's
 * lookup wrote it inline, `finance/client-cargo.ts` wrote it into three raw
 * subqueries of «my clients» and its own «Qayerda» read, and the client card's
 * «Yuklar» tab needed it a fifth time (the tab's judge, finding 8). A status
 * added to the box ladder is a decision about every one of those surfaces, and
 * with one list it is a decision made once.
 */
export const CLIENT_ACTIVE_STATUSES = [
  'in_stock',
  'planned',
  'loading',
  'in_transit',
  'ready_for_pickup',
] as const;

export type ClientActiveStatus = (typeof CLIENT_ACTIVE_STATUSES)[number];
