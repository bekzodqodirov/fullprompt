import 'dotenv/config';
import { pgClient } from '../src/modules/platform/db/client';

/**
 * The finance audit's READ-ONLY checks for money already stored wrong
 * (2026-09-25). The doors are fixed; nothing here repairs a row — money is
 * corrected only by void and re-entry, by the person who knows which half of
 * a row is true. This prints the candidates for the accountant to look at.
 *
 *   pnpm money-suspects
 *
 * Runs inside a READ ONLY transaction, so it cannot write even by mistake.
 *
 *   U28 — an amount typed «1,200» was stored 1.2 (the comma became a decimal
 *         point) on the expense, template, transfer, kassa-opening, partner
 *         and settlement doors. Suspects: so'm rows under 1,000 and dollar
 *         rows under 10 with cents; tills whose opening was wiped to 0 by an
 *         edit (the old `|| 0`).
 *   U29 — a till whose currency was edited after money named it; rows whose
 *         own currency differs from their till's.
 *   U06 — a non-cash kind (depreciation) naming a kassa or a payer.
 *   U21 — money rows dated after tomorrow (Tashkent).
 */
const CHECKS: { title: string; query: string }[] = [
  {
    title: 'U28 · expenses that look like «1,200» read as 1.2',
    query: `
      SELECT e.id, e.expense_date AS day, e.amount, e.currency, c.name AS kind, e.note
        FROM expenses e JOIN expense_categories c ON c.id = e.category_id
       WHERE e.voided_at IS NULL
         AND ((e.currency = 'UZS' AND e.amount < 1000)
           OR (e.currency = 'USD' AND e.amount < 10 AND e.amount <> round(e.amount)))
       ORDER BY e.expense_date DESC`,
  },
  {
    title: 'U28 · active recurring templates that look like «1,200» read as 1.2',
    query: `
      SELECT r.id, r.day_of_month, r.amount, r.currency, c.name AS kind, r.note
        FROM recurring_expenses r JOIN expense_categories c ON c.id = r.category_id
       WHERE r.active
         AND ((r.currency = 'UZS' AND r.amount < 1000)
           OR (r.currency = 'USD' AND r.amount < 10 AND r.amount <> round(r.amount)))`,
  },
  {
    title: 'U28 · transfers with a side that looks like «1,200» read as 1.2',
    query: `
      SELECT t.id, t.transfer_date AS day, t.amount_from, fa.currency AS from_ccy, t.amount_to, ta.currency AS to_ccy, t.note
        FROM account_transfers t
        JOIN money_accounts fa ON fa.id = t.from_account_id
        JOIN money_accounts ta ON ta.id = t.to_account_id
       WHERE t.voided_at IS NULL
         AND ((fa.currency = 'UZS' AND t.amount_from < 1000)
           OR (ta.currency = 'UZS' AND t.amount_to < 1000)
           OR (fa.currency = 'USD' AND t.amount_from < 10 AND t.amount_from <> round(t.amount_from))
           OR (ta.currency = 'USD' AND t.amount_to < 10 AND t.amount_to <> round(t.amount_to)))
       ORDER BY t.transfer_date DESC`,
  },
  {
    title: 'U28 · partner rows (incl. settlement legs) that look like «1,200» read as 1.2',
    query: `
      SELECT pt.id, pt.tx_date AS day, p.name AS partner, pt.type, pt.amount, pt.currency, pt.note
        FROM partner_transactions pt JOIN partners p ON p.id = pt.partner_id
       WHERE pt.voided_at IS NULL
         AND pt.type IN ('payment', 'receipt', 'adjust', 'offset')
         AND ((pt.currency = 'UZS' AND abs(pt.amount) < 1000)
           OR (pt.currency = 'USD' AND abs(pt.amount) < 10 AND pt.amount <> round(pt.amount)))
       ORDER BY pt.tx_date DESC`,
  },
  {
    title: 'U28 · tills whose opening an edit wiped to 0 (an earlier save said otherwise)',
    query: `
      WITH h AS (
        SELECT entity_id, created_at, (after->>'openingBalance') AS opening,
               lag(after->>'openingBalance') OVER (PARTITION BY entity_id ORDER BY created_at) AS previous
          FROM audit_log WHERE entity_type = 'money_account')
      SELECT ma.name, ma.currency, h.previous AS opening_before, h.opening AS opening_after, h.created_at AS edited_at
        FROM h JOIN money_accounts ma ON ma.id = h.entity_id
       WHERE h.previous IS NOT NULL AND h.previous::numeric <> 0 AND h.opening::numeric = 0
       ORDER BY h.created_at DESC`,
  },
  {
    title: 'U29 · tills whose currency was changed after birth',
    query: `
      WITH h AS (
        SELECT entity_id, created_at, after->>'currency' AS currency,
               lag(after->>'currency') OVER (PARTITION BY entity_id ORDER BY created_at) AS previous
          FROM audit_log WHERE entity_type = 'money_account')
      SELECT ma.name, h.previous AS was, h.currency AS became, h.created_at AS edited_at
        FROM h JOIN money_accounts ma ON ma.id = h.entity_id
       WHERE h.previous IS NOT NULL AND h.previous <> h.currency
       ORDER BY h.created_at DESC`,
  },
  {
    title: 'U29 · rows whose own currency differs from their till’s',
    query: `
      SELECT 'client_transactions' AS source, x.id, x.currency AS row_ccy, ma.name AS till, ma.currency AS till_ccy
        FROM client_transactions x JOIN money_accounts ma ON ma.id = x.account_id WHERE x.currency <> ma.currency
      UNION ALL
      SELECT 'expenses', x.id, x.currency, ma.name, ma.currency
        FROM expenses x JOIN money_accounts ma ON ma.id = x.account_id WHERE x.currency <> ma.currency
      UNION ALL
      SELECT 'partner_transactions', x.id, x.currency, ma.name, ma.currency
        FROM partner_transactions x JOIN money_accounts ma ON ma.id = x.account_id WHERE x.currency <> ma.currency
      UNION ALL
      SELECT 'recurring_expenses', x.id, x.currency, ma.name, ma.currency
        FROM recurring_expenses x JOIN money_accounts ma ON ma.id = x.account_id WHERE x.currency <> ma.currency`,
  },
  {
    title: 'U06 · non-cash kinds naming a kassa or a payer (live expenses)',
    query: `
      SELECT c.name AS kind, count(*) AS rows, sum(e.amount_usd) AS usd
        FROM expenses e JOIN expense_categories c ON c.id = e.category_id
       WHERE NOT c.cash AND e.voided_at IS NULL AND (e.account_id IS NOT NULL OR e.partner_id IS NOT NULL)
       GROUP BY c.name`,
  },
  {
    title: 'U06 · non-cash kinds naming a kassa or a payer (active templates)',
    query: `
      SELECT c.name AS kind, count(*) AS templates
        FROM recurring_expenses r JOIN expense_categories c ON c.id = r.category_id
       WHERE NOT c.cash AND r.active AND (r.account_id IS NOT NULL OR r.partner_id IS NOT NULL)
       GROUP BY c.name`,
  },
  {
    title: 'U21 · money rows dated after tomorrow (Tashkent)',
    query: `
      WITH bound AS (SELECT ((now() AT TIME ZONE 'Asia/Tashkent')::date + 1) AS latest)
      SELECT 'expenses' AS source, x.id, x.expense_date AS day, x.amount, x.currency
        FROM expenses x, bound WHERE x.voided_at IS NULL AND x.expense_date > bound.latest
      UNION ALL
      SELECT 'cost_entries', x.id, x.cost_date, x.amount, x.currency
        FROM cost_entries x, bound WHERE x.voided_at IS NULL AND x.cost_date > bound.latest
      UNION ALL
      SELECT 'account_transfers', x.id, x.transfer_date, x.amount_from, NULL
        FROM account_transfers x, bound WHERE x.voided_at IS NULL AND x.transfer_date > bound.latest
      UNION ALL
      SELECT 'partner_transactions', x.id, x.tx_date, x.amount, x.currency
        FROM partner_transactions x, bound WHERE x.voided_at IS NULL AND x.tx_date > bound.latest
      UNION ALL
      SELECT 'client_transactions', x.id, x.tx_date, x.amount, x.currency
        FROM client_transactions x, bound WHERE x.voided_at IS NULL AND x.tx_date > bound.latest
      ORDER BY day DESC`,
  },
];

async function main() {
  await pgClient.begin('read only', async (tx) => {
    for (const check of CHECKS) {
      const rows = await tx.unsafe(check.query);
      console.log(`\n== ${check.title}: ${rows.length}`);
      for (const row of rows.slice(0, 50)) console.log('  ', JSON.stringify(row));
      if (rows.length > 50) console.log(`   … and ${rows.length - 50} more`);
    }
  });
  console.log('\nREAD ONLY — nothing was changed. Correct a real one by void and re-entry.');
}

main()
  .catch((err) => {
    console.error(err);
    process.exitCode = 1;
  })
  .finally(() => pgClient.end());
