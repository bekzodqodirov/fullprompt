import 'dotenv/config';
import { randomUUID } from 'node:crypto';
import { eq } from 'drizzle-orm';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { db } from '@/modules/platform/db/client';
import { settings } from '@/modules/platform/db/schema';
import { autoVerdict } from '@/modules/wms/agent/auto-gate';
import { autoFactsFor, type AutoDraftShape } from '@/modules/wms/agent/auto-send';

/**
 * Stage 1a's kernel (K5 + K6) as `autoFactsFor` reads it off a stored draft — the half a hand-built gate input
 * cannot see: the codes come from the stored policy (a draft stored before 1a with notes and no codes is a stop), the
 * tayyor matn mark from `policy.system`, the two chat facts the packages fill are false, and his night setting is
 * read from the settings table (a value typed into it by hand is never guessed at).
 *
 * `agent_night_prices` is CONFIGURATION (#183): its stored row is snapshotted and put back.
 */

const NOON = new Date('2026-11-11T07:00:00Z');

let stored: { value: unknown; updatedBy: string | null } | null = null;

beforeAll(async () => {
  const [row] = await db.select({ value: settings.value, updatedBy: settings.updatedBy }).from(settings).where(eq(settings.key, 'agent_night_prices'));
  stored = row ?? null;
});

afterAll(async () => {
  await db.delete(settings).where(eq(settings.key, 'agent_night_prices'));
  if (stored) await db.insert(settings).values({ key: 'agent_night_prices', value: stored.value, updatedBy: stored.updatedBy });
});

const night = async (value: unknown) => {
  await db.delete(settings).where(eq(settings.key, 'agent_night_prices'));
  if (value !== undefined) await db.insert(settings).values({ key: 'agent_night_prices', value, updatedBy: null });
};

/** A reply draft as `autoFactsFor` reads one — a chat nobody else has, so every chat fact reads empty. */
const shape = (policy: Record<string, unknown>): AutoDraftShape => ({
  managerUserId: randomUUID(),
  peerId: BigInt(900_000_000 + Math.floor(Math.random() * 1_000_000)),
  runId: null,
  clientId: null,
  leadId: null,
  anchorTgMessageId: 10n,
  kind: 'reply',
  status: 'pending',
  finalBody: null,
  proposedBody: 'Assalomu alaykum! Qanday yordam bera olaman?',
  blocked: false,
  needsOwner: false,
  category: 'greeting',
  language: 'uz',
  confidence: '0.90',
  policy,
  actions: [],
});

const facts = (policy: Record<string, unknown>) => autoFactsFor(shape(policy), { at: NOON, now: NOON, config: null });

describe('the gate’s stage-1a facts, read off the stored draft', () => {
  it('codes from the stored policy, the tayyor matn mark from `policy.system`, the packages’ two facts false', async () => {
    const f = await facts({
      warnings: [{ rule: 'G2', code: 'questions' }],
      notes: ['Bu chatda ochiq hisoblatish bor — ikkinchisi yuborilmaydi.'],
      noteCodes: ['calc_open'],
      system: 'voice',
    });
    expect(f.draft.warningCodes).toEqual(['questions']);
    expect(f.draft.noteCodes).toEqual(['calc_open']);
    expect(f.draft.systemAck).toBe(true);
    expect(f.loop).toBe(false);
    expect(f.complaint).toBe(false);
  });

  it('a draft stored before 1a — notes, no codes — reads null, and the gate refuses it as a note', async () => {
    const f = await facts({ warnings: [], notes: ['⏱ Mijoz 12 daqiqadan beri javob kutyapti'] });
    expect(f.draft.noteCodes).toBeNull();
    expect(autoVerdict(f).reasons).toContain('notes');
    const none = await facts({ warnings: [], notes: [] });
    expect(none.draft.noteCodes).toEqual([]);
    expect(none.draft.systemAck).toBe(false);
  });

  it('his night setting: the stored value, the default when there is none or it is not one of the three', async () => {
    await night(undefined);
    expect((await facts({})).nightPrices).toBe('table');
    await night('none');
    expect((await facts({})).nightPrices).toBe('none');
    await night('all');
    expect((await facts({})).nightPrices).toBe('all');
    await night('hammasi');
    expect((await facts({})).nightPrices).toBe('table');
  });
});
