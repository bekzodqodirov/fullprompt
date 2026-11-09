import 'dotenv/config';
import { eq, inArray, sql } from 'drizzle-orm';
import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest';

/**
 * The bot door on the REQUEST (0140, docs/IKKI-ESHIK.md §0): which door
 * collected a job is written on its row by the landing, and read back from
 * the row by every later reader — the add and seeded doors' collection, the
 * pass (`prefillStanding`), a correction. On NULL (legacy, and every door
 * that is not the bot's) nothing changes.
 *
 * One migration behind (§0.4, #472) is tested by REALLY dropping the column
 * — vitest runs files one at a time, and the drop is undone in a `finally`
 * (and healed in `beforeAll`, should a killed run have left it dropped). A
 * stubbed probe would not do: drizzle names every DECLARED column in every
 * INSERT, so the only proof that the landing does not name this one is a
 * schema that does not have it.
 *
 * The pass's queue is a stand-in (no pg-boss job leaves this file); the
 * landing, the request and the readers are real.
 */
const queue = vi.hoisted(() => ({ spy: vi.fn(async () => true) }));
vi.mock('@/modules/wms/calc/prefill-queue', async (importOriginal) => ({
  ...(await importOriginal<typeof import('@/modules/wms/calc/prefill-queue')>()),
  queueCalcPrefill: queue.spy,
}));

import { db, pgClient } from '@/modules/platform/db/client';
import {
  calcRequestItems,
  calcRequests,
  crmActivities,
  events,
  leads,
  notifications,
  roles,
  tasks,
  userRoles,
  users,
} from '@/modules/platform/db/schema';
import { endIntake, startIntake, updateIntake } from '@/modules/platform/telegram/calc-intake';
import { landCollectedIntake } from '@/modules/platform/telegram/staff-bot';
import { landIntake } from '@/modules/wms/calc/intake-land';
import { openCalcRequest, storedRequestFacts } from '@/modules/wms/calc/service';
import { prefillStanding, type PrefillSeen } from '@/modules/wms/calc/prefill';
import { recalcFromSealed } from '@/modules/wms/calc/workspace';
import { __forgetIntakeDoorReady, requestIntakeDoor } from '@/modules/wms/calc/intake-door';
import type { IntakeDoor } from '@/modules/wms/calc/intake';

const SUFFIX = String(Date.now()).slice(-6);
let seq = 0;
const tag = () => `Eshik ${SUFFIX}-${(seq += 1)}`;
let actorId = '';
let leadId = '';
const madeRequests: string[] = [];
const madeLeads: string[] = [];
const ctx = () => ({ actorId });

/** 0140's own two statements for the column — what the restore puts back. */
const RESTORE = [
  sql`ALTER TABLE calc_requests ADD COLUMN IF NOT EXISTS intake_door text`,
  sql`ALTER TABLE calc_requests DROP CONSTRAINT IF EXISTS calc_requests_intake_door_check`,
  sql`ALTER TABLE calc_requests ADD CONSTRAINT calc_requests_intake_door_check
        CHECK (intake_door IS NULL OR intake_door IN ('plain', 'ai'))`,
];

async function restoreColumn(): Promise<void> {
  for (const statement of RESTORE) await db.execute(statement);
  __forgetIntakeDoorReady();
}

/** The column itself, read by name — a test may; `src/` never does outside intake-door.ts. */
async function doorOf(requestId: string): Promise<string | null> {
  const rows = (await db.execute(sql`SELECT intake_door FROM calc_requests WHERE id = ${requestId}::uuid`)) as unknown as {
    intake_door: string | null;
  }[];
  return rows[0]?.intake_door ?? null;
}

/** A collection of a stranger, landed through the bot's own crossing. */
/** `seededFrom`: a seeded collection's source — null is a seeded row that names none (before COMP-3). */
async function landCollection(opts: { ai: boolean; seededFrom?: string | null }) {
  const n = (seq += 1);
  const chatId = BigInt(-9_700_000_000) - BigInt(n);
  const name = `Kurtka ${SUFFIX}-${n}`;
  startIntake(chatId, 'rastamojka', { ai: opts.ai, staffId: actorId });
  const goods = [{ name, quantity: 10, weightKg: 100 }];
  updateIntake(chatId, {
    stage: 'review',
    clientHintRaw: `Eshik ${SUFFIX}-${n} +99893${SUFFIX}${n % 10}`,
    material: [`${name} 10 dona 100 kg`],
    facts: { weightKg: 100, volumeM3: 1, goods },
    ...(opts.seededFrom !== undefined ? { seed: goods, seededFrom: opts.seededFrom } : {}),
  });
  try {
    const target = await landCollectedIntake(chatId, actorId, 'Ikki eshik fixture');
    expect(target?.queued, `landed: ${target?.queueError ?? ''}`).toBe(true);
    madeRequests.push(target!.requestId!);
    if (target!.kind === 'lead') madeLeads.push(target!.id);
    return target!.requestId!;
  } finally {
    endIntake(chatId);
  }
}

