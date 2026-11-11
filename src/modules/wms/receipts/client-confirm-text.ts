import { clientLabels } from '../../platform/telegram/client-labels';
import { b, code, groupDigits, h, visibleLength } from '../../platform/telegram/format';
import { clipKeepingCount } from '../../platform/text/label-count';
import { PUSH_NAME_CHARS, boxesText, headerLine, joinBlocks, pushLotName } from '../notices/client-text';
import { ASK_MAX_CHARS, type ClientAskFacts } from './client-confirm';

/**
 * «📋 Yuk ma'lumotini tasdiqlang» — the question a person sends from the
 * prixod card («Mijozdan so'rash», 0144; docs/TARKIB-TAKLIFLAR.md §4.1).
 * Pure: no database, no clock, no Telegram — every customer language is
 * tested with none of them.
 *
 * It prints exactly what the ✅ / ❌ is ABOUT, and nothing else: per lot the
 * goods and the carton count — a tarkib's goods one per line with their
 * pieces, a plain lot's name on the lot's own line. No kilos and no cubic
 * metres, on purpose: they are the warehouse's measurement, they are not
 * part of the answer, and a customer who pays by them must not read ✅ as
 * agreeing to the weight. No truck, no price, no other client.
 *
 * The names are HTML-escaped and cut like every push's (a tarkib's «+N»
 * survives the cut); the tag (`askTag`) covers the FULL names, so two
 * questions that print the same clipped line and differ further on still
 * carry different buttons.
 */
const clip = (text: string): string => clipKeepingCount(text.replace(/\s+/g, ' ').trim(), PUSH_NAME_CHARS);

export function askText(facts: ClientAskFacts, locale?: string | null): string {
  const t = clientLabels(locale);
  const lots = facts.lots.flatMap((lot) => {
    const letter = lot.letter?.trim() ? b(h(lot.letter.trim())) : '';
    const boxes = boxesText(lot.count, locale);
    if (lot.goods.length === 0) {
      return [`📦 ${letter ? `${letter} · ` : ''}${h(clip(pushLotName(lot.ru, lot.zh)))} — ${boxes}`];
    }
    return [
      `📦 ${letter ? `${letter} — ` : ''}${boxes}`,
      ...lot.goods.map((good) => {
        const pieces = good.pieces && good.pieces > 0 ? ` — ${groupDigits(good.pieces)} ${h(t.unitDona)}` : '';
        return `   • ${h(clip(good.name))}${pieces}`;
      }),
    ];
  });
  return joinBlocks(
    [b(h(t.confirmAskTitle)), headerLine(facts.clientCode, facts.warehouseName, facts.receivedAt)],
    lots,
    [h(t.confirmAskLine), facts.receiptNumber ? `${h(t.pushReceiptNo)}: ${code(h(facts.receiptNumber))}` : ''],
  );
}

/** Does the question fit one Telegram message, in every customer language? */
export function askFits(facts: ClientAskFacts): boolean {
  return (['uz', 'ru', 'en'] as const).every((locale) => visibleLength(askText(facts, locale)) <= ASK_MAX_CHARS);
}
