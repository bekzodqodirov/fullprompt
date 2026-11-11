import { describe, expect, it } from 'vitest';
import { aiReadingWhole, modelOnlyMaterial, type WholenessInput } from '@/modules/platform/telegram/reading-whole';

/**
 * docs/FAYL-OQISH.md §1.1 — the one predicate «✅ Tasdiqlash» on the AI door
 * asks. Each blocking reason is pinned alone, and the named tier never blocks.
 */
const base = (patch: Partial<WholenessInput> = {}): WholenessInput => ({
  images: [],
  pdfs: [],
  sheetTexts: [],
  aiUsed: false,
  goodsFiles: [],
  ...patch,
});

describe('aiReadingWhole', () => {
  it('an Excel-only collection with rows is whole, model or no model', () => {
    expect(aiReadingWhole(base(), 3)).toEqual({ whole: true, blocking: [], named: [] });
    expect(aiReadingWhole(base({ aiUsed: true }), 3).whole).toBe(true);
  });

  it('zero rows is never whole', () => {
    expect(aiReadingWhole(base({ aiUsed: true }), 0).blocking).toEqual(['no_goods']);
  });

  it('a photo, a PDF or an unmapped sheet the model did not answer for is not whole', () => {
    const img = { attachmentId: 'a', mediaType: 'image/jpeg' as const };
    const pdf = { attachmentId: 'p', name: 'x.pdf', bytes: 10 };
    expect(aiReadingWhole(base({ images: [img] }), 2).blocking).toEqual(['model_failed']);
    expect(aiReadingWhole(base({ pdfs: [pdf] }), 2).blocking).toEqual(['model_failed']);
    expect(aiReadingWhole(base({ sheetTexts: [{ text: 'a | 1', cut: false, cellsCut: false }] }), 2).blocking).toEqual([
      'model_failed',
    ]);
    // Blank sheet text is no material.
    expect(aiReadingWhole(base({ sheetTexts: [{ text: '  ', cut: false, cellsCut: false }] }), 2).whole).toBe(true);
    expect(aiReadingWhole(base({ images: [img], aiUsed: true }), 2).whole).toBe(true);
  });

  it('a PDF the API refused is not model material, but it blocks as refused', () => {
    const pdf = { attachmentId: 'p', name: 'x.pdf', bytes: 10 };
    const s = base({ pdfs: [pdf], unreadPdfs: ['p'] });
    expect(modelOnlyMaterial(s)).toBe(false);
    expect(aiReadingWhole(s, 2).blocking).toEqual(['pdf_refused']);
  });

  it('a cut, a missing file, an input cut and a capped file each block', () => {
    expect(aiReadingWhole(base({ aiUsed: true, aiCut: { goods: 40, why: 'clock' } }), 40).blocking).toEqual(['cut']);
    expect(aiReadingWhole(base({ filesMissing: 1 }), 2).blocking).toEqual(['files_missing']);
    expect(aiReadingWhole(base({ aiInputCut: true }), 2).blocking).toEqual(['input_cut']);
    const capped = { label: 'a.xlsx', shape: 'invoice' as const, weightKind: null, grossKg: null, grossColumn: false, volumeM3: null, rows: 500, text: null, capped: true as const };
    expect(aiReadingWhole(base({ goodsFiles: [capped] }), 500).blocking).toEqual(['capped']);
  });

  it('files refused at arrival are named and never block', () => {
    const r = aiReadingWhole(base({ refusedFiles: [{ name: 'shartnoma.docx', why: 'Word fayl o‘qilmaydi' }] }), 2);
    expect(r.whole).toBe(true);
    expect(r.named).toEqual([{ name: 'shartnoma.docx', why: 'Word fayl o‘qilmaydi' }]);
  });
});
