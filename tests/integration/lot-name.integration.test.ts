import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { eq, inArray, sql } from 'drizzle-orm';
import { db } from '@/modules/platform/db/client';
import { clients, lotCompositionLines, lotCompositions, receiptLots, users } from '@/modules/platform/db/schema';
import { tarkibLabel } from '@/modules/wms/receipts/composition-math';
import { compositionsFor } from '@/modules/wms/receipts/lot-composition';
import { lotGoodsShownSql, lotRuShownFor, lotRuShownSql, tarkibLineMatchSql } from '@/modules/wms/receipts/lot-name';
import { receiveStamped, removeStamped } from '../fixtures/stamped-cargo';

/**
 * The Russian name a lot is SHOWN under (the owner's items 3-4, 2026-11-10;
 * docs/TARKIB-TUZATISH.md §3): the SQL fragments every display reader asks,
 * held equal to the pure `tarkibLabel` — and the one promise the whole design
 * rests on: the STORED name never moves.
 *
 * Lots are written straight to the tables (`receiveStamped`), compositions
 * too: the writer's own rules are proven in lot-composition.integration; this
 * file is about what a reader gets back, including shapes the writer never
 * leaves behind (a header with no lines, lines that do not start at 1).
 */

const RUN = String(Date.now()).slice(-6);
let actorId = '';
let clientId = '';
const receiptIds: string[] = [];
const lot = { none: '', one: '', three: '', twenty: '', torn: '', gap: '', noRu: '', sameZh: '', sameZhNoRu: '', zhFirst: '' };
/** Every lot of this file carries this Chinese name. */
const ZH = `键盘 Hub${RUN}`;
const pure = (lines: readonly { seq: number; name: string }[]) => tarkibLabel(lines, ZH);

async function mint(ru: string | null): Promise<string> {
  const made = await receiveStamped({ clientId, actorId, sellerId: null, m3: 1, kg: 10, boxes: 2 });
  receiptIds.push(made.receiptId);
  await db
    .update(receiptLots)
    .set({ productNameZh: ZH, productNameRu: ru })
    .where(eq(receiptLots.id, made.lotId));
  return made.lotId;
}

async function compose(lotId: string, names: { seq: number; name: string }[]): Promise<void> {
  // No document: optional since 0143 — which this insert also proves.
  await db.insert(lotCompositions).values({ lotId, seenBoxCount: 2, savedBy: actorId });
  if (names.length > 0) {
    await db
      .insert(lotCompositionLines)
      .values(names.map((n) => ({ lotId, seq: n.seq, name: n.name, weightKg: '1.000', volumeM3: '0.1000' })));
  }
}

async function shown(lotId: string): Promise<{ ru: string | null; goods: string; stored: string | null }> {
  const [row] = await db
    .select({
      ru: sql<string | null>`${lotRuShownSql(sql`${receiptLots}`)}`,
      goods: sql<string>`${lotGoodsShownSql(sql`${receiptLots}`)}`,
      stored: sql<string | null>`${receiptLots}.product_name_ru`,
    })
    .from(receiptLots)
    .where(eq(receiptLots.id, lotId));
  return row!;
}

const THREE = [
  { seq: 1, name: 'Клавиатура' },
  { seq: 2, name: 'Мышь' },
  { seq: 3, name: 'Наушники' },
];
const TWENTY = Array.from({ length: 20 }, (_, i) => ({ seq: i + 1, name: `Товар ${i + 1}` }));

