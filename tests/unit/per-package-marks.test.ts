import { describe, expect, it } from 'vitest';
import { measureCandidates, type ChatMessage } from '@/modules/wms/agent/context';
import { sizeOwnerUnknown } from '@/modules/wms/calc/carton-math';
import { parseManualFacts, readGoodsLines } from '@/modules/wms/calc/intake-manual';
import { parseTableAnswer, type TableRef } from '@/modules/wms/calc/line-address';
import { parseGoodsLine } from '@/modules/wms/calc/units';

/**
 * docs/AI-SORAYDI.md §3.1 T4 / T6 as sellers actually write the marks — the
 * review of release 1a as built (cluster «per-package marks and sizes»,
 * docs/AI-SORAYDI-REVIEW.md JN-7, JN-8, JN-11, JS-1, JS-2, JS-24 binding).
 * Each block names the finding it pins; every figure is worked by hand in the
 * comment beside it, never asked of the code (#166).
 */

/** The shipment's two totals as the typed reader states them. */
const totals = (text: string) => {
  const f = parseManualFacts(text, 'podklyuch');
  return { kg: f.weightKg ?? null, m3: f.volumeM3 ?? null };
};
const none = { kg: null, m3: null };

/** The one typed goods row a line gives. */
const row = (text: string) => {
  const goods = readGoodsLines(text);
  expect(goods, text).toHaveLength(1);
  return goods[0]!;
};

function msg(body: string): ChatMessage {
  return {
    ref: '#1',
    id: '00000000-0000-4000-8000-000000000001',
    tgMessageId: 1n,
    direction: 'in',
    body,
    media: null,
    fileName: null,
    sentAt: new Date('2026-11-12T10:00:00Z'),
    autoSent: false,
    editedAt: null,
  };
}
/** The AI sotuvchi's weight and cube references of ONE inbound message. */
const references = (body: string) => measureCandidates([msg(body)]).map(({ kind, value }) => ({ kind, value }));

