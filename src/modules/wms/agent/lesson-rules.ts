/**
 * His lessons («📝 Tuzatish», spec SPEC-P1-v2 §3: «hato qilgan joyini men aytib ketay va u ozi organib boradgan
 * bolsin») — the PURE rules: what one lesson may be, which of them fit the prompt, and the bytes they become there.
 * Zero imports, so the prompt, the page and the tests read one rule and the browser bundle can read the limits.
 *
 * A lesson is an INSTRUCTION, never a source: a figure in one vouches for nothing a reply says (G1 reads the tools,
 * the customer's own lines and the knowledge — never this block).
 */

export const LESSON_LIMITS = {
  /** One lesson, in characters — the 0148 CHECK's own bound. */
  maxChars: 500,
  /** How many lessons the prompt carries at most. */
  promptCount: 40,
  /** …and how many characters of them AS RENDERED (the lines of the block, joined) — whichever binds first. */
  promptChars: 6_000,
} as const;

/** A lesson as the prompt reads it. */
export interface PromptLesson {
  id: string;
  text: string;
}

/**
 * The block's heading (§3.3, binding wording): the lessons stand BELOW the rules — a rule wins a conflict, and no
 * lesson lifts the three questions that are always his (rail's price, a GS code, a complaint).
 */
export const LESSONS_HEADING =
  'BEKZODNING TUZATISHLARI (QOIDALARdan keyin turadi: zid kelsa — qoida ustun; 10, 12, 13-qoidalarda doim needs_owner=true):';

/** One lesson as one line: its own line breaks folded, so no lesson can draw a heading or a second bullet. */
export function lessonLine(text: string): string {
  return `- ${text.replace(/\s+/gu, ' ').trim()}`;
}

/**
 * Which lessons the prompt carries — a PREFIX of the list, newest first: lessons are taken while both caps hold, and
 * the first that does not fit ends it (every older one is left too). A prefix, never «skip and go on»: «the newest
 * are in, the oldest fell out» is a rule he can read off the page, and the bytes move only at the tail.
 *
 * Counted the way the head is built: the rendered lines joined by a newline, in characters (code points).
 */
export function fitLessons<T extends { text: string }>(newestFirst: readonly T[]): { inPrompt: T[]; left: T[] } {
  const inPrompt: T[] = [];
  let chars = 0;
  let i = 0;
  for (; i < newestFirst.length && inPrompt.length < LESSON_LIMITS.promptCount; i++) {
    const cost = [...lessonLine(newestFirst[i]!.text)].length + (inPrompt.length > 0 ? 1 : 0);
    if (chars + cost > LESSON_LIMITS.promptChars) break;
    chars += cost;
    inPrompt.push(newestFirst[i]!);
  }
  return { inPrompt, left: newestFirst.slice(i) };
}

/** How many characters the fitted lessons take in the prompt — what the page prints beside the cap. */
export function lessonsChars(newestFirst: readonly { text: string }[]): number {
  return [...fitLessons(newestFirst).inPrompt.map((l) => lessonLine(l.text)).join('\n')].length;
}

/**
 * The block as the stable head carries it — '' when there is no lesson, so a head with none is byte for byte the
 * head it was before lessons existed. The caps are applied HERE too: whatever a caller hands over, the head never
 * grows past them.
 */
export function lessonsBlock(newestFirst: readonly PromptLesson[]): string {
  const { inPrompt } = fitLessons(newestFirst);
  if (inPrompt.length === 0) return '';
  return `\n\n${LESSONS_HEADING}\n${inPrompt.map((l) => lessonLine(l.text)).join('\n')}`;
}

/** What a draft's policy keeps of the lessons its run read (§3.7): before/after rates per lesson are read off it. */
export interface LessonSetMark {
  /** A short digest of the block's own bytes — two runs that read the same lessons carry the same one. */
  digest: string;
  /** The newest lesson's id — «was this draft written after lesson X?». */
  newest: string;
  count: number;
}