beforeAll(async () => {
  const [u] = await db.select({ id: users.id }).from(users).limit(1);
  const [c] = await db.select({ id: clients.id }).from(clients).limit(1);
  actorId = u!.id;
  clientId = c!.id;
  lot.none = await mint('клавиатура');
  lot.one = await mint('клавиатура');
  lot.three = await mint('клавиатура');
  lot.twenty = await mint('клавиатура');
  lot.torn = await mint('клавиатура');
  lot.gap = await mint('клавиатура');
  lot.noRu = await mint(null);
  await compose(lot.one, [{ seq: 1, name: 'Мышь' }]);
  await compose(lot.three, THREE);
  await compose(lot.twenty, TWENTY);
  await compose(lot.torn, []);
  await compose(lot.gap, [
    { seq: 4, name: 'Вторая' },
    { seq: 2, name: 'Первая' },
  ]);
  await compose(lot.noRu, THREE);
  lot.sameZh = await mint('клавиатура');
  lot.sameZhNoRu = await mint(null);
  lot.zhFirst = await mint(null);
  // «Bitta tovar» on a lot typed in Chinese: the line is the Chinese name
  // (spaced and cased as a person might retype it).
  await compose(lot.sameZh, [{ seq: 1, name: `  ${ZH.toUpperCase().replace(' ', '   ')} ` }]);
  await compose(lot.sameZhNoRu, [{ seq: 1, name: ZH }]);
  await compose(lot.zhFirst, [
    { seq: 1, name: ZH },
    { seq: 2, name: 'Мышь' },
  ]);
});

afterAll(async () => {
  const ids = Object.values(lot).filter(Boolean);
  if (ids.length > 0) await db.delete(lotCompositions).where(inArray(lotCompositions.lotId, ids));
  await removeStamped(receiptIds);
});

describe('the shown Russian name — SQL and its pure twin', () => {
  it('no tarkib: the lot’s own name, as before', async () => {
    expect(await shown(lot.none)).toEqual({ ru: 'клавиатура', goods: 'клавиатура', stored: 'клавиатура' });
  });

  it('one line: its name stands where the Russian name is shown (item 3) — the stored name does not move', async () => {
    expect(await shown(lot.one)).toEqual({ ru: 'Мышь', goods: 'Мышь', stored: 'клавиатура' });
    expect(pure([{ seq: 1, name: 'Мышь' }])).toBe('Мышь');
  });

  it('several lines: «first +N» (item 4), equal to the pure rule at 3 and at 20 lines', async () => {
    expect((await shown(lot.three)).ru).toBe('Клавиатура +2');
    expect((await shown(lot.three)).ru).toBe(pure(THREE));
    expect((await shown(lot.twenty)).ru).toBe('Товар 1 +19');
    expect((await shown(lot.twenty)).ru).toBe(pure(TWENTY));
    expect((await shown(lot.three)).stored).toBe('клавиатура');
  });

  it('a header with NO lines is no tarkib: the own name shows (the readers’ torn-header guard)', async () => {
    expect(await shown(lot.torn)).toEqual({ ru: 'клавиатура', goods: 'клавиатура', stored: 'клавиатура' });
    expect(pure([])).toBeNull();
  });

  it('lines that do not start at 1: the LOWEST seq is the first, in SQL as in the pure rule', async () => {
    const label = pure([
      { seq: 4, name: 'Вторая' },
      { seq: 2, name: 'Первая' },
    ]);
    expect(label).toBe('Первая +1');
    expect((await shown(lot.gap)).ru).toBe(label);
  });

  it('a ONE-line tarkib that only repeats the lot’s Chinese name is no label — never «键盘 (键盘)» — in SQL as in the pure rule', async () => {
    // With a Russian name of its own the lot goes on showing it; with none, none.
    expect(await shown(lot.sameZh)).toEqual({ ru: 'клавиатура', goods: 'клавиатура', stored: 'клавиатура' });
    expect(await shown(lot.sameZhNoRu)).toEqual({ ru: null, goods: ZH, stored: null });
    expect(pure([{ seq: 1, name: `  ${ZH.toUpperCase().replace(' ', '   ')} ` }])).toBeNull();
    // Two lines are a label even when the first repeats the Chinese name.
    expect((await shown(lot.zhFirst)).ru).toBe(`${ZH} +1`);
    expect(
      pure([
        { seq: 1, name: ZH },
        { seq: 2, name: 'Мышь' },
      ]),
    ).toBe(`${ZH} +1`);
    // The whole-row reader agrees: no entry for the two, one for the third.
    const map = await lotRuShownFor([lot.sameZh, lot.sameZhNoRu, lot.zhFirst]);
    expect([...map]).toEqual([[lot.zhFirst, `${ZH} +1`]]);
  });

  it('a lot with no Russian name of its own shows the label; the `ru || zh` reader prints it before the Chinese', async () => {
    expect(await shown(lot.noRu)).toEqual({ ru: 'Клавиатура +2', goods: 'Клавиатура +2', stored: null });
    // …and with neither a tarkib nor a Russian name, the Chinese one.
    await db.update(receiptLots).set({ productNameRu: '  ' }).where(eq(receiptLots.id, lot.none));
    expect((await shown(lot.none)).goods).toBe(ZH);
    await db.update(receiptLots).set({ productNameRu: 'клавиатура' }).where(eq(receiptLots.id, lot.none));
  });

  it('legal in a grouped select that groups by the lot — the stock table’s shape', async () => {
    const rows = (await db.execute(sql`
      SELECT l.id, count(*)::int AS n, ${lotRuShownSql(sql`l`)} AS ru
        FROM boxes b JOIN receipt_lots l ON l.id = b.lot_id
       WHERE l.id IN (${sql.join(
         [lot.one, lot.three].map((id) => sql`${id}::uuid`),
         sql`, `,
       )})
       GROUP BY l.id
    `)) as unknown as { id: string; n: number; ru: string }[];
    expect(new Map(rows.map((r) => [r.id, `${r.n}|${r.ru}`]))).toEqual(
      new Map([
        [lot.one, '2|Мышь'],
        [lot.three, '2|Клавиатура +2'],
      ]),
    );
  });

  it('lotRuShownFor: only the lots that HAVE a tarkib, one statement, garbage ids ignored', async () => {
    const map = await lotRuShownFor([...Object.values(lot), 'not-a-uuid']);
    expect(map.get(lot.one)).toBe('Мышь');
    expect(map.get(lot.three)).toBe('Клавиатура +2');
    expect(map.get(lot.gap)).toBe('Первая +1');
    expect(map.has(lot.none)).toBe(false);
    expect(map.has(lot.torn)).toBe(false);
    expect(await lotRuShownFor([])).toEqual(new Map());
  });

  it('a cleared tarkib gives the own name back by itself — nothing was ever written to restore', async () => {
    await db.delete(lotCompositions).where(eq(lotCompositions.lotId, lot.one));
    expect(await shown(lot.one)).toEqual({ ru: 'клавиатура', goods: 'клавиатура', stored: 'клавиатура' });
    await compose(lot.one, [{ seq: 1, name: 'Мышь' }]);
  });
});