describe('owner-1 — «1 ta karobka», «1 karobka = 15 kg», «1ctn=15kg» are ONE carton’s, beside another carton count', () => {
  it('the Uzbek counter «ta» after the «1»: 20 × 0.12 = 2.4 m³ on the row, no 0.12 m³ total', () => {
    // Was the shipment's 0.12 m³ under ✅ — one carton's cube pricing the road.
    // (The 300 kg is the one line's own, the shipment's as it always was.)
    expect(totals('Kurtka 300 dona, 300 kg, 20 ta karobka, 1 ta karobka 0.12 kub')).toEqual({ ...none, kg: 300 });
    expect(row('Kurtka 300 dona, 300 kg, 20 ta karobka, 1 ta karobka 0.12 kub')).toMatchObject({
      name: 'Kurtka',
      quantity: 300,
      weightKg: 300,
      volumeM3: 2.4,
    });
    // 20 × 15 = 300 kg.
    expect(totals('Kurtka 300 dona, 20 karobka, 1 ta karobka 15 kg')).toEqual(none);
    expect(row('Kurtka 300 dona, 20 karobka, 1 ta karobka 15 kg')).toMatchObject({ weightKg: 300 });
    expect(row('Kurtka 300 dona, 20 ta quti, 1 ta quti 15 kg')).toMatchObject({ name: 'Kurtka', weightKg: 300 });
    // The Uzbek Cyrillic «қути» — «кути» was a carton word of WORDS, the right spelling was not:
    // «20 та қути» read as 20 PIECES. 20 × 15 = 300 kg.
    expect(row('Куртка 300 дона, 20 та қути, 1 та қути 15 кг')).toMatchObject({ name: 'Куртка', quantity: 300, weightKg: 300 });
  });

  it('«=» between the mark and its figure, Latin and Cyrillic, and the «=» leaves the name', () => {
    // 20 × 15 = 300 kg; 20 × 0.6 × 0.4 × 0.5 = 2.4 m³.
    expect(totals('Kurtka 300 dona, 20 karobka, 1 karobka = 15 kg, karobka o‘lchami 60x40x50 sm')).toEqual(none);
    expect(row('Kurtka 300 dona, 20 karobka, 1 karobka = 15 kg, karobka o‘lchami 60x40x50 sm')).toMatchObject({
      name: 'Kurtka',
      quantity: 300,
      weightKg: 300,
      volumeM3: 2.4,
    });
    expect(totals('Куртка 300 шт, 20 коробок, 1 коробка = 15 кг, размер коробки 60х40х50 см')).toEqual(none);
    expect(row('Куртка 300 шт, 20 коробок, 1 коробка = 15 кг, размер коробки 60х40х50 см')).toMatchObject({
      name: 'Куртка',
      weightKg: 300,
      volumeM3: 2.4,
    });
    // English: 20 × 0.12 = 2.4 m³; 20 × 15 = 300 kg.
    expect(row('Stul 40 pcs, 20 ctns, 1 ctn = 0.12 cbm')).toMatchObject({ name: 'Stul', quantity: 40, volumeM3: 2.4 });
    expect(row('Stul 40 pcs, 20 cartons, one carton = 15 kg')).toMatchObject({ name: 'Stul', weightKg: 300 });
  });

  it('a «1» welded to its noun: «1ctn=15kg», «1箱 15kg» — 20 × 15 = 300 kg', () => {
    expect(totals('Kurtka 300 dona, 20 ctns, 1ctn=15kg')).toEqual(none);
    expect(row('Kurtka 300 dona, 20 ctns, 1ctn=15kg')).toMatchObject({ name: 'Kurtka', weightKg: 300 });
    expect(row('折叠椅 200个 20箱 1箱 15kg')).toMatchObject({ name: '折叠椅', quantity: 200, weightKg: 300 });
  });

  it('ALONE the «1 ta karobka» is the count — one carton of 15 kg is the line’s 15 kg, as it always was', () => {
    expect(totals('Stul 1 ta karobka 15 kg')).toEqual({ ...none, kg: 15 });
    expect(totals('Stul 1 karobka 15 kg')).toEqual({ ...none, kg: 15 });
    // A word that only opens with the counter is no mark: «1 tabletka» is no package.
    expect(row('Tabletka 1 tabletka 0.5 kg 20 karobka')).toMatchObject({ weightKg: 0.5 });
  });

  it('as a totals answer it is one package’s figure — refused in the seller’s words, never «umumiy hajm 0.12»', () => {
    const table: TableRef = {
      rows: [{ no: 1, index: 0, seq: null, name: 'Kurtka', needs: [] }],
      open: [{ totals: 'volumeM3' }],
      preferred: [{ totals: 'volumeM3' }],
      stage: 'review',
    };
    const [only] = parseTableAnswer('jami 20 ta karobka, 1 ta karobka 0.12 kub', table).segments;
    expect(only).toMatchObject({ totals: null, refused: { reason: 'totals_unit', left: [{ why: 'per_one', text: '1 ta karobka 0.12 kub' }] } });
  });

  it('the AI sotuvchi gets no reference from one carton’s figure (T16)', () => {
    expect(references('stul 20 ta karobka, 1 ta karobka 0.12 kub')).toEqual([]);
    expect(references('stul 20 karobka, 1 karobka = 0.12 kub')).toEqual([]);
    expect(references('stul 20 ctns, 1ctn=15kg')).toEqual([]);
    // The control the review ran: the bare form was already none.
    expect(references('stul 20 karobka, 1 karobka 0.12 kub')).toEqual([]);
  });
});

