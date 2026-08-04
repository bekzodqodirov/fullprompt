/**
 * Lot letter sequencing — the owner's core rule (spec 5.3).
 *
 * Pure logic lives here; the transactional assignment (warehouse row locked
 * FOR UPDATE) is in `sequencer.ts`. Positions are 0-based indexes into the
 * sequence A…Z, AA…ZZ (702 positions per cycle) BEFORE blacklist skipping —
 * skipped combos consume a position but produce no letter, so extending the
 * blacklist never shifts already-assigned letters.
 */

const ALPHABET = 'ABCDEFGHIJKLMNOPQRSTUVWXYZ';

export const TOTAL_POSITIONS = 26 + 26 * 26; // A..Z then AA..ZZ

export function letterAt(position: number): string {
  if (position < 0 || position >= TOTAL_POSITIONS) {
    throw new RangeError(`letter position out of range: ${position}`);
  }
  if (position < 26) return ALPHABET[position]!;
  const p = position - 26;
  return ALPHABET[Math.floor(p / 26)]! + ALPHABET[p % 26]!;
}

export interface LetterState {
  /** Next unconsumed position (0 = "A is next"). */
  position: number;
  cycleNo: number;
}

export interface LetterAssignment {
  letter: string;
  cycleNo: number;
}

export interface LetterOptions {
  blacklist: Set<string>;
  /** Skip single letters I and O (config `exclude_ambiguous_letters`). */
  excludeAmbiguous?: boolean;
}

export function computeNextLetters(
  state: LetterState,
  count: number,
  opts: LetterOptions,
): { letters: LetterAssignment[]; nextState: LetterState } {
  let { position, cycleNo } = state;
  const letters: LetterAssignment[] = [];
  const skipped = (letter: string) =>
    opts.blacklist.has(letter) ||
    (opts.excludeAmbiguous === true && (letter === 'I' || letter === 'O'));

  // A full sweep with zero yield means the blacklist ate the whole alphabet.
  let sinceLastYield = 0;
  while (letters.length < count) {
    if (position >= TOTAL_POSITIONS) {
      position = 0;
      cycleNo += 1;
    }
    const letter = letterAt(position);
    position += 1;
    if (skipped(letter)) {
      sinceLastYield += 1;
      if (sinceLastYield > TOTAL_POSITIONS) {
        throw new Error('letter blacklist excludes every combination');
      }
      continue;
    }
    sinceLastYield = 0;
    letters.push({ letter, cycleNo });
  }
  return { letters, nextState: { position, cycleNo } };
}
