import 'dotenv/config';
import { and, eq, inArray, sql } from 'drizzle-orm';
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { db, pgClient } from '@/modules/platform/db/client';
import {
  auditLog,
  boxes,
  clientNotices,
  clientTelegramLinks,
  clients,
  lotChecks,
  lotClientConfirms,
  lotCompositionLines,
  lotCompositions,
  notifications,
  receiptLots,
  receipts,
  users,
  warehouses,
} from '@/modules/platform/db/schema';
import type { Actor } from '@/modules/platform/rbac/authorize';
import { clientLabels } from '@/modules/platform/telegram/client-labels';
import { htmlToPlain } from '@/modules/platform/telegram/format';
import { getSetting, setSetting } from '@/modules/platform/settings/service';
import { claimNoticesForSending, settleArrivalNotice } from '@/modules/wms/notices/arrival';
import { sendDueArrivalNotices, SWEPT_NOTICE_KINDS } from '@/modules/wms/notices/arrival-jobs';
import {
  NOTICE_LOT_ASK,
  NOTICE_LOT_REASK,
  answerClientAsk,
  askClientAboutReceipt,
  clientAskFacts,
  clientReaskStatusFor,
} from '@/modules/wms/receipts/client-confirm';
import { askFits } from '@/modules/wms/receipts/client-confirm-text';
import { armClientReask, REASK_SETTLE_MINUTES } from '@/modules/wms/receipts/client-reask';
import { editLot } from '@/modules/wms/receipts/edit';
import { afterLotGrown, growLotInTx, shrinkGrownInTx } from '@/modules/wms/receipts/grow-lot';
import { checkLot, lotCheckViewsFor, type LotCheckActor } from '@/modules/wms/receipts/lot-check';
import { botHarness, type BotHarness } from '../fixtures/bot-harness';

/**
 * «Yuk qayta tortilganda mijozga savol o'zi qayta borsin» — the owner's «1 b»
 * of 2026-11-12 (docs/PRIXOD-JAVOBLAR.md §1), through the REAL doors (#531):
 * a person's «Mijozdan so'rash» delivered by the sweep (which remembers the
 * tag the client now holds), a ✏️ re-weigh through `editLot`, a growth and a
 * take-back through the count kernel and the hook both count doors share
 * (`afterLotGrown`), the automatic question delivered by the same sweep —
 * with the Bot API swapped for the recorder (no network here, no token in CI).
 *
 * Every row this file drives is made due by moving its `send_after` to 2001
 * and sweeping on a clock two days in the past (client-push's discipline): no
 * stranger's row another file left behind is ever due.
 */

const RUN = String(Date.now()).slice(-6);
const SWEEP_AT = new Date(Date.now() - 2 * 86_400_000);
const CHAT = 8_400_000_000 + Number(RUN) * 10 + 1;
const CODE = `RQ${RUN}`;

let h: BotHarness;
let staffId = '';
const wh = { cn: '', uz: '' };
let clientId = '';
let silentClientId = '';
const receipt = { main: '', quiet: '' };
const lot = { K: '', L: '', Q: '', D: '' };
const madeBoxes: string[] = [];
const saved = { reask: undefined as unknown, app: process.env.APP_URL };

const logist = (): LotCheckActor => ({ id: staffId, permissions: new Set(['plans.manage']), warehouseScoped: false, warehouseIds: [] });
const manager = (): Actor =>
  ({ id: staffId, fullName: `RQ boshliq ${RUN}`, roles: ['warehouse_manager'], permissions: new Set(['receipts.edit', 'receipts.void']) }) as unknown as Actor;
const ctx = () => ({ actorId: staffId, ip: null, userAgent: 'client-reask.integration' });

async function mintLot(key: keyof typeof lot, receiptId: string, seq: number, letter: string, n: number, kg: string, m3: string) {
  const [row] = await db
    .insert(receiptLots)
    .values({ receiptId, seq, letter, dimsMode: 'mixed', productNameZh: `秤${RUN}${key}`, productNameRu: `Tarozi ${RUN} ${key}`, boxCount: n, totalWeightKg: kg, totalVolumeM3: m3 })
    .returning({ id: receiptLots.id });
  lot[key] = row!.id;
  for (let i = 1; i <= n; i += 1) {
    const [box] = await db
      .insert(boxes)
      .values({ lotId: row!.id, seqInLot: i, shortCode: `RQ${RUN}${key}${i}`, status: 'in_stock', currentWarehouseId: wh.cn })
      .returning({ id: boxes.id });
    madeBoxes.push(box!.id);
  }
}

const rowOf = async (kind: string, receiptId = receipt.main) =>
  (
    (await db.execute(sql`
      SELECT id, status, send_after, sent_at, last_error, asked_tag, asked_at
        FROM client_notices WHERE kind = ${kind} AND ref_id = ${receiptId}::uuid
    `)) as unknown as {
      id: string;
      status: string;
      send_after: Date;
      sent_at: Date | null;
      last_error: string | null;
      asked_tag: string | null;
      asked_at: Date | null;
    }[]
  )[0];
const dueNow = (kind: string, receiptId = receipt.main) =>
  db
    .update(clientNotices)
    .set({ sendAfter: new Date('2001-01-01T00:00:00Z') })
    .where(and(eq(clientNotices.kind, kind), eq(clientNotices.refId, receiptId)));
