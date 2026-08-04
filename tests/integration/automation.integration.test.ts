import 'dotenv/config';
import { and, eq, inArray, like } from 'drizzle-orm';
import { v4 as uuidv4 } from 'uuid';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { db, pgClient } from '@/modules/platform/db/client';
import {
  attachments,
  automationRules,
  clients,
  dealStages as dealStagesTable,
  deals,
  leadStages as leadStagesTable,
  leads,
  notifications,
  tasks,
  users,
  warehouses,
} from '@/modules/platform/db/schema';
import { saveRule, setRuleActive } from '@/modules/platform/automation/service';
import { processPendingEvents } from '@/modules/platform/notifications/service';
import { createDeal, listStages as dealStages, moveDeal } from '@/modules/wms/deals/service';
import { createLead, moveLead } from '@/modules/wms/crm/service';
import { confirmReceipt } from '@/modules/wms/receipts/service';

/**
 * Phase 7 end to end against a real database: a rule written as data, a
 * stage moved by the real service, the real event worker — and a task that
 * exists afterwards, assigned to the right person, linked to the right card.
 */

const STAMP = Date.now();
let authorId: string;
let assigneeId: string;
let clientId: string;
let whId: string;
const ruleIds: string[] = [];
/**
 * The trigger stage is MINTED here, not borrowed from the seeded funnel.
 *
 * It used to be `stages.find((s) => s.id !== from.id)` — a shared column that
 * any other test file's deal can also walk into. CI caught it once: the rule
 * had fired twice and `fireCount` read 2. A rule is only testable if nothing
 * but this file can pull its trigger. Deleted in afterAll — a stage is
 * CONFIGURATION (#183).
 */
const madeStages: string[] = [];
const madeLeadStages: string[] = [];
const ctx = (actorId: string) => ({ actorId, ip: null, userAgent: null });

beforeAll(async () => {
  const staff = await db.select().from(users).where(eq(users.active, true)).limit(2);
  authorId = staff[0]!.id;
  assigneeId = (staff[1] ?? staff[0])!.id;
  const [c] = await db
    .insert(clients)
    .values({
      clientCode: `AU${STAMP}`.slice(0, 12),
      name: `Automation ${STAMP}`,
      salesManagerId: assigneeId,
    })
    .returning();
  clientId = c!.id;
  const wh = await db.query.warehouses.findFirst({ where: eq(warehouses.code, 'AUWH') });
  whId =
    wh?.id ??
    (
      await db
        .insert(warehouses)
        .values({
          code: 'AUWH',
          name: 'Automation WH',
          country: 'CN',
          type: 'origin',
          timezone: 'Asia/Shanghai',
          batchPrefix: 'AUWH',
        })
        .returning()
    )[0]!.id;
  // Earlier test files leave THEIR events unprocessed. Drain them while no
  // rule exists yet, or the backlog's old receipts would fire the rules this
  // file is about to write — the tests below must hear only their own moves.
  await processPendingEvents();
});

afterAll(async () => {
  // Rules are CONFIGURATION (#183): they change what every later event does,
  // so they must not outlive this file.
  for (const id of ruleIds) {
    await db.delete(automationRules).where(eq(automationRules.id, id));
  }
  await db.delete(tasks).where(like(tasks.title, `AU-${STAMP}%`));
  // MOVE FIRST, then delete — the same law `deleteDealStage` enforces on the
  // screen. A stage still under a deal cannot be dropped (`deals_stage_id_fkey`),
  // and a cleanup that throws fails the FILE even when every test passed: CI
  // reported «Test Files 1 failed» beside «851 tests passed».
  if (madeStages.length) {
    const home = (await dealStages()).find((stage) => !madeStages.includes(stage.id))!;
    await db
      .update(deals)
      .set({ stageId: home.id })
      .where(inArray(deals.stageId, madeStages));
    await db.delete(dealStagesTable).where(inArray(dealStagesTable.id, madeStages));
  }
  if (madeLeadStages.length) {
    const home = (await db.select().from(leadStagesTable)).find(
      (stage) => !madeLeadStages.includes(stage.id),
    )!;
    await db.update(leads).set({ stageId: home.id }).where(inArray(leads.stageId, madeLeadStages));
    await db.delete(leadStagesTable).where(inArray(leadStagesTable.id, madeLeadStages));
  }
  await db.delete(notifications).where(eq(notifications.type, 'AutomationRule'));
  await db.update(warehouses).set({ active: false }).where(eq(warehouses.id, whId));
  await pgClient.end();
});

