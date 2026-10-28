import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';

/**
 * The collection's clock (docs/SAKKIZ-R3.md §6.2.13-15, his 1.8 c): the pure
 * `sweepAction`, and the sweep itself driven with a fake «now» and a send spy.
 * Every reader the sweep asks another package (the reading's job, the save's
 * job, the landing) is stood in for, so this file decides nothing but the
 * clock. The table is stood in for too (the probe answers «no table»): the
 * store's write path is calc-store-durable.integration's.
 */
const stub = vi.hoisted(() => ({
  readingAlive: true,
  savingAlive: true,
  deliveryAlive: false,
  landing: 'none' as 'none' | 'landed' | 'note_only',
  landed: null as null | Promise<unknown>,
}));
vi.mock('@/modules/platform/telegram/send', async (original) => ({
  ...(await original<typeof import('@/modules/platform/telegram/send')>()),
  sendText: vi.fn(async () => ({
    ok: true,
    status: 200,
    description: '',
    messageId: 88_001,
    retryAfter: null,
    permanent: false,
    botDown: false,
    usedFallback: false,
  })),
}));
vi.mock('@/modules/platform/telegram/calc-read', async (original) => ({
  ...(await original<typeof import('@/modules/platform/telegram/calc-read')>()),
  readingAlive: vi.fn(async () => stub.readingAlive),
  releaseDeadReading: vi.fn(async () => {}),
  pendingDeliveryAlive: vi.fn(async () => stub.deliveryAlive),
  deliverStoredReply: vi.fn(async () => {}),
}));
vi.mock('@/modules/platform/telegram/calc-amend', async (original) => ({
  ...(await original<typeof import('@/modules/platform/telegram/calc-amend')>()),
  savingAlive: vi.fn(async () => stub.savingAlive),
  releaseDeadSave: vi.fn(async () => {}),
}));
vi.mock('@/modules/wms/calc/intake-ended', () => ({
  landingState: vi.fn(async () => stub.landing),
  endedCollections: vi.fn(async () => ({ ended: new Set(), untold: [] })),
}));
vi.mock('@/modules/platform/telegram/staff-bot', async (original) => ({
  ...(await original<typeof import('@/modules/platform/telegram/staff-bot')>()),
  staffForChat: vi.fn(async () => ({ id: 'staff-sweep', fullName: 'Sotuvchi' })),
  landingLinkFor: vi.fn(async () => null),
  landCollectedIntake: vi.fn(async () => {
    await stub.landed;
    return { kind: 'deal', id: 'd-1', label: 'B-000067', leadOwnerId: null, outcome: 'retried', queued: true, requestId: 'r-1', queueError: null, replyQueued: false };
  }),
}));
vi.mock('@/modules/platform/telegram/keyboards', () => ({
  replyKeyboardFor: vi.fn(async () => ({ keyboard: [[{ text: '📋 Bugun' }]], resize_keyboard: true })),
}));

import { sendText } from '@/modules/platform/telegram/send';
import { releaseDeadReading, deliverStoredReply } from '@/modules/platform/telegram/calc-read';
import { releaseDeadSave } from '@/modules/platform/telegram/calc-amend';
import {
  __forgetIntakeMemory,
  __setIntakeTableProbe,
  activeIntake,
  endIntake,
  INTAKE_TTL_MS,
  intakeMomentOf,
  intakeTakes,
  peekIntake,
  REMIND_AFTER_MS,
  setDurableIntakes,
  startIntake,
  updateIntake,
} from '@/modules/platform/telegram/calc-store';
import type { IntakeState } from '@/modules/platform/telegram/calc-intake';
import {
  __resetIntakeSweep,
  BOOT_GRACE_MS,
  landedAlreadyReply,
  reminderText,
  runIntakeSweep,
  sweepAction,
  type SweepFacts,
} from '@/modules/platform/telegram/calc-intake-sweep';
import { __resetLifecycle, markBoot } from '@/modules/platform/telegram/lifecycle';
import { SECTION_LABEL } from '@/modules/wms/calc/intake';
import type { AmendBase } from '@/modules/wms/calc/amend-types';

