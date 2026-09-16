/**
 * What a deal's code does NOT say, written once.
 *
 * The owner, marking a payment in the till (2026-09-14): «bitim sonidan
 * boshqa narsa korinmayabti … yani B-00123 (kichkina yozuvlarda 5 kub 200kg
 * oyinchoq) deb korinishi kerak». A deal code is a database key; the person
 * choosing one is holding an invoice and thinking about cargo.
 *
 * The rule was already settled once, in the OTHER direction: round 79
 * (DECISIONS #583) gave the prixod picker `number · goods · m³ · kg` for the
 * identical complaint, and the deal picker sitting on the same two cards never
 * got it. So this is that rule, moved one picker over — same separator, same
 * two decimal places, same «leave out whatever the row cannot answer».
 *
 * THE ONE DECISION WORTH THE FILE: which numbers.
 *
 * A deal carries two cargo figures and the app deliberately prints them side
 * by side on the deal card, labelled «Kelishuv» and «Haqiqat», because they
 * routinely disagree — `compareQuote` exists to measure the gap. His answer
 * (1.1c) is that a picker must show whichever is TRUE at that moment and say
 * which it is: cargo that has arrived speaks for itself, and until it arrives
 * the quote is all there is, marked `≈`. The marker is the whole honesty of
 * it — an unmarked quoted figure is the system claiming cargo it has not
 * seen, and an empty label would hide the deal he is trying to pick.
 *
 * Pure, no imports: the same string is composed for three pickers that load
 * their rows three different ways, and a composer that could query would grow
 * a fourth.
 */

export interface DealCargo {
  /** Non-void prixods attached to this deal. Zero means nothing has arrived. */
  receiptCount: number;
  /** Summed over the attached prixods' lots. */
  volumeM3: number;
  weightKg: number;
  /** The deal's own agreed figures. Null where nobody priced it. */
  quotedVolumeM3: number | null;
  quotedWeightKg: number | null;
  /**
   * Goods name, already resolved by the caller in this order: the prixod's
   * own lots (ru before zh — the office reads the picker, #583), else the
   * VED's filed lines, else nothing. The deal's TITLE is deliberately not a
   * fallback here: every picker already prints it beside the code, and a
   * title repeated inside its own parenthesis reads as two different facts.
   */
  goods: string | null;
  /** How many further distinct goods names the deal holds, for the «+N». */
  goodsExtra: number;
}

/** `2` → «2.00 m³», and nothing at all for a zero or a missing figure. */
function m3(value: number | null): string {
  return value && value > 0 ? `${value.toFixed(2)} m³` : '';
}

function kg(value: number | null): string {
  return value && value > 0 ? `${value.toFixed(1)} kg` : '';
}

function goodsText(cargo: DealCargo): string {
  if (!cargo.goods) return '';
  return cargo.goodsExtra > 0 ? `${cargo.goods} +${cargo.goodsExtra}` : cargo.goods;
}

/**
 * The parenthetical for one deal, or '' when the deal can say nothing.
 *
 * '' is a real answer and not a failure: a deal opened this morning with no
 * quote and no cargo has nothing to add, and «B-000123 ()» would be worse
 * than «B-000123». Every caller joins with `.filter(Boolean)` for that reason.
 */
export function dealCargoLabel(cargo: DealCargo): string {
  const arrived = cargo.receiptCount > 0 && (cargo.volumeM3 > 0 || cargo.weightKg > 0);

  const parts = arrived
    ? [m3(cargo.volumeM3), kg(cargo.weightKg), goodsText(cargo)]
    : [m3(cargo.quotedVolumeM3), kg(cargo.quotedWeightKg), goodsText(cargo)];

  const text = parts.filter(Boolean).join(' · ');
  if (!text) return '';

  /**
   * The marker rides the WHOLE group, never one number. Marking only the
   * volume («≈ 4 m³ · 180 kg») would read as a measured weight beside an
   * estimated cube, which is the one thing that is certainly false: before a
   * prixod exists, every figure here is the agreement.
   */
  return arrived ? text : `≈ ${text}`;
}

/**
 * The whole option line: code, title, cargo. One function so the three
 * pickers cannot drift — they are three files today and the drift between
 * them is what the owner reported.
 */
export function dealOptionLabel(input: {
  code: string;
  title: string | null;
  cargo: string;
}): string {
  const head = [input.code, input.title].filter(Boolean).join(' — ');
  return input.cargo ? `${head} (${input.cargo})` : head;
}
