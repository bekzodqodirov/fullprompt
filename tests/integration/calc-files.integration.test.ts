import 'dotenv/config';
import { eq, inArray } from 'drizzle-orm';
import { afterAll, afterEach, beforeAll, describe, expect, it, vi } from 'vitest';
import { v4 as uuidv4 } from 'uuid';
import { db, pgClient } from '@/modules/platform/db/client';
import { attachments, users } from '@/modules/platform/db/schema';
import { getStorage } from '@/modules/platform/files/storage';
import { __setTelegramTransport } from '@/modules/platform/telegram/send';
import { startIntake, endIntake } from '@/modules/platform/telegram/calc-store';
import { fileOf, loadIntakeFiles, saveIntakeFile } from '@/modules/platform/telegram/calc-files';

/**
 * The collector's files since K (docs/SAKKIZ-R3.md K4/K5): the collection
 * keeps attachment IDS and never the bytes, the id is the Telegram message's
 * (so a message applied twice is one attachment, and the second time nothing
 * is downloaded), and the reading loads the bytes back from storage, counting
 * what storage no longer has instead of throwing.
 */
const STAMP = String(Date.now()).slice(-7);
let staffId = '';
const notes: string[] = [];
const chats: bigint[] = [];
let getFileCalls = 0;

const jpeg = async () => {
  const sharp = (await import('sharp')).default;
  return sharp({ create: { width: 12, height: 8, channels: 3, background: '#e0e0e0' } }).jpeg().toBuffer();
};

beforeAll(async () => {
  const [user] = await db
    .insert(users)
    .values({ phone: `+99897${STAMP}`, fullName: `Calc files ${STAMP}`, passwordHash: 'x', locale: 'uz', active: true })
    .returning({ id: users.id });
  staffId = user!.id;
  process.env.TELEGRAM_BOT_TOKEN = 'calc-files-test-token';
  __setTelegramTransport(async (url) => {
    if (url.endsWith('/getFile')) getFileCalls += 1;
    return new Response(JSON.stringify({ ok: true, result: { file_path: 'photos/file_1.jpg' } }), { status: 200 });
  });
});

afterEach(() => {
  vi.unstubAllGlobals();
  for (const chat of chats.splice(0)) endIntake(chat);
});

afterAll(async () => {
  __setTelegramTransport(null);
  delete process.env.TELEGRAM_BOT_TOKEN;
  if (notes.length) {
    const rows = await db
      .select({ storageKey: attachments.storageKey })
      .from(attachments)
      .where(inArray(attachments.entityId, notes));
    for (const row of rows) await getStorage().delete(row.storageKey).catch(() => {});
    await db.delete(attachments).where(inArray(attachments.entityId, notes));
  }
  if (staffId) await db.delete(users).where(eq(users.id, staffId));
  await pgClient.end();
});

describe('fileOf — the file a message or an album part carries', () => {
  it('a message’s LARGEST photo, else its document; an album part by its kind; nothing for a voice', () => {
    expect(fileOf({ photo: [{ file_id: 'small' }, { file_id: 'big' }] })).toEqual({ fileId: 'big', isPhoto: true });
    expect(fileOf({ document: { file_id: 'doc', file_name: 'A.xlsx', mime_type: 'application/x' } })).toEqual({
      fileId: 'doc',
      isPhoto: false,
      fileName: 'A.xlsx',
      mime: 'application/x',
    });
    expect(fileOf({})).toBeNull();
    const part = { messageId: 5, kind: 'photo' as const, file: { fileId: 'p', name: null, mime: null, size: 1 } };
    expect(fileOf(part)).toEqual({ fileId: 'p', isPhoto: true, fileName: undefined, mime: undefined });
    expect(fileOf({ ...part, kind: 'voice' })).toBeNull();
    expect(fileOf({ ...part, file: null })).toBeNull();
  });
});

describe('an intake file is the MESSAGE’s attachment (durability-1)', () => {
  it('the same message stored twice is one row, and the second time Telegram is asked nothing', async () => {
    const body = await jpeg();
    vi.stubGlobal(
      'fetch',
      vi.fn(async () => new Response(new Uint8Array(body), { status: 200 })),
    );
    const noteId = uuidv4();
    notes.push(noteId);
    const ctx = { message: { message_id: 4242, photo: [{ file_id: 'AgAD-photo' }] } };
    getFileCalls = 0;
    const first = await saveIntakeFile(ctx, noteId, staffId);
    expect(first?.isPhoto).toBe(true);
    expect(getFileCalls).toBe(1);
    const again = await saveIntakeFile(ctx, noteId, staffId);
    expect(again?.attachmentId).toBe(first?.attachmentId);
    expect(again?.body.equals(body)).toBe(true);
    expect(getFileCalls, 'a redone message downloads nothing').toBe(1);
    const rows = await db.select({ id: attachments.id }).from(attachments).where(eq(attachments.entityId, noteId));
    expect(rows.map((r) => r.id)).toEqual([first!.attachmentId]);
    // Another message of the same collection is another attachment.
    const other = await saveIntakeFile({ message: { message_id: 4243, photo: [{ file_id: 'AgAD-2' }] } }, noteId, staffId);
    expect(other?.attachmentId).not.toBe(first?.attachmentId);
  });
});

describe('the reading loads the bytes from storage (K5)', () => {
  it('images and PDFs by id; what storage lacks, or an id that cannot be a row, is counted missing', async () => {
    const noteId = uuidv4();
    notes.push(noteId);
    const { saveAttachment } = await import('@/modules/platform/files/service');
    const image = await saveAttachment(
      { entityType: 'crm_activity', entityId: noteId, fileName: 'a.jpg', contentType: 'image/jpeg', body: await jpeg(), uploadedBy: staffId },
      { thumbnails: 'skip' },
    );
    const pdfBody = Buffer.from('%PDF-1.4 test');
    const pdf = await saveAttachment(
      { entityType: 'crm_activity', entityId: noteId, fileName: 'B.pdf', contentType: 'application/pdf', body: pdfBody, uploadedBy: staffId },
      { thumbnails: 'skip' },
    );
    const chat = BigInt(-7_400_000_000) - BigInt(STAMP);
    chats.push(chat);
    const state = startIntake(chat, 'rastamojka', { staffId });
    const files = await loadIntakeFiles(
      {
        ...state,
        images: [
          { attachmentId: image.id, mediaType: 'image/jpeg' },
          { attachmentId: uuidv4(), mediaType: 'image/jpeg' },
        ],
        pdfs: [
          { attachmentId: pdf.id, name: 'B.pdf', bytes: pdfBody.length },
          { attachmentId: 'not-a-row', name: 'C.pdf', bytes: 3 },
        ],
      },
      { deadline: Date.now() + 30_000 },
    );
    expect(files.images).toHaveLength(1);
    expect(files.images[0]!.mediaType).toBe('image/jpeg');
    expect(files.pdfs).toEqual([{ data: pdfBody, name: 'B.pdf' }]);
    expect(files.missing).toBe(2);
    // A collection of text alone reads nothing at all.
    expect(await loadIntakeFiles(state, { deadline: Date.now() })).toEqual({ images: [], pdfs: [], missing: 0 });
  });
});