const H = 3_600_000;
const MIN = 60_000;
const send = vi.mocked(sendText);
const OK = { ok: true, status: 200, description: '', messageId: 88_001, retryAfter: null, permanent: false, botDown: false, usedFallback: false };

let seq = 0;
const chats: bigint[] = [];
function chat(): bigint {
  seq += 1;
  const id = BigInt(-7_600_000_000) - BigInt(seq);
  chats.push(id);
  return id;
}
/** A collection with something in it, last touched `idleMs` before `at`. */
function open(at: number, idleMs: number, patch: Partial<IntakeState> = {}): bigint {
  const id = chat();
  startIntake(id, 'rastamojka', { staffId: 'staff-sweep' });
  updateIntake(id, { clientHintRaw: 'GS777', material: ['Kurtka 300 dona'], ...patch });
  updateIntake(id, { touchedAt: at - idleMs }, { quiet: true });
  return id;
}
const remindersTo = (id: bigint) =>
  send.mock.calls.filter(([msg]) => String(msg.chatId) === String(id) && String(msg.text).startsWith('⏸'));
const textsTo = (id: bigint) => send.mock.calls.filter(([msg]) => String(msg.chatId) === String(id)).map(([m]) => String(m.text));

const facts = (patch: Partial<SweepFacts> = {}): SweepFacts => ({
  readingAlive: true,
  landing: 'none',
  pendingDeliveryAlive: false,
  savingAlive: true,
  pressLandingMs: null,
  sinceBootMs: Number.POSITIVE_INFINITY,
  ...patch,
});

beforeAll(() => {
  __setIntakeTableProbe(async () => false);
  setDurableIntakes(true);
});
afterAll(() => {
  setDurableIntakes(false);
  __setIntakeTableProbe(null);
});
beforeEach(() => {
  send.mockClear();
  send.mockImplementation(async () => OK);
  vi.mocked(releaseDeadReading).mockClear();
  vi.mocked(deliverStoredReply).mockClear();
  vi.mocked(releaseDeadSave).mockClear();
  Object.assign(stub, { readingAlive: true, savingAlive: true, deliveryAlive: false, landing: 'none', landed: null });
});
afterEach(() => {
  for (const id of chats.splice(0)) endIntake(id);
  __forgetIntakeMemory();
  __resetIntakeSweep();
  __resetLifecycle();
});

