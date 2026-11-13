import { describe, expect, it } from 'vitest';
import { parseLineAnswer, parseManualFacts, readGoodsLines } from '@/modules/wms/calc/intake-manual';
import { parseTableAnswer, type TableRef, type TableTarget } from '@/modules/wms/calc/line-address';
import { parseGoodsLine, perOneSpans } from '@/modules/wms/calc/units';
import { measureCandidates, type ChatMessage } from '@/modules/wms/agent/context';

/**
 * The review of P-typed-A as built (docs/AI-SORAYDI.md §3.1; the reviewers'
 * typed-break-1..9 and typed-spec-1..7). Each block is one finding; every
 * literal is the seller's own text or a figure worked by hand in its comment.
 * The corpus carries one case per finding (c3000, c3385-c3399); the spellings
 * beside it live here.
 */

const totals = (text: string, section?: 'podklyuch' | 'rastamojka') => {
  const f = parseManualFacts(text, section ?? 'podklyuch');
  return { kg: f.weightKg ?? null, m3: f.volumeM3 ?? null, asked: f.ambiguous };
};
const none = { kg: null, m3: null, asked: [] };
const rows = (text: string) =>
  readGoodsLines(text).map((g) => ({ name: g.name, q: g.quantity ?? null, kg: g.weightKg ?? null, m3: g.volumeM3 ?? null, note: g.note ?? null }));

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
/** The AI sotuvchi's weight and cube references for one inbound message (agent/context.ts). */
const agent = (body: string) => measureCandidates([msg(body)]).map(({ kind, value }) => ({ kind, value }));

const TOTALS: TableTarget[] = [{ totals: 'weightKg' }, { totals: 'volumeM3' }];
const table = (open: TableTarget[] = TOTALS): TableRef => ({ rows: [], open, preferred: open, stage: 'review' });
const oneRow: TableRef = {
  rows: [{ no: 1, index: 0, seq: null, name: 'Kurtka', needs: ['dona', 'kg'] }],
  open: [{ line: 1 }, ...TOTALS],
  preferred: [{ line: 1 }, ...TOTALS],
  stage: 'review',
};

describe('typed-break-1 — a label-first figure with a per-package tail is no total', () => {
  it('every spelling the reviewer ran: the shipment states nothing, the agent gets no reference', () => {
    for (const text of [
      'G.W.: 15/ctn',
      '毛重: 15/箱',
      'MEAS: 0.12/ctn',
      'CBM: 0.12 /ctn',
      'Brutto: 15/karobka',
      '体积: 0.12/箱',
      'Hajmi: 0.12/karobka',
      '20 karobka\nMEAS: 0.12/ctn',
      'Stul 20 karobka\nG.W.: 15/ctn',
      // A slash and a word the tails do not know is nobody's figure either (JN-8 (e)).
      'Brutto: 15/kor',
    ]) {
      expect(totals(text), text).toEqual(none);
      expect(agent(text), text).toEqual([]);
    }
  });

  it('…while a slash that only separates two fields, or a figure, still lets the label stand', () => {
    // «G.W.: 507 / N.W.: 480» — the brutto and the netto of one line.
    expect(totals('G.W.: 507 / N.W.: 480').kg).toBe(507);
    expect(totals('G.W.: 507').kg).toBe(507);
  });

  it('on ONE line beside the carton count the figure is the row’s packing: 20 × 15 = 300 kg, 20 × 0.12 = 2.4 m³', () => {
    const text = 'Yiwudan, stullar 20 karobka, G.W.: 15/ctn, MEAS: 0.12/ctn';
    expect(totals(text)).toEqual(none);
    expect(readGoodsLines(text)).toMatchObject([{ weightKg: 300, volumeM3: 2.4 }]);
    // The AI sotuvchi priced «below_minimum» and «255 $ (15 kg × 17 $/kg)» off this line: no reference now.
    expect(agent(text)).toEqual([]);
    expect(agent('Yiwudan, stullar 20 karobka, 毛重: 15/箱, 体积: 0.12/箱')).toEqual([]);
  });

  it('at the table the same figure is named as one carton’s, never «jadvalda bunday qator yo‘q»', () => {
    for (const text of ['G.W.: 15/ctn', 'MEAS: 0.12/ctn']) {
      const [seg] = parseTableAnswer(text, table()).segments;
      expect(seg!.totals, text).toBeNull();
      expect(seg!.refused?.reason, text).toBe('totals_unit');
      expect(seg!.refused?.left?.[0]?.why, text).toBe('per_one');
    }
    // To a row: refused as one package's, the row's figure untouched.
    expect(parseLineAnswer('15/ctn')).toEqual({ kind: 'refused', reason: 'per_one', detail: '15/ctn' });
    // A fraction is no tail: «1/2 dyuym» is a size of the name.
    expect(parseLineAnswer('1/2 dyuym 300 dona')).toMatchObject({ kind: 'figures', figures: { quantity: 300 } });
  });
});