/** A request opened straight on this file's lead, with the door a caller names. */
async function openOn(door: IntakeDoor | null): Promise<string> {
  const opened = await openCalcRequest(
    {
      intakeDoor: door,
      entityType: 'lead',
      entityId: leadId,
      section: 'rastamojka',
      weightKg: 100,
      items: [{ name: tag(), quantity: 10 }],
      source: door === null ? 'card' : 'bot',
    },
    ctx(),
  );
  madeRequests.push(opened.id);
  return opened.id;
}

/** Priced by a «Готово» answer — what a correction needs of its parent (`isAnswer`). */
async function answered(requestId: string): Promise<void> {
  await db.execute(sql`
    UPDATE calc_requests
       SET completed_at = now(), completed_via = 'task', completed_by = ${actorId}::uuid,
           answer_amount = 100, answer_currency = 'USD'
     WHERE id = ${requestId}::uuid`);
}

async function corrected(parentId: string): Promise<string> {
  const fresh = (await recalcFromSealed(parentId, ctx())).id;
  madeRequests.push(fresh);
  return fresh;
}

async function seenDoor(requestId: string): Promise<IntakeDoor | null> {
  const seen: PrefillSeen = { door: null };
  expect(await prefillStanding(requestId, null, seen)).not.toBe('not_found');
  return seen.door;
}

beforeAll(async () => {
  // A killed run of this very file may have left the column dropped.
  await restoreColumn();
  const [actor] = await db
    .insert(users)
    .values({ phone: `+99896${String(Date.now()).slice(-7)}`, fullName: `Ikki eshik ${SUFFIX}`, passwordHash: 'x' })
    .returning();
  actorId = actor!.id;
  // A VED, so a correction comes back to this fixture rather than becoming a
  // task on a seeded colleague (calc-chain's reason, #154).
  const ved = await db.query.roles.findFirst({ where: eq(roles.code, 'ved_manager') });
  await db.insert(userRoles).values({ userId: actorId, roleId: ved!.id }).onConflictDoNothing();
  const stage = (await db.execute(sql`SELECT id FROM lead_stages WHERE kind = 'open' ORDER BY sort_order LIMIT 1`)) as unknown as {
    id: string;
  }[];
  const [lead] = await db
    .insert(leads)
    .values({ name: `Ikki eshik lid ${SUFFIX}`, stageId: stage[0]!.id, createdBy: actorId, ownerId: actorId })
    .returning();
  leadId = lead!.id;
  madeLeads.push(leadId);
});

afterAll(async () => {
  await restoreColumn();
  if (madeRequests.length > 0) {
    await db.delete(calcRequestItems).where(inArray(calcRequestItems.requestId, madeRequests));
    const rows = await db.select({ taskId: calcRequests.taskId }).from(calcRequests).where(inArray(calcRequests.id, madeRequests));
    // One statement: a correction points at its parent, and postgres checks the FK at its end.
    await db.delete(calcRequests).where(inArray(calcRequests.id, madeRequests));
    const taskIds = rows.map((r) => r.taskId).filter(Boolean) as string[];
    if (taskIds.length > 0) {
      await db.delete(events).where(inArray(events.entityId, taskIds));
      await db.delete(tasks).where(inArray(tasks.id, taskIds));
    }
  }
  await db.delete(notifications).where(eq(notifications.userId, actorId));
  if (madeLeads.length > 0) {
    await db.delete(crmActivities).where(inArray(crmActivities.entityId, madeLeads));
    await db.delete(leads).where(inArray(leads.id, madeLeads));
  }
  // An audited fixture is deactivated, never deleted (audit_log FK).
  await db.update(users).set({ active: false }).where(eq(users.id, actorId));
  await pgClient.end();
});