describe('the reminder (2 h, once per idle stretch)', () => {
  it('reminds at 2 h, not at 1 h 59 min', async () => {
    const now = Date.now();
    const early = open(now, 2 * H - MIN);
    const due = open(now, 2 * H);
    await runIntakeSweep(now);
    expect(remindersTo(early)).toHaveLength(0);
    expect(remindersTo(due)).toHaveLength(1);
  });

  it('is not repeated in the same idle stretch — 5 minutes later, nor two hours after it', async () => {
    const now = Date.now();
    const id = open(now, 2 * H);
    await runIntakeSweep(now);
    await runIntakeSweep(now + 5 * MIN);
    await runIntakeSweep(now + 2 * H + 5 * MIN);
    expect(remindersTo(id)).toHaveLength(1);
  });

  it('the seller’s own action after it starts a new stretch: reminded again two hours later', async () => {
    const now = Date.now();
    const id = open(now, 2 * H);
    await runIntakeSweep(now);
    updateIntake(id, { material: ['Kurtka 300 dona', 'Shim 200 dona'] });
    await runIntakeSweep(Date.now() + 2 * H);
    expect(remindersTo(id)).toHaveLength(2);
  });

  it('a live reading is not reminded; a dead one is released', async () => {
    const now = Date.now();
    const id = open(now, 2 * H, { analysing: 'tok' });
    await runIntakeSweep(now);
    expect(remindersTo(id)).toHaveLength(0);
    expect(releaseDeadReading).not.toHaveBeenCalled();
    stub.readingAlive = false;
    await runIntakeSweep(now);
    expect(releaseDeadReading).toHaveBeenCalledTimes(1);
  });

  it('a frozen save is not reminded; a dead save is released once, a live one left', async () => {
    const now = Date.now();
    const id = open(now, 2 * H, { saving: { token: 't', at: now - 2 * H, jobId: 'j' } });
    await runIntakeSweep(now);
    expect(remindersTo(id)).toHaveLength(0);
    expect(releaseDeadSave).not.toHaveBeenCalled();
    stub.savingAlive = false;
    vi.mocked(releaseDeadSave).mockImplementationOnce(async (chatId) => {
      updateIntake(chatId, { saving: null }, { quiet: true });
    });
    await runIntakeSweep(now);
    await runIntakeSweep(now);
    expect(releaseDeadSave).toHaveBeenCalledTimes(1);
    expect(peekIntake(id)?.saving).toBeNull();
  });

  it('an empty collection is never reminded', async () => {
    const now = Date.now();
    const id = chat();
    startIntake(id, 'rastamojka', { staffId: 'staff-sweep' });
    updateIntake(id, { touchedAt: now - 3 * H }, { quiet: true });
    await runIntakeSweep(now);
    expect(send).not.toHaveBeenCalled();
  });

  it('a 429 (or the token down, or no answer) releases the claim — the next tick sends; a 403 stays claimed', async () => {
    const now = Date.now();
    const flaky = open(now, 2 * H);
    const blocked = open(now, 2 * H);
    send.mockImplementation(async (msg) =>
      String(msg.chatId) === String(flaky)
        ? { ...OK, ok: false, status: 429, messageId: null, retryAfter: 30 }
        : { ...OK, ok: false, status: 403, messageId: null, permanent: true },
    );
    await runIntakeSweep(now);
    send.mockImplementation(async () => OK);
    await runIntakeSweep(now + 5 * MIN);
    expect(remindersTo(flaky)).toHaveLength(2);
    expect(remindersTo(blocked)).toHaveLength(1);
    expect(peekIntake(flaky)?.ownMessageIds).toContain(88_001);
  });

  it('is silent in the bot’s one night (22:00-08:00 Tashkent), aloud by day', async () => {
    const day = (h: number, m: number) => Date.UTC(2026, 9, 28, h - 5, m);
    for (const [at, silent] of [
      [day(22, 30), true],
      [day(21, 30), false],
      [day(10, 0), false],
    ] as const) {
      send.mockClear();
      const id = open(at, 2 * H);
      await runIntakeSweep(at);
      expect(remindersTo(id)[0]?.[0].silent, new Date(at).toISOString()).toBe(silent);
    }
  });

  it('the words: section · customer, what was sent, when it ends; an add collection names its card', () => {
    const touched = Date.UTC(2026, 9, 28, 9 - 5, 30);
    const base = { ...startIntake(chat(), 'rastamojka', { staffId: 's' }), touchedAt: touched };
    const plain = reminderText(
      { ...base, material: ['a', 'b'], answers: ['3: 50 dona'], fileCount: 2 },
      touched + 2 * H,
      SECTION_LABEL,
      'GS777 · Ali aka',
    );
    expect(plain).toBe(
      '⏸ Tugallanmagan hisoblatish: 🛃 Rastamojka · GS777 · Ali aka\n' +
        'Yuborilgan: 3 ta xabar · 2 ta fayl\n' +
        'Davom etamizmi? Tugatilmasa ertaga soat 09:30 da o‘chiriladi.',
    );
    // The end falls today when the reminder is sent on the next calendar day.
    const late = reminderText({ ...base, fileCount: 1 }, touched + 22 * H, SECTION_LABEL, null);
    expect(late).toBe(
      '⏸ Tugallanmagan hisoblatish: 🛃 Rastamojka · mijoz hali yozilmagan\n' +
        'Yuborilgan: 1 ta fayl\n' +
        'Davom etamizmi? Tugatilmasa soat 09:30 da o‘chiriladi.',
    );
    const amend = { cardLabel: 'B-000067' } as AmendBase;
    expect(reminderText({ ...base, amend, material: ['x'] }, touched + 2 * H, SECTION_LABEL, null).split('\n')[0]).toBe(
      '⏸ Tugallanmagan qo‘shimcha: ➕ B-000067 · 🛃 Rastamojka',
    );
  });

  it('the sweep sends the add collection’s ➕ head and the two buttons', async () => {
    const now = Date.now();
    const id = open(now, 2 * H, { amend: { cardLabel: 'B-000067', requestId: 'r' } as AmendBase });
    await runIntakeSweep(now);
    const [msg] = remindersTo(id)[0]!;
    expect(String(msg.text)).toContain('➕ B-000067');
    const data = (msg.replyMarkup as { inline_keyboard: { callback_data: string }[][] }).inline_keyboard
      .flat()
      .map((b) => b.callback_data);
    expect(data).toEqual(['c:resume', 'c:cancel']);
  });
});

