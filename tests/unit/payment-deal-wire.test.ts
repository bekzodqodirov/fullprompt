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

  // U30: the three-cornered settlement writes a CLIENT payment too, and until
  // it could name a job it paid a deferral off on paper while the gate went
  // on excusing unrelated debt — #531's hole on the one door it had not
  // reached. The same two halves, plus the list the select is filled from.
  it('the settlement form posts dealId from the ledger\u2019s own deal list', () => {
    const form = readFileSync('src/app/(protected)/kontragentlar/hisob/settlement-form.tsx', 'utf8');
    expect(form).toContain('name="dealId"');
    expect(form).toContain('/api/deals/ledger?client=');
    const route = readFileSync('src/app/api/deals/ledger/route.ts', 'utf8');
    expect(route).toContain("actor?.permissions.has('finance.manage')");
    expect(route).toContain('ledgerDealsForClient(client.data)');
  });

  it('the settlement action parses dealId', () => {
    const action = readFileSync('src/app/(protected)/kontragentlar/actions.ts', 'utf8');
    expect(action).toContain("dealId: formData.get('dealId')");
  });
});
