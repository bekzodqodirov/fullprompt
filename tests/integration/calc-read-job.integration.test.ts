import 'dotenv/config';
import { eq, inArray } from 'drizzle-orm';
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
import { v4 as uuidv4 } from 'uuid';

/**
 * The reading as a pg-boss job (docs/SAKKIZ-R3.md §7.2.4): it loads the
 * collection (waiting for this process's hydrate), reads the stored files
 * under one budget, calls the model on a leash cut to what is left of the
 * wall clock, settles against the LIVE collection, STORES its reply and only
 * then sends it — and every way it can be run twice (a retry after a failed
 * send, pg-boss's expiry race, a flood wait) sends the stored reply without
 * a second model call.
 *
 * The model, pg-boss and Telegram are stand-ins; storage and the attachments
 * table are real. The store's two P1 answers (a sealed or failed write, the
 * hydrate wait) are played by a thin wrapper over the real calc-store.
 */
const model = vi.hoisted(() => ({ analyze: vi.fn() }));
vi.mock('@/modules/wms/calc/intake-ai', async (importOriginal) => ({
  ...(await importOriginal<typeof import('@/modules/wms/calc/intake-ai')>()),
  analyzeIntake: model.analyze,
}));
// The bill is intake-billing's subject; here it must only not stand in the way.
vi.mock('@/modules/wms/calc/ai-cost', () => ({ aiCalcBudgetLeft: async () => 100, recordAiPass: async () => {} }));
vi.mock('@/modules/platform/jobs/boss', async (importOriginal) =>
  (await import('../fixtures/calc-read-drive')).bossForReading(await importOriginal()),
);
const store = vi.hoisted(() => ({
  /** A sealed store, or a write that failed, answers false (P1). */
  flushAnswer: true,
  /** P1's `loadIntake`, played: wait for the hydrate, or throw `IntakesNotReady`. */
  load: null as null | ((chatId: bigint) => Promise<unknown>),
}));
vi.mock('@/modules/platform/telegram/calc-store', async (importOriginal) => {
  const real = await importOriginal<typeof import('@/modules/platform/telegram/calc-store')>();
  return {
    ...real,
    flushIntakeWrites: async (chatId?: bigint) => (store.flushAnswer ? real.flushIntakeWrites(chatId) : false),
    loadIntake: async (chatId: bigint) => (store.load ? store.load(chatId) : real.loadIntake(chatId)),
  };
});
const files = vi.hoisted(() => ({ before: null as null | (() => void), throwNext: false }));
vi.mock('@/modules/platform/telegram/calc-files', async (importOriginal) => {
  const real = await importOriginal<typeof import('@/modules/platform/telegram/calc-files')>();
  return {
    ...real,
    loadIntakeFiles: async (...args: Parameters<typeof real.loadIntakeFiles>) => {
      files.before?.();
      if (files.throwNext) {
        files.throwNext = false;
        throw new Error('attachments unreadable (test)');
      }
      return real.loadIntakeFiles(...args);
    },
  };
});
// One read's deadline, short, so a storage get that never answers costs the
// test a second rather than half a minute; the deadline itself stays real.
vi.mock('@/modules/platform/files/read-within', async (importOriginal) => ({
  ...(await importOriginal<typeof import('@/modules/platform/files/read-within')>()),
  PHOTO_READ_MS: 300,
}));
const sharpCalls = vi.hoisted(() => ({ n: 0 }));
vi.mock('sharp', async (importOriginal) => {
  const real = (await importOriginal<{ default: (...a: unknown[]) => unknown }>()).default;
  const counted = Object.assign((...a: unknown[]) => {
    sharpCalls.n += 1;
    return real(...a);
  }, real);
  return { default: counted };
});

