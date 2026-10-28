import 'dotenv/config';
import { randomUUID } from 'node:crypto';
import { inArray, sql } from 'drizzle-orm';
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';

/**
 * The durable «Hisoblatish» collection (docs/SAKKIZ-R3.md §6.2, his 1.8 c)
 * against a real database: the debounced write, the seal, the per-chat flush,
 * a failed write kept dirty, the hydrate and what it drops, a job's read after
 * the hydrate, and the 24-hour end said once.
 *
 * Everything is this file's own: chat ids starting `-79<stamp>`, one staff
 * user (DEACTIVATED in cleanup, never deleted), the requests, notes and
 * additions it writes. The job queue is stood in for (an untold addition's
 * save job is SEEN, never run), and so is the one send the sweep makes.
 */
vi.mock('@/modules/platform/jobs/boss', async (original) => ({
  ...(await original<typeof import('@/modules/platform/jobs/boss')>()),
  enqueue: vi.fn(async () => 'job-id'),
}));
vi.mock('@/modules/platform/telegram/send', async (original) => ({
  ...(await original<typeof import('@/modules/platform/telegram/send')>()),
  sendText: vi.fn(async () => ({
    ok: true,
    status: 200,
    description: '',
    messageId: 77_001,
    retryAfter: null,
    permanent: false,
    botDown: false,
    usedFallback: false,
  })),
}));

import { db, pgClient } from '@/modules/platform/db/client';
import { users } from '@/modules/platform/db/schema';
import { enqueue } from '@/modules/platform/jobs/boss';
import { sendText } from '@/modules/platform/telegram/send';
import {
  __forgetIntakeMemory,
  __intakeWriteCount,
  __setIntakeTableProbe,
  __setIntakeWriteHook,
  endIntake,
  flushIntakeWrites,
  hydrateIntakes,
  INTAKE_TTL_MS,
  intakesHydrated,
  IntakesNotReady,
  loadIntake,
  markIntakesHydrated,
  oldestUnwrittenUpdate,
  peekIntake,
  sealIntakeWrites,
  setDurableIntakes,
  startIntake,
  updateIntake,
} from '@/modules/platform/telegram/calc-store';
import type { IntakeState } from '@/modules/platform/telegram/calc-intake';
import { runIntakeSweep } from '@/modules/platform/telegram/calc-intake-sweep';
import { pruneTelegramRedelivery } from '@/modules/platform/telegram/once';
import { __resetLifecycle, stoppingGuard } from '@/modules/platform/telegram/lifecycle';
import { endedCollections, landingState } from '@/modules/wms/calc/intake-ended';
import { rootRequestOfNote } from '@/modules/wms/calc/intake-land';

const STAMP = String(Date.now()).slice(-7);
let chatSeq = 0;
const madeChats: bigint[] = [];
const nextChat = () => {
  const id = BigInt(`-79${STAMP}${String((chatSeq += 1)).padStart(2, '0')}`);
  madeChats.push(id);
  return id;
};
const madeNotes: string[] = [];
const madeRequests: string[] = [];
const madeLeads: string[] = [];
let staffId = '';
let savedToken: string | undefined;

async function rowOf(chat: bigint): Promise<{ state: IntakeState; expires_at: string } | null> {
  const rows = (await db.execute(sql`
    SELECT state, expires_at::text AS expires_at FROM telegram_calc_intakes WHERE chat_id = ${String(chat)}::bigint`)) as unknown as {
    state: IntakeState;
    expires_at: string;
  }[];
  return rows[0] ?? null;
}

/** A collection with something in it. */
function collection(chat: bigint, patch: Partial<IntakeState> = {}): IntakeState {
  startIntake(chat, 'rastamojka', { staffId, openedBy: 41 });
  return updateIntake(chat, { clientHintRaw: 'GS777 Ali aka', material: ['Kurtka 300 dona'], ...patch })!;
}