describe('owner-2 / crit-3 / crit-4 — what ONE carton holds, in every form JN-8 (b) names (20 × 24 = 480, 20 × 25 = 500)', () => {
  it('owner-2: «1 karobkada 24 dona» beside «20 karobka» is 480 — never the row’s 24 (a 20× customs error under ✅)', () => {
    // The line was set aside «1 karobkada» as a pair and kept «24 dona» as the row's own count.
    for (const text of ['Ruchka 20 karobka, 1 karobkada 24 dona', 'Ruchka 20 karobka 1 karobkada 24 dona', 'Ruchka 20 karobka, 1 ta karobkada 24 dona']) {
      const r = row(text);
      expect(r, text).toMatchObject({ name: 'Ruchka', quantity: 480, note: null });
      expect(r.packing, text).toMatchObject({ cartons: 20, pcsPerCarton: 24 });
    }
    expect(row('Ruchka 20 ta quti, 1 qutida 24 dona')).toMatchObject({ quantity: 480 });
  });

  it('crit-3: «в каждой коробке» / «в 1 коробке» / «в каждом месте» — the line no longer vanishes', () => {
    // Was []: no row, no packing, no note — and the seller asked for everything he typed.
    for (const text of [
      'Кукла 20 мест, в каждой коробке 25 шт',
      'Кукла 20 мест, в 1 коробке 25 шт',
      'Кукла 20 мест, в каждом месте 25 шт',
      'Кукла 20 мест, в одной коробке 25 шт',
    ]) {
      const r = row(text);
      expect(r, text).toMatchObject({ name: 'Кукла', quantity: 500 });
      expect(r.packing, text).toMatchObject({ cartons: 20, pcsPerCarton: 25 });
    }
    for (const text of ['Ручка 20 коробок, в каждой коробке 24 шт', 'Ручка 20 коробок в каждой коробке 24 шт']) {
      expect(row(text), text).toMatchObject({ name: 'Ручка', quantity: 480 });
    }
  });

  it('crit-4: the other two forms the ruling names — «в коробке по 25 шт», «25 шт в каждой коробке»', () => {
    expect(row('Кукла 20 мест, в коробке по 25 шт')).toMatchObject({ name: 'Кукла', quantity: 500 });
    expect(row('Кукла 20 мест, 25 шт в каждой коробке')).toMatchObject({ name: 'Кукла', quantity: 500 });
  });

  it('a WEIGHT in one carton: «в каждой коробке 15 кг» — 20 × 15 = 300 kg on the row, no 15 kg total, nothing more asked of the goods', () => {
    expect(row('Stul 20 мест, в каждой коробке 15 кг')).toMatchObject({ name: 'Stul', weightKg: 300 });
    expect(totals('Stul 20 мест, в каждой коробке 15 кг')).toEqual(none);
  });

  it('JN-8 (b) unchanged: «Кукла в коробке» is the product’s own box — 500 pieces, nothing multiplied', () => {
    const r = row('Кукла в коробке 500 шт, 20 мест');
    expect(r).toMatchObject({ name: 'Кукла в коробке', quantity: 500 });
    expect(r.packing ?? null).toBeNull();
  });
});

