import { and, asc, eq, inArray, sql } from 'drizzle-orm';
import { isUuidShaped } from '../../platform/audit/fields';
import { writeAudit, type AuditContext } from '../../platform/audit/service';
import { db, type Db, type Tx } from '../../platform/db/client';
import { agentDesignations, users } from '../../platform/db/schema';
import { logger } from '../../platform/logger';
import { canLogInSql } from '../../platform/users/login';
import { AGENT_CONFIG_AUDIT_ID, agentToliq1aReady, agentToliq1aReadyOn, mayGovernAgent, readAgentConfig } from './config';

/**
 * WHO the machine tells (stage 1a §3.2; design §11.2, his «kim — tizimda tanlanadi»): picked on /suhbatlar/ai
 * («Kim javob beradi»), stored in `agent_designations` (0151), and named NOWHERE in code — no role key, no user id,
 * no person's name in this file (a source-shape test reads it). ONE table for every later stage: they add a KEY to
 * `AGENT_TOPICS` and four strings, never a second «who» table (`qurish/COVERAGE.md` §C.1).
 *
 * TWO readers, and which one a caller takes is decided by what it does with the answer — never by convenience:
 *  - `designated(topic)` is for TELLING somebody (a signal, an alarm, the morning line): the fallback chain makes it
 *    never «nobody» — the topic's rows, else the «rahbar va o'rinbosar» pair's, else the people the agent's alarms
 *    reach today (`agentAlarmRecipients`, auto-send.ts — the one line that already held the role). It reads the
 *    POOL, so it is asked before a transaction opens or after it commits, never inside one (#714).
 *  - `designatedRows(topic, handle)` is for LETTING somebody in (a door of a later stage — who may press ✅, write
 *    from the AI's number) and for the screen, which draws what is STORED: the topic's own rows and nothing else.
 *    An empty topic answers `[]` and the door keeps the rule it has today — an empty table never widens a door to
 *    the alarm audience, which is wider by design.
 */

/**
 * The topics, as the code knows them: a key and the page's label and hint keys (`agentAi.*`, all four bundles).
 * Nothing about people. Stage 1a's two: the pair his 5 b names (rank 1 rahbar, rank 2 o'rinbosar) and the big-cargo
 * signal of his 3 b.
 */
export const AGENT_TOPICS = {
  supervisor: { label: 'topic.supervisor', hint: 'topicHint.supervisor' },
  big_cargo: { label: 'topic.big_cargo', hint: 'topicHint.big_cargo' },
} as const satisfies Record<string, { label: string; hint: string }>;

export type AgentTopic = keyof typeof AGENT_TOPICS;

export const AGENT_TOPIC_KEYS = Object.keys(AGENT_TOPICS) as AgentTopic[];

export function isAgentTopic(raw: string): raw is AgentTopic {
  return Object.hasOwn(AGENT_TOPICS, raw);
}

/** The most people one topic holds — 0151's rank CHECK (1..9). */
export const DESIGNATION_MAX = 9;

export interface DesignationRow {
  userId: string;
  rank: number;
}

/**
 * The topic's OWN stored rows — people who can log in (`canLogInSql`: a leaver is skipped, and so is a person who
 * never signs in), by rank, then name. Read on the handle it is given: inside the caller's transaction it sees that
 * transaction's own uncommitted replace-all (#714 — never a second connection). No fallback, ever: an empty topic,
 * a topic the registry does not know, or a server one migration behind 0151 answers `[]`. The readiness is asked
 * on the same handle (`agentToliq1aReadyOn`), so this is safe inside a transaction.
 */
export async function designatedRows(topic: AgentTopic, handle: Db | Tx): Promise<DesignationRow[]> {
  if (!isAgentTopic(topic)) return [];
  if (!(await agentToliq1aReadyOn(handle))) return [];
  return handle
    .select({ userId: agentDesignations.userId, rank: agentDesignations.rank })
    .from(agentDesignations)
    .innerJoin(users, eq(users.id, agentDesignations.userId))
    .where(and(eq(agentDesignations.topic, topic), canLogInSql()))
    .orderBy(asc(agentDesignations.rank), asc(users.fullName), asc(users.id));
}

/** Where `designated()` found its people — the screen says it beside the names (J18). */
export type DesignationSource = 'own' | 'supervisor' | 'alarm';

export interface Designation {
  userIds: string[];
  source: DesignationSource;
}

/**
 * Who is TOLD about this topic, with where the answer came from. Never «nobody» while anybody can be told: the
 * topic's rows → the supervisor pair's → the agent's alarm audience (its holder and every super_admin who can log
 * in, holder first). A read that fails falls to the alarm audience rather than to silence (a signal nobody
 * receives is the silent failure this table exists to end). Reads the pool: never inside a transaction.
 */
