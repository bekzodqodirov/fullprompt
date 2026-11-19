import { and, asc, eq, inArray, isNull, or, sql, type SQL } from 'drizzle-orm';
import { z } from 'zod';
import { db } from '../db/client';
import { attachments, staffNoteParts, staffNotes } from '../db/schema';
import { isServerBehind } from '../db/errors';
import { writeAudit, type AuditContext } from '../audit/service';
import { purgeAttachment } from '../files/service';
import { MAX_TELEGRAM_PHOTO_BYTES } from '../telegram/limits';
import type { NoteFile, NoteHead } from './plan';

/**
 * Zametkalar — the library the staff bot re-sends from.
 *
 * Two kinds, which is the owner's own answer (1b): the COMPANY's, written by
 * whoever may publish and offered to everybody, and a person's own, which
 * nobody else sees. The ownership column and its one-line read are
 * `reply_templates`' exactly, and so is the gate on writing a shared one —
 * deciding what every colleague is offered, and can forward to a customer with
 * one tap, is a different and larger power than keeping a note for yourself.
 *
 * The bot and the screen are TWO DOORS onto these functions, never two
 * implementations: `visibleNotes` decides visibility once (#513), and every
 * refusal is a code the caller turns into a sentence.
 */

export class NoteError extends Error {
  constructor(public readonly code: NoteErrorCode) {
    super(code);
  }
}

export type NoteErrorCode =
  | 'unauthenticated'
  | 'validation'
  | 'forbidden'
  | 'not_found'
  | 'note_empty'
  | 'title_taken'
  | 'too_many_parts'
  /** The «🆕 Yangi mijozga» tick on a note that is somebody's own (0151's CHECK, said in words). */
  | 'not_company'
  /** 0151 has not landed: the tick's column is not there yet (#472's morning). */
  | 'server_behind';

/** Publishing to the company. No new permission code (#170). */
export const SHARE_NOTES_PERMISSION = 'admin.settings.manage';

/**
 * Ten, which is `sendMediaGroup`'s own ceiling and therefore the point past
 * which one tap stops being one burst. It also keeps a note from quietly
 * becoming the largest thing in a MinIO that shares its disk with Postgres and
 * every cargo photograph.
 */
export const MAX_NOTE_PARTS = 10;

export function canShareNotes(permissions: Set<string>): boolean {
  return permissions.has(SHARE_NOTES_PERMISSION);
}

export const noteSchema = z.object({
  // Bounded and trimmed HERE, not at render: the title becomes an inline
  // button's text, an empty button is refused by Telegram, and a refusal kills
  // the whole message — so a company note of spaces would break the 📌 list
  // for every colleague at once.
  title: z.string().trim().min(1).max(64),
  /** What the thing IS — his own words, «nima narsaligini yozish». */
  body: z.string().trim().max(3000).optional().or(z.literal('')),
  /** True asks for the company's list; refused without the permission. */
  shared: z.boolean().default(false),
});
export type NoteInput = z.infer<typeof noteSchema>;

export interface NoteCtx extends AuditContext {
  actorId: string | null;
  canShare: boolean;
}

/**
 * THE visibility rule. The company's, plus this person's own — and nothing
 * else, for anybody, including an admin: a personal note is somebody's own the
 * way a personal canned reply is.
 */
export function visibleNotes(actorId: string): SQL {
  return or(isNull(staffNotes.userId), eq(staffNotes.userId, actorId))!;
}

export interface NoteRow extends NoteHead {
  userId: string | null;
  sortOrder: number;
  /** Moved by every writer of the row, the 🆕 flag's included — the screen's press is tied to it. */
  updatedAt: Date;
  shared: boolean;
  partCount: number;
}

/**
 * The list both doors draw. Part counts come from ONE grouped query beside it
 * rather than a count per row (#432 — a list's length is the business growing).
 */
