import { describe, expect, it } from 'vitest';
import { CODE_SOURCE_WORDS, aiNoteText, type AiNoteGroup, type AiNoteInput } from '@/modules/wms/calc/ai-note';
import { CODING_FAILED_LINE } from '@/modules/wms/calc/ai-reply';
import { AI_CODE_NOTE } from '@/modules/wms/calc/code-source';
import { AI_NOTE_HEAD, AI_REPLY_HEAD, MACHINE_REPLY_HEADS, VED_ESTIMATE_MARK } from '@/modules/wms/calc/reply-heads';

/**
 * «🤖 AI izohi (VED uchun)» — the plain door's pass, for the VED alone
 * (docs/IKKI-ESHIK.md §2.4, his 3a: «AI faqat VED uchun kartani tayyorlaydi —
 * kodlar, stavkalar, izoh»). The seller reads the card's lenta, so the note
 * carries NO MONEY: what the machine did and what is left, in words. Every
 * literal is typed from the spec.
 */
const group = (over: Partial<AiNoteGroup> = {}): AiNoteGroup => ({
  // Row 1 unless a case numbers it — the group line opens with its rows' own
  // numbers (docs/AI-SORAYDI.md §3.4 A3).
  seqs: [1],
  label: 'Сумка женская',
  code: '4202929800',
  aiCode: false,
  dutyText: '10%',
  addDutyPct: 0,
  exciseText: null,
  vatPct: 12,
  rates: 'dictionary',
  bazas: { import: 1 },
  bazaless: 0,
  refusal: null,
  refusalTail: 'ved',
  ...over,
});

const base: AiNoteInput = {
  clientLabel: 'GS777',
  cardLabel: 'B-000067',
  pass: 'landing',
  rows: [
    { seq: 1, name: 'Сумка женская', code: '4202929800', source: 'memory' },
    { seq: 2, name: 'Kurtka', code: '6201930000', source: 'reading' },
    { seq: 3, name: 'Krossovka', code: '6403990000', source: 'book' },
    { seq: 4, name: 'Kepka', code: null, source: null },
    { seq: 5, name: 'Shim', code: '6203420000', source: 'row' },
    { seq: 6, name: 'Ko‘ylak', code: '6205200000', source: 'model' },
  ],
  groups: [
    group(),
    group({
      // Row 2 of `rows`, alone in its group: its refusal, said under its own
      // line, names no row and no group a second time (A3, A9 — `refusalUnder`).
      seqs: [2],
      label: 'Kurtka',
      code: '6201930000',
      aiCode: true,
      dutyText: '20% / min 3 $/dona',
      rates: 'typed',
      bazas: {},
      bazaless: 1,
      refusal: 'soni (dona) kiritilmagan — boj kamida $3/dona',
      refusalTail: 'seller',
    }),
  ],
  ungrouped: [{ seq: 4, name: 'Kepka' }],
  proposeFailed: false,
  asks: [],
  freight: null,
  feeRefusal: null,
  pickLeft: null,
  hasCertificate: true,
  aiConfigured: true,
  budgetSpent: false,
};

