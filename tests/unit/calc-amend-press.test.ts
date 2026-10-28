import { afterEach, describe, expect, it, vi } from 'vitest';

/**
 * «➕ Shu so‘rovga qo‘shish» — the door's press (docs/SAKKIZ-R3.md §9.2, §2.4):
 * every refusal in its words, the restart and the resume, the open state, and
 * a returned request's seeded collection. Handler fakes: the stored request,
 * its standing and the staff member are stand-ins; the collection store, the
 * keyboards and the door itself are the real ones.
 */
const stub = vi.hoisted(() => ({
  staff: { id: 'staff-1', fullName: 'Ali' } as { id: string; fullName: string } | null,
  stored: null as null | Record<string, unknown>,
  standing: { standing: 'open', rev: 3, handsoffRev: 3, completedVia: null, returnReason: null, ending: null } as Record<string, unknown>,
  hint: 'GS777',
  claimed: true,
  draft: false,
  capture: false,
  asks: [] as { itemId: string; seq: number; name: string; needs: unknown[] }[],
  toasts: [] as (string | undefined)[],
}));
vi.mock('@/modules/platform/telegram/staff-bot', async (original) => ({
  ...(await original<typeof import('@/modules/platform/telegram/staff-bot')>()),
  staffForChat: async () => stub.staff,
}));
vi.mock('@/modules/wms/calc/service', async (original) => ({
  ...(await original<typeof import('@/modules/wms/calc/service')>()),
  storedRequestFacts: async (id: string) =>
    stub.stored && (stub.stored.base as { requestId: string }).requestId === id ? stub.stored : null,
}));
vi.mock('@/modules/wms/calc/amend', async (original) => ({
  ...(await original<typeof import('@/modules/wms/calc/amend')>()),
  amendStanding: async () => stub.standing,
  returnedClientHint: async () => stub.hint,
}));
vi.mock('@/modules/wms/calc/law-asks', () => ({ lawAsksOf: () => stub.asks }));
vi.mock('@/modules/platform/telegram/once', async (original) => ({
  ...(await original<typeof import('@/modules/platform/telegram/once')>()),
  claimOnce: async () => stub.claimed,
}));
vi.mock('@/modules/platform/telegram/press', async (original) => ({
  ...(await original<typeof import('@/modules/platform/telegram/press')>()),
  answerPress: async (_ctx: unknown, toast?: string) => {
    stub.toasts.push(toast);
    return 'answered';
  },
}));
vi.mock('@/modules/platform/telegram/task-draft', async (original) => ({
  ...(await original<typeof import('@/modules/platform/telegram/task-draft')>()),
  activeDraft: () => (stub.draft ? ({ assigneeId: null } as never) : null),
}));
vi.mock('@/modules/platform/telegram/note-capture', async (original) => ({
  ...(await original<typeof import('@/modules/platform/telegram/note-capture')>()),
  activeCapture: () => (stub.capture ? ({} as never) : null),
  refuseWhileCapturing: vi.fn(async () => true),
}));
vi.mock('@/modules/platform/telegram/calc-dialog', async (original) => ({
  ...(await original<typeof import('@/modules/platform/telegram/calc-dialog')>()),
  deliverNextStep: vi.fn(async () => {}),
}));
vi.mock('@/modules/platform/telegram/calc-intake-sweep', async (original) => ({
  ...(await original<typeof import('@/modules/platform/telegram/calc-intake-sweep')>()),
  pressResume: vi.fn(async () => {}),
}));

import { ADD_REFUSAL, amendKeyboard, pressAdd, STANDING_LINE } from '@/modules/platform/telegram/calc-amend';
import { activeIntake, endIntake, startIntake } from '@/modules/platform/telegram/calc-store';
import { deliverNextStep } from '@/modules/platform/telegram/calc-dialog';
import { pressResume } from '@/modules/platform/telegram/calc-intake-sweep';
import { refuseWhileCapturing } from '@/modules/platform/telegram/note-capture';
import { CLIENT_QUESTION } from '@/modules/platform/telegram/calc-keyboards';
import { BUSY_DRAFT } from '@/modules/platform/telegram/task-handlers';
import { parseCallback } from '@/modules/platform/telegram/staff-bot';

