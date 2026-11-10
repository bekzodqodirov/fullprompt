import 'dotenv/config';
import { randomUUID } from 'node:crypto';
import { eq, inArray } from 'drizzle-orm';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { db } from '@/modules/platform/db/client';
import {
  batches,
  boxMovements,
  boxes,
  clients,
  lotCompositionLines,
  lotCompositions,
  receiptLots,
  receipts,
  tnvedAssignments,
  users,
  warehouses,
} from '@/modules/platform/db/schema';
import { NO_MERGE, invoiceModel } from '@/modules/wms/documents/invoice-rows';
import { DOC } from '@/modules/wms/documents/labels';
import { buildInvoiceXlsx, invoiceLotLabel, invoiceSourceRows } from '@/modules/wms/documents/ved-xlsx';
import { productKey } from '@/modules/wms/tnved/service';
import { readInvoiceSheet } from '../fixtures/invoice-sheet';

/**
 * The customs invoice as POSITIONS, against a real truck (the owner's item 6,
 * 2026-11-10; docs/TARKIB-TUZATISH.md §6 and §9.4): same code + same name is
 * one row, a code that still holds several rows is merged only by a signed
 * answer, column B names the stickers behind each row, and a sticker whose
 * lot holds several goods in several rows is red. The pure rules are in
 * tests/unit/invoice-rows.test.ts; this file is the builder and the sheet.
 *
 * ONE truck out of China carrying seven lots:
 *   K  client 1, lot A — tarkib of two goods: «Клавиатура» 8471607000 (500 шт)
 *      and «Мышь» 8471606000 (300 шт)
 *   W  client 1, lot B — tarkib of one good: «Клавиатура беспроводная» 8471607000
 *   B  client 2 — no tarkib, «Клавиатура», the memory's code 8471607000
 *   C  client 3 — no tarkib, the SAME good as B (same Chinese name, «клавиатура »)
 *   E  client 4 — the same good again, but client 4 clears through his OWN firm
 *   T  unclaimed, marking only — tea, no code
 *   G  client 2, received under a marking and claimed later — coffee, no code
 */

const SFX = randomUUID().replace(/-/g, '').slice(0, 6).toUpperCase();
const ZH_KEYBOARD = `键盘甲${SFX}`;
let actorId = '';
let truckId = '';
const wh = { cn: '', uz: '' };
const client: Record<string, string> = {};
const code: Record<string, string> = {};
const receipt: Record<string, string> = {};
const lot: Record<string, string> = {};
const ago = (hours: number) => new Date(Date.now() - hours * 3_600_000);

async function mintReceipt(key: string, clientKey: string | null, extra: Partial<typeof receipts.$inferInsert> = {}) {
  const [row] = await db
    .insert(receipts)
    .values({
      number: `IM-${SFX}-${key}`,
      warehouseId: wh.cn,
      clientId: clientKey ? client[clientKey]! : null,
      status: 'confirmed',
      createdBy: actorId,
      confirmedAt: ago(48),
      confirmedBy: actorId,
      createdAt: ago(48),
      ...extra,
    })
    .returning({ id: receipts.id });
  receipt[key] = row!.id;
}

async function mintLot(key: string, receiptKey: string, seq: number, zh: string, ru: string | null, n: number, kg: string) {
  const [row] = await db
    .insert(receiptLots)
    .values({
      receiptId: receipt[receiptKey]!,
      seq,
      letter: String.fromCharCode(64 + seq),
      cycleNo: 1,
      productNameZh: zh,
      productNameRu: ru,
      boxCount: n,
      dimsMode: 'mixed',
      totalWeightKg: kg,
      totalVolumeM3: '1.0000',
    })
    .returning({ id: receiptLots.id });
  lot[key] = row!.id;
  const made = await db
    .insert(boxes)
    .values(
      Array.from({ length: n }, (_, i) => ({
        lotId: row!.id,
        seqInLot: i + 1,
        shortCode: `IM${SFX}${key}${i + 1}`,
        status: 'in_transit',
        currentBatchId: truckId,
        currentWarehouseId: null,
      })),
    )
    .returning({ id: boxes.id });
  await db.insert(boxMovements).values(
    made.map((box) => ({
      boxId: box.id,
      fromStatus: 'loading',
      toStatus: 'in_transit',
      cause: 'batch_departed',
      refType: 'batch',
      refId: truckId,
      actorId,
      createdAt: ago(24),
    })),
  );
}

