import 'dotenv/config';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { and, desc, eq, inArray, isNull, sql } from 'drizzle-orm';
import { db } from '@/modules/platform/db/client';
import { agentConfig, agentDrafts, agentOutbox, auditLog, clients, kbFacts, roles, userRoles, users } from '@/modules/platform/db/schema';
import {
  AVIA_RATE_LABEL,
  AgentConfigError,
  __restoreAgentConfig,
  readAgentConfig,
  setAviaRate,
  type AgentConfig,
} from '@/modules/wms/agent/config';
import { agentRules, pageDrawsSend, webDrafts } from '@/modules/wms/agent/web-page';
import { approveStyleGuide } from '@/modules/wms/agent/style';
import {
  AgentCancelError,
  CANCELLED_BY_HOLDER,
  agentSentIds,
  cancelAgentReply,
  waitingAgentReplies,
} from '@/modules/wms/agent/web-thread';
import { addGeneralFact, editKbFact, retireKbFact, RetireError } from '@/modules/wms/agent/web-kb';
import { KbError } from '@/modules/wms/agent/kb';
import { SEED_FACTS } from '@/modules/wms/agent/seed-kb';

/**
 * The web half of the AI sotuvchi (spec §17.12) — the rules a page cannot
 * enforce by drawing less:
 *  - the style guide is approved by the configured owner or the super_admin
 *    ROLE, and only from a proposal;
 *  - a waiting AI reply is taken back by its ACCOUNT HOLDER alone, by a
 *    compare-and-set that loses to the listener once it has started (the read
 *    step done, or 'sending'), and says so;
 *  - the 🤖 marker is derived from agent_outbox by (account, Telegram id).
 *
 * agent_config is a singleton CONFIGURATION row on the one database vitest
 * and Playwright share (#183): snapshotted once, restored in afterAll.
 */

const SUFFIX = String(Date.now()).slice(-7);
let counter = 0;
const next = () => (counter += 1);

let snapshot: AgentConfig | null = null;
let superAdminId = '';
let holderId = '';
let otherId = '';
let clientId = '';
const draftIds: string[] = [];
const factIds: string[] = [];
const madeClients: string[] = [];

async function userWithRole(code: string, not: string[] = []): Promise<string> {
  const rows = await db
    .select({ id: users.id })
    .from(users)
    .innerJoin(userRoles, eq(userRoles.userId, users.id))
    .innerJoin(roles, eq(roles.id, userRoles.roleId))
    .where(and(eq(roles.code, code), eq(users.active, true)));
  const found = rows.find((r) => !not.includes(r.id));
  if (!found) throw new Error(`no active user with role ${code}`);
  return found.id;
}

/** An approved draft and its outbox row, the shape `decideDraft` writes. */
async function waitingReply(over: { readDone?: boolean; status?: string; tgMessageId?: bigint | null } = {}) {
  const n = next();
  const peerId = BigInt(`9${SUFFIX}${String(n).padStart(3, '0')}`);
  const [draft] = await db
    .insert(agentDrafts)
    .values({
      managerUserId: holderId,
      peerId,
      clientId,
      anchorTgMessageId: BigInt(1000 + n),
      proposedBody: `Javob ${SUFFIX}-${n}`,
      status: 'approved',
      decidedBy: holderId,
      decidedAt: new Date(),
    })
    .returning({ id: agentDrafts.id });
  draftIds.push(draft!.id);
  const status = over.status ?? 'agent';
  const [outbox] = await db
    .insert(agentOutbox)
    .values({
      draftId: draft!.id,
      managerUserId: holderId,
      peerId,
      clientId,
      body: `Javob ${SUFFIX}-${n}`,
      randomId: BigInt(`7${SUFFIX}${String(n).padStart(4, '0')}`),
      answersTgMessageId: BigInt(1000 + n),
      status,
      readDone: over.readDone ?? false,
      queuedBy: holderId,
      nextStepAt: new Date(Date.now() + 6 * 3_600_000),
      tgMessageId: over.tgMessageId ?? null,
      ...(status === 'sent' ? { sentAt: new Date() } : {}),
    })
    .returning({ id: agentOutbox.id });
  return { draftId: draft!.id, outboxId: outbox!.id, peerId };
}

beforeAll(async () => {
  snapshot = await readAgentConfig();
  if (!snapshot) throw new Error('0138 is not applied on this database');
  superAdminId = await userWithRole('super_admin');
  holderId = await userWithRole('sales_manager', [superAdminId]);
  otherId = await userWithRole('accountant', [superAdminId, holderId]);
  const [client] = await db.select({ id: clients.id }).from(clients).limit(1);
  clientId = client!.id;
});