const REQ = '01234567-89ab-7def-8123-456789abcd01';
const OTHER = '01234567-89ab-7def-8123-456789abcd02';
const I1 = '01234567-89ab-7def-8123-456789abcd11';
const I2 = '01234567-89ab-7def-8123-456789abcd12';

function storedOf(over: Record<string, unknown> = {}, baseOver: Record<string, unknown> = {}) {
  const base = {
    requestId: REQ,
    cardLabel: 'B-000067',
    entityType: 'deal',
    entityId: '01234567-89ab-7def-8123-456789abcd21',
    leadOpen: null,
    section: 'rastamojka',
    clientLabel: 'GS777',
    openedRev: 3,
    items: [
      { itemId: I1, seq: 1, name: 'Sumka', quantity: 10, weightKg: null, volumeM3: null, measureUnit: null, measureQty: null, tnvedCode: '4202920000', law: null, confirmed: false },
      { itemId: I2, seq: 2, name: 'Krossovka', quantity: null, weightKg: 300, volumeM3: null, measureUnit: null, measureQty: null, tnvedCode: null, law: null, confirmed: false },
    ],
    weightKg: 500,
    volumeM3: 3,
    fromCity: null,
    toCity: null,
    ...baseOver,
  };
  return {
    base,
    facts: {
      weightKg: 500,
      volumeM3: 3,
      goods: [
        { name: 'Sumka', quantity: 10, tnvedCode: '4202920000', itemId: I1, seq: 1 },
        { name: 'Krossovka', weightKg: 300, itemId: I2, seq: 2 },
      ],
    },
    rev: 3,
    handsoffRev: 3,
    aiPassRev: null,
    aiPassAt: null,
    aiPassJob: null,
    requestedBy: 'staff-1',
    completedAt: null,
    completedVia: null,
    returnReason: null,
    ending: null,
    ...over,
  };
}

let seq = 0;
const chats: bigint[] = [];
function chat(): bigint {
  seq += 1;
  const id = BigInt(-7_500_000_000) - BigInt(seq);
  chats.push(id);
  return id;
}

afterEach(() => {
  for (const id of chats.splice(0)) endIntake(id);
  stub.staff = { id: 'staff-1', fullName: 'Ali' };
  stub.stored = null;
  stub.standing = { standing: 'open', rev: 3, handsoffRev: 3, completedVia: null, returnReason: null, ending: null };
  stub.hint = 'GS777';
  stub.claimed = true;
  stub.draft = false;
  stub.capture = false;
  stub.asks = [];
  stub.toasts.length = 0;
  vi.mocked(deliverNextStep).mockClear();
  vi.mocked(pressResume).mockClear();
  vi.mocked(refuseWhileCapturing).mockClear();
});

/** A press of `data` from message 77. */
function pressOf() {
  const replies: { text: string; extra?: Record<string, unknown> }[] = [];
  const ctx = {
    reply: async (text: string, extra?: Record<string, unknown>) => {
      replies.push({ text, extra });
      return { message_id: 9000 + replies.length };
    },
    callbackQuery: { message: { message_id: 77 } },
    answerCallbackQuery: async () => true,
    api: { editMessageText: async () => true },
  };
  return { ctx: ctx as never, replies, texts: () => replies.map((r) => r.text) };
}

const buttonsOf = (extra?: Record<string, unknown>) =>
  ((extra?.reply_markup as { inline_keyboard?: { text: string; callback_data: string }[][] } | undefined)?.inline_keyboard ?? []).flat();

async function press(id: bigint, mode: 'plain' | 'restart' | 'replied' = 'plain', requestId = REQ) {
  const p = pressOf();
  await pressAdd(p.ctx, id, requestId, mode, mode === 'restart' ? ({ kind: 'press' } as never) : null);
  return p;
}