/** A row as an earlier process wrote it — touched `idleMs` ago. */
async function writeRow(chat: bigint, idleMs: number, patch: Partial<IntakeState> = {}): Promise<IntakeState> {
  const touched = Date.now() - idleMs;
  // A state of the right shape, minted with the store switched off so the
  // template itself is never written.
  setDurableIntakes(false);
  const state: IntakeState = {
    ...startIntake(BigInt(-1), 'rastamojka', { staffId }),
    clientHintRaw: 'GS777',
    material: ['Kurtka 300 dona'],
    openedAt: touched - 60_000,
    touchedAt: touched,
    ...patch,
  };
  endIntake(BigInt(-1));
  setDurableIntakes(true);
  const stored: Partial<IntakeState> = { ...state };
  delete stored.expires;
  await db.execute(sql`
    INSERT INTO telegram_calc_intakes (chat_id, staff_id, note_id, state, opened_at, touched_at, expires_at)
    VALUES (${String(chat)}::bigint, ${staffId}::uuid, ${state.noteId}::uuid, ${JSON.stringify(stored)}::jsonb,
            ${new Date(state.openedAt).toISOString()}::timestamptz, ${new Date(touched).toISOString()}::timestamptz,
            ${new Date(touched + INTAKE_TTL_MS).toISOString()}::timestamptz)`);
  return state;
}

/** A lead note (a card), and optionally a root request on it. */
async function noteOnCard(noteId: string, withRequest: boolean): Promise<string | null> {
  const [lead] = (await db.execute(sql`
    INSERT INTO leads (id, name, stage_id, owner_id)
    VALUES (${randomUUID()}::uuid, ${`Saqlash lid ${STAMP}`}, (SELECT id FROM lead_stages WHERE kind = 'open' ORDER BY sort_order LIMIT 1), ${staffId}::uuid)
    RETURNING id::text AS id`)) as unknown as { id: string }[];
  const leadId = lead!.id;
  madeLeads.push(leadId);
  await db.execute(sql`
    INSERT INTO crm_activities (id, entity_type, entity_id, kind, note, created_by)
    VALUES (${noteId}::uuid, 'lead', ${leadId}::uuid, 'note', 'hisoblatish', ${staffId}::uuid)`);
  madeNotes.push(noteId);
  if (!withRequest) return null;
  const [row] = (await db.execute(sql`
    INSERT INTO calc_requests (entity_type, entity_id, requested_by, item_count, due_at, note_id, section)
    VALUES ('lead', ${leadId}::uuid, ${staffId}::uuid, 0, now(), ${noteId}::uuid, 'rastamojka')
    RETURNING id::text AS id`)) as unknown as { id: string }[];
  madeRequests.push(row!.id);
  return row!.id;
}

beforeAll(async () => {
  savedToken = process.env.TELEGRAM_BOT_TOKEN;
  process.env.TELEGRAM_BOT_TOKEN = '7000002:DURABLE';
  const [u] = await db
    .insert(users)
    .values({ phone: `+99879${STAMP}`, fullName: `Saqlash ${STAMP}`, passwordHash: 'x', active: true })
    .returning({ id: users.id });
  staffId = u!.id;
  setDurableIntakes(true);
});

beforeEach(() => {
  vi.mocked(sendText).mockClear();
  vi.mocked(enqueue).mockClear();
});

afterEach(async () => {
  __setIntakeWriteHook(null);
  __setIntakeTableProbe(null);
  __forgetIntakeMemory();
  __resetLifecycle();
  if (madeChats.length) {
    await db.execute(sql`
      DELETE FROM telegram_calc_intakes
       WHERE chat_id IN (${sql.join(madeChats.map((c) => sql`${String(c)}::bigint`), sql`, `)})`);
  }
});

afterAll(async () => {
  setDurableIntakes(false);
  if (savedToken === undefined) delete process.env.TELEGRAM_BOT_TOKEN;
  else process.env.TELEGRAM_BOT_TOKEN = savedToken;
  await db.execute(sql`DELETE FROM telegram_calc_intakes WHERE staff_id = ${staffId}::uuid`);
  await db.execute(sql`DELETE FROM calc_amendments WHERE staff_id = ${staffId}::uuid`);
  if (madeRequests.length) {
    await db.execute(sql`DELETE FROM calc_requests WHERE id IN (${sql.join(madeRequests.map((id) => sql`${id}::uuid`), sql`, `)})`);
  }
  if (madeNotes.length) {
    await db.execute(sql`DELETE FROM crm_activities WHERE id IN (${sql.join(madeNotes.map((id) => sql`${id}::uuid`), sql`, `)})`);
  }
  if (madeLeads.length) {
    await db.execute(sql`DELETE FROM leads WHERE id IN (${sql.join(madeLeads.map((id) => sql`${id}::uuid`), sql`, `)})`);
  }
  await db.update(users).set({ active: false }).where(inArray(users.id, [staffId]));
  await pgClient.end();
});