export async function listNotes(actorId: string): Promise<NoteRow[]> {
  const rows = await db
    .select()
    .from(staffNotes)
    .where(visibleNotes(actorId))
    // Across BOTH scopes, so a company library cannot evict a person's own
    // notes off the end of the bot's list. `sort_order` is a column with a
    // default and no input: he asked for three things on the form and this is
    // not one of them, so the library is alphabetical until he asks otherwise.
    .orderBy(asc(staffNotes.sortOrder), asc(staffNotes.title));
  if (rows.length === 0) return [];
  const counts = await db
    .select({ noteId: staffNoteParts.noteId, n: sql<number>`count(*)::int` })
    .from(staffNoteParts)
    .where(
      inArray(
        staffNoteParts.noteId,
        rows.map((r) => r.id),
      ),
    )
    .groupBy(staffNoteParts.noteId);
  const byNote = new Map(counts.map((c) => [c.noteId, c.n]));
  return rows.map((row) => ({
    ...row,
    shared: row.userId === null,
    partCount: byNote.get(row.id) ?? 0,
  }));
}

/**
 * One note and its files, or null.
 *
 * The visibility predicate is in the WHERE and not a check after the load —
 * an inline keyboard is permanent chat history, so a button tapped a week
 * later may name a note that has since been deleted or moved out of this
 * person's sight, and the query is what must refuse it.
 */
export async function noteWithFiles(
  id: string,
  actorId: string,
): Promise<{ note: NoteRow; files: NoteFile[] } | null> {
  const [row] = await db
    .select()
    .from(staffNotes)
    .where(and(eq(staffNotes.id, id), visibleNotes(actorId)))
    .limit(1);
  if (!row) return null;
  const files = await filesForNote(id);
  return {
    note: { ...row, shared: row.userId === null, partCount: files.length },
    files,
  };
}

export async function filesForNote(noteId: string): Promise<NoteFile[]> {
  const rows = await db
    .select({
      partId: staffNoteParts.id,
      attachmentId: attachments.id,
      fileName: attachments.fileName,
      storageKey: attachments.storageKey,
      sizeBytes: attachments.sizeBytes,
      sendAs: staffNoteParts.sendAs,
      telegramFileId: staffNoteParts.telegramFileId,
      telegramSentAs: staffNoteParts.telegramSentAs,
      kind: attachments.kind,
      sortOrder: staffNoteParts.sortOrder,
    })
    .from(staffNoteParts)
    .innerJoin(attachments, eq(attachments.id, staffNoteParts.attachmentId))
    .where(eq(staffNoteParts.noteId, noteId))
    .orderBy(asc(staffNoteParts.sortOrder), asc(staffNoteParts.createdAt));
  return rows.map((r) => ({
    partId: r.partId,
    attachmentId: r.attachmentId,
    fileName: r.fileName,
    storageKey: r.storageKey,
    sizeBytes: r.sizeBytes,
    sendAs: r.sendAs === 'document' ? 'document' : 'photo',
    telegramFileId: r.telegramFileId,
    telegramSentAs:
      r.telegramSentAs === 'photo' || r.telegramSentAs === 'document' ? r.telegramSentAs : null,
  }));
}

/** The shape a freshly uploaded file must be sent in, decided once. */
export function defaultSendAs(kind: string, sizeBytes: number): 'photo' | 'document' {
  // Only a real photograph can go as a photo at all, and only under Telegram's
  // own byte ceiling — which is LOWER than the one our storage accepts, so a
  // legitimately stored 12 MB image is a document or it is nothing.
  return kind === 'photo' && sizeBytes <= MAX_TELEGRAM_PHOTO_BYTES ? 'photo' : 'document';
}

/** Who owns this note, asked before every write. Templates' predicate verbatim. */
function refuseUnlessOwn(row: { userId: string | null }, ctx: NoteCtx): void {
  const mine = row.userId === null ? ctx.canShare : row.userId === ctx.actorId;
  if (!mine) throw new NoteError('forbidden');
}

/**
 * Create or correct a note.
 *
 * Uploads are pre-bound to a browser-minted id before the note exists (#180's
 * pattern), so the save CLAIMS whatever arrived under this note's id into
 * parts. On an edit that means new uploads join the note and the ones already
 * there keep their order.
 */