describe('the plain door’s note (§2.4)', () => {
  it('is headed for the VED, and wears no answer chip — it is not a figure', () => {
    const head = aiNoteText(base).split('\n')[0]!;
    expect(head).toBe(`${AI_NOTE_HEAD} · GS777 · B-000067`);
    // The lenta's chips name an ANSWER by these heads; this note is none.
    for (const h of Object.values(MACHINE_REPLY_HEADS)) expect(head.startsWith(h)).toBe(false);
    expect(head.startsWith(AI_REPLY_HEAD)).toBe(false);
    expect(aiNoteText(base)).not.toContain(VED_ESTIMATE_MARK);
  });

  it('names each row’s code and WHERE it came from — 🧠 memory, 📖 book, 🤖 model, the file’s own', () => {
    const note = aiNoteText(base);
    expect(note).toContain(`· 1-qator «Сумка женская» — 4202929800 · ${CODE_SOURCE_WORDS.memory}`);
    // The reading's model code wears the table's mark (§3.1).
    expect(note).toContain(`· 2-qator «Kurtka» — 6201930000 (AI taklifi) · ${CODE_SOURCE_WORDS.reading}`);
    expect(note).toContain(`· 3-qator «Krossovka» — 6403990000 · ${CODE_SOURCE_WORDS.book}`);
    expect(note).toContain('· 4-qator «Kepka» — kod yo‘q');
    expect(note).toContain(`· 5-qator «Shim» — 6203420000 · ${CODE_SOURCE_WORDS.row}`);
    expect(note).toContain(`· 6-qator «Ko‘ylak» — 6205200000 · ${CODE_SOURCE_WORDS.model}`);
    expect(CODE_SOURCE_WORDS).toEqual({
      row: '📄 so‘rovning o‘zida yozilgan',
      memory: '🧠 avvalgi muhrdan',
      book: '📖 kod lug‘atidan',
      reading: '🤖 AI o‘qishda taklif qildi — tekshiring',
      model: '🤖 AI hisobda taklif qildi — tekshiring',
    });
  });

  it('names each group’s law, where its rates came from and its bazas’ — and the refusal in words, the VED’s to get', () => {
    const note = aiNoteText(base);
    expect(note).toContain('1. Сумка женская · 4202929800 · boj 10% · QQS 12% · stavka 📖 lug‘atdan · baza: 1 ta 📥 bojxona faylidan (taxmin)');
    expect(note).toContain(
      '2. Kurtka · 6201930000 (AI taklifi) · boj 20% / min 3 $/dona · QQS 12% · stavka qo‘lda · baza: 1 ta bazasiz — VED to‘ldiradi\n' +
        '   ⚠️ soni (dona) kiritilmagan — boj kamida $3/dona — VED xodimi so‘raydi',
    );
    // Re-anchored for A3: the uncoded row by its own number, as «Kodlar:» lists it.
    expect(note).toContain('⚠️ Kod topilmadi: 4-qator «Kepka» — VED xodimi qo‘yadi');
  });

  it('carries NO money — no customs figure, no Aniq/Taxminiy, no road, no JAMI (his 3a)', () => {
    const note = aiNoteText({
      ...base,
      // A road that priced cannot even reach the note (review ADV-4): the
      // input admits a REFUSED road only, so this is a compile error — and if
      // the type ever widens again, the unused directive fails typecheck.
      // At run time the note still prints nothing about it.
      freight: {
        // @ts-expect-error — `freight` is `Extract<AiVedFreight, { ok: false }> | null`
        ok: true,
        listUsd: 1920,
        routeLabel: 'Xitoy → O‘zbekiston',
        bandText: '180 kg/m³ · $160/m³ × 12 m³',
        zoneGuessed: false,
        zoneReadFrom: null,
        volumeFromLines: false,
        exact: true,
        small: false,
      },
    });
    for (const money of ['≈', 'jami', 'Jami', 'JAMI', 'Aniq', 'Taxminiy', 'taxminiy:', 'Yo‘lkira', '$1920', 'Rasmiy emas']) {
      expect(note, money).not.toContain(money);
    }
    expect(note).not.toMatch(/\$\d+\.\d{2}\b/);
  });

  it('the gaps go first, for the VED: the rows the law wants and the road’s facts only the customer has', () => {
    const note = aiNoteText({
      ...base,
      asks: [{ itemId: 'k', seq: 2, name: 'Kurtka', needs: [{ unit: 'dona', why: 'duty', present: false, rate: 3 }] }],
      freight: { ok: false, refusal: 'umumiy hajm (m³) yo‘q', tail: 'seller' },
    }).split('\n');
    expect(note[1]).toBe('⚠️ VED uchun: 2-qator «Kurtka»: soni (dona); umumiy hajm (m³) yo‘q.');
    // The customer's fact is in the gaps line; no road line says it twice.
    expect(note.filter((l) => l.includes('umumiy hajm'))).toHaveLength(1);
    // A road refusal the VED owns is said in words.
    const zone = aiNoteText({ ...base, freight: { ok: false, refusal: 'bu zichlikka tarif yo‘q', tail: 'ved' } });
    expect(zone).toContain('Yo‘lkira: ⚠️ bu zichlikka tarif yo‘q — VED xodimi hisoblaydi');
  });

  it('refusals beyond the rows: the fee, the pick, the key, the budget', () => {
    const note = aiNoteText({
      ...base,
      feeRefusal: 'so‘m kursi yo‘q — buxgalter kiritadi yoki yig‘im qo‘lda yoziladi',
      pickLeft: { capped: 0, refused: 1, overtaken: 0, timedOut: 0, skipped: false },
    });
    expect(note).toContain('⚠️ Bojxona yig‘imi: so‘m kursi yo‘q — buxgalter kiritadi yoki yig‘im qo‘lda yoziladi');
    expect(note).toContain('⚠️ AI bazasini qo‘ymadi: 1 tasida tanlangan deklaratsiya o‘lchovi mos kelmadi — VED to‘ldiradi');
    expect(aiNoteText({ ...base, aiConfigured: false })).toContain('AI sozlanmagan — faqat yozilganidan o‘qildi.');
    expect(aiNoteText({ ...base, budgetSpent: true })).toContain('AI kunlik limiti tugadi');
  });

  it('30 rows in 3 groups: every group line and its refusal survive the fit, and each list counts its own (review PP-SPEC-1)', () => {
    const rows = Array.from({ length: 30 }, (_, k) => ({
      seq: k + 1,
      name: `Tovar ${k + 1}`,
      code: k < 10 ? '4202929800' : k < 20 ? '6201930000' : '6403990000',
      source: 'row' as const,
    }));
    // Rows 1-10, 11-20 and 21-30, one group each (A3: the line opens with the run).
    const run = (from: number) => Array.from({ length: 10 }, (_, k) => from + k);
    const groups = [
      group({ seqs: run(1), label: 'Sumka', bazas: {}, bazaless: 10, refusal: 'baza yo‘q — 1-qator «Tovar 1»', refusalTail: 'ved' }),
      group({ seqs: run(11), label: 'Kurtka', code: '6201930000' }),
      group({ seqs: run(21), label: 'Krossovka', code: '6403990000', rates: 'typed' }),
    ];
    const note = aiNoteText({ ...base, rows, groups, ungrouped: [] });
    // The groups come first — the law, the rate source, the bazas and the
    // refusal are what the VED reads the note for.
    expect(note).toContain(
      '1-10. Sumka · 4202929800 · boj 10% · QQS 12% · stavka 📖 lug‘atdan · baza: 10 ta bazasiz — VED to‘ldiradi\n' +
        '   ⚠️ baza yo‘q — 1-qator «Tovar 1» — VED xodimi qo‘yadi',
    );
    expect(note).toContain('11-20. Kurtka · 6201930000');
    expect(note).toContain('21-30. Krossovka · 6403990000 · boj 10% · QQS 12% · stavka qo‘lda');
    expect(note.indexOf('Guruhlar:')).toBeLessThan(note.indexOf('Kodlar:'));
    // The rows' codes keep their own cap and count only themselves.
    expect(note).toContain('· 25-qator «Tovar 25» — 6403990000');
    expect(note).not.toContain('26-qator');
    expect(note).toContain('… va yana 5 ta qator kodi');
    expect(note).not.toContain('ta guruh');
  });

  it('past the cap a hidden group’s refusal is counted, never dropped in silence', () => {
    const groups = Array.from({ length: 28 }, (_, k) =>
      group({ seqs: [k + 1], label: `Guruh ${k + 1}`, ...(k >= 25 && k !== 26 ? { refusal: `Guruh ${k + 1}: baza yo‘q` } : {}) }),
    );
    const note = aiNoteText({ ...base, rows: [], groups, ungrouped: [] });
    expect(note).toContain('25. Guruh 25 ·');
    expect(note).not.toContain('26. Guruh 26');
    expect(note).toContain('… va yana 3 ta guruh, 2 tasi hisoblanmadi — ro‘yxati VED ekranida');
    expect(note).not.toContain('Kodlar:');
  });

  it('a re-run after an addition says so in its heading', () => {
    expect(aiNoteText({ ...base, pass: 'amend' }).split('\n')[0]).toBe(`${AI_NOTE_HEAD} · qayta hisob · GS777 · B-000067`);
  });

  it('the item note the mark is read from is the one constant (§3.1)', () => {
    expect(AI_CODE_NOTE).toBe('TNVED: AI taklifi (o‘qishda) — tekshiring');
  });
});