describe('the row (§6.2.4)', () => {
  it('(a) three updates, a flush, a restart: the same collection back, field for field', async () => {
    const chat = nextChat();
    collection(chat);
    updateIntake(chat, { stage: 'material', fileCount: 2, images: [{ attachmentId: randomUUID(), mediaType: 'image/jpeg' }] });
    updateIntake(chat, { ownMessageIds: [42, 43], takenUpTo: 900 }, { quiet: true });
    const before = peekIntake(chat)!;
    expect(await flushIntakeWrites()).toBe(true);
    __forgetIntakeMemory();
    expect(peekIntake(chat)).toBeNull();
    expect(await hydrateIntakes()).toBeGreaterThanOrEqual(1);
    expect(peekIntake(chat)).toEqual(before);
  });

  it('(b) no Buffer reaches the jsonb — the files are attachment ids', async () => {
    const chat = nextChat();
    const photo = randomUUID();
    collection(chat, {
      images: [{ attachmentId: photo, mediaType: 'image/jpeg' }],
      pdfs: [{ attachmentId: randomUUID(), name: 'invoice.pdf', bytes: 120_000 }],
      fileCount: 2,
    });
    await flushIntakeWrites(chat);
    const raw = (await db.execute(sql`
      SELECT state::text AS text FROM telegram_calc_intakes WHERE chat_id = ${String(chat)}::bigint`)) as unknown as { text: string }[];
    expect(raw[0]!.text).not.toContain('"type": "Buffer"');
    expect(raw[0]!.text).not.toContain('"type":"Buffer"');
    expect((await rowOf(chat))!.state.images).toEqual([{ attachmentId: photo, mediaType: 'image/jpeg' }]);
  });

  it('(c) twenty updates at the poller’s cadence are at most three statements, not twenty (performance-2)', async () => {
    const chat = nextChat();
    collection(chat);
    await flushIntakeWrites(chat);
    const before = __intakeWriteCount();
    for (let i = 0; i < 20; i += 1) {
      updateIntake(chat, { material: [...peekIntake(chat)!.material, `xabar ${i}`] });
      // The bot's own awaited reply after every update — the step a chained
      // write used to run in.
      await new Promise((resolve) => setTimeout(resolve, 50));
    }
    await new Promise((resolve) => setTimeout(resolve, 1_300));
    await flushIntakeWrites(chat);
    expect(__intakeWriteCount() - before).toBeLessThanOrEqual(3);
    expect((await rowOf(chat))!.state.material).toHaveLength(21);
  });

  it('(d) an ended collection’s row is gone after the flush', async () => {
    const chat = nextChat();
    collection(chat);
    await flushIntakeWrites(chat);
    expect(await rowOf(chat)).not.toBeNull();
    endIntake(chat);
    expect(await flushIntakeWrites(chat)).toBe(true);
    expect(await rowOf(chat)).toBeNull();
  });

  it('(e) one migration behind (no table): memory works, nothing is written, nothing throws', async () => {
    __setIntakeTableProbe(async () => false);
    const chat = nextChat();
    const before = __intakeWriteCount();
    collection(chat);
    updateIntake(chat, { stage: 'material' });
    expect(await flushIntakeWrites(chat)).toBe(true);
    expect(peekIntake(chat)?.stage).toBe('material');
    expect(__intakeWriteCount()).toBe(before);
    __setIntakeTableProbe(null);
    expect(await rowOf(chat)).toBeNull();
  });
});