describe('doors-1 — a per-carton cube’s own unit and tail are no label of the NEXT figure', () => {
  it('«0.12 cbm/ctn 300 kg»: 20 × 0.12 = 2.4 m³, and the 300 kg is the line’s own — never 20 × 300 = 6 000', () => {
    for (const text of [
      'Kurtka 20 karobka 0.12 cbm/ctn 300 kg',
      'Stul 20 ctns 0.12 cbm/ctn 300 kgs',
      'Stul 20 ctn, 0.12 cbm/ctn 300 kg',
      'Kurtka 20 karobka 0.12 kub/karobka 300 kg',
      'Kurtka 20 karobka 0.12 куб/кор 300 kg',
      'Stul 20 мест 0.12 м3/место 300 кг',
      '椅子 20箱 0.12立方/箱 300kg',
    ]) {
      const r = row(text);
      expect(r, text).toMatchObject({ weightKg: 300, volumeM3: 2.4 });
      expect(r.packing, text).toMatchObject({ cartons: 20, m3PerCarton: 0.12, kgPerCarton: null });
    }
  });

  it('«Stol 10 ctn 1.2 cbm/ctn 150 kg 12 cbm»: 150 kg the line’s, 12 m³ stated and agreeing with 10 × 1.2', () => {
    // Was 1 500 kg, the volume empty and «1.2 cbm/ctn, 12 cbm» sent to the note.
    expect(row('Stol 10 ctn 1.2 cbm/ctn 150 kg 12 cbm')).toMatchObject({ name: 'Stol', weightKg: 150, volumeM3: 12, note: null });
  });

  it('a REAL label with its tail still heads its figure: «G.W./CTN: 15 kg» — 20 × 15 = 300 kg', () => {
    expect(row('Kurtka 20 karobka G.W./CTN: 15 kg')).toMatchObject({ weightKg: 300 });
    expect(row('Stul 20 ctns, CBM/CTN: 0.12 cbm')).toMatchObject({ volumeM3: 2.4 });
  });

  it('the same mark’s neighbours: «Weight per carton: 15 kg» and «вес брутто на 1 место 15 кг» — 20 × 15 = 300 kg', () => {
    // «Weight per carton: 15 kg» was the shipment's 15 kg — the example LABEL_LEAD's own comment names.
    expect(totals('Stul 20 ctns, Weight per carton: 15 kg')).toEqual(none);
    expect(row('Stul 20 ctns, Weight per carton: 15 kg')).toMatchObject({ name: 'Stul', weightKg: 300 });
    expect(row('Stul 20 ctns, wt. per ctn 15 kg')).toMatchObject({ weightKg: 300 });
    // «на 1 место»'s own «1» was taken for a second carton count: 20 and 1 differ, so no count, no product.
    expect(row('Stul 20 мест, вес брутто на 1 место 15 кг')).toMatchObject({ weightKg: 300 });
    // A bare «weight» stays no label-first total (JN-21): nothing read from «Weight: 300».
    expect(totals('Weight: 300')).toEqual(none);
  });
});

describe('crit-1 — a sack, a crate, a roll, a bale are packages: one of them is never the shipment’s brutto', () => {
  it('«N <package> по X кг» / «X kg dan» / «X kg/bag» — the row weighs N × X, and no total is stated', () => {
    for (const [text, name, kg] of [
      ['Цемент 20 мешков по 50 кг', 'Цемент', 1000], // 20 × 50
      ['Стул 20 ящиков по 15 кг', 'Стул', 300], // 20 × 15
      ['Стул 20 упаковок по 15 кг', 'Стул', 300],
      ['Ткань 20 рулонов по 30 кг', 'Ткань', 600], // 20 × 30
      ['Стул 20 тюков по 30 кг', 'Стул', 600],
      ['Mato 20 rulon 30 kg dan', 'Mato', 600],
      ['Sement 20 meshok 50 kg dan', 'Sement', 1000],
      ['Olma 20 yashik 30 kg dan', 'Olma', 600],
      ['Sement 20 bags, 50 kg/bag', 'Sement', 1000],
      ['Cement 20 sacks, each 50 kg', 'Cement', 1000],
      ['Куртка 300 дона, 20 қути, 1 қути 15 кг', 'Куртка', 300],
    ] as const) {
      expect(totals(text), text).toEqual(none);
      expect(row(text), text).toMatchObject({ name, weightKg: kg });
    }
    // The controls of the finding, as before.
    expect(row('Стул 20 коробок по 15 кг')).toMatchObject({ name: 'Стул', weightKg: 300 });
    expect(row('Sement 20 qop 50 kg dan')).toMatchObject({ name: 'Sement', weightKg: 1000 });
  });

  it('…and the AI sotuvchi gets no 50 kg reference from one sack', () => {
    expect(references('Цемент 20 мешков по 50 кг')).toEqual([]);
    expect(references('Mato 20 rulon 30 kg dan')).toEqual([]);
  });

  it('beside a count of something no list names, «по» / «dan» still say «each» — no total, the words on the note', () => {
    expect(totals('Ткань 20 штабелей по 30 кг')).toEqual(none);
    expect(row('Ткань 20 штабелей по 30 кг')).toMatchObject({ weightKg: null, note: 'sotuvchi: по 30 кг' });
    expect(totals('Mato 20 tugun 30 kg dan')).toEqual(none);
    expect(row('Mato 20 tugun 30 kg dan')).toMatchObject({ weightKg: null, note: 'sotuvchi: 30 kg dan' });
    // JN-8 (a) stands: «dan» before «ortiq» is «more than», and alone it marks nothing.
    expect(totals('jami 500 kg dan ortiq')).toEqual({ ...none, kg: 500 });
    expect(totals('500 kg dan')).toEqual({ ...none, kg: 500 });
  });

  it('a package noun that IS the product, or a package count nothing multiplies, keeps its old reading', () => {
    expect(row('Мешок 500 шт')).toMatchObject({ name: 'Мешок', quantity: 500 });
    expect(row('Ящик 20 шт 5 кг')).toMatchObject({ name: 'Ящик', quantity: 20, weightKg: 5 });
    // No package's figure: the count stays where it always stood — in the name, or on the note.
    expect(row('Ткань 20 рулонов, 600 кг')).toMatchObject({ name: 'Ткань 20 рулонов', weightKg: 600 });
    expect(row('Kurtka 300 dona 150 kg 5 meshok')).toMatchObject({ name: 'Kurtka', weightKg: 150, note: 'sotuvchi: 5 meshok' });
  });

  it('a carton figure INSIDE a mark is the mark’s own «1» — the line keeps its 20', () => {
    // 20 × 15 = 300 kg each time; 20 × 25 = 500 pieces.
    expect(row('Stul 20 мест, вес 1 коробки 15 кг')).toMatchObject({ weightKg: 300 });
    expect(row('Кукла 20 мест, 25 шт в 1 коробке')).toMatchObject({ quantity: 500 });
  });
});

