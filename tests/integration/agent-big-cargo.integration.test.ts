import 'dotenv/config';
import { and, eq, inArray, sql } from 'drizzle-orm';
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { db } from '@/modules/platform/db/client';
import {
  agentConfig,
  agentDesignations,
  agentSignals,
  auditLog,
  clients,
  leadSources,
  leadStages,
  leads,
  notifications,
  roles,
  settings,
  userRoles,
  users,
} from '@/modules/platform/db/schema';
import { __forgetAgentToliq1aReady, __pretendAgentToliq1aBehind, __restoreAgentConfig, readAgentConfig, type AgentConfig } from '@/modules/wms/agent/config';
import type { AgentContext, ChatIdentity, ChatMessage, MeasureCandidate } from '@/modules/wms/agent/context';
import { bigCargoWeek, readBigCargoSettings, signalBigCargo } from '@/modules/wms/agent/big-cargo';
import { readLivenessMinutes } from '@/modules/wms/agent/liveness';
import { SignalSettingError, setBigCargoSettings, setLivenessMinutes } from '@/modules/wms/agent/signal-settings';
import { kimgaPanel } from '@/modules/wms/agent/signal-page';
import { PURGED_CARD_TEXT, purgeAgentChat } from '@/modules/wms/agent/purge';
import { dropDrainKicksSince } from './drain-kicks';

/**
 * The big-cargo signal against a real database (stage 1a §4.5, his 3 b; §7's big-cargo row): ONE claim per chat per
 * week (`agent_signals.dedupe_key`), its copies queued in the claim's own transaction to the people designated for
 * «Katta yuk signali», each copy as THAT recipient may read it — the card's name and link only past the card's own
 * door — and every copy carrying the chat it is about, so a purge blanks the colleagues' copies too (J15). One
 * migration behind: nothing claimed, nothing sent, nothing thrown.
 *
 * Clocks are LITERALS (#1790). agent_designations, agent_config and the three settings are CONFIGURATION (#183) — put back in afterAll; fixture users are
 * deactivated, never deleted (the audit FK).
 */

const SUFFIX = String(Date.now()).slice(-6);
const KICKS_FROM = new Date().toISOString();
const MONDAY = new Date('2026-11-16T06:00:00Z');
const TUESDAY = new Date('2026-11-17T06:00:00Z');
const NEXT_WEEK = new Date('2026-11-23T06:00:00Z');
let peerSeq = BigInt(`56${SUFFIX}00`);

const ids = { holder: '', boss: '', plain: '', lead: '', client: '' };
let superRoleId = '';
let designationSnapshot: (typeof agentDesignations.$inferSelect)[] = [];
let configSnapshot: AgentConfig | null = null;

async function minted(label: string, n: number): Promise<string> {
  const [u] = await db
    .insert(users)
    .values({ phone: `+99896${SUFFIX}${String(n).padStart(2, '0')}`, fullName: `Fura ${label} ${SUFFIX}`, passwordHash: 'x' })
    .returning({ id: users.id });
  return u!.id;
}

function nextPeer(): bigint {
  peerSeq += 1n;
  return peerSeq;
}

function chat(peer: bigint, body: string, identity: Partial<ChatIdentity>, measures: MeasureCandidate[] = []): Pick<AgentContext, 'managerUserId' | 'peerId' | 'burst' | 'measures' | 'identity'> {
  const burst = [{ ref: '#1', id: 'm1', tgMessageId: 1n, direction: 'in', body, sentAt: MONDAY, media: null } as unknown as ChatMessage];
  return {
    managerUserId: ids.holder,
    peerId: peer,
    burst,
    measures,
    identity: { clientId: null, leadId: null, strength: null, codes: [], customerName: null, managerName: null, cargoAllowed: false, ...identity },
  };
}

const copies = (userId: string) =>
  db
    .select({ payload: notifications.payload })
    .from(notifications)
    .where(and(eq(notifications.userId, userId), eq(notifications.type, 'AgentSignal')))
    .then((rows) => rows.map((r) => r.payload as { text: string; managerUserId: string; peerId: string }));

