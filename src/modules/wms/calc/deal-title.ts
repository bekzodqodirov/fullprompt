import { tashkentDay } from '../../platform/time/tashkent';
import type { CalcSection } from './intake';

/** A job's deal reads apart from its siblings on every picker: section and goods, never «Hisoblatish — rastamojka». */
const SECTION_TITLE: Record<CalcSection, string> = {
  yolkira: "Yo'lkira",
  rastamojka: 'Rastamojka',
  podklyuch: 'Podklyuch',
};

export function dealTitleFor(
  section: CalcSection,
  goodsNames: readonly string[],
  /**
   * What names a job with no goods typed (judge product-18): one client's
   * several «Rastamojka» cards on the board are told apart by the day they
   * were asked, so «Rastamojka — GS777 · 27.10» rather than three identical
   * titles under one code.
   */
  empty?: { clientCode: string; at: Date },
): string {
  // A customs description is 300 characters with its own newlines: one line,
  // cut, so the board and the receive picker keep a list a list.
  const names = goodsNames.map((name) => name.replace(/\s+/g, ' ').trim()).filter(Boolean);
  const head = SECTION_TITLE[section];
  if (names.length === 0) {
    if (!empty) return head;
    const day = tashkentDay(empty.at);
    return `${head} — ${empty.clientCode} · ${day.slice(8, 10)}.${day.slice(5, 7)}`;
  }
  const first = names[0]!.length > 60 ? `${names[0]!.slice(0, 59)}…` : names[0]!;
  return `${head} — ${first}${names.length > 1 ? ` +${names.length - 1}` : ''}`;
}