async function compose(key: string, n: number, lines: { name: string; code: string; cartons: number; kg: string; pieces?: number }[]) {
  await db.insert(lotCompositions).values({ lotId: lot[key]!, seenBoxCount: n, savedBy: actorId });
  await db.insert(lotCompositionLines).values(
    lines.map((l, i) => ({
      lotId: lot[key]!,
      seq: i + 1,
      name: l.name,
      tnvedCode: l.code,
      cartons: l.cartons,
      pieces: l.pieces ?? null,
      weightKg: l.kg,
      volumeM3: (1 / lines.length).toFixed(4),
    })),
  );
}

beforeAll(async () => {
  actorId = (await db.query.users.findFirst({ where: eq(users.phone, '+998900000004') }))!.id;
  const s3 = SFX.slice(0, 3);
  for (const [key, country] of [['cn', 'CN'], ['uz', 'UZ']] as const) {
    const [w] = await db
      .insert(warehouses)
      .values({
        code: `IM${key === 'cn' ? 'C' : 'U'}${s3}`,
        name: `Invoys ${key} ${SFX}`,
        country,
        type: country === 'CN' ? 'origin' : 'distribution',
        timezone: country === 'CN' ? 'Asia/Shanghai' : 'Asia/Tashkent',
        batchPrefix: `IM${key === 'cn' ? 'C' : 'U'}${s3}`,
      })
      .returning({ id: warehouses.id });
    wh[key] = w!.id;
  }
  for (const n of ['1', '2', '3', '4']) {
    code[n] = `IM${n}${SFX}`;
    const [c] = await db
      .insert(clients)
      .values({ clientCode: code[n]!, name: `Invoys ${n} ${SFX}` })
      .returning({ id: clients.id });
    client[n] = c!.id;
  }
  const [truck] = await db
    .insert(batches)
    .values({
      code: `IMT-${SFX}`,
      originWarehouseId: wh.cn,
      destWarehouseId: wh.uz,
      status: 'in_transit',
      departedAt: ago(24),
      createdBy: actorId,
    })
    .returning({ id: batches.id });
  truckId = truck!.id;

  await mintReceipt('r1', '1');
  await mintReceipt('r2', '2');
  await mintReceipt('r3', '3');
  // Client 4 clears his cargo through his own firm (the Rastamojka panel).
  await mintReceipt('r4', '4', { customsByClient: true });
  await mintReceipt('r5', null, { unclaimedMarking: `MRK${SFX}` });
  await mintReceipt('r6', '2', { unclaimedMarking: `444MAN${SFX}` });

  await mintLot('K', 'r1', 1, `键盘鼠${SFX}`, 'Клавиатура', 10, '100.000');
  await mintLot('W', 'r1', 2, `无线${SFX}`, null, 2, '20.000');
  await mintLot('B', 'r2', 1, ZH_KEYBOARD, 'Клавиатура', 5, '50.000');
  await mintLot('C', 'r3', 1, ZH_KEYBOARD, 'клавиатура ', 3, '30.500');
  await mintLot('E', 'r4', 1, ZH_KEYBOARD, 'Клавиатура', 4, '40.000');
  await mintLot('T', 'r5', 1, `茶${SFX}`, null, 2, '8.000');
  await mintLot('G', 'r6', 1, `咖啡${SFX}`, null, 1, '4.000');

  await compose('K', 10, [
    { name: 'Клавиатура', code: '8471607000', cartons: 6, kg: '60.000', pieces: 500 },
    { name: 'Мышь', code: '8471606000', cartons: 4, kg: '40.000', pieces: 300 },
  ]);
  await compose('W', 2, [{ name: 'Клавиатура беспроводная', code: '8471607000', cartons: 2, kg: '20.000' }]);
  await db
    .insert(tnvedAssignments)
    .values({ productKey: productKey(ZH_KEYBOARD), productNameZh: ZH_KEYBOARD, tnvedCode: '8471607000', source: 'manual' });
});