beforeAll(async () => {
  __forgetAgentToliq1aReady();
  designationSnapshot = await db.select().from(agentDesignations).where(inArray(agentDesignations.topic, ['supervisor', 'big_cargo']));
  configSnapshot = await readAgentConfig();
  ids.holder = await minted('egasi', 1);
  ids.boss = await minted('rahbar', 2);
  ids.plain = await minted('oddiy', 3);
  const r = await db.query.roles.findFirst({ where: eq(roles.code, 'super_admin') });
  superRoleId = r!.id;
  await db.insert(userRoles).values({ userId: ids.boss, roleId: superRoleId });
  const [source] = await db.select({ id: leadSources.id }).from(leadSources).limit(1);
  const [stage] = await db.select({ id: leadStages.id }).from(leadStages).where(eq(leadStages.kind, 'open')).orderBy(leadStages.sortOrder).limit(1);
  const [lead] = await db
    .insert(leads)
    .values({ name: `Katta lid ${SUFFIX}`, phone: `+99895${SUFFIX}41`, stageId: stage!.id, sourceId: source!.id, ownerId: ids.holder })
    .returning({ id: leads.id });
  ids.lead = lead!.id;
  const [c] = await db
    .insert(clients)
    .values({ clientCode: `FK${SUFFIX}`, name: `Fura mijoz ${SUFFIX}`, phones: [`+99895${SUFFIX}42`], salesManagerId: ids.holder })
    .returning({ id: clients.id });
  ids.client = c!.id;
});

beforeEach(async () => {
  __forgetAgentToliq1aReady();
  await db.delete(agentDesignations).where(inArray(agentDesignations.topic, ['supervisor', 'big_cargo']));
  await db.insert(agentDesignations).values([
    { topic: 'big_cargo', userId: ids.boss, rank: 1 },
    { topic: 'big_cargo', userId: ids.plain, rank: 2 },
  ]);
  await db.delete(notifications).where(inArray(notifications.userId, [ids.holder, ids.boss, ids.plain]));
});

afterAll(async () => {
  __forgetAgentToliq1aReady();
  await dropDrainKicksSince(KICKS_FROM);
  await db.delete(agentSignals).where(eq(agentSignals.managerUserId, ids.holder));
  await __restoreAgentConfig(configSnapshot);
  await db.delete(agentDesignations).where(inArray(agentDesignations.topic, ['supervisor', 'big_cargo']));
  if (designationSnapshot.length > 0) await db.insert(agentDesignations).values(designationSnapshot);
  const fixture = [ids.holder, ids.boss, ids.plain].filter(Boolean);
  await db.delete(notifications).where(inArray(notifications.userId, fixture));
  await db.delete(userRoles).where(and(eq(userRoles.roleId, superRoleId), inArray(userRoles.userId, fixture)));
  await db.update(users).set({ active: false }).where(inArray(users.id, fixture));
});