export async function saveNote(
  input: NoteInput & { id: string },
  ctx: NoteCtx,
): Promise<{ id: string; parts: number }> {
  if (!ctx.actorId) throw new NoteError('unauthenticated');
  const parsed = noteSchema.safeParse(input);
  if (!parsed.success) throw new NoteError('validation');
  const data = parsed.data;
  if (data.shared && !ctx.canShare) throw new NoteError('forbidden');

  const existing = await db.query.staffNotes.findFirst({ where: eq(staffNotes.id, input.id) });
  if (existing) refuseUnlessOwn(existing, ctx);

  // An ordinary save NEVER moves a note between the two lists.
  //
  // The precedent recomputes the owner from the checkbox on every save, and
  // that means one absent-minded edit of the COMPANY's address sheet turns it
  // into somebody's private note and the whole company loses it — no refusal,
  // no warning, and nobody notices until a customer asks for the address.
  // Moving a note is its own act, with its own button (`setNoteShared`); the
  // checkbox on the form decides the scope of a note being CREATED and
  // nothing else.
  const userId = existing ? existing.userId : data.shared ? null : ctx.actorId;

  const values = {
    title: data.title,
    body: data.body?.trim() || null,
    userId,
  };

  try {
    if (existing) {
      await db
        .update(staffNotes)
        .set({ ...values, updatedAt: new Date() })
        .where(eq(staffNotes.id, input.id));
    } else {
      await db.insert(staffNotes).values({ ...values, id: input.id, createdBy: ctx.actorId });
    }
  } catch (err) {
    if (isUniqueViolation(err)) throw new NoteError('title_taken');
    throw err;
  }

  const parts = await claimUploads(input.id, ctx.actorId);
  const emptied = !values.body && parts === 0;
  if (emptied) {
    // A note that says nothing sends nothing, and a tap that sends nothing is
    // the silence rounds 89 and 97 were spent removing. Refused at the door —
    // and the row is taken back out when it was this save that minted it.
    // Three things make a note (his own correction): a name, the text saying
    // what it is, and files; the name alone is a label for nothing.
    if (!existing) await db.delete(staffNotes).where(eq(staffNotes.id, input.id));
    throw new NoteError('note_empty');
  }

  // The note's IDENTITY, never its contents: /admin/audit prints `after`
  // verbatim to anyone holding admin.audit.browse, and a personal note is
  // precisely where somebody keeps a supplier's price or a private address.
  await writeAudit(db, ctx, {
    entityType: 'staff_note',
    entityId: input.id,
    action: existing ? 'update' : 'create',
    after: { title: values.title, shared: values.userId === null, parts },
    ...(existing ? { before: { title: existing.title, shared: existing.userId === null } } : {}),
  });
  return { id: input.id, parts };
}

function isUniqueViolation(err: unknown): boolean {
  const pg = err as { code?: string; cause?: { code?: string } };
  return pg?.code === '23505' || pg?.cause?.code === '23505';
}

/**
 * Turn the uploads that arrived under this note's id into parts.
 *
 * The upload route pre-binds by (entityType, entityId), so this is where a
 * file becomes a part of the note rather than a loose object — and where the
 * ceiling bites, in words, rather than at send time in a warehouse.
 */
async function claimUploads(noteId: string, actorId: string): Promise<number> {
  const owned = await db
    .select({
      id: attachments.id,
      kind: attachments.kind,
      sizeBytes: attachments.sizeBytes,
      createdAt: attachments.createdAt,
    })
    .from(attachments)
    .where(and(eq(attachments.entityType, NOTE_ENTITY_TYPE), eq(attachments.entityId, noteId)))
    .orderBy(asc(attachments.createdAt));
  const claimed = await db
    .select({ attachmentId: staffNoteParts.attachmentId, sortOrder: staffNoteParts.sortOrder })
    .from(staffNoteParts)
    .where(eq(staffNoteParts.noteId, noteId));
  const have = new Set(claimed.map((c) => c.attachmentId));
  const fresh = owned.filter((a) => !have.has(a.id));
  if (fresh.length === 0) return claimed.length;
  if (claimed.length + fresh.length > MAX_NOTE_PARTS) throw new NoteError('too_many_parts');

  let next = claimed.reduce((max, c) => Math.max(max, c.sortOrder), 0);
  await db.insert(staffNoteParts).values(
    fresh.map((a) => {
      next += 10;
      return {
        noteId,
        attachmentId: a.id,
        sortOrder: next,
        sendAs: defaultSendAs(a.kind, a.sizeBytes),
      };
    }),
  );
  void actorId;
  return claimed.length + fresh.length;
}