afterAll(async () => {
  const lotIds = Object.values(lot).filter(Boolean);
  try {
    await db.delete(tnvedAssignments).where(eq(tnvedAssignments.productKey, productKey(ZH_KEYBOARD)));
    if (lotIds.length > 0) {
      await db.delete(lotCompositions).where(inArray(lotCompositions.lotId, lotIds));
      const boxIds = (await db.select({ id: boxes.id }).from(boxes).where(inArray(boxes.lotId, lotIds))).map((b) => b.id);
      if (boxIds.length > 0) {
        await db.delete(boxMovements).where(inArray(boxMovements.boxId, boxIds));
        await db.delete(boxes).where(inArray(boxes.id, boxIds));
      }
      await db.delete(receiptLots).where(inArray(receiptLots.id, lotIds));
    }
    const receiptIds = Object.values(receipt).filter(Boolean);
    if (receiptIds.length > 0) await db.delete(receipts).where(inArray(receipts.id, receiptIds));
    if (truckId) await db.delete(batches).where(eq(batches.id, truckId));
    const clientIds = Object.values(client).filter(Boolean);
    if (clientIds.length > 0) await db.delete(clients).where(inArray(clients.id, clientIds));
    await db.delete(warehouses).where(inArray(warehouses.id, [wh.cn, wh.uz].filter(Boolean)));
  } catch (err) {
    console.error('[invoice-merge] cleanup', err);
  }
});

const L = () => ({
  K: `${code['1']}-A`,
  W: `${code['1']}-B`,
  B: `${code['2']}-A`,
  C: `${code['3']}-A`,
  E: `${code['4']}-A`,
  T: `MRK${SFX}-A`,
  G: `${code['2']}-A (444MAN${SFX})`,
});

describe('the stickers a row names', () => {
  it('client code + lot letter; a marking the cartons still carry follows in brackets; unclaimed cargo has only its marking', () => {
    expect(invoiceLotLabel({ clientCode: 'GS777', marking: null, letter: 'AB' })).toBe('GS777-AB');
    expect(invoiceLotLabel({ clientCode: 'GS444', marking: '444MANIKEN-AL', letter: 'B' })).toBe('GS444-B (444MANIKEN-AL)');
    expect(invoiceLotLabel({ clientCode: null, marking: '444MANIKEN-AL', letter: 'B' })).toBe('444MANIKEN-AL-B');
    expect(invoiceLotLabel({ clientCode: null, marking: null, letter: null })).toBe('?-');
  });
});