const tagNow = async (receiptId = receipt.main) => {
  const facts = await clientAskFacts(receiptId);
  if ('skip' in facts) throw new Error(`facts skipped: ${facts.skip}`);
  return facts.tag;
};
/** What send.ts posted since the mark — the text as plain, and the ✅ button's callback. */
function sentSince(mark: ReturnType<BotHarness['mark']>) {
  return h.since(mark).sent.map((call) => {
    const raw = call.body.reply_markup;
    const markup = (typeof raw === 'string' ? JSON.parse(raw) : raw) as { inline_keyboard?: { callback_data?: string }[][] } | undefined;
    const yes = (markup?.inline_keyboard ?? []).flat().find((b) => b.callback_data?.startsWith('yt:1:'))?.callback_data ?? null;
    return { chatId: Number(call.body.chat_id), text: htmlToPlain(String(call.body.text ?? call.body.caption ?? '')), yes };
  });
}
/** ✏️ through the real door: the mixed lot's kilos to `kg`. */
const reweigh = async (key: keyof typeof lot, kg: number, m3 = 1) => {
  const [row] = await db.select().from(receiptLots).where(eq(receiptLots.id, lot[key]));
  await editLot(
    {
      lotId: lot[key],
      productNameZh: row!.productNameZh,
      productNameRu: row!.productNameRu ?? '',
      boxCount: row!.boxCount,
      totalWeightKg: kg,
      totalVolumeM3: m3,
      note: null,
    } as Parameters<typeof editLot>[0],
    manager(),
    ctx(),
  );
};
/** A colleague's «✅ To'g'ri» on a lot, through the real door, posting what the card printed. */
async function tick(key: keyof typeof lot) {
  const [row] = await db.select().from(receiptLots).where(eq(receiptLots.id, lot[key]));
  const token = (
    (await db.execute(sql`SELECT checked_at::text AS at FROM lot_checks WHERE lot_id = ${lot[key]}::uuid`)) as unknown as { at: string }[]
  )[0]?.at;
  return checkLot(
    {
      lotId: lot[key],
      seen: { nameZh: row!.productNameZh, nameRu: row!.productNameRu ?? '', boxCount: row!.boxCount, clientId, kg: row!.totalWeightKg, m3: row!.totalVolumeM3 },
      seenCheckedAt: token ?? null,
    },
    logist(),
    ctx(),
  );
}
const stateOf = async (key: keyof typeof lot) => (await lotCheckViewsFor([lot[key]])).get(lot[key])!;
/** The client's answer to whatever question they hold now (the tag of today's facts). */
const answer = async (verdict: 'yes' | 'no') =>
  answerClientAsk({ chatId: BigInt(CHAT), receiptId: receipt.main, verdict, tag: await tagNow() });

/** A person's question, delivered by the sweep: the tag the client holds is remembered. */
async function deliverPersonQuestion(): Promise<string> {
  await db.execute(sql`DELETE FROM client_notices WHERE kind = ${NOTICE_LOT_ASK} AND ref_id = ${receipt.main}::uuid`);
  await askClientAboutReceipt(receipt.main, logist(), ctx(), askFits);
  await dueNow(NOTICE_LOT_ASK);
  await sendDueArrivalNotices(SWEEP_AT);
  const row = await rowOf(NOTICE_LOT_ASK);
  expect(row?.status).toBe('sent');
  return row!.asked_tag!;
}

beforeAll(async () => {
  h = botHarness();
  process.env.APP_URL = 'https://gsrwms.test';
  saved.reask = await getSetting('client_reask_on_reweigh');
  await setSetting('client_reask_on_reweigh', true, null);
  const people = await db.select({ id: users.id }).from(users).where(eq(users.active, true)).limit(1);
  staffId = people[0]!.id;
  for (const [key, country, type] of [
    ['cn', 'CN', 'origin'],
    ['uz', 'UZ', 'distribution'],
  ] as const) {
    const [row] = await db
      .insert(warehouses)
      .values({ code: `R${key.toUpperCase()}${RUN}`, name: `Qayta ${key} ${RUN}`, country, type, timezone: 'Asia/Tashkent', batchPrefix: `R${key.toUpperCase()}${RUN}` })
      .returning({ id: warehouses.id });
    wh[key] = row!.id;
  }
  const [client] = await db.insert(clients).values({ clientCode: CODE, name: `Qayta mijoz ${RUN}`, locale: 'uz' }).returning({ id: clients.id });
  clientId = client!.id;
  await db.insert(clientTelegramLinks).values({ clientId, telegramChatId: BigInt(CHAT), status: 'linked', linkedAt: new Date() });
  // A client with NO Telegram: nothing is ever armed for them.
  const [silent] = await db.insert(clients).values({ clientCode: `RS${RUN}`, name: `Jim mijoz ${RUN}` }).returning({ id: clients.id });
  silentClientId = silent!.id;
  for (const [key, owner] of [
    ['main', clientId],
    ['quiet', silentClientId],
  ] as const) {
    const [row] = await db
      .insert(receipts)
      .values({
        warehouseId: wh.cn,
        number: `RQ-${RUN}-${key}`,
        clientId: owner,
        status: 'confirmed',
        createdBy: staffId,
        receivedAt: new Date(Date.now() - 7_200_000),
        confirmedAt: new Date(Date.now() - 3_600_000),
        confirmedBy: staffId,
      })
      .returning({ id: receipts.id });
    receipt[key] = row!.id;
  }
  await mintLot('K', receipt.main, 1, 'A', 3, '100.000', '1.0000');
  await mintLot('L', receipt.main, 2, 'B', 2, '40.714', '0.3140');
  await mintLot('Q', receipt.quiet, 1, 'A', 2, '50.000', '0.5000');
  // A lot the old arithmetic DRIFTED on (tests/unit/mixed-walk.test.ts): on the quiet prixod, which asks nobody.
  await mintLot('D', receipt.quiet, 2, 'B', 7, '40.714', '0.3140');
});

