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
    // The message the file came in rides on the file (spec-1 of K's review):
    // a press and an album part key the attachment by it, not by the update.
    expect(fileOf({ message_id: 31, photo: [{ file_id: 'x' }] })).toEqual({ fileId: 'x', isPhoto: true, messageId: 31 });
    const part = { messageId: 5, kind: 'photo' as const, file: { fileId: 'p', name: null, mime: null, size: 1 } };
    expect(fileOf(part)).toEqual({ fileId: 'p', isPhoto: true, fileName: undefined, mime: undefined, messageId: 5 });
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

  it('a PRESS saving the file it replies to, or an album part, keys by that file’s message — twice is one row', async () => {
    // The add door's `cf:` press (P4, §2.4/§9.2): `saveIntakeFile(ctx, note,
    // staff, fileOf(part))` on a callback, whose update carries no message.
    // The id used to be read off `ctx.message` alone, so here it was minted at
    // random and a re-run stored the file twice (K's review, spec-1).
    const body = await jpeg();
    vi.stubGlobal(
      'fetch',
      vi.fn(async () => new Response(new Uint8Array(body), { status: 200 })),
    );
    const noteId = uuidv4();
    notes.push(noteId);
    const pressCtx = {};
    const part = { messageId: 777, kind: 'photo' as const, file: { fileId: 'AgAD-part', name: null, mime: null, size: 1 } };
    getFileCalls = 0;
    const first = await saveIntakeFile(pressCtx, noteId, staffId, fileOf(part));
    const again = await saveIntakeFile(pressCtx, noteId, staffId, fileOf(part));
    expect(again?.attachmentId).toBe(first?.attachmentId);
    expect(getFileCalls, 'the re-run downloads nothing').toBe(1);
    const replied = await saveIntakeFile(pressCtx, noteId, staffId, fileOf({ message_id: 778, document: { file_id: 'BQAD', file_name: 'a.xlsx' } }));
    const rows = await db.select({ id: attachments.id }).from(attachments).where(eq(attachments.entityId, noteId));
    expect(rows.map((r) => r.id).sort()).toEqual([first!.attachmentId, replied!.attachmentId].sort());
  });

  it('a refused getFile is said in the log and stores nothing; a short 429 is waited out', async () => {
    const noteId = uuidv4();
    notes.push(noteId);
    const { logger } = await import('@/modules/platform/logger');
    const warn = vi.spyOn(logger, 'warn');
    __setTelegramTransport(async () =>
      new Response(JSON.stringify({ ok: false, error_code: 400, description: 'Bad Request: file is too big' }), { status: 400 }),
    );
    try {
      const out = await saveIntakeFile({ message: { message_id: 5001, document: { file_id: 'big' } } }, noteId, staffId);
      expect(out).toBeNull();
      expect(warn.mock.calls.some((c) => c[1] === '[bot-file] getFile refused')).toBe(true);
      // …and a 429 asking for a second is waited out, as grammy's briefRetry did.
      let calls = 0;
      const body = await jpeg();
      vi.stubGlobal(
        'fetch',
        vi.fn(async () => new Response(new Uint8Array(body), { status: 200 })),
      );
      __setTelegramTransport(async () => {
        calls += 1;
        return calls === 1
          ? new Response(JSON.stringify({ ok: false, error_code: 429, description: 'Too Many Requests', parameters: { retry_after: 1 } }), { status: 429 })
          : new Response(JSON.stringify({ ok: true, result: { file_path: 'photos/file_2.jpg' } }), { status: 200 });
      });
      const saved = await saveIntakeFile({ message: { message_id: 5002, photo: [{ file_id: 'AgAD-429' }] } }, noteId, staffId);
      expect(calls).toBe(2);
      expect(saved?.isPhoto).toBe(true);
    } finally {
      warn.mockRestore();
      __setTelegramTransport(async (url) => {
        if (url.endsWith('/getFile')) getFileCalls += 1;
        return new Response(JSON.stringify({ ok: true, result: { file_path: 'photos/file_1.jpg' } }), { status: 200 });
      });
    }
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
    // The deadline is the whole load's: a file whose turn comes after it is
    // counted, never read (K's review, U2) — one past it reads nothing.
    const late = await loadIntakeFiles(
      { ...state, images: [{ attachmentId: image.id, mediaType: 'image/jpeg' }], pdfs: [{ attachmentId: pdf.id, name: 'B.pdf', bytes: pdfBody.length }] },
      { deadline: Date.now() - 1 },
    );
    expect(late).toEqual({ images: [], pdfs: [], missing: 2 });
  });
});
