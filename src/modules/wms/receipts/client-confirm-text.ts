import { clientLabels } from '../../platform/telegram/client-labels';
import { b, code, groupDigits, h, visibleLength } from '../../platform/telegram/format';
import { clipKeepingCount } from '../../platform/text/label-count';
import {
  PUSH_NAME_CHARS,
  boxesText,
  headerLine,
  joinBlocks,
  kgText,
  m3Text,
  measuresOf,
  pushLotName,
  totalLine,
} from '../notices/client-text';
import { ASK_MAX_CHARS, type ClientAskFacts } from './client-confirm';

/**
 * «📋 Yuk ma'lumotini tasdiqlang» — the question a person sends from the
 * prixod card («Mijozdan so'rash», 0144; docs/TARKIB-TAKLIFLAR.md §4.1).
 * Pure: no database, no clock, no Telegram — every customer language is
 * tested with none of them.
 *
 * It prints exactly what the ✅ / ❌ is ABOUT, and nothing else: per lot the
 * goods and the carton count — a tarkib's goods one per line with their
 * pieces, a plain lot's name on the lot's own line — and, for a `full`
 * question (0146, docs/PRIXOD-XABARI.md §A — the owner's «4 ha»), the lot's
 * kilos and cubic metres on its line and a total under a prixod of several
 * lots, through the cabinet's own rounding. A `basic` question (a server one
 * migration behind) prints no measures, as 0144 did: they are not part of
 * that answer, and a customer who pays by them must not read its ✅ as
 * agreeing to the weight. A tarkib lot's measures are the LOT's — never a
 * good's: the answer compares the lot's two totals, and a figure per good
 * would be confirmed and compared with nothing. No truck, no price, no other
 * client.
 *
 * The names are HTML-escaped and cut like every push's (a tarkib's «+N»
 * survives the cut); the tag (`askTag`) covers the FULL names, so two
 * questions that print the same clipped line and differ further on still
 * carry different buttons.
 */
const clip = (text: string): string => clipKeepingCount(text.replace(/\s+/g, ' ').trim(), PUSH_NAME_CHARS);

export function askText(facts: ClientAskFacts, locale?: string | null): string {
  const t = clientLabels(locale);
  const full = facts.scope === 'full';
  const measures = (lot: ClientAskFacts['lots'][number]): string =>
    full ? ` · ${kgText(lot.kg)} ${h(t.kg)} · ${m3Text(lot.m3)} ${h(t.m3)}` : '';
  const lots = facts.lots.flatMap((lot) => {
    const letter = lot.letter?.trim() ? b(h(lot.letter.trim())) : '';
    const boxes = boxesText(lot.count, locale);
    if (lot.goods.length === 0) {
      return [`📦 ${letter ? `${letter} · ` : ''}${h(clip(pushLotName(lot.ru, lot.zh)))} — ${boxes}${measures(lot)}`];
    }
    return [
      `📦 ${letter ? `${letter} — ` : ''}${boxes}${measures(lot)}`,
      ...lot.goods.map((good) => {
        const pieces = good.pieces && good.pieces > 0 ? ` — ${groupDigits(good.pieces)} ${h(t.unitDona)}` : '';
        return `   • ${h(clip(good.name))}${pieces}`;
      }),
    ];
  });
  // The question names what the answer is compared with: where a tarkib's
  // goods are listed with their pieces, it asks about the pieces too.
  const listsGoods = facts.lots.some((lot) => lot.goods.length > 0);
  const ask = full
    ? b(h(listsGoods ? t.confirmAskLineGoodsFull : t.confirmAskLineFull))
    : h(listsGoods ? t.confirmAskLineGoods : t.confirmAskLine);
  // The prixod's total — the push's own line — where there is more than one
  // lot to add up; one lot's line IS the total.
  const total =
    full && facts.lots.length > 1
      ? totalLine(
          facts.lots.reduce((n, lot) => n + lot.count, 0),
          measuresOf(facts.lots.map((lot) => ({ weightKg: lot.kg, volumeM3: lot.m3 }))),
          locale,
        )
      : null;
  return joinBlocks(
    [b(h(t.confirmAskTitle)), headerLine(facts.clientCode, facts.warehouseName, facts.receivedAt)],
    lots,
    total,
    [ask, facts.receiptNumber ? `${h(t.pushReceiptNo)}: ${code(h(facts.receiptNumber))}` : ''],
  );
}

/** Does the question fit one Telegram message, in every customer language? */
export function askFits(facts: ClientAskFacts): boolean {
  return (['uz', 'ru', 'en'] as const).every((locale) => visibleLength(askText(facts, locale)) <= ASK_MAX_CHARS);
}
