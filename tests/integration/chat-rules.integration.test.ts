import 'dotenv/config';
import { and, desc, eq } from 'drizzle-orm';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { db, pgClient } from '@/modules/platform/db/client';
import { auditLog, clients, tgChatRules, users } from '@/modules/platform/db/schema';
import {
  ChatRuleError,
  decideChat,
  excludeChatForClient,
  listCandidates,
  pendingCount,
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