describe('owner-4 — a package noun opening its clause right before the size says whose the size is (JS-2)', () => {
  it('«…, 20 karobka, karobka 60x40x50 sm» — 20 × 0.6 × 0.4 × 0.5 = 2.4 m³, the noun out of the name', () => {
    // Was «Kurtka karobka», of: null, no cube — and the seller told to work the cube out himself.
    for (const [text, name] of [
      ['Kurtka 300 dona, 20 karobka, karobka 60x40x50 sm', 'Kurtka'],
      ['Куртка 300 шт, 20 коробок по 15 кг, коробка 60х40х50 см', 'Куртка'],
      ['Stul 40 pcs, 20 cartons, carton 60x40x50 cm', 'Stul'],
      ['Stul 40 dona, 20 ctns, ctn 60*40*50cm', 'Stul'],
      ['Kurtka 300 dona, 20 ta quti, quti: 60x40x50 sm', 'Kurtka'],
      ['Куртка 300 дона, 20 қути, қути 60х40х50 см', 'Куртка'],
      ['折叠椅 200个, 20箱, 箱 60*40*50cm', '折叠椅'],
    ] as const) {
      const r = row(text);
      expect(r, text).toMatchObject({ name, volumeM3: 2.4 });
      expect(r.packing?.size, text).toMatchObject({ l: 60, w: 40, h: 50, of: 'package' });
    }
    // 20 × 15 = 300 kg beside it.
    expect(row('Куртка 300 шт, 20 коробок по 15 кг, коробка 60х40х50 см')).toMatchObject({ weightKg: 300 });
  });

  it('a noun at the head of the LINE is the goods’ name — the size after the name stays nobody’s, asked', () => {
    for (const text of ['Корзина 60x40x50 см, 20 коробок', 'Karobka 60x40x50 sm, 20 karobka', 'Stol 120x80x75, 10 karobka']) {
      const r = row(text);
      expect(r.packing?.size?.of, text).toBeNull();
      expect(r.volumeM3, text).toBeNull();
    }
  });
});

