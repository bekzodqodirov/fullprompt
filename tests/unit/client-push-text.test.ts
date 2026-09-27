import { describe, expect, it } from 'vitest';
import { clientLabels, stageLabel } from '@/modules/platform/telegram/client-labels';
import { htmlToPlain } from '@/modules/platform/telegram/format';
import type { SendResult } from '@/modules/platform/telegram/send';
import { pushVerdict } from '@/modules/wms/notices/client-push';
import {
  boxesText,
  issuedText,
  receivedText,
  stepSummaryLine,
  type IssuedSummary,
  type ReceivedSummary,
} from '@/modules/wms/notices/client-text';

/**
 * Round C's pushes, the parts that are decisions rather than wording: which
 * title, which step, which ending, which verdict for the row. The facts the
 * old tests pinned (code, names, totals) are in `client-cabinet-text.test.ts`
 * and `arrival-notice-text.test.ts`.
 */

const plain = (html: string) => htmlToPlain(html);
const NBSP = ' ';

const RECEIVED: ReceivedSummary = {
  clientCode: 'GS777',
  receiptNumber: 'YW-IN-260927-001',
  warehouseName: 'Yiwu',
  receivedAt: new Date('2026-09-27T05:00:00Z'),
  stage: 'cn_warehouse',
  lines: [{ lotId: 'lot-a', letter: 'A', name: 'Kurtka', boxCount: 3, weightKg: 12845.5, volumeM3: 1.25 }],
};

describe('«qabul qilindi» knows where the cargo is when it is SENT', () => {
  it('still in China: the received title, the first square and what happens next', () => {
    const t = clientLabels('uz');
    const html = receivedText(RECEIVED, 'uz');
    const text = plain(html);
    expect(text.startsWith(t.arrivedTitle)).toBe(true);
    expect(text).toContain(`🟩⬜⬜⬜⬜ ${t.msChina}`);
    expect(text).toContain(t.pushNextReceived);
    // The customer's own reference, copyable.
    expect(html).toContain(`${t.pushReceiptNo}: <code>YW-IN-260927-001</code>`);
    // «27.09.2026» in Tashkent, the warehouse by name.
    expect(text).toContain('GS777 · Yiwu · 27.09.2026');
  });

  it('cargo claimed after it left China is «added to your cabinet», on its real step', () => {
    // Judge REL-9/STATE-2: unclaimed cargo given its owner weeks later must
    // not be announced as just received with «next: loaded onto a truck».
    const t = clientLabels('uz');
    const text = plain(receivedText({ ...RECEIVED, stage: 'in_uz' }, 'uz'));
    expect(text.startsWith(t.pushAddedTitle)).toBe(true);
    expect(text).not.toContain(t.arrivedTitle);
    expect(text).toContain(`🟩🟩🟩⬜⬜ ${t.msUz}`);
    expect(text).toContain(stageLabel('in_uz', t));
    expect(text).not.toContain(t.pushNextReceived);
  });

  it('FRESH is a fact about the cargo, not the rung (PA-1)', () => {
    const t = clientLabels('uz');
    // A customer who brings goods to Tashkent: received, at step three, with
    // no «next: loaded onto a truck» about cargo that has already arrived.
    const walkIn = plain(receivedText({ ...RECEIVED, stage: 'in_uz', fresh: true }, 'uz'));
    expect(walkIn.startsWith(t.arrivedTitle)).toBe(true);
    expect(walkIn).toContain(`🟩🟩🟩⬜⬜ ${t.msUz}`);
    expect(walkIn).not.toContain(t.pushNextReceived);
    expect(walkIn).not.toContain(t.pushAddedTitle);
    // Received in China long ago and given its owner only now: «added», even
    // while it still stands in China.
    const late = plain(receivedText({ ...RECEIVED, stage: 'cn_warehouse', fresh: false }, 'uz'));
    expect(late.startsWith(t.pushAddedTitle)).toBe(true);
    expect(late).not.toContain(t.pushNextReceived);
  });

  it('a long name is cut on a whole character, never inside an emoji (PA-3)', () => {
    const name = `${'x'.repeat(78)}😀tail`;
    const html = receivedText({ ...RECEIVED, lines: [{ ...RECEIVED.lines[0]!, name }] }, 'uz');
    expect(/[\uD800-\uDBFF](?![\uDC00-\uDFFF])/.test(html), 'a lone high surrogate').toBe(false);
  });

  it('a rung whose sentence IS the step is not said twice', () => {
    // Found by reading the rendered push: «🟩🟩🟩🟩⬜ Olib ketishga tayyor» and
    // then «Olib ketishga tayyor ✅» on the next line.
    const t = clientLabels('uz');
    const text = plain(receivedText({ ...RECEIVED, stage: 'ready' }, 'uz'));
    expect(text).toContain(`🟩🟩🟩🟩⬜ ${t.msReady}`);
    expect(text.split(t.msReady).length - 1).toBe(1);
  });

  it('numbers are grouped the way a person reads them, boxes counted in the customer’s grammar', () => {
    const text = plain(receivedText(RECEIVED, 'ru'));
    expect(text).toContain(`12${NBSP}845.5`);
    expect(text).toContain('3 коробки');
    expect(boxesText(1, 'ru')).toBe('1 коробка');
    expect(boxesText(5, 'ru')).toBe('5 коробок');
    expect(boxesText(21, 'ru')).toBe('21 коробка');
    expect(boxesText(2, 'en')).toBe('2 boxes');
    expect(boxesText(7, 'uz')).toBe('7 quti');
  });

  it('a lot with no letter prints no empty bold', () => {
    const html = receivedText({ ...RECEIVED, lines: [{ ...RECEIVED.lines[0]!, letter: null }] }, 'uz');
    expect(html).toContain('📦 Kurtka —');
    expect(html).not.toContain('<b></b>');
  });
});