describe('the end (24 h; durability-12)', () => {
  it('24 hours since the last action → ended with the line; an empty one in silence', async () => {
    const now = Date.now();
    const full = open(now, INTAKE_TTL_MS);
    const empty = chat();
    startIntake(empty, 'yolkira', { staffId: 'staff-sweep' });
    updateIntake(empty, { touchedAt: now - INTAKE_TTL_MS }, { quiet: true });
    await runIntakeSweep(now);
    await vi.waitFor(() => expect(textsTo(full)).toHaveLength(1));
    expect(textsTo(full)[0]).toBe(
      '⌛ Hisoblatish 24 soat ichida tugatilmadi va o‘chirildi: 🛃 Rastamojka · GS777. Kerak bo‘lsa «🧮 Hisoblatish» dan qaytadan boshlang.',
    );
    expect(peekIntake(full)).toBeNull();
    expect(peekIntake(empty)).toBeNull();
    expect(textsTo(empty)).toHaveLength(0);
  });

  it('a READ that meets it first says the line once — the tick after it says nothing', async () => {
    const id = open(Date.now(), INTAKE_TTL_MS + MIN);
    expect(activeIntake(id)).toBeNull();
    await vi.waitFor(() => expect(textsTo(id)).toHaveLength(1));
    await runIntakeSweep(Date.now() + 2 * MIN);
    await new Promise((resolve) => setTimeout(resolve, 20));
    expect(textsTo(id)).toHaveLength(1);
  });

  it('a backlog answer written 10 minutes before the 24 hours ran out, processed 20 after, is the collection’s', () => {
    const touched = Date.now() - INTAKE_TTL_MS - 20 * MIN;
    const id = open(Date.now(), 0, { ownMessageIds: [5005] });
    updateIntake(id, { touchedAt: touched, openedAt: touched - H }, { quiet: true });
    markBoot(new Date());
    const written = Math.floor((touched + INTAKE_TTL_MS - 10 * MIN) / 1000);
    const state = activeIntake(id, intakeMomentOf(written));
    expect(state).not.toBeNull();
    expect(intakeTakes(state!, { date: written, messageId: 6006, replyTo: 5005 })).toBe('take');
  });

  it('ends nothing in the boot’s grace — the backlog is applied first', async () => {
    const now = Date.now();
    markBoot(new Date(now - BOOT_GRACE_MS + 30_000));
    const id = open(now, INTAKE_TTL_MS + MIN);
    await runIntakeSweep(now);
    expect(peekIntake(id)).not.toBeNull();
    await runIntakeSweep(now + BOOT_GRACE_MS);
    expect(peekIntake(id)).toBeNull();
  });
});