describe('figures-size-owner-after-per-carton-tail — a per-carton tail’s noun is no «carton size» label (JN-11)', () => {
  it('a spec block’s «G.W.: 15 kg/ctn» then «Size:» — the size is nobody’s said: kept, asked, never 20 × it', () => {
    // Was of: 'package' and 2.4 m³ «hisoblangan» with no question — and if it is the chair's own size it is 24 m³.
    for (const text of [
      'Product: folding chair\nQty: 200 pcs\nCartons: 20\nG.W.: 15 kg/ctn\nSize: 60*40*50cm',
      'Наименование: стул складной\nКоличество: 200 шт\nМест: 20\nВес: 15 кг/кор\nРазмер: 60x40x50 см',
      '品名 折叠椅\n数量 200\n箱数 20\n毛重 15kg/箱\n尺寸 60*40*50cm',
      'Nomi: stul\nSoni: 200 dona\nKarobka soni: 20\nVazni: 15 kg/karobka\nO‘lchami: 60x40x50 sm',
      'Stul 200 dona 20 karobka 15 kg/karobka razmeri 60x40x50 sm',
      'folding chair 200 pcs 20 ctns 15 kg/ctn size 60*40*50cm',
    ]) {
      const r = row(text);
      expect(r.volumeM3, text).toBeNull();
      expect(r.packing?.size, text).toMatchObject({ l: 60, w: 40, h: 50, of: null });
      // The owner is asked: 20 cartons, a size, nobody's said.
      expect(sizeOwnerUnknown(r.packing), text).toBe(true);
      // The carton's weight still multiplies: 20 × 15 = 300 kg.
      expect(r.weightKg, text).toBe(300);
    }
  });

  it('a label that SAYS the carton still says so after the tail — «Carton size:», «外箱尺寸», «, karobka o‘lchami»', () => {
    for (const text of [
      'Product: folding chair\nQty: 200 pcs\nCartons: 20\nG.W.: 15 kg/ctn\nCarton size: 60*40*50cm',
      '品名 折叠椅\n数量 200\n箱数 20\n毛重 15kg/箱\n外箱尺寸 60*40*50cm',
      'Stul 200 dona 20 karobka 15 kg/karobka, karobka o‘lchami 60x40x50 sm',
      'Stul 20 karobka razmeri 60x40x50 sm',
    ]) {
      // 20 × 0.6 × 0.4 × 0.5 = 2.4 m³.
      expect(row(text), text).toMatchObject({ volumeM3: 2.4 });
    }
  });
});

describe('figures-pair-steals-thousands — a tiny «2 x 1» before a three-digit group is no sheet', () => {
  const oneRow: TableRef = {
    rows: [{ no: 1, index: 0, seq: null, name: 'Stanok', needs: ['kg'] }],
    open: [{ line: 1 }, { totals: 'weightKg' }],
    preferred: [{ line: 1 }, { totals: 'weightKg' }],
    stage: 'review',
  };

  it('«Stanok 2 x 1 500 kg» never lands 500 kg — a figure neither reading gives (2 × 1 500, or a 2×1 thing of 500)', () => {
    for (const text of ['Stanok 2 x 1 500 kg', 'Generator 3 x 1 200 kg', 'Mebel 10 x 2 400 kg']) {
      expect(totals(text), text).toEqual(none);
      const r = row(text);
      // The name no longer swallows «2 x 1»; the figure waits on the note, as written.
      expect(r.weightKg, text).toBeNull();
      expect(r.name, text).not.toMatch(/x/u);
      expect(r.note, text).toBe(`sotuvchi: ${text.slice(text.indexOf(' ') + 1)}`);
    }
    expect(row('Kurtka 20 x 1 200 dona')).toMatchObject({ name: 'Kurtka', quantity: null, note: 'sotuvchi: 20 x 1 200 dona' });
    // The bare row kernel (the card form) asks the grouping instead of reading 500.
    const bare = parseGoodsLine('Stanok 2 x 1 500 kg');
    expect(bare.weightKg).toBeNull();
    expect(bare.problems).toContainEqual(expect.objectContaining({ kind: 'ambiguous', text: '1 500' }));
  });

  it('as an answer it is refused like «2 x 1500 kg» — no 500 written onto the row or the total', () => {
    const [addressed] = parseTableAnswer('1: 2 x 1 500 kg', oneRow).segments;
    expect(addressed!.answer).toMatchObject({ kind: 'refused', reason: 'per_one' });
    const [total] = parseTableAnswer('jami 2 x 1 500 kg', oneRow).segments;
    expect(total!.totals).toBeNull();
  });

  it('a real sheet keeps its reading: «Kafel 600x600 500 dona», «Kafel 60x60 1 200 m2», a size before kilos', () => {
    expect(row('Kafel 600x600 500 dona')).toMatchObject({ name: 'Kafel 600x600', quantity: 500 });
    expect(parseGoodsLine('Kafel 60x60 1 200 m2')).toMatchObject({ measureUnit: 'm2', measureQty: 1200 });
    expect(row('stul 20 karobka 60x40x50 300 kg')).toMatchObject({ weightKg: 300, volumeM3: 2.4 });
    // A small sheet with its unit written is a size still.
    expect(row('Oyna 2x3 m 500 dona')).toMatchObject({ quantity: 500 });
  });
});