export async function designation(topic: AgentTopic): Promise<Designation> {
  try {
    if (await agentToliq1aReady()) {
      const own = await designatedRows(topic, db);
      if (own.length > 0) return { userIds: own.map((r) => r.userId), source: 'own' };
      if (topic !== 'supervisor') {
        const pair = await designatedRows('supervisor', db);
        if (pair.length > 0) return { userIds: pair.map((r) => r.userId), source: 'supervisor' };
      }
    }
  } catch (err) {
    logger.warn({ err, topic }, '[agent] designations not read — the alarm audience answers');
  }
  const config = await readAgentConfig().catch(() => null);
  const holderId = config?.ownerUserId ?? null;
  // Dynamic: auto-send is the agent's heaviest module, and a static edge here would tie this small reader into it
  // for every importer (the house's way across such edges — card-io, auto-send's own imports of it).
  const { agentAlarmRecipients } = await import('./auto-send');
  return { userIds: await whoCanLogIn(await agentAlarmRecipients(holderId), holderId), source: 'alarm' };
}

/** `designation(topic).userIds` — what a signal or an alarm passes to `notifyStaffTelegram`. */
export async function designated(topic: AgentTopic): Promise<string[]> {
  return (await designation(topic)).userIds;
}

/**
 * Of these ids, the people who can log in NOW — the holder first, then by name. The alarm audience's super_admins
 * are already filtered by their reader; the holder is not (the seat may be a machine user nobody signs in as), and
 * every answer of `designated()` is a person who can log in.
 */
async function whoCanLogIn(ids: readonly string[], firstId: string | null): Promise<string[]> {
  if (ids.length === 0) return [];
  const rows = await db
    .select({ id: users.id })
    .from(users)
    .where(and(inArray(users.id, [...ids]), canLogInSql()))
    .orderBy(sql`CASE WHEN ${users.id}::text = ${firstId ?? ''} THEN 0 ELSE 1 END`, asc(users.fullName), asc(users.id));
  return rows.map((r) => r.id);
}

export type DesignationRefusal = 'not_ready' | 'forbidden' | 'unknown_topic' | 'too_many' | 'not_staff';

export class DesignationError extends Error {
  constructor(public readonly code: DesignationRefusal) {
    super(code);
  }
}

/**
 * «Kim javob beradi» saved: the topic's people REPLACED, in the order given (the first is rank 1), in ONE
 * transaction, audited. The door is `mayGovernAgent` — the very predicate `setAgentSeat` asks (config.ts), never a
 * role restated here. Every person must be a colleague who can log in, checked on the transaction; a duplicate
 * keeps its first place; an empty list clears the topic (and `designated()` falls back). Two saves of one topic at
 * once queue behind one advisory lock — without it both delete, both insert, and the second dies on the key.
 * What it reads back it reads with `designatedRows(topic, tx)`.
 */
export async function setDesignations(
  actor: { id: string; roles: readonly string[] },
  topic: string,
  userIds: readonly string[],
  ctx: AuditContext,
): Promise<DesignationRow[]> {
  if (!mayGovernAgent(actor)) throw new DesignationError('forbidden');
  if (!isAgentTopic(topic)) throw new DesignationError('unknown_topic');
  const ids = [...new Set(userIds.map((id) => id.trim().toLowerCase()).filter((id) => id !== ''))];
  // A picker's value that is no id is a forged post, said as «not a colleague» rather than as a database error.
  if (!ids.every(isUuidShaped)) throw new DesignationError('not_staff');
  if (ids.length > DESIGNATION_MAX) throw new DesignationError('too_many');
  // Read BEFORE the transaction: the probe reaches the pool.
  if (!(await agentToliq1aReady())) throw new DesignationError('not_ready');
  return db.transaction(async (tx) => {
    await tx.execute(sql`SELECT pg_advisory_xact_lock(hashtext(${`agent_designations:${topic}`}))`);
    if (ids.length > 0) {
      const live = await tx
        .select({ id: users.id })
        .from(users)
        .where(and(inArray(users.id, ids), canLogInSql()));
      if (live.length !== ids.length) throw new DesignationError('not_staff');
    }
    // What was stored, leavers included — the audit says what the save replaced, not what a reader would have drawn.
    const before = await tx
      .select({ userId: agentDesignations.userId })
      .from(agentDesignations)
      .where(eq(agentDesignations.topic, topic))
      .orderBy(asc(agentDesignations.rank), asc(agentDesignations.userId));
    await tx.delete(agentDesignations).where(eq(agentDesignations.topic, topic));
    if (ids.length > 0) {
      await tx
        .insert(agentDesignations)
        .values(ids.map((userId, i) => ({ topic, userId, rank: i + 1, createdBy: actor.id })));
    }
    const after = await designatedRows(topic, tx);
    await writeAudit(tx, ctx, {
      entityType: 'agent_designations',
      entityId: AGENT_CONFIG_AUDIT_ID,
      action: 'update',
      before: { topic, userIds: before.map((r) => r.userId) },
      after: { topic, userIds: after.map((r) => r.userId) },
    });
    return after;
  });
}