afterAll(async () => {
  if (draftIds.length > 0) {
    await db.delete(agentOutbox).where(inArray(agentOutbox.draftId, draftIds));
    await db.delete(agentDrafts).where(inArray(agentDrafts.id, draftIds));
  }
  if (factIds.length > 0) await db.delete(kbFacts).where(inArray(kbFacts.id, factIds));
  // By the run's own words too (#523): a refusal a red proof turns into a
  // write leaves a GENERAL fact that no id list collected, read in every chat.
  await db.delete(kbFacts).where(sql`${kbFacts.question} LIKE ${`%(${SUFFIX})`}`);
  if (madeClients.length > 0) await db.delete(clients).where(inArray(clients.id, madeClients));
  await __restoreAgentConfig(snapshot);
});

const ctx = (actorId: string) => ({ actorId, ip: null, userAgent: null });

describe('approveStyleGuide — the configured owner or the super_admin role, from a proposal', () => {
  const proposal = `Qisqa yozadi, «aka» deb murojaat qiladi. ${SUFFIX}`;

  it('refuses a colleague who is neither', async () => {
    await db
      .update(agentConfig)
      .set({ mode: 'off', ownerUserId: holderId, styleGuideProposed: proposal })
      .where(eq(agentConfig.id, 1));
    await expect(approveStyleGuide({ id: otherId, roles: ['accountant'] }, ctx(otherId))).rejects.toMatchObject({
      code: 'forbidden',
    });
    expect((await readAgentConfig())!.styleGuide).not.toBe(proposal);
  });

  it('lets the configured owner approve — without the super_admin role — and copies the proposal as it stands', async () => {
    const out = await approveStyleGuide({ id: holderId, roles: ['sales_manager'] }, ctx(holderId));
    expect(out.styleGuide).toBe(proposal);
    const [row] = await db.select().from(agentConfig).where(eq(agentConfig.id, 1));
    expect(row!.styleGuide).toBe(proposal);
    expect(row!.styleApprovedBy).toBe(holderId);
    expect(row!.styleApprovedAt).not.toBeNull();
  });

  it('lets the super_admin role approve on somebody else’s account', async () => {
    const out = await approveStyleGuide({ id: superAdminId, roles: ['super_admin'] }, ctx(superAdminId));
    expect(out.styleGuide).toBe(proposal);
  });

  it('refuses when there is nothing proposed', async () => {
    await db.update(agentConfig).set({ styleGuideProposed: null }).where(eq(agentConfig.id, 1));
    const err = await approveStyleGuide({ id: holderId, roles: [] }, ctx(holderId)).catch((e: unknown) => e);
    expect(err).toBeInstanceOf(AgentConfigError);
    expect((err as AgentConfigError).code).toBe('bad_value');
  });
});

describe('cancelAgentReply — the account holder only, a compare-and-set that loses to the listener', () => {
  it('lists the waiting reply for its holder and the supervision view, never for another account', async () => {
    const { outboxId } = await waitingReply();
    const mine = await waitingAgentReplies({ clientId }, { id: holderId });
    expect(mine.map((r) => r.id)).toContain(outboxId);
    const all = await waitingAgentReplies({ clientId }, { id: superAdminId, all: true });
    expect(all.map((r) => r.id)).toContain(outboxId);
    const theirs = await waitingAgentReplies({ clientId }, { id: otherId });
    expect(theirs.map((r) => r.id)).not.toContain(outboxId);
  });

  it('refuses a colleague, even a super_admin — a message leaves a personal account only by its holder', async () => {
    const { outboxId } = await waitingReply();
    for (const who of [otherId, superAdminId]) {
      const err = await cancelAgentReply({ id: who }, outboxId, ctx(who)).catch((e: unknown) => e);
      expect(err).toBeInstanceOf(AgentCancelError);
      expect((err as AgentCancelError).code).toBe('not_account_holder');
    }
    const [row] = await db.select({ status: agentOutbox.status }).from(agentOutbox).where(eq(agentOutbox.id, outboxId));
    expect(row!.status).toBe('agent');
  });

  it('cancels for the holder, once — the second press is «too late», not a second write', async () => {
    const { outboxId } = await waitingReply();
    await cancelAgentReply({ id: holderId }, outboxId, ctx(holderId));
    const [row] = await db.select().from(agentOutbox).where(eq(agentOutbox.id, outboxId));
    expect(row!.status).toBe('cancelled');
    expect(row!.lastError).toBe(CANCELLED_BY_HOLDER);
    await expect(cancelAgentReply({ id: holderId }, outboxId, ctx(holderId))).rejects.toMatchObject({ code: 'too_late' });
  });

  it('loses to a listener that has started: past the read step, or sending', async () => {
    for (const over of [{ readDone: true }, { status: 'sending' }]) {
      const { outboxId } = await waitingReply(over);
      await expect(cancelAgentReply({ id: holderId }, outboxId, ctx(holderId))).rejects.toMatchObject({ code: 'too_late' });
      const [row] = await db.select({ status: agentOutbox.status }).from(agentOutbox).where(eq(agentOutbox.id, outboxId));
      expect(row!.status).toBe(over.status ?? 'agent');
    }
  });
});

