import { globSync, readFileSync } from 'node:fs';
import path from 'node:path';
import { describe, expect, it } from 'vitest';
import {
  accountSchema,
  expenseSchema,
  recurringPatchSchema,
  recurringSchema,
  transferSchema,
} from '@/modules/wms/accounting/service';
import { expenseRequestSchema } from '@/modules/wms/accounting/expense-requests';
import { payRecurringSchema } from '@/modules/wms/accounting/recurring';
import { costEntrySchema, receiptCostGridSchema } from '@/modules/wms/costing/service';
import { createCrateSchema } from '@/modules/wms/crates/service';
import { refundFitsAdvance, transactionSchema } from '@/modules/wms/finance/service';
import { amountRefusal, exceedsRowUsd, MAX_NATIVE_AMOUNT, MAX_ROW_USD } from '@/modules/wms/finance/money-bounds';
import { partnerTxSchema } from '@/modules/wms/partners/service';
import { settlementSchema } from '@/modules/wms/partners/settlement';
import { extraCostSchema } from '@/modules/wms/receipts/service';

/**
 * The finance audit's DOORS (U21/U28/U29/U30/U33/U34/U44/U06) — the halves an
 * integration test cannot press because the action calls `authorize` (#531).
 * The service halves are proven in money-doors.integration.test.ts. Comments
 * are stripped first, or a fence matches the sentence explaining itself
 * (#725).
 */