import { db, pgClient } from '@/modules/platform/db/client';
import { attachments, users } from '@/modules/platform/db/schema';
import { getStorage } from '@/modules/platform/files/storage';
import { __setTelegramTransport } from '@/modules/platform/telegram/send';
import { activeIntake, endIntake, startIntake, updateIntake, type IntakeState } from '@/modules/platform/telegram/calc-intake';
import { IntakesNotReady, setDurableIntakes } from '@/modules/platform/telegram/calc-store';
import { modelCopyKey, readIntakeFile, reduceForModel, storeModelCopy } from '@/modules/platform/telegram/calc-files';
import {
  INTAKE_READ_RETRY,
  deliverStoredReply,
  pendingDeliveryAlive,
  readingAlive,
  releaseDeadReading,
  runIntakeRead,
  type IntakeReadJob,
} from '@/modules/platform/telegram/calc-read';
import { handleCalcCallback } from '@/modules/platform/telegram/staff-handlers';
import { readingsEnqueued, resetReadingDrive, setReadJobState } from '../fixtures/calc-read-drive';

const STAMP = String(Date.now()).slice(-7);
let staffId = '';
const notes: string[] = [];
const chats: bigint[] = [];
let seq = 0;

const READ = (goods = [{ name: 'Kurtka', quantity: 300, weightKg: 150 }]) => ({
  ok: true,
  facts: { fromCity: null, toCity: null, weightKg: 150, volumeM3: 1, goods },
  steps: [],
  usage: { model: 'm', inputTokens: 1, outputTokens: 1 },
  answered: [{ model: 'm', inputTokens: 1, outputTokens: 1, at: Date.now() }],
});
const FAILED = 'Tahlil qilib bo‘lmadi. «Bo‘ldi» ni qayta bosing.';
const MISSING = '⚠️ 1 ta fayl o‘qilmadi — saqlangan joydan olib bo‘lmadi. Kerak bo‘lsa qayta yuboring.';

/** Telegram, scripted: every answer `ok` unless the script says otherwise for the next call. */
const tg = {
  sent: [] as { text: string; markup: unknown }[],
  edits: [] as { messageId: number; text: string }[],
  script: [] as ((method: string) => Response | null)[],
  id: 500,
};
const json = (status: number, body: unknown) =>
  new Response(JSON.stringify(body), { status, headers: { 'content-type': 'application/json' } });

const ctx = { reply: async () => ({ message_id: 41 }) };

/** A collection pressed «Bo‘ldi» on: the job's payload, as the press enqueued it. */
async function pressed(patch: Partial<IntakeState> = {}): Promise<{ chatId: bigint; job: IntakeReadJob }> {
  seq += 1;
  const chatId = BigInt(-7_700_000_000) - BigInt(STAMP) * 100n - BigInt(seq);
  chats.push(chatId);
  const { noteId } = startIntake(chatId, 'rastamojka', { staffId });
  notes.push(noteId);
  updateIntake(chatId, { stage: 'material', clientHintRaw: 'GS777', material: ['Kurtka 300 dona 150 kg'], ...patch });
  await handleCalcCallback(ctx, chatId, 'done');
  const job = readingsEnqueued(chatId).at(-1)?.data;
  expect(job, 'the press enqueued the reading').toBeTruthy();
  return { chatId, job: job! };
}

async function photo(noteId: string): Promise<{ id: string; storageKey: string; body: Buffer }> {
  const sharp = (await import('sharp')).default;
  const body = await sharp({ create: { width: 24, height: 16, channels: 3, background: '#d0d0d0' } }).jpeg().toBuffer();
  const { saveAttachment } = await import('@/modules/platform/files/service');
  const saved = await saveAttachment(
    { entityType: 'crm_activity', entityId: noteId, fileName: 'p.jpg', contentType: 'image/jpeg', body, uploadedBy: staffId },
    { thumbnails: 'skip' },
  );
  const [row] = await db.select({ storageKey: attachments.storageKey }).from(attachments).where(eq(attachments.id, saved.id));
  return { id: saved.id, storageKey: row!.storageKey, body };
}

const realNow = Date.now.bind(Date);

beforeAll(async () => {
  const [user] = await db
    .insert(users)
    .values({ phone: `+99896${STAMP}`, fullName: `Calc read job ${STAMP}`, passwordHash: 'x', locale: 'uz', active: true })
    .returning({ id: users.id });
  staffId = user!.id;
  process.env.TELEGRAM_BOT_TOKEN = 'calc-read-job-token';
});

