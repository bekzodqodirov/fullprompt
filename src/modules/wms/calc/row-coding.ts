import { productKey, tnvedFor } from '../tnved/service';
import { AI_CODE_NOTE } from './code-source';
import { doorName } from './door-row';
import type { CalcGoodsFact } from './intake';
import { NO_REQUEST, itemNameNorm, sealedMemoryFor } from './memory';

/**
 * ONE function codes a goods row (docs/IKKI-ESHIK.md §3.1, #513): the bot's
 * reading calls it so the table can ask the law's unit of the code the row
 * will carry, and `openCalcRequest` calls it before its INSERT — so the table
 * and the card code a row the same way, and the unit the table asked is the
 * book law of exactly the code the INSERT stores.
 *
 * The order is the owner's (his 2026-09-05 answer, kept):
 *  1. the row's own code — the Excel's column, the seller's typed one; at the
 *     INSERT, whatever the collection already carries, with the source it
 *     carries (the reading ran this very order before it);
 *  2. what a VED SEALED for a name like it (`sealedMemoryFor`) — the
 *     company's own confirmed answer;
 *  3. the exact-key TNVED book (`tnvedFor`), for a name written the same way;
 *  4. the model's proposal — the reading's only: a model-read line's own
 *     code, or a code the model gave an Excel row by its number
 *     (`known_codes`). Last, because nobody stated it; such a row lands with
 *     `AI_CODE_NOTE` for the VED to check.
 *
 * Only the CODE is decided here. The baza is the workspace's sweep to fill
 * (`saveTable`), under the group's law — a price without that check is a
 * number in the wrong unit. Pooled: never called inside a transaction (#714;
 * `sealedMemoryFor` opens its own short one for the trigram GUC).
 */

export type TnvedSource = NonNullable<CalcGoodsFact['tnvedSource']>;

/** One row as the coding sees it. */
export interface CodingRow {
  name: string;
  /** The row's own code (step 1). */
  own: string | null;
  /** Where `own` came from, when the caller knows it — absent = the row's own ('row'). */
  ownSource?: TnvedSource | null;
  /** The model's proposal (step 4) — the reading's; null at the INSERT. */
  model: string | null;
}

export interface CodedRow {
  code: string | null;
  /** null = no code at all. */
  source: TnvedSource | null;
}

/** The two dictionaries, by the row's stored name — injectable, so the ORDER is a unit test. */
export interface CodingLookups {
  memory(names: readonly string[]): Promise<ReadonlyMap<string, string | null>>;
  book(names: readonly string[]): Promise<ReadonlyMap<string, string | null>>;
}

/** The real ones: the sealed memory and the exact-key book, each one query for every name. */
export const DICTIONARY_LOOKUPS: CodingLookups = {
  async memory(names) {
    const hits = await sealedMemoryFor([...names], { excludeRequestId: NO_REQUEST });
    return new Map(names.map((n) => [n, hits.get(itemNameNorm(n))?.tnvedCode ?? null]));
  },
  async book(names) {
    const hits = await tnvedFor([...names]);
    return new Map(names.map((n) => [n, hits.get(productKey(n))?.tnvedCode ?? null]));
  },
};

/**
 * Code every row, in the order above, with where each code came from. Only
 * the rows with no code of their own are looked up — the answer for the rest
 * is theirs — and by the name as the INSERT stores it (`doorName`), so a long
 * name is asked by the same string at the reading and at the INSERT.
 */
export async function codeRows(
  rows: readonly CodingRow[],
  lookups: CodingLookups = DICTIONARY_LOOKUPS,
): Promise<CodedRow[]> {
  const own = rows.map((r) => r.own?.trim() || null);
  const asking = [...new Set(rows.filter((_r, i) => own[i] === null).map((r) => doorName(r.name)))];
  const [memory, book] =
    asking.length > 0
      ? await Promise.all([lookups.memory(asking), lookups.book(asking)])
      : [new Map<string, string | null>(), new Map<string, string | null>()];
  return rows.map((r, i): CodedRow => {
    const stated = own[i];
    if (stated) return { code: stated, source: r.ownSource ?? 'row' };
    const name = doorName(r.name);
    const remembered = memory.get(name)?.trim();
    if (remembered) return { code: remembered, source: 'memory' };
    const booked = book.get(name)?.trim();
    if (booked) return { code: booked, source: 'book' };
    const proposed = r.model?.trim();
    if (proposed) return { code: proposed, source: 'model' };
    return { code: null, source: null };
  });
}

/**
 * A row's note as it lands: a code the model proposed carries `AI_CODE_NOTE`
 * after whatever the row already says (joined « · », as `doorRow` joins), and
 * once — a note that already says it is left alone. Any other source adds
 * nothing. Pure.
 */
export function codedNote(note: string | null, source: TnvedSource | null | undefined): string | null {
  if (source !== 'model') return note;
  if (!note) return AI_CODE_NOTE;
  return note.includes(AI_CODE_NOTE) ? note : `${note} · ${AI_CODE_NOTE}`;
}
