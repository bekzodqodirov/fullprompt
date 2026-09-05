import 'dotenv/config';
import { randomUUID } from 'node:crypto';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { asc, eq, like } from 'drizzle-orm';
import { db, pgClient } from '@/modules/platform/db/client';
import { attachments, roles, staffNotes, userRoles, users } from '@/modules/platform/db/schema';
import { saveAttachment } from '@/modules/platform/files/service';
import {
  MAX_NOTE_PARTS,
  NOTE_ENTITY_TYPE,
  NoteError,
  deleteNote,
  filesForNote,
  listNotes,
  noteWithFiles,
  notesByTitle,
  removeNotePart,
  saveNote,
  setNoteShared,
} from '@/modules/platform/notes/service';

/**
 * Zametkalar — the two rules a screen cannot enforce, and the ones a bot
 * cannot be made to demonstrate at all.
 *
 * Publishing to the COMPANY needs the permission (the checkbox is a request);
 * a personal note belongs to one person and is invisible to everybody else,
 * INCLUDING the admin; and the bot's list and the screen's list are the same
 * function, so «who sees what» cannot drift between the two doors (#513).
 */

const SUFFIX = String(Date.now()).slice(-7);
let counter = 0;
// Date.now() is not unique within a run (#598): a file that finishes in
// milliseconds mints colliding fixtures.
const stamp = () => `${SUFFIX}-${(counter += 1)}`;

let adminId = '';
let otherId = '';

const ctx = (actorId: string, canShare: boolean) => ({
  actorId,
  ip: null,
  userAgent: null,
  canShare,
});

const input = (title: string, over: Record<string, unknown> = {}) => ({
  id: randomUUID(),
  title,
  body: 'Manzil: Yiwu',
  location: '',
  placeTitle: '',
  placeAddress: '',
  shared: false,
  sortOrder: 100,
  ...over,
});

beforeAll(async () => {
  const admins = await db
    .select({ id: users.id })
    .from(users)
    .innerJoin(userRoles, eq(userRoles.userId, users.id))
    .innerJoin(roles, eq(roles.id, userRoles.roleId))
    .where(eq(roles.code, 'super_admin'))
    .limit(1);
  adminId = admins[0]!.id;
  const staff = await db.select({ id: users.id }).from(users).orderBy(asc(users.createdAt));
  otherId = staff.find((row) => row.id !== adminId)!.id;
});

afterAll(async () => {
  // A note is CONFIGURATION while it exists (#183): a COMPANY one appears in
  // every colleague's bot list and on every later spec's screen.
  //
  // Swept by TITLE, never by the ids this file collected: half of these cases
  // assert a REFUSAL, and red-proving one (#166) runs the file with the guard
  // stripped — at which moment the call succeeds, the id is never recorded,
  // and the row it should have refused survives into every later run.
  const left = await db
    .select({ id: staffNotes.id })
    .from(staffNotes)
    .where(like(staffNotes.title, `%${SUFFIX}%`));
  for (const row of left) {
    // The parts go with them, and so do the objects: a note owns bytes.
    const files = await filesForNote(row.id);
    for (const file of files) await db.delete(attachments).where(eq(attachments.id, file.attachmentId));
  }
  await db.delete(staffNotes).where(like(staffNotes.title, `%${SUFFIX}%`));
  await pgClient.end();
});

describe('publishing to the company', () => {
  it('is refused without the permission — the checkbox is a request', async () => {
    await expect(
      saveNote(input(`Umumiy ${stamp()}`, { shared: true }), ctx(otherId, false)),
    ).rejects.toMatchObject({ code: 'forbidden' });
  });

  it('is written when the permission is held', async () => {
    const title = `Umumiy ${stamp()}`;
    const { id } = await saveNote(input(title, { shared: true }), ctx(adminId, true));
    const row = await db.query.staffNotes.findFirst({ where: eq(staffNotes.id, id) });
    expect(row?.userId).toBeNull();
  });
});