beforeEach(() => {
  resetReadingDrive();
  model.analyze.mockReset();
  model.analyze.mockResolvedValue(READ());
  store.flushAnswer = true;
  store.load = null;
  files.before = null;
  files.throwNext = false;
  sharpCalls.n = 0;
  tg.sent.length = 0;
  tg.edits.length = 0;
  tg.script.length = 0;
  tg.id = 500;
  __setTelegramTransport(async (url, init) => {
    const method = url.slice(url.lastIndexOf('/') + 1);
    const scripted = tg.script.shift()?.(method) ?? null;
    if (scripted) return scripted;
    const body = JSON.parse(String(init.body ?? '{}')) as Record<string, unknown>;
    if (method === 'sendMessage') {
      tg.sent.push({ text: String(body.text), markup: body.reply_markup ?? null });
      return json(200, { ok: true, result: { message_id: (tg.id += 1) } });
    }
    if (method === 'editMessageText') tg.edits.push({ messageId: Number(body.message_id), text: String(body.text) });
    return json(200, { ok: true, result: true });
  });
});

afterEach(() => {
  vi.restoreAllMocks();
  setDurableIntakes(false);
  for (const id of chats.splice(0)) endIntake(id);
});

afterAll(async () => {
  __setTelegramTransport(null);
  delete process.env.TELEGRAM_BOT_TOKEN;
  if (notes.length) {
    const rows = await db
      .select({ storageKey: attachments.storageKey })
      .from(attachments)
      .where(inArray(attachments.entityId, notes));
    for (const row of rows) {
      await getStorage().delete(row.storageKey).catch(() => {});
      await getStorage().delete(modelCopyKey(row.storageKey)).catch(() => {});
    }
    await db.delete(attachments).where(inArray(attachments.entityId, notes));
  }
  if (staffId) await db.delete(users).where(eq(users.id, staffId));
  await pgClient.end();
});

describe('the job reads, stores, then sends — once', () => {
  it('a normal job: the table sent once, the stored reply cleared, the table’s id kept, the notice pointed down', async () => {
    const { chatId, job } = await pressed();
    await runIntakeRead(job, 0);
    expect(model.analyze).toHaveBeenCalledTimes(1);
    expect(tg.sent).toHaveLength(1);
    expect(JSON.stringify(tg.sent[0]!.markup)).toContain('c:save');
    const live = activeIntake(chatId)!;
    expect(live).toMatchObject({ analysing: null, stage: 'review', pendingReply: null, tableMessageId: 501 });
    expect(live.tableHash).toEqual(expect.any(String));
    expect(live.ownMessageIds).toContain(501);
    expect(job.noticeMessageId).toBe(41);
    await vi.waitFor(() => expect(tg.edits).toEqual([{ messageId: 41, text: '✅ O‘qildi — natija pastda ⬇️' }]));
  });

  it('a token that is not the collection’s: nothing sent, no model call', async () => {
    const { job } = await pressed();
    await runIntakeRead({ ...job, token: 'somebody-else' }, 0);
    expect(model.analyze).not.toHaveBeenCalled();
    expect(tg.sent).toEqual([]);
  });

  it('the redelivery after the settle sends the STORED reply — the model is not asked again', async () => {
    const { chatId, job } = await pressed();
    tg.script.push((m) => (m === 'sendMessage' ? json(502, { ok: false, description: 'Bad Gateway' }) : null));
    await expect(runIntakeRead(job, 0)).rejects.toThrow();
    const stored = activeIntake(chatId)!;
    expect(stored.analysing).toBeNull();
    expect(stored.pendingReply?.token).toBe(job.token);
    await runIntakeRead(job, 1);
    expect(model.analyze).toHaveBeenCalledTimes(1);
    expect(tg.sent.map((s) => s.text)).toEqual([stored.pendingReply!.text]);
    expect(activeIntake(chatId)!.pendingReply).toBeNull();
  });

  it('two runs of one token in one process (pg-boss’s expiry race): one model call, one table', async () => {
    const { job } = await pressed();
    let release: () => void = () => {};
    model.analyze.mockImplementationOnce(
      () => new Promise((resolve) => (release = () => resolve(READ()))),
    );
    const first = runIntakeRead(job, 0);
    await vi.waitFor(() => expect(model.analyze).toHaveBeenCalledTimes(1));
    await runIntakeRead(job, 0);
    release();
    await first;
    expect(model.analyze).toHaveBeenCalledTimes(1);
    expect(tg.sent).toHaveLength(1);
  });

  it('material that arrived while it read: the reading is kept and the seller asked to press again', async () => {
    const { chatId, job } = await pressed();
    model.analyze.mockImplementationOnce(async () => {
      updateIntake(chatId, { material: [...activeIntake(chatId)!.material, 'Shim 20 dona'] });
      return READ();
    });
    await runIntakeRead(job, 0);
    expect(tg.sent.map((s) => s.text)).toEqual([
      'Tahlil paytida yana 1 ta xabar/fayl keldi — ular hali o‘qilmagan.\n' +
        'Hammasini birga o‘qish uchun «Bo‘ldi» ni yana bosing.',
    ]);
    expect(JSON.stringify(tg.sent[0]!.markup)).toContain('c:done');
    const live = activeIntake(chatId)!;
    expect(live).toMatchObject({ stage: 'material', analysing: null, pendingReply: null });
    // The «arrived» words are not the table: no answer will ever edit them.
    expect(live.tableMessageId).toBeNull();
  });
});

