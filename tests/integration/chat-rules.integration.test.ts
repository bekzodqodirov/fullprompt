import 'dotenv/config';
import { and, desc, eq } from 'drizzle-orm';
import { v4 as uuidv4 } from 'uuid';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { db, pgClient } from '@/modules/platform/db/client';
import {
  attachments,
  auditLog,
  clients,
  tgChatRules,
  tgMessages,
  users,
} from '@/modules/platform/db/schema';
import {
  ChatRuleError,
  decideChat,
  excludeChatForClient,
  excludedLeftovers,
  listCandidates,
  pendingCount,
  purgeExcludedChat,
  recordCandidates,
  rulesFor,
} from '@/modules/wms/crm/chat-rules';
import { classifyWithRules } from '@/modules/wms/crm/telegram-import';

/**
 * Which chats a person said yes and no to, against a real database.
 *
 * The precedence itself is pure and proved in `chat-rules.test.ts`. What only
 * this file can show: that a scan does not un-answer a decision, that the
 * schema refuses an `include` with nowhere to put the messages, and that the
 * rules the import reads back are the ones the screen wrote.
 */

const STAMP = Date.now();
const PEER_A = BigInt(STAMP);
const PEER_B = BigInt(STAMP + 1);

let managerId: string;
let clientId: string;
let clientCode: string;

beforeAll(async () => {
  const [staff] = await db.select().from(users).limit(1);
  managerId = staff!.id;
  clientCode = `CR${STAMP}`.slice(0, 12);
  const [row] = await db
    .insert(clients)
    .values({ clientCode, name: `Rules ${STAMP}`, phones: ['+998907776655'] })
    .returning({ id: clients.id });
  clientId = row!.id;
});

afterAll(async () => {
  await db.delete(tgChatRules).where(eq(tgChatRules.managerUserId, managerId));
  await db.delete(clients).where(eq(clients.id, clientId));
  await pgClient.end();
});

const ctx = () => ({ actorId: managerId, ip: null, userAgent: null });

describe('a scan writing down what it found', () => {
  it('adds a question and nothing else', async () => {
    const result = await recordCandidates(managerId, [
      { peerId: PEER_A, title: 'Sardor', phone: null },
      { peerId: PEER_B, title: 'Oyim', phone: '+998901112200' },
    ]);
    expect(result).toEqual({ added: 2, refreshed: 0 });

    const rows = await listCandidates({ managerUserId: managerId, decision: 'pending' });
    expect(rows).toHaveLength(2);
    // A question decides nothing: the import must still refuse these.
    const rules = await rulesFor(managerId);
    expect(rules.get(PEER_A)?.decision).toBe('pending');
  });

  it('refreshes the name without touching the answer', async () => {
    await decideChat({ id: (await pending())[0]!.id, decision: 'exclude' }, ctx());
    const before = await rulesFor(managerId);
    const excluded = [...before.values()].filter((r) => r.decision === 'exclude');
    expect(excluded).toHaveLength(1);

    // A person changes their Telegram name; the scan runs again.
    const result = await recordCandidates(managerId, [
      { peerId: PEER_A, title: 'Sardor Karimov', phone: '+998909998877' },
      { peerId: PEER_B, title: 'Oyim', phone: '+998901112200' },
    ]);
    expect(result).toEqual({ added: 0, refreshed: 2 });

    const after = await rulesFor(managerId);
    // The answer survived — a re-scan must never re-ask something settled.
    expect([...after.values()].filter((r) => r.decision === 'exclude')).toHaveLength(1);
    const rows = await listCandidates({ managerUserId: managerId });
    expect(rows.map((r) => r.title).sort()).toEqual(['Oyim', 'Sardor Karimov']);
  });

  it('does nothing at all when it found nothing', async () => {
    expect(await recordCandidates(managerId, [])).toEqual({ added: 0, refreshed: 0 });
  });
});

const pending = async () => listCandidates({ managerUserId: managerId, decision: 'pending' });