describe('«berildi» says «everything» only when it is true (judge CX-5)', () => {
  const ISSUED: IssuedSummary = {
    clientCode: 'GS777',
    warehouseName: 'Toshkent 1',
    issuedAt: new Date('2026-09-27T06:00:00Z'),
    boxCount: 2,
    personName: 'Aziz <aka>',
    leftHere: 0,
    elsewhere: null,
    lines: [{ lotId: 'lot-a', letter: 'A', name: 'Kurtka', boxCount: 2, weightKg: 10, volumeM3: 0.1 }],
  };
  const none = { china: 0, transit: 0, uz: 0, ready: 0, issued: 0 };

  it('cargo left at this warehouse: says how much', () => {
    const t = clientLabels('uz');
    const text = plain(issuedText({ ...ISSUED, leftHere: 3 }, 'uz'));
    expect(text).toContain(`${t.issuedLeft}: 3 quti`);
    expect(text).not.toContain(t.pushAllIssued);
    expect(text).not.toContain(t.pushHereIssued);
  });

  it('nothing left here but a truck on the road: THIS warehouse is done, and where the rest is', () => {
    const t = clientLabels('uz');
    const text = plain(issuedText({ ...ISSUED, elsewhere: { ...none, transit: 180, china: 40 } }, 'uz'));
    expect(text).toContain(t.pushHereIssued);
    expect(text).toContain(`${t.sumTransit}: 180 · ${t.sumChina}: 40`);
    expect(text).not.toContain(t.pushAllIssued);
    expect(text).not.toContain('🟩🟩🟩🟩🟩');
  });

  it('nothing active anywhere: the whole bar green', () => {
    const t = clientLabels('uz');
    for (const elsewhere of [null, none, { ...none, issued: 12 }]) {
      const text = plain(issuedText({ ...ISSUED, elsewhere }, 'uz'));
      expect(text).toContain(`🟩🟩🟩🟩🟩 ${t.pushAllIssued}`);
    }
  });

  it('the receiver typed at the counter is escaped', () => {
    const html = issuedText(ISSUED, 'uz');
    expect(html).toContain('Aziz &lt;aka&gt;');
    expect(html).not.toContain('<aka>');
  });

  it('the summary line lists only non-zero steps, nearest the customer first', () => {
    const t = clientLabels('uz');
    expect(stepSummaryLine({ ...none, china: 1, ready: 2, uz: 3 }, 'uz')).toBe(
      `${t.sumReady}: 2 · ${t.sumUz}: 3 · ${t.sumChina}: 1`,
    );
    expect(stepSummaryLine(none, 'uz')).toBe('');
  });
});

function result(over: Partial<SendResult>): SendResult {
  return {
    ok: false,
    status: 0,
    description: '',
    messageId: null,
    retryAfter: null,
    permanent: false,
    botDown: false,
    usedFallback: false,
    ...over,
  };
}

