import { describe, expect, it } from 'vitest';
import { renderTelegramText } from '@/modules/platform/notifications/service';
import { notificationLabels } from '@/modules/platform/notifications/labels';
import { approvalCounts } from '@/modules/wms/reports/dashboard-math';

/**
 * One approval asks two questions since 0104 (a debt, cartons with no price).
 * The Telegram a decider reads must name the question it asks: a price-only
 * request never reads «Qarz: $0.00», in any language — and an event written
 * before 0104 (no `reasons`) renders exactly as it always did.
 */
const LOCALES = ['ru', 'uz', 'zh-CN', 'en'] as const;
const base = {
  approvalId: 'a1',
  clientId: 'c1',
  clientCode: 'GS301',
  clientName: 'Aziz',
  warehouseCode: 'TAS1',
  requestedByName: 'Operator',
  note: null,
};

describe('DebtApprovalRequested wording', () => {
  for (const locale of LOCALES) {
    it(`${locale}: a price-only request carries no debt line and names the prixods`, () => {
      const L = notificationLabels(locale);
      const text = renderTelegramText(
        'DebtApprovalRequested',
        {
          ...base,
          blockingDebtUsd: 0,
          reasons: 'price',
          unpriced: [{ number: 'R-1234', trucks: 'YW-013', boxes: 3 }],
          unpricedMore: 0,
        },
        locale,
      );
      expect(text).not.toContain(L.debtLine);
      expect(text).toContain(L.unpricedApprovalRequested);
      expect(text).toContain('R-1234 (YW-013) · 3');
    });

    it(`${locale}: an event from before 0104 renders byte-identical to the old wording`, () => {
      const L = notificationLabels(locale);
      const appUrl = process.env.APP_URL ?? '';
      const text = renderTelegramText('DebtApprovalRequested', { ...base, blockingDebtUsd: 250 }, locale);
      expect(text).toBe(
        `🔐 ${L.debtApprovalRequested}\n` +
          `${L.client}: GS301 (Aziz) · ${L.warehouse} TAS1\n` +
          `${L.debtLine}: $250\n` +
          `${L.requestedByWord}: Operator` +
          `\n\n${appUrl}/approvals`,
      );
    });

    it(`${locale}: both questions carry the debt line and the combined title`, () => {
      const L = notificationLabels(locale);
      const text = renderTelegramText(
        'DebtApprovalRequested',
        { ...base, blockingDebtUsd: 70, reasons: 'both', unpriced: [{ number: 'R-9', trucks: '', boxes: 1 }] },
        locale,
      );
      expect(text).toContain(L.issueApprovalRequested);
      expect(text).toContain(`${L.debtLine}: $70`);
    });
  }

  it('the answer names the question it answered', () => {
    const L = notificationLabels('uz');
    const answer = (reasons?: string) =>
      renderTelegramText('DebtApprovalDecided', { verdict: 'approved', clientCode: 'GS1', clientName: 'X', decidedByName: 'Y', reasons }, 'uz');
    expect(answer('price')).toContain(L.priceApprovalYes);
    expect(answer('both')).toContain(L.issueApprovalYes);
    expect(answer()).toContain(L.debtApprovalYes);
  });
});

describe('approvalCounts — the dashboard’s two approval rows', () => {
  it('counts each question only where it is asked, and a both-question row in both', () => {
    expect(
      approvalCounts([
        { blockingDebtUsd: '500.00', unpricedBoxIds: [] },
        { blockingDebtUsd: '0.00', unpricedBoxIds: ['b1'] },
        { blockingDebtUsd: 200, unpricedBoxIds: ['b2', 'b3'] },
      ]),
    ).toEqual({ debt: { n: 2, usd: 700 }, price: { n: 2 } });
  });
});
