import 'dotenv/config';
import { and, desc, eq, inArray } from 'drizzle-orm';
import { v4 as uuidv4 } from 'uuid';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { db, pgClient } from '@/modules/platform/db/client';
import {
  clients,
  crmActivities,
  dealStages,
  deals,
  notifications,
  roles,
  userRoles,
  users,
} from '@/modules/platform/db/schema';
import {
  announceMentions,
  announceNote,
  cardLabel,
  noteRecipients,
} from '@/modules/wms/crm/internal-chat';
import { createTask, listTaskTypes } from '@/modules/platform/tasks/service';

/**
 * The internal chat's Telegram half, and the instant task messages.
 *
 * What only a real database can prove: who ends up in the `notifications`
 * table, and that the author never pings themselves — the failure mode that
 * teaches a whole team to mute the type.
 */

const STAMP = Date.now();
let seq = 0;
const phone = () => `+99894${String(STAMP).slice(-6)}${(seq += 1)}`;
const minted: string[] = [];

/**
 * The fixture's people carry SEEDED roles (0127): who a note pings is now
 * decided by each person's door at send time, and «the first two active
 * users of whatever database this is» is not a person with a known door.
 */
async function person(name: string, role: string | null): Promise<string> {
  const [u] = await db
    .insert(users)
    .values({ phone: phone(), fullName: name, passwordHash: 'x', active: true })
    .returning({ id: users.id });
  if (role) {
    const r = await db.query.roles.findFirst({ where: eq(roles.code, role) });
    await db.insert(userRoles).values({ userId: u!.id, roleId: r!.id });
  }
  minted.push(u!.id);
  return u!.id;
}

let author: string;
let colleague: string;
let bystander: string;
let clientId: string;
let dealId: string;

beforeAll(async () => {
  process.env.APP_URL = 'https://test.gsrwms.uz';
  // The author reads every card (the logist); the colleague is the seller
  // who carries the deal.
  author = await person(`Ichki Logist ${STAMP}`, 'logist');
  colleague = await person(`Ichki Sotuvchi ${STAMP}`, 'sales_manager');
  // Somebody OUTSIDE the thread — the person a mention exists to reach.
  bystander = await person(`Chetdagi Hamkasb ${STAMP}`, null);

  const [c] = await db
    .insert(clients)
    .values({ clientCode: `IC${STAMP}`.slice(0, 12), name: `Chat ${STAMP}`, phones: [] })
    .returning({ id: clients.id });
  clientId = c!.id;

  const [stage] = await db.select().from(dealStages).limit(1);
  const [d] = await db
    .insert(deals)
    .values({
      code: `B-IC${STAMP}`.slice(0, 14),
      clientId,
      stageId: stage!.id,
      ownerId: colleague,
      createdBy: author,
    })
    .returning({ id: deals.id });
  dealId = d!.id;
});

afterAll(async () => {
  await db
    .delete(notifications)
    .where(
      inArray(notifications.type, ['InternalNote', 'MentionedInNote', 'TaskAssigned', 'TaskDone']),
    );
  await db.delete(crmActivities).where(eq(crmActivities.entityId, dealId));
  await db.delete(deals).where(eq(deals.id, dealId));
  await db.delete(clients).where(eq(clients.id, clientId));
  // Deactivated, never deleted: the tasks below wrote audit rows naming them.
  await db.update(users).set({ active: false }).where(inArray(users.id, minted));
  await pgClient.end();
});

describe('who a note pings', () => {
  it('starts with the record owner, even before anybody has written', async () => {
    expect(await noteRecipients('deal', dealId, null)).toEqual([colleague]);
  });

  it('grows to the thread participants — you join by speaking', async () => {
    await db.insert(crmActivities).values({
      entityType: 'deal',
      entityId: dealId,
      kind: 'note',
      note: 'birinchi izoh',
      createdBy: author,
    });
    const who = await noteRecipients('deal', dealId, null);
    expect(new Set(who)).toEqual(new Set([author, colleague]));
  });

  it('names the deal by its code — the word staff say out loud', async () => {
    expect(await cardLabel('deal', dealId)).toContain(`B-IC${STAMP}`.slice(0, 14));
  });
});