/** The one thing an admin does when a warehouse moves: swap the sheet. */
export async function removeNotePart(partId: string, ctx: NoteCtx): Promise<void> {
  if (!ctx.actorId) throw new NoteError('unauthenticated');
  const [part] = await db
    .select({
      id: staffNoteParts.id,
      noteId: staffNoteParts.noteId,
      attachmentId: staffNoteParts.attachmentId,
      userId: staffNotes.userId,
      body: staffNotes.body,
    })
    .from(staffNoteParts)
    .innerJoin(staffNotes, eq(staffNotes.id, staffNoteParts.noteId))
    .where(eq(staffNoteParts.id, partId))
    .limit(1);
  if (!part) throw new NoteError('not_found');
  refuseUnlessOwn(part, ctx);
  const [counted] = await db
    .select({ n: sql<number>`count(*)::int` })
    .from(staffNoteParts)
    .where(eq(staffNoteParts.noteId, part.noteId));
  if ((counted?.n ?? 0) <= 1 && !part.body) throw new NoteError('note_empty');

  // The part row goes with the attachment (ON DELETE cascade), and the bytes
  // go with it. Never in a transaction: two of these calls are network I/O to
  // the object store, and a pooled call inside one is #714's measured freeze.
  await purgeAttachment(part.attachmentId);
  await writeAudit(db, ctx, {
    entityType: 'staff_note',
    entityId: part.noteId,
    action: 'update',
    after: { removedPart: partId },
  });
}

/** «Rasm sifatida» / «Fayl sifatida» on the screen. */
export async function setPartSendAs(
  partId: string,
  sendAs: 'photo' | 'document',
  ctx: NoteCtx,
): Promise<void> {
  if (!ctx.actorId) throw new NoteError('unauthenticated');
  const [part] = await db
    .select({ id: staffNoteParts.id, noteId: staffNoteParts.noteId, userId: staffNotes.userId })
    .from(staffNoteParts)
    .innerJoin(staffNotes, eq(staffNotes.id, staffNoteParts.noteId))
    .where(eq(staffNoteParts.id, partId))
    .limit(1);
  if (!part) throw new NoteError('not_found');
  refuseUnlessOwn(part, ctx);
  // The cached id is typed by the method that minted it, so changing the
  // method retires it rather than handing a document id to sendPhoto.
  await db
    .update(staffNoteParts)
    .set({ sendAs, telegramFileId: null, telegramSentAs: null })
    .where(eq(staffNoteParts.id, partId));
}

/**
 * Move a note between the company's list and its author's own.
 *
 * Its own act, deliberately: this is the only thing that can take an address
 * sheet away from twenty colleagues, and it must never be a side effect of
 * correcting a typo. Both directions need the publish permission — putting a
 * note into everybody's list and taking it out again are the same power.
 */
export async function setNoteShared(id: string, shared: boolean, ctx: NoteCtx): Promise<void> {
  if (!ctx.actorId) throw new NoteError('unauthenticated');
  if (!ctx.canShare) throw new NoteError('forbidden');
  const existing = await db.query.staffNotes.findFirst({ where: eq(staffNotes.id, id) });
  if (!existing) throw new NoteError('not_found');
  refuseUnlessOwn(existing, ctx);
  if ((existing.userId === null) === shared) return;
  const owner = shared ? null : (existing.userId ?? ctx.actorId);
  // Taking a note out of the company's list takes its «🆕 Yangi mijozga» tick
  // with it, in the SAME statement (0151): a personal note cannot be one the
  // new-client card sends, and a second statement — or a CHECK refusal caught
  // afterwards — would be a white page or a half-move under a race.
  const wasFlagged = !shared && ((await newClientFlags(ctx.actorId))?.has(id) ?? false);
  try {
    if (!shared) {
      await unshareClearingFlag(id, owner!);
    } else {
      await db.update(staffNotes).set({ userId: owner, updatedAt: new Date() }).where(eq(staffNotes.id, id));
    }
  } catch (err) {
    if (isUniqueViolation(err)) throw new NoteError('title_taken');
    throw err;
  }
  await writeAudit(db, ctx, {
    entityType: 'staff_note',
    entityId: id,
    action: 'update',
    // History says the card lost a note, not only that a list did.
    before: { shared: existing.userId === null, ...(wasFlagged ? { forNewClient: true } : {}) },
    after: { shared, ...(wasFlagged ? { forNewClient: false } : {}) },
  });
}

