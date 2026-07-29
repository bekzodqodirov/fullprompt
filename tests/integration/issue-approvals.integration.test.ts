import 'dotenv/config';
import { and, eq } from 'drizzle-orm';
import { v4 as uuidv4 } from 'uuid';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { db, pgClient } from '@/modules/platform/db/client';
import {
  attachments,
  auditLog,
  boxes,
  clients,
  clientTransactions,
  issueApprovals,
  users,
  warehouses,
} from '@/modules/platform/db/schema';
import { confirmReceipt } from '@/modules/wms/receipts/service';
import { issueBoxes } from '@/modules/wms/issue/service';
import {
  decideIssueApproval,
  requestIssueApproval,
} from '@/modules/wms/issue/approvals';

/**
 * Phase 6 against a real database: the recorded permission opens the gate
 * exactly once, only while live, and only for the debt it was granted for.
 * Every case is the predicate that would silently lie without its filter.
 */

const STAMP = Date.now();
let operatorId: string;
let deciderId: string;
let clientId: string;
let whId: string;
const ctx = (actorId: string) => ({ actorId, ip: null, userAgent: null });

async function issuableBox(): Promise<string> {
  const receiptId = uuidv4();
  const lotId = uuidv4();
  await db.insert(attachments).values({
    entityType: 'receipt_lot',
    entityId: lotId,
    kind: 'photo',
    storageKey: `iatest/${lotId}`,
    fileName: 'x.jpg',
    contentType: 'image/jpeg',
    sizeBytes: 1,
    uploadedBy: operatorId,
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
          productNameZh: '欠款货',
          boxCount: 1,
          dimsMode: 'uniform',
          boxLengthCm: 30,
          boxWidthCm: 30,
          boxHeightCm: 30,
          boxWeightKg: 5,
        },
      ],
      extraCosts: [],
    },
    ctx(operatorId),
  );
  return (await db.select().from(boxes).where(eq(boxes.lotId, lotId)))[0]!.id;
}

const charge = (amount: string) =>
  db.insert(clientTransactions).values({
    clientId,
    type: 'charge',
    amount,
    currency: 'USD',
    rateToUsd: '1',
    amountUsd: amount,
    txDate: new Date().toISOString().slice(0, 10),
    createdBy: deciderId,
  });

const tryIssue = (boxId: string) =>
  issueBoxes(
    {
      handoverId: uuidv4(),
      clientId,
      warehouseId: whId,
      boxIds: [boxId],
      personName: 'Qarzdor Vakili',
      personPhone: '+998901234567',
      debtOk: false,
      note: '',
    },
    ctx(operatorId),
  );

beforeAll(async () => {
  const staff = await db.select().from(users).limit(2);
  operatorId = staff[0]!.id;
  deciderId = (staff[1] ?? staff[0])!.id;
  const wh = await db.query.warehouses.findFirst({ where: eq(warehouses.code, 'IAWH') });
  whId =
    wh?.id ??
    (
      await db
        .insert(warehouses)
        .values({
          code: 'IAWH',
          name: 'Approvals WH',
          country: 'UZ',
          type: 'origin',
          timezone: 'Asia/Tashkent',
          batchPrefix: 'IAWH',
        })
        .returning()
    )[0]!.id;
  const [c] = await db
    .insert(clients)
    .values({ clientCode: `IA${STAMP}`.slice(0, 12), name: `Approval debtor ${STAMP}` })
    .returning();
  clientId = c!.id;
  await charge('100');
});

afterAll(async () => {
  await db.delete(issueApprovals).where(eq(issueApprovals.clientId, clientId));
  await db.delete(clientTransactions).where(eq(clientTransactions.clientId, clientId));
  // Boxes/receipts stay (issued/in_stock rows are ordinary history for a
  // throwaway client), but the warehouse is deactivated so later specs'
  // pickers do not inherit it.
  await db.update(warehouses).set({ active: false }).where(eq(warehouses.id, whId));
  await pgClient.end();
});