describe('the signal, once per chat per week, to the people he chose', () => {
  it('24 kub said in the burst: ONE claim and one copy each; a recipient the lead’s door admits reads its name and link, the other neither', async () => {
    const peer = nextPeer();
    const ctx = chat(peer, '24 kub 5200 kg Yiwudan', { leadId: ids.lead }, [
      { ref: 'v1', kind: 'volume', value: 24, messageRef: '#1' },
      { ref: 'w1', kind: 'weight', value: 5200, messageRef: '#1' },
    ]);
    expect(await signalBigCargo(ctx, [], MONDAY)).toBe(true);
    const [claim] = await db.select().from(agentSignals).where(and(eq(agentSignals.managerUserId, ids.holder), eq(agentSignals.peerId, peer)));
    expect(claim).toMatchObject({ topic: 'big_cargo', leadId: ids.lead, clientId: null, dedupeKey: `big_cargo:${ids.holder}:${peer}:${bigCargoWeek(MONDAY)}` });
    expect(claim!.facts).toEqual({ m3: 24, kg: 5200, by: 'size' });

    const [bossCopy] = await copies(ids.boss);
    const [plainCopy] = await copies(ids.plain);
    expect(bossCopy!.text.split('\n')[0]).toBe('🚛 Katta yuk: 24 kub · 5 200 kg · AI javob tayyorladi.');
    expect(bossCopy!.text).toContain(`👤 Katta lid ${SUFFIX}`);
    expect(bossCopy!.text.split('\n').at(-1)).toMatch(new RegExp(`/crm/leads/${ids.lead}$`, 'u'));
    expect(plainCopy!.text).toBe('🚛 Katta yuk: 24 kub · 5 200 kg · AI javob tayyorladi.');
    // Never the customer's words.
    for (const c of [bossCopy!, plainCopy!]) expect(c.text).not.toContain('Yiwudan');
    // Both keys the purge finds a signal by (J15), on every copy.
    for (const c of [bossCopy!, plainCopy!]) expect({ managerUserId: c.managerUserId, peerId: c.peerId }).toEqual({ managerUserId: ids.holder, peerId: String(peer) });
    // The account holder is told nothing he was not designated for.
    expect(await copies(ids.holder)).toEqual([]);
  });

  it('the same chat again this week: no second claim, no second copy; next week, one more', async () => {
    const peer = nextPeer();
    const ctx = chat(peer, 'yana 30 kub', { leadId: ids.lead }, [{ ref: 'v1', kind: 'volume', value: 30, messageRef: '#1' }]);
    expect(await signalBigCargo(ctx, [], MONDAY)).toBe(true);
    expect(await signalBigCargo(ctx, [], TUESDAY)).toBe(false);
    expect(await copies(ids.boss)).toHaveLength(1);
    expect(await signalBigCargo(ctx, [], NEXT_WEEK)).toBe(true);
    expect(await copies(ids.boss)).toHaveLength(2);
  });

  it('«fura» alone signals; a load under the line does not', async () => {
    const words = nextPeer();
    expect(await signalBigCargo(chat(words, 'Assalomu alaykum, fura kerak', { leadId: ids.lead }), [], MONDAY)).toBe(true);
    const [copy] = await copies(ids.plain);
    expect(copy!.text).toBe('🚛 Katta yuk: to‘liq mashina (fura) · AI javob tayyorladi.');
    const small = nextPeer();
    expect(await signalBigCargo(chat(small, '5 kub', { leadId: ids.lead }, [{ ref: 'v1', kind: 'volume', value: 5, messageRef: '#1' }]), [], MONDAY)).toBe(false);
  });

  it('a coded client with no lead: the client card’s door decides who reads its name', async () => {
    const peer = nextPeer();
    expect(await signalBigCargo(chat(peer, 'fura', { clientId: ids.client }), [], MONDAY)).toBe(true);
    const [bossCopy] = await copies(ids.boss);
    const [plainCopy] = await copies(ids.plain);
    expect(bossCopy!.text).toContain(`👤 FK${SUFFIX} Fura mijoz ${SUFFIX}`);
    expect(bossCopy!.text.split('\n').at(-1)).toMatch(new RegExp(`/admin/clients/${ids.client}$`, 'u'));
    expect(plainCopy!.text.split('\n')).toHaveLength(1);
  });

  it('nobody designated for the topic: the «rahbar va o‘rinbosar» pair hears it', async () => {
    await db.delete(agentDesignations).where(eq(agentDesignations.topic, 'big_cargo'));
    await db.insert(agentDesignations).values({ topic: 'supervisor', userId: ids.plain, rank: 1 });
    expect(await signalBigCargo(chat(nextPeer(), 'fura', { leadId: ids.lead }), [], MONDAY)).toBe(true);
    expect(await copies(ids.plain)).toHaveLength(1);
    expect(await copies(ids.boss)).toHaveLength(0);
  });
});

describe('one migration behind 0151', () => {
  it('nothing is claimed, nothing is sent, nothing throws', async () => {
    const peer = nextPeer();
    __pretendAgentToliq1aBehind();
    try {
      expect(await signalBigCargo(chat(peer, 'fura', { leadId: ids.lead }), [], MONDAY)).toBe(false);
    } finally {
      __forgetAgentToliq1aReady();
    }
    expect(await db.select().from(agentSignals).where(and(eq(agentSignals.managerUserId, ids.holder), eq(agentSignals.peerId, peer)))).toEqual([]);
    expect(await copies(ids.boss)).toEqual([]);
  });
});

describe('the purge (J15)', () => {
  it('a purged chat blanks the copies on the COLLEAGUES’ rows and takes the claim', async () => {
    const peer = nextPeer();
    await signalBigCargo(chat(peer, 'fura', { leadId: ids.lead }), [], MONDAY);
    await purgeAgentChat(ids.holder, peer);
    for (const userId of [ids.boss, ids.plain]) {
      const [copy] = await copies(userId);
      expect(copy!.text, userId).toBe(PURGED_CARD_TEXT);
    }
    expect(await db.select().from(agentSignals).where(and(eq(agentSignals.managerUserId, ids.holder), eq(agentSignals.peerId, peer)))).toEqual([]);
  });
});

