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

const ready = vi.hoisted(() => ({ on: true }));
vi.mock('@/modules/wms/receipts/lot-check-ready', () => ({ lotChecksReady: async () => ready.on }));
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
  dismissClientDispute,
  type ClientAskFacts,
} from '@/modules/wms/receipts/client-confirm';
import { lotCheckViewsFor, type LotCheckActor } from '@/modules/wms/receipts/lot-check';
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
const receipt = { main: '', uz: '' };
const lot = { K: '', T: '', S: '', U: '' };
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
  const whIds = Object.values(wh).filter(Boolean);
  if (whIds.length > 0) await db.delete(warehouses).where(inArray(warehouses.id, whIds));
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
    expect(await clientAskFacts(randomUUID())).toEqual({ skip: 'receipt_gone' });
    expect(await clientAskFacts('not-an-id')).toEqual({ skip: 'receipt_gone' });
    const set = (v: Partial<typeof receipts.$inferInsert>) => db.update(receipts).set(v).where(eq(receipts.id, receipt.main));
    await set({ status: 'draft' });
    expect(await clientAskFacts(receipt.main)).toEqual({ skip: 'not_confirmed' });
    await set({ status: 'confirmed', clientId: null });
    expect(await clientAskFacts(receipt.main)).toEqual({ skip: 'no_client' });
    await set({ clientId: client.A });
  });
});

describe('the ✅ / ❌ row under «yukingiz qabul qilindi» — offered only where it means something', () => {
  const offer = () => clientAskOffer(receipt.main, client.A);
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
      expect(await clientAskOffer(receipt.main, client.B)).toBeNull();
      await setSetting('client_confirm_on_receipt', false, null);
      expect(await offer()).toBeNull();
      await setSetting('client_confirm_on_receipt', true, null);
      ready.on = false;
      expect(await offer()).toBeNull();
      ready.on = true;
      expect(await offer()).not.toBeNull();
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
    expect(await clientAskOffer(receipt.uz, client.A)).toBeNull();
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
    expect(await press('no', CHAT_A, 'deadbeef')).toEqual({ outcome: 'stale' });
    await db.update(receipts).set({ status: 'voided' }).where(eq(receipts.id, receipt.main));
    try {
      // The very tag the message carried: the prixod is void, so there is nothing left to answer about.
      expect(await press('no', CHAT_A, tag)).toEqual({ outcome: 'stale' });
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
      expect(view.client, key).toMatchObject({ verdict: 'no', holds: true });
    }
    // The colleague's tick is untouched — it simply does not outrank the owner of the cargo.
    expect((await stateOf('S')).person).toMatchObject({ holds: true });
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
    expect(text.split('\n').at(-1)).toContain(`/receipts/${receipt.main}`);
    await clearQueued();
  });

  it('way out 1 — the data is corrected: the ❌ is about facts that no longer exist, and says nothing', async () => {
    await db.update(receiptLots).set({ productNameRu: `Клавиатура проводная ${RUN}` }).where(eq(receiptLots.id, lot.K));
    const k = await stateOf('K');
    expect(k.client).toMatchObject({ verdict: 'no', holds: false });
    // Nobody else has confirmed K, and a ❌ that moved is not «was confirmed»: ❓, not ⚠.
    expect(k.state).toBe('none');
    // S's own name was not touched: its dispute still stands.
    expect((await stateOf('S')).state).toBe('none');
    await db.update(receiptLots).set({ productNameRu: `Клавиатура ${RUN}` }).where(eq(receiptLots.id, lot.K));
    expect((await stateOf('K')).client).toMatchObject({ holds: true });
  });

  it('way out 1b — the tarkib is re-written with other goods: the dispute about the old list is over, the tarkib vouches again', async () => {
    await db.update(lotCompositionLines).set({ pieces: 480 }).where(and(eq(lotCompositionLines.lotId, lot.T), eq(lotCompositionLines.seq, 1)));
    const t = await stateOf('T');
    expect(t.client).toMatchObject({ verdict: 'no', holds: false });
    expect(t.state).toBe('checked');
    await db.update(lotCompositionLines).set({ pieces: 500 }).where(and(eq(lotCompositionLines.lotId, lot.T), eq(lotCompositionLines.seq, 1)));
    expect((await stateOf('T')).state).toBe('none');
  });

  it('way out 2 — a person closes the dispute: the row is gone, the History says who and why, the lot reads as before the ❌', async () => {
    await expect(dismissClientDispute({ lotId: lot.S }, logist({ permissions: new Set(['receipts.edit']) }), ctx())).rejects.toMatchObject({ code: 'forbidden' });
    await expect(dismissClientDispute({ lotId: 'x' }, logist(), ctx())).rejects.toBeInstanceOf(ClientDisputeError);
    await dismissClientDispute({ lotId: lot.S, note: 'mijoz adashib bosgan' }, logist(), ctx());
    const s = await stateOf('S');
    expect(s.client).toBeNull();
    expect(s.state).toBe('checked');
    const [audit] = await db
      .select({ actorId: auditLog.actorId, before: auditLog.before, after: auditLog.after })
      .from(auditLog)
      .where(and(eq(auditLog.entityType, 'receipt'), eq(auditLog.entityId, receipt.main)))
      .orderBy(sql`${auditLog.id} DESC`)
      .limit(1);
    expect(audit!.actorId).toBe(staffId);
    expect(audit!.before).toEqual({ 'clientConfirm:C': `❌ 鼠标${RUN} × 2` });
    expect(audit!.after).toEqual({ 'clientConfirm:C': 'e’tiroz yopildi: mijoz adashib bosgan' });
    // A second press has nothing to close; a ✅ is never closed by a person.
    await expect(dismissClientDispute({ lotId: lot.S }, logist(), ctx())).rejects.toMatchObject({ code: 'nothing_to_close' });
  });

  it('way out 3 — the client answers again: the newest answer is the one that stands', async () => {
    const answer = await press('yes', CHAT_A2);
    expect(answer.outcome).toBe('recorded');
    for (const key of ['K', 'T', 'S'] as const) expect((await stateOf(key)).state, key).toBe('checked');
    const rows = await rowsOfAnswers();
    expect(rows.every((row) => row.verdict === 'yes' && row.chatId === CHAT_A2)).toBe(true);
    // A ✅ cannot be closed by a person.
    await expect(dismissClientDispute({ lotId: lot.K }, logist(), ctx())).rejects.toMatchObject({ code: 'nothing_to_close' });
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

  it('a server whose migration has not landed draws nothing and asks nothing (#472)', async () => {
    ready.on = false;
    expect(await lotCheckViewsFor([lot.K])).toEqual(new Map());
    const shelf = await plannableStock(wh.cn);
    expect(shelf.lots.find((l) => l.lotId === lot.K)?.check ?? null).toBeNull();
    ready.on = true;
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
    expect(await clientAskStatusFor(receipt.main)).toMatchObject({ status: 'pending', sentAt: null });
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
