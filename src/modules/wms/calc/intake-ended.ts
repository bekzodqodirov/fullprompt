import { sql } from 'drizzle-orm';
import { db } from '../../platform/db/client';
import { cardOfNote, rootRequestOfNote } from './intake-land';

/**
 * Is a durable «Hisoblatish» collection over? (docs/SAKKIZ-R3.md §6.2.10, §6.2.15.)
 *
 * The bot's store (platform/telegram/calc-store.ts) keeps a collection as a row
 * so a deploy loses nothing — and then has to tell, after the deploy, which
 * rows are collections still being collected and which are jobs that already
 * landed. The store is platform and the jobs are wms, so it asks here, by
 * dynamic import (platform never imports wms statically).
 *
 * «Landed» has ONE meaning, Uch band's (docs/UCH-BAND.md): a ROOT
 * `calc_requests` row carries the note id — `rootRequestOfNote`'s predicate,
 * the WHERE of `rootOfNoteSql` (service.ts). A note that reached its card
 * with no request beside it is a landing cut off halfway (durability-3): the
 * collection is KEPT, and the sweep finishes it on the note's own card.
 */

export interface EndedCheck {
  noteId: string;
  /** An add collection («➕ Shu so‘rovga qo‘shish»): its note is its save job's, never a landing's. */
  amend: boolean;
}

export interface EndedVerdict {
  /** The note ids whose collection is over — their rows go. */
  ended: Set<string>;
  /** Additions written but never told to the seller: kept, and their save job sent again. */
  untold: { noteId: string; requestId: string; submission: unknown }[];
}

/**
 * Two statements at most, over every hydrated note at once (the hydrate runs
 * before the first `getUpdates`, so its cost is the poll's).
 *  - a new-request collection is over when a ROOT request carries its note;
 *  - an add collection is over when its `calc_amendments` row exists AND the
 *    seller was told (`outcome_sent_at`); a row nobody told is kept.
 */
export async function endedCollections(rows: readonly EndedCheck[]): Promise<EndedVerdict> {
  const verdict: EndedVerdict = { ended: new Set(), untold: [] };
  const fresh = rows.filter((r) => !r.amend).map((r) => r.noteId);
  const adds = rows.filter((r) => r.amend).map((r) => r.noteId);
  if (fresh.length > 0) {
    // `rootOfNoteSql`'s predicate over many notes at once (its own form ends
    // in ORDER BY … LIMIT 1, for one note); `rootRequestOfNote` below is the
    // same question for one, and the integration test holds the two together.
    const landed = (await db.execute(sql`
      SELECT DISTINCT note_id::text AS note_id
        FROM calc_requests
       WHERE note_id IN (${sql.join(fresh.map((id) => sql`${id}::uuid`), sql`, `)})
         AND supersedes_request_id IS NULL`)) as unknown as { note_id: string }[];
    for (const row of landed) verdict.ended.add(row.note_id);
  }
  if (adds.length > 0) {
    const saved = (await db.execute(sql`
      SELECT note_id::text AS note_id, request_id::text AS request_id, submission,
             outcome_sent_at IS NOT NULL AS told
        FROM calc_amendments
       WHERE note_id IN (${sql.join(adds.map((id) => sql`${id}::uuid`), sql`, `)})`)) as unknown as {
      note_id: string;
      request_id: string;
      submission: unknown;
      told: boolean;
    }[];
    for (const row of saved) {
      if (row.told) verdict.ended.add(row.note_id);
      else verdict.untold.push({ noteId: row.note_id, requestId: row.request_id, submission: row.submission });
    }
  }
  return verdict;
}

/**
 * Where a new-request collection's landing stands, for the sweep (§6.2.15):
 * 'landed' = a root request carries the note; 'note_only' = the note is on
 * the sender's own card with no request (a cut-off landing, finished by
 * calling the landing again — it converges on that card); 'none' = it never
 * landed. Uch band's two readers, in Uch band's order — the «landed» check
 * first, so a landed note never meets a refusal — and no SQL of its own.
 */
export async function landingState(noteId: string, staffId: string): Promise<'none' | 'landed' | 'note_only'> {
  if ((await rootRequestOfNote(noteId)) !== null) return 'landed';
  const card = await cardOfNote(noteId, staffId, null);
  return card !== null && card !== 'foreign' ? 'note_only' : 'none';
}