describe('the wall clock (§7.2.1)', () => {
  it('a storage get that never answers is counted within the file budget, and SAID', async () => {
    const { chatId, job } = await pressed();
    const { id, storageKey } = await photo(activeIntake(chatId)!.noteId);
    updateIntake(chatId, { images: [{ attachmentId: id, mediaType: 'image/jpeg' }], fileCount: 1 });
    const storage = getStorage();
    const real = storage.get.bind(storage);
    vi.spyOn(storage, 'get').mockImplementation((key: string) =>
      key.startsWith(storageKey) ? new Promise<Buffer>(() => {}) : real(key),
    );
    const started = realNow();
    await runIntakeRead(job, 0);
    expect(realNow() - started).toBeLessThan(5_000);
    expect(activeIntake(chatId)!.notes).toContain(MISSING);
    expect(tg.sent[0]!.text).toContain(MISSING);
  }, 10_000);

  it('the model’s leash is what is left: 200 s spent → no call, a «timeout» in words; 100 s → at most 120 s', async () => {
    const clock = { offset: 0 };
    vi.spyOn(Date, 'now').mockImplementation(() => realNow() + clock.offset);

    const late = await pressed();
    files.before = () => (clock.offset = 200_000);
    await runIntakeRead(late.job, 0);
    expect(model.analyze).not.toHaveBeenCalled();
    expect(activeIntake(late.chatId)!.aiFailure).toBe('timeout');
    expect(tg.sent.at(-1)!.text).toContain('AI belgilangan vaqtda javob bermadi.');

    clock.offset = 0;
    const slow = await pressed();
    files.before = () => (clock.offset = 100_000);
    await runIntakeRead(slow.job, 0);
    expect(model.analyze).toHaveBeenCalledTimes(1);
    const leash = (model.analyze.mock.calls[0]![0] as { timeoutMs?: number }).timeoutMs!;
    expect(leash).toBeGreaterThanOrEqual(30_000);
    expect(leash).toBeLessThanOrEqual(120_000);
  });
});

describe('a reply is sent only from a durable store (durability-1’s sibling)', () => {
  it('a sealed store: the job throws before sending, and nothing is sent', async () => {
    const { chatId, job } = await pressed();
    setDurableIntakes(true);
    store.flushAnswer = false;
    await expect(runIntakeRead(job, 0)).rejects.toThrow();
    expect(tg.sent).toEqual([]);
    // Kept in memory for the delivery the next process (or this one) makes.
    expect(activeIntake(chatId)!.pendingReply?.token).toBe(job.token);
  });
});

