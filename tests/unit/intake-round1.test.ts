import Anthropic from '@anthropic-ai/sdk';
import { readFileSync } from 'node:fs';
import path from 'node:path';
import { describe, expect, it } from 'vitest';
import { z } from 'zod';
import { aiFailureOf, readIntakeResponse } from '@/modules/wms/calc/intake-ai';
import { AI_READ_FAILURE, parseClientHint, type AiReadFailure } from '@/modules/wms/calc/intake';
import { looksLikeMaterial, parseManualFacts, readGoodsLines } from '@/modules/wms/calc/intake-manual';
import { intakeFileKind, startIntake, endIntake, type IntakeState } from '@/modules/platform/telegram/calc-intake';
import { aiStepsText, settleAnalysis } from '@/modules/platform/telegram/staff-handlers';
import { collectorSource } from '../fixtures/calc-collector-source';

/**
 * Round 1 of his eight items (docs/SAKKIZ-BAND.md, 2026-10-21): the bot stops
 * losing what it is sent, and says why when the model does not read it.
 */

// The collector's files (docs/SAKKIZ-R3.md K16): the summary's words moved
// into calc-dialog.ts with the rest of the dialogue.
const HANDLERS = collectorSource();

describe('the model’s answer, read — or the reason it is missing (his 1.6 a)', () => {
  const good = JSON.stringify({
    from_city: null,
    to_city: null,
    weight_kg: 240,
    volume_m3: 1.1,
    goods: [
      {
        name: 'Масло компрессорное',
        quantity: null,
        weight_kg: 240,
        volume_m3: null,
        unit: null,
        measure_qty: null,
        tnved_code: null,
        note: null,
      },
    ],
    steps: ['Matndan tovar nomi va og‘irlik olindi'],
  });

  it('a whole answer is the facts', () => {
    const out = readIntakeResponse({
      stop_reason: 'end_turn',
      content: [{ type: 'text', text: good }],
      usage: { input_tokens: 10, output_tokens: 20 },
    });
    expect(out.ok).toBe(true);
    if (out.ok) expect(out.facts.goods?.[0]?.name).toBe('Масло компрессорное');
  });

  it('a CUT answer is «truncated», never «the AI is unavailable» (the 4096 trap)', () => {
    const cut = readIntakeResponse({ stop_reason: 'max_tokens', content: [{ type: 'text', text: good.slice(0, 60) }] });
    expect(cut).toMatchObject({ ok: false, failure: 'truncated' });
  });

  it('a refusal and an unreadable answer are named apart', () => {
    expect(readIntakeResponse({ stop_reason: 'refusal', content: [] })).toMatchObject({ ok: false, failure: 'refused' });
    expect(readIntakeResponse({ stop_reason: 'end_turn', content: [{ type: 'text', text: '{"goods":' }] })).toMatchObject({
      ok: false,
      failure: 'unreadable',
    });
  });

  // Round 1, c21 (re-anchored from the two exact-shape pins above): a read the
  // model was PAID for and that failed still says what it cost, or the day's
  // budget never sees the most expensive calls on the path.
  it('a paid read that failed carries its usage', () => {
    const usage = { input_tokens: 40_000, output_tokens: 16_000 };
    for (const response of [
      { stop_reason: 'max_tokens', content: [], usage },
      { stop_reason: 'refusal', content: [], usage },
      { stop_reason: 'end_turn', content: [{ type: 'text', text: '{"goods":' }], usage },
    ]) {
      const out = readIntakeResponse(response);
      expect(out.ok, response.stop_reason).toBe(false);
      expect(out.usage, response.stop_reason).toMatchObject({ inputTokens: 40_000, outputTokens: 16_000 });
    }
  });

  it('every SDK error is one of the words the seller is told', () => {
    const generate = (status: number) => Anthropic.APIError.generate(status, { error: { type: 'x' } }, 'm', new Headers());
    expect(aiFailureOf(generate(401))).toBe('auth');
    expect(aiFailureOf(generate(403))).toBe('auth');
    expect(aiFailureOf(generate(429))).toBe('rate_limited');
    expect(aiFailureOf(generate(500))).toBe('overloaded');
    expect(aiFailureOf(generate(529))).toBe('overloaded');
    expect(aiFailureOf(generate(400))).toBe('rejected');
    expect(aiFailureOf(new Anthropic.APIConnectionTimeoutError())).toBe('timeout');
    expect(aiFailureOf(new Anthropic.APIConnectionError({ message: 'reset' }))).toBe('network');
    expect(aiFailureOf(new SyntaxError('bad json'))).toBe('unreadable');
    expect(aiFailureOf(new z.ZodError([]))).toBe('unreadable');
  });

  it('every failure has a sentence, and the bot no longer says «AI mavjud emas»', () => {
    const all: AiReadFailure[] = [
      'not_configured', 'nothing_to_read', 'budget', 'refused', 'truncated', 'timeout',
      'rate_limited', 'overloaded', 'auth', 'rejected', 'unreadable', 'network',
    ];
    for (const f of all) expect(AI_READ_FAILURE[f].text.length).toBeGreaterThan(10);
    expect(HANDLERS).not.toContain('AI mavjud emas');
    expect(HANDLERS).toContain('AI_READ_FAILURE[failure].text');
  });

  it('the model’s own notes reach the seller, at most three (his 1.6 a)', () => {
    expect(aiStepsText([])).toBe('');
    const text = aiStepsText(['bir', 'ikki', 'uch', 'to‘rt']);
    expect(text).toContain('· uch');
    expect(text).not.toContain('to‘rt');
  });
});