describe('what lands in Telegram', () => {
  it('pings the thread, minus the author, with a link to the card', async () => {
    await announceNote({
      entityType: 'deal',
      entityId: dealId,
      note: 'narxni qayta ko‘ramiz',
      authorId: author,
      activityId: uuidv4(),
      calcRequestId: null,
    });
    const rows = await db
      .select()
      .from(notifications)
      .where(eq(notifications.type, 'InternalNote'))
      .orderBy(desc(notifications.createdAt));
    // The colleague is told; the author is NOT — a notification about your own
    // note is how people learn to mute the type entirely.
    const mine = rows.filter(
      (r) => (r.payload as { text?: string })?.text?.includes('narxni qayta'),
    );
    expect(mine.map((r) => r.userId)).toEqual([colleague]);
    const text = (mine[0]!.payload as { text: string }).text;
    expect(text).toContain(`https://test.gsrwms.uz/bitimlar/${dealId}`);
    // 0127: the ping says it can be answered by a reply — ABOVE the link,
    // which must stay the LAST line or the drain cannot lift it.
    const lines = text.split('\n');
    expect(lines.at(-2)).toBe('↩️ Javob uchun shu xabarga reply qiling');
    expect(lines.at(-1)).toBe(`🔗 https://test.gsrwms.uz/bitimlar/${dealId}`);
    // …and it names its thread, so the reply finds its way back.
    expect((mine[0]!.payload as { thread?: { kind: string; id: string } }).thread).toMatchObject({
      kind: 'deal',
      id: dealId,
    });
  });
});

describe('a mention reaches the person named — phase 4', () => {
  it('a NON-participant colleague named in a note gets the 📣 ping, not the thread copy', async () => {
    await announceNote({
      entityType: 'deal',
      entityId: dealId,
      note: `@Chetdagi Hamkasb ${STAMP} shu narxni ko‘rib bering`,
      authorId: author,
      activityId: uuidv4(),
      calcRequestId: null,
    });
    const mentionRows = await db
      .select()
      .from(notifications)
      .where(
        and(eq(notifications.type, 'MentionedInNote'), eq(notifications.userId, bystander)),
      );
    expect(
      mentionRows.filter((r) => (r.payload as { text?: string })?.text?.includes('shu narxni')),
    ).toHaveLength(1);
    // …and NOT the thread broadcast — one note, one message per person.
    const threadRows = await db
      .select()
      .from(notifications)
      .where(and(eq(notifications.type, 'InternalNote'), eq(notifications.userId, bystander)));
    expect(
      threadRows.filter((r) => (r.payload as { text?: string })?.text?.includes('shu narxni')),
    ).toHaveLength(0);
  });

  it('a mentioned PARTICIPANT gets exactly one message — the mention one', async () => {
    await announceNote({
      entityType: 'deal',
      entityId: dealId,
      // colleague is the deal owner (a thread participant) AND mentioned.
      note: `@${(await db.select().from(users).where(eq(users.id, colleague)))[0]!.fullName} bir qarang`,
      authorId: author,
      activityId: uuidv4(),
      calcRequestId: null,
    });
    const all = await db
      .select()
      .from(notifications)
      .where(eq(notifications.userId, colleague));
    const about = all.filter((r) => (r.payload as { text?: string })?.text?.includes('bir qarang'));
    expect(about).toHaveLength(1);
    expect(about[0]!.type).toBe('MentionedInNote');
  });

  it('a self-mention is silently dropped', async () => {
    const me = (await db.select().from(users).where(eq(users.id, author)))[0]!.fullName;
    await announceMentions({
      entityType: 'deal',
      entityId: dealId,
      note: `@${me} o‘zimga eslatma`,
      authorId: author,
      activityId: uuidv4(),
      calcRequestId: null,
    });
    const rows = await db
      .select()
      .from(notifications)
      .where(and(eq(notifications.type, 'MentionedInNote'), eq(notifications.userId, author)));
    expect(
      rows.filter((r) => (r.payload as { text?: string })?.text?.includes('o‘zimga eslatma')),
    ).toHaveLength(0);
  });

  it('the contact-log path pings ONLY the mentioned, never the thread', async () => {
    await announceMentions({
      entityType: 'client',
      entityId: clientId,
      note: `@Chetdagi Hamkasb ${STAMP} qo‘ng‘iroq qiling`,
      authorId: author,
      activityId: uuidv4(),
      calcRequestId: null,
    });
    const mentioned = await db
      .select()
      .from(notifications)
      .where(and(eq(notifications.type, 'MentionedInNote'), eq(notifications.userId, bystander)));
    expect(
      mentioned.filter((r) =>
        (r.payload as { text?: string })?.text?.includes('qo‘ng‘iroq qiling'),
      ),
    ).toHaveLength(1);
    const broadcast = await db
      .select()
      .from(notifications)
      .where(eq(notifications.type, 'InternalNote'));
    expect(
      broadcast.filter((r) =>
        (r.payload as { text?: string })?.text?.includes('qo‘ng‘iroq qiling'),
      ),
    ).toHaveLength(0);
  });
});