beforeEach(async () => {
  // Every test starts from «the client holds nothing»: no question, no answer.
  for (const id of Object.values(receipt).filter(Boolean)) await db.delete(clientNotices).where(eq(clientNotices.refId, id));
  await db.delete(lotClientConfirms).where(inArray(lotClientConfirms.lotId, Object.values(lot).filter(Boolean)));
  // …and no colleague's tick: a ✅ there decides whether a lot is still on the ❓ list.
  await db.delete(lotChecks).where(inArray(lotChecks.lotId, Object.values(lot).filter(Boolean)));
  await db.update(receiptLots).set({ totalWeightKg: '100.000', totalVolumeM3: '1.0000' }).where(eq(receiptLots.id, lot.K));
  await setSetting('client_reask_on_reweigh', true, null);
});

afterAll(async () => {
  for (const id of Object.values(receipt).filter(Boolean)) await db.delete(clientNotices).where(eq(clientNotices.refId, id));
  const lotIds = Object.values(lot).filter(Boolean);
  if (lotIds.length > 0) {
    await db.delete(lotClientConfirms).where(inArray(lotClientConfirms.lotId, lotIds));
    // A growth minted cartons of its own, with their movements; they go with the lots.
    await db.execute(sql`
      DELETE FROM box_movements WHERE box_id IN (SELECT id FROM boxes WHERE lot_id IN (${sql.join(
        lotIds.map((id) => sql`${id}::uuid`),
        sql`, `,
      )}))
    `);
    await db.delete(boxes).where(inArray(boxes.lotId, lotIds));
    await db.delete(receiptLots).where(inArray(receiptLots.id, lotIds));
  }
  await db
    .delete(notifications)
    .where(and(inArray(notifications.type, ['ClientLotDisputed', 'ClientLotConfirmed', 'ReceiptMeasureCorrected']), sql`${notifications.payload}::text LIKE ${`%${CODE}%`}`));
  const receiptIds = Object.values(receipt).filter(Boolean);
  if (receiptIds.length > 0) await db.delete(receipts).where(inArray(receipts.id, receiptIds));
  for (const id of [clientId, silentClientId].filter(Boolean)) {
    await db.delete(clientTelegramLinks).where(eq(clientTelegramLinks.clientId, id));
    await db.delete(clients).where(eq(clients.id, id));
  }
  const whIds = Object.values(wh).filter(Boolean);
  if (whIds.length > 0) await db.update(warehouses).set({ active: false }).where(inArray(warehouses.id, whIds));
  await setSetting('client_reask_on_reweigh', saved.reask as boolean, null);
  if (saved.app === undefined) delete process.env.APP_URL;
  else process.env.APP_URL = saved.app;
  h.restore();
  await pgClient.end();
});

describe('the question the client holds is remembered at delivery (0147)', () => {
  it('a person’s question the sweep delivered remembers the tag of exactly what it printed', async () => {
    const tag = await deliverPersonQuestion();
    expect(tag).toBe(await tagNow());
    expect((await rowOf(NOTICE_LOT_ASK))?.asked_at).not.toBeNull();
  });

  it('the automatic question is a kind the sweep claims', () => {
    expect(SWEPT_NOTICE_KINDS).toContain(NOTICE_LOT_REASK);
  });
});

