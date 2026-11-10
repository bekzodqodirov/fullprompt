import { afterEach, describe, expect, it, vi } from 'vitest';

/**
 * A collection opened ON a stored request takes its `ai` from the request's
 * door (docs/IKKI-ESHIK.md §0.3): «➕ Shu so‘rovga qo‘shish» on an open
 * request (the add door) and on a returned one (the seeded door). 'plain' →
 * false, 'ai' → true, NULL → exactly the flag each door set before 0141 —
 * the add door's `true`, the seeded door's «a customs section». The press is
 * the real one; the stored request, its standing and the staff member are
 * stand-ins, as in calc-amend-press.test.ts.
 */
const stub = vi.hoisted(() => ({
  stored: null as null | Record<string, unknown>,
  certificate: true as boolean | null,
}));
vi.mock('@/modules/platform/telegram/staff-bot', async (original) => ({
  ...(await original<typeof import('@/modules/platform/telegram/staff-bot')>()),
  staffForChat: async () => ({ id: 'staff-1', fullName: 'Ali' }),
}));
vi.mock('@/modules/wms/calc/service', async (original) => ({
  ...(await original<typeof import('@/modules/wms/calc/service')>()),
  storedRequestFacts: async (id: string) =>
    stub.stored && (stub.stored.base as { requestId: string }).requestId === id ? stub.stored : null,
}));
vi.mock('@/modules/wms/calc/amend', async (original) => ({
  ...(await original<typeof import('@/modules/wms/calc/amend')>()),
  amendStanding: async () => ({ standing: 'open', rev: 3, handsoffRev: 3, completedVia: null, returnReason: null, ending: null }),
  returnedClientHint: async () => 'GS777',
  requestHasCertificate: async () => stub.certificate,
}));
vi.mock('@/modules/wms/calc/law-asks', async (original) => ({
  ...(await original<typeof import('@/modules/wms/calc/law-asks')>()),
  lawAsksOf: () => [],
}));
vi.mock('@/modules/platform/telegram/press', async (original) => ({
  ...(await original<typeof import('@/modules/platform/telegram/press')>()),
  answerPress: async () => 'answered',
}));
vi.mock('@/modules/platform/telegram/calc-dialog', async (original) => ({
  ...(await original<typeof import('@/modules/platform/telegram/calc-dialog')>()),
  deliverNextStep: vi.fn(async () => {}),
}));

import { collectionAiOf, pressAdd } from '@/modules/platform/telegram/calc-amend';
import { intakeNextStep } from '@/modules/platform/telegram/calc-dialog';
import { activeIntake, endIntake } from '@/modules/platform/telegram/calc-store';
import * as intake from '@/modules/wms/calc/intake';
import type { IntakeDoor } from '@/modules/wms/calc/intake';
import { nameWordFor } from '@/modules/wms/calc/line-address';

const REQ = '01234567-89ab-7def-8123-456789abcd41';
const I1 = '01234567-89ab-7def-8123-456789abcd51';

function storedOf(door: IntakeDoor | null, section: string, ending: string | null) {
  const base = {
    requestId: REQ,
    cardLabel: 'B-000067',
    entityType: 'deal',
    entityId: '01234567-89ab-7def-8123-456789abcd61',
    leadOpen: null,
    section,
    door,
    clientLabel: 'GS777',
    openedRev: 3,
    items: [
      { itemId: I1, seq: 1, name: 'Sumka', quantity: 10, weightKg: null, volumeM3: null, measureUnit: null, measureQty: null, tnvedCode: null, law: null, confirmed: false },
    ],
    weightKg: 500,
    volumeM3: 3,
    fromCity: null,
    toCity: null,
  };
  return {
    base,
    facts: { weightKg: 500, volumeM3: 3, goods: [{ name: 'Sumka', quantity: 10, itemId: I1, seq: 1 }] },
    door,
    rev: 3,
    handsoffRev: 3,
    aiPassRev: null,
    aiPassAt: null,
    aiPassJob: null,
    requestedBy: 'staff-1',
    completedAt: ending ? new Date() : null,
    completedVia: ending === 'returned' ? 'returned' : null,
    returnReason: ending === 'returned' ? 'x' : null,
    ending,
  };
}

