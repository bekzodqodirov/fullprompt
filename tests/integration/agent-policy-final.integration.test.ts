import 'dotenv/config';
import { eq, inArray } from 'drizzle-orm';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { db } from '@/modules/platform/db/client';
import { agentDrafts, agentOutbox, clients, users } from '@/modules/platform/db/schema';
import { AGENT_LIMITS } from '@/modules/wms/agent/limits';
import { ownerPolicyFor, policyFor, type PolicyMemory } from '@/modules/wms/agent/policy-input';
import { priceReplyText } from '@/modules/wms/agent/price-reply';

/**
 * G10's same-text fuse against the real outbox (final review K1, K3). The
 * stored rows are fingerprinted with THEIR OWN customer's names and codes,
 * read off the drafts they were approved from — so one address sentence sent
 * to five customers, each greeted by his own name and code, is one text; and
 * the 💵 template, the same to everybody once its digits fold, is counted for
 * the card as a warning.
 *
 * The manager is this file's own, so the counts are this file's rows alone.
 * Fixture rows are deleted; the person is deactivated if anything points at him.
 */

const STAMP = String(Date.now()).slice(-6);
const BASE = BigInt(`88${STAMP}`) * 1000n;
let seq = 0n;
const next = () => BASE + ++seq;
let managerId = '';
const madeClients: string[] = [];

const NAMES = ['Aziz', 'Sardor', 'Jasur', 'Dilshod', 'Bobur'] as const;
let codeNo = 0;
/** A client code of this file's own — digits fold to «#» in a fingerprint, so the letters and digits both differ. */
const freshCode = () => `F${STAMP}${String(++codeNo).padStart(2, '0')}`;
const greeting = (name: string, code: string) =>
  `Assalomu alaykum, ${name} aka! ${code} bo‘yicha Toshkent omborimiz manzili: Chuqursoy, 5-uy.`;

const memory = (ownCodes: string[]): PolicyMemory => ({
  language: 'uz',
  customerScript: null,
  sources: [{ value: 5, kind: 'plain', label: 'kompaniya bilimi', origin: 'kb' }],
  allowedPhones: [],
  allowedUrls: [],
  mapUrls: [],
  askedLocation: true,
  hasEstimate: false,
  ownCodes,
  managerName: null,
  canary: 'zq7-canary-41',
  hasGloss: true,
});

/** One approved reply, sent to its own peer, with the draft that names whose it was. */
async function sent(i: number, bodyOf: (code: string) => string): Promise<bigint> {
  const peer = next();
  const anchor = next();
  const code = freshCode();
  const body = bodyOf(code);
  const [c] = await db.insert(clients).values({ clientCode: code, name: `${NAMES[i]} Final ${STAMP}` }).returning({ id: clients.id });
  madeClients.push(c!.id);
  const [d] = await db
    .insert(agentDrafts)
    .values({
      managerUserId: managerId,
      peerId: peer,
      clientId: c!.id,
      anchorTgMessageId: anchor,
      status: 'approved',
      proposedBody: body,
      policy: { blocks: [], warnings: [], ledger: [], notes: [], memory: memory([code]), card: { customerLabel: `${code} · ${NAMES[i]} Karimov`, lastOut: null, customerLines: [] } },
    })
    .returning({ id: agentDrafts.id });
  await db.insert(agentOutbox).values({
    draftId: d!.id,
    managerUserId: managerId,
    peerId: peer,
    clientId: c!.id,
    body,
    randomId: next(),
    answersTgMessageId: anchor,
    status: 'sent',
    step: 'send',
    queuedBy: managerId,
    sentAt: new Date(),
  });
  return peer;
}

beforeAll(async () => {
  const [u] = await db
    .insert(users)
    .values({ phone: `+99893${STAMP}7`, fullName: `Agent policy final ${STAMP}`, passwordHash: 'x' })
    .returning({ id: users.id });
  managerId = u!.id;
});