describe('a bare address — nothing asked is merged', () => {
  it('same code + name + unit is ONE row whoever’s cargo it is; «шт» is never swallowed; another customs choice stays apart', async () => {
    const sheet = await readInvoiceSheet(await buildInvoiceXlsx(truckId));
    const l = L();
    expect(sheet.rows.map((r) => [r.marks, r.product, r.code, r.unit, r.quantity, r.places, r.brutto])).toEqual([
      // Lot K's two goods, in «шт» as the tarkib states them.
      [l.K, 'Клавиатура', '8471607000', 'шт', 500, 6, 60],
      [l.K, 'Мышь', '8471606000', 'шт', 300, 4, 40],
      // B and C: two clients, one good — ONE position, both stickers named.
      [`${l.B}, ${l.C}`, 'Клавиатура', '8471607000', 'кг', 80.5, 8, 80.5],
      // No code: never merged, never asked.
      [l.G, `咖啡${SFX}`, '', 'кг', 4, 1, 4],
      // Client 4 clears through his own firm: his keyboards are not ours.
      [l.E, 'Клавиатура', '8471607000', 'кг', 40, 4, 40],
      [l.T, `茶${SFX}`, '', 'кг', 8, 2, 8],
      [l.W, 'Клавиатура беспроводная', '8471607000', 'кг', 20, 2, 20],
    ]);
    expect(sheet.rows.map((r) => r.no)).toEqual([1, 2, 3, 4, 5, 6, 7]);
    // netto = brutto on every row, and no row is an estimate (the whole lots ride).
    expect(sheet.rows.every((r) => r.netto === r.brutto && r.note === null && !r.filled)).toBe(true);
  });

  it('RED: lot K holds two goods in two rows — its sticker is red in BOTH, and nothing else is', async () => {
    const sheet = await readInvoiceSheet(await buildInvoiceXlsx(truckId));
    const l = L();
    expect(sheet.rows.map((r) => r.redMarks)).toEqual([[l.K], [l.K], [], [], [], [], []]);
    // Every run of a rich-text cell names its own face: the «all Arial» pass
    // sets the CELL's font and does not reach runs.
    const rich = sheet.sheet.getRow(sheet.rows[0]!.row).getCell(sheet.cols.marks).value as {
      richText: { text: string; font?: { name?: string; bold?: boolean } }[];
    };
    expect(rich.richText.every((run) => run.font?.name === 'Arial')).toBe(true);
    expect(rich.richText.find((run) => run.text === l.K)?.font?.bold).toBe(true);
  });

  it('the formulas name the moved columns: amount = price × quantity, the totals sum places, netto, brutto and amount', async () => {
    const sheet = await readInvoiceSheet(await buildInvoiceXlsx(truckId));
    const { letters } = sheet;
    expect([letters.no, letters.marks, letters.product, letters.code, letters.unit, letters.quantity]).toEqual(['A', 'B', 'C', 'D', 'E', 'F']);
    expect([letters.places, letters.netto, letters.brutto, letters.price, letters.amount]).toEqual(['G', 'H', 'I', 'J', 'K']);
    for (const r of sheet.rows) expect(r.amount).toBe(`J${r.row}*F${r.row}`);
    const first = sheet.rows[0]!.row;
    const last = sheet.rows.at(-1)!.row;
    expect(sheet.totals).toEqual({
      places: `SUM(G${first}:G${last})`,
      netto: `SUM(H${first}:H${last})`,
      brutto: `SUM(I${first}:I${last})`,
      amount: `SUM(K${first}:K${last})`,
    });
  });

  it('the header block moved to column C and left B empty beside the labels of column A', async () => {
    const { sheet, headRow } = await readInvoiceSheet(await buildInvoiceXlsx(truckId));
    expect(headRow).toBe(20);
    expect(String(sheet.getCell('C1').value)).toContain('I N V O I C E');
    expect(String(sheet.getCell('C3').value)).toMatch(new RegExp(`^\\d{8}imt${SFX.toLowerCase()}$`));
    expect(String(sheet.getCell('A7').value)).toBe('Отправитель/Sender:');
    for (let r = 1; r <= 18; r += 1) expect(sheet.getCell(`B${r}`).value ?? null, `B${r}`).toBeNull();
    expect(String(sheet.getRow(headRow).getCell(2).value)).toBe(DOC.lotMarks);
  });
});

