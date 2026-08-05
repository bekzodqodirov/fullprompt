import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';

/**
 * The wire between the payment form and the deferral gate.
 *
 * `deferredBalanceUsd` (#251) nets a deferred deal's charges against the
 * payments that NAME the deal — by `client_transactions.deal_id`. For four
 * rounds the service supported that column and no form could send it: the
 * action parsed batchId and accountId but not dealId, so every production
 * payment landed with deal_id NULL, the netting branch was dead code on real
 * data, and a paid-off deferral went on opening the handover gate for
 * unrelated debt. The integration test passed the whole time, because it
 * hand-crafted the row through the service — proving the service, not the
 * system.
 *
 * These are source-shape assertions (the chat-controls precedent): the FORM
 * must post the field, the ACTION must parse it. Either half missing is the
 * same silent hole again.
 */
describe('a payment can name its deal, end to end', () => {
  it('the ledger form posts dealId', () => {
    const form = readFileSync('src/app/(protected)/finance/[clientId]/tx-form.tsx', 'utf8');
    expect(form).toContain('name="dealId"');
  });

  it('the action parses dealId', () => {
    const action = readFileSync('src/app/(protected)/finance/actions.ts', 'utf8');
    expect(action).toContain("dealId: formData.get('dealId')");
  });
});
