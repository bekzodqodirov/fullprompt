import { describe, expect, it } from 'vitest';
import { parseManualFacts, readGoodsLines } from '@/modules/wms/calc/intake-manual';
import { packingRead, parseGoodsLine } from '@/modules/wms/calc/units';

/**
 * docs/AI-SORAYDI.md §3.1 T12 — a supplier's spec block is ONE good (MP-3,
 * MP-2), with the size owner of review JN-11.
 *
 * With the model silent a forwarded «品名 折叠椅⏎尺寸 60*40*50cm⏎20箱⏎毛重
 * 15kg/箱» was judged line by line: the weight line became a PRODUCT «毛重
 * /箱» of 15 kg, landed through «✅ Tasdiqlash»; the English and Russian
 * blocks gave a figure-less «folding chair» beside a «G.W. /ctn». A name
 * label opens the block now; the count, carton, weight and size lines under
 * it — until a blank line, the next name or a line that is no field — are
 * ITS figures and packing, and the carton arithmetic (carton-math.ts) is the
 * only one that multiplies.
 *
 * Every figure below is worked by hand in the comment beside it.
 */

const row = (text: string) => {
  const goods = readGoodsLines(text);
  expect(goods, text).toHaveLength(1);
  return goods[0]!;
};

describe('T12 — the block is one good, its field lines its figures', () => {
  it('MP-3, the Chinese block: 折叠椅, 20 cartons of 15 kg brutto — 20 × 15 = 300 kg; «尺寸» is nobody’s size, so no cube (JN-11)', () => {
    const r = row('品名 折叠椅\n尺寸 60*40*50cm\n20箱\n毛重 15kg/箱');
    expect(r).toMatchObject({ name: '折叠椅', weightKg: 300, volumeM3: null });
    expect(r.packing).toMatchObject({
      cartons: 20,
      kgPerCarton: 15,
      kgPerCartonKind: 'gross',
      size: { l: 60, w: 40, h: 50, unit: 'cm', of: null },
    });
  });

  it('with the PACKAGE’s size word «外箱尺寸» the cube is computed: 20 × (0.6 × 0.4 × 0.5 = 0.12) = 2.4 m³', () => {
    const r = row('品名 折叠椅\n外箱尺寸 60*40*50cm\n箱数 20\n毛重 15kg/箱');
    expect(r).toMatchObject({ name: '折叠椅', weightKg: 300, volumeM3: 2.4 });
    expect(r.packing).toMatchObject({ cartons: 20, size: { of: 'package' } });
  });

  it('MP-3, the English and Russian blocks: one good of 200 pieces, 300 kg and 2.4 m³ — never a row named after a field', () => {
    for (const text of [
      'Product: folding chair\nQty: 200 pcs\nCartons: 20\nG.W.: 15 kg/ctn\nCarton size: 60*40*50cm',
      'Наименование: стул складной\nКол-во: 200 шт\nМест: 20\nВес брутто: 15 кг/место\nРазмер коробки: 60*40*50 см',
    ]) {
      // 20 cartons × 15 kg = 300 kg; 20 × 0.12 m³ = 2.4 m³; «200 pcs» the count, never the 20 places.
      expect(row(text), text).toMatchObject({ quantity: 200, weightKg: 300, volumeM3: 2.4 });
    }
    expect(row('Product: folding chair\nQty: 200 pcs\nCartons: 20').name).toBe('folding chair');
  });

  it('the same block on ONE line reads the same way', () => {
    expect(row('Product: folding chair Qty: 200 pcs Cartons: 20 G.W.: 15 kg/ctn Carton size: 60*40*50cm')).toMatchObject({
      name: 'folding chair',
      quantity: 200,
      weightKg: 300,
      volumeM3: 2.4,
    });
  });

  it('MP-2, the forwarded line with its name label AFTER the figures: the same good as the block', () => {
    const r = row('尺寸 60*40*50cm 20箱 毛重 15kg/箱 品名 折叠椅');
    expect(r).toMatchObject({ name: '折叠椅', weightKg: 300, volumeM3: null });
    expect(r.packing).toMatchObject({ cartons: 20, kgPerCarton: 15, size: { of: null } });
  });

  it('a block’s per-carton weight is no total; a block’s own total line is the shipment’s, as one goods line’s is', () => {
    // 15 kg is one carton's (MP-2: it landed as the shipment's and the row's).
    expect(parseManualFacts('品名 折叠椅\n尺寸 60*40*50cm\n20箱\n毛重 15kg/箱', 'podklyuch').weightKg ?? null).toBeNull();
    // «总毛重 300kg» states the whole good's brutto; one good IS the shipment.
    const facts = parseManualFacts('品名 折叠椅\n数量 200个\n箱数 20箱\n毛重 15kg/箱\n总毛重 300kg\n体积 2.4立方', 'podklyuch');
    expect(facts).toMatchObject({ weightKg: 300, volumeM3: 2.4 });
    expect(facts.goods).toEqual([expect.objectContaining({ name: '折叠椅', quantity: 200, weightKg: 300, volumeM3: 2.4, weightKind: 'gross' })]);
  });

  it('a field line opening its own line is a field however it is written — «Soni 300» under «Tovar: kurtka»', () => {
    expect(row('Tovar: kurtka\nSoni 300\nVazni 150 kg\nHajmi 3 kub')).toMatchObject({
      name: 'kurtka',
      quantity: 300,
      weightKg: 150,
      volumeM3: 3,
    });
  });
});

