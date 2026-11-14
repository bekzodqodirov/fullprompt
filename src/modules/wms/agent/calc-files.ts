import { eq, sql, type SQL } from 'drizzle-orm';
import { v5 as uuidv5 } from 'uuid';
import { db } from '../../platform/db/client';
import { attachments } from '../../platform/db/schema';
import { violatedUnique } from '../../platform/db/errors';
import { saveAttachment } from '../../platform/files/service';
import { getStorage } from '../../platform/files/storage';
import { logger } from '../../platform/logger';
import { tashkentDay } from '../../platform/time/tashkent';
import { AGENT_LIMITS } from './limits';
import { keptFileSql } from './outbox-store';

/**
 * The customer's files go to the VED with the job (SPEC-P2-v2 §1.4, regress 8, hands 8). The VED cannot open his
 * personal Telegram, and the note used to say only «(Chatda N ta fayl/rasm bor — Telegram suhbatida.)» — an invoice
 * nobody but him could read.
 *
 * WHICH files: every file this system KEPT from the customer's lines since the chat's last landed job (the newest
 * `agent_calc_links` row of this chat — a re-press of the same draft excluded, so its own link never hides its own
 * files), else the run's recent window (the newest `contextMessages` lines) — never only the lines the model CITED:
 * the model chooses its citations, and an uncited invoice would be left out in silence (judge R8). At most
 * `CALC_FILES_MAX`, the newest.
 *
 * HOW: `attachments.storage_key` is UNIQUE, so a second row over the chat's bytes cannot exist, and re-pointing the
 * chat's own row would take the file out of the chat thread and out of the chat's purge. Each file is COPIED — the
 * bytes read and written under a new key — as an attachment of the intake NOTE, pre-bound to the note's id before
 * the note exists (#180's pattern; the VED reads a note's files through the note its request points at,
 * attachments/access.ts). Idempotent per (note, source file): the copy's id is derived from both, so a re-press, the
 * K26 re-ask and two presses at once copy each file once. On the pool, before the approval's transaction (#714 — the
 * bytes are network I/O).
 *
 * A «🚫 Shaxsiy» purge does not reach the copies: they are the VED's record of a job, as a lesson's words are the
 * owner's (0148's rule's shape) — stated.
 */

/** At most this many of the chat's files go with one job — the newest. */
export const CALC_FILES_MAX = 10;

const COPY_NS = '2c8e6a4b-0149-4f3a-9d1c-7e5b3a2f1d0e';

/** The copy's id for (note, source file) — what makes a second press a read of the first one's copy. */
export const calcFileCopyId = (noteId: string, sourceId: string) => uuidv5(`${noteId}:${sourceId}`, COPY_NS);

/**
 * The chat's inbound lines since the chat's last landed job — the window both the copy and the gate's
 * `calc_file_missing` read, so the two cannot disagree about which lines «belong» to this job. `m` is the
 * `tg_messages` alias the caller selects from; `excludeDraftId` is the draft being landed (its own link, written by
 * an earlier attempt of the same press, is not «the last landed job»).
 */
function windowSql(managerUserId: string, peerId: bigint, excludeDraftId: string | null): SQL {
  const manager = sql`${managerUserId}::uuid`;
  const peer = sql`${String(peerId)}::bigint`;
  return sql`
    m.manager_user_id = ${manager} AND m.peer_id = ${peer} AND m.direction = 'in'
    AND NOT EXISTS (SELECT 1 FROM tg_message_flags f WHERE f.message_id = m.id AND f.deleted_at IS NOT NULL)
    AND CASE
          WHEN EXISTS (SELECT 1 FROM agent_calc_links l
                        WHERE l.manager_user_id = ${manager} AND l.peer_id = ${peer}
                          AND l.draft_id IS DISTINCT FROM ${excludeDraftId}::uuid)
          THEN m.sent_at > (SELECT max(l.created_at) FROM agent_calc_links l
                             WHERE l.manager_user_id = ${manager} AND l.peer_id = ${peer}
                               AND l.draft_id IS DISTINCT FROM ${excludeDraftId}::uuid)
          ELSE m.id IN (SELECT r.id FROM tg_messages r
                         WHERE r.manager_user_id = ${manager} AND r.peer_id = ${peer}
                         ORDER BY r.sent_at DESC, r.tg_message_id DESC
                         LIMIT ${AGENT_LIMITS.contextMessages})
        END`;
}

export interface ChatFile {
  id: string;
  storageKey: string;
  fileName: string;
  contentType: string;
  sentAt: Date;
}