describe('answering a chat', () => {
  it('takes in a client the phone match could never have found', async () => {
    const row = (await pending())[0]!;
    await decideChat({ id: row.id, decision: 'include', clientId }, ctx());

    const rules = await rulesFor(managerId);
    const rule = rules.get(BigInt(row.peerId))!;
    expect(rule.decision).toBe('include');
    expect(rule.clientId).toBe(clientId);
    // Read back through the same function the import and listener use.
    expect(
      classifyWithRules(
        { id: BigInt(row.peerId), phone: null, isPrivate: true, isBot: false },
        [],
        rules,
      ),
    ).toEqual({ keep: true, clientId, clientCode });
  });

  it('refuses an include with no client', async () => {
    // `tg_messages.client_id` is NOT NULL — such a rule would promise a
    // message a home it does not have.
    const [row] = await listCandidates({ managerUserId: managerId, decision: 'exclude' });
    await expect(decideChat({ id: row!.id, decision: 'include' }, ctx())).rejects.toBeInstanceOf(
      ChatRuleError,
    );
  });

  it('refuses a client that does not exist', async () => {
    const [row] = await listCandidates({ managerUserId: managerId, decision: 'exclude' });
    await expect(
      decideChat(
        { id: row!.id, decision: 'include', clientId: '00000000-0000-0000-0000-000000000000' },
        ctx(),
      ),
    ).rejects.toBeInstanceOf(ChatRuleError);
  });

  it('refuses a rule that is not there', async () => {
    await expect(
      decideChat(
        { id: '00000000-0000-0000-0000-000000000000', decision: 'exclude' },
        ctx(),
      ),
    ).rejects.toBeInstanceOf(ChatRuleError);
  });

  it('is reversible, because it is a judgement made from a display name', async () => {
    const [included] = await listCandidates({ managerUserId: managerId, decision: 'include' });
    await decideChat({ id: included!.id, decision: 'pending' }, ctx());
    const rules = await rulesFor(managerId);
    expect(rules.get(BigInt(included!.peerId))?.decision).toBe('pending');
    // And the client goes with it — a pending row must not keep pointing at
    // somebody, or an undo would leave a half-answer behind.
    expect(rules.get(BigInt(included!.peerId))?.clientId).toBeNull();
  });

  it('records who decided, and what it was before', async () => {
    // This is a decision about what the company starts keeping on a person.
    const [row] = await pending();
    await decideChat({ id: row!.id, decision: 'exclude' }, ctx());
    const [entry] = await db
      .select()
      .from(auditLog)
      .where(and(eq(auditLog.entityType, 'tg_chat_rule'), eq(auditLog.entityId, row!.id)))
      // Newest: this rule may well have been answered before, and an
      // unordered limit(1) picks whichever row postgres reaches first.
      .orderBy(desc(auditLog.createdAt))
      .limit(1);
    expect(entry?.actorId).toBe(managerId);
    expect(entry?.after).toMatchObject({ decision: 'exclude' });
  });
});

describe('who sees which questions', () => {
  it('counts only one manager’s chats when asked for one manager', async () => {
    const mine = await pendingCount(managerId);
    const everybody = await pendingCount();
    // Other specs may leave rows for other managers; mine can never exceed all.
    expect(mine).toBeLessThanOrEqual(everybody);
    const rows = await listCandidates({ managerUserId: managerId });
    expect(rows.every((r) => r.managerUserId === managerId)).toBe(true);
  });
});

describe('stopping a chat the phone rule DOES match', () => {
  /**
   * The half of the owner's ask that was unreachable. `scanVerdict` returns
   * 'auto' for anything the automatic rule already keeps, the scan records
   * only 'ask' verdicts, and `recordCandidates` was the sole writer of
   * tg_chat_rules — so a matched chat could never be given an exclude.
   */
  const PEER_C = BigInt(STAMP + 2);

  it('writes an exclude where no rule existed at all', async () => {
    await excludeChatForClient(
      { clientId, managerUserId: managerId, peerId: PEER_C },
      ctx(),
    );
    const rules = await rulesFor(managerId);
    expect(rules.get(PEER_C)?.decision).toBe('exclude');
    // And the decision now actually bites: the same function the import and
    // the listener call refuses it, whatever the phone says.
    expect(
      classifyWithRules(
        { id: PEER_C, phone: '+998907776655', isPrivate: true, isBot: false },
        [{ id: clientId, clientCode, phones: ['+998907776655'] }],
        rules,
      ),
    ).toEqual({ keep: false, reason: 'excluded' });
  });

  it('overrides an include somebody is changing their mind about', async () => {
    await excludeChatForClient({ clientId, managerUserId: managerId, peerId: PEER_A }, ctx());
    const rules = await rulesFor(managerId);
    expect(rules.get(PEER_A)?.decision).toBe('exclude');
    // The client goes with it: an excluded row must not keep pointing at
    // somebody, or a later undo would restore a half-answer.
    expect(rules.get(PEER_A)?.clientId).toBeNull();
  });

  it('is future-only — it does not delete what is already stored', async () => {
    // Deleting a client's conversation is a separate decision with its own
    // consequences, and this button must not quietly be the one that takes it.
    const before = await db.select().from(tgChatRules).where(eq(tgChatRules.peerId, PEER_C));
    expect(before).toHaveLength(1);
    await excludeChatForClient({ clientId, managerUserId: managerId, peerId: PEER_C }, ctx());
    const after = await db.select().from(tgChatRules).where(eq(tgChatRules.peerId, PEER_C));
    // Repeatable, and still one row.
    expect(after).toHaveLength(1);
  });
});