// Review owner-3: with the model silent a supplier's block of per-carton
// fields broke — the Chinese one gave two products named «单箱» carrying one
// carton's cube and weight, the English one lost every figure and asked the
// count he typed. A line opening with ONE package's measure label («单箱毛重»,
// «G.W./CTN», «CBM/CTN», «Вес 1 места») is the block's packing; a bare figure
// takes its unit from the label.
describe('T12 — one package’s field lines are the block’s packing (owner-3)', () => {
  it('the Chinese, English and Russian blocks are ONE good: 3000 pieces, 15 × 33.8 = 507 kg, 15 × 0.395 = 5.925 m³', () => {
    for (const text of [
      '品名: LED灯\n数量: 3000个\n箱数: 15箱\n单箱体积: 0.395\n单箱毛重: 33.8kg',
      'Product: LED lamp\nQty: 3000 pcs\nCartons: 15 ctns\nG.W./CTN: 33.8 kg\nCBM/CTN: 0.395',
      'Наименование: LED лампа\nКоличество: 3000 шт\nМест: 15\nВес 1 места: 33.8 кг\nОбъем 1 места: 0.395',
    ]) {
      const r = row(text);
      expect(r, text).toMatchObject({ quantity: 3000, weightKg: 507, volumeM3: 5.925 });
      expect(r.packing, text).toMatchObject({ cartons: 15, kgPerCarton: 33.8, m3PerCarton: 0.395 });
      // One carton's figures are never the shipment's.
      expect(parseManualFacts(text, 'podklyuch'), text).toMatchObject({ weightKg: null, volumeM3: null });
    }
  });

  it('outside a block such a line is no goods line and no total — no product «单箱», no 0.395 m³ shipment', () => {
    for (const line of ['单箱毛重: 33.8kg', '单箱体积: 0.395', '单箱毛重 33.8kg', '每箱体积: 0.12', 'CBM/CTN: 0.395', 'Вес 1 места: 33.8 кг']) {
      expect(readGoodsLines(line), line).toEqual([]);
      expect(parseManualFacts(line, 'podklyuch'), line).toMatchObject({ weightKg: null, volumeM3: null });
    }
    // The shipment's own label still states the shipment.
    expect(parseManualFacts('体积: 5.92', 'podklyuch').volumeM3).toBe(5.92);
    expect(parseManualFacts('毛重: 507', 'podklyuch').weightKg).toBe(507);
  });

  // Check owner-3: the block form worked and the ONE-line form of the same
  // labels did not — «CBM/CTN 0.12» made 0.12 the row's PIECES and «CBM/CTN»
  // a word of its name («Stul CBM/CTN» × 0.12).
  it('the same labels on ONE line: 20 cartons × 15 kg = 300 kg, 20 × 0.12 = 2.4 m³, no count', () => {
    for (const text of [
      'Stul 20 ctns, G.W./CTN 15 kg, CBM/CTN 0.12',
      'Stul 20 ctns, G.W./CTN: 15, CBM/CTN: 0.12',
      'Стул 20 мест, вес 1 места 15 кг, объем 1 места 0.12',
      '椅子 20箱, 单箱毛重 15kg, 单箱体积 0.12',
    ]) {
      const r = row(text);
      expect(r, text).toMatchObject({ quantity: null, weightKg: 300, volumeM3: 2.4 });
      expect(r.name, text).not.toMatch(/CBM|CTN|单箱|объем/iu);
      expect(r.packing, text).toMatchObject({ cartons: 20, kgPerCarton: 15, m3PerCarton: 0.12 });
      expect(parseManualFacts(text, 'podklyuch'), text).toMatchObject({ weightKg: null, volumeM3: null });
    }
  });
});

