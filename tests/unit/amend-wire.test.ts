import { describe, expect, it } from 'vitest';
import { bodyOf, read } from '../fixtures/source-shape';

/**
 * The add door's wiring (docs/SAKKIZ-R3.md §9.7, `amend-wire`): the rules no
 * behavioural test sees, read off the source with comments stripped (#725).
 */
const AMEND = read('src/modules/wms/calc/amend.ts');
const BOT = read('src/modules/platform/telegram/calc-amend.ts');
const SERVICE = read('src/modules/wms/calc/service.ts');
const UPSALE = read('src/modules/wms/calc/upsale.ts');

/**
 * A top-level function's whole text, from its declaration to the closing
 * brace at column 0 — `bodyOf` stops at a bare object return type.
 */
function fnText(source: string, needle: string): string {
  const at = source.indexOf(needle);
  if (at < 0) return '';
  const end = source.indexOf('\n}\n', at);
  return source.slice(at, end < 0 ? undefined : end + 2);
}

/** Every braces-balanced block opening right after `head` (each occurrence). */
function blocksAfter(source: string, head: string): string[] {
  const out: string[] = [];
  let at = source.indexOf(head);
  while (at >= 0) {
    const open = source.indexOf('{', at + head.length - 1);
    let braces = 0;
    for (let j = open; j < source.length; j += 1) {
      if (source[j] === '{') braces += 1;
      else if (source[j] === '}') {
        braces -= 1;
        if (braces === 0) {
          out.push(source.slice(open, j + 1));
          break;
        }
      }
    }
    at = source.indexOf(head, at + head.length);
  }
  return out;
}

describe('the landing is Uch band’s, never the add door’s (re-check p4-12)', () => {
  const LANDING = [
    'landIntake',
    'landCodedRequest',
    'landCodedCard',
    'calcCardFor',
    'cardOfNote',
    'rootRequestOfNote',
    'shellCandidate',
    'openLeadForPhone',
    'calcDealOwnerFor',
    'clientSellerFor',
    'resolveIntakeClient',
    'calcStageMove',
    'moveToCalcStage',
    'openCalcRequest',
    'createDealInTx',
    'insertLeadTx',
  ];
  for (const [file, text] of [
    ['amend.ts', AMEND],
    ['calc-amend.ts', BOT],
  ] as const) {
    it(`${file} names none of the landing`, () => {
      expect(LANDING.filter((name) => new RegExp(`\\b${name}\\b`).test(text))).toEqual([]);
    });
  }
});

describe('the one writer', () => {
  it('the card note goes through insertActivityTx(tx, …), never addActivity( (re-check p4-4)', () => {
    const body = fnText(AMEND, 'async function noteAndThreadTx(');
    expect(body).toMatch(/insertActivityTx\(\s*tx,/);
    expect(body).toMatch(/insertThreadMessageInTx\(\s*tx,/);
    expect(AMEND).not.toContain('addActivity(');
  });

  it('the saveTable call posts no baza, import, reason, rate source or zone (the ai-advisory pattern)', () => {
    const call = AMEND.slice(AMEND.indexOf('await saveTable('), AMEND.indexOf('inTx: async', AMEND.indexOf('await saveTable(')));
    expect(call.length).toBeGreaterThan(0);
    const edits = fnText(AMEND, 'export function tableEditsOf(');
    const patch = fnText(AMEND, 'function doorPatch(');
    expect(edits.length).toBeGreaterThan(0);
    expect(patch.length).toBeGreaterThan(0);
    for (const name of ['bazaUsd', 'bazaBasis', 'importRowId', 'bazaReason', 'rateSource', 'freightZone', 'shownBasis']) {
      expect(call, `${name} in the saveTable call`).not.toContain(name);
      expect(edits, `${name} in the edits`).not.toContain(name);
      expect(patch, `${name} in a row answer`).not.toContain(name);
      // …and nowhere else in the writer either.
      expect(AMEND, `${name} in amend.ts`).not.toMatch(new RegExp(`\\b${name}\\b`));
    }
    expect(call).toContain('handsOff: true');
    expect(call).toContain('expectRev: standing.handsoffRev');
  });

  it('every new line and every row answer passes through doorRow', () => {
    expect(fnText(AMEND, 'export function amendDiff(')).toContain('doorRow(');
    expect(fnText(AMEND, 'export function amendDiff(')).toContain('doorPatch(');
    expect(fnText(AMEND, 'function doorPatch(')).toContain('doorRow(');
  });

  it('every in-transaction body names tx. and never db. (#714 — tx-pool.test.ts cannot see a callback run inside saveTable)', () => {
    const bodies = [
      ...blocksAfter(AMEND, 'inTx: async (tx, newRev, saved) => {'),
      ...blocksAfter(AMEND, 'db.transaction(async (tx) => {'),
      fnText(AMEND, 'async function recordAmendmentInTx('),
      fnText(AMEND, 'async function noteAndThreadTx('),
      fnText(AMEND, 'async function cardUnderLockTx('),
      fnText(AMEND, 'async function leadStillOpenTx('),
      fnText(AMEND, 'async function addSeqsTx('),
    ];
    expect(bodies.length).toBeGreaterThanOrEqual(7);
    for (const body of bodies) {
      expect(body.length).toBeGreaterThan(0);
      expect(body).toMatch(/\btx\s*[.,)]/);
      expect(body).not.toMatch(/\bdb\./);
      // A pooled read inside the lock is #714's freeze.
      expect(body).not.toContain('storedRequestFacts(');
      expect(body).not.toContain('amendStanding(');
    }
  });

  it('the card is re-read under the lock, never taken from the pooled read (re-check p4-4)', () => {
    for (const body of blocksAfter(AMEND, 'inTx: async (tx, newRev, saved) => {')) {
      expect(body).toContain('cardUnderLockTx(tx, input.requestId)');
    }
  });
});

describe('the words and the reads', () => {
  it('AMEND_REFUSAL is a Record over SaveTableRefusal — a new refusal without words is a compile error', () => {
    expect(BOT).toMatch(/export const AMEND_REFUSAL: Record<SaveTableRefusal(\s*\|\s*'server_behind')?, string> = \{/);
  });

  it('storedRequestFacts names no loadWorkspace (performance-9)', () => {
    const body = bodyOf(SERVICE, 'export async function storedRequestFacts(');
    expect(body.length).toBeGreaterThan(0);
    expect(body).not.toContain('loadWorkspace');
  });

  it('the save is a pg-boss job with its own options and no singletonKey (re-check p4-2)', () => {
    const enqueueSave = bodyOf(BOT, 'async function enqueueSave(');
    expect(enqueueSave).toContain('JOB_CALC_AMEND_SAVE');
    expect(enqueueSave).toContain('expireInSeconds: AMEND_SAVE_EXPIRE_S');
    expect(enqueueSave).toContain('retryLimit: AMEND_SAVE_RETRIES');
    expect(BOT).not.toContain('singletonKey');
    // Never a `void` save: a graceful deploy drains no `void` work (durability-4).
    expect(BOT).not.toMatch(/void\s+runAmendSave/);
  });

  it('an answer offer’s quoted m³ reads the request’s Σ when the version has none (law-money-1)', () => {
    expect(UPSALE).toContain('COALESCE(v.volume_m3, r.volume_m3) AS quoted_m3');
  });
});