describe('typed-break-2 — a product’s own measure label is that product’s, never the cargo’s', () => {
  it('possessed by a name word on its line: the goods row keeps no m³ / kilos from it, the figure goes on the note', () => {
    expect(rows('Avtomobil, dvigatel hajmi: 1.6, 2 dona')).toEqual([
      { name: 'Avtomobil dvigatel hajmi', q: 2, kg: null, m3: null, note: 'sotuvchi: hajmi: 1.6' },
    ]);
    for (const text of ['Dvigatel hajmi: 1.6', 'Bak hajmi: 50', 'Termos hajmi: 2', 'Двигатель объем: 1.6', 'Кастрюля, объём: 5', "Stul og'irligi: 5"]) {
      expect(rows(text).every((r) => r.m3 === null && r.kg === null), text).toBe(true);
      expect(totals(text), text).toEqual(none);
    }
  });

  it('opening its line right under a figureless product name: the product’s spec, no total', () => {
    expect(totals('Termos\nHajmi: 2\n500 dona')).toEqual(none);
    expect(totals('Холодильник LG\nОбъем: 250\nКол-во: 20 шт')).toEqual(none);
    expect(agent('Termos\nHajmi: 2\n500 dona')).toEqual([]);
  });

  it('…and the shipment’s own label still stands: after a figure, the cargo, a totals word, on a line of its own', () => {
    // «Kurtka 300 dona, hajmi: 5» — the label follows a figure with its unit: the row's 5 m³.
    expect(rows('Kurtka 300 dona, hajmi: 5')).toMatchObject([{ name: 'Kurtka', q: 300, m3: 5 }]);
    expect(totals('Yuk hajmi: 12').m3).toBe(12);
    expect(totals('Hajmi: 12').m3).toBe(12);
    // Under a greeting, a route or a header the label is still the shipment's: none of them is a product.
    expect(totals('Assalomu alaykum\nHajmi: 12').m3).toBe(12);
    expect(totals('Yuk ma’lumoti:\nHajmi: 12').m3).toBe(12);
    // A freight list's label names no product's capacity: «Stul\nCBM: 2.4» is the cargo's.
    expect(totals('Stul\nCBM: 2.4').m3).toBe(2.4);
  });
});

describe('typed-break-3 — a gram beside a count is one pack’s, and no truck is weighed in grams', () => {
  it('beside a carton or pack count the gram stays in the name and no total or row weight comes of it', () => {
    for (const text of ['Choy 500 gr 200 karobka', 'Чай 500 гр 200 коробок', 'Kofe 250 gr, 1000 pachka']) {
      expect(totals(text), text).toEqual(none);
      expect(rows(text), text).toEqual([]);
      expect(agent(text), text).toEqual([]);
    }
    // The row kernel alone, for every door: «Choy 500 gr» is the name, 200 the cartons.
    expect(parseGoodsLine('Choy 500 gr 200 karobka', { scaled: true })).toMatchObject({ name: 'Choy 500 gr', weightKg: null, cartons: 200 });
  });

  it('no gram is the shipment’s brutto without a weight’s label — «og‘irligi 500 g» is 500 × 0.001 = 0.5 kg', () => {
    expect(totals('Kofe 250 gr')).toEqual(none);
    expect(totals('Zafaron 500 gr')).toEqual(none);
    expect(totals('og‘irligi 500 g').kg).toBe(0.5);
    // A tonne is still the shipment's: 2 × 1000 = 2000 kg.
    expect(totals('yuk 2 tonna 12 kub')).toEqual({ kg: 2000, m3: 12, asked: [] });
  });
});

describe('typed-break-4 — a grouped number: kept on the note, and whole after a word that owns no count', () => {
  it('after a product’s name it is asked (JN-6), and the seller’s figure goes on the row’s note — never lost', () => {
    expect(rows('Kurtka 1 200 dona')).toEqual([{ name: 'Kurtka', q: null, kg: null, m3: null, note: 'sotuvchi: 1 200 dona' }]);
    expect(rows('Shim 2 500 dona 1 200 kg 15 kub')).toEqual([{ name: 'Shim', q: null, kg: 1200, m3: 15, note: 'sotuvchi: 2 500 dona' }]);
    // The guard: a name word before it is still asked, both readings — 200 or 1 200.
    expect(totals('Mebel 1 200 kg').asked).toEqual([{ field: 'weightKg', text: '1 200', decimal: 200, thousands: 1200 }]);
    expect(rows('Omega 3 200 dona')).toEqual([{ name: 'Omega', q: null, kg: null, m3: null, note: 'sotuvchi: 3 200 dona' }]);
  });

  it('after a place in its route case, a greeting, the cargo itself, an approximator: one number', () => {
    for (const [text, kg] of [
      ['Yiwudan Toshkentga 12 500 kg', 12500],
      ['Andijonga 1 200 kg', 1200],
      ['Assalomu alaykum 1 200 kg yuk bor', 1200],
      ['Yukimiz 1 200 kg', 1200],
      ['Mening yukim 1 200 kg', 1200],
      ['Kargo 1 200 kg', 1200],
      ['Груз весит 1 200 кг', 1200],
      ['Tahminan 1 200 kg', 1200],
      ['approx 1 200 kg', 1200],
      ["Hammasi bo'lib 1 200 kg", 1200],
    ] as const) {
      expect(totals(text), text).toEqual({ kg, m3: null, asked: [] });
      // …and none of those words names a product.
      expect(rows(text), text).toEqual([]);
    }
    expect(totals('Guangzhou - Toshkent 3 500 kg 12 kub')).toEqual({ kg: 3500, m3: 12, asked: [] });
  });
});