describe('a re-weigh through ✏️ asks the client again, by itself', () => {
  it('armed after the commit, due ten minutes after the LAST correction — a second correction slides it', async () => {
    await deliverPersonQuestion();
    const before = Date.now();
    await reweigh('K', 110);
    const first = await rowOf(NOTICE_LOT_REASK);
    expect(first?.status).toBe('pending');
    const due = new Date(first!.send_after).getTime();
    expect(due).toBeGreaterThanOrEqual(before + (REASK_SETTLE_MINUTES - 1) * 60_000);
    expect(due).toBeLessThanOrEqual(Date.now() + (REASK_SETTLE_MINUTES + 1) * 60_000);
    await new Promise((resolve) => setTimeout(resolve, 20));
    await reweigh('K', 120);
    expect(new Date((await rowOf(NOTICE_LOT_REASK))!.send_after).getTime()).toBeGreaterThan(due);
  });

  it('the sweep sends the question with its «updated» line and the NEW tag, remembers it, and writes the History', async () => {
    await deliverPersonQuestion();
    await reweigh('K', 110);
    await dueNow(NOTICE_LOT_REASK);
    const mark = h.mark();
    await sendDueArrivalNotices(SWEEP_AT);
    const sent = sentSince(mark).filter((m) => m.chatId === CHAT);
    expect(sent).toHaveLength(1);
    expect(sent[0]!.text).toContain(clientLabels('uz').confirmAskUpdated);
    const tag = await tagNow();
    expect(sent[0]!.yes).toBe(`yt:1:${receipt.main}:${tag}`);
    const row = await rowOf(NOTICE_LOT_REASK);
    expect([row?.status, row?.asked_tag]).toEqual(['sent', tag]);
    const history = await db
      .select({ actorId: auditLog.actorId, after: auditLog.after })
      .from(auditLog)
      .where(and(eq(auditLog.entityType, 'receipt'), eq(auditLog.entityId, receipt.main)));
    expect(history.some((r) => r.actorId === null && String((r.after as { clientAsk?: string } | null)?.clientAsk ?? '').includes('o’zi qayta so’raldi'))).toBe(true);
    expect((await clientReaskStatusFor(receipt.main))?.state).toBe('sent');
  });

  it('an edit and its reversal inside the window: the held question is stood down at once, and never sent', async () => {
    await deliverPersonQuestion();
    await reweigh('K', 110);
    expect((await clientReaskStatusFor(receipt.main))?.state).toBe('waiting');
    await reweigh('K', 100);
    const row = await rowOf(NOTICE_LOT_REASK);
    expect([row?.status, row?.last_error]).toEqual(['skipped', 'not_needed']);
    // Rightly not sent: the card stops promising it.
    expect(await clientReaskStatusFor(receipt.main)).toBeNull();
    await dueNow(NOTICE_LOT_REASK);
    const mark = h.mark();
    await sendDueArrivalNotices(SWEEP_AT);
    expect(sentSince(mark).filter((m) => m.chatId === CHAT)).toHaveLength(0);
  });

  it('a count corrected through ✏️ (the same kilos) asks too — the count is on the question and in its tag', async () => {
    await deliverPersonQuestion();
    const [row] = await db.select().from(receiptLots).where(eq(receiptLots.id, lot.K));
    await editLot(
      { lotId: lot.K, productNameZh: row!.productNameZh, productNameRu: row!.productNameRu ?? '', boxCount: 2, totalWeightKg: 100, totalVolumeM3: 1, note: null } as Parameters<
        typeof editLot
      >[0],
      manager(),
      ctx(),
    );
    try {
      expect((await rowOf(NOTICE_LOT_REASK))?.status).toBe('pending');
    } finally {
      // Back to three cartons: the third is minted again, the lot as it was.
      await editLot(
        { lotId: lot.K, productNameZh: row!.productNameZh, productNameRu: row!.productNameRu ?? '', boxCount: 3, totalWeightKg: 100, totalVolumeM3: 1, note: null } as Parameters<
          typeof editLot
        >[0],
        manager(),
        ctx(),
      );
    }
  });

  it('below what a list prints (100.004 kg after 100.000) nothing is armed', async () => {
    await deliverPersonQuestion();
    await reweigh('K', 100.004);
    expect(await rowOf(NOTICE_LOT_REASK)).toBeUndefined();
  });

  it('a client who holds no question is not «re»-asked', async () => {
    await reweigh('K', 110);
    expect(await rowOf(NOTICE_LOT_REASK)).toBeUndefined();
  });

  it('a client with no Telegram is never armed — even holding a question that no longer fits (linked once, unlinked since)', async () => {
    await db.execute(sql`
      INSERT INTO client_notices (client_id, kind, ref_type, ref_id, send_after, staff_notified_at, status, sent_at, asked_tag, asked_at)
      VALUES (${silentClientId}::uuid, ${NOTICE_LOT_ASK}, 'receipt', ${receipt.quiet}::uuid, now(), now(), 'sent', now(), '00000000', now())
    `);
    await armClientReask(lot.Q);
    expect(await rowOf(NOTICE_LOT_REASK, receipt.quiet)).toBeUndefined();
  });

  it('the switch off: nothing is armed, and a held question is not sent', async () => {
    await deliverPersonQuestion();
    await setSetting('client_reask_on_reweigh', false, null);
    await reweigh('K', 110);
    expect(await rowOf(NOTICE_LOT_REASK)).toBeUndefined();
    await setSetting('client_reask_on_reweigh', true, null);
    await reweigh('K', 120);
    await setSetting('client_reask_on_reweigh', false, null);
    await dueNow(NOTICE_LOT_REASK);
    await sendDueArrivalNotices(SWEEP_AT);
    expect((await rowOf(NOTICE_LOT_REASK))?.last_error).toBe('switched_off');
  });

  it('cargo that left China (unloaded in Uzbekistan) is not asked', async () => {
    await deliverPersonQuestion();
    // The LIVE cartons only: a carton an earlier count correction voided stays void.
    const live = and(inArray(boxes.lotId, [lot.K, lot.L]), sql`${boxes.status} <> 'void'`);
    await db.update(boxes).set({ status: 'ready_for_pickup', currentWarehouseId: wh.uz }).where(live);
    try {
      await reweigh('K', 110);
      expect(await rowOf(NOTICE_LOT_REASK)).toBeUndefined();
      // …not even with a question on its way at that moment: an «in flight» arms only where it can be asked.
      await db.execute(sql`
        INSERT INTO client_notices (client_id, kind, ref_type, ref_id, send_after, staff_notified_at, status, claimed_at)
        VALUES (${clientId}::uuid, 'received_cn', 'receipt', ${receipt.main}::uuid, '2001-01-01', now(), 'sending', now())
      `);
      await reweigh('K', 120);
      expect(await rowOf(NOTICE_LOT_REASK)).toBeUndefined();
    } finally {
      await db.update(boxes).set({ status: 'in_stock', currentWarehouseId: wh.cn }).where(live);
    }
  });
});