describe('the last attempt (§7.2.4 step 8)', () => {
  it('a failure before any reply was stored: the token released, back to material, «bo‘lmadi» said once', async () => {
    const { chatId, job } = await pressed();
    files.throwNext = true;
    await expect(runIntakeRead(job, INTAKE_READ_RETRY)).resolves.toBeUndefined();
    expect(activeIntake(chatId)).toMatchObject({
      analysing: null,
      analysingAt: null,
      analysingJob: null,
      stage: 'material',
      readingSaidDead: true,
    });
    expect(tg.sent.map((s) => s.text)).toEqual([FAILED]);
    expect(JSON.stringify(tg.sent[0]!.markup)).toContain('c:done');
  });

  it('…an earlier attempt rethrows, for pg-boss to retry, and says nothing', async () => {
    const { chatId, job } = await pressed();
    files.throwNext = true;
    await expect(runIntakeRead(job, 0)).rejects.toThrow('attachments unreadable');
    expect(tg.sent).toEqual([]);
    expect(activeIntake(chatId)!.analysing).toBe(job.token);
  });

  it('a reading that WORKED and only failed to deliver says nothing — the stored reply waits for the sweep', async () => {
    const { chatId, job } = await pressed();
    tg.script.push((m) => (m === 'sendMessage' ? json(502, { ok: false, description: 'Bad Gateway' }) : null));
    await expect(runIntakeRead(job, INTAKE_READ_RETRY)).resolves.toBeUndefined();
    expect(tg.sent).toEqual([]);
    expect(activeIntake(chatId)!.pendingReply?.token).toBe(job.token);
  });
});

describe('a flood wait at delivery (durability-16)', () => {
  it('429 with retry_after 30: ONE delivery-only follow-up at 31 s, nothing thrown, no «bo‘lmadi» — and it sends the stored table, no model', async () => {
    const { chatId, job } = await pressed();
    tg.script.push((m) =>
      m === 'sendMessage'
        ? json(429, { ok: false, description: 'Too Many Requests: retry after 30', parameters: { retry_after: 30 } })
        : null,
    );
    await expect(runIntakeRead(job, 0)).resolves.toBeUndefined();
    const follow = readingsEnqueued(chatId).filter((j) => j.data.deliverOnly);
    expect(follow).toHaveLength(1);
    expect(follow[0]!.options).toMatchObject({ startAfter: 31, expireInSeconds: 300, retryLimit: INTAKE_READ_RETRY });
    expect(follow[0]!.data).toMatchObject({ token: job.token, deliverOnly: true });
    expect(tg.sent).toEqual([]);
    const waiting = activeIntake(chatId)!.pendingReply!;
    expect(waiting.jobId).toBe(follow[0]!.options.id);

    await runIntakeRead(follow[0]!.data, 0);
    expect(model.analyze).toHaveBeenCalledTimes(1);
    expect(tg.sent.map((s) => s.text)).toEqual([waiting.text]);
    expect(activeIntake(chatId)!.pendingReply).toBeNull();
  });
});

describe('a job fetched before this process hydrated (durability-9)', () => {
  /** P1's `loadIntake`: the hydrate is awaited (bounded), then MEMORY — never the table. */
  function hydrateLater(): { hydrate: (fill: () => void) => void } {
    let done: (() => void) | null = null;
    const hydrated = new Promise<void>((resolve) => (done = resolve));
    store.load = async (chatId) => {
      const ok = await Promise.race([hydrated.then(() => true), new Promise<boolean>((r) => setTimeout(() => r(false), 300))]);
      if (!ok) throw new IntakesNotReady();
      return activeIntake(chatId);
    };
    return { hydrate: (fill) => (fill(), done!()) };
  }

  it('it waits; hydrated meanwhile, it proceeds and delivers', async () => {
    const { chatId, job } = await pressed();
    const saved = structuredClone(activeIntake(chatId)!);
    endIntake(chatId);
    const boot = hydrateLater();
    const running = runIntakeRead(job, 0);
    setTimeout(
      () =>
        boot.hydrate(() => {
          startIntake(chatId, saved.section, { staffId });
          updateIntake(chatId, saved);
        }),
      50,
    );
    await running;
    expect(model.analyze).toHaveBeenCalledTimes(1);
    expect(tg.sent).toHaveLength(1);
  });

  it('never hydrated: it throws (pg-boss re-delivers) and sends nothing', async () => {
    const { chatId, job } = await pressed();
    endIntake(chatId);
    hydrateLater();
    await expect(runIntakeRead(job, 0)).rejects.toBeInstanceOf(IntakesNotReady);
    expect(model.analyze).not.toHaveBeenCalled();
    expect(tg.sent).toEqual([]);
  });
});