const ROOT = path.resolve(__dirname, '../..');
const strip = (text: string) =>
  text.replace(/\/\*[\s\S]*?\*\//g, '').replace(/(^|[^:])\/\/.*$/gm, '$1');
const read = (rel: string) => strip(readFileSync(path.join(ROOT, rel), 'utf8'));
const slice = (text: string, from: string, to?: string) => {
  const start = text.indexOf(from);
  expect(start, `${from} not found`).toBeGreaterThanOrEqual(0);
  const end = to ? text.indexOf(to, start + from.length) : text.length;
  return text.slice(start, end < 0 ? text.length : end);
};

const UUID = '01a0d800-6812-758a-a09e-40582dfc7ecb';
const DAY = '2026-09-25';

describe('U28 — every typed amount on a money form is read the office\'s way', () => {
  /**
   * DERIVED: every `inputMode="decimal"` input with a name, on every form
   * under the money screens, posts to an action that reads that name through
   * `parseTypedMoney` — directly, or through a local reader whose body calls
   * it. A new form or a new field cannot slip back to `Number(...replace(',', '.'))`,
   * which read «1,200» as 1.2 and «12,500,000» as NaN.
   */
  const FORM_DIRS = ['accounting', 'kontragentlar', 'finance'];
  const forms = FORM_DIRS.flatMap((dir) => globSync(`src/app/(protected)/${dir}/**/*.tsx`, { cwd: ROOT }));

  it('finds the money forms', () => {
    expect(forms.length).toBeGreaterThan(8);
  });

  it('each posted decimal field is read through the shared reader', () => {
    const unread: string[] = [];
    let checked = 0;
    for (const form of forms) {
      const source = read(form);
      const names = [...source.matchAll(/<input\b[^>]*?\/>/gs)]
        .map((m) => m[0])
        .filter((tag) => tag.includes('inputMode="decimal"'))
        .map((tag) => /\bname="([^"]+)"/.exec(tag)?.[1])
        .filter((name): name is string => Boolean(name));
      if (names.length === 0) continue;
      const imported = /from '(\.{1,2}(?:\/\.\.)*\/actions)'/.exec(source)?.[1];
      expect(imported, `${form} posts decimal fields but imports no actions module`).toBeTruthy();
      const actionPath = path.join(path.dirname(form), `${imported}.ts`);
      const action = read(actionPath);
      // A reader: `parseTypedMoney` itself, or a local function/arrow whose
      // own definition calls it.
      const readers = new Set(['parseTypedMoney']);
      for (const def of action.matchAll(/(?:function\s+(\w+)|const\s+(\w+)\s*=\s*\()[\s\S]*?(?=\n(?:export |function |const |async function |\/\*\*)|$)/g)) {
        const name = def[1] ?? def[2];
        if (name && def[0].includes('parseTypedMoney(')) readers.add(name);
      }
      for (const name of names) {
        const gets = [...action.matchAll(new RegExp(`\\.get\\('${name}'\\)`, 'g'))];
        expect(gets.length, `${form}: ${name} is never read by ${actionPath}`).toBeGreaterThan(0);
        for (const hit of gets) {
          const lineStart = action.lastIndexOf('\n', hit.index!) + 1;
          const lineEnd = action.indexOf('\n', hit.index!);
          const line = action.slice(lineStart, lineEnd < 0 ? undefined : lineEnd);
          const before = action.slice(lineStart, hit.index!);
          const viaReader = [...readers].some((reader) => new RegExp(`\\b${reader}\\(`).test(before));
          const assigned = /const\s+(\w+)\s*=/.exec(line)?.[1];
          const viaVariable = assigned !== undefined && new RegExp(`parseTypedMoney\\(\\s*${assigned}\\s*\\)`).test(action);
          checked += 1;
          if (!viaReader && !viaVariable) unread.push(`${form} → ${actionPath}: ${name}`);
        }
      }
    }
    expect(checked).toBeGreaterThan(8);
    expect(unread, 'a money field read around parseTypedMoney').toEqual([]);
  });

  it('both audited action files import the shared reader', () => {
    for (const file of ['src/app/(protected)/accounting/actions.ts', 'src/app/(protected)/kontragentlar/actions.ts']) {
      expect(read(file), file).toContain("import { parseTypedMoney } from '@/modules/wms/calc/money-input';");
    }
  });

  it('an EMPTY opening is 0 and an unreadable one is refused, not stored as 0 over a real figure', () => {
    const action = slice(read('src/app/(protected)/accounting/actions.ts'), 'export async function saveAccountAction');
    expect(action).toContain("openingBalance: opening === '' ? 0 : (parseTypedMoney(opening) ?? Number.NaN),");
    expect(action).not.toMatch(/openingBalance:[^\n]*\|\| 0/);
  });

  it('the browser-side money readers outside the cluster use it too', () => {
    const doors: [string, RegExp][] = [
      ['src/app/(protected)/receive/expense-request-fold.tsx', /amount: parseTypedMoney\(amount\) \?\? Number\.NaN/],
      ['src/components/calc-offer.tsx', /const typed = parseTypedMoney\(price\) \?\? Number\.NaN;/],
      ['src/app/(protected)/hisoblash/[id]/calc-workspace.tsx', /amountUsd: parseTypedMoney\(amount\) \?\? Number\.NaN/],
      ['src/app/(protected)/hisoblash/[id]/calc-workspace.tsx', /discountUsd: discount\.trim\(\) === '' \? 0 : \(parseTypedMoney\(discount\) \?\? Number\.NaN\)/],
      ['src/app/(protected)/receive/receive-wizard.tsx', /amount: parseTypedMoney\(c\.amount\) \?\? Number\.NaN/],
      ['src/app/(protected)/bitimlar/actions.ts', /quotedAmount: optionalMoney\(form\.get\('quotedAmount'\)\)/],
      ['src/app/(protected)/crm/actions.ts', /quotedAmount: optionalMoney\(formData\.get\('quotedAmount'\)\)/],
    ];
    for (const [file, shape] of doors) expect(read(file), file).toMatch(shape);
  });

  it('the rasxod fold greys its button with the SAME reader it sends with', () => {
    // Review of wc: the send parsed «1 200» as 1200 while the button asked
    // `Number(amount.replace(',', '.'))` — NaN — so a warehouse person typing
    // the amount the way every other money box accepts it had a grey button
    // and no sentence saying why.
    const fold = read('src/app/(protected)/receive/expense-request-fold.tsx');
    expect(fold).not.toMatch(/Number\(amount/);
    expect(fold).toMatch(/disabled=\{[^}]*\(parseTypedMoney\(amount\) \?\? 0\) > 0/);
  });
});

describe('U44 — one bound for a native amount, the ceiling in dollars', () => {
  const BIG_SOM = 1_500_000_000; // ≈ $120k — refused by every door before
  const PAST_COLUMN = 1e12;

  const doors: [string, (amount: number) => { success: boolean }][] = [
    ['expense', (amount) => expenseSchema.safeParse({ categoryId: UUID, amount, currency: 'UZS', expenseDate: DAY })],
    ['recurring', (amount) => recurringSchema.safeParse({ categoryId: UUID, amount, currency: 'UZS' })],
    ['recurring patch', (amount) => recurringPatchSchema.safeParse({ amount, dayOfMonth: 5, active: true })],
    ['recurring pay', (amount) => payRecurringSchema.safeParse({ recurringId: UUID, month: '2026-09', amount, expenseDate: DAY })],
    ['transfer', (amount) => transferSchema.safeParse({ fromAccountId: UUID, toAccountId: UUID, amountFrom: amount, amountTo: amount, transferDate: DAY })],
    ['client ledger', (amount) => transactionSchema.safeParse({ clientId: UUID, type: 'payment', amount, currency: 'UZS', txDate: DAY })],
    ['cost', (amount) => costEntrySchema.safeParse({ scope: 'receipt', receiptId: UUID, costTypeId: UUID, amount, currency: 'UZS', costDate: DAY, allocationBasis: 'weight' })],
    ['cost kassa side', (amount) => costEntrySchema.safeParse({ scope: 'receipt', receiptId: UUID, costTypeId: UUID, amount: 1, currency: 'USD', costDate: DAY, allocationBasis: 'weight', accountId: UUID, accountAmount: amount })],
    ['grid cell', (amount) => receiptCostGridSchema.safeParse({ batchId: UUID, currency: 'UZS', costDate: DAY, cells: [{ receiptId: UUID, costTypeId: UUID, amount }] })],
    ['partner', (amount) => partnerTxSchema.safeParse({ partnerId: UUID, type: 'payment', amount, currency: 'UZS', txDate: DAY, accountId: UUID })],
    ['settlement client side', (amount) => settlementSchema.safeParse({ txId: UUID, clientId: UUID, partnerId: UUID, clientAmount: amount, clientCurrency: 'UZS', partnerAmount: 1, partnerCurrency: 'USD', txDate: DAY })],
    ['settlement firm side', (amount) => settlementSchema.safeParse({ txId: UUID, clientId: UUID, partnerId: UUID, clientAmount: 1, clientCurrency: 'USD', partnerAmount: amount, partnerCurrency: 'UZS', txDate: DAY })],
    ['rasxod xabari', (amount) => expenseRequestSchema.safeParse({ id: UUID, amount, currency: 'UZS', note: 'taksi' })],
    ['receive extra cost', (amount) => extraCostSchema.safeParse({ costTypeId: UUID, amount, currency: 'UZS' })],
    ['crating cost', (amount) => createCrateSchema.shape.cratingCost.safeParse({ amount, currency: 'UZS' })],
    ['till opening', (amount) => accountSchema.safeParse({ name: 'Kassa', currency: 'UZS', kind: 'cash', openingBalance: amount })],
  ];

  it('every money door takes 1.5 billion so\'m and refuses a figure past its column', () => {
    for (const [name, parse] of doors) {
      expect(parse(BIG_SOM).success, `${name} refused 1.5e9`).toBe(true);
      expect(parse(PAST_COLUMN).success, `${name} took 1e12`).toBe(false);
    }
    expect(MAX_NATIVE_AMOUNT).toBe(999_999_999_999.99);
  });

  it('the signed doors are bounded BOTH ways (an adjust of −1e12 was 22003)', () => {
    const adjust = (amount: number) =>
      partnerTxSchema.safeParse({ partnerId: UUID, type: 'adjust', amount, currency: 'UZS', txDate: DAY });
    expect(adjust(-BIG_SOM).success).toBe(true);
    expect(adjust(-PAST_COLUMN).success).toBe(false);
    const opening = (openingBalance: number) =>
      accountSchema.safeParse({ name: 'Kassa', currency: 'UZS', kind: 'cash', openingBalance });
    expect(opening(-BIG_SOM).success).toBe(true);
    expect(opening(-PAST_COLUMN).success).toBe(false);
  });

  it('the typo ceiling is today\'s $1e9, asked in dollars', () => {
    expect(MAX_ROW_USD).toBe(1_000_000_000);
    expect(exceedsRowUsd(1_000_000_000)).toBe(false);
    expect(exceedsRowUsd(1_000_000_000.01)).toBe(true);
    expect(exceedsRowUsd(-1_000_000_000.01)).toBe(true);
    expect(exceedsRowUsd(Number.NaN)).toBe(true);
  });

  it('a size refusal is its own word, and only on an amount', () => {
    const big = expenseSchema.safeParse({ categoryId: UUID, amount: PAST_COLUMN, currency: 'UZS', expenseDate: DAY });
    expect(big.success).toBe(false);
    if (!big.success) expect(amountRefusal(big.error)).toBe('amount_too_large');
    const note = expenseSchema.safeParse({ categoryId: UUID, amount: 5, currency: 'UZS', expenseDate: DAY, note: 'x'.repeat(3000) });
    expect(note.success).toBe(false);
    if (!note.success) expect(amountRefusal(note.error)).toBeNull();
  });

  it('DERIVED: no amount field anywhere carries a literal per-currency cap again', () => {
    const files = [
      ...globSync('src/modules/wms/**/*.ts', { cwd: ROOT }),
      ...globSync('src/app/**/*.{ts,tsx}', { cwd: ROOT }),
    ];
    expect(files.length).toBeGreaterThan(200);
    const capped: string[] = [];
    for (const file of files) {
      const source = read(file);
      for (const line of source.split('\n')) {
        if (/(amount|balance)\w*\s*:/i.test(line) && /\.max\(\s*(1_000_000_000(_000)?|100_000_000|1e9|1e8|1e12)\s*\)/.test(line)) {
          capped.push(`${file}: ${line.trim()}`);
        }
      }
    }
    expect(capped).toEqual([]);
  });

  it('the doors say it in words: the actions map the size refusal', () => {
    for (const file of [
      'src/app/(protected)/accounting/actions.ts',
      'src/app/(protected)/kontragentlar/actions.ts',
      'src/app/(protected)/finance/actions.ts',
      'src/app/(protected)/costs/actions.ts',
      'src/app/(protected)/receive/actions.ts',
      'src/app/(protected)/profile/actions.ts',
    ]) {
      expect(read(file), file).toMatch(/amountRefusal\((parsed\.)?error\)/);
    }
    // The partner door used to hand zod's raw English to the screen.
    const partner = slice(read('src/app/(protected)/kontragentlar/actions.ts'), 'export async function addPartnerTxAction', 'export async function voidPartnerTxAction');
    expect(partner).not.toContain('parsed.error.issues[0]?.message ??');
  });
});

describe('U21 — every money form carries the door\'s own date limit', () => {
  it('the date inputs say «not after tomorrow», as the ledger form does', () => {
    for (const file of [
      'src/app/(protected)/accounting/expenses/expense-form.tsx',
      'src/app/(protected)/accounting/accounts/transfer-form.tsx',
      'src/components/cost-panel.tsx',
      'src/app/(protected)/batches/[id]/receipt-cost-grid.tsx',
      'src/app/(protected)/kontragentlar/[id]/tx-form.tsx',
      'src/app/(protected)/kontragentlar/hisob/settlement-form.tsx',
      'src/app/(protected)/upsale/pay-form.tsx',
    ]) {
      const source = read(file);
      expect(source, file).toContain('max={latestTxDate()}');
      // …and the refusal reaches the person as a sentence: a literal branch,
      // or the upsale's `calc.errors.<code>` lookup, which needs the key.
      if (file.endsWith('pay-form.tsx')) {
        expect(source).toContain('tErr.has(`errors.${result.error}`)');
        const ru = JSON.parse(readFileSync(path.join(ROOT, 'messages/ru.json'), 'utf8'));
        expect(typeof ru.calc.errors.future_date).toBe('string');
      } else {
        expect(source, file).toMatch(/future_date/);
      }
    }
  });

  it('a recurring payment obeys the date rule like every door — the monthly run and its exception are gone (owner Q6)', () => {
    // Rewritten, not deleted: this test pinned the monthly run's exemption
    // while Q6 was open. The owner answered «money leaves a kassa only when
    // the kassa holder actually pays it», the run that posted each template
    // on its own later day is deleted, and «To'landi» is dated the day the
    // money left — so the write half asks the date rule of EVERY row.
    // `!opts.recurring` catches both spellings of the old exemption (G4).
    const service = read('src/modules/wms/accounting/service.ts');
    const write = slice(service, 'export async function addExpenseTx', 'export async function addExpense(');
    expect(write).toContain('if (input.expenseDate > latestTxDate()) {');
    expect(write).not.toContain('!opts.recurring');
    expect(service).not.toContain('export async function generateRecurring');
  });
});

describe('U29 — a kassa in use keeps its currency', () => {
  it('the edit form shows the currency as text and re-posts it hidden (#171), never a disabled select', () => {
    const form = read('src/app/(protected)/accounting/accounts/account-form.tsx');
    expect(form).toContain('<input type="hidden" name="currency" value={account.currency} />');
    expect(form).not.toMatch(/name="currency"[^>]*disabled/);
    expect(form).toContain("state.error === 'currency_locked'");
    const page = read('src/app/(protected)/accounting/accounts/page.tsx');
    expect(page).toContain('tillsInUse(),');
    expect(page).toContain('inUse: inUse.has(account.id),');
  });
});

describe('U06 — a non-cash kind names no kassa and no payer', () => {
  it('both expense forms drop the two pickers for a book entry, and the page tells them which is which', () => {
    for (const file of [
      'src/app/(protected)/accounting/expenses/expense-form.tsx',
      'src/app/(protected)/accounting/expenses/recurring-form.tsx',
    ]) {
      const form = read(file);
      expect(form, file).toMatch(/\{!partnerId && !bookEntry && \(\s*<select name="accountId"/);
      expect(form, file).toMatch(/\{partners\.length > 0 && !bookEntry && \(/);
      expect(form, file).toContain("state.error === 'non_cash_category'");
    }
    const page = read('src/app/(protected)/accounting/expenses/page.tsx');
    expect(page).toContain('categories: categories.map((row) => ({ id: row.id, label: row.name, cash: row.cash })),');
  });

  it('the upsale category picker says its refusal in words, not the bare code', () => {
    const form = read('src/app/(protected)/upsale/pay-form.tsx');
    expect(form).not.toContain('{state.error}</span>');
    expect(form).toContain('data-testid="upsale-category-error"');
  });
});

describe('U13 (owner A) — the two expense doors ask for a kassa or a payer', () => {
  const action = read('src/app/(protected)/accounting/actions.ts');

  it('addExpenseAction asks it after authorize and BEFORE the rasxod xabari\u2019s claim', () => {
    const body = slice(action, 'export async function addExpenseAction', 'export async function openStaffPartnerAction');
    const ask = body.indexOf('if (await needsKassaOrPayer(parsed.data.categoryId, parsed.data)) {');
    expect(ask).toBeGreaterThan(body.indexOf("return run('finance.expenses'"));
    expect(ask).toBeLessThan(body.indexOf('await claimExpenseRequest('));
    expect(ask).toBeLessThan(body.indexOf('await addExpense('));
    expect(body).toContain("throw new AccountingError('account_or_payer_required');");
  });

  it('saveRecurringAction asks it before the template is written', () => {
    const body = slice(action, 'export async function saveRecurringAction', 'export async function updateRecurringAction');
    const ask = body.indexOf('if (await needsKassaOrPayer(parsed.data.categoryId, parsed.data)) {');
    expect(ask).toBeGreaterThan(0);
    expect(ask).toBeLessThan(body.indexOf('await saveRecurring('));
  });

  it('both forms say it in words', () => {
    for (const file of [
      'src/app/(protected)/accounting/expenses/expense-form.tsx',
      'src/app/(protected)/accounting/expenses/recurring-form.tsx',
    ]) {
      expect(read(file), file).toContain("state.error === 'account_or_payer_required'");
    }
  });
});

describe('U33 (owner b) — a kassa moved on a counterparty\u2019s card is the kassa holders\u2019', () => {
  const action = read('src/app/(protected)/kontragentlar/actions.ts');

  it('the write door refuses a payment or a receipt without the grant, before the staff door', () => {
    expect(action).toContain("return movesTill && !mayPickTill(actor.permissions) ? 'till_forbidden' : null;");
    const body = slice(action, 'export async function addPartnerTxAction', 'export async function voidPartnerTxAction');
    expect(body).toContain('tillDoor(actor, CASH_TYPES.includes(parsed.data.type)) ?? staffDoor(actor, parsed.data.partnerId)');
  });

  it('the void judges the ROW\u2019s kassa', () => {
    const body = slice(action, 'export async function voidPartnerTxAction', 'export async function recordSettlementAction');
    expect(body).toMatch(
      /tillDoor\(actor, Boolean\(row\?\.accountId\)\) \?\?\s*\(row \? await firmDebtVoidRefusal\(actor, row\) : null\) \?\?\s*staffDoor\(actor, row\?\.partnerId \?\? null\)/,
    );
  });

  it('the card offers no kassa, no cash kind and no ✕ on a cash row to a non-holder', () => {
    const page = read('src/app/(protected)/kontragentlar/[id]/page.tsx');
    expect(page).toContain('const movesTills = canManage && mayPickTill(actor.permissions);');
    expect(page).toMatch(/const accounts = movesTills\s*\?/);
    // …nor on a debt a cost or an expense wrote (review of wc): the action
    // refuses it, and a fire-and-forget ✕ that silently does nothing is worse.
    // 0103 put the system's kurs farqi row out of the ✕'s reach as well (it
    // changes only with its cycle, Q14) — one more clause, the same door.
    expect(page).toMatch(
      /canManage &&\s*!tx\.voidedAt &&\s*(?:\/\/[^\n]*\n\s*)?tx\.type !== 'fx_diff' &&\s*\(!tx\.accountId \|\| movesTills\) &&\s*\(!\(tx\.costEntryId \|\| tx\.expenseId\) \|\| movesTills\) && \(\s*<VoidTx/,
    );
    const form = read('src/app/(protected)/kontragentlar/[id]/tx-form.tsx');
    expect(form).toContain('const kinds = movesTills ? TYPES : TYPES.filter((code) => !CASH.has(code));');
    expect(form).toContain("state.error === 'till_forbidden'");
  });
});

describe('U04 (owner A) — a refund hands back an advance, never more', () => {
  it('fits: up to the advance plus the FX residue (2 % or $5, the looser), never with no advance', () => {
    expect(refundFitsAdvance(300, 300)).toBe(true);
    expect(refundFitsAdvance(301.88, 300)).toBe(true); // the same so'm after the rate moved
    expect(refundFitsAdvance(306, 300)).toBe(true); // 2 % of 300 = $6 beats $5
    expect(refundFitsAdvance(306.01, 300)).toBe(false);
    expect(refundFitsAdvance(105, 100)).toBe(true); // $5 beats 2 % of 100
    expect(refundFitsAdvance(105.01, 100)).toBe(false);
    // 125,000,000 so'm paid at 12,600 ($9,920.63) and handed back at 12,450
    // ($10,040.16): a flat $5 refused the most ordinary refund there is.
    expect(refundFitsAdvance(10040.16, 9920.63)).toBe(true);
    expect(refundFitsAdvance(10200, 9920.63)).toBe(false);
    expect(refundFitsAdvance(4, 0)).toBe(false);
    expect(refundFitsAdvance(1, -50)).toBe(false); // he owes us
  });

  it('the ledger form shows the advance beside the button and says the refusal in words', () => {
    const form = read('src/app/(protected)/finance/[clientId]/tx-form.tsx');
    expect(form).toContain("t('advanceNow', { amount: advanceUsd.toFixed(2) })");
    expect(form).toContain("state.error === 'refund_exceeds_advance'");
    const page = read('src/app/(protected)/finance/[clientId]/page.tsx');
    expect(page).toContain('advanceUsd={balance < -0.009 ? -balance : 0}');
  });

  // Rewritten with 0103 (design §5.5.7): wc's own `hashtext('refund:'…)` lock
  // became the client's ONE money lock (`lockOwnersTx`, the kurs farqi
  // reconciler's), and the USD rule became `refundFits` — native when the
  // client holds an advance in the refund's currency and owes nothing else,
  // wc's USD rule otherwise. The balance is still read on the transaction.
  it('the service checks and inserts under one per-client lock, on the transaction\u2019s own connection', () => {
    const service = read('src/modules/wms/finance/service.ts');
    const body = slice(service, 'export async function addTransaction', 'export async function placePayment');
    const lock = body.indexOf('lockOwnersTx(tx, { clientIds: [input.clientId] })');
    expect(lock).toBeGreaterThan(0);
    const held = body.indexOf('clientMoneyByCurrency(tx, input.clientId)');
    expect(held).toBeGreaterThan(lock);
    expect(body.indexOf('refundFits({ amount: input.amount, currency: input.currency, amountUsd }, held)')).toBeGreaterThan(held);
    expect(body.indexOf('tx.insert(clientTransactions)')).toBeGreaterThan(held);
    expect(body.slice(lock)).not.toContain('clientBalanceUsd(');
  });
});

describe('U33 — voiding a refund asks the grant that created it', () => {
  const action = read('src/app/(protected)/finance/actions.ts');

  it('the void door passes the kassa predicate to the service, judged there by the ROW', () => {
    const body = slice(action, 'export async function voidTransactionAction', 'export async function placePaymentAction');
    const gate = body.indexOf('{ mayMoveTill: mayPickTill(actor.permissions) }');
    expect(gate).toBeGreaterThan(body.indexOf("authorize('finance.manage')"));
    expect(gate).toBeGreaterThan(body.indexOf('await voidTransaction('));
    const service = read('src/modules/wms/finance/service.ts');
    const voidBody = slice(service, 'export async function voidTransaction', 'export async function futureDatedEntries');
    expect(voidBody).toContain("if (row.type === 'refund' && !door.mayMoveTill) throw new FinanceError('forbidden');");
    // REQUIRED, never optional — an optional door fails open.
    expect(voidBody).toContain('door: { mayMoveTill: boolean },');
  });

  it('the create door asks the same predicate (#513)', () => {
    const body = slice(action, 'export async function addTransactionAction', 'const voidSchema');
    expect(body).toContain("if (parsed.data.type === 'refund' && !mayPickTill(actor.permissions)) {");
    expect(body).not.toContain("actor.permissions.has('finance.expenses')");
  });

  it('the ledger draws the ✖ on a refund only for the kassa holders', () => {
    const page = read('src/app/(protected)/finance/[clientId]/page.tsx');
    expect(page).toContain('const canRefund = mayPickTill(actor.permissions);');
    // Q19 widened the rule from «a refund» to every row that moved a till (a
    // placed payment too): the ✖ now asks the one function whose SQL twin is
    // the void's own claim (`mayVoidLedgerRow` ↔ `nonHolderVoidableSql`,
    // proven to agree in ledger-void.integration.test.ts), with the kassa
    // holders' grant as its door.
    expect(page).toMatch(
      /canManage &&\s*mayVoidLedgerRow\([\s\S]*?\{ mayMoveTill: canRefund, actorId: actor\.id \},?\s*\) && \(\s*<span className="ml-auto">\s*<VoidButton/,
    );
  });
});
