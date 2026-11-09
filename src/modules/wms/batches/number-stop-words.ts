import type { NumberKeptWhy } from './batch-number';

/*
 * Why the give-back stopped, in HIS words — what `scripts/batch-raqam.ts`
 * prints beside «--apply qaytaradi» and after an `--apply` (his 7a: the list
 * is read to him, docs/NARX-VA-RAQAM.md §2.3 + §3.2.7). The same sentences as
 * the dry run's gap lines and the card's `batches.number.kept`, in Uzbek like
 * the rest of the script's output — a raw `agent` / `newer` / `busy` was what
 * it printed (review C5).
 *
 * A literal `Record` over `NumberKeptWhy`: a reason added to the union is a
 * compile error here until it has its words. Pure (a type import only), so
 * the script can take it without the database client and a unit test can
 * read every line.
 */

export interface NumberStop {
  why: NumberKeptWhy;
  /** The number the walk stopped at, as the mint builds it. */
  number?: string;
  /** The truck that keeps it, by the name it wears now. */
  name?: string;
}

/** «(hozir 01A777BA)» — the holder's name, only where it differs from the number. */
const now = (stop: NumberStop): string => (stop.name && stop.name !== stop.number ? ` (hozir ${stop.name})` : '');
const at = (stop: NumberStop): string => (stop.number ? `${stop.number}: ` : '');

const WORDS: Record<NumberKeptWhy, (stop: NumberStop) => string> = {
  // His 5a, verbatim: «YW-011 allaqachon ochilgan».
  newer: (s) => `${s.number ?? s.name ?? '?'} allaqachon ochilgan${now(s)}`,
  agent: (s) => `${at(s)}bekor qilingan, hujjatlari agentga yuborilgan — raqami saqlanadi${now(s)}`,
  left: (s) => `${at(s)}yo‘lga chiqqan, keyin bekor qilingan — raqami saqlanadi`,
  renamed_left: (s) => `${at(s)}${s.name ?? '?'} nomi bilan jo‘nagan`,
  // The release's own «nothing under number 1» carries no number.
  unworn: (s) => (s.number ? `${s.number}: hech kim olmagan` : 'sanoq boshiga yetdi — qaytadigan raqam qolmadi'),
  no_counter: () => 'bu prefiksning hisoblagichi yo‘q',
  prefix: (s) => `${at(s)}ombor prefiksi o‘zgargan`,
  pending: (s) => `${at(s)}hali qaytarilmagan`,
  busy: (s) => `${at(s)}tizim band — birozdan keyin qayta ishga tushiring`,
  error: (s) => `${at(s)}xatolik — konteyner logini qarang`,
};

/**
 * One stop in words. `'empty'` = the dry run's walk ran out of numbers (the
 * counter is 0, or everything down to 1 comes back); `null` = the list was cut
 * before it found where the walk stops.
 */
export function numberStopWords(stop: NumberStop | 'empty' | null): string {
  if (stop === 'empty') return 'sanoq boshiga yetdi — qaytadigan raqam qolmadi';
  if (stop === null) return 'ro‘yxat kesilgan — to‘xtash joyi ko‘rinmadi';
  return WORDS[stop.why](stop);
}