afterAll(async () => {
  await db.delete(agentOutbox).where(eq(agentOutbox.managerUserId, managerId));
  await db.delete(agentDrafts).where(eq(agentDrafts.managerUserId, managerId));
  if (madeClients.length) await db.delete(clients).where(inArray(clients.id, madeClients));
  await db
    .delete(users)
    .where(eq(users.id, managerId))
    .catch(() => db.update(users).set({ active: false }).where(eq(users.id, managerId)));
});

describe('K1 — one sentence to many customers, each greeted by his own name and code, is one text', () => {
  it('the fifth customer’s draft trips the fuse: every stored row folds out ITS customer, not this one', async () => {
    // AGENT_LIMITS.fingerprintPeers other peers is the ceiling; one more than that trips it.
    const others = AGENT_LIMITS.fingerprintPeers + 1;
    for (let i = 0; i < others; i++) await sent(i, (code) => greeting(NAMES[i]!, code));
    const me = freshCode();
    const policy = await policyFor({
      managerUserId: managerId,
      peerId: next(),
      body: greeting('Bobur', me),
      memory: memory([me]),
      strip: [me, 'Bobur', 'Karimov'],
    });
    expect(policy.blocks).toContainEqual(expect.objectContaining({ rule: 'G10', code: 'fingerprint', detail: String(others) }));
  });

  it('a different sentence to the same customers trips nothing', async () => {
    const me = freshCode();
    const policy = await policyFor({
      managerUserId: managerId,
      peerId: next(),
      body: `Assalomu alaykum, Bobur aka! ${me} bo‘yicha yukingiz omborda.`,
      memory: memory([me]),
      strip: [me, 'Bobur'],
    });
    expect(policy.blocks.map((b) => b.code)).not.toContain('fingerprint');
  });
});

describe('K3 — the 💵 template counted against the same fuse, as a warning', () => {
  it('his fifth identical price sentence of the day warns on the card and still passes', async () => {
    const before = AGENT_LIMITS.fingerprintPeers + 1;
    for (let i = 0; i < before; i++) await sent(i, () => priceReplyText('uz', 'yolkira', 1000 + i * 50));
    const body = priceReplyText('uz', 'yolkira', 1250);
    const me = freshCode();
    const warned = await ownerPolicyFor(body, [me], { managerUserId: managerId, peerId: next(), strip: [me, 'Bobur'] });
    expect(warned.ok).toBe(true);
    expect(warned.blocks).toEqual([]);
    expect(warned.warnings).toContainEqual(expect.objectContaining({ rule: 'G10', code: 'fingerprint' }));
    // His own ✏️ words — no chat given — are counted against nothing.
    expect((await ownerPolicyFor(body, [me], null)).warnings).toEqual([]);
  });
});

describe('K29 — the translation rides the memory, so ✅ asks what the write asked', () => {
  it('a Persian draft stored without its Uzbek gloss is refused by policyFor; with one it passes', async () => {
    const fa = (hasGloss: boolean): PolicyMemory => ({ ...memory([]), language: 'fa', customerScript: 'arabic', hasGloss });
    const body = 'سلام، بار شما در انبار است.';
    const without = await policyFor({ managerUserId: managerId, peerId: next(), body, memory: fa(false), strip: [] });
    expect(without.ok).toBe(false);
    expect(without.blocks).toContainEqual(expect.objectContaining({ rule: 'G5', code: 'gloss_missing' }));
    expect((await policyFor({ managerUserId: managerId, peerId: next(), body, memory: fa(true), strip: [] })).ok).toBe(true);
    // A memory written before the flag says none — read as none, for these two languages only.
    const old: PolicyMemory = { ...fa(true) };
    delete old.hasGloss;
    expect((await policyFor({ managerUserId: managerId, peerId: next(), body, memory: old, strip: [] })).ok).toBe(false);
  });
});