// Check R1-pair-guard-eats-metre-sizes: the guard above took every unitless
// pair with a side under 5 for a grouped number's head — so a carpet, a tile
// or a mattress measured in METRES beside a three-digit count lost its count
// and its size (and with a decimal side the whole row). A side glued to its
// joiner is joined to a letter or a sign, no group's head (JN-6's mask); a
// decimal side is a length. Only the spaced joiner of whole numbers is the
// doubt of «Stanok 2 x 1 500 kg».
describe('R1 — a metre-sized sheet beside a three-digit count is a size and a count', () => {
  const oneRow: TableRef = {
    rows: [{ no: 1, index: 0, seq: null, name: 'Gilam', needs: ['dona'] }],
    open: [{ line: 1 }],
    preferred: [{ line: 1 }],
    stage: 'review',
  };

  it('a glued pair keeps its size in the name and its count: 100 carpets, 500 m² of tile, 150 шт', () => {
    expect(row('Gilam 2x3 100 dona')).toMatchObject({ name: 'Gilam 2x3', quantity: 100, note: null });
    expect(row('Kafel 2x2 500 m2')).toMatchObject({ name: 'Kafel 2x2', measureUnit: 'm2', measureQty: 500 });
    expect(row('Plitka 3x3 200 m2')).toMatchObject({ name: 'Plitka 3x3', measureQty: 200 });
    expect(row('Oyna 4x6 200 dona')).toMatchObject({ name: 'Oyna 4x6', quantity: 200 });
    expect(row('Shurup 4x40 500 dona')).toMatchObject({ name: 'Shurup 4x40', quantity: 500 });
    expect(row('Kovyor 2x3 200 ta')).toMatchObject({ name: 'Kovyor 2x3', quantity: 200 });
    expect(row('Ковер 2х3 150 шт')).toMatchObject({ name: 'Ковер 2х3', quantity: 150 });
    expect(row('Gilam 2*3 100 dona')).toMatchObject({ name: 'Gilam 2*3', quantity: 100 });
    expect(row('Gilam 2×3 100 dona')).toMatchObject({ name: 'Gilam 2×3', quantity: 100 });
    expect(row('Gilam 2x3 100 dona 500 kg')).toMatchObject({ quantity: 100, weightKg: 500 });
  });

  it('a decimal side is a length: the row stays, with its count', () => {
    expect(row('Matras 1.6x2 100 dona')).toMatchObject({ name: 'Matras 1.6x2', quantity: 100 });
    expect(row('Matras 2x1.6 100 dona')).toMatchObject({ name: 'Matras 2x1.6', quantity: 100 });
    expect(row('Gilam 1.5x2 300 dona')).toMatchObject({ quantity: 300 });
    expect(row('Ковер 1,5х2 300 шт')).toMatchObject({ quantity: 300 });
    expect(row('Samorez 4,2x16 100 kg')).toMatchObject({ weightKg: 100 });
  });

  it('as the answer to the row it writes the count: «1: 2x3 100 dona» → 100', () => {
    const [seg] = parseTableAnswer('1: 2x3 100 dona', oneRow).segments;
    expect(seg!.answer).toMatchObject({ kind: 'figures', figures: { quantity: 100 } });
  });

  it('a SPACED joiner of whole numbers is the doubt still: «Gilam 2 x 3 100 dona» reads like «Stanok 2 x 1 500 kg»', () => {
    expect(row('Gilam 2 x 3 100 dona')).toMatchObject({ name: 'Gilam', quantity: null, note: 'sotuvchi: 2 x 3 100 dona' });
    expect(row('Stanok 2 x 1 500 kg')).toMatchObject({ weightKg: null });
  });
});