describe('what a person TYPED as goods is read without the model', () => {
  it('his screenshot: «Tovar … 1.1 kub 240 kg» is a line, not «Tovarlar: —»', () => {
    const facts = parseManualFacts('Tovar синтетическое компрессорное масло 1.1 kub 240 kg');
    expect(facts.goods).toEqual([
      expect.objectContaining({ name: 'синтетическое компрессорное масло', weightKg: 240, volumeM3: 1.1 }),
    ]);
    expect(facts.weightKg).toBe(240);
    expect(facts.volumeM3).toBe(1.1);
  });

  it('a name followed by figures is a line; a sentence, a route or a total is not', () => {
    expect(readGoodsLines('Kurtka 300 dona 150 kg\nSumka 50 dona').map((g) => [g.name, g.quantity, g.weightKg])).toEqual([
      ['Kurtka', 300, 150],
      ['Sumka', 50, null],
    ]);
    expect(readGoodsLines('Krossovka 40 juft')[0]).toMatchObject({ measureUnit: 'juft', measureQty: 40 });
    for (const not of [
      'vazni 120кг, 2 куб',
      '250 kg\nyana 250 kg deb yozishdi',
      'Yiwu → Toshkent, 250 kg, 3.5 kub, chexollar',
      'umumiy 12 kub 3500 kg',
      'GS777',
      'salom',
      'Futbolka 1,200 dona',
    ]) {
      expect(readGoodsLines(not), not).toEqual([]);
    }
  });
});

describe('the first message: the customer, or material (his 1.7 b)', () => {
  it('a code or a phone names the customer; a goods list is material; a few words are a name', () => {
    expect(looksLikeMaterial('GS777')).toBe(false);
    expect(looksLikeMaterial('+998 90 123 45 67')).toBe(false);
    expect(looksLikeMaterial('Telegram . Nomli account')).toBe(false);
    expect(looksLikeMaterial('Tovar масло 1.1 kub 240 kg')).toBe(true);
    expect(looksLikeMaterial('Ali\nKurtka 300 dona')).toBe(true);
  });

  it('a TNVED code is never a phone (the diagnosis’ cause 6)', () => {
    expect(parseClientHint('Kurtka 6201930000')).toBeNull();
    expect(parseClientHint('Kurtka 6201930000\nSumka 4202')).toBeNull();
    // The NUMBER, not the line (review #26): it is what the lead's phone
    // column holds and what the matchers read the last digits of.
    expect(parseClientHint('Ali aka +998901234567')).toEqual({ phone: '+998901234567' });
  });
});

describe('an analysis lands only where it still belongs (the diagnosis’ cause 7)', () => {
  const chat = 990_000_001n;
  const base = (): IntakeState => {
    const s = startIntake(chat, 'rastamojka', { staffId: 'staff-test' });
    endIntake(chat);
    return { ...s, stage: 'material', material: ['Kurtka 300 dona'], fileCount: 1, analysing: 'T1' };
  };
  const analysed = (s: IntakeState): IntakeState => ({
    ...s,
    facts: { goods: [{ name: 'Kurtka', quantity: 300 }] },
    aiUsed: true,
    stage: 'review',
  });

  it('a message sent while it ran is KEPT, and the seller is asked to press «Bo‘ldi» again', () => {
    const snap = base();
    const live = { ...snap, material: [...snap.material, 'yana 2 ta sumka'] };
    const out = settleAnalysis(live, snap, analysed(snap), 'T1');
    expect(out.kind).toBe('arrived');
    if (out.kind !== 'arrived') return;
    expect(out.arrived).toBe(1);
    expect(out.state.material).toEqual(['Kurtka 300 dona', 'yana 2 ta sumka']);
    expect(out.state.stage).toBe('material');
    expect(out.state.analysing).toBeNull();
  });

  it('a cancelled, restarted or superseded collection throws the result away', () => {
    const snap = base();
    expect(settleAnalysis(null, snap, analysed(snap), 'T1').kind).toBe('gone');
    expect(settleAnalysis({ ...snap, noteId: 'other' }, snap, analysed(snap), 'T1').kind).toBe('gone');
    expect(settleAnalysis({ ...snap, analysing: 'T2' }, snap, analysed(snap), 'T1').kind).toBe('gone');
  });

  it('nothing new: the facts land and the summary follows', () => {
    const snap = base();
    const out = settleAnalysis(snap, snap, analysed(snap), 'T1');
    expect(out.kind).toBe('done');
    if (out.kind === 'done') expect(out.state.facts.goods?.[0]?.name).toBe('Kurtka');
  });

  it('the confirm lands only what the seller was shown', () => {
    const save = HANDLERS.slice(HANDLERS.indexOf('  // save — only what the seller was SHOWN.'));
    expect(save.slice(0, 1100)).toContain("if (state.stage !== 'review' && state.stage !== 'question') {");
    expect(save.slice(0, 1100)).toContain('if (state.analysing) {');
  });
});