let seq = 0;
const chats: bigint[] = [];
function chat(): bigint {
  seq += 1;
  const id = BigInt(-7_600_000_000) - BigInt(seq);
  chats.push(id);
  return id;
}

afterEach(() => {
  for (const id of chats.splice(0)) endIntake(id);
  stub.stored = null;
  stub.certificate = true;
});

async function opened(door: IntakeDoor | null, section: string, ending: string | null) {
  stub.stored = storedOf(door, section, ending);
  const id = chat();
  const ctx = {
    reply: async () => ({ message_id: 9001 }),
    callbackQuery: { message: { message_id: 77 } },
    answerCallbackQuery: async () => true,
    api: { editMessageText: async () => true },
  };
  await pressAdd(ctx as never, id, REQ, 'plain', null);
  return activeIntake(id)!;
}

describe('the rule', () => {
  it('the request’s door decides; NULL keeps the door’s own legacy flag', () => {
    expect(collectionAiOf('plain', true)).toBe(false);
    expect(collectionAiOf('ai', false)).toBe(true);
    expect(collectionAiOf(null, true)).toBe(true);
    expect(collectionAiOf(null, false)).toBe(false);
    // A base hydrated from before 0141 carries no door at all.
    expect(collectionAiOf(undefined, true)).toBe(true);
  });
});

describe('the ➕ add door on an open request', () => {
  it('plain → a plain collection, ai → an AI one, legacy → the add door’s `true` of today', async () => {
    expect((await opened('plain', 'rastamojka', null)).ai).toBe(false);
    expect((await opened('ai', 'rastamojka', null)).ai).toBe(true);
    expect((await opened(null, 'rastamojka', null)).ai).toBe(true);
    // It IS the add collection in each case.
    expect((await opened('plain', 'podklyuch', null)).amend?.requestId).toBe(REQ);
  });

  it('the base it opens with carries the door, for every later reader of the add collection', async () => {
    expect((await opened('plain', 'rastamojka', null)).amend?.door).toBe('plain');
    expect((await opened(null, 'rastamojka', null)).amend?.door).toBeNull();
  });
});

describe('the seeded door on a returned request', () => {
  it('plain → plain, ai → ai, legacy → «a customs section» of today', async () => {
    const plain = await opened('plain', 'rastamojka', 'returned');
    expect(plain.seed).not.toBeNull();
    expect(plain.ai).toBe(false);
    expect((await opened('ai', 'rastamojka', 'returned')).ai).toBe(true);
    expect((await opened(null, 'rastamojka', 'returned')).ai).toBe(true);
    expect((await opened(null, 'podklyuch', 'returned')).ai).toBe(true);
    expect((await opened(null, 'yolkira', 'returned')).ai).toBe(false);
  });
});

describe('a plain request’s seeded collection and the certificate (K review KU-2, stated)', () => {
  /** The table as the collection would draw it — the real renderer over no laws. */
  const tableOf = (state: ReturnType<typeof activeIntake>) =>
    intakeNextStep(state!, new Map(), intake, { nameWord: nameWordFor });
  const certButtons = (keyboard: { inline_keyboard: { callback_data?: string }[][] } | null | undefined) =>
    (keyboard?.inline_keyboard ?? []).flat().filter((b) => (b.callback_data ?? '').startsWith('c:cert_'));

  it('the «sertifikat yo‘q» the VED set is carried onto the new request — but the plain door draws no certificate control', async () => {
    stub.certificate = false;
    const plain = await opened('plain', 'rastamojka', 'returned');
    expect(plain.ai).toBe(false);
    // It lands with the request (calc-amend.ts openSeeded), as before 0141…
    expect(plain.hasCertificate).toBe(false);
    // …and nothing on the plain collection says so: no «📄 Sertifikat» line,
    // no toggle — the plain door never had one (§2.1). A change K makes on a
    // 'plain' request only; a legacy request still opens AI-flagged.
    const shown = tableOf(plain);
    expect(shown.text).not.toContain('📄 Sertifikat');
    expect(certButtons(shown.keyboard)).toEqual([]);

    const legacy = tableOf(await opened(null, 'rastamojka', 'returned'));
    expect(legacy.text).toContain('📄 Sertifikat: yo‘q');
    expect(certButtons(legacy.keyboard)).toHaveLength(1);
  });
});