describe('the vocabulary', () => {
  it('ca: / cg: / cf: parse to the add door with their mode', () => {
    expect(parseCallback(`ca:${REQ}`)).toEqual({ kind: 'calc_add', requestId: REQ, mode: 'plain' });
    expect(parseCallback(`cg:${REQ}`)).toEqual({ kind: 'calc_add', requestId: REQ, mode: 'restart' });
    expect(parseCallback(`cf:${REQ}`)).toEqual({ kind: 'calc_add', requestId: REQ, mode: 'replied' });
  });
});

describe('every refusal says its words, and answers the press once with them (§2.4)', () => {
  const cases: [string, () => void, string][] = [
    ['an unlinked chat', () => void (stub.staff = null), ADD_REFUSAL.notLinked],
    ['a request that is gone', () => void (stub.stored = null), ADD_REFUSAL.notFound],
    ['a colleague’s request', () => void (stub.stored = storedOf({ requestedBy: 'staff-2' })), ADD_REFUSAL.notYours],
    ['an answered request', () => void (stub.stored = storedOf({ ending: 'answered' })), ADD_REFUSAL.closed],
    ['a sealed request', () => void (stub.stored = storedOf({ ending: 'sealed' })), ADD_REFUSAL.closed],
    // Re-check p4-15: a price-less close is never «javob berilgan».
    ['a request closed with no price (lines)', () => void (stub.stored = storedOf({ ending: 'unpriced_lines' })), ADD_REFUSAL.closedUnpriced],
    ['a request closed with no price (task)', () => void (stub.stored = storedOf({ ending: 'unpriced_task' })), ADD_REFUSAL.closedUnpriced],
    // Re-check p4-4: a closed lead takes no addition.
    ['a closed lead', () => void (stub.stored = storedOf({}, { entityType: 'lead', leadOpen: false })), ADD_REFUSAL.leadClosed],
  ];
  for (const [what, arrange, words] of cases) {
    it(what, async () => {
      if (stub.stored === null && what !== 'a request that is gone') stub.stored = storedOf();
      arrange();
      const id = chat();
      const p = await press(id);
      expect(p.texts()).toEqual([words]);
      expect(stub.toasts).toEqual([words]);
      expect(activeIntake(id)).toBeNull();
    });
  }

  it('closed between the door and the open (the standing re-read) — by how it ended', async () => {
    stub.stored = storedOf();
    stub.standing = { ...stub.standing, standing: 'closed', ending: 'unpriced_task' };
    const p = await press(chat());
    expect(p.texts()).toEqual([ADD_REFUSAL.closedUnpriced]);
    stub.standing = { ...stub.standing, standing: 'closed', ending: 'answered' };
    const q = await press(chat());
    expect(q.texts()).toEqual([ADD_REFUSAL.closed]);
  });

  it('a task draft being written: its own words, imported', async () => {
    stub.stored = storedOf();
    stub.draft = true;
    const p = await press(chat());
    expect(p.texts()).toEqual([`Hozir topshiriq yozilyapti. ${BUSY_DRAFT}`]);
  });

  it('a zametka being written: the capture’s own refusal', async () => {
    stub.stored = storedOf();
    stub.capture = true;
    const id = chat();
    await press(id);
    expect(vi.mocked(refuseWhileCapturing)).toHaveBeenCalledTimes(1);
    expect(stub.toasts).toHaveLength(1);
    expect(activeIntake(id)).toBeNull();
  });
});