describe('the person’s question and the system’s never both go', () => {
  it('a person’s question still waiting: nothing is armed — it will carry the new figures itself', async () => {
    // The client holds an older question (delivered an hour ago), and the person has asked again since.
    await deliverPersonQuestion();
    await db.execute(sql`UPDATE client_notices SET sent_at = now() - interval '1 hour' WHERE kind = ${NOTICE_LOT_ASK} AND ref_id = ${receipt.main}::uuid`);
    await askClientAboutReceipt(receipt.main, logist(), ctx(), askFits);
    expect((await rowOf(NOTICE_LOT_ASK))?.status).toBe('pending');
    await reweigh('K', 110);
    expect(await rowOf(NOTICE_LOT_REASK)).toBeUndefined();
  });

  it('a person’s question waiting when the system’s comes due stands it down at SEND time too (a stand-down the door missed)', async () => {
    await deliverPersonQuestion();
    await db.execute(sql`UPDATE client_notices SET sent_at = now() - interval '1 hour' WHERE kind = ${NOTICE_LOT_ASK} AND ref_id = ${receipt.main}::uuid`);
    await reweigh('K', 110);
    expect((await rowOf(NOTICE_LOT_REASK))?.status).toBe('pending');
    // The person's question re-armed behind the door's back (its own stand-down failed), not yet due.
    await db.execute(sql`
      UPDATE client_notices SET status = 'pending', send_after = now() + interval '1 day'
       WHERE kind = ${NOTICE_LOT_ASK} AND ref_id = ${receipt.main}::uuid
    `);
    await dueNow(NOTICE_LOT_REASK);
    const mark = h.mark();
    await sendDueArrivalNotices(SWEEP_AT);
    expect(sentSince(mark).filter((m) => m.chatId === CHAT)).toHaveLength(0);
    const row = await rowOf(NOTICE_LOT_REASK);
    expect([row?.status, row?.last_error]).toEqual(['skipped', 'superseded']);
  });

  it('a receipt push that will go WITHOUT buttons holds nothing back: it asks nothing', async () => {
    const saved = await getSetting('client_confirm_on_receipt');
    await setSetting('client_confirm_on_receipt', false, null);
    try {
      await deliverPersonQuestion();
      await db.execute(sql`
        INSERT INTO client_notices (client_id, kind, ref_type, ref_id, send_after, staff_notified_at, status)
        VALUES (${clientId}::uuid, 'received_cn', 'receipt', ${receipt.main}::uuid, now() + interval '1 day', now(), 'pending')
      `);
      await reweigh('K', 110);
      expect((await rowOf(NOTICE_LOT_REASK))?.status).toBe('pending');
    } finally {
      await setSetting('client_confirm_on_receipt', saved as boolean, null);
    }
  });

  it('…nor one that goes without buttons because a tarkib is written (the push asks about no lot with a paper)', async () => {
    await deliverPersonQuestion();
    await db.execute(sql`
      INSERT INTO client_notices (client_id, kind, ref_type, ref_id, send_after, staff_notified_at, status)
      VALUES (${clientId}::uuid, 'received_cn', 'receipt', ${receipt.main}::uuid, now() + interval '1 day', now(), 'pending')
    `);
    await db.insert(lotCompositions).values({ lotId: lot.K, seenBoxCount: 3, savedBy: staffId });
    await db.insert(lotCompositionLines).values([{ lotId: lot.K, seq: 1, name: `Tarozi ${RUN}`, pieces: 3, weightKg: '100.000', volumeM3: '1.0000' }]);
    try {
      await reweigh('K', 110);
      expect((await rowOf(NOTICE_LOT_REASK))?.status).toBe('pending');
    } finally {
      await db.delete(lotCompositionLines).where(eq(lotCompositionLines.lotId, lot.K));
      await db.delete(lotCompositions).where(eq(lotCompositions.lotId, lot.K));
    }
  });

  it('a person’s press stands a held automatic question down', async () => {
    await deliverPersonQuestion();
    // Out of the person door's ten-minute cooldown: the delivery is an hour old.
    await db.execute(sql`UPDATE client_notices SET sent_at = now() - interval '1 hour' WHERE kind = ${NOTICE_LOT_ASK} AND ref_id = ${receipt.main}::uuid`);
    await reweigh('K', 110);
    expect((await rowOf(NOTICE_LOT_REASK))?.status).toBe('pending');
    await askClientAboutReceipt(receipt.main, logist(), ctx(), askFits);
    const row = await rowOf(NOTICE_LOT_REASK);
    expect([row?.status, row?.last_error]).toEqual(['skipped', 'superseded']);
    expect(await clientReaskStatusFor(receipt.main)).toBeNull();
  });
});