describe('a file is read by what its bytes are (the diagnosis’ cause 2)', () => {
  const bytes = (...b: number[]) => Buffer.from([...b, ...new Array(16).fill(0)]);
  it('a picture sent as a FILE is a picture; a PDF a PDF; an ISO-media file is tried as HEIC', () => {
    expect(intakeFileKind(bytes(0xff, 0xd8, 0xff, 0xe0), false, 'scan.jpg', 'image/jpeg')).toBe('image');
    expect(intakeFileKind(Buffer.concat([Buffer.from([0x89]), Buffer.from('PNG\r\n')]), false, 'a.png', null)).toBe('image');
    expect(intakeFileKind(Buffer.from('%PDF-1.7 rest'), false, 'inv.pdf', null)).toBe('pdf');
    expect(intakeFileKind(Buffer.concat([Buffer.alloc(4), Buffer.from('ftypheic')]), false, 'IMG.HEIC', null)).toBe(
      'isomedia',
    );
    // A phone video is ISO media too — its brand keeps it from being called a HEIC.
    expect(intakeFileKind(Buffer.concat([Buffer.alloc(4), Buffer.from('ftypmp42')]), false, 'v.mp4', null)).toBe('video');
    expect(intakeFileKind(Buffer.concat([Buffer.alloc(4), Buffer.from('ftypqt  ')]), false, 'v.mov', null)).toBe('video');
    expect(intakeFileKind(Buffer.from('PK\u0003\u0004'), false, 'photos.zip', null)).toBe('archive');
    expect(intakeFileKind(Buffer.from('PK\u0003\u0004'), false, 'a.docx', null)).toBe('docx');
    expect(intakeFileKind(Buffer.from('PK\u0003\u0004'), false, 'invoice.xlsx', null)).toBe('sheet');
  });
});

describe('the queued AI pass is never silent when it does not answer', () => {
  const JOBS = readFileSync(path.join(__dirname, '..', '..', 'src', 'modules', 'wms', 'calc', 'jobs.ts'), 'utf8');
  // Re-anchored for round 2 (docs/SAKKIZ-R2.md §6.8, regression-4): the
  // worker speaks through `sayOnce` (one machine message per request), its
  // loop body moved into `runPrefillJob` (so `continue` became `return`), and
  // the words are chosen by the job's queue — the tariff reply has its own
  // (§2.8). The pins keep their shape: a stand-down SPEAKS before it leaves,
  // and a failure says PASS_FAILED.
  it('a stand-down and a failure both reach the seller', () => {
    const branch = JOBS.slice(JOBS.indexOf("if (standing !== 'ok') {"));
    // Re-anchored (R2 late pass, concurrency-9): the queue's choice of words
    // moved into `standDownWords`, whose tariff map has no key for a person's
    // work.
    const told = branch.indexOf('const said = standDownWords(standing, writes);');
    expect(told, 'the stand-down no longer speaks — re-anchor').toBeGreaterThan(-1);
    const leaves = branch.indexOf('return;');
    expect(told).toBeLessThan(leaves);
    expect(branch.slice(told, leaves)).toContain("await sayOnce(requestId, 'landing', {");
    const failed = JOBS.slice(JOBS.indexOf("'[calc-prefill] pass failed — the VED still has the job'"));
    expect(failed.slice(0, 600)).toContain("await sayOnce(requestId, 'landing', {");
    expect(failed.slice(0, 600)).toContain('text: writes ? PASS_FAILED : TARIFF_PASS_FAILED');
  });
});

describe('an album before the customer is named is asked about once', () => {
  it('the re-ask is skipped for the rest of the same album', () => {
    const handler = HANDLERS.slice(HANDLERS.indexOf("const waiting = state.stage === 'client' || state.stage === 'section';"));
    const skip = handler.indexOf('if (asked) return;');
    expect(skip, 'the album guard has moved — re-anchor').toBeGreaterThan(-1);
    expect(skip).toBeLessThan(handler.indexOf("if (state.stage === 'section') {"));
    expect(handler.slice(0, 600)).toContain('group === state.reaskedGroup');
  });
});
