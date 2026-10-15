import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';

/**
 * The Готово fold (the owner's 9a, docs/VED-TARIX.md §5).
 *
 * The amount travels as TEXT: the browser used to parse it first, so «1200$»
 * became 1200 on one side and a refusal was impossible to word — the server
 * now owns the one parse (`parseTypedMoney`) and says
 * `answer_amount_unreadable` in words. And the fold carries TWO boxes, the
 * seller's note and the VED's internal one, each with its own id, so neither
 * can be mistaken for the other on a phone.
 */
const strip = (s: string) => s.replace(/\/\*[\s\S]*?\*\//g, '').replace(/(^|[^:])\/\/.*$/gm, '$1');
const FOLD = strip(readFileSync('src/app/(protected)/hisoblash/[id]/calc-actions.tsx', 'utf8'));
const SERVICE = strip(readFileSync('src/modules/wms/calc/service.ts', 'utf8'));

describe('the Готово fold', () => {
  it('posts the typed amount raw and parses nothing itself', () => {
    expect(FOLD).toContain('amountText: amount');
    expect(FOLD).not.toContain('parseTypedMoney');
  });

  it('carries the seller’s note and the internal note as two labelled boxes', () => {
    expect(FOLD).toContain('data-testid="calc-answer-note"');
    expect(FOLD).toContain('data-testid="calc-answer-internal"');
    expect(FOLD).toContain('internalNote');
  });

  it('the server is the one parse, and refuses in the agreed order', () => {
    const finish = SERVICE.slice(
      SERVICE.indexOf('export async function finishCalcRequest('),
      SERVICE.indexOf('export async function completeCalcForDeal('),
    );
    expect(finish).toContain('parseTypedMoney(');
    const order = ['already_closed', 'seal_instead', 'answer_amount_required', 'answer_amount_unreadable', 'answer_positive', 'internal_note_required'];
    const at = order.map((code) => finish.indexOf(`'${code}'`));
    for (const [i, pos] of at.entries()) expect(pos, order[i]).toBeGreaterThan(-1);
    expect([...at].sort((a, b) => a - b)).toEqual(at);
  });
});