describe('the hydrate drops what is over, keeps what is not (§6.2.10)', () => {
  it('(f) a landed note and a told addition go; a note with no request and an untold addition stay', async () => {
    const landed = nextChat();
    const cutOff = nextChat();
    const told = nextChat();
    const untold = nextChat();
    const a = await writeRow(landed, 60_000);
    const b = await writeRow(cutOff, 60_000);
    const amendOf = (requestId: string) => ({ requestId, cardLabel: 'B-1', items: [] }) as unknown as IntakeState['amend'];
    const base = await noteOnCard(randomUUID(), true);
    const c = await writeRow(told, 60_000, { amend: amendOf(base!) });
    const d = await writeRow(untold, 60_000, {
      amend: amendOf(base!),
      saving: { token: 'tok-d', at: Date.now() - 60_000, jobId: 'old' },
    });
    await noteOnCard(a.noteId, true);
    await noteOnCard(b.noteId, false);
    for (const [state, sent] of [
      [c, true],
      [d, false],
    ] as const) {
      await db.execute(sql`
        INSERT INTO calc_amendments (id, request_id, note_id, staff_id, chat_id, outcome, submission, change, outcome_sent_at)
        VALUES (${randomUUID()}::uuid, ${base}::uuid, ${state.noteId}::uuid, ${staffId}::uuid, -1, 'noted',
                ${JSON.stringify({ material: ['x'] })}::jsonb, '{}'::jsonb, ${sent ? sql`now()` : sql`NULL`})`);
    }
    __forgetIntakeMemory();
    await hydrateIntakes();
    expect(peekIntake(landed)).toBeNull();
    expect(peekIntake(told)).toBeNull();
    expect(peekIntake(cutOff)?.noteId).toBe(b.noteId);
    expect(peekIntake(untold)?.noteId).toBe(d.noteId);
    // Their rows go with them; the kept ones stay.
    expect(await rowOf(landed)).toBeNull();
    expect(await rowOf(told)).toBeNull();
    expect(await rowOf(cutOff)).not.toBeNull();
    // The untold addition's save job is sent again, with the save job's own options.
    const calls = vi.mocked(enqueue).mock.calls.filter(([, data]) => (data as { noteId?: string }).noteId === d.noteId);
    expect(calls).toHaveLength(1);
    expect(calls[0]![1]).toMatchObject({ requestId: base, savingToken: 'tok-d', amendmentId: null, submission: { material: ['x'] } });
    expect(calls[0]![2]).toMatchObject({ expireInSeconds: 120, retryLimit: 3 });
    expect(peekIntake(untold)?.saving?.jobId).toBe((calls[0]![2] as { id: string }).id);
  });

  it('«landed» is one question: the hydrate’s and the landing’s own answers agree', async () => {
    const landedNote = randomUUID();
    const bareNote = randomUUID();
    await noteOnCard(landedNote, true);
    await noteOnCard(bareNote, false);
    const verdict = await endedCollections([
      { noteId: landedNote, amend: false },
      { noteId: bareNote, amend: false },
    ]);
    expect(verdict.ended.has(landedNote)).toBe((await rootRequestOfNote(landedNote)) !== null);
    expect(verdict.ended.has(bareNote)).toBe((await rootRequestOfNote(bareNote)) !== null);
    expect(await landingState(landedNote, staffId)).toBe('landed');
    expect(await landingState(bareNote, staffId)).toBe('note_only');
    expect(await landingState(randomUUID(), staffId)).toBe('none');
  });
});

describe('the seal and the per-chat flush (§6.2.2-3)', () => {
  it('(g) after the seal no statement is sent and the flush answers false', async () => {
    const chat = nextChat();
    collection(chat);
    await flushIntakeWrites();
    sealIntakeWrites();
    const before = __intakeWriteCount();
    updateIntake(chat, { material: ['a late effect'] });
    await new Promise((resolve) => setTimeout(resolve, 1_300));
    expect(await flushIntakeWrites()).toBe(false);
    expect(__intakeWriteCount()).toBe(before);
    expect((await rowOf(chat))!.state.material).toEqual(['Kurtka 300 dona']);
  });

  it('(h) a chat’s flush waits for that chat alone, and answers for it alone (performance-10)', async () => {
    const a = nextChat();
    const b = nextChat();
    collection(a);
    collection(b);
    await flushIntakeWrites();
    // B's write hangs: A's flush does not wait for it.
    let release: () => void = () => {};
    const gate = new Promise<void>((resolve) => {
      release = resolve;
    });
    __setIntakeWriteHook(async (chat) => {
      if (chat === String(b)) await gate;
    });
    updateIntake(a, { material: ['a'] });
    updateIntake(b, { material: ['b'] });
    const hanging = flushIntakeWrites(b);
    const quick = await Promise.race([
      flushIntakeWrites(a),
      new Promise<'waited'>((resolve) => setTimeout(() => resolve('waited'), 800)),
    ]);
    expect(quick).toBe(true);
    release();
    await hanging;
    // B's row is REFUSED (its window CHECK made to fail): A's flush is still true.
    __setIntakeWriteHook(null);
    updateIntake(b, { openedAt: Date.now() + 3_600_000 }, { quiet: true });
    updateIntake(a, { material: ['a2'] });
    expect(await flushIntakeWrites(a)).toBe(true);
    expect(await flushIntakeWrites(b)).toBe(false);
    expect((await rowOf(a))!.state.material).toEqual(['a2']);
  });

  it('(i) a failed write stays dirty, names its update, and the next timer lands it (durability-10)', async () => {
    const chat = nextChat();
    collection(chat);
    await flushIntakeWrites();
    let fail = true;
    __setIntakeWriteHook(async (k) => {
      if (k === String(chat) && fail) {
        fail = false;
        throw new Error('database blip');
      }
    });
    await stoppingGuard()({ update: { update_id: 424_242 } } as never, async () => {
      updateIntake(chat, { material: ['typed during the blip'] });
    });
    // The first write (after a second of quiet) fails…
    await vi.waitFor(() => expect(fail).toBe(false), { timeout: 3_000 });
    await new Promise((resolve) => setTimeout(resolve, 50));
    expect(oldestUnwrittenUpdate()).toBe(424_242);
    expect((await rowOf(chat))!.state.material).toEqual(['Kurtka 300 dona']);
    // …and the retry timer lands it, with nobody flushing.
    await vi.waitFor(async () => expect((await rowOf(chat))!.state.material).toEqual(['typed during the blip']), {
      timeout: 8_000,
      interval: 200,
    });
    expect(oldestUnwrittenUpdate()).toBeNull();
  }, 12_000);
});