describe('the recorded permission opens the gate', () => {
  it('no approval → debt_block; approved → the issue goes through and consumes it', async () => {
    const boxId = await issuableBox();
    // The headline red: without any approval the gate refuses.
    await expect(tryIssue(boxId)).rejects.toThrow('debt_block');

    const { id } = await requestIssueApproval(
      { clientId, warehouseId: whId, note: 'mijoz keldi' },
      ctx(operatorId),
    );
    // Still blocked while pending — asking is not being allowed.
    await expect(tryIssue(boxId)).rejects.toThrow('debt_block');

    await decideIssueApproval({ approvalId: id, verdict: 'approved' }, ctx(deciderId));
    const handover = await tryIssue(boxId);
    expect(handover.id).toBeTruthy();

    const [row] = await db.select().from(issueApprovals).where(eq(issueApprovals.id, id));
    expect(row!.status).toBe('consumed');
    expect(row!.consumedHandoverId).toBe(handover.id);

    // Both halves are in the audit log: the decision on the approval row and
    // the handover naming WHICH approval it spent.
    const decisionRows = await db
      .select()
      .from(auditLog)
      .where(and(eq(auditLog.entityType, 'issue_approval'), eq(auditLog.entityId, id)));
    expect(decisionRows.some((r) => r.action === 'status_change')).toBe(true);
    const handoverRows = await db
      .select()
      .from(auditLog)
      .where(and(eq(auditLog.entityType, 'handover'), eq(auditLog.entityId, handover.id)));
    expect(
      handoverRows.some((r) => (r.after as { approvalId?: string })?.approvalId === id),
    ).toBe(true);
  });

  it('one permission opens ONE handover — the second issue blocks again', async () => {
    const boxId = await issuableBox();
    await expect(tryIssue(boxId)).rejects.toThrow('debt_block');
  });

  it('an expired approval is no approval', async () => {
    const boxId = await issuableBox();
    const { id } = await requestIssueApproval({ clientId, warehouseId: whId }, ctx(operatorId));
    await decideIssueApproval({ approvalId: id, verdict: 'approved' }, ctx(deciderId));
    await db
      .update(issueApprovals)
      .set({ expiresAt: new Date(Date.now() - 60_000) })
      .where(eq(issueApprovals.id, id));
    await expect(tryIssue(boxId)).rejects.toThrow('debt_block');
    await db.delete(issueApprovals).where(eq(issueApprovals.id, id));
  });

  it('a debt that GREW past the approved snapshot is a different debt', async () => {
    const boxId = await issuableBox();
    const { id } = await requestIssueApproval({ clientId, warehouseId: whId }, ctx(operatorId));
    await decideIssueApproval({ approvalId: id, verdict: 'approved' }, ctx(deciderId));
    // A new charge after the approval: the decider never saw this figure.
    await charge('50');
    await expect(tryIssue(boxId)).rejects.toThrow('debt_block');
    await db.delete(issueApprovals).where(eq(issueApprovals.id, id));
    await db
      .delete(clientTransactions)
      .where(and(eq(clientTransactions.clientId, clientId), eq(clientTransactions.amount, '50')));
  });

  it('a refusal blocks, and a decision is single-shot', async () => {
    const boxId = await issuableBox();
    const { id } = await requestIssueApproval({ clientId, warehouseId: whId }, ctx(operatorId));
    await decideIssueApproval({ approvalId: id, verdict: 'refused' }, ctx(deciderId));
    await expect(tryIssue(boxId)).rejects.toThrow('debt_block');
    // The second decider learns the question is closed.
    await expect(
      decideIssueApproval({ approvalId: id, verdict: 'approved' }, ctx(deciderId)),
    ).rejects.toThrow('already_decided');
  });

  it('one live request per pair — a duplicate ask is refused, not stacked', async () => {
    const { id } = await requestIssueApproval({ clientId, warehouseId: whId }, ctx(operatorId));
    await expect(
      requestIssueApproval({ clientId, warehouseId: whId }, ctx(operatorId)),
    ).rejects.toThrow('already_requested');
    await decideIssueApproval({ approvalId: id, verdict: 'refused' }, ctx(deciderId));
  });

  it('a zero-debt client has nothing to approve', async () => {
    const [clean] = await db
      .insert(clients)
      .values({ clientCode: `IB${STAMP}`.slice(0, 12), name: `No debt ${STAMP}` })
      .returning();
    await expect(
      requestIssueApproval({ clientId: clean!.id, warehouseId: whId }, ctx(operatorId)),
    ).rejects.toThrow('no_debt');
    await db.delete(clients).where(eq(clients.id, clean!.id));
  });
});
