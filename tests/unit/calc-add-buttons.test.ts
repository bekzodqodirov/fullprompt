import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';
import { buttonsFor, parseCallback } from '@/modules/platform/telegram/staff-bot';
import { addFor } from '@/modules/wms/calc/jobs';
import {
  aiVedReplyText,
  lawAsksBlock,
  type AiVedLine,
  type AiVedReplyInput,
} from '@/modules/wms/calc/ai-reply';
import { fitTelegram, TELEGRAM_LIMIT } from '@/modules/wms/calc/fit-telegram';
import { tariffReplyText } from '@/modules/wms/calc/prefill-reply';
import { TAXMINIY_BLOCK_WORDS } from '@/modules/wms/calc/estimate';
import { lawAsksInputOf, lawAsksOf, type LawAsk } from '@/modules/wms/calc/law-asks';
import type { Workspace } from '@/modules/wms/calc/workspace';
import { strip } from '../fixtures/source-shape';

/**
 * «➕ Shu so‘rovga qo‘shish» under the machine's answer (docs/SAKKIZ-R3.md
 * §10.2.5, his proposal 2) and the 2.8 b block in it (§2.5, §10.3). The
 * muted seller's re-run needs the drain, so it is pinned in
 * calc-pass-settle.integration.
 */

const REQUEST = '0b8f6a1c-3d2e-4f50-8a9b-7c6d5e4f3a21';

