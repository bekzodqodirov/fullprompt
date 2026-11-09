import { eq } from 'drizzle-orm';
import { db } from '../../platform/db/client';
import { calcRequestItems } from '../../platform/db/schema';
import { logger } from '../../platform/logger';
import { productKey, tnvedFor } from '../tnved/service';
import type { AiVedLine } from './ai-reply';
import type { AiNoteGroup, AiNoteRow, CodeSource } from './ai-note';
import { AI_CODE_NOTE } from './code-source';
import { itemNameNorm, sealedMemoryFor } from './memory';
import type { BazaSource } from './pricing';
import type { Workspace, WorkspaceItem } from './workspace';

/**
 * What the plain door's note says the machine found (docs/IKKI-ESHIK.md
 * §2.4) — READ, never written: the sources it names are the ones the row's
 * own columns, the pass's own steps and the INSERT's order already decided.
 *
 * Its own module and not the pass's: `prefill.ts` is fenced against naming a
 * provenance at all (`ai-advisory.test.ts` — a value named there is a value
 * that can travel to a writer), and this file names every one of them, to
 * print. Nothing here writes; its readers are the pass and nothing else.
 */

/** Does a row's note carry the reading-time model's code mark (§3.1)? */
export const carriesAiCode = (note: string | null): boolean => (note ?? '').includes(AI_CODE_NOTE);

/** The request's codes by row, as they stand — the plain note's «landed with» (§2.4). */
export async function codesOf(requestId: string): Promise<Map<string, string | null> | null> {
  try {
    const rows = await db
      .select({ id: calcRequestItems.id, tnvedCode: calcRequestItems.tnvedCode })
      .from(calcRequestItems)
      .where(eq(calcRequestItems.requestId, requestId));
    return new Map(rows.map((r) => [r.id, (r.tnvedCode ?? '').trim() || null]));
  } catch (err) {
    logger.warn({ err, requestId }, '[calc-prefill] the landed codes not read — the note names no code source');
    return null;
  }
}

/**
 * Every row of the request with its code and WHERE the code came from (§2.4):
 * the pass's own steps it knows — step 0's memory, its model — and for a code
 * the request LANDED with, the INSERT's order re-asked (§3.1): the reading's
 * model when the row carries `AI_CODE_NOTE`, else the sealed memory, else the
 * exact-key book, else the row's own. The INSERT prefers the row's own code
 * to both memories; a row whose own code a memory happens to agree with is
 * named by that memory — the code is the same either way. A read that fails
 * names no source; it never costs the note.
 */
export async function noteRows(
  requestId: string,
  ws: Workspace,
  landed: Map<string, string | null> | null,
  memoryIds: ReadonlySet<string>,
  aiUsed: boolean,
): Promise<AiNoteRow[]> {
  const items = [...ws.groups.flatMap((g) => g.items), ...ws.ungrouped].sort((a, b) => a.seq - b.seq);
  const codeOf = (i: WorkspaceItem) => (i.tnvedCode ?? '').trim() || null;
  const source = new Map<string, CodeSource | null>();
  const asked: WorkspaceItem[] = [];
  for (const i of items) {
    const code = codeOf(i);
    if (code === null || landed === null) continue;
    if (landed.get(i.id) === code) {
      if (carriesAiCode(i.note)) source.set(i.id, 'reading');
      else asked.push(i);
    } else if (memoryIds.has(i.id)) source.set(i.id, 'memory');
    // Nothing but the memory and the model codes a row in the pass.
    else source.set(i.id, aiUsed ? 'model' : null);
  }
  if (asked.length > 0) {
    try {
      const names = asked.map((i) => i.label);
      const [book, sealed] = await Promise.all([tnvedFor(names), sealedMemoryFor(names, { excludeRequestId: requestId })]);
      for (const i of asked) {
        const code = codeOf(i);
        source.set(
          i.id,
          sealed.get(itemNameNorm(i.label))?.tnvedCode === code
            ? 'memory'
            : book.get(productKey(i.label))?.tnvedCode === code
              ? 'book'
              : 'row',
        );
      }
    } catch (err) {
      logger.warn({ err, requestId }, '[calc-prefill] the landed codes’ sources not read — the note says the code alone');
    }
  }
  return items.map((i) => ({ seq: i.seq, name: i.label, code: codeOf(i), source: source.get(i.id) ?? null }));
}

/**
 * The reply's own group lines (`replyLines`, index for index — one map over
 * `ws.groups`) with what the note adds: where the rates and the bazas came
 * from. The law and the refusal are the reply's words, so the VED's note and
 * the AI door's answer cannot describe one group two ways (#513).
 */
export function noteGroups(ws: Workspace, lines: readonly AiVedLine[]): AiNoteGroup[] {
  return ws.groups.map((g, k) => {
    const line = lines[k]!;
    const bazas: Partial<Record<Exclude<BazaSource, null>, number>> = {};
    let bazaless = 0;
    for (const i of g.items) {
      if (i.bazaUsd === null) bazaless += 1;
      else if (i.bazaSource !== null) bazas[i.bazaSource] = (bazas[i.bazaSource] ?? 0) + 1;
    }
    return {
      label: line.label,
      code: line.code,
      aiCode: line.aiCode,
      dutyText: line.dutyText,
      addDutyPct: line.addDutyPct,
      exciseText: line.exciseText,
      vatPct: line.vatPct,
      rates: g.rateSource,
      bazas,
      bazaless,
      refusal: line.refusal,
      refusalTail: line.refusalTail,
    };
  });
}