describe('the 🤖 marker', () => {
  it('marks exactly the OUT rows whose (account, Telegram id) an agent_outbox row carries', async () => {
    const tgId = BigInt(`5${SUFFIX}${next()}`);
    await waitingReply({ status: 'sent', tgMessageId: tgId });
    const marked = await agentSentIds([
      { id: 'ours', direction: 'out', managerUserId: holderId, tgMessageId: tgId },
      { id: 'inbound-same-id', direction: 'in', managerUserId: holderId, tgMessageId: tgId },
      { id: 'other-account', direction: 'out', managerUserId: otherId, tgMessageId: tgId },
      { id: 'human', direction: 'out', managerUserId: holderId, tgMessageId: tgId + 1n },
    ]);
    expect([...marked]).toEqual(['ours']);
  });
});

describe('the avia rate on «AI qoidalari» (§17.14) — the page’s door, cents at most, audited', () => {
  it('refuses a colleague who is neither the owner nor a super_admin', async () => {
    await db.update(agentConfig).set({ mode: 'off', ownerUserId: holderId }).where(eq(agentConfig.id, 1));
    await expect(setAviaRate({ id: otherId, roles: ['accountant'] }, 18, ctx(otherId))).rejects.toMatchObject({ code: 'forbidden' });
  });

  it('refuses what is not a rate — zero, 1 000, NaN, more than cents — and never rounds', async () => {
    for (const bad of [0, -1, 1000, Number.NaN, 17.555]) {
      await expect(setAviaRate({ id: holderId, roles: [] }, bad, ctx(holderId)), String(bad)).rejects.toMatchObject({ code: 'bad_value' });
    }
  });

  it('the owner sets it (stamped, audited, read back by every run); empty = avia is not quoted', async () => {
    const out = await setAviaRate({ id: holderId, roles: ['sales_manager'] }, 18.5, ctx(holderId));
    expect(out).toMatchObject({ aviaUsdPerKg: 18.5, aviaRateSetBy: holderId });
    expect(out.aviaRateSetAt).not.toBeNull();
    expect((await readAgentConfig())!.aviaUsdPerKg).toBe(18.5);
    expect(agentRules((await readAgentConfig())!).avia).toMatchObject({ usdPerKg: 18.5, minKg: 1, daysMin: 2, daysMax: 5 });
    const [audit] = await db
      .select()
      .from(auditLog)
      .where(and(eq(auditLog.entityType, 'agent_config'), eq(auditLog.actorId, holderId)))
      .orderBy(desc(auditLog.id))
      .limit(1);
    expect(audit!.after).toMatchObject({ aviaUsdPerKg: 18.5 });
    const cleared = await setAviaRate({ id: superAdminId, roles: ['super_admin'] }, null, ctx(superAdminId));
    expect(cleared.aviaUsdPerKg).toBeNull();
  });
});