describe('a rule turns an event into work', () => {
  it('deal enters the chosen stage → a task opens for the deal owner, linked to the deal', async () => {
    const stages = await dealStages();
    const from = stages.find((s) => s.kind === 'open')!;
    // A column of this file's own, so only this file's move can fire the rule.
    const to = (
      await db
        .insert(dealStagesTable)
        .values({
          name: `AU-${STAMP} bosqich`,
          kind: 'open',
          color: 'blue',
          sortOrder: 9700,
          active: true,
        })
        .returning()
    )[0]!;
    madeStages.push(to.id);

    ruleIds.push(
      await saveRule(
        {
          name: `AU-${STAMP} deal rule`,
          triggerType: 'deal_stage',
          triggerStageId: to.id,
          triggerEvent: null,
          actionType: 'create_task',
          actionConfig: {
            title: `AU-${STAMP} shartnoma tayyorlang`,
            assignee: 'owner',
            dueDays: 3,
            priority: 2,
          },
        },
        ctx(authorId),
      ),
    );

    const dealId = await createDeal(
      { clientId, ownerId: assigneeId, stageId: from.id },
      ctx(authorId),
    );
    await moveDeal(dealId, to.id, ctx(authorId));
    await processPendingEvents();

    const [task] = await db
      .select()
      .from(tasks)
      .where(eq(tasks.title, `AU-${STAMP} shartnoma tayyorlang`));
    expect(task).toBeTruthy();
    expect(task!.assigneeId).toBe(assigneeId);
    expect(task!.entityType).toBe('deal');
    expect(task!.entityId).toBe(dealId);
    expect(task!.dueAt).not.toBeNull();
    // The task acts with its author's authority.
    expect(task!.createdBy).toBe(authorId);

    const [rule] = await db
      .select()
      .from(automationRules)
      .where(eq(automationRules.id, ruleIds[0]!));
    expect(rule!.fireCount).toBe(1);
    expect(rule!.lastFiredAt).not.toBeNull();

    // Somebody else's deal walking the SHARED funnel must not pull this
    // rule's trigger. It used to: the trigger was a seeded column, so any
    // other file's move fired it and `fireCount` came back 2 — which is how
    // CI failed once while every local run passed.
    const foreignStage = stages.find((s) => s.id !== from.id)!;
    const foreignDeal = await createDeal(
      { clientId, ownerId: assigneeId, stageId: from.id },
      ctx(authorId),
    );
    await moveDeal(foreignDeal, foreignStage.id, ctx(authorId));
    await processPendingEvents();
    const [after] = await db
      .select()
      .from(automationRules)
      .where(eq(automationRules.id, ruleIds[0]!));
    expect(after!.fireCount, 'only this file may fire this rule').toBe(1);
  });

  it('a lead move fires the notify action; a PAUSED rule stays silent', async () => {
    // Minted, for the same reason the deal trigger is: a shared column is
    // pulled by every other file's lead as well as this one's.
    const to = (
      await db
        .insert(leadStagesTable)
        .values({
          name: `AU-${STAMP} lid bosqichi`,
          kind: 'open',
          color: 'blue',
          sortOrder: 9700,
          active: true,
        })
        .returning()
    )[0]!;
    madeLeadStages.push(to.id);

    const ruleId = await saveRule(
      {
        name: `AU-${STAMP} lead rule`,
        triggerType: 'lead_stage',
        triggerStageId: to.id,
        triggerEvent: null,
        actionType: 'notify',
        actionConfig: { userIds: [assigneeId], text: `AU-${STAMP} lid siljidi` },
      },
      ctx(authorId),
    );
    ruleIds.push(ruleId);

    const lead = await createLead({ name: `AU lead ${STAMP}` }, ctx(authorId));
    await moveLead(lead.id, to.id, '', ctx(authorId));
    await processPendingEvents();

    const sent = await db
      .select()
      .from(notifications)
      .where(
        and(eq(notifications.type, 'AutomationRule'), eq(notifications.userId, assigneeId)),
      );
    expect(sent.length).toBe(1);
    expect(String((sent[0]!.payload as { text: string }).text)).toContain(`AU-${STAMP}`);

    // Paused = silent: same move again after pausing, nothing new arrives.
    await setRuleActive(ruleId, false, ctx(authorId));
    const lead2 = await createLead({ name: `AU lead2 ${STAMP}` }, ctx(authorId));
    await moveLead(lead2.id, to.id, '', ctx(authorId));
    await processPendingEvents();
    const after = await db
      .select()
      .from(notifications)
      .where(
        and(eq(notifications.type, 'AutomationRule'), eq(notifications.userId, assigneeId)),
      );
    expect(after.length).toBe(1);
  });

  it('a warehouse event (ReceiptConfirmed) opens a task for a fixed person, linked to the receipt', async () => {
    ruleIds.push(
      await saveRule(
        {
          name: `AU-${STAMP} receipt rule`,
          triggerType: 'event',
          triggerStageId: null,
          triggerEvent: 'ReceiptConfirmed',
          actionType: 'create_task',
          actionConfig: {
            title: `AU-${STAMP} mijozga xabar bering`,
            assignee: assigneeId,
            dueDays: null,
            priority: 3,
          },
        },
        ctx(authorId),
      ),
    );

    const receiptId = uuidv4();
    const lotId = uuidv4();
    await db.insert(attachments).values({
      entityType: 'receipt_lot',
      entityId: lotId,
      kind: 'photo',
      storageKey: `autest/${lotId}`,
      fileName: 'x.jpg',
      contentType: 'image/jpeg',
      sizeBytes: 1,
      uploadedBy: authorId,
    });
    await confirmReceipt(
      {
        receiptId,
        warehouseId: whId,
        clientId,
        unclaimedMarking: '',
        lots: [
          {
            id: lotId,
            productNameZh: '自动化货',
            boxCount: 1,
            dimsMode: 'uniform',
            boxLengthCm: 30,
            boxWidthCm: 30,
            boxHeightCm: 30,
            boxWeightKg: 4,
          },
        ],
        extraCosts: [],
      },
      ctx(authorId),
    );
    await processPendingEvents();

    const [task] = await db
      .select()
      .from(tasks)
      .where(eq(tasks.title, `AU-${STAMP} mijozga xabar bering`));
    expect(task).toBeTruthy();
    expect(task!.assigneeId).toBe(assigneeId);
    expect(task!.entityType).toBe('receipt');
    expect(task!.entityId).toBe(receiptId);
    expect(task!.dueAt).toBeNull();
    expect(task!.priority).toBe(3);
  });
});