/**
 * The unshare's one statement. One migration behind (0151 not run) the column
 * is absent and no tick can exist, so the plain move is the whole truth.
 */
async function unshareClearingFlag(id: string, owner: string): Promise<void> {
  try {
    await db.execute(sql`
      UPDATE staff_notes SET user_id = ${owner}::uuid, for_new_client = false, updated_at = now()
       WHERE id = ${id}::uuid`);
  } catch (err) {
    if (!isServerBehind(err)) throw err;
    await db.update(staffNotes).set({ userId: owner, updatedAt: new Date() }).where(eq(staffNotes.id, id));
  }
}

/**
 * «🆕 Yangi mijozga yuborilsin» — the tick on a COMPANY note (0151, the
 * owner's answer: his «Xitoy sklad» zametka with the three addresses and the
 * picture is the one he ticks himself; nothing is ever ticked by its title).
 *
 * The publisher's power and nobody else's: what every new customer is sent is
 * a broadcast to the company's customers, larger than editing a note. The ONE
 * writer of the column — raw SQL, because the column is not on the drizzle
 * table this release (#1313: a whole-row reader would 42703 one migration
 * behind) — and `user_id IS NULL` is in its WHERE, so a note moved to
 * somebody's own list between the read and the write is refused, never
 * flagged.
 */
export async function setNewClientFlag(id: string, on: boolean, ctx: NoteCtx): Promise<void> {
  if (!ctx.actorId) throw new NoteError('unauthenticated');
  if (!ctx.canShare) throw new NoteError('forbidden');
  const existing = await db.query.staffNotes.findFirst({ where: eq(staffNotes.id, id) });
  if (!existing) throw new NoteError('not_found');
  if (existing.userId !== null) throw new NoteError('not_company');
  const flags = await newClientFlags(ctx.actorId);
  if (flags === null) throw new NoteError('server_behind');
  // A press that changes nothing writes nothing — no empty History line (#502).
  if (flags.has(id) === on) return;
  let rows: unknown[];
  try {
    rows = [
      ...(await db.execute(sql`
        UPDATE staff_notes SET for_new_client = ${on}, updated_at = now()
         WHERE id = ${id}::uuid AND user_id IS NULL
        RETURNING id`)),
    ];
  } catch (err) {
    if (isServerBehind(err)) throw new NoteError('server_behind');
    throw err;
  }
  if (rows.length === 0) throw new NoteError('not_company');
  await writeAudit(db, ctx, {
    entityType: 'staff_note',
    entityId: id,
    action: 'update',
    before: { forNewClient: !on },
    after: { forNewClient: on },
  });
}

/**
 * The ticked notes this reader may see, by id — or null when 0151 has not
 * landed (the screen then draws no tick at all rather than a white page).
 */
export async function newClientFlags(actorId: string): Promise<Set<string> | null> {
  try {
    const rows = await db
      .select({ id: staffNotes.id })
      .from(staffNotes)
      // `${staffNotes}.for_new_client`, never a bare name (#128's idiom): the
      // column is qualified by its TABLE, whatever the select around it is.
      .where(and(visibleNotes(actorId), sql`${staffNotes}.for_new_client`));
    return new Set(rows.map((row) => row.id));
  } catch (err) {
    if (isServerBehind(err)) return null;
    throw err;
  }
}

/**
 * What the new-client card carries: every ticked note this recipient may see,
 * in the library's own order, each with its files in the note's order.
 *
 * Through `visibleNotes` like every other reader (the fence), with the person
 * the card goes to — a tick can only sit on a company note (0151's CHECK), so
 * in practice that is the company's ticked notes; the predicate is what makes
 * «in practice» a rule. One migration behind it answers «nothing is ticked»,
 * which is true: the card then goes as its footer alone, and says so.
 */