describe('the open', () => {
  it('an add collection on the stored rows, in review, with the asked rows and the standing — and its keyboard', async () => {
    stub.stored = storedOf();
    stub.asks = [{ itemId: I2, seq: 2, name: 'Krossovka', needs: [] }];
    const id = chat();
    const p = await press(id);
    const state = activeIntake(id)!;
    expect(state.amend?.requestId).toBe(REQ);
    expect(state.stage).toBe('review');
    expect(state.standingAtOpen).toBe('open');
    expect(state.askedSeqs).toEqual([2]);
    expect(state.openedBy).toBe(77);
    expect(state.facts.goods?.map((g) => [g.seq, g.itemId, g.name])).toEqual([
      [1, I1, 'Sumka'],
      [2, I2, 'Krossovka'],
    ]);
    // A stored row's weight is its own — never the brutto copied onto it.
    expect(state.facts.lineWeightsStated).toBe(true);
    expect(state.clientHintRaw).toBe('GS777');
    expect(stub.toasts).toHaveLength(1);
    // An open request says no standing line; the table is the next step's.
    expect(p.texts()).toEqual([]);
    expect(vi.mocked(deliverNextStep)).toHaveBeenCalledTimes(1);
    expect(vi.mocked(deliverNextStep).mock.calls[0]![2]).toMatchObject({ amend: { requestId: REQ }, stage: 'review' });
    expect(amendKeyboard(state.standingAtOpen).inline_keyboard.flat().map((b) => [b.text, b.callback_data])).toEqual([
      ['✅ Qo‘shish', 'c:save'],
      ['➕ Yana ma’lumot', 'c:more'],
      ['✖️ Bekor qilish', 'c:cancel'],
    ]);
  });

  it('a job the VED started: the standing line first, and the save button says where it goes', async () => {
    stub.stored = storedOf();
    stub.standing = { ...stub.standing, standing: 'started', handsoffRev: null };
    const id = chat();
    const p = await press(id);
    expect(p.texts()).toEqual([STANDING_LINE.started]);
    expect(activeIntake(id)!.standingAtOpen).toBe('started');
    expect(amendKeyboard('started').inline_keyboard[0]![0]).toEqual({ text: '📨 VED ga yuborish', callback_data: 'c:save' });
  });

  it('a machine pass running: the busy line', async () => {
    stub.stored = storedOf();
    stub.standing = { ...stub.standing, standing: 'busy' };
    const p = await press(chat());
    expect(p.texts()).toEqual([STANDING_LINE.busy]);
  });

  it('a stored m³ that is the lines’ Σ is left to the lines; a typed one is kept', async () => {
    stub.stored = storedOf(
      { facts: { volumeM3: 3, goods: [{ name: 'A', volumeM3: 1, itemId: I1, seq: 1 }, { name: 'B', volumeM3: 2, itemId: I2, seq: 2 }] } },
      {
        volumeM3: 3,
        items: [
          { itemId: I1, seq: 1, name: 'A', quantity: null, weightKg: null, volumeM3: 1, measureUnit: null, measureQty: null, tnvedCode: null, law: null, confirmed: false },
          { itemId: I2, seq: 2, name: 'B', quantity: null, weightKg: null, volumeM3: 2, measureUnit: null, measureQty: null, tnvedCode: null, law: null, confirmed: false },
        ],
      },
    );
    const id = chat();
    await press(id);
    expect(activeIntake(id)!.facts.volumeM3).toBeNull();
    expect(activeIntake(id)!.facts.totalsStored).toBe(false);
    endIntake(id);
    stub.stored = storedOf({}, { volumeM3: 7 });
    const other = chat();
    await press(other);
    expect(activeIntake(other)!.facts.volumeM3).toBe(3);
    expect(activeIntake(other)!.facts.totalsStored).toBe(true);
  });
});