describe('who sees what', () => {
  it('a personal note is invisible to everybody else, admin included', async () => {
    const title = `Shaxsiy ${stamp()}`;
    await saveNote(input(title), ctx(otherId, false));
    expect((await listNotes(otherId)).map((n) => n.title)).toContain(title);
    expect((await listNotes(adminId)).map((n) => n.title)).not.toContain(title);
  });

  it('a company note is offered to both', async () => {
    const title = `Hammaga ${stamp()}`;
    await saveNote(input(title, { shared: true }), ctx(adminId, true));
    expect((await listNotes(otherId)).map((n) => n.title)).toContain(title);
    expect((await listNotes(adminId)).map((n) => n.title)).toContain(title);
  });

  it('the SEND re-asks the same question — a stale button cannot serve a note', async () => {
    // An inline keyboard is permanent chat history: a button tapped a week
    // later can name a note that has since moved out of this person's sight.
    const { id } = await saveNote(input(`Shaxsiy ${stamp()}`), ctx(otherId, false));
    expect(await noteWithFiles(id, otherId)).not.toBeNull();
    expect(await noteWithFiles(id, adminId)).toBeNull();
  });

  it('a deleted note answers the tap with «not found», never with silence', async () => {
    const { id } = await saveNote(input(`O‘chgan ${stamp()}`), ctx(otherId, false));
    await deleteNote(id, ctx(otherId, false));
    expect(await noteWithFiles(id, otherId)).toBeNull();
  });

  it('the typed-name lookup obeys the same rule', async () => {
    const mine = `Qidiruv shaxsiy ${stamp()}`;
    await saveNote(input(mine), ctx(otherId, false));
    expect((await notesByTitle(otherId, 'Qidiruv shaxsiy')).map((n) => n.title)).toContain(mine);
    expect((await notesByTitle(adminId, 'Qidiruv shaxsiy')).map((n) => n.title)).not.toContain(mine);
  });
});

describe('whose note it is', () => {
  it('editing somebody else’s is a refusal, not a correction', async () => {
    const { id } = await saveNote(input(`Begona ${stamp()}`), ctx(otherId, false));
    await expect(
      saveNote({ ...input(`Begona o‘zgargan ${stamp()}`), id }, ctx(adminId, true)),
    ).rejects.toMatchObject({ code: 'forbidden' });
  });

  it('deleting somebody else’s is a refusal', async () => {
    const { id } = await saveNote(input(`Begona 2 ${stamp()}`), ctx(otherId, false));
    await expect(deleteNote(id, ctx(adminId, true))).rejects.toMatchObject({ code: 'forbidden' });
  });

  it('moving a note between the lists is its own act, and needs the permission', async () => {
    const title = `Ko‘chirish ${stamp()}`;
    const { id } = await saveNote(input(title, { shared: true }), ctx(adminId, true));
    await expect(setNoteShared(id, false, ctx(otherId, false))).rejects.toMatchObject({
      code: 'forbidden',
    });
    await setNoteShared(id, false, ctx(adminId, true));
    const row = await db.query.staffNotes.findFirst({ where: eq(staffNotes.id, id) });
    expect(row?.userId).toBe(adminId);
    await setNoteShared(id, true, ctx(adminId, true));
    expect(
      (await db.query.staffNotes.findFirst({ where: eq(staffNotes.id, id) }))?.userId,
    ).toBeNull();
  });

  it('an edit does NOT quietly convert a company note into a personal one', async () => {
    // The precedent recomputes the owner from the checkbox on every save, so
    // an admin editing a COMPANY note with the box unticked silently turns it
    // into their own — and the whole company loses the address sheet.
    const title = `Qolsin ${stamp()}`;
    const { id } = await saveNote(input(title, { shared: true }), ctx(adminId, true));
    await saveNote({ ...input(title, { shared: false }), id, body: 'yangi matn' }, ctx(adminId, true));
    const row = await db.query.staffNotes.findFirst({ where: eq(staffNotes.id, id) });
    expect(row?.body).toBe('yangi matn');
    expect(row?.userId, 'a company note kept its scope').toBeNull();
  });
});

