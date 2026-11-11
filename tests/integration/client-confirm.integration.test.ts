import 'dotenv/config';
import { randomUUID } from 'node:crypto';
import { and, eq, inArray, like, sql } from 'drizzle-orm';
import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest';

/**
 * The CLIENT's own ✅ / ❌ about their cargo (0144, docs/TARKIB-TAKLIFLAR.md
 * §4): what a question shows and its tag, what a press writes, what every
 * reader of «yuk ma'lumoti tekshirildi» then says — and the door, the
 * cooldown and the re-arm of «Mijozdan so'rash».
 *
 * Written straight to the tables: two warehouses (CN, UZ), two clients each
 * with its own Telegram chat, one confirmed prixod of client A at CN with
 * three lots — K (plain), T (a two-good tarkib that stands), S (ticked by a
 * colleague) — and one prixod whose cargo stands in Uzbekistan. Everything
 * carries the run's digits and is deleted at the end; the staff messages this
 * file queued go with it (they name the run's client code).
 *
 * The probe (`lotChecksReady`) is a switch, for the one test about a server
 * whose migration has not landed (#472).
 */

const ready = vi.hoisted(() => ({ on: true, client: true }));
vi.mock('@/modules/wms/receipts/lot-check-ready', () => ({
  lotChecksReady: async () => ready.on,
  // The probe's SECOND answer: is 0144's table there? (`ready.client = false` =
  // a deploy whose 0144 did not land while 0122/0123 are live.)
  lotClientConfirmsReady: () => ready.on && ready.client,
  clientConfirmsReady: async () => ready.on && ready.client,
}));
vi.mock('@/modules/platform/auth/session', async (original) => ({
  ...(await original<typeof import('@/modules/platform/auth/session')>()),
  requestMeta: async () => ({ ip: null, userAgent: 'client-confirm.integration' }),
}));