describe('the ➕ on a CalcPrefilled message', () => {
  it('one button whose callback the parser takes — the add door on THAT request', () => {
    const rows = buttonsFor('CalcPrefilled', { requestId: REQUEST, add: true, text: 'x' });
    expect(rows).toEqual([[{ text: '➕ Shu so‘rovga qo‘shish', callback_data: `ca:${REQUEST}` }]]);
    const data = (rows![0]![0] as { callback_data: string }).callback_data;
    // An unparsed callback is answered by nobody and spins (#939).
    expect(parseCallback(data)).toEqual({ kind: 'calc_add', requestId: REQUEST, mode: 'plain' });
    expect(Buffer.byteLength(data)).toBeLessThanOrEqual(64);
  });

  it('a request id written in capitals still reaches the parser (it takes lowercase)', () => {
    const rows = buttonsFor('CalcPrefilled', { requestId: REQUEST.toUpperCase(), add: true });
    const data = (rows![0]![0] as { callback_data: string }).callback_data;
    expect(parseCallback(data)).toMatchObject({ kind: 'calc_add', requestId: REQUEST });
  });

  it('no `add`, or no uuid request id → no button', () => {
    expect(buttonsFor('CalcPrefilled', { requestId: REQUEST })).toBeNull();
    expect(buttonsFor('CalcPrefilled', { requestId: REQUEST, add: false })).toBeNull();
    expect(buttonsFor('CalcPrefilled', { requestId: REQUEST, add: 'true' })).toBeNull();
    expect(buttonsFor('CalcPrefilled', { requestId: 'r1', add: true })).toBeNull();
    expect(buttonsFor('CalcPrefilled', { add: true })).toBeNull();
    // Another type with the same fields is not the machine's answer.
    expect(buttonsFor('CalcDone', { requestId: REQUEST, add: true })).toBeNull();
  });

  it('which messages carry it: everything about an OPEN request — not a closed one, not a gone one', () => {
    expect(addFor('closed')).toBe(false);
    expect(addFor('not_found')).toBe(false);
    for (const standing of ['touched', 'confirmed', 'unfinished', 'ok'] as const) {
      expect(addFor(standing), standing).toBe(true);
    }
  });

  it('the worker decides it at each of its five sites — `add: addFor(…)` on every machine message', () => {
    const jobs = strip(readFileSync('src/modules/wms/calc/jobs.ts', 'utf8'));
    const body = jobs.slice(jobs.indexOf('async function runPrefillJob'), jobs.indexOf('async function writeReplyToLenta'));
    const says = body.split('sayOnce(requestId, pass, {').length - 1;
    expect(says).toBe(5);
    expect(body.match(/extra: \{ add: addFor\(/g)).toHaveLength(5);
    // The withheld reply's closed sentence carries none.
    expect(body).toContain("extra: { add: addFor('closed') }");
  });
});

const line = (k: number): AiVedLine => ({
  label: `Uzun nomli tovar ${k} — ${'x'.repeat(120)}`,
  code: '8528520000',
  measureText: '100 dona × $20/dona',
  bazaSource: 'memory',
  dutyText: '10%',
  addDutyPct: 0,
  exciseText: null,
  vatPct: 12,
  customsUsd: 100 + k,
  refusal: null,
  refusalTail: 'ved',
  estimated: null,
  weightFromTotal: null,
  staleBaza: false,
});

const asks: LawAsk[] = [
  { itemId: 'a', seq: 2, name: 'Krossovka', needs: [{ unit: 'juft', why: 'duty', present: false, rate: 3 }] },
  { itemId: 'b', seq: 5, name: 'Kurtka', needs: [{ unit: 'dona', why: 'duty', present: false, rate: 2 }] },
];

const base: AiVedReplyInput = {
  clientLabel: 'GS777',
  cardLabel: 'B-000067',
  lines: Array.from({ length: 40 }, (_, k) => line(k + 1)),
  ungrouped: [],
  fee: { bhm: 5, usd: 164.8 },
  totalUsd: 4980,
  feeRefusal: null,
  hasCertificate: true,
  freight: null,
  link: 'https://gsrwms.uz/bitimlar/x',
  aiConfigured: true,
  estimate: null,
  pickLeft: null,
  asks,
  pass: 'landing',
  audience: 'chat',
};

describe('the 2.8 b block is never cut by the 4096 fit', () => {
  it('a 40-line reply: the group lines shrink, the asked rows all stay', () => {
    const text = aiVedReplyText(base);
    expect(text.length).toBeLessThanOrEqual(TELEGRAM_LIMIT);
    expect(text).toContain('… va yana');
    for (const l of lawAsksBlock(asks)) expect(text).toContain(l);
  });

  it('the property the reply leans on: `fixed` survives the fit, `lines` do not', () => {
    // The same block handed to the fit as LINES is cut on a long invoice —
    // which is why the reply puts it in `fixed` (§2.5).
    const groupLines = base.lines.map((l, k) => `${k + 1}. ${l.label}\n   boj 10% · QQS 12% → $${l.customsUsd}`);
    const asFixed = fitTelegram(['head'], groupLines, lawAsksBlock(asks), ['tail']);
    const asLines = fitTelegram(['head'], [...groupLines, ...lawAsksBlock(asks)], [], ['tail']);
    expect(asFixed).toContain('✍️ Shu xabarga reply qilib yozing');
    expect(asLines).not.toContain('✍️ Shu xabarga reply qilib yozing');
  });
});

describe('the block is asked only while nobody but the machine has written', () => {
  const ws = (handsoffRev: number | null) =>
    ({
      rev: 7,
      handsoffRev,
      section: 'rastamojka',
      fromCity: null,
      weightKg: null,
      volumeM3: null,
      groups: [
        {
          dutyMode: 'max',
          dutyUnit: 'juft',
          dutySpecific: 3,
          dutyFree: false,
          excisePct: null,
          exciseSpecific: null,
          exciseUnit: null,
          confirmedAt: null,
          items: [
            { id: 'a', seq: 2, label: 'Krossovka', quantity: 200, weightKg: null, volumeM3: null, measureUnit: null, measureQty: null, tnvedCode: '6403990000', bazaBasis: null },
          ],
        },
      ],
      ungrouped: [],
    }) as unknown as Workspace;
  /** The reply's own derivation (prefill.ts): the input, then the asks. */
  const replyAsks = (w: Workspace) => {
    const input = lawAsksInputOf(w);
    return input ? lawAsksOf(input) : null;
  };

  it('handsoff_rev = rev → the block; handsoff_rev ≠ rev at the reply → no block', () => {
    expect(aiVedReplyText({ ...base, lines: [line(1)], asks: replyAsks(ws(7)) })).toContain('· 2-qator «Krossovka»: juft soni');
    expect(aiVedReplyText({ ...base, lines: [line(1)], asks: replyAsks(ws(6)) })).not.toContain('❓');
  });

  it('the pass derives it from the FINAL workspace it already loaded, and not over a person who overtook it', () => {
    const prefill = strip(readFileSync('src/modules/wms/calc/prefill.ts', 'utf8'));
    expect(prefill).toContain('const asksInput = overtaken === null ? lawAsksInputOf(ws) : null;');
    // One read (performance-9): never the stored-request reader beside the workspace.
    expect(prefill).not.toContain('storedRequestFacts');
  });
});

describe('the seller’s tails are worded for their reader (§2.5)', () => {
  const PLUS = '— mijozdan so‘rab, «➕ Shu so‘rovga qo‘shish» bilan yuboring';
  const LENTA = '— mijozdan so‘rab, kartadagi lentaga yozing';
  const sellerLine: AiVedLine = {
    ...line(1),
    customsUsd: null,
    refusal: 'Kurtka: 1-qator «Kurtka»: soni (dona) kiritilmagan — boj kamida $3/dona',
    refusalTail: 'seller',
  };
  const road = { ok: false as const, refusal: 'umumiy brutto og‘irlik (kg) yo‘q', tail: 'seller' as const };

  it('the chat points at «➕» on the road, a customs line and refused_measure', () => {
    const chat = aiVedReplyText({ ...base, lines: [sellerLine], asks: null, freight: road });
    expect(chat).toContain(`Yo‘lkira: ⚠️ umumiy brutto og‘irlik (kg) yo‘q ${PLUS}`);
    expect(chat).toContain(`kamida $3/dona ${PLUS}`);
    expect(TAXMINIY_BLOCK_WORDS.refused_measure.chat).toBe(`⚠️ qatorda soni yoki og‘irligi yo‘q ${PLUS}`);
    expect(tariffReplyText({ clientLabel: null, cardLabel: null, link: null, pass: 'landing', audience: 'chat', freight: road })).toContain(PLUS);
  });

  it('the lenta keeps «kartadagi lentaga yozing» on all three', () => {
    const lenta = aiVedReplyText({ ...base, link: null, audience: 'lenta', lines: [sellerLine], asks: null, freight: road });
    expect(lenta).toContain(`Yo‘lkira: ⚠️ umumiy brutto og‘irlik (kg) yo‘q ${LENTA}`);
    expect(lenta).toContain(`kamida $3/dona ${LENTA}`);
    expect(lenta).not.toContain('«➕');
    expect(TAXMINIY_BLOCK_WORDS.refused_measure.lenta).toBe(`⚠️ qatorda soni yoki og‘irligi yo‘q ${LENTA}`);
    expect(tariffReplyText({ clientLabel: null, cardLabel: null, link: null, pass: 'landing', audience: 'lenta', freight: road })).toContain(LENTA);
  });
});