describe('a task reaches its assignee in Telegram, with the link', () => {
  it('on creation, when assigned to somebody else', async () => {
    const [type] = await listTaskTypes();
    const task = await createTask(
      {
        title: `Hujjatlarni tekshirish ${STAMP}`,
        note: '',
        typeId: type?.id ?? null,
        assigneeId: colleague,
        dueAt: '2027-01-01',
        priority: 2,
        entityType: 'deal',
        entityId: dealId,
        repeatUnit: null,
        repeatEvery: 1,
      },
      { actorId: author, ip: null, userAgent: null },
      { origin: 'hand' },
    );
    const rows = await db
      .select()
      .from(notifications)
      .where(and(eq(notifications.type, 'TaskAssigned'), eq(notifications.userId, colleague)));
    const mine = rows.filter((r) =>
      (r.payload as { text?: string })?.text?.includes(String(STAMP)),
    );
    expect(mine).toHaveLength(1);
    const text = (mine[0]!.payload as { text: string }).text;
    // The link is the point: a message that names a task but cannot take you
    // to it is a reminder to go searching.
    expect(text).toContain(`https://test.gsrwms.uz/bitimlar/${dealId}`);
    // Re-anchored ON PURPOSE in round C (it read the ISO '2027-01-01'): a
    // Telegram deadline prints the way the office writes a date, «dd.mm», the
    // year only when it is not this one — and an all-day date is its own UTC
    // day, never shifted into the next one by the Tashkent offset.
    expect(text).toMatch(/📅 01\.01(\.2027)?(\n|$)/);
    expect(task.id).toBeTruthy();
  });

  it('never to yourself — a task you just typed is not news', async () => {
    const [type] = await listTaskTypes();
    await createTask(
      {
        title: `O'zimga eslatma ${STAMP}`,
        note: '',
        typeId: type?.id ?? null,
        assigneeId: author,
        dueAt: '',
        priority: 2,
        entityType: null,
        entityId: null,
        repeatUnit: null,
        repeatEvery: 1,
      },
      { actorId: author, ip: null, userAgent: null },
      { origin: 'hand' },
    );
    const rows = await db
      .select()
      .from(notifications)
      .where(and(eq(notifications.type, 'TaskAssigned'), eq(notifications.userId, author)));
    expect(
      rows.filter((r) => (r.payload as { text?: string })?.text?.includes(`O'zimga eslatma`)),
    ).toHaveLength(0);
  });
});