describe('a stored reply nobody delivered (durability-16)', () => {
  it('two minutes old, no reading running, no delivery alive → delivered once; with one alive → left', async () => {
    const now = Date.now();
    const id = open(now, 5 * MIN, {
      pendingReply: { token: 't', text: 'jadval', keyboard: null, at: now - 2 * MIN, jobId: null },
    });
    stub.deliveryAlive = true;
    await runIntakeSweep(now);
    expect(deliverStoredReply).not.toHaveBeenCalled();
    stub.deliveryAlive = false;
    await runIntakeSweep(now);
    expect(deliverStoredReply).toHaveBeenCalledTimes(1);
    expect(vi.mocked(deliverStoredReply).mock.calls[0]![0]).toBe(id);
  });
});

describe('a landing cut off halfway (durability-3)', () => {
  it('a note on its card with no request → resumed once, the ✅ in Uch band’s retried words; a press in the same tick says nothing', async () => {
    const now = Date.now();
    const id = open(now, 5 * MIN, { stage: 'review' });
    stub.landing = 'note_only';
    let release: () => void = () => {};
    stub.landed = new Promise<void>((resolve) => {
      release = resolve;
    });
    const tick = runIntakeSweep(now);
    await vi.waitFor(async () => {
      const replies: string[] = [];
      const said = await landedAlreadyReply({ reply: async (t) => (replies.push(t), { message_id: 1 }) }, id, peekIntake(id)!);
      expect(said).toBe(true);
      expect(replies).toEqual([]);
    });
    release();
    await tick;
    const ticks = textsTo(id).filter((t) => t.startsWith('✅'));
    expect(ticks).toHaveLength(1);
    expect(ticks[0]).toContain('✅ Saqlandi — oldingi urinishda ochilgan');
    expect(peekIntake(id)).toBeNull();
  });

  it('a press that started the landing this minute keeps the tick away', async () => {
    const now = Date.now();
    const id = open(now, 5 * MIN, { stage: 'review' });
    stub.landing = 'note_only';
    expect(await landedAlreadyReply({ reply: async () => ({ message_id: 1 }) }, id, peekIntake(id)!)).toBe(false);
    await runIntakeSweep(Date.now());
    expect(textsTo(id)).toHaveLength(0);
    await runIntakeSweep(Date.now() + 61_000);
    expect(textsTo(id).filter((t) => t.startsWith('✅'))).toHaveLength(1);
  });

  it('an add collection is never a landing to resume — its note is its save job’s', async () => {
    const now = Date.now();
    const id = open(now, 5 * MIN, { stage: 'review', amend: { cardLabel: 'B-000067', requestId: 'r' } as AmendBase });
    stub.landing = 'note_only';
    await runIntakeSweep(now);
    expect(textsTo(id)).toHaveLength(0);
    expect(peekIntake(id)).not.toBeNull();
  });
});

describe('sweepAction, the order of its answers (pure)', () => {
  const now = Date.now();
  const base = (patch: Partial<IntakeState> = {}): IntakeState => ({
    ...startIntake(chat(), 'rastamojka', { staffId: 's' }),
    material: ['x'],
    touchedAt: now - 3 * H,
    ...patch,
  });
  it('resume before the end; the end before a reminder; nothing in the grace', () => {
    expect(sweepAction(base({ touchedAt: now - INTAKE_TTL_MS }), now, facts({ landing: 'note_only' }))).toBe('resume_landing');
    expect(sweepAction(base({ touchedAt: now - INTAKE_TTL_MS }), now, facts())).toBe('end_said');
    expect(sweepAction(base({ touchedAt: now - INTAKE_TTL_MS }), now, facts({ sinceBootMs: MIN }))).toBe('none');
    expect(sweepAction(base(), now, facts())).toBe('remind');
    expect(sweepAction(base({ remindedAt: now - H }), now, facts())).toBe('none');
    expect(sweepAction(base({ touchedAt: now - REMIND_AFTER_MS + 1 }), now, facts())).toBe('none');
  });
  it('a press landing it this minute leaves it to the press', () => {
    expect(sweepAction(base(), now, facts({ landing: 'note_only', pressLandingMs: 10_000 }))).toBe('remind');
    expect(sweepAction(base(), now, facts({ landing: 'note_only', pressLandingMs: 60_000 }))).toBe('resume_landing');
  });
});