describe('the answers the address carries', () => {
  it('the code that holds three rows is listed as ONE group with the mixed-units warning; client 4’s row is not in it', async () => {
    const source = (await invoiceSourceRows(truckId))!;
    const model = invoiceModel(source.rows);
    expect(model.groups).toHaveLength(1);
    const [group] = model.groups;
    expect(group!.code).toBe('8471607000');
    expect(group!.names.map((n) => [n.name, n.unit, n.quantity])).toEqual([
      ['Клавиатура', 'шт', 500],
      ['Клавиатура', 'кг', 80.5],
      ['Клавиатура беспроводная', 'кг', 20],
    ]);
    expect(group!.merged).toMatchObject({ name: 'Клавиатура, Клавиатура беспроводная', unit: 'кг', quantity: 160.5, mixedUnits: true });
    // Who clears the other scope, for the dialog.
    expect(source.scopes.get(`client:${client['4']}`)).toEqual({ kind: 'client', name: code['4'] });
    expect(source.scopes.size).toBe(1);
  });

  it('merged by its signed key: ONE position in the first row’s slot, the count kept in a note, the sums untouched, K still red', async () => {
    const source = (await invoiceSourceRows(truckId))!;
    const model = invoiceModel(source.rows);
    const bare = await readInvoiceSheet(await buildInvoiceXlsx(truckId, NO_MERGE));
    const merged = await readInvoiceSheet(
      await buildInvoiceXlsx(truckId, { all: null, picks: new Set([model.groups[0]!.key]) }),
    );
    const l = L();
    expect(merged.rows.map((r) => [r.marks, r.product, r.unit, r.quantity, r.places, r.brutto])).toEqual([
      [`${l.K}, ${l.B}, ${l.C}, ${l.W}`, 'Клавиатура, Клавиатура беспроводная', 'кг', 160.5, 16, 160.5],
      [l.K, 'Мышь', 'шт', 300, 4, 40],
      [l.G, `咖啡${SFX}`, 'кг', 4, 1, 4],
      [l.E, 'Клавиатура', 'кг', 40, 4, 40],
      [l.T, `茶${SFX}`, 'кг', 8, 2, 8],
    ]);
    // The 500 pieces a «кг» position cannot carry are named beside the quantity.
    expect(merged.rows[0]!.quantityNote).toBe(`шт: ${l.K} 500`);
    // Lot K's goods still stand in two rows: red in both, and only K's run in the merged cell.
    expect(merged.rows[0]!.redMarks).toEqual([l.K]);
    expect(merged.rows[1]!.redMarks).toEqual([l.K]);
    // What customs adds up does not move.
    const sum = (rows: typeof bare.rows, pick: (r: (typeof bare.rows)[number]) => number) =>
      Math.round(rows.reduce((s, r) => s + pick(r), 0) * 10) / 10;
    expect(sum(merged.rows, (r) => r.brutto)).toBe(sum(bare.rows, (r) => r.brutto));
    expect(sum(merged.rows, (r) => r.netto)).toBe(sum(bare.rows, (r) => r.netto));
    expect(sum(merged.rows, (r) => Number(r.places))).toBe(sum(bare.rows, (r) => Number(r.places)));
    // «all» with the list's fingerprint is the same file.
    const all = await readInvoiceSheet(await buildInvoiceXlsx(truckId, { all: model.fp, picks: new Set() }));
    expect(all.rows.map((r) => r.product)).toEqual(merged.rows.map((r) => r.product));
  });

  it('a stale or forged answer merges nothing — the file is the bare one', async () => {
    const bare = await readInvoiceSheet(await buildInvoiceXlsx(truckId));
    for (const answer of [
      { all: null, picks: new Set(['8471607000.deadbeef']) },
      { all: 'deadbeef', picks: new Set<string>() },
    ]) {
      const sheet = await readInvoiceSheet(await buildInvoiceXlsx(truckId, answer));
      expect(sheet.rows.map((r) => [r.marks, r.product, r.quantity])).toEqual(bare.rows.map((r) => [r.marks, r.product, r.quantity]));
    }
  });

  it('a name typed after the list was shown asks again: the old key no longer merges', async () => {
    const before = invoiceModel((await invoiceSourceRows(truckId))!.rows);
    await db
      .update(lotCompositionLines)
      .set({ name: 'Клавиатура игровая' })
      .where(eq(lotCompositionLines.lotId, lot['W']!));
    try {
      const sheet = await readInvoiceSheet(
        await buildInvoiceXlsx(truckId, { all: null, picks: new Set([before.groups[0]!.key]) }),
      );
      expect(sheet.rows).toHaveLength(7);
      const now = invoiceModel((await invoiceSourceRows(truckId))!.rows);
      expect(now.groups[0]!.key).not.toBe(before.groups[0]!.key);
    } finally {
      await db
        .update(lotCompositionLines)
        .set({ name: 'Клавиатура беспроводная' })
        .where(eq(lotCompositionLines.lotId, lot['W']!));
    }
  });
});

describe('the order of the rows does not depend on how the cartons happen to be read', () => {
  it('lots that share a letter stand by their label, then their id — the same file on every download', async () => {
    const a = (await invoiceSourceRows(truckId))!.rows.map((r) => `${r.lot.label}|${r.name}`);
    const b = (await invoiceSourceRows(truckId))!.rows.map((r) => `${r.lot.label}|${r.name}`);
    expect(a).toEqual(b);
    const l = L();
    expect([...new Set((await invoiceSourceRows(truckId))!.rows.map((r) => r.lot.label))]).toEqual([l.K, l.B, l.G, l.C, l.E, l.T, l.W]);
  });

  it('a truck that is not there is no file', async () => {
    expect(await buildInvoiceXlsx(randomUUID())).toBeNull();
    expect(await invoiceSourceRows(randomUUID())).toBeNull();
  });
});