describe('a fact’s words corrected — the old row retired, a new approved one in its place', () => {
  it('writes the new words, names what they replace, and retires the old', async () => {
    const id = await addGeneralFact({ question: 'Ish vaqti?', answer: `Dushanba–juma ishlaymiz. ${SUFFIX}` }, ctx(holderId));
    factIds.push(id);
    const next = await editKbFact(id, { question: 'Ish vaqti?', answer: `Dushanba–shanba ishlaymiz. ${SUFFIX}` }, ctx(holderId));
    factIds.push(next);
    expect(next).not.toBe(id);
    const [old] = await db.select().from(kbFacts).where(eq(kbFacts.id, id));
    expect(old!.retiredAt).not.toBeNull();
    const [row] = await db.select().from(kbFacts).where(eq(kbFacts.id, next));
    expect(row).toMatchObject({ scope: 'general', answer: `Dushanba–shanba ishlaymiz. ${SUFFIX}`, retiredAt: null, approvedBy: holderId });
    expect(row!.sourceRef).toMatchObject({ door: 'web', replaces: id });
    // The same words again change nothing.
    expect(await editKbFact(next, { question: 'Ish vaqti?', answer: `Dushanba–shanba ishlaymiz. ${SUFFIX}` }, ctx(holderId))).toBe(next);
    // A retired fact is not edited.
    await expect(editKbFact(id, { question: null, answer: `Boshqa ${SUFFIX}` }, ctx(holderId))).rejects.toMatchObject({ code: 'already_retired' });
  });

  it('refuses a price BEFORE anything moves — the old fact stays live, no new row', async () => {
    const id = await addGeneralFact({ question: null, answer: `Ombor 9:00 da ochiladi. ${SUFFIX}` }, ctx(holderId));
    factIds.push(id);
    const before = await db.select({ id: kbFacts.id }).from(kbFacts).where(sql`${kbFacts.answer} LIKE ${`%${SUFFIX}%`}`);
    await expect(editKbFact(id, { question: null, answer: `Yo‘lkira 1 kub 110 $ ${SUFFIX}` }, ctx(holderId))).rejects.toBeInstanceOf(KbError);
    const [still] = await db.select().from(kbFacts).where(eq(kbFacts.id, id));
    expect(still!.retiredAt).toBeNull();
    const after = await db.select({ id: kbFacts.id }).from(kbFacts).where(sql`${kbFacts.answer} LIKE ${`%${SUFFIX}%`}`);
    expect(after.length).toBe(before.length);
  });
});

describe('Bilimlar on the page — the one kb writer, and retiring', () => {
  it('refuses a price as knowledge and a customer’s phone in a general fact', async () => {
    await expect(addGeneralFact({ question: null, answer: `Yo‘lkira 1 kub 110 $ ${SUFFIX}` }, ctx(holderId))).rejects.toBeInstanceOf(KbError);
    const err = await addGeneralFact({ question: null, answer: `Qo‘ng‘iroq qiling +998 90 123 45 67 ${SUFFIX}` }, ctx(holderId)).catch(
      (e: unknown) => e,
    );
    expect((err as KbError).code).toBe('personal');
  });

  it('writes a clean general fact, retires it once, and keeps the row', async () => {
    const id = await addGeneralFact({ question: 'Ish vaqti?', answer: `Dushanba–shanba ishlaymiz. ${SUFFIX}` }, ctx(holderId));
    factIds.push(id);
    await retireKbFact(id, ctx(holderId));
    const [row] = await db.select().from(kbFacts).where(eq(kbFacts.id, id));
    expect(row!.retiredAt).not.toBeNull();
    expect(row!.scope).toBe('general');
    await expect(retireKbFact(id, ctx(holderId))).rejects.toBeInstanceOf(RetireError);
    const live = await db.select({ id: kbFacts.id }).from(kbFacts).where(and(eq(kbFacts.id, id), isNull(kbFacts.retiredAt)));
    expect(live).toEqual([]);
  });
});