describe('the sweep’s questions (§7.2.2, §6.2.13)', () => {
  it('a dead job: its token released and «bo‘lmadi» said ONCE — a second sweep says nothing', async () => {
    const { chatId } = await pressed();
    const live = activeIntake(chatId)!;
    expect(await readingAlive(live)).toBe(true);
    setReadJobState(live.analysingJob!, 'failed');
    expect(await readingAlive(live)).toBe(false);
    await releaseDeadReading(chatId, live);
    expect(activeIntake(chatId)).toMatchObject({ analysing: null, stage: 'material', readingSaidDead: true });
    expect(tg.sent.map((s) => s.text)).toEqual([FAILED]);
    await releaseDeadReading(chatId, activeIntake(chatId)!);
    expect(tg.sent).toHaveLength(1);
  });

  it('no such job yet is alive for a minute (the enqueue may still be on its way), then dead', async () => {
    const { chatId } = await pressed();
    const live = activeIntake(chatId)!;
    setReadJobState(live.analysingJob!, null);
    expect(await readingAlive(live)).toBe(true);
    expect(await readingAlive({ ...live, analysingAt: Date.now() - 120_000 })).toBe(false);
  });

  it('a stored reply whose follow-up is dead is sent by the sweep — never the reading again', async () => {
    const { chatId, job } = await pressed();
    tg.script.push((m) =>
      m === 'sendMessage' ? json(429, { ok: false, description: 'Too Many Requests', parameters: { retry_after: 30 } }) : null,
    );
    await runIntakeRead(job, 0);
    const waiting = activeIntake(chatId)!;
    expect(await pendingDeliveryAlive(waiting)).toBe(true);
    setReadJobState(waiting.pendingReply!.jobId!, 'failed');
    expect(await pendingDeliveryAlive(waiting)).toBe(false);
    await deliverStoredReply(chatId, waiting);
    expect(tg.sent.map((s) => s.text)).toEqual([waiting.pendingReply!.text]);
    expect(activeIntake(chatId)!.pendingReply).toBeNull();
    expect(model.analyze).toHaveBeenCalledTimes(1);
  });
});

describe('the model-sized copy (§7.2.4 step 3, §7.2.8)', () => {
  it('written at arrival beside the original, from the reduction the arrival makes anyway', async () => {
    const noteId = uuidv4();
    notes.push(noteId);
    const { id, storageKey, body } = await photo(noteId);
    const chat = BigInt(-7_790_000_000) - BigInt(STAMP);
    chats.push(chat);
    const state = startIntake(chat, 'rastamojka', { staffId });
    const answer = await readIntakeFile({ isPhoto: true, body, attachmentId: id }, '', 'image/jpeg', state);
    expect(answer.patch.images).toEqual([{ attachmentId: id, mediaType: 'image/jpeg' }]);
    await vi.waitFor(async () => expect((await getStorage().get(modelCopyKey(storageKey))).length).toBeGreaterThan(0));
  });

  it('a photo with its copy costs the job no sharp call; without one, one', async () => {
    const withCopy = await pressed();
    const a = await photo(activeIntake(withCopy.chatId)!.noteId);
    await storeModelCopy(a.id, (await reduceForModel(a.body))!);
    updateIntake(withCopy.chatId, { images: [{ attachmentId: a.id, mediaType: 'image/jpeg' }], fileCount: 1 });
    sharpCalls.n = 0;
    await runIntakeRead(withCopy.job, 0);
    expect(sharpCalls.n).toBe(0);
    const sent = model.analyze.mock.calls[0]![0] as { images: unknown[] };
    expect(sent.images).toHaveLength(1);

    const without = await pressed();
    const b = await photo(activeIntake(without.chatId)!.noteId);
    updateIntake(without.chatId, { images: [{ attachmentId: b.id, mediaType: 'image/jpeg' }], fileCount: 1 });
    sharpCalls.n = 0;
    await runIntakeRead(without.job, 0);
    expect(sharpCalls.n).toBe(1);
  });
});