describe('a live collection: the question, the restart and the resume (durability-2)', () => {
  it('another collection live → the one question, «🗑 Ha …» = cg:, «▶️ Yo‘q, davom etaman» = c:resume; nothing ended', async () => {
    stub.stored = storedOf();
    const id = chat();
    const old = startIntake(id, 'yolkira', { staffId: 'staff-1' });
    const p = await press(id);
    expect(p.replies).toHaveLength(1);
    expect(p.replies[0]!.text).toContain('B-000067');
    expect(buttonsOf(p.replies[0]!.extra).map((b) => b.callback_data)).toEqual([`cg:${REQ}`, 'c:resume']);
    expect(buttonsOf(p.replies[0]!.extra)[1]!.text).toBe('▶️ Yo‘q, davom etaman');
    expect(activeIntake(id)!.noteId).toBe(old.noteId);
    expect(stub.toasts).toHaveLength(1);
  });

  it('cg: ends the other collection and opens the add one', async () => {
    stub.stored = storedOf();
    const id = chat();
    const old = startIntake(id, 'yolkira', { staffId: 'staff-1' });
    await press(id, 'restart');
    const now = activeIntake(id)!;
    expect(now.noteId).not.toBe(old.noteId);
    expect(now.amend?.requestId).toBe(REQ);
  });

  it('a redelivered cg: (its claim already spent) resumes — never a second wipe', async () => {
    stub.stored = storedOf();
    const id = chat();
    const old = startIntake(id, 'yolkira', { staffId: 'staff-1' });
    stub.claimed = false;
    await press(id, 'restart');
    expect(activeIntake(id)!.noteId).toBe(old.noteId);
    expect(vi.mocked(pressResume)).toHaveBeenCalledTimes(1);
  });

  it('a cg: (or ca:) for the request whose add collection is already live resumes it', async () => {
    stub.stored = storedOf();
    const id = chat();
    await press(id);
    const live = activeIntake(id)!;
    for (const mode of ['restart', 'plain'] as const) {
      vi.mocked(pressResume).mockClear();
      const p = await press(id, mode);
      expect(p.texts()).toEqual([ADD_REFUSAL.sameLive]);
      expect(vi.mocked(pressResume)).toHaveBeenCalledTimes(1);
      expect(activeIntake(id)!.noteId).toBe(live.noteId);
    }
  });

  it('another request’s add collection live → the question, not a resume', async () => {
    stub.stored = storedOf();
    const id = chat();
    await press(id);
    stub.stored = storedOf({}, { requestId: OTHER, cardLabel: 'B-000068' });
    const p = await press(id, 'plain', OTHER);
    expect(p.replies[0]!.text).toContain('B-000068');
    expect(activeIntake(id)!.amend?.requestId).toBe(REQ);
  });
});

describe('a returned request opens a NEW collection with its rows (⭐ of Question 6)', () => {
  it('rows, figures and codes carried; no stored ids; the customer named; the VED’s reason said', async () => {
    stub.stored = storedOf({ ending: 'returned', returnReason: 'kod yo‘q', completedAt: new Date() });
    const id = chat();
    const p = await press(id);
    const state = activeIntake(id)!;
    expect(state.amend).toBeNull();
    expect(state.seed?.map((g) => g.name)).toEqual(['Sumka', 'Krossovka']);
    expect(state.seed?.every((g) => g.itemId === undefined && g.seq === undefined)).toBe(true);
    expect(state.facts.goods?.[0]).toMatchObject({ name: 'Sumka', quantity: 10, tnvedCode: '4202920000' });
    expect(state.clientHintRaw).toBe('GS777');
    expect(state.stage).toBe('review');
    expect(p.texts()[0]).toContain('«kod yo‘q»');
    expect(p.texts()[0]).not.toContain('qayta ochil');
    expect(vi.mocked(deliverNextStep)).toHaveBeenCalledTimes(1);
  });

  it('no customer to name → the customer question first', async () => {
    stub.stored = storedOf({ ending: 'returned', returnReason: 'x', completedAt: new Date() });
    stub.hint = '';
    const id = chat();
    const p = await press(id);
    expect(activeIntake(id)!.stage).toBe('client');
    expect(p.texts().at(-1)).toBe(CLIENT_QUESTION);
    expect(vi.mocked(deliverNextStep)).not.toHaveBeenCalled();
  });

  it('a returned request on a closed lead still seeds (the new one lands where Uch band puts it)', async () => {
    stub.stored = storedOf({ ending: 'returned', returnReason: 'x', completedAt: new Date() }, { entityType: 'lead', leadOpen: false });
    const id = chat();
    await press(id);
    expect(activeIntake(id)!.seed).not.toBeNull();
  });
});