// Review crit-5 (the completeness critic's; reproduced at 5e97abf): T12's
// labels departed from §2.4 in the sellers' own two languages — «Karobka: 20»
// (a unit word as the label) ended the block, «Количество мест» was eaten by
// the count label «количество», «Вес одного места: 15 кг» read by nobody —
// and the carton count and the per-carton weight vanished with no note.
describe('T12 — the cartons and one place’s weight in Uzbek and Russian (crit-5)', () => {
  it('each block is ONE good: 200 pieces, 20 cartons × 15 kg = 300 kg', () => {
    for (const text of [
      'Nomi: stul\nSoni: 200 dona\nKarobka: 20\nOg‘irligi: 15 kg/karobka',
      'Nomi: stul\nSoni: 200 dona\nQuti: 20\nOg‘irligi: 15 kg/quti',
      'Наименование: стул\nКоличество: 200 шт\nКоличество мест: 20\nВес брутто 15 кг/место',
      'Наименование: стул\nКоличество: 200 шт\nКол-во мест: 20\nВес брутто 15 кг/место',
      'Наименование: стул\nКоличество: 200 шт\nКоробок: 20\nВес одного места: 15 кг',
      'Наименование: стул\nКоличество: 200 шт\nМест: 20\nВес одного места: 15 кг',
    ]) {
      const r = row(text);
      expect(r, text).toMatchObject({ quantity: 200, weightKg: 300 });
      expect(r.packing, text).toMatchObject({ cartons: 20, kgPerCarton: 15 });
      expect(parseManualFacts(text, 'podklyuch').weightKg, text).toBeNull();
    }
  });

  it('a unit word as the label right under the name, a counter after its figure, the next field’s label after a count', () => {
    // 20 cartons × 15 kg = 300 kg; never a product «stul Karobka» × 20.
    for (const text of ['Nomi: stul\nKarobka: 20\nOg‘irligi: 15 kg/karobka', 'Nomi: stul\nKarobka: 20 ta\nOg‘irligi: 15 kg/karobka']) {
      expect(row(text), text).toMatchObject({ name: 'stul', quantity: null, weightKg: 300 });
    }
    // «Soni: 200 Karobka: 20» — «Karobka:» is the next field, not 200's unit.
    expect(row('Nomi: stul\nSoni: 200\nKarobka: 20')).toMatchObject({ name: 'stul', quantity: 200 });
    // «件数» is the count of packages as a label (§2.4).
    expect(row('品名: 折叠椅\n件数: 20\n毛重: 15kg/箱')).toMatchObject({ weightKg: 300 });
  });

  it('on one line the place’s 15 kg is still no shipment total: the carton count stands before its label', () => {
    expect(parseManualFacts('стул Мест: 20 Вес одного места: 15 кг', 'podklyuch').weightKg).toBeNull();
    expect(row('стул Мест: 20 Вес одного места: 15 кг')).toMatchObject({ weightKg: 300 });
    // «Qty: 200 Kg: 150» was 200 kg: «Kg:» is the next field's label, never 200's unit.
    expect(parseManualFacts('Qty: 200 Kg: 150', 'podklyuch').weightKg).not.toBe(200);
  });
});