describe('what a note must carry', () => {
  it('an empty note is refused, and no row is left behind', async () => {
    const one = input(`Bo‘sh ${stamp()}`, { body: '' });
    await expect(saveNote(one, ctx(otherId, false))).rejects.toMatchObject({ code: 'note_empty' });
    expect(await db.query.staffNotes.findFirst({ where: eq(staffNotes.id, one.id) })).toBeUndefined();
  });

  it('two notes with one name in the same list is a trap, and is refused in words', async () => {
    const title = `Bir xil ${stamp()}`;
    await saveNote(input(title), ctx(otherId, false));
    await expect(saveNote(input(title), ctx(otherId, false))).rejects.toMatchObject({
      code: 'title_taken',
    });
  });

  it('but an admin publishing the same name does not break a colleague’s own row', async () => {
    // The two scopes are policed separately on purpose; the bot marks the
    // company's with 🏢 where they meet.
    const title = `Ikki doira ${stamp()}`;
    await saveNote(input(title), ctx(otherId, false));
    const { id } = await saveNote(input(title, { shared: true }), ctx(adminId, true));
    expect(id).toBeTruthy();
  });

  it('a location that is not a location is a sentence, not a 23514', async () => {
    await expect(
      saveNote(input(`Yomon nuqta ${stamp()}`, { location: 'sklad yonida' }), ctx(otherId, false)),
    ).rejects.toMatchObject({ code: 'bad_location' });
  });

  it('a place NAME with no address is refused — sendVenue needs both', async () => {
    await expect(
      saveNote(
        input(`Yarim joy ${stamp()}`, { location: '41.31, 69.24', placeTitle: 'Ombor' }),
        ctx(otherId, false),
      ),
    ).rejects.toMatchObject({ code: 'validation' });
  });
});

describe('the parts', () => {
  const attach = async (noteId: string, name: string) =>
    saveAttachment(
      {
        entityType: NOTE_ENTITY_TYPE,
        entityId: noteId,
        fileName: name,
        contentType: 'image/jpeg',
        body: Buffer.from('itest note bytes'),
        uploadedBy: otherId,
      },
      { thumbnails: 'skip' },
    );

  it('an upload pre-bound to the note becomes a part on save', async () => {
    const one = input(`Fayl bilan ${stamp()}`);
    await attach(one.id, 'sklad.jpg');
    const saved = await saveNote(one, ctx(otherId, false));
    expect(saved.parts).toBe(1);
    const files = await filesForNote(one.id);
    expect(files[0]!.fileName).toBe('sklad.jpg');
    expect(files[0]!.sendAs).toBe('photo');
  });

  it('a note that is ONLY a file is a real note', async () => {
    const one = input(`Faqat rasm ${stamp()}`, { body: '' });
    await attach(one.id, 'faqat.jpg');
    const saved = await saveNote(one, ctx(otherId, false));
    expect(saved.parts).toBe(1);
  });

  it('the ceiling bites in words rather than at send time in a warehouse', async () => {
    const one = input(`Ko‘p fayl ${stamp()}`);
    for (let i = 0; i <= MAX_NOTE_PARTS; i += 1) await attach(one.id, `f${i}.jpg`);
    await expect(saveNote(one, ctx(otherId, false))).rejects.toMatchObject({
      code: 'too_many_parts',
    });
  });

  it('a part can be removed without destroying the note', async () => {
    const one = input(`Almashtirish ${stamp()}`);
    await attach(one.id, 'eski.jpg');
    await saveNote(one, ctx(otherId, false));
    const [part] = await filesForNote(one.id);
    await removeNotePart(part!.partId, ctx(otherId, false));
    expect(await filesForNote(one.id)).toHaveLength(0);
    expect(await db.query.staffNotes.findFirst({ where: eq(staffNotes.id, one.id) })).toBeTruthy();
  });

  it('removing the LAST thing a note has is refused — it would send nothing', async () => {
    const one = input(`Oxirgi qism ${stamp()}`, { body: '' });
    await attach(one.id, 'yagona.jpg');
    await saveNote(one, ctx(otherId, false));
    const [part] = await filesForNote(one.id);
    await expect(removeNotePart(part!.partId, ctx(otherId, false))).rejects.toBeInstanceOf(NoteError);
  });

  it('deleting the note takes its attachment rows with it', async () => {
    const one = input(`O‘chirish ${stamp()}`);
    const { id: attachmentId } = await attach(one.id, 'ketadi.jpg');
    await saveNote(one, ctx(otherId, false));
    await deleteNote(one.id, ctx(otherId, false));
    expect(
      await db.query.attachments.findFirst({ where: eq(attachments.id, attachmentId) }),
    ).toBeUndefined();
  });
});