describe('a tarkib with no document (0143) is still a tarkib to its reader', () => {
  it('compositionsFor returns it, `attachment` null — an inner join on the file dropped it from the card', async () => {
    const view = (await compositionsFor([lot.three])).get(lot.three);
    expect(view?.lines.map((l) => l.name)).toEqual(['Клавиатура', 'Мышь', 'Наушники']);
    expect(view?.attachment).toBeNull();
  });
});

describe('search finds a lot by ANY line of its tarkib', () => {
  const find = async (needle: string): Promise<string[]> => {
    const rows = await db
      .select({ id: receiptLots.id })
      .from(receiptLots)
      .where(
        sql`${receiptLots.id} IN (${sql.join(
          Object.values(lot).map((id) => sql`${id}::uuid`),
          sql`, `,
        )}) AND ${tarkibLineMatchSql(sql`${receiptLots}`, `%${needle}%`)}`,
      );
    return rows.map((r) => r.id).sort();
  };

  it('«науш» is the THIRD line of two lots and no stored name of either', async () => {
    expect(await find('науш')).toEqual([lot.three, lot.noRu].sort());
  });

  it('a word no line says finds nothing; the lot’s own stored name is not this arm’s business', async () => {
    expect(await find('клавиатура-которой-нет')).toEqual([]);
    // «клавиатура» is the stored name of lot.none, which has no tarkib: this
    // arm does not match it — the screen's own zh/ru predicate does.
    expect(await find('клавиатура')).not.toContain(lot.none);
  });
});