describe('his own seeded facts can be edited (review A7) — only a NEW personal bit is refused', () => {
  /** A live approved general fact with exactly this text — the shape the seed and the page leave. */
  async function fact(question: string, answer: string): Promise<string> {
    const [row] = await db
      .insert(kbFacts)
      .values({ scope: 'general', question, answer, locale: 'uz', source: 'owner', approvedAt: new Date(), approvedBy: holderId })
      .returning({ id: kbFacts.id });
    factIds.push(row!.id);
    return row!.id;
  }

  it('edits the minimum, the Toshkent sklad and its map — the facts the mask reads a code or a phone in', async () => {
    for (const key of ['min_shipment@1', 'tashkent_warehouse@1', 'tashkent_map@1']) {
      const seed = SEED_FACTS.find((f) => f.key === key)!;
      const id = await fact(seed.question, seed.answer);
      const next = await editKbFact(id, { question: `${seed.question} (${SUFFIX})`, answer: seed.answer }, ctx(holderId));
      factIds.push(next);
      expect(next, key).not.toBe(id);
      const [row] = await db.select().from(kbFacts).where(eq(kbFacts.id, next));
      expect(row, key).toMatchObject({ scope: 'general', answer: seed.answer, retiredAt: null, approvedBy: holderId, source: 'owner' });
      expect(row!.sourceRef).toMatchObject({ door: 'web', replaces: id });
      const [old] = await db.select({ retiredAt: kbFacts.retiredAt }).from(kbFacts).where(eq(kbFacts.id, id));
      expect(old!.retiredAt, key).not.toBeNull();
    }
  });

  it('the same phone written another way is not a new one; a different phone is, and nothing moves', async () => {
    const seed = SEED_FACTS.find((f) => f.key === 'tashkent_warehouse@1')!;
    const id = await fact(seed.question, seed.answer);
    const spaced = await editKbFact(id, { question: seed.question, answer: seed.answer.replace('+998 95 018 30 33', '+998950183033') }, ctx(holderId));
    factIds.push(spaced);
    const before = await db.select({ id: kbFacts.id }).from(kbFacts).where(isNull(kbFacts.retiredAt));
    const err = await editKbFact(spaced, { question: seed.question, answer: `${seed.answer} Yoki +998 90 111 22 33.` }, ctx(holderId)).catch(
      (e: unknown) => e,
    );
    expect(err).toBeInstanceOf(KbError);
    expect((err as KbError).code).toBe('personal');
    const after = await db.select({ id: kbFacts.id }).from(kbFacts).where(isNull(kbFacts.retiredAt));
    expect(after.length).toBe(before.length);
    const [still] = await db.select({ retiredAt: kbFacts.retiredAt }).from(kbFacts).where(eq(kbFacts.id, spaced));
    expect(still!.retiredAt).toBeNull();
  });

  it('the minimum and the map are no personal facts at all — typed afresh on the page, both are written (answers review)', async () => {
    for (const key of ['min_shipment@1', 'tashkent_map@1']) {
      const seed = SEED_FACTS.find((f) => f.key === key)!;
      const id = await addGeneralFact({ question: `${seed.question} (${SUFFIX})`, answer: seed.answer }, ctx(holderId));
      factIds.push(id);
      const [row] = await db.select().from(kbFacts).where(eq(kbFacts.id, id));
      expect(row, key).toMatchObject({ scope: 'general', answer: seed.answer, retiredAt: null, source: 'owner' });
    }
  });

  it('an edit is written by the one writer: the kept phone passes, a new code beside it does not', async () => {
    const seed = SEED_FACTS.find((f) => f.key === 'tashkent_warehouse@1')!;
    const id = await fact(seed.question, seed.answer);
    const err = await editKbFact(id, { question: seed.question, answer: `${seed.answer} GS555 ham shu yerdan oladi.` }, ctx(holderId)).catch(
      (e: unknown) => e,
    );
    expect((err as KbError).code).toBe('personal');
    expect((err as KbError).detail).toBe('GS555');
    const [still] = await db.select({ retiredAt: kbFacts.retiredAt }).from(kbFacts).where(eq(kbFacts.id, id));
    expect(still!.retiredAt).toBeNull();
  });

  it('a code written with a space is refused when the client book holds it — and only then (cards review)', async () => {
    const digits = SUFFIX.slice(-5);
    const [c] = await db
      .insert(clients)
      .values({ clientCode: `KB${digits}`, name: `Bo‘shliqli kod ${SUFFIX}`, phones: [] })
      .returning({ id: clients.id });
    madeClients.push(c!.id);
    const err = await addGeneralFact(
      { question: `Qayerda turadi? (${SUFFIX})`, answer: `KB ${digits} mijozimizning yuki Qashqarda turadi.` },
      ctx(holderId),
    ).catch((e: unknown) => e);
    expect(err).toBeInstanceOf(KbError);
    expect((err as KbError).code).toBe('personal');
    expect((err as KbError).detail).toBe(`KB${digits}`);
    expect(await db.select({ id: kbFacts.id }).from(kbFacts).where(sql`${kbFacts.question} = ${`Qayerda turadi? (${SUFFIX})`}`)).toHaveLength(0);
    // A word and a number a space apart that the book does NOT hold are two words.
    const id = await addGeneralFact({ question: `Qachon keladi? (${SUFFIX})`, answer: 'Yuk 30 kunda yetib keladi.' }, ctx(holderId));
    factIds.push(id);
  });

  it('a money figure is still refused on an inherited-bits fact', async () => {
    const seed = SEED_FACTS.find((f) => f.key === 'min_shipment@1')!;
    const id = await fact(seed.question, seed.answer);
    await expect(editKbFact(id, { question: seed.question, answer: `${seed.answer} Narxi 110 $.` }, ctx(holderId))).rejects.toMatchObject({
      code: 'money',
    });
  });
});