/** The files to go with the job, oldest first (the newest `CALC_FILES_MAX`). */
export async function chatFilesForJob(managerUserId: string, peerId: bigint, excludeDraftId: string | null): Promise<ChatFile[]> {
  const rows = (await db.execute(sql`
    SELECT a.id::text AS id, a.storage_key, a.file_name, a.content_type, m.sent_at
      FROM tg_messages m
      JOIN attachments a ON a.entity_type = 'tg_message' AND a.entity_id = m.id
     WHERE ${windowSql(managerUserId, peerId, excludeDraftId)}
     ORDER BY m.sent_at DESC, a.created_at DESC
     LIMIT ${CALC_FILES_MAX}
  `)) as unknown as { id: string; storage_key: string; file_name: string; content_type: string; sent_at: string | Date }[];
  return rows
    .map((r) => ({ id: r.id, storageKey: r.storage_key, fileName: r.file_name, contentType: r.content_type, sentAt: new Date(r.sent_at) }))
    .reverse();
}

/**
 * The customer's lines in the job's window that carried a medium this system did NOT keep (`has_media` and no kept
 * attachment, `keptFileSql`) — fail closed: a sticker or a refused type waits too (SPEC-P2-v2 §1.1
 * `calc_file_missing`). Each by when it was sent — the card names the day.
 */
export async function missingChatFiles(managerUserId: string, peerId: bigint, excludeDraftId: string | null): Promise<Date[]> {
  const rows = (await db.execute(sql`
    SELECT m.sent_at FROM tg_messages m
     WHERE ${windowSql(managerUserId, peerId, excludeDraftId)}
       AND m.has_media AND NOT ${keptFileSql(sql`m.id`)}
     ORDER BY m.sent_at
  `)) as unknown as { sent_at: string | Date }[];
  return rows.map((r) => new Date(r.sent_at));
}

/** «12.11» — the Tashkent day a line was sent, as the card names it. */
export function dayMonth(at: Date): string {
  const [, mo, d] = tashkentDay(at).split('-');
  return `${d}.${mo}`;
}

/**
 * The card's words for files the VED will not get (`calc_file_missing`): «12.11 dagi fayl saqlanmagan — ✅ bossangiz
 * faylsiz yuboriladi; faylni VEDga o'zingiz bering». The size the spec names is not stored for a file nobody kept
 * (tg_messages carries `has_media` alone), so the day names it.
 */
export function missingFilesNote(days: readonly Date[]): string | null {
  if (days.length === 0) return null;
  const named = [...new Set(days.map(dayMonth))].join(', ');
  const what = days.length === 1 ? 'fayl' : `${days.length} ta fayl`;
  return `📎 ${named} dagi ${what} saqlanmagan — ✅ bossangiz faylsiz yuboriladi; faylni VEDga o‘zingiz bering.`;
}

/**
 * Copy the job's files onto the intake note (`noteId`, not yet written — pre-bound). Returns the files that stand on
 * the note after it — copied now or by an earlier press — oldest first; a file that could not be read or stored is
 * logged and left out (never fatal: the job lands without it, and the note says how many went).
 */
export async function copyChatFilesToNote(input: {
  managerUserId: string;
  peerId: bigint;
  noteId: string;
  draftId: string;
  uploadedBy: string;
}): Promise<{ copied: { id: string; fileName: string }[]; failed: number }> {
  const files = await chatFilesForJob(input.managerUserId, input.peerId, input.draftId);
  const copied: { id: string; fileName: string }[] = [];
  let failed = 0;
  for (const f of files) {
    const id = calcFileCopyId(input.noteId, f.id);
    const exists = async () => (await db.select({ id: attachments.id }).from(attachments).where(eq(attachments.id, id)).limit(1)).length > 0;
    try {
      if (!(await exists())) {
        const body = await getStorage().get(f.storageKey);
        await saveAttachment(
          { entityType: 'crm_activity', entityId: input.noteId, fileName: f.fileName, contentType: f.contentType, body, uploadedBy: input.uploadedBy },
          // A deterministic key and id: a press whose row never landed after its put overwrites that object on the
          // next press instead of orphaning it (`saveAttachment`'s own retry fence).
          { id, keyName: `c${id.replace(/-/gu, '')}` },
        );
      }
      copied.push({ id, fileName: f.fileName });
    } catch (err) {
      // Two presses at once: the other one's row landed between the read and the insert — it is copied.
      if (violatedUnique(err) !== null && (await exists())) {
        copied.push({ id, fileName: f.fileName });
        continue;
      }
      failed += 1;
      logger.warn({ err, noteId: input.noteId, file: f.id }, '[agent] a chat file not copied to the VED');
    }
  }
  return { copied, failed };
}

/**
 * The note's material line for the copied files (SPEC-P2-v2 §1.4): «Chatdan N ta fayl VEDga biriktirildi: …», naming
 * them — and the ones that could not go, said as such. Null when the job carries none.
 */
export function filesMaterialLine(copied: readonly { fileName: string }[], missing: number): string[] {
  const out: string[] = [];
  if (copied.length > 0) out.push(`Chatdan ${copied.length} ta fayl VEDga biriktirildi: ${copied.map((f) => f.fileName).join(', ')}.`);
  if (missing > 0) out.push(`(Chatda yana ${missing} ta fayl/rasm saqlanmagan — Telegram suhbatida.)`);
  return out;
}