describe('a job reads memory, after the hydrate (§6.2.12)', () => {
  it('(j) it waits for the hydrate; an ended collection is not raised from the table', async () => {
    const chat = nextChat();
    collection(chat);
    await flushIntakeWrites();
    const waiting = loadIntake(chat);
    let answered = false;
    void waiting.then(() => (answered = true));
    await new Promise((resolve) => setTimeout(resolve, 100));
    expect(answered).toBe(false);
    markIntakesHydrated();
    expect((await waiting)?.noteId).toBe(peekIntake(chat)!.noteId);
    // Ended in memory, its DELETE made to fail: the row is still there.
    __setIntakeWriteHook(async () => {
      throw new Error('delete refused');
    });
    endIntake(chat);
    expect(await flushIntakeWrites(chat)).toBe(false);
    expect(await rowOf(chat)).not.toBeNull();
    expect(await loadIntake(chat)).toBeNull();
    expect(peekIntake(chat)).toBeNull();
  });

  it('(j) not hydrated in time → false; no bot in this process → IntakesNotReady at once', async () => {
    __forgetIntakeMemory();
    expect(await intakesHydrated(150)).toBe(false);
    delete process.env.TELEGRAM_BOT_TOKEN;
    try {
      await expect(loadIntake(nextChat())).rejects.toBeInstanceOf(IntakesNotReady);
    } finally {
      process.env.TELEGRAM_BOT_TOKEN = '7000002:DURABLE';
    }
  });
});

describe('the end after an outage (durability-12 b)', () => {
  it('(k) a row expired 3 h ago is loaded and ended with the line once; one expired 30 h ago is never loaded and the prune deletes it', async () => {
    const recent = nextChat();
    const old = nextChat();
    await writeRow(recent, INTAKE_TTL_MS + 3 * 3_600_000);
    await writeRow(old, INTAKE_TTL_MS + 30 * 3_600_000);
    __forgetIntakeMemory();
    await hydrateIntakes();
    expect(peekIntake(recent)).not.toBeNull();
    expect(peekIntake(old)).toBeNull();
    await runIntakeSweep(Date.now());
    await runIntakeSweep(Date.now() + 5 * 60_000);
    await vi.waitFor(() => {
      const lines = vi.mocked(sendText).mock.calls.filter(([m]) => String(m.chatId) === String(recent));
      expect(lines).toHaveLength(1);
      expect(String(lines[0]![0].text)).toMatch(/^⌛ Hisoblatish 24 soat ichida tugatilmadi va o‘chirildi: 🛃 Rastamojka · GS777\./);
    });
    await flushIntakeWrites();
    expect(await rowOf(recent)).toBeNull();
    await pruneTelegramRedelivery();
    expect(await rowOf(old)).toBeNull();
  });
});