/**
 * …and THIS is that separate decision (round 22): the explicit purge of what
 * an excluded chat left behind — messages and their photographs, counted,
 * audited, refused for anything not excluded.
 */
describe('purging an excluded chat', () => {
  const PEER_P = BigInt(STAMP + 100);

  it('deletes the stored rows and their photos, and writes the counts to the audit', async () => {
    // Two stored messages, one carrying a "photo" (rows only — storage keys
    // that never existed delete as a no-op, which is the best-effort design).
    const [m1] = await db
      .insert(tgMessages)
      .values({
        clientId,
        managerUserId: managerId,
        peerId: PEER_P,
        tgMessageId: 1n,
        direction: 'in',
        body: 'maxfiy',
        hasMedia: true,
        sentAt: new Date(),
      })
      .returning({ id: tgMessages.id });
    await db.insert(tgMessages).values({
      clientId,
      managerUserId: managerId,
      peerId: PEER_P,
      tgMessageId: 2n,
      direction: 'out',
      body: 'javob',
      sentAt: new Date(),
    });
    await db.insert(attachments).values({
      entityType: 'tg_message',
      entityId: m1!.id,
      kind: 'photo',
      storageKey: `purgetest/${m1!.id}`,
      fileName: 'photo_1.jpg',
      contentType: 'image/jpeg',
      sizeBytes: 1,
      uploadedBy: managerId,
    });

    await excludeChatForClient({ clientId, managerUserId: managerId, peerId: PEER_P }, ctx());
    const [rule] = await db
      .select()
      .from(tgChatRules)
      .where(and(eq(tgChatRules.managerUserId, managerId), eq(tgChatRules.peerId, PEER_P)));

    // The screen's number: what still stands behind the exclude.
    const counts = await excludedLeftovers([
      { id: rule!.id, managerUserId: managerId, peerId: PEER_P },
    ]);
    expect(counts.get(rule!.id)).toBe(2);

    const result = await purgeExcludedChat(rule!.id, ctx());
    expect(result).toEqual({ messages: 2, photos: 1 });

    expect(
      await db
        .select()
        .from(tgMessages)
        .where(and(eq(tgMessages.managerUserId, managerId), eq(tgMessages.peerId, PEER_P))),
    ).toHaveLength(0);
    expect(
      await db.select().from(attachments).where(eq(attachments.entityId, m1!.id)),
    ).toHaveLength(0);

    // Who deleted a conversation and when — the audit's whole purpose.
    const trail = await db
      .select()
      .from(auditLog)
      .where(eq(auditLog.entityId, rule!.id))
      .orderBy(desc(auditLog.createdAt));
    const purged = trail.find((r) => (r.after as { purged?: boolean })?.purged === true);
    expect(purged).toBeDefined();
    expect((purged!.after as { messages: number }).messages).toBe(2);

    // Nothing left → the screen stops offering the button.
    expect(
      (
        await excludedLeftovers([{ id: rule!.id, managerUserId: managerId, peerId: PEER_P }])
      ).size,
    ).toBe(0);
  });

  it('refuses anything that is not an excluded chat', async () => {
    // A rule made UNCONDITIONALLY here, not found lying around — the first
    // cut looked one up and skipped itself when none existed, which proved
    // nothing (the round-19 lesson about tests that can quietly pass).
    const PEER_I = BigInt(STAMP + 101);
    await recordCandidates(managerId, [{ peerId: PEER_I, title: 'Mijoz', phone: null }]);
    const rule = (await listCandidates({ managerUserId: managerId })).find(
      (r) => r.peerId === PEER_I.toString(),
    )!;
    await decideChat({ id: rule.id, decision: 'include', clientId }, ctx());
    // Purging a KEPT client conversation is a different act — refused.
    await expect(purgeExcludedChat(rule.id, ctx())).rejects.toThrow('not_excluded');
    await expect(purgeExcludedChat(uuidv4(), ctx())).rejects.toThrow('chat_rule_not_found');
  });
});