/**
 * The note numbers its groups the way the AI answer does (docs/AI-SORAYDI.md
 * §3.4 A3): by their rows' own `seq`, the number the VED's screen and the
 * «Kodlar:» list beside it print — and a coding call that did not answer is
 * said as that (A6, review JS-15), never «Kod topilmadi».
 */
describe('the note in one numbering, and a failed coding call (A3, A6)', () => {
  it('groups open with their rows’ numbers, in row order whatever order they come in', () => {
    const note = aiNoteText({
      ...base,
      rows: [],
      ungrouped: [],
      groups: [group({ seqs: [3, 5], label: 'Sumka, Hamyon' }), group({ seqs: [1, 2], label: 'Kurtka, Shim' })],
    });
    const heads = note.split('\n').filter((l) => /^[\d, -]+\. /.test(l));
    expect(heads.map((l) => l.split(' · ')[0])).toEqual(['1-2. Kurtka, Shim', '3, 5. Sumka, Hamyon']);
  });

  it('the coding call did not answer: the ruling’s sentence instead of «Kod topilmadi»', () => {
    const note = aiNoteText({ ...base, proposeFailed: true });
    expect(note).toContain(CODING_FAILED_LINE);
    expect(note).not.toContain('Kod topilmadi');
    // The row is still listed in «Kodlar:» — what is uncoded stays named.
    expect(note).toContain('· 4-qator «Kepka» — kod yo‘q');
    // Nothing uncoded, nothing to say about a code.
    expect(aiNoteText({ ...base, ungrouped: [], proposeFailed: true })).not.toContain(CODING_FAILED_LINE);
  });
});