describe('the landing writes the door (§0.1)', () => {
  it('a bot collection lands its own: «🤖 AI rastamojka» is ai, «🧮 Hisoblatish» is plain', async () => {
    expect(await doorOf(await landCollection({ ai: true }))).toBe('ai');
    expect(await doorOf(await landCollection({ ai: false }))).toBe('plain');
  });

  it('a seeded collection lands with its SOURCE’s door as the source reads it — a legacy source, a legacy request', async () => {
    // The states `openSeeded` opens (tests/unit/intake-door-amend.test.ts): a
    // 'plain' source's collection is plain, an 'ai' one's AI — and a legacy
    // rastamojka's AI by «a customs section», a flag that is no door: landed,
    // it would make an «🤖» request nobody pressed, past his mute (K review
    // K-SPEC-1 / KU-1).
    const from = madeRequests.length;
    try {
      expect(await doorOf(await landCollection({ ai: false, seededFrom: await openOn('plain') }))).toBe('plain');
      expect(await doorOf(await landCollection({ ai: true, seededFrom: await openOn('ai') }))).toBe('ai');
      expect(await doorOf(await landCollection({ ai: true, seededFrom: await openOn(null) }))).toBeNull();
      // No source named (a seeded row from before COMP-3), or one that cannot
      // be read: legacy too — today's behaviour, never the collection's flag.
      expect(await doorOf(await landCollection({ ai: true, seededFrom: null }))).toBeNull();
      expect(await doorOf(await landCollection({ ai: true, seededFrom: 'not-a-request-id' }))).toBeNull();
    } finally {
      // Closed again, failing or not: this test's eight would take the file
      // past one requester's twenty open (`MAX_OPEN_PER_REQUESTER`).
      for (const id of madeRequests.slice(from)) await answered(id);
    }
  });

  it('the card form, the thread door and the agent name none — NULL, today’s', async () => {
    // The card's and the thread's `openCalcRequest`, and the agent's `landIntake`
    // (its re-queue's own open is the first shape); the callers' wiring is
    // fenced in tests/unit/intake-door-wire.test.ts.
    expect(await doorOf(await openOn(null))).toBeNull();
    const target = await landIntake({
      noteId: crypto.randomUUID(),
      section: 'rastamojka',
      facts: { weightKg: 100, goods: [{ name: tag(), quantity: 10 }] },
      steps: ["AI sotuvchi mijozning Telegram suhbatidan yig'di, egasi tasdiqladi."],
      fileCount: 0,
      collectedBy: actorId,
      collectedByName: 'Ikki eshik',
      client: null,
      lead: { id: leadId, name: `Ikki eshik lid ${SUFFIX}`, ownerId: actorId },
      leadName: 'Telegram',
      leadPhone: null,
      hasCertificate: true,
      intakeDoor: null,
    });
    expect(target.queued).toBe(true);
    madeRequests.push(target.requestId!);
    expect(await doorOf(target.requestId!)).toBeNull();
  });
});

describe('every reader reads it from the row (§0.3)', () => {
  it('the stored request, its add base, the pass’s standing and the one-request reader agree', async () => {
    for (const door of ['plain', 'ai', null] as const) {
      const id = await openOn(door);
      const stored = await storedRequestFacts(id);
      expect(stored?.door).toBe(door);
      expect(stored?.base.door).toBe(door);
      expect(await seenDoor(id)).toBe(door);
      expect(await requestIntakeDoor(id)).toBe(door);
    }
  });

  it('a correction copies its parent’s door, as it copies `source`', async () => {
    for (const door of ['ai', 'plain', null] as const) {
      const parent = await openOn(door);
      await answered(parent);
      expect(await doorOf(await corrected(parent))).toBe(door);
    }
  });
});

describe('one migration behind (§0.4, #472)', () => {
  it('a landing still opens — never `server_behind` — and every reader reads NULL', async () => {
    const parent = await openOn('ai');
    await answered(parent);
    await db.execute(sql`ALTER TABLE calc_requests DROP COLUMN intake_door`);
    // The process as it starts on deploy morning: nothing cached.
    __forgetIntakeDoorReady();
    try {
      const landed = await landCollection({ ai: true });
      const opened = await openOn('plain');
      expect((await storedRequestFacts(landed))?.door).toBeNull();
      expect(await seenDoor(opened)).toBeNull();
      expect(await requestIntakeDoor(opened)).toBeNull();
      // A correction reads its parent's door off a row that has none.
      const fresh = await corrected(parent);
      expect((await storedRequestFacts(fresh))?.door).toBeNull();
    } finally {
      await restoreColumn();
    }
    const [check] = (await db.execute(sql`
      SELECT pg_get_constraintdef(oid) AS def FROM pg_constraint WHERE conname = 'calc_requests_intake_door_check'`)) as unknown as {
      def: string;
    }[];
    expect(check?.def).toContain("'plain'::text, 'ai'::text");
    // …and the moment the column is back, the door is written again — no restart.
    expect(await doorOf(await landCollection({ ai: true }))).toBe('ai');
  });
});
