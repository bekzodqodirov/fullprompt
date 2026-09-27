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