import { db, pgClient } from '@/modules/platform/db/client';
import {
  auditLog,
  boxes,
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
import { getSetting, setSetting } from '@/modules/platform/settings/service';
import { usersWithPermission } from '@/modules/platform/notifications/service';
import {
  ClientAskError,
  ClientDisputeError,
  NOTICE_LOT_ASK,
  answerClientAsk,
  askClientAboutReceipt,
  askTag,
  clientAskFacts,
  clientAskOffer,
  clientAskStatusFor,
  dismissClientDisputes,
  type ClientAskFacts,
} from '@/modules/wms/receipts/client-confirm';
import { checkLot, lotCheckViewsFor, type LotCheckActor } from '@/modules/wms/receipts/lot-check';
import { receivedFacts } from '@/modules/wms/notices/client-summary';
import { pushLotName } from '@/modules/wms/notices/client-text';
import { plannableStock } from '@/modules/wms/planning/stock';

const RUN = String(Date.now()).slice(-6);
const CODE_A = `CA${RUN}`;
const CODE_B = `CB${RUN}`;
const CHAT_A = BigInt(`81${RUN}1`);
const CHAT_A2 = BigInt(`81${RUN}2`);
const CHAT_B = BigInt(`81${RUN}3`);
const CHAT_NOBODY = BigInt(`81${RUN}9`);

let staffId = '';
let sellerId = '';
const wh = { cn: '', uz: '' };
const client = { A: '', B: '' };
const receipt = { main: '', uz: '', matrix: '' };
const lot = { K: '', T: '', S: '', U: '', M: '' };
const MATRIX_ZH = `母${RUN}`;
const MATRIX_RU = `Матрица ${RUN}`;
const madeBoxes: string[] = [];
let settingBefore: unknown;

const logist = (over: Partial<LotCheckActor> = {}): LotCheckActor => ({
  id: staffId,
  permissions: new Set(['plans.manage']),
  warehouseScoped: false,
  warehouseIds: [],
  ...over,
});
const ctx = () => ({ actorId: staffId, ip: null, userAgent: 'client-confirm.integration' });

async function mintLot(key: keyof typeof lot, receiptId: string, seq: number, letter: string, zh: string, ru: string | null, n: number, warehouseId: string) {
  const [row] = await db
    .insert(receiptLots)
    .values({ receiptId, seq, letter, productNameZh: zh, productNameRu: ru, boxCount: n, totalWeightKg: '100.000', totalVolumeM3: '1.0000' })
    .returning({ id: receiptLots.id });
  lot[key] = row!.id;
  for (let i = 1; i <= n; i += 1) {
    const [box] = await db
      .insert(boxes)
      .values({
        lotId: row!.id,
        seqInLot: i,
        shortCode: `CC${RUN}${key}${i}`,
        status: warehouseId === wh.uz ? 'ready_for_pickup' : 'in_stock',
        currentWarehouseId: warehouseId,
      })
      .returning({ id: boxes.id });
    madeBoxes.push(box!.id);
  }
}

const facts = async (): Promise<ClientAskFacts> => {
  const answer = await clientAskFacts(receipt.main);
  if ('skip' in answer) throw new Error(`facts skipped: ${answer.skip}`);
  return answer;
};
const stateOf = async (key: keyof typeof lot) => (await lotCheckViewsFor([lot[key]])).get(lot[key])!;
const press = async (verdict: 'yes' | 'no', chatId = CHAT_A, tag?: string) =>
  answerClientAsk({ chatId, receiptId: receipt.main, verdict, tag: tag ?? (await facts()).tag });
const rowsOfAnswers = async () =>
  (await db.select().from(lotClientConfirms).where(inArray(lotClientConfirms.lotId, [lot.K, lot.T, lot.S]))).sort((a, b) =>
    a.lotId < b.lotId ? -1 : 1,
  );
/** The staff messages this file's answers queued, newest first. */
const queued = async () =>
  db
    .select({ userId: notifications.userId, type: notifications.type, payload: notifications.payload, status: notifications.status })
    .from(notifications)
    .where(and(inArray(notifications.type, ['ClientLotDisputed', 'ClientLotConfirmed']), like(sql`${notifications.payload}::text`, `%${CODE_A}%`)));
const clearQueued = async () =>
  db
    .delete(notifications)
    .where(and(inArray(notifications.type, ['ClientLotDisputed', 'ClientLotConfirmed']), like(sql`${notifications.payload}::text`, `%${CODE_A}%`)));
const noticeRow = async () =>
  (
    (await db.execute(sql`
      SELECT status, attempts, asked_by::text AS asked_by, sent_at, send_after
        FROM client_notices WHERE kind = ${NOTICE_LOT_ASK} AND ref_id = ${receipt.main}::uuid AND client_id = ${client.A}::uuid
    `)) as unknown as { status: string; attempts: number; asked_by: string | null; sent_at: Date | null; send_after: Date }[]
  )[0];

beforeAll(async () => {
  settingBefore = await getSetting('client_confirm_on_receipt');
  await setSetting('client_confirm_on_receipt', true, null);
  const people = await db.select({ id: users.id }).from(users).where(eq(users.active, true)).limit(2);
  staffId = people[0]!.id;
  sellerId = people[1]?.id ?? people[0]!.id;
  for (const [key, country, type] of [
    ['cn', 'CN', 'origin'],
    ['uz', 'UZ', 'distribution'],
  ] as const) {
    const [row] = await db
      .insert(warehouses)
      .values({
        code: `C${key.toUpperCase()}${RUN}`,
        name: `Tasdiq ${key} ${RUN}`,
        country,
        type,
        timezone: 'Asia/Tashkent',
        batchPrefix: `C${key.toUpperCase()}${RUN}`,
      })
      .returning({ id: warehouses.id });
    wh[key] = row!.id;
  }
  for (const [key, code, chat] of [
    ['A', CODE_A, CHAT_A],
    ['B', CODE_B, CHAT_B],
  ] as const) {
    const [row] = await db
      .insert(clients)
      .values({ clientCode: code, name: `Tasdiq mijoz ${key} ${RUN}`, salesManagerId: key === 'A' ? sellerId : null })
      .returning({ id: clients.id });
    client[key] = row!.id;
    await db.insert(clientTelegramLinks).values({ clientId: row!.id, telegramChatId: chat, status: 'linked', linkedAt: new Date() });
  }
  // Client A reads the bot from a second chat too.
  await db.insert(clientTelegramLinks).values({ clientId: client.A, telegramChatId: CHAT_A2, status: 'linked', linkedAt: new Date() });
  for (const [key, warehouseId] of [
    ['main', wh.cn],
    ['uz', wh.uz],
    ['matrix', wh.cn],
  ] as const) {
    const [row] = await db
      .insert(receipts)
      .values({
        warehouseId,
        number: `CC-${RUN}-${key}`,
        clientId: client.A,
        status: 'confirmed',
        createdBy: staffId,
        confirmedAt: new Date(Date.now() - 3_600_000),
        confirmedBy: staffId,
      })
      .returning({ id: receipts.id });
    receipt[key] = row!.id;
  }
  await mintLot('K', receipt.main, 1, 'A', `键盘${RUN}`, `Клавиатура ${RUN}`, 3, wh.cn);
  await mintLot('T', receipt.main, 2, 'B', `杂货${RUN}`, `складское ${RUN}`, 2, wh.cn);
  await mintLot('S', receipt.main, 3, 'C', `鼠标${RUN}`, null, 2, wh.cn);
  await mintLot('U', receipt.uz, 1, 'A', `茶${RUN}`, `Чай ${RUN}`, 1, wh.uz);
  // M: the matrix's one lot, on a prixod of its own — every combination is arranged on it by hand.
  await mintLot('M', receipt.matrix, 1, 'A', MATRIX_ZH, MATRIX_RU, 2, wh.cn);
  // T: a tarkib of two goods that STANDS (two cartons, the lot's own totals).
  await db.insert(lotCompositions).values({ lotId: lot.T, seenBoxCount: 2, savedBy: staffId });
  await db.insert(lotCompositionLines).values([
    { lotId: lot.T, seq: 1, name: `Мышь ${RUN}`, pieces: 500, weightKg: '60.000', volumeM3: '0.6000' },
    { lotId: lot.T, seq: 2, name: `Коврик ${RUN}`, pieces: null, weightKg: '40.000', volumeM3: '0.4000' },
  ]);
  // S: a colleague's tick that holds.
  await db
    .insert(lotChecks)
    .values({ lotId: lot.S, seenNameZh: `鼠标${RUN}`, seenNameRu: null, seenBoxCount: 2, seenClientId: client.A, checkedBy: staffId });
});

afterAll(async () => {
  await clearQueued();
  // Guarded id by id: when `beforeAll` failed half-way, an empty id bound into
  // a uuid comparison would hide the real error behind «invalid input syntax».
  for (const id of Object.values(receipt).filter(Boolean)) {
    await db.execute(sql`DELETE FROM client_notices WHERE ref_id = ${id}::uuid`);
  }
  const lotIds = Object.values(lot).filter(Boolean);
  if (lotIds.length > 0) {
    await db.delete(lotClientConfirms).where(inArray(lotClientConfirms.lotId, lotIds));
    await db.delete(lotChecks).where(inArray(lotChecks.lotId, lotIds));
    await db.delete(lotCompositions).where(inArray(lotCompositions.lotId, lotIds));
    if (madeBoxes.length > 0) await db.delete(boxes).where(inArray(boxes.id, madeBoxes));
    await db.delete(receiptLots).where(inArray(receiptLots.id, lotIds));
  }
  const receiptIds = Object.values(receipt).filter(Boolean);
  if (receiptIds.length > 0) await db.delete(receipts).where(inArray(receipts.id, receiptIds));
  for (const id of Object.values(client).filter(Boolean)) {
    await db.delete(clientTelegramLinks).where(eq(clientTelegramLinks.clientId, id));
    await db.delete(clients).where(eq(clients.id, id));
  }
  // Deactivated, never deleted: the tick and the dismissal audit under their
  // warehouse, and `audit_log` keeps its rows (and its FK) for ever.
  const whIds = Object.values(wh).filter(Boolean);
  if (whIds.length > 0) await db.update(warehouses).set({ active: false }).where(inArray(warehouses.id, whIds));
  await setSetting('client_confirm_on_receipt', settingBefore as boolean, null);
  await pgClient.end();
});

describe('what a question shows, and its tag', () => {
  it('every lot by letter — both names, the count, a tarkib’s goods with their pieces', async () => {
    const f = await facts();
    expect([f.clientCode, f.receiptNumber, f.clientId]).toEqual([CODE_A, `CC-${RUN}-main`, client.A]);
    expect(f.lots.map((l) => [l.letter, l.zh, l.ru, l.count, l.goods])).toEqual([
      ['A', `键盘${RUN}`, `Клавиатура ${RUN}`, 3, []],
      // The Russian name is the one the lists SHOW: the tarkib's «first +1».
      ['B', `杂货${RUN}`, `Мышь ${RUN} +1`, 2, [{ name: `Мышь ${RUN}`, pieces: 500 }, { name: `Коврик ${RUN}`, pieces: null }]],
      ['C', `鼠标${RUN}`, null, 2, []],
    ]);
    expect(f.lots.map((l) => l.goodsKey === null)).toEqual([true, false, true]);
    expect(f.tag).toMatch(/^[0-9a-f]{8}$/);
    expect(f.tag).toBe(askTag(f.clientId, f.lots));
    expect((await facts()).tag).toBe(f.tag);
  });

  it('the tag moves with what the client is SHOWN — a name, a count, the goods, their pieces, the owner', async () => {
    const base = (await facts()).tag;
    const moved = async (change: () => Promise<unknown>, undo: () => Promise<unknown>): Promise<boolean> => {
      await change();
      const tag = (await facts()).tag;
      await undo();
      expect((await facts()).tag, 'the undo restores the tag').toBe(base);
      return tag !== base;
    };
    const setLot = (key: keyof typeof lot, set: Partial<typeof receiptLots.$inferInsert>) => db.update(receiptLots).set(set).where(eq(receiptLots.id, lot[key]));
    expect(await moved(() => setLot('K', { productNameZh: `键盘改${RUN}` }), () => setLot('K', { productNameZh: `键盘${RUN}` }))).toBe(true);
    expect(await moved(() => setLot('K', { productNameRu: `Клава ${RUN}` }), () => setLot('K', { productNameRu: `Клавиатура ${RUN}` }))).toBe(true);
    expect(await moved(() => setLot('S', { boxCount: 5 }), () => setLot('S', { boxCount: 2 }))).toBe(true);
    const setLine = (seq: number, set: Partial<typeof lotCompositionLines.$inferInsert>) =>
      db.update(lotCompositionLines).set(set).where(and(eq(lotCompositionLines.lotId, lot.T), eq(lotCompositionLines.seq, seq)));
    expect(await moved(() => setLine(2, { name: `Коврик большой ${RUN}` }), () => setLine(2, { name: `Коврик ${RUN}` }))).toBe(true);
    expect(await moved(() => setLine(1, { pieces: 600 }), () => setLine(1, { pieces: 500 }))).toBe(true);
    const setOwner = (id: string) => db.update(receipts).set({ clientId: id }).where(eq(receipts.id, receipt.main));
    expect(await moved(() => setOwner(client.B), () => setOwner(client.A))).toBe(true);
  });

  it('…and NOT with what they are not shown: a TNVED code typed on a line (the tarkib’s rev moves), its kilos, its cartons', async () => {
    const base = (await facts()).tag;
    // The Bojxona tab's line code: `setLineCodes` writes the code and draws a new rev.
    await db.update(lotCompositionLines).set({ tnvedCode: '8471606000', weightKg: '61.000', cartons: 1 }).where(and(eq(lotCompositionLines.lotId, lot.T), eq(lotCompositionLines.seq, 1)));
    await db.execute(sql`UPDATE lot_compositions SET rev = nextval('lot_composition_rev_seq') WHERE lot_id = ${lot.T}::uuid`);
    expect((await facts()).tag).toBe(base);
    await db.update(lotCompositionLines).set({ tnvedCode: null, weightKg: '60.000', cartons: null }).where(and(eq(lotCompositionLines.lotId, lot.T), eq(lotCompositionLines.seq, 1)));
  });

  it('a prixod that is gone, voided, unconfirmed or ownerless asks nothing', async () => {
    // Each skip says WHOSE the prixod is, when it is anybody's: a press must know the owner before it
    // says «this is out of date» to a chat (L2-6).
    expect(await clientAskFacts(randomUUID())).toEqual({ skip: 'receipt_gone', clientId: null });
    expect(await clientAskFacts('not-an-id')).toEqual({ skip: 'receipt_gone', clientId: null });
    const set = (v: Partial<typeof receipts.$inferInsert>) => db.update(receipts).set(v).where(eq(receipts.id, receipt.main));
    await set({ status: 'draft' });
    expect(await clientAskFacts(receipt.main)).toEqual({ skip: 'not_confirmed', clientId: client.A });
    await set({ status: 'voided' });
    expect(await clientAskFacts(receipt.main)).toEqual({ skip: 'voided', clientId: client.A });
    await set({ status: 'confirmed', clientId: null });
    expect(await clientAskFacts(receipt.main)).toEqual({ skip: 'no_client', clientId: null });
    await set({ clientId: client.A });
  });
});

describe('the ✅ / ❌ row under «yukingiz qabul qilindi» — offered only where it means something', () => {
  /** As the sweep asks it: with the very lines the push is about to print. */
  const offerFor = async (receiptId: string, clientId: string) => {
    const got = await receivedFacts(clientId, receiptId);
    if ('skip' in got) return null;
    const printed = got.summary.lines.map((line) => ({ lotId: line.lotId, name: line.name, boxCount: line.boxCount }));
    return clientAskOffer(receiptId, clientId, printed, pushLotName);
  };
  const offer = () => offerFor(receipt.main, client.A);
  /** The tarkib off, for the offers that are about a plain prixod. */
  const withoutTarkib = async <T>(run: () => Promise<T>): Promise<T> => {
    const [header] = await db.select().from(lotCompositions).where(eq(lotCompositions.lotId, lot.T));
    const lines = await db.select().from(lotCompositionLines).where(eq(lotCompositionLines.lotId, lot.T));
    await db.delete(lotCompositions).where(eq(lotCompositions.lotId, lot.T));
    try {
      return await run();
    } finally {
      await db.insert(lotCompositions).values(header!);
      await db.insert(lotCompositionLines).values(lines);
    }
  };

  it('a prixod with a tarkib written is NOT asked by the push — it prints «Мышь +1» and cannot list the goods', async () => {
    expect(await offer()).toBeNull();
  });

  it('cargo in China that nobody has confirmed: offered, with the tag of the facts', async () => {
    await withoutTarkib(async () => {
      const answer = await offer();
      expect(answer).toEqual({ receiptId: receipt.main, tag: (await facts()).tag });
    });
  });

  it('not for another client, not with the switch off, not on a server whose migration has not landed', async () => {
    await withoutTarkib(async () => {
      const lines = (await facts()).lots.map((l) => ({ lotId: l.lotId, name: pushLotName(l.ru, l.zh), boxCount: l.count }));
      expect(await clientAskOffer(receipt.main, client.B, lines, pushLotName)).toBeNull();
      await setSetting('client_confirm_on_receipt', false, null);
      expect(await offer()).toBeNull();
      await setSetting('client_confirm_on_receipt', true, null);
      // 0144 not landed (0122/0123 live): no button is drawn that nothing could answer.
      ready.client = false;
      expect(await offer()).toBeNull();
      ready.client = true;
      expect(await offer()).not.toBeNull();
    });
  });

  it('only for the lines the push PRINTS: a name or a count that moved between the text and the tag costs the buttons', async () => {
    await withoutTarkib(async () => {
      const f = await facts();
      const lines = f.lots.map((l) => ({ lotId: l.lotId, name: pushLotName(l.ru, l.zh), boxCount: l.count }));
      expect(await clientAskOffer(receipt.main, client.A, lines, pushLotName)).toEqual({ receiptId: receipt.main, tag: f.tag });
      // The text was rendered a moment before a rename / a recount / a lot added.
      expect(await clientAskOffer(receipt.main, client.A, lines.map((l, i) => (i === 0 ? { ...l, name: `${l.name} (eski)` } : l)), pushLotName)).toBeNull();
      expect(await clientAskOffer(receipt.main, client.A, lines.map((l, i) => (i === 1 ? { ...l, boxCount: l.boxCount + 1 } : l)), pushLotName)).toBeNull();
      expect(await clientAskOffer(receipt.main, client.A, lines.slice(1), pushLotName)).toBeNull();
      expect(await clientAskOffer(receipt.main, client.A, [], pushLotName)).toBeNull();
    });
  });

  it('not when every lot is ✅ already, and never for cargo that stands in Uzbekistan (his 4a)', async () => {
    await withoutTarkib(async () => {
      // K and T get a colleague's tick; S has one.
      for (const key of ['K', 'T'] as const) {
        const [row] = await db.select().from(receiptLots).where(eq(receiptLots.id, lot[key]));
        await db.insert(lotChecks).values({ lotId: lot[key], seenNameZh: row!.productNameZh, seenNameRu: row!.productNameRu, seenBoxCount: row!.boxCount, seenClientId: client.A, checkedBy: staffId });
      }
      expect(await offer()).toBeNull();
      await db.delete(lotChecks).where(inArray(lotChecks.lotId, [lot.K, lot.T]));
      expect(await offer()).not.toBeNull();
    });
    expect(await offerFor(receipt.uz, client.A)).toBeNull();
  });

  it('not when the push cannot print every lot (more than twelve)', async () => {
    await withoutTarkib(async () => {
      const extra: string[] = [];
      for (let i = 0; i < 10; i += 1) {
        const [row] = await db
          .insert(receiptLots)
          .values({ receiptId: receipt.main, seq: 10 + i, letter: `X${i}`, productNameZh: `额外${i}${RUN}`, boxCount: 1, totalWeightKg: '1.000', totalVolumeM3: '0.0100' })
          .returning({ id: receiptLots.id });
        extra.push(row!.id);
      }
      expect((await facts()).lots).toHaveLength(13);
      expect(await offer()).toBeNull();
      await db.delete(receiptLots).where(inArray(receiptLots.id, extra));
      expect(await offer()).not.toBeNull();
    });
  });
});

describe('a press', () => {
  it('✅: every lot of the message gets the client’s row — what they were shown, who pressed — and reads «checked»', async () => {
    expect((await stateOf('K')).state).toBe('none');
    const answer = await press('yes');
    expect(answer.outcome).toBe('recorded');
    const rows = await rowsOfAnswers();
    expect(rows).toHaveLength(3);
    expect(rows.every((row) => row.verdict === 'yes' && row.chatId === CHAT_A && row.shownClientId === client.A && row.askedBy === null)).toBe(true);
    const byLot = new Map(rows.map((row) => [row.lotId, row]));
    expect([byLot.get(lot.K)!.shownZh, byLot.get(lot.K)!.shownRu, byLot.get(lot.K)!.shownCount, byLot.get(lot.K)!.shownGoodsKey]).toEqual([
      `键盘${RUN}`,
      `Клавиатура ${RUN}`,
      3,
      null,
    ]);
    expect(byLot.get(lot.T)!.shownRu).toBe(`Мышь ${RUN} +1`);
    expect(byLot.get(lot.T)!.shownGoodsKey).toMatch(/^[0-9a-f]{32}$/);
    // The plain lot nobody had ticked is ✅ now — by the client's own word.
    const k = await stateOf('K');
    expect(k.state).toBe('checked');
    expect(k.person).toBeNull();
    expect(k.client).toMatchObject({ verdict: 'yes', holds: true, askedBy: null });
    // …and the lists agree with the card: the plan editor's shelf row.
    const shelf = await plannableStock(wh.cn);
    expect(shelf.lots.find((l) => l.lotId === lot.K)?.check).toBe('checked');
    // The push's own ✅ tells nobody: the ❓ list shrinking is the news.
    expect(await queued()).toEqual([]);
    // One History row on the prixod, by nobody of ours, a key per lot.
    const [audit] = await db
      .select({ actorId: auditLog.actorId, after: auditLog.after })
      .from(auditLog)
      .where(and(eq(auditLog.entityType, 'receipt'), eq(auditLog.entityId, receipt.main)))
      .orderBy(sql`${auditLog.id} DESC`)
      .limit(1);
    expect(audit!.actorId).toBeNull();
    expect(Object.keys(audit!.after as object).sort()).toEqual(['clientConfirm:A', 'clientConfirm:B', 'clientConfirm:C']);
    expect((audit!.after as Record<string, string>)['clientConfirm:A']).toBe(`✅ Telegram · 键盘${RUN} (Клавиатура ${RUN}) × 3`);
  });

  it('the same press again — a second tap, a redelivery, the other chat — is «already», and writes nothing', async () => {
    const before = await rowsOfAnswers();
    expect(await press('yes')).toEqual({ outcome: 'already', verdict: 'yes' });
    expect(await press('yes', CHAT_A2)).toEqual({ outcome: 'already', verdict: 'yes' });
    expect(await rowsOfAnswers()).toEqual(before);
  });

  it('a tag from before the data moved is «stale»; so is a voided prixod; nothing is written', async () => {
    const before = await rowsOfAnswers();
    const tag = (await facts()).tag;
    expect(await press('no', CHAT_A, 'deadbeef')).toEqual({ outcome: 'stale', clientId: client.A });
    await db.update(receipts).set({ status: 'voided' }).where(eq(receipts.id, receipt.main));
    try {
      // The very tag the message carried: the prixod is void, so there is nothing left to answer about.
      expect(await press('no', CHAT_A, tag)).toEqual({ outcome: 'stale', clientId: client.A });
    } finally {
      await db.update(receipts).set({ status: 'confirmed' }).where(eq(receipts.id, receipt.main));
    }
    expect(await rowsOfAnswers()).toEqual(before);
  });

  it('somebody else’s chat, an unlinked chat, a prixod that is not there: ONE neutral answer — and nothing learned (#273)', async () => {
    const tag = (await facts()).tag;
    expect(await answerClientAsk({ chatId: CHAT_B, receiptId: receipt.main, verdict: 'no', tag })).toEqual({ outcome: 'unknown' });
    expect(await answerClientAsk({ chatId: CHAT_NOBODY, receiptId: receipt.main, verdict: 'no', tag })).toEqual({ outcome: 'unknown' });
    expect(await answerClientAsk({ chatId: CHAT_A, receiptId: randomUUID(), verdict: 'no', tag })).toEqual({ outcome: 'unknown' });
    // The prixod corrected to another client: the OLD owner's buttons answer like a stranger's.
    await db.update(receipts).set({ clientId: client.B }).where(eq(receipts.id, receipt.main));
    expect(await answerClientAsk({ chatId: CHAT_A, receiptId: receipt.main, verdict: 'no', tag })).toEqual({ outcome: 'unknown' });
    await db.update(receipts).set({ clientId: client.A }).where(eq(receipts.id, receipt.main));
    // …and WHATEVER became of that prixod: voided, back to a draft or left with no owner, a stranger's
    // chat hears the same word as for one that is not there. «Stale» is said to the OWNER alone — it
    // told any linked chat which uuids are voided or unclaimed prixods, and a stale ❌ is invited to
    // write to a manager about cargo that is not theirs (the as-built review, L2-6).
    for (const patch of [{ status: 'voided' }, { status: 'draft' }, { clientId: null }] as const) {
      await db.update(receipts).set(patch).where(eq(receipts.id, receipt.main));
      try {
        expect(await answerClientAsk({ chatId: CHAT_B, receiptId: receipt.main, verdict: 'no', tag }), JSON.stringify(patch)).toEqual({
          outcome: 'unknown',
        });
      } finally {
        await db.update(receipts).set({ status: 'confirmed', clientId: client.A }).where(eq(receipts.id, receipt.main));
      }
    }
    expect((await rowsOfAnswers()).every((row) => row.verdict === 'yes')).toBe(true);
  });

  it('❌ is a VETO: it takes the ✅ off a lot a colleague ticked AND off a lot whose tarkib stands — and the people who can fix it are told, in the same transaction', async () => {
    expect((await stateOf('S')).state).toBe('checked');
    expect((await stateOf('T')).state).toBe('checked');
    const answer = await press('no');
    expect(answer.outcome).toBe('recorded');
    for (const key of ['K', 'T', 'S'] as const) {
      const view = await stateOf(key);
      expect(view.state, key).toBe('none');
      expect(view.client, key).toMatchObject({ verdict: 'no', holds: true, vetoes: true, ofOwner: true });
    }
    // The colleague's tick is untouched — pressed BEFORE the ❌, it does not outrank the owner of the cargo.
    expect((await stateOf('S')).person).toMatchObject({ holds: true });
    // …and the tarkib still «stands» as a fact about the lot: the card draws it as history (`vetoes`).
    expect((await stateOf('T')).byDocument).toBe(true);
    // Told: the client's seller and everyone who plans — one message each.
    const told = await queued();
    const expected = [...new Set([sellerId, ...(await usersWithPermission('plans.manage'))])];
    expect(told.map((row) => row.userId).sort()).toEqual([...expected].sort());
    expect(told.every((row) => row.type === 'ClientLotDisputed')).toBe(true);
    const text = String((told[0]!.payload as { text: string }).text);
    expect(text).toContain(`${CODE_A} · prixod CC-${RUN}-main`);
    expect(text).toContain(`A · Клавиатура ${RUN} — 3 quti`);
    expect(text).toContain(`B · Мышь ${RUN} +1 — 2 quti`);
    // One button answered three lots — the sentence says so, so nobody reads it as «all three are wrong».
    expect(text).toContain('3 ta lotning hammasiga');
    expect(text.split('\n').at(-1)).toContain(`/receipts/${receipt.main}`);
    await clearQueued();
  });

  it('a ❌ stands against what it REJECTED: an edit of something else lifts nothing — not on a plain lot, not under a standing tarkib', async () => {
    // K (no tarkib, no tick): its Russian name is corrected. The ❌ no longer «matches», and it still stands.
    await db.update(receiptLots).set({ productNameRu: `Клавиатура проводная ${RUN}` }).where(eq(receiptLots.id, lot.K));
    const k = await stateOf('K');
    expect(k.client).toMatchObject({ verdict: 'no', holds: false, vetoes: true });
    expect(k.state).toBe('none');
    await db.update(receiptLots).set({ productNameRu: `Клавиатура ${RUN}` }).where(eq(receiptLots.id, lot.K));
    // T (a tarkib stands): a typo fixed in the CHINESE name. The goods the client rejected are untouched,
    // so the tarkib does not vouch for them again — the design judge's case: a veto tied to the whole
    // snapshot read ✅ here with nobody re-asked.
    await db.update(receiptLots).set({ productNameZh: `杂货改${RUN}` }).where(eq(receiptLots.id, lot.T));
    const t = await stateOf('T');
    expect(t.byDocument).toBe(true);
    expect(t.client).toMatchObject({ verdict: 'no', holds: false, vetoes: true });
    expect(t.state).toBe('none');
    await db.update(receiptLots).set({ productNameZh: `杂货${RUN}` }).where(eq(receiptLots.id, lot.T));
    // S (a colleague's older tick): the lot is re-counted. The tick is stale, the ❌ still stands — ❓, never «o'zgardi».
    await db.update(receiptLots).set({ boxCount: 5 }).where(eq(receiptLots.id, lot.S));
    expect((await stateOf('S')).state).toBe('none');
    await db.update(receiptLots).set({ boxCount: 2 }).where(eq(receiptLots.id, lot.S));
  });

  it('way out 1 — the rejected GOODS are changed: the dispute about the old list is over, the tarkib vouches again', async () => {
    await db.update(lotCompositionLines).set({ pieces: 480 }).where(and(eq(lotCompositionLines.lotId, lot.T), eq(lotCompositionLines.seq, 1)));
    const t = await stateOf('T');
    expect(t.client).toMatchObject({ verdict: 'no', holds: false, vetoes: false });
    expect(t.state).toBe('checked');
    await db.update(lotCompositionLines).set({ pieces: 500 }).where(and(eq(lotCompositionLines.lotId, lot.T), eq(lotCompositionLines.seq, 1)));
    expect((await stateOf('T')).state).toBe('none');
  });

  it('way out 2 — a colleague ticks AFTER the ❌ (and must have seen it): the tick outranks it', async () => {
    const seenOf = async (key: keyof typeof lot) => {
      const [row] = await db.select().from(receiptLots).where(eq(receiptLots.id, lot[key]));
      return { nameZh: row!.productNameZh, nameRu: row!.productNameRu ?? '', boxCount: row!.boxCount, clientId: client.A };
    };
    const k = await stateOf('K');
    // A page drawn before the client pressed (it shows no answer): refused — a ❌ is not lifted by somebody who never saw it.
    await expect(
      checkLot({ lotId: lot.K, seen: await seenOf('K'), seenCheckedAt: null, seenClientAt: null }, logist(), ctx()),
    ).rejects.toMatchObject({ code: 'check_changed' });
    expect((await stateOf('K')).person).toBeNull();
    // The page that drew the ❌: the tick is written, newer than the ❌, and the lot is ✅ by the colleague's word.
    expect(await checkLot({ lotId: lot.K, seen: await seenOf('K'), seenCheckedAt: null, seenClientAt: k.client!.token }, logist(), ctx())).toEqual({
      changed: true,
    });
    const after = await stateOf('K');
    expect(after.state).toBe('checked');
    expect(after.person).toMatchObject({ holds: true });
    // The ❌ is still on record — as history, no longer the reason for anything.
    expect(after.client).toMatchObject({ verdict: 'no', vetoes: false });

    // S: the SAME colleague's tick already holds — but it is older than the ❌. The same press again is not
    // «already confirmed» (the double tap's no-op): it writes, and the new tick is what lifts the ❌.
    const s = await stateOf('S');
    expect([s.state, s.person!.holds]).toEqual(['none', true]);
    expect(
      await checkLot({ lotId: lot.S, seen: await seenOf('S'), seenCheckedAt: s.person!.token, seenClientAt: s.client!.token }, logist(), ctx()),
    ).toEqual({ changed: true });
    expect((await stateOf('S')).state).toBe('checked');
    const [audit] = await db
      .select({ after: auditLog.after })
      .from(auditLog)
      .where(and(eq(auditLog.entityType, 'receipt'), eq(auditLog.entityId, receipt.main)))
      .orderBy(sql`${auditLog.id} DESC`)
      .limit(1);
    expect(String((audit!.after as Record<string, unknown>)['lotCheck:C'])).toContain('mijozning ❌ idan keyin qayta tasdiqlandi');
    // …and now that the tick outranks it, the very same press IS the double tap.
    const again = await stateOf('S');
    expect(
      await checkLot({ lotId: lot.S, seen: await seenOf('S'), seenCheckedAt: again.person!.token, seenClientAt: again.client!.token }, logist(), ctx()),
    ).toEqual({ changed: false });
    // Back to the fixture: K without a tick; S's tick as it was (older than the ❌).
    await db.delete(lotChecks).where(eq(lotChecks.lotId, lot.K));
    await db.execute(sql`UPDATE lot_checks SET checked_at = now() - interval '3 hours' WHERE lot_id = ${lot.S}::uuid`);
    expect((await stateOf('S')).state).toBe('none');
  });

  it('…and a ❌ pressed AGAIN after that tick is a NEW answer, never «already»: it vetoes again, the people are told, the History says so', async () => {
    // The as-built review (L1-2). The push goes to every linked chat with its own buttons: chat 1 says ❌,
    // the logist phones and ticks, chat 2 presses ❌ on ITS copy — the same tag, the same facts, the same
    // verdict as the row that stands. «Already» swallowed it: the lot stayed ✅ by the tick, nobody was
    // told, and the customer's toast said it was recorded.
    const [row] = await db.select().from(receiptLots).where(eq(receiptLots.id, lot.K));
    const seen = { nameZh: row!.productNameZh, nameRu: row!.productNameRu ?? '', boxCount: row!.boxCount, clientId: client.A };
    const k = await stateOf('K');
    expect(k.client).toMatchObject({ verdict: 'no', vetoes: true });
    expect(await checkLot({ lotId: lot.K, seen, seenCheckedAt: null, seenClientAt: k.client!.token }, logist(), ctx())).toEqual({ changed: true });
    try {
    expect((await stateOf('K')).state).toBe('checked');
    await clearQueued();

    const again = await press('no', CHAT_A2);
    expect(again.outcome).toBe('recorded');
    const after = await stateOf('K');
    expect(after.state).toBe('none');
    expect(after.client).toMatchObject({ verdict: 'no', vetoes: true });
    // The tick is still there — and is once more the OLDER of the two.
    expect(after.person).toMatchObject({ holds: true });
    const told = await queued();
    expect(told.length).toBeGreaterThan(0);
    expect(told.every((t) => t.type === 'ClientLotDisputed')).toBe(true);
    const [audit] = await db
      .select({ actorId: auditLog.actorId, before: auditLog.before, after: auditLog.after })
      .from(auditLog)
      .where(and(eq(auditLog.entityType, 'receipt'), eq(auditLog.entityId, receipt.main)))
      .orderBy(sql`${auditLog.id} DESC`)
      .limit(1);
    expect(audit!.actorId).toBeNull();
    // No word of the answer changed — the row still says that it was given again.
    expect(String((audit!.after as Record<string, unknown>)['clientConfirm:A'])).toMatch(/^❌ Telegram · .* · qayta$/);
    // NOW the ❌ is in force again, so the very same press is the double tap.
    expect(await press('no', CHAT_A2)).toEqual({ outcome: 'already', verdict: 'no' });
    expect(await queued()).toHaveLength(told.length);
    } finally {
      // Back to the fixture, whatever happened above: K without a tick.
      await db.delete(lotChecks).where(eq(lotChecks.lotId, lot.K));
      await clearQueued();
    }
  });

  it('way out 3 — a person closes the dispute, and only the one the card DREW: the History says who and why', async () => {
    const tokenOf = async (key: keyof typeof lot) => (await stateOf(key)).client!.token;
    const close = (seen: { lotId: string; token: string }[], actor = logist(), note?: string, receiptId = receipt.main) =>
      dismissClientDisputes({ receiptId, seen, note }, actor, ctx());
    const s = await tokenOf('S');
    await expect(close([{ lotId: lot.S, token: s }], logist({ permissions: new Set(['receipts.edit']) }))).rejects.toMatchObject({ code: 'forbidden' });
    await expect(close([{ lotId: 'x', token: s }])).rejects.toBeInstanceOf(ClientDisputeError);
    await expect(close([])).rejects.toMatchObject({ code: 'forbidden' });
    // The lot is another prixod's: nothing matches, nothing is closed.
    await expect(close([{ lotId: lot.S, token: s }], logist(), undefined, receipt.uz)).rejects.toMatchObject({ code: 'check_changed' });
    // A token from before the client pressed again: the answer on the screen is not the answer in the table.
    await expect(close([{ lotId: lot.S, token: '2001-01-01 00:00:00+00' }])).rejects.toMatchObject({ code: 'check_changed' });
    // Every posted lot or none: one stale token among two keeps both.
    await expect(
      close([
        { lotId: lot.S, token: s },
        { lotId: lot.K, token: 'stale' },
      ]),
    ).rejects.toMatchObject({ code: 'check_changed' });
    expect((await rowsOfAnswers()).filter((row) => row.verdict === 'no')).toHaveLength(3);

    expect(await close([{ lotId: lot.S, token: s }], logist(), 'mijoz adashib bosgan')).toEqual({ lots: 1 });
    const view = await stateOf('S');
    expect(view.client).toBeNull();
    // The lot reads as before the ❌: the colleague's tick vouches.
    expect(view.state).toBe('checked');
    const [audit] = await db
      .select({ actorId: auditLog.actorId, before: auditLog.before, after: auditLog.after })
      .from(auditLog)
      .where(and(eq(auditLog.entityType, 'receipt'), eq(auditLog.entityId, receipt.main)))
      .orderBy(sql`${auditLog.id} DESC`)
      .limit(1);
    expect(audit!.actorId).toBe(staffId);
    expect(audit!.before).toEqual({ 'clientConfirm:C': `❌ 鼠标${RUN} × 2` });
    expect(audit!.after).toEqual({ 'clientConfirm:C': 'e’tiroz yopildi: mijoz adashib bosgan' });
    // A second press has nothing left to close.
    await expect(close([{ lotId: lot.S, token: s }])).rejects.toMatchObject({ code: 'check_changed' });

    // A ❌ of a PREVIOUS owner (the prixod was corrected to this client since): the card never draws it
    // and the sentence treats it as nobody's — so no post may close it either. Were the prixod corrected
    // BACK, that client's still-valid ❌ would be gone, closed by somebody who was never shown it (L1-5).
    const foreign = (await db.execute(sql`
      INSERT INTO lot_client_confirms (lot_id, verdict, shown_zh, shown_ru, shown_count, shown_client_id, shown_goods_key, chat_id)
      VALUES (${lot.M}::uuid, 'no', ${MATRIX_ZH}, ${MATRIX_RU}, 2, ${client.B}::uuid, NULL, ${CHAT_B})
      ON CONFLICT (lot_id) DO UPDATE SET verdict = 'no', shown_client_id = EXCLUDED.shown_client_id, answered_at = now()
      RETURNING answered_at::text AS token
    `)) as unknown as { token: string }[];
    try {
      await expect(close([{ lotId: lot.M, token: foreign[0]!.token }], logist(), undefined, receipt.matrix)).rejects.toMatchObject({
        code: 'check_changed',
      });
      const kept = await db.select().from(lotClientConfirms).where(eq(lotClientConfirms.lotId, lot.M));
      expect(kept).toHaveLength(1);
    } finally {
      await db.delete(lotClientConfirms).where(eq(lotClientConfirms.lotId, lot.M));
    }

    // The prixod's other disputed lots in ONE press, one History row.
    expect(await close([{ lotId: lot.K, token: await tokenOf('K') }, { lotId: lot.T, token: await tokenOf('T') }])).toEqual({ lots: 2 });
    const [both] = await db
      .select({ before: auditLog.before, after: auditLog.after })
      .from(auditLog)
      .where(and(eq(auditLog.entityType, 'receipt'), eq(auditLog.entityId, receipt.main)))
      .orderBy(sql`${auditLog.id} DESC`)
      .limit(1);
    expect(Object.keys(both!.after as object).sort()).toEqual(['clientConfirm:A', 'clientConfirm:B']);
    expect(await rowsOfAnswers()).toEqual([]);
    expect([(await stateOf('K')).state, (await stateOf('T')).state]).toEqual(['none', 'checked']);
  });

  it('way out 4 — the client answers again: the newest answer is the one that stands; a ✅ is never closed by a person', async () => {
    expect((await press('no')).outcome).toBe('recorded');
    await clearQueued();
    expect((await stateOf('T')).state).toBe('none');
    const answer = await press('yes', CHAT_A2);
    expect(answer.outcome).toBe('recorded');
    for (const key of ['K', 'T', 'S'] as const) expect((await stateOf(key)).state, key).toBe('checked');
    const rows = await rowsOfAnswers();
    expect(rows.every((row) => row.verdict === 'yes' && row.chatId === CHAT_A2)).toBe(true);
    const k = await stateOf('K');
    await expect(dismissClientDisputes({ receiptId: receipt.main, seen: [{ lotId: lot.K, token: k.client!.token }] }, logist(), ctx())).rejects.toMatchObject({
      code: 'check_changed',
    });
    expect((await rowsOfAnswers()).every((row) => row.verdict === 'yes')).toBe(true);
    expect(await queued()).toEqual([]);
  });

  it('a ✅ that no longer matches is «was confirmed, then changed» — ⚠, on the worklist', async () => {
    await db.update(receiptLots).set({ boxCount: 4 }).where(eq(receiptLots.id, lot.K));
    const k = await stateOf('K');
    expect(k.client).toMatchObject({ verdict: 'yes', holds: false });
    expect(k.state).toBe('stale');
    await db.update(receiptLots).set({ boxCount: 3 }).where(eq(receiptLots.id, lot.K));
    expect((await stateOf('K')).state).toBe('checked');
  });

  it('an answer is taken only while the cargo is still worth asking about (his 4a): a press about cargo standing in Uzbekistan writes nothing', async () => {
    const f = await clientAskFacts(receipt.uz);
    if ('skip' in f) throw new Error(f.skip);
    for (const verdict of ['yes', 'no'] as const) {
      expect(await answerClientAsk({ chatId: CHAT_A, receiptId: receipt.uz, verdict, tag: f.tag })).toEqual({ outcome: 'stale', clientId: client.A });
    }
    expect(await db.select().from(lotClientConfirms).where(eq(lotClientConfirms.lotId, lot.U))).toEqual([]);
    expect(await queued()).toEqual([]);
  });

  it('«busy»: a press that would have to wait for a colleague’s tick on the lot is answered within three seconds, and writes nothing', async () => {
    const before = await rowsOfAnswers();
    // A colleague's tick in flight holds the lot's answer lock (`lockLotAnswersTx`) — held here on a second connection.
    const holder = await pgClient.reserve();
    try {
      await holder`BEGIN`;
      await holder`SELECT pg_advisory_xact_lock(hashtextextended(${`lot-answer:${lot.K}`}, 0))`;
      const started = Date.now();
      expect(await press('no')).toEqual({ outcome: 'busy' });
      expect(Date.now() - started).toBeGreaterThanOrEqual(2500);
      expect(Date.now() - started).toBeLessThan(8000);
    } finally {
      await holder`ROLLBACK`;
      holder.release();
    }
    expect(await rowsOfAnswers()).toEqual(before);
    expect(await queued()).toEqual([]);
  }, 20_000);

  it.each([
    ['a FIRST answer (the row is inserted)', true],
    ['a re-answer (the row is updated)', false],
  ])('a ❌ that had to wait for a tick in flight is NEWER than that tick — %s: the colleague could not have seen it, so it vetoes', async (_what, fresh) => {
    // K: nobody has ticked. Either the client has not answered at all (the ❌ will INSERT its row), or their ✅ stands (it will UPDATE it).
    if (fresh) await db.delete(lotClientConfirms).where(inArray(lotClientConfirms.lotId, [lot.K, lot.T, lot.S]));
    expect((await stateOf('K')).state).toBe(fresh ? 'none' : 'checked');
    // A colleague's tick is in flight — it holds the lot's answer lock.
    const holder = await pgClient.reserve();
    let pressed: ReturnType<typeof press> | null = null;
    try {
      await holder`BEGIN`;
      await holder`SELECT pg_advisory_xact_lock(hashtextextended(${`lot-answer:${lot.K}`}, 0))`;
      // The client presses ❌ now: its transaction BEGINS here and waits for the lock.
      pressed = press('no');
      let waiting = 0;
      for (let i = 0; i < 60 && waiting === 0; i += 1) {
        await new Promise((resolve) => setTimeout(resolve, 50));
        const [row] = (await db.execute(sql`
          SELECT count(*)::int AS n FROM pg_stat_activity WHERE wait_event_type = 'Lock' AND wait_event = 'advisory' AND datname = current_database()
        `)) as unknown as { n: number }[];
        waiting = Number(row?.n ?? 0);
      }
      // The premise, or the test proves nothing: the press really is waiting behind the tick.
      expect(waiting).toBeGreaterThan(0);
      // The tick commits AFTER the ❌'s transaction began — by the transaction's own clock the ❌ would read OLDER than it.
      await holder`
        INSERT INTO lot_checks (lot_id, seen_name_zh, seen_name_ru, seen_box_count, seen_client_id, checked_by, checked_at)
        VALUES (${lot.K}, ${`键盘${RUN}`}, ${`Клавиатура ${RUN}`}, 3, ${client.A}, ${staffId}, clock_timestamp())
      `;
      await holder`COMMIT`;
    } catch (err) {
      await holder`ROLLBACK`.catch(() => undefined);
      throw err;
    } finally {
      holder.release();
    }
    expect((await pressed!).outcome).toBe('recorded');
    const k = await stateOf('K');
    expect(k.person).toMatchObject({ holds: true });
    expect(k.client).toMatchObject({ verdict: 'no', vetoes: true });
    expect(k.state).toBe('none');
    // Back to the fixture: no tick on K, the client's ✅ on all three.
    await db.delete(lotChecks).where(eq(lotChecks.lotId, lot.K));
    await clearQueued();
    expect((await press('yes')).outcome).toBe('recorded');
    for (const key of ['K', 'T', 'S'] as const) expect((await stateOf(key)).state, key).toBe('checked');
  }, 20_000);

  it('the same ❌ pressed while the tick that lifts it is IN FLIGHT waits behind that tick and then sees it: «already» is decided under the lock', async () => {
    // The as-built review (L1-2, its second half). «Already» was decided from reads made BEFORE the lots'
    // answer locks: a ❌ pressed while a colleague's lifting tick was in flight was compared with a row
    // that still stood, answered «already», and the tick then committed over it — the lot ✅ by a
    // colleague who had been overruled a second time, and nobody told.
    await clearQueued();
    expect((await press('no')).outcome).toBe('recorded');
    expect((await stateOf('K')).client).toMatchObject({ verdict: 'no', vetoes: true });
    await clearQueued();
    const holder = await pgClient.reserve();
    let pressed: ReturnType<typeof press> | null = null;
    try {
      await holder`BEGIN`;
      await holder`SELECT pg_advisory_xact_lock(hashtextextended(${`lot-answer:${lot.K}`}, 0))`;
      // The other chat's copy of the message: the same tag, the same facts, the same ❌ as the row that stands.
      pressed = press('no', CHAT_A2);
      let waiting = 0;
      for (let i = 0; i < 60 && waiting === 0; i += 1) {
        await new Promise((resolve) => setTimeout(resolve, 50));
        const [row] = (await db.execute(sql`
          SELECT count(*)::int AS n FROM pg_stat_activity WHERE wait_event_type = 'Lock' AND wait_event = 'advisory' AND datname = current_database()
        `)) as unknown as { n: number }[];
        waiting = Number(row?.n ?? 0);
      }
      // The premise: the press did not answer from what it had read — it is waiting for the tick.
      expect(waiting).toBeGreaterThan(0);
      await holder`
        INSERT INTO lot_checks (lot_id, seen_name_zh, seen_name_ru, seen_box_count, seen_client_id, checked_by, checked_at)
        VALUES (${lot.K}, ${`键盘${RUN}`}, ${`Клавиатура ${RUN}`}, 3, ${client.A}, ${staffId}, clock_timestamp())
      `;
      await holder`COMMIT`;
    } catch (err) {
      await holder`ROLLBACK`.catch(() => undefined);
      throw err;
    } finally {
      holder.release();
    }
    try {
      expect((await pressed!).outcome).toBe('recorded');
      const k = await stateOf('K');
      expect(k.person).toMatchObject({ holds: true });
      expect(k.client).toMatchObject({ verdict: 'no', vetoes: true });
      expect(k.state).toBe('none');
      expect((await queued()).length).toBeGreaterThan(0);
    } finally {
      // Back to the fixture: no tick on K, the client's ✅ on all three.
      await db.delete(lotChecks).where(eq(lotChecks.lotId, lot.K));
      await clearQueued();
      expect((await press('yes')).outcome).toBe('recorded');
      await clearQueued();
    }
    for (const key of ['K', 'T', 'S'] as const) expect((await stateOf(key)).state, key).toBe('checked');
  }, 20_000);

  it('a server whose migration has not landed draws nothing and asks nothing (#472)', async () => {
    ready.on = false;
    expect(await lotCheckViewsFor([lot.K])).toEqual(new Map());
    const shelf = await plannableStock(wh.cn);
    expect(shelf.lots.find((l) => l.lotId === lot.K)?.check ?? null).toBeNull();
    ready.on = true;
  });

  it('0144 alone not landed: what shipped with 0123 goes on working — the two-source sentence, the tick, the lists — and the client’s side says so in words', async () => {
    // K holds the client's ✅ and nothing else; S a colleague's tick; T a standing tarkib.
    expect([(await stateOf('K')).state, (await stateOf('S')).state, (await stateOf('T')).state]).toEqual(['checked', 'checked', 'checked']);
    ready.client = false;
    try {
      const k = await stateOf('K');
      // The client's row is not read at all: K is a lot nobody has confirmed.
      expect([k.state, k.client]).toEqual(['none', null]);
      expect((await stateOf('S')).state).toBe('checked');
      expect((await stateOf('T')).state).toBe('checked');
      const shelf = await plannableStock(wh.cn);
      expect(shelf.lots.find((l) => l.lotId === lot.S)?.check).toBe('checked');
      expect(shelf.lots.find((l) => l.lotId === lot.K)?.check).toBe('none');
      // The colleague's tick itself — 0123's own door — works, and never looks for the missing table.
      const [row] = await db.select().from(receiptLots).where(eq(receiptLots.id, lot.K));
      const seen = { nameZh: row!.productNameZh, nameRu: row!.productNameRu ?? '', boxCount: row!.boxCount, clientId: client.A };
      expect(await checkLot({ lotId: lot.K, seen, seenCheckedAt: null, seenClientAt: null }, logist(), ctx())).toEqual({ changed: true });
      expect((await stateOf('K')).state).toBe('checked');
      await db.delete(lotChecks).where(eq(lotChecks.lotId, lot.K));
      // The client's side: nothing drawn, nothing written, and the person who asks is told why.
      expect(await press('yes')).toEqual({ outcome: 'unknown' });
      expect(await clientAskStatusFor(receipt.main)).toBeNull();
      await expect(askClientAboutReceipt(receipt.main, logist(), ctx(), () => true)).rejects.toMatchObject({ code: 'server_behind' });
      await expect(
        dismissClientDisputes({ receiptId: receipt.main, seen: [{ lotId: lot.K, token: 'x' }] }, logist(), ctx()),
      ).rejects.toMatchObject({ code: 'server_behind' });
    } finally {
      ready.client = true;
    }
    expect((await stateOf('K')).state).toBe('checked');
  });
});

describe('«Mijozdan so‘rash» — a person asks, once, and hears the answer', () => {
  const fits = () => true;
  const ask = (actor = logist(), fit: (f: ClientAskFacts) => boolean = fits, receiptId = receipt.main) =>
    askClientAboutReceipt(receiptId, actor, ctx(), fit);
  const code = async (run: Promise<unknown>) => {
    try {
      await run;
    } catch (err) {
      if (err instanceof ClientAskError) return err.code;
      throw err;
    }
    return 'ok';
  };

  it('the door is the lot check’s own — and every miss says «forbidden»', async () => {
    expect(await code(ask(logist({ permissions: new Set(['receipts.edit', 'crm.leads']) })))).toBe('forbidden');
    expect(await code(ask(logist(), fits, randomUUID()))).toBe('forbidden');
    expect(await code(ask(logist(), fits, 'nope'))).toBe('forbidden');
    // A scoped person standing at another warehouse cannot read the prixod.
    expect(await code(ask(logist({ warehouseScoped: true, warehouseIds: [wh.uz] })))).toBe('forbidden');
    expect(await noticeRow()).toBeUndefined();
  });

  it('refused in words: a client with no Telegram, cargo that has left China, a list that will not fit', async () => {
    await db.update(clientTelegramLinks).set({ status: 'revoked' }).where(eq(clientTelegramLinks.clientId, client.A));
    expect(await code(ask())).toBe('no_chat');
    await db.update(clientTelegramLinks).set({ status: 'linked' }).where(eq(clientTelegramLinks.clientId, client.A));
    expect(await code(ask(logist(), fits, receipt.uz))).toBe('not_askable');
    expect(await code(ask(logist(), () => false))).toBe('too_long');
    expect(await noticeRow()).toBeUndefined();
  });

  it('asks: ONE row for the prixod, due now, naming who asked; the History says so', async () => {
    expect(await ask()).toEqual({ lots: 3 });
    const row = await noticeRow();
    expect(row).toMatchObject({ status: 'pending', attempts: 0, asked_by: staffId, sent_at: null });
    expect(new Date(row!.send_after).getTime()).toBeLessThanOrEqual(Date.now() + 1000);
    expect(await clientAskStatusFor(receipt.main)).toMatchObject({ status: 'pending', deliveredAt: null });
    const [audit] = await db
      .select({ actorId: auditLog.actorId, after: auditLog.after })
      .from(auditLog)
      .where(and(eq(auditLog.entityType, 'receipt'), eq(auditLog.entityId, receipt.main)))
      .orderBy(sql`${auditLog.id} DESC`)
      .limit(1);
    expect(audit).toEqual({ actorId: staffId, after: { clientAsk: 'Telegram · 3 lot' } });
  });

  it('a second press while it waits or goes out is «already queued»; right after it went, «too soon»; later it is re-armed', async () => {
    expect(await code(ask())).toBe('already_queued');
    const set = (v: ReturnType<typeof sql>) => db.execute(sql`UPDATE client_notices SET ${v} WHERE kind = ${NOTICE_LOT_ASK} AND ref_id = ${receipt.main}::uuid`);
    await set(sql`status = 'sending'`);
    expect(await code(ask())).toBe('already_queued');
    await set(sql`status = 'sent', sent_at = now(), attempts = 1`);
    expect(await code(ask())).toBe('too_soon');
    expect(await clientAskStatusFor(receipt.main)).toMatchObject({ status: 'sent' });
    await set(sql`sent_at = now() - interval '11 minutes'`);
    expect(await ask()).toEqual({ lots: 3 });
    expect(await noticeRow()).toMatchObject({ status: 'pending', attempts: 0, asked_by: staffId });
    // A question that never reached anybody may be asked again at once.
    await set(sql`status = 'failed', sent_at = NULL, last_error = '403 Forbidden: bot was blocked by the user'`);
    expect(await clientAskStatusFor(receipt.main)).toMatchObject({ status: 'failed', reason: '403 Forbidden: bot was blocked by the user' });
    expect(await ask()).toEqual({ lots: 3 });
    await set(sql`status = 'sent', sent_at = now()`);
  });

  it('the answer to a question a person sent: the SAME ✅ as before is that question’s answer — written again, and the asker is told past their own mute', async () => {
    await clearQueued();
    const before = await rowsOfAnswers();
    // Every lot already holds ✅ about these very facts — but those were given BEFORE this question went out.
    await db.execute(sql`UPDATE lot_client_confirms SET answered_at = now() - interval '1 hour' WHERE lot_id IN (${lot.K}::uuid, ${lot.T}::uuid, ${lot.S}::uuid)`);
    const answer = await press('yes');
    expect(answer.outcome).toBe('recorded');
    const rows = await rowsOfAnswers();
    expect(rows.every((row) => row.askedBy === staffId)).toBe(true);
    expect(rows.every((row, i) => row.answeredAt > before[i]!.answeredAt || row.answeredAt.getTime() >= Date.now() - 60_000)).toBe(true);
    const told = await queued();
    expect(told.map((row) => [row.userId, row.type])).toEqual([[staffId, 'ClientLotConfirmed']]);
    // The History: no word of the answer changed, and the entry still has a line under it for every
    // lot — a row whose before and after are both empty draws «Tizim · o'zgartirdi» over nothing (#502).
    const [reAnswer] = await db
      .select({ actorId: auditLog.actorId, after: auditLog.after })
      .from(auditLog)
      .where(and(eq(auditLog.entityType, 'receipt'), eq(auditLog.entityId, receipt.main)))
      .orderBy(sql`${auditLog.id} DESC`)
      .limit(1);
    expect(reAnswer!.actorId).toBeNull();
    const lines = reAnswer!.after as Record<string, unknown>;
    expect(Object.keys(lines).sort()).toEqual(['clientConfirm:A', 'clientConfirm:B', 'clientConfirm:C']);
    for (const value of Object.values(lines)) expect(String(value)).toMatch(/^✅ Telegram · .* · qayta$/);
    // Now it IS the answer to the last question: a second tap is «already».
    expect(await press('yes')).toEqual({ outcome: 'already', verdict: 'yes' });
    expect(await queued()).toHaveLength(1);
    await clearQueued();
  });

  it('❌ to a question a person sent: the seller, the planners and the asker — each told once', async () => {
    const answer = await press('no');
    expect(answer.outcome).toBe('recorded');
    const told = await queued();
    const expected = [...new Set([sellerId, staffId, ...(await usersWithPermission('plans.manage'))])];
    expect(told.map((row) => row.userId).sort()).toEqual([...expected].sort());
    expect(told.every((row) => row.type === 'ClientLotDisputed')).toBe(true);
  });
});

/**
 * The ORDER of the CASE is the design, and until this table only scenarios
 * pinned it (the design judge). Every combination of the three bases is
 * arranged on one lot by hand and read back through the card's own reader;
 * the expected states are LITERALS — a table that recomputed them from a
 * JS twin of the rule would be the rule agreeing with itself.
 */
describe('the sentence, combination by combination — against literal states', () => {
  type Tarkib = 'none' | 'stands' | 'stale';
  type Tick = 'none' | 'old' | 'new' | 'stale';
  /** The client's answer, given an hour ago: none · ✅ that matches · ✅ about a count since changed · ❌ on the goods now listed · ❌ on OTHER goods · a previous owner's ❌. */
  const CLIENT = ['none', 'yes', 'yesMoved', 'no', 'noOtherGoods', 'noOtherOwner'] as const;
  type Answer = (typeof CLIENT)[number];
  // c = ✅ checked · n = ❓ none · s = ⚠ stale — one letter per CLIENT case, in that order.
  // Tick: «old» holds and was pressed two hours ago (before the answer); «new» holds and was pressed now (after it).
  const EXPECTED: Record<Tarkib, Record<Tick, string>> = {
    none: { none: 'ncsnnn', old: 'cccnnc', new: 'cccccc', stale: 'scsnns' },
    stands: { none: 'cccncc', old: 'cccncc', new: 'cccccc', stale: 'cccncc' },
    stale: { none: 'scsnns', old: 'cccnnc', new: 'cccccc', stale: 'scsnns' },
  };
  const LETTER = { checked: 'c', none: 'n', stale: 's', unclaimed: 'u' } as const;

  async function arrange(tarkib: Tarkib, tick: Tick, answer: Answer): Promise<void> {
    await db.delete(lotClientConfirms).where(eq(lotClientConfirms.lotId, lot.M));
    await db.delete(lotChecks).where(eq(lotChecks.lotId, lot.M));
    await db.delete(lotCompositions).where(eq(lotCompositions.lotId, lot.M));
    if (tarkib !== 'none') {
      // One good, named as the lot is: the SHOWN name stays the lot's own, so the snapshots below can state it.
      await db.insert(lotCompositions).values({ lotId: lot.M, seenBoxCount: tarkib === 'stands' ? 2 : 3, savedBy: staffId });
      await db.insert(lotCompositionLines).values([{ lotId: lot.M, seq: 1, name: MATRIX_RU, pieces: 10, weightKg: '100.000', volumeM3: '1.0000' }]);
    }
    const [key] = (await db.execute(sql`
      SELECT md5(string_agg(l.name || chr(31) || coalesce(l.pieces::text, ''), chr(30) ORDER BY l.seq)) AS goods_key
        FROM lot_composition_lines l WHERE l.lot_id = ${lot.M}::uuid
    `)) as unknown as { goods_key: string | null }[];
    const goodsKey = key?.goods_key ?? null;
    if (tick !== 'none') {
      await db.execute(sql`
        INSERT INTO lot_checks (lot_id, seen_name_zh, seen_name_ru, seen_box_count, seen_client_id, checked_by, checked_at)
        VALUES (${lot.M}::uuid, ${MATRIX_ZH}, ${MATRIX_RU}, ${tick === 'stale' ? 9 : 2}, ${client.A}::uuid, ${staffId}::uuid,
                now() - make_interval(mins => ${tick === 'new' ? 0 : 120}))
      `);
    }
    if (answer !== 'none') {
      await db.execute(sql`
        INSERT INTO lot_client_confirms (lot_id, verdict, shown_zh, shown_ru, shown_count, shown_client_id, shown_goods_key, chat_id, answered_at)
        VALUES (${lot.M}::uuid, ${answer === 'yes' || answer === 'yesMoved' ? 'yes' : 'no'}, ${MATRIX_ZH}, ${MATRIX_RU},
                ${answer === 'yesMoved' ? 9 : 2}, ${answer === 'noOtherOwner' ? client.B : client.A}::uuid,
                ${answer === 'noOtherGoods' ? 'f'.repeat(32) : goodsKey}, ${CHAT_A}, now() - interval '60 minutes')
      `);
    }
  }
  const read = async () => (await lotCheckViewsFor([lot.M])).get(lot.M)!;

  it('72 combinations of tarkib × tick × the client’s answer', async () => {
    const wrong: string[] = [];
    for (const tarkib of Object.keys(EXPECTED) as Tarkib[]) {
      for (const tick of Object.keys(EXPECTED[tarkib]) as Tick[]) {
        for (const [i, answer] of CLIENT.entries()) {
          await arrange(tarkib, tick, answer);
          const view = await read();
          const got = LETTER[view.state];
          const want = EXPECTED[tarkib][tick][i];
          if (got !== want) wrong.push(`tarkib ${tarkib} · tick ${tick} · client ${answer}: ${got}, expected ${want}`);
          // The card's «the ❌ is why» is the sentence's own arm: this owner's ❌ and nothing vouching past it.
          const vetoes = (answer === 'no' || answer === 'noOtherGoods') && want === 'n';
          if ((view.client?.vetoes ?? false) !== vetoes) wrong.push(`tarkib ${tarkib} · tick ${tick} · client ${answer}: vetoes ${!vetoes}`);
        }
      }
    }
    expect(wrong).toEqual([]);
  }, 60_000);

  it('cargo with no client is never vetoed and never ❓: a previous owner’s ❌ is nobody’s', async () => {
    await db.update(receipts).set({ clientId: null }).where(eq(receipts.id, receipt.matrix));
    try {
      await arrange('none', 'none', 'none');
      expect((await read()).state).toBe('unclaimed');
      await arrange('none', 'old', 'no');
      expect((await read()).state).toBe('unclaimed');
      // A standing tarkib vouches on unclaimed cargo too (his 3a) — and the ❌ of the client it was taken from does not veto it.
      await arrange('stands', 'none', 'no');
      const view = await read();
      expect([view.state, view.client?.vetoes, view.client?.ofOwner]).toEqual(['checked', false, false]);
    } finally {
      await db.update(receipts).set({ clientId: client.A }).where(eq(receipts.id, receipt.matrix));
      await arrange('none', 'none', 'none');
    }
  });
});