describe('what the sweep does with a notice after every chat', () => {
  const ok = result({ ok: true, status: 200, messageId: 1 });
  const blocked = result({ status: 403, permanent: true, description: 'Forbidden: bot was blocked by the user' });
  const busy = result({ status: 502 });
  const limited = result({ status: 429, retryAfter: 17 });
  const tokenGone = result({ status: 401, botDown: true });

  it('one reached chat is the person reached', () => {
    expect(pushVerdict([blocked, ok]).kind).toBe('sent');
  });

  it('a refused TOKEN outranks everything — nothing else will go either', () => {
    expect(pushVerdict([tokenGone])).toMatchObject({ kind: 'botDown', delivered: false });
    expect(pushVerdict([ok, tokenGone])).toMatchObject({ kind: 'botDown', delivered: true });
  });

  it('a 429 is a wait with its own length, never an attempt', () => {
    expect(pushVerdict([limited])).toMatchObject({ kind: 'defer', retryAfter: 17 });
    expect(pushVerdict([blocked, limited]).kind).toBe('defer');
  });

  it('given up only when EVERY refusal is about the recipient', () => {
    expect(pushVerdict([blocked]).kind).toBe('failed');
    expect(pushVerdict([blocked, busy]).kind).toBe('retry');
    expect(pushVerdict([busy]).kind).toBe('retry');
  });
});

describe('the push prints kilos the way the app it opens does (round C review)', () => {
  it('a partial lot reads two places, as every cabinet surface rounds it', async () => {
    const { kgText } = await import('@/modules/wms/notices/client-text');
    // 3 of 7 boxes of a 10 kg lot. The Mini App's lot card and handover
    // history both say 4.29 — the first fix printed 4.286 here and created the
    // very mismatch it named.
    expect(kgText((10 * 3) / 7)).toBe('4.29');
  });

  it('every customer surface shares and rounds through the one helper, never inline', async () => {
    const { readFileSync } = await import('node:fs');
    for (const file of [
      'src/modules/wms/client-cabinet/service.ts',
      'src/modules/wms/client-cabinet/miniapp.ts',
      'src/modules/wms/client-cabinet/map.ts',
      'src/modules/wms/notices/client-text.ts',
      'src/modules/wms/notices/client-summary.ts',
      'src/modules/wms/notices/arrival.ts',
    ]) {
      const src = readFileSync(file, 'utf8').replace(/\/\*[\s\S]*?\*\/|\/\/.*$/gm, '');
      // An inline `* 100) / 100` on a weight or `* 1000) / 1000` on a volume,
      // or a generic `10 ** d` rounder, is a second rule that drifts from
      // `roundKg`/`roundM3` — the map printed 5.7 beside the header's 5.71.
      expect(src, file).not.toMatch(/(weight|kg|volume|m3)[^\n;]*\*\s*100\)\s*\/\s*100/i);
      expect(src, file).not.toMatch(/(weight|kg|volume|m3)[^\n;]*\*\s*1000\)\s*\/\s*1000/i);
      expect(src, file).not.toMatch(/\*\s*10\s*\*\*/);
      // A share computed any other way than `shareOf` lands on the other side
      // of a half-hundredth (10.1 kg, 7 of 20: 3.53 against 3.54).
      expect(src, file).not.toMatch(/\*\s*share\b|\bshare\s*\*/);
      expect(src, file).not.toMatch(/perBox(Kg|M3)\b[^\n;]*\*|\*[^\n;]*perBox(Kg|M3)/);
      // …nor `lotKg * (n / boxes)`, the push's old shape written inline.
      expect(src, file).not.toMatch(/(Kg|M3|kg|m3)[^\n;]*\*\s*\([^()\n]*\/[^()\n]*\)/);
      expect(src, file).toMatch(/\b(roundKg|shareOf)\b/);
    }
  });

  it('a whole lot is its typed total, exactly; a part is total × n ÷ boxes', async () => {
    const { shareOf } = await import('@/modules/platform/telegram/format');
    expect(shareOf(0.1125, 9, 9)).toBe(0.1125);
    expect(shareOf(0.0945, 12, 12)).toBe(0.0945);
    expect(shareOf(1.5, 3, 20)).toBe((1.5 * 3) / 20);
    expect(shareOf(10, 3, 0)).toBe(0);
  });

  it('a total is the sum of the lines as printed — 0.095 + 0.095 is 0.19, not 0.189', async () => {
    const { measuresOf } = await import('@/modules/wms/notices/client-text');
    const line = { lotId: 'x', letter: 'A', name: 'x', boxCount: 2, weightKg: 0, volumeM3: 0.0945 };
    expect(measuresOf([line, { ...line, lotId: 'y' }]).volumeM3).toBe(0.19);
  });

});