describe('T12 — where a block ends, and what is no block', () => {
  it('a blank line and the next name label end it: two blocks are two goods, each 300 kg (20 × 15, 10 × 30)', () => {
    const goods = readGoodsLines('品名 折叠椅\n20箱\n毛重 15kg/箱\n\n品名 桌子\n10箱\n毛重 30kg/箱');
    expect(goods.map((g) => [g.name, g.weightKg])).toEqual([
      ['折叠椅', 300],
      ['桌子', 300],
    ]);
  });

  it('a block whose lines read no figured good is read line by line, as it always was', () => {
    // «20 ctns» is a carton count and nothing a table can price (c0649).
    expect(readGoodsLines('Tovar: kurtka\n20 ctns').map((g) => [g.name, g.quantity])).toEqual([['kurtka', null]]);
  });

  it('a name line that says something ABOUT the goods opens nothing — «Tovar: tayyor»', () => {
    expect(readGoodsLines('Tovar: tayyor\nVazni: 150 kg')).toEqual([]);
    expect(parseManualFacts('Tovar: tayyor\nVazni: 150 kg', 'podklyuch').weightKg).toBe(150);
  });

  it('a block NAMES its goods: it still answers when the model read the material and found none (labelledOnly)', () => {
    const block = 'Item: folding chair\nQty: 200 pcs\nCartons: 20\nG.W.: 15 kg/ctn';
    expect(readGoodsLines(block, { labelledOnly: true })).toEqual([
      expect.objectContaining({ name: 'folding chair', quantity: 200, weightKg: 300 }),
    ]);
  });

  it('a field line alone is still no goods line of its own (T3/T4)', () => {
    for (const line of ['毛重 15kg/箱', 'G.W.: 15 kg/ctn', 'Вес брутто 15 кг/место', 'Carton size: 60*40*50cm', '20箱']) {
      expect(readGoodsLines(line), line).toEqual([]);
    }
  });
});

describe('T12 in the kernel — a label before a tail-marked figure, and the size word that names nobody', () => {
  it('«Вес брутто: 15 кг/место» — the tail says one package’s, the label which weight, and neither is a word of the name', () => {
    const line = parseGoodsLine('стул Вес брутто: 15 кг/место 20 мест', { packing: true });
    expect(line.name).toBe('стул');
    expect(line.packing).toMatchObject({ cartons: 20, kgPerCarton: 15, kgPerCartonKind: 'gross' });
    expect(packingRead('折叠椅 毛重 15kg/箱 20箱').figures).toEqual([expect.objectContaining({ unit: 'kg', value: 15, owner: 'package', kind: 'gross' })]);
  });

  it('JN-11: a size word that names nobody’s size is asked even right beside the carton count — and a package’s word still multiplies', () => {
    expect(packingRead('折叠椅 尺寸 60*40*50cm 20箱').size).toMatchObject({ of: null });
    expect(packingRead('Kurtka razmeri 60x40x50 sm 20 karobka').size).toMatchObject({ of: null });
    expect(packingRead('Kurtka karobka razmeri 60x40x50 sm 20 karobka').size).toMatchObject({ of: 'package' });
    // No size word at all, right beside the count: the package's (JS-2), as before.
    expect(packingRead('stul 60x40x50 sm 20 karobka').size).toMatchObject({ of: 'package' });
  });
});