describe('a question ON ITS WAY when the correction lands (the design judge’s two blockers)', () => {
  it('the receipt push in flight with no earlier question: armed anyway, and sent only if the push carried the OLD figures', async () => {
    await db.execute(sql`
      INSERT INTO client_notices (client_id, kind, ref_type, ref_id, send_after, staff_notified_at, status, claimed_at)
      VALUES (${clientId}::uuid, 'received_cn', 'receipt', ${receipt.main}::uuid, '2001-01-01', now(), 'sending', now())
    `);
    const oldTag = await tagNow();
    await reweigh('K', 110);
    // Nothing delivered, nothing answered — but a question is on its way: armed.
    expect((await rowOf(NOTICE_LOT_REASK))?.status).toBe('pending');
    // The push delivered the figures it read BEFORE the correction.
    await db.execute(sql`
      UPDATE client_notices SET status = 'sent', sent_at = now(), asked_tag = ${oldTag}, asked_at = now()
       WHERE kind = 'received_cn' AND ref_id = ${receipt.main}::uuid
    `);
    await dueNow(NOTICE_LOT_REASK);
    const mark = h.mark();
    await sendDueArrivalNotices(SWEEP_AT);
    expect(sentSince(mark).filter((m) => m.chatId === CHAT)).toHaveLength(1);
  });

  it('…and when the push in flight already carried the NEW figures, the armed question is not sent', async () => {
    await db.execute(sql`
      INSERT INTO client_notices (client_id, kind, ref_type, ref_id, send_after, staff_notified_at, status, claimed_at)
      VALUES (${clientId}::uuid, 'received_cn', 'receipt', ${receipt.main}::uuid, '2001-01-01', now(), 'sending', now())
    `);
    await reweigh('K', 110);
    expect((await rowOf(NOTICE_LOT_REASK))?.status).toBe('pending');
    await db.execute(sql`
      UPDATE client_notices SET status = 'sent', sent_at = now(), asked_tag = ${await tagNow()}, asked_at = now()
       WHERE kind = 'received_cn' AND ref_id = ${receipt.main}::uuid
    `);
    await dueNow(NOTICE_LOT_REASK);
    const mark = h.mark();
    await sendDueArrivalNotices(SWEEP_AT);
    expect(sentSince(mark).filter((m) => m.chatId === CHAT)).toHaveLength(0);
    expect((await rowOf(NOTICE_LOT_REASK))?.last_error).toBe('not_needed');
  });

  it('a re-armed question that went anyway is REMEMBERED — the same question never goes twice', async () => {
    await deliverPersonQuestion();
    await reweigh('K', 110);
    await dueNow(NOTICE_LOT_REASK);
    // The sweep claims it; a further correction re-arms it while it is out; it is
    // delivered with what the preparer reads NOW (the latest figures).
    const [claimed] = (await claimNoticesForSending(50, SWEEP_AT, [NOTICE_LOT_REASK])).filter((row) => row.refId === receipt.main);
    await reweigh('K', 120);
    expect((await rowOf(NOTICE_LOT_REASK))?.status).toBe('pending');
    await db.execute(sql`UPDATE client_notices SET status = 'sending', claimed_at = ${claimed!.claimedAt!.toISOString()}::timestamptz WHERE id = ${claimed!.id}::uuid`);
    // (Re-claimed by hand above so the real sweep can deliver it; then re-armed again by the correction's own arm.)
    await reweigh('K', 120.004);
    await dueNow(NOTICE_LOT_REASK);
    const mark = h.mark();
    await sendDueArrivalNotices(SWEEP_AT);
    expect(sentSince(mark).filter((m) => m.chatId === CHAT)).toHaveLength(1);
    expect((await rowOf(NOTICE_LOT_REASK))?.asked_tag).toBe(await tagNow());
    // Ten minutes later the held row is looked at again: the client already holds these figures.
    await dueNow(NOTICE_LOT_REASK);
    const again = h.mark();
    await sendDueArrivalNotices(SWEEP_AT);
    expect(sentSince(again).filter((m) => m.chatId === CHAT)).toHaveLength(0);
  });
});

describe('the person’s door after the system asked', () => {
  it('right after the system’s question went, a person’s press is «too soon» — the same question minutes apart is noise', async () => {
    await deliverPersonQuestion();
    await db.execute(sql`UPDATE client_notices SET sent_at = now() - interval '1 hour' WHERE kind = ${NOTICE_LOT_ASK} AND ref_id = ${receipt.main}::uuid`);
    await reweigh('K', 110);
    await dueNow(NOTICE_LOT_REASK);
    await sendDueArrivalNotices(SWEEP_AT);
    await expect(askClientAboutReceipt(receipt.main, logist(), ctx(), askFits)).rejects.toMatchObject({ code: 'too_soon' });
  });

  it('a delivered automatic question stays on the card after a later one is rightly not sent', async () => {
    await deliverPersonQuestion();
    await reweigh('K', 110);
    await dueNow(NOTICE_LOT_REASK);
    await sendDueArrivalNotices(SWEEP_AT);
    // A further correction arms it again, and its reversal stands it down.
    await reweigh('K', 120);
    await reweigh('K', 110);
    const row = await rowOf(NOTICE_LOT_REASK);
    expect(row?.status).toBe('skipped');
    expect((await clientReaskStatusFor(receipt.main))?.state).toBe('sent');
    // …and the client's answer, given to the system's newer question, reaches the person who asked
    // first and was never answered (the owner lens, O3).
    await answer('yes');
    const answers = await db.select({ askedBy: lotClientConfirms.askedBy }).from(lotClientConfirms).where(eq(lotClientConfirms.lotId, lot.K));
    expect(answers.map((r) => r.askedBy)).toEqual([staffId]);
  });
});