export async function newClientNotes(
  recipientId: string,
): Promise<{ note: NoteHead; files: NoteFile[] }[]> {
  let rows: { id: string; title: string; body: string | null }[];
  try {
    rows = await db
      .select({ id: staffNotes.id, title: staffNotes.title, body: staffNotes.body })
      .from(staffNotes)
      .where(and(visibleNotes(recipientId), sql`${staffNotes}.for_new_client`))
      .orderBy(asc(staffNotes.sortOrder), asc(staffNotes.title));
  } catch (err) {
    if (isServerBehind(err)) return [];
    throw err;
  }
  const out: { note: NoteHead; files: NoteFile[] }[] = [];
  // One read per ticked note: he ticks one or two, never a list (#432 is
  // about a list's length, and this list is his handful).
  for (const row of rows) out.push({ note: row, files: await filesForNote(row.id) });
  return out;
}

export async function deleteNote(id: string, ctx: NoteCtx): Promise<void> {
  if (!ctx.actorId) throw new NoteError('unauthenticated');
  const existing = await db.query.staffNotes.findFirst({ where: eq(staffNotes.id, id) });
  if (!existing) throw new NoteError('not_found');
  refuseUnlessOwn(existing, ctx);

  const files = await filesForNote(id);
  // Files first, note row LAST, one at a time, no transaction: a crash then
  // leaves a note with fewer parts — visible, and fixable from the screen —
  // rather than bytes nothing lists and no sweeper reaches (#285's shape).
  for (const file of files) await purgeAttachment(file.attachmentId);
  await db.delete(staffNotes).where(eq(staffNotes.id, id));
  await writeAudit(db, ctx, {
    entityType: 'staff_note',
    entityId: id,
    action: 'delete',
    before: { title: existing.title, shared: existing.userId === null },
  });
}

/**
 * Telegram's own id for these bytes, remembered after a successful send, and
 * forgotten the moment Telegram says it does not know it.
 */
/**
 * Telegram's id for a part's bytes — kept only when it is of the shape the
 * part is SENT as (review FR1-5 / ALB-1). An album's photo-shape repair sends
 * the group as documents without persisting the downgrade (the culprit is
 * unknown), and its answers are document ids: written onto parts still
 * `photo`, they replaced every good member's photo id with one `cachedFileId`
 * never offers again, and a stale one was offered to the next documents retry
 * with nothing left to repair it. In the WHERE, so a part flipped to the other
 * shape between the send and this write keeps its own cache too.
 */
export async function rememberFileId(
  partId: string,
  fileId: string,
  sentAs: 'photo' | 'document',
): Promise<void> {
  await db
    .update(staffNoteParts)
    .set({ telegramFileId: fileId, telegramSentAs: sentAs })
    .where(and(eq(staffNoteParts.id, partId), eq(staffNoteParts.sendAs, sentAs)));
}

export async function forgetFileId(partId: string): Promise<void> {
  await db
    .update(staffNoteParts)
    .set({ telegramFileId: null, telegramSentAs: null })
    .where(eq(staffNoteParts.id, partId));
}

/** A dimension refusal is a fact about the FILE; the next tap must not repeat it. */
export async function downgradeToDocument(partId: string): Promise<void> {
  await db
    .update(staffNoteParts)
    .set({ sendAs: 'document', telegramFileId: null, telegramSentAs: null })
    .where(eq(staffNoteParts.id, partId));
}

/**
 * «ushani soraganda berishi kerak» — his own word. A staff member who types
 * the note's name gets the note, for one indexed query, instead of falling
 * through the free lookup into the paid model, which cannot see this table and
 * would answer «topilmadi» having spent a question out of the daily cap.
 */
export async function notesByTitle(actorId: string, text: string): Promise<NoteRow[]> {
  const needle = text.trim().toLowerCase();
  if (needle.length < 3) return [];
  const rows = await db
    .select()
    .from(staffNotes)
    .where(
      and(
        visibleNotes(actorId),
        sql`lower(btrim(${staffNotes.title})) LIKE ${'%' + needle.replace(/[%_\\]/g, '\\$&') + '%'}`,
      ),
    )
    .orderBy(asc(staffNotes.sortOrder), asc(staffNotes.title))
    .limit(5);
  return rows.map((row) => ({ ...row, shared: row.userId === null, partCount: 0 }));
}

/** The one string, baked into every storage key for the life of the data. */
export const NOTE_ENTITY_TYPE = 'staff_note';