// Review load-1: the field labels of T8/T12 were each written `label GAP [.)]?
// GAP [:：=]? GAP (?=digit)` — three runs of spaces with only optional single
// characters between them, so a label followed by a long stretch of spaces and
// no figure was tried at every split of the stretch: cubic. One Telegram message
// («G.W.» + 4 080 spaces) froze the one app process for ~50 s on the AI sotuvchi's
// path; a spec block's «毛重» + 2 000 spaces cost 23 s. The label-first totals'
// «G.W. kg» + spaces had the same shape. Each optional character now carries its
// own gap — the same language — and the cost is the base's: the known readRoute
// quadratic (~0.1-0.3 s here at 1 500 spaces, the cubic took 2-10 s).
describe('load-1 — a field label followed by a long run of spaces is read without backtracking', () => {
  const spaces = ' '.repeat(1_500);
  it.each([
    ['the line form, a weight label', `Stul 20 dona G.W.${spaces}x`],
    ['the line form, a count label', `Stul 20 dona Qty${spaces}x`],
    ['the line form, a Han label', `Stul 20 dona 毛重${spaces}x`],
    ['the spec block form', `品名 折叠椅\n毛重${spaces}x`],
    ['a label-first total, its unit written', `G.W. kg${spaces}x`],
    ['a label-first cube, its unit written', `Stul 20 dona CBM m3${spaces}x`],
  ])('%s: under a second in both typed readers', (_, text) => {
    let at = performance.now();
    readGoodsLines(text);
    expect(performance.now() - at, 'readGoodsLines').toBeLessThan(1_000);
    at = performance.now();
    parseManualFacts(text, 'podklyuch');
    expect(performance.now() - at, 'parseManualFacts').toBeLessThan(1_000);
  });

  it('the shapes the labels read are read as before — a gap, a dot, a bracket and a colon in every order', () => {
    // 20 cartons × 15 kg = 300 kg in each spelling of the weight's field.
    for (const line of ['Qty: 200 pcs\nCartons: 20\nG.W.: 15 kg/ctn', 'Qty .  :  200 pcs\nCartons: 20\nG.W.) = 15 kg/ctn', 'Qty\t\t: 200 pcs\nCartons: 20\nG.W.\t\t: 15 kg/ctn']) {
      expect(row(`Product: folding chair\n${line}`), line).toMatchObject({ quantity: 200, weightKg: 300 });
    }
    expect(parseManualFacts('G.W. (kg): 507', 'podklyuch').weightKg).toBe(507);
    expect(parseManualFacts('G.W. kg = 507', 'podklyuch').weightKg).toBe(507);
    expect(parseManualFacts('CBM , m3 : 5.92', 'podklyuch').volumeM3).toBe(5.92);
  });
});

// Review load-3: the word after a label's figure (`FIGURE_AT`) was an unbounded
// run of letters, and on Chinese written with no spaces that run is the rest of
// the line — walked again at every label of it, O(L²) a line (32 768 glued
// characters: 1.3 s; bounded: ~70 ms). No unit is longer than 40 characters.
describe('load-3 — a long glued Chinese line is read in linear time', () => {
  it('32 768 characters of «毛重507kg体积5.92立方» under half a second; a 41-letter word after a figure is no unit, as before', () => {
    const unit = '毛重507kg体积5.92立方';
    const glued = unit.repeat(Math.ceil(32_768 / unit.length)).slice(0, 32_768);
    const at = performance.now();
    readGoodsLines(glued);
    expect(performance.now() - at).toBeLessThan(500);
    // «Qty: 200» + a 45-letter word: the word is no unit, so the label gives the figure none — as it never did.
    expect(row(`Product: chair\nQty: 200 ${'a'.repeat(45)}`).quantity).toBeNull();
    expect(row('Product: chair\nQty: 200 pcs').quantity).toBe(200);
  });
});