describe('a re-arm while the question is on its way survives the settle', () => {
  it('the sweep’s settle of a claim no longer held writes nothing', async () => {
    await deliverPersonQuestion();
    await reweigh('K', 110);
    await dueNow(NOTICE_LOT_REASK);
    const claimed = (await claimNoticesForSending(50, SWEEP_AT, [NOTICE_LOT_REASK])).filter((row) => row.refId === receipt.main);
    expect(claimed).toHaveLength(1);
    // A further correction lands while the message is out.
    await reweigh('K', 120);
    expect((await rowOf(NOTICE_LOT_REASK))?.status).toBe('pending');
    expect(await settleArrivalNotice(claimed[0]!.id, 'sent', undefined, claimed[0]!.claimedAt)).toBe(false);
    expect((await rowOf(NOTICE_LOT_REASK))?.status).toBe('pending');
  });
});

describe('the answer to the system’s question', () => {
  const confirmedTold = async () =>
    (
      await db
        .select({ id: notifications.id })
        .from(notifications)
        .where(and(eq(notifications.type, 'ClientLotConfirmed'), sql`${notifications.payload}::text LIKE ${`%${CODE}%`}`))
    ).length;

  it('is nobody’s question once the person’s was answered: recorded with no asker, and a plain ✅ tells nobody', async () => {
    await deliverPersonQuestion();
    // The client answered the person's question — the person was told then.
    expect((await answer('yes')).outcome).toBe('recorded');
    await reweigh('K', 110);
    await dueNow(NOTICE_LOT_REASK);
    await sendDueArrivalNotices(SWEEP_AT);
    const told = await confirmedTold();
    expect((await answer('yes')).outcome).toBe('recorded');
    const rows = await db.select({ askedBy: lotClientConfirms.askedBy }).from(lotClientConfirms).where(eq(lotClientConfirms.lotId, lot.K));
    expect(rows.map((r) => r.askedBy)).toEqual([null]);
    expect(await confirmedTold()).toBe(told);
  });

  it('a person who asked and was never answered is the asker of the answer to the system’s newer question (the owner lens, O3)', async () => {
    await deliverPersonQuestion();
    await reweigh('K', 110);
    await dueNow(NOTICE_LOT_REASK);
    await sendDueArrivalNotices(SWEEP_AT);
    expect((await rowOf(NOTICE_LOT_REASK))?.status).toBe('sent');
    expect((await answer('no')).outcome).toBe('recorded');
    const rows = await db.select({ askedBy: lotClientConfirms.askedBy }).from(lotClientConfirms).where(eq(lotClientConfirms.lotId, lot.K));
    expect(rows.map((r) => r.askedBy)).toEqual([staffId]);
  });
});

describe('a question delivered before 0147 left no tag', () => {
  it('a FULL answer that no longer holds is the trigger', async () => {
    const facts = await clientAskFacts(receipt.main);
    if ('skip' in facts) throw new Error('facts');
    // The client answered a full question; no row remembers what it printed.
    await db.insert(lotClientConfirms).values(
      facts.lots.map((l) => ({
        lotId: l.lotId,
        verdict: 'yes' as const,
        shownZh: l.zh,
        shownRu: l.ru,
        shownCount: l.count,
        shownClientId: clientId,
        shownGoodsKey: l.goodsKey,
        chatId: BigInt(CHAT),
      })),
    );
    await db.execute(sql`
      UPDATE lot_client_confirms SET shown_kg = round(l.total_weight_kg, 2), shown_m3 = round(l.total_volume_m3, 3)
        FROM receipt_lots l WHERE l.id = lot_client_confirms.lot_id AND l.receipt_id = ${receipt.main}::uuid
    `);
    await reweigh('K', 110);
    expect((await rowOf(NOTICE_LOT_REASK))?.status).toBe('pending');
  });
});

describe('what is on the ❓ list decides (the owner lens, O6 and O9)', () => {
  it('a correction taken back after the system asked: the client’s ✅ on the old figures stands again, and nothing is asked a third time', async () => {
    await deliverPersonQuestion();
    expect((await answer('yes')).outcome).toBe('recorded');
    await reweigh('K', 110);
    expect((await stateOf('K')).state).toBe('stale');
    await dueNow(NOTICE_LOT_REASK);
    await sendDueArrivalNotices(SWEEP_AT);
    expect((await rowOf(NOTICE_LOT_REASK))?.status).toBe('sent');
    // Back to the figures the client confirmed: their ✅ holds again.
    await reweigh('K', 100);
    expect((await stateOf('K')).state).toBe('checked');
    expect((await rowOf(NOTICE_LOT_REASK))?.status).toBe('sent');
    await dueNow(NOTICE_LOT_REASK);
    const mark = h.mark();
    await sendDueArrivalNotices(SWEEP_AT);
    expect(sentSince(mark).filter((m) => m.chatId === CHAT)).toHaveLength(0);
  });

  it('a colleague’s tick a re-weigh broke asks the client, though no question was ever delivered («To‘g‘ri — mijoz tasdiqladi»)', async () => {
    await tick('K');
    expect((await stateOf('K')).state).toBe('checked');
    await reweigh('K', 110);
    expect((await stateOf('K')).person?.moved.measures).toBe(true);
    expect((await rowOf(NOTICE_LOT_REASK))?.status).toBe('pending');
  });

  it('…and a re-weigh no list would show leaves the tick standing and asks nothing', async () => {
    await tick('K');
    await reweigh('K', 100.004);
    expect((await stateOf('K')).state).toBe('checked');
    expect(await rowOf(NOTICE_LOT_REASK)).toBeUndefined();
  });
});