describe('typed-break-5 — a counted cube after the line’s first figure is the cargo’s cube', () => {
  it('«kubov», «кубов», «куба» after a count: m³, never a word of the name', () => {
    expect(rows('Kurtka 300 dona 450 kg 5 kubov')).toEqual([{ name: 'Kurtka', q: 300, kg: 450, m3: 5, note: null }]);
    expect(rows('Куртки 300 шт 12 кубов 800 кг')).toEqual([{ name: 'Куртки', q: 300, kg: 800, m3: 12, note: null }]);
    expect(rows('Shim 200 dona 3 куба')).toEqual([{ name: 'Shim', q: 200, kg: null, m3: 3, note: null }]);
    expect(totals('Kurtka 300 dona 450 kg 5 kubov')).toEqual({ kg: 450, m3: 5, asked: [] });
    // To a row: «300 dona 5 kubov» answers both, the cube no longer dropped.
    expect(parseLineAnswer('300 dona 5 kubov')).toMatchObject({ kind: 'figures', figures: { quantity: 300, volumeM3: 5 } });
  });

  it('…and inside the name run, before any figure, the toy’s cubes stay the toy’s (JN-22)', () => {
    expect(rows('Набор 4 кубов 20 шт')).toEqual([{ name: 'Набор 4 кубов', q: 20, kg: null, m3: null, note: null }]);
    expect(totals('Набор 4 кубов 20 шт')).toEqual(none);
  });
});

describe('typed-break-6 — the commonest per-carton spellings', () => {
  it('«each» after the figure binds like «har biri»: 20 × 15 = 300 kg, 20 × 0.12 = 2.4 m³', () => {
    expect(readGoodsLines('Chair 20 ctns, 15 kg each')).toMatchObject([{ name: 'Chair', weightKg: 300 }]);
    for (const text of ['Chair 20 ctns, 15 kg each', '20 cartons, 15 kg each, 0.12 cbm each', '15 kg each, 20 ctns']) {
      expect(totals(text), text).toEqual(none);
      expect(agent(text), text).toEqual([]);
    }
    // «each» with a figure after it leads that figure, and the count before it is the line's own.
    expect(readGoodsLines('Telefon 300 pcs each 0.2 kg')).toMatchObject([{ quantity: 300, weightKg: 60 }]);
  });

  it('a package’s noun possessing the label: one carton’s — 20 × 22.5 = 450 kg', () => {
    for (const text of [
      'Jacket 300 pcs, 20 ctns, carton weight 22.5 kg',
      'Куртка 300 шт, 20 коробок, вес коробки 22.5 кг',
      "Kurtka 300 dona, 20 karobka, karobka og'irligi 22.5 kg",
      'Kurtka 300 dona, 20 karobka, karobka vazni 22.5 kg',
    ]) {
      expect(totals(text), text).toEqual(none);
      const [row] = readGoodsLines(text);
      expect(row, text).toMatchObject({ weightKg: 450 });
      expect(row!.name, text).not.toMatch(/karobka/u);
      // «carton weight» names no netto: the label's «n w» is two words' letters.
      expect(row!.packing?.kgPerCartonKind ?? null, text).toBeNull();
    }
    // A COUNTED noun is all the cartons' — «20 karobka og‘irligi 300 kg» is the line's 300.
    expect(totals("20 karobka og'irligi 300 kg").kg).toBe(300);
  });

  it('a line OPENING with «1 karobka» under the carton count’s line is one carton’s', () => {
    expect(totals('Stul 20 karobka\n1 karobka 15 kg')).toEqual(none);
    // Alone, «1 karobka 15 kg» is one carton of 15 kg — the shipment's, as it always was.
    expect(totals('1 karobka 15 kg').kg).toBe(15);
    // A named line of its own keeps its figures: «Shkaf 1 karobka 15 kg» is that row's.
    expect(perOneSpans('Stul 20 karobka\nShkaf 1 karobka 15 kg')).toEqual([]);
  });
});