describe('crit-2 — JN-8 (c), binding: a bare «A x B unit» gives the product, and A is no carton count', () => {
  it('«Stul 20 x 15 kg» weighs 20 × 15 = 300 kg; «Kurtka 20*24 dona» counts 20 × 24 = 480 — the phrase stays on the note', () => {
    expect(row('Stul 20 x 15 kg')).toMatchObject({ name: 'Stul', weightKg: 300, note: 'sotuvchi: 20 x 15 kg' });
    expect(row('Kurtka 20*24 dona')).toMatchObject({ name: 'Kurtka', quantity: 480, note: 'sotuvchi: 20*24 dona' });
    expect(row('Kurtka 20x24 dona')).toMatchObject({ quantity: 480 });
    // The other scripts' joiners: the Cyrillic «х», the sign «×», the asterisk.
    expect(row('Stul 20 х 15 кг')).toMatchObject({ weightKg: 300 });
    expect(row('Стул 20 × 15 кг')).toMatchObject({ weightKg: 300 });
    expect(row('椅子 20*15kg')).toMatchObject({ weightKg: 300 });
    // 20 × 0.12 = 2.4 m³; 2 × 1 500 = 3 000 kg.
    expect(row('Stul 20 x 0.12 kub')).toMatchObject({ volumeM3: 2.4 });
    expect(row('Stanok 2 x 1500 kg')).toMatchObject({ weightKg: 3000 });
    // A pair unit goes to the measure: 20 × 12 = 240 juft; 10 × 12 = 120 m².
    expect(row('Krossovka 20 x 12 juft')).toMatchObject({ quantity: null, measureUnit: 'juft', measureQty: 240 });
    expect(row('Kafel 10 x 12 m2')).toMatchObject({ measureUnit: 'm2', measureQty: 120 });
  });

  it('A is no carton count: no packing is built, so nothing else is ever multiplied by it', () => {
    expect(row('Stul 20 x 15 kg').packing ?? null).toBeNull();
    expect(row('Kurtka 20*24 dona').packing ?? null).toBeNull();
    // With a carton word A IS the count — the packing path, as before: 20 × 15 = 300 kg.
    expect(row('Stul 20 karobka x 15 kg').packing).toMatchObject({ cartons: 20, kgPerCarton: 15 });
  });

  it('the product never overrules what the line states, and two of one unit write neither', () => {
    expect(row('Stul 20 x 15 kg 200 kg')).toMatchObject({ weightKg: 200, note: 'sotuvchi: 20 x 15 kg' });
    expect(row('Stul 20 x 15 kg, 10 x 5 kg')).toMatchObject({ weightKg: null });
    // A space-grouped B has two readings (figures-pair-steals-thousands): no product.
    expect(row('Stanok 2 x 1 500 kg')).toMatchObject({ weightKg: null });
  });

  it('the product is the row’s, never a shipment total; the table’s answer grammar is release 1b’s (refused, as before)', () => {
    expect(totals('Stul 20 x 15 kg')).toEqual(none);
    expect(references('Stul 20 x 15 kg')).toEqual([]);
  });
});