describe('«Kim javob beradi» as the page reads it (J17, J18, J28)', () => {
  it('stored people with what the bot can do for them and whether the page opens; an empty topic names who hears it now', async () => {
    await db.delete(agentDesignations).where(inArray(agentDesignations.topic, ['supervisor', 'big_cargo']));
    await db.insert(agentDesignations).values([
      { topic: 'supervisor', userId: ids.boss, rank: 1 },
      { topic: 'supervisor', userId: ids.plain, rank: 2 },
    ]);
    const panel = await kimgaPanel({ id: ids.boss, roles: ['super_admin'] }, { ownerUserId: ids.holder });
    expect(panel.ready).toBe(true);
    expect(panel.editable).toBe(true);
    const supervisor = panel.topics.find((t) => t.topic === 'supervisor')!;
    expect(supervisor.stored.map((p) => [p.id, p.noPage, p.unreachable])).toEqual([
      [ids.boss, false, true],
      [ids.plain, true, true],
    ]);
    expect(supervisor.fallback).toBeNull();
    // The empty topic: the pair hears it, said by name and by source (J18).
    const cargo = panel.topics.find((t) => t.topic === 'big_cargo')!;
    expect(cargo.stored).toEqual([]);
    expect(cargo.fallback).toEqual({ names: [`Fura rahbar ${SUFFIX}`, `Fura oddiy ${SUFFIX}`], source: 'supervisor' });
    // The holder's own Telegram (J28): no linked staff chat here.
    expect(panel.holderReachable).toBe(false);
    // A reader who is not a super_admin reads it and edits nothing.
    expect((await kimgaPanel({ id: ids.holder, roles: [] }, { ownerUserId: ids.holder })).editable).toBe(false);
  });
});

describe('the boxes of «Kim javob beradi» (§3.3, §5)', () => {
  const KEYS = ['agent_big_cargo_m3', 'agent_big_cargo_words', 'agent_liveness_minutes'] as const;
  let stored: (typeof settings.$inferSelect)[] = [];

  beforeAll(async () => {
    stored = await db.select().from(settings).where(inArray(settings.key, [...KEYS]));
  });

  afterAll(async () => {
    await db.delete(settings).where(inArray(settings.key, [...KEYS]));
    if (stored.length > 0) await db.insert(settings).values(stored);
  });

  const refusedWith = async (run: () => Promise<unknown>) => {
    try {
      await run();
      return 'not refused';
    } catch (err) {
      return err instanceof SignalSettingError ? err.code : 'other';
    }
  };

  it('the big-cargo line is a super_admin’s; a shape its key refuses is refused; a save is read back and audited', async () => {
    const ctx = { actorId: ids.boss };
    expect(await refusedWith(() => setBigCargoSettings({ id: ids.plain, roles: [] }, { m3: '30', words: false }, ctx))).toBe('forbidden');
    for (const bad of ['201', '-1', '2.5', 'yigirma']) {
      expect(await refusedWith(() => setBigCargoSettings({ id: ids.boss, roles: ['super_admin'] }, { m3: bad, words: true }, ctx)), bad).toBe('bad_big_cargo');
    }
    expect(await setBigCargoSettings({ id: ids.boss, roles: ['super_admin'] }, { m3: '35', words: false }, ctx)).toEqual({ m3: 35, words: false });
    expect(await readBigCargoSettings()).toEqual({ m3: 35, words: false });
    const [audit] = await db
      .select({ after: auditLog.after })
      .from(auditLog)
      .where(and(eq(auditLog.entityType, 'settings'), eq(auditLog.actorId, ids.boss)))
      .orderBy(sql`${auditLog.createdAt} DESC`)
      .limit(1);
    expect(audit!.after).toEqual({ agent_big_cargo_m3: 35, agent_big_cargo_words: false });
  });

  it('the alarm’s minutes are the holder’s or a super_admin’s; 1 and 2 refused, 0 and 3 taken', async () => {
    await db.update(agentConfig).set({ ownerUserId: ids.holder }).where(eq(agentConfig.id, 1));
    try {
      expect(await refusedWith(() => setLivenessMinutes({ id: ids.plain, roles: [] }, '15', { actorId: ids.plain }))).toBe('forbidden');
      for (const bad of ['1', '2', '121', 'o‘n']) expect(await refusedWith(() => setLivenessMinutes({ id: ids.holder, roles: [] }, bad, { actorId: ids.holder })), bad).toBe('bad_liveness');
      expect(await setLivenessMinutes({ id: ids.holder, roles: [] }, '0', { actorId: ids.holder })).toBe(0);
      expect(await setLivenessMinutes({ id: ids.boss, roles: ['super_admin'] }, '3', { actorId: ids.boss })).toBe(3);
      expect(await readLivenessMinutes()).toBe(3);
    } finally {
      await __restoreAgentConfig(configSnapshot);
    }
  });
});