describe('typed-break-7 — «dan» that compares or composes is no per-carton mark', () => {
  it('«dan oshmaydi», «dan ziyod emas», «dan katta emas», «dan iborat», and «jami … dan»: the line’s own figure', () => {
    for (const [text, kg, m3] of [
      ['Stul 20 karobka 300 kg dan oshmaydi', 300, null],
      ['20 karobka 300 kg dan oshadi', 300, null],
      ['Kurtka 300 dona 20 karobka, 500 kg dan ziyod emas', 500, null],
      ['Kurtka 20 karobka 5 kub dan katta emas', null, 5],
      ['Stul 20 karobka 300 kg dan iborat', 300, null],
      ['Stul 20 karobka, jami 300 kg dan', 300, null],
      ['yuk 300 kg dan oshmaydi, 20 karobka', 300, null],
    ] as const) {
      expect(totals(text), text).toEqual({ kg, m3, asked: [] });
    }
    // The mark itself, beside a count: one carton's — no total.
    expect(totals('Stul 20 karobka 15 kg dan')).toEqual(none);
  });
});

describe('typed-break-9 — the table’s totals answer', () => {
  it('an un-addressed gram is no brutto: named back, as the base asked', () => {
    for (const text of ['128 g', '500 gr']) {
      const [seg] = parseTableAnswer(text, oneRow).segments;
      expect(seg!.totals, text).toBeNull();
      expect(seg!.refused?.reason, text).toBe('no_address');
    }
  });

  it('an apostrophe inside a label is ONE word: no «unit» called «og»', () => {
    const [seg] = parseTableAnswer("hajmi 5.9 og'irligi 507", table()).segments;
    expect(seg!.refused?.reason).toBe('totals_unit');
    expect(seg!.refused?.left ?? []).toEqual([]);
    // With the comma between, both totals are written: 5.9 m³ and 507 kg.
    const both = parseTableAnswer("hajmi 5.9, og'irligi 507", table()).segments;
    expect(both.map((s) => s.totals)).toEqual([
      { weightKg: null, volumeM3: 5.9, ambiguous: [] },
      { weightKg: 507, volumeM3: null, ambiguous: [] },
    ]);
  });
});

describe('typed-spec-2 — an unknown slash tail: never a total, and the named row stays', () => {
  it('JN-8 (e)’s spellings: the row keeps its name and count, the figure goes on its note', () => {
    expect(rows('Kurtka 300 dona 15 kg/kor')).toEqual([{ name: 'Kurtka', q: 300, kg: null, m3: null, note: 'sotuvchi: 15 kg/kor' }]);
    expect(rows('Stul 300 dona 15 кг/коробке')).toEqual([{ name: 'Stul', q: 300, kg: null, m3: null, note: 'sotuvchi: 15 кг/коробке' }]);
    expect(rows('Kurtka 300 dona 15 kg/karobkaga')).toEqual([{ name: 'Kurtka', q: 300, kg: null, m3: null, note: 'sotuvchi: 15 kg/karobkaga' }]);
    for (const text of ['Kurtka 300 dona 15 kg/kor', 'Stul 15 kg/kor 20 karobka']) expect(totals(text), text).toEqual(none);
  });

  it('…while a RATE per a unit of measure stays in the name, the coder’s to read', () => {
    expect(rows('Mato 180 gr/m2 500 kg')).toEqual([{ name: 'Mato 180 gr/m2', q: null, kg: 500, m3: null, note: null }]);
  });
});

describe('typed-spec-3 — a per-one answer speaks as one, never as a new product', () => {
  it('addressed: the row answer’s own refusal, at the row; un-addressed: one carton’s figure, named', () => {
    for (const text of ['1: 15 kg/ctn', '1: 15 kg/karobka', '1: har biri 15 kg', '1: 20 karobka 15 kg/ctn', '1: 15/ctn']) {
      const [seg] = parseTableAnswer(text, oneRow).segments;
      expect(seg!.at, text).toEqual({ line: 1 });
      expect(seg!.refused, text).toBeNull();
      expect(seg!.answer, text).toMatchObject({ kind: 'refused', reason: 'per_one' });
    }
    const [seg] = parseTableAnswer('15 kg/ctn', oneRow).segments;
    expect(seg!.refused).toEqual({
      reason: 'totals_unit',
      detail: '15 kg/ctn',
      left: [{ why: 'per_one', text: '15 kg/ctn', figure: '15 kg', number: '15' }],
    });
    // Another product's name beside the mark is still the name question.
    expect(parseTableAnswer('1: Shim har biri 15 kg', oneRow).segments[0]!.refused?.reason).toBe('name_mismatch');
  });
});