describe('a new avia rate retires the pending drafts quoted at the old one (review A3)', () => {
  async function draft(sources: { value: number; kind: string; label: string }[], status = 'pending') {
    const n = next();
    const [row] = await db
      .insert(agentDrafts)
      .values({
        managerUserId: holderId,
        peerId: BigInt(`8${SUFFIX}${String(n).padStart(3, '0')}`),
        clientId,
        anchorTgMessageId: BigInt(2000 + n),
        proposedBody: `Avia ${SUFFIX}-${n}`,
        status,
        policy: { blocks: [], warnings: [], ledger: [], notes: [], memory: { sources } },
      })
      .returning({ id: agentDrafts.id });
    draftIds.push(row!.id);
    return row!.id;
  }
  const avia = (rate: number) => [
    { value: rate * 40, kind: 'money', label: 'avia (tarif × kg)' },
    { value: rate, kind: 'money', label: AVIA_RATE_LABEL },
  ];
  const statusOf = async (id: string) => (await db.select().from(agentDrafts).where(eq(agentDrafts.id, id)))[0]!;

  it('supersedes only pending drafts at another rate, marks why, and leaves his own words and other replies alone', async () => {
    await db.update(agentConfig).set({ mode: 'off', ownerUserId: holderId }).where(eq(agentConfig.id, 1));
    await setAviaRate({ id: holderId, roles: [] }, 17, ctx(holderId));
    const old = await draft(avia(17));
    const same = await draft(avia(18));
    const editing = await draft(avia(17), 'editing');
    const plain = await draft([{ value: 50, kind: 'money', label: "yo'lkira (sayt kalkulyatori)" }]);

    await setAviaRate({ id: holderId, roles: [] }, 18, ctx(holderId));
    expect(await statusOf(old)).toMatchObject({ status: 'superseded', policy: expect.objectContaining({ stale: 'avia_rate' }) });
    expect((await statusOf(same)).status).toBe('pending');
    expect((await statusOf(editing)).status).toBe('editing');
    expect((await statusOf(plain)).status).toBe('pending');

    // Avia switched off: every pending avia figure stops, whatever its rate.
    await setAviaRate({ id: holderId, roles: [] }, null, ctx(holderId));
    expect((await statusOf(same)).status).toBe('superseded');
    expect((await statusOf(plain)).status).toBe('pending');
  });
});

describe('the page’s ✅ follows the bot’s card (C7, C10 a)', () => {
  async function live(over: { finalBody?: string | null; status?: string }) {
    const n = next();
    const [row] = await db
      .insert(agentDrafts)
      .values({
        managerUserId: holderId,
        peerId: BigInt(`6${SUFFIX}${String(n).padStart(3, '0')}`),
        clientId,
        anchorTgMessageId: BigInt(3000 + n),
        proposedBody: `Salom ${SUFFIX}-${n}`,
        finalBody: over.finalBody ?? null,
        status: over.status ?? 'pending',
        policy: { blocks: [], warnings: [], ledger: [], notes: [] },
      })
      .returning({ id: agentDrafts.id });
    draftIds.push(row!.id);
    return row!.id;
  }

  it('a card too long to show is blocked on the page too, and says so in its text', async () => {
    const cut = await live({ finalBody: 'Ш'.repeat(3800) });
    const drawn = (await webDrafts({ id: holderId })).pending.find((d) => d.id === cut)!;
    expect(drawn.blocked).toBe(true);
    expect(drawn.cardText).toContain('✅ yo‘q');
    expect(pageDrawsSend(drawn)).toBe(false);
  });

  it('a draft he pressed ✏️ on and wrote nothing for keeps its ✅; with his words, not until he sends new ones', async () => {
    const unused = await live({ status: 'editing' });
    const own = await live({ status: 'editing', finalBody: 'Ertaga aytaman.' });
    const page = (await webDrafts({ id: holderId })).pending;
    const a = page.find((d) => d.id === unused)!;
    const b = page.find((d) => d.id === own)!;
    expect(a.ownText).toBe(false);
    expect(pageDrawsSend(a)).toBe(true);
    expect(b.ownText).toBe(true);
    expect(pageDrawsSend(b)).toBe(false);
    // The page's own words for the editing line name the bot AND the page's box.
    expect(a.cardText).toContain('✏️ Botda tahrir boshlangan');
  });
});