describe('the count doors reach it through their shared hook', () => {
  it('a growth committed, then `afterLotGrown` — armed', async () => {
    await deliverPersonQuestion();
    await db.transaction((tx) =>
      growLotInTx(tx, { lotId: lot.K, add: 1, warehouseId: wh.cn, actorId: staffId, reason: 'sinov', batchId: crypto.randomUUID(), side: 'load' }),
    );
    await afterLotGrown(lot.K);
    expect((await rowOf(NOTICE_LOT_REASK))?.status).toBe('pending');
  });

  it('a mixed lot grown in one press and taken back one carton a press lands EXACTLY where it began', async () => {
    const batchId = crypto.randomUUID();
    const grown = await db.transaction((tx) =>
      growLotInTx(tx, { lotId: lot.L, add: 6, warehouseId: wh.cn, actorId: staffId, reason: 'sinov', batchId, side: 'load' }),
    );
    for (const box of grown.boxes) {
      await db.transaction((tx) => shrinkGrownInTx(tx, { lotId: lot.L, boxIds: [box.id], actorId: staffId, reason: 'sinov', batchId, side: 'load' }));
    }
    const [row] = await db.select().from(receiptLots).where(eq(receiptLots.id, lot.L));
    expect([row!.boxCount, row!.totalWeightKg, row!.totalVolumeM3]).toEqual([2, '40.714', '0.3140']);
  });

  it('…and on a lot the old arithmetic DRIFTED: 7 cartons of 40.714 kg grown by 6 and taken back one a press ends on 40.714, not 40.716', async () => {
    const batchId = crypto.randomUUID();
    const grown = await db.transaction((tx) =>
      growLotInTx(tx, { lotId: lot.D, add: 6, warehouseId: wh.cn, actorId: staffId, reason: 'sinov', batchId, side: 'load' }),
    );
    for (const box of grown.boxes) {
      await db.transaction((tx) => shrinkGrownInTx(tx, { lotId: lot.D, boxIds: [box.id], actorId: staffId, reason: 'sinov', batchId, side: 'load' }));
    }
    const [row] = await db.select().from(receiptLots).where(eq(receiptLots.id, lot.D));
    expect([row!.boxCount, row!.totalWeightKg, row!.totalVolumeM3]).toEqual([7, '40.714', '0.3140']);
  });

  it('grown in two presses and taken back one carton a press: every step measured from the same base, and the end is the start', async () => {
    const batchId = crypto.randomUUID();
    const first = await db.transaction((tx) =>
      growLotInTx(tx, { lotId: lot.L, add: 2, warehouseId: wh.cn, actorId: staffId, reason: 'sinov', batchId, side: 'load' }),
    );
    const second = await db.transaction((tx) =>
      growLotInTx(tx, { lotId: lot.L, add: 3, warehouseId: wh.cn, actorId: staffId, reason: 'sinov', batchId, side: 'load' }),
    );
    const [grown] = await db.select().from(receiptLots).where(eq(receiptLots.id, lot.L));
    // 7 cartons of a 2-carton 40.714 kg lot, from the base — not 4 cartons' rounding scaled again.
    expect([grown!.boxCount, grown!.totalWeightKg, grown!.totalVolumeM3]).toEqual([7, '142.499', '1.0990']);
    for (const box of [...second.boxes, ...first.boxes]) {
      await db.transaction((tx) => shrinkGrownInTx(tx, { lotId: lot.L, boxIds: [box.id], actorId: staffId, reason: 'sinov', batchId, side: 'load' }));
    }
    const [row] = await db.select().from(receiptLots).where(eq(receiptLots.id, lot.L));
    expect([row!.boxCount, row!.totalWeightKg, row!.totalVolumeM3]).toEqual([2, '40.714', '0.3140']);
  });

  it('a colleague’s tick on a mixed lot: grown — «o’zgardi» on the count and the weight; taken back carton by carton — ✅ again by itself (YUK-TEKSHIRUV §7 under his «2 b»)', async () => {
    await tick('L');
    expect((await stateOf('L')).state).toBe('checked');
    const batchId = crypto.randomUUID();
    const grown = await db.transaction((tx) =>
      growLotInTx(tx, { lotId: lot.L, add: 3, warehouseId: wh.cn, actorId: staffId, reason: 'sinov', batchId, side: 'load' }),
    );
    const stale = await stateOf('L');
    expect(stale.state).toBe('stale');
    expect(stale.person?.moved).toMatchObject({ count: true, measures: true });
    for (const box of grown.boxes) {
      await db.transaction((tx) => shrinkGrownInTx(tx, { lotId: lot.L, boxIds: [box.id], actorId: staffId, reason: 'sinov', batchId, side: 'load' }));
    }
    expect((await stateOf('L')).state).toBe('checked');
  });
});
