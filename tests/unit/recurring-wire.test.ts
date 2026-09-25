import { globSync, readFileSync } from 'node:fs';
import path from 'node:path';
import { describe, expect, it } from 'vitest';
import { RECURRING_ERRORS } from '@/app/(protected)/accounting/expenses/recurring-errors';

/**
 * The owner's Q6 (2026-09-25: «money leaves a kassa only when the kassa
 * holder actually pays it») as SOURCE SHAPE — the halves no integration test
 * can press: the actions call `authorize` (#531), the fold is a browser
 * form, and «nothing posts by itself» is an absence. Comments are stripped
 * first, or a fence matches the sentence explaining itself (#725). The
 * service halves are proven in recurring-pay.integration.test.ts; the date
 * rule's write half (W2) lives beside U21 in money-doors-wire.test.ts.
 */
const ROOT = path.resolve(__dirname, '../..');
const strip = (text: string) => text.replace(/\/\*[\s\S]*?\*\//g, '').replace(/(^|[^:])\/\/.*$/gm, '$1');
const read = (rel: string) => strip(readFileSync(path.join(ROOT, rel), 'utf8'));

/** The balanced `(...)` or `{...}` opening at or after `from`, as text. */
function balanced(text: string, from: number, open: '(' | '{'): { text: string; end: number } {
  const close = open === '(' ? ')' : '}';
  const start = text.indexOf(open, from);
  expect(start, `no ${open} after ${from}`).toBeGreaterThanOrEqual(0);
  let depth = 0;
  for (let i = start; i < text.length; i += 1) {
    if (text[i] === open) depth += 1;
    else if (text[i] === close) {
      depth -= 1;
      if (depth === 0) return { text: text.slice(start, i + 1), end: i + 1 };
    }
  }
  return { text: text.slice(start), end: text.length };
}

/** A named function's body (after its parameter list). */
function body(source: string, name: string): string {
  const at = source.search(new RegExp(`function\\s+${name}\\b`));
  expect(at, `function ${name} not found`).toBeGreaterThanOrEqual(0);
  const params = balanced(source, at, '(');
  return balanced(source, params.end, '{').text;
}

/** Every `name(...)` call's argument text in `source`. */
function calls(source: string, name: string): string[] {
  const out: string[] = [];
  const re = new RegExp(`(?<![.\\w])${name}\\s*\\(`, 'g');
  let match: RegExpExecArray | null;
  while ((match = re.exec(source))) out.push(balanced(source, match.index + match[0].length - 1, '(').text);
  return out;
}

const SRC = globSync('src/**/*.{ts,tsx}', { cwd: ROOT });
const RECURRING = 'src/modules/wms/accounting/recurring.ts';
const SERVICE = 'src/modules/wms/accounting/service.ts';
const ACTIONS = 'src/app/(protected)/accounting/actions.ts';

type Tree = { [key: string]: string | Tree };
const bundle = (locale: string): Tree => JSON.parse(readFileSync(path.join(ROOT, `messages/${locale}.json`), 'utf8'));
const lookup = (tree: Tree, dotted: string) =>
  dotted.split('.').reduce<string | Tree | undefined>((node, part) => (typeof node === 'object' ? node[part] : undefined), tree);

describe('W1 — nothing posts a month by itself', () => {
  it('the monthly run, its button and any recurring job are gone from src/', () => {
    const offenders: string[] = [];
    for (const file of SRC) {
      const source = read(file);
      for (const shape of [/\bgenerateRecurring\s*\(/, /function\s+generateRecurring\b/, /GenerateRecurringButton/, /generate-recurring/]) {
        if (shape.test(source)) offenders.push(`${file}: ${shape}`);
      }
      for (const job of source.matchAll(/boss\.(?:schedule|work)\(\s*([^,]+),/g)) {
        if (/recurring/i.test(job[1]!)) offenders.push(`${file}: ${job[0]}`);
      }
    }
    expect(offenders).toEqual([]);
  });
});

describe('W3 — one writer of a payment’s recurring columns (derived)', () => {
  it('only accounting/recurring.ts passes `recurring:` to addExpenseTx or sets the columns', () => {
    const offenders: string[] = [];
    let found = 0;
    for (const file of SRC) {
      const source = read(file);
      for (const args of calls(source, 'addExpenseTx')) {
        if (/\brecurring\s*:/.test(args)) {
          found += 1;
          if (file !== RECURRING) offenders.push(`${file}: addExpenseTx with recurring`);
        }
      }
      let at = 0;
      while ((at = source.indexOf('.set(', at)) !== -1) {
        const object = balanced(source, at, '(').text;
        if (/\brecurring(?:Id|Month|Partial)\b/.test(object)) {
          found += 1;
          if (file !== RECURRING) offenders.push(`${file}: .set naming a recurring column`);
        }
        at += 5;
      }
    }
    // «To'landi» and «Bog'lash» must be found, or the scan is looking nowhere.
    expect(found).toBeGreaterThanOrEqual(2);
    expect(offenders).toEqual([]);
  });

  it('addExpense takes no options any more — only the write half can carry a month', () => {
    const service = read(SERVICE);
    const at = service.indexOf('export async function addExpense(');
    expect(at).toBeGreaterThanOrEqual(0);
    expect(balanced(service, at, '(').text).not.toMatch(/\bopts\b/);
  });
});

describe('W4 — the four doors are the kassa holders’', () => {
  it('each recurring action runs under finance.expenses; the pay action reads the named button', () => {
    const actions = read(ACTIONS);
    for (const name of ['payRecurringAction', 'linkRecurringAction', 'skipRecurringAction', 'unskipRecurringAction']) {
      expect(body(actions, name), name).toContain("run('finance.expenses'");
    }
    expect(body(actions, 'payRecurringAction')).toContain("formData.has('partial')");
  });
});

describe('W5 — the pay fold', () => {
  const fold = read('src/app/(protected)/accounting/expenses/recurring-due.tsx');

  it('dates a payment never after tomorrow and asks where the money went', () => {
    expect(fold).toContain('max={latestTxDate()}');
    const select = /<select\s+name="payer"[^>]*>/s.exec(fold)?.[0] ?? '';
    expect(select).toContain('required');
  });

  it('every submit greys itself while the press is in flight (M10)', () => {
    expect(fold.match(/type="submit"/g)).toHaveLength(1);
    const button = body(fold, 'PendingButton');
    expect(button).toContain('useFormStatus()');
    expect(button).toContain('disabled={pending}');
  });
});

describe('W6 — every refusal in words (derived)', () => {
  const codes = new Set<string>();
  const service = read(SERVICE);
  for (const source of [
    read(RECURRING),
    body(service, 'updateRecurring'),
    body(service, 'saveRecurring'),
    body(service, 'addExpenseTx'),
    body(service, 'assertRecurringUsd'),
  ]) {
    for (const match of source.matchAll(/new AccountingError\('([a-z_]+)'\)/g)) codes.add(match[1]!);
  }

  it('finds the codes to check', () => {
    expect(codes.has('recurring_already_paid')).toBe(true);
    expect(codes.has('recurring_has_arrears')).toBe(true);
  });

  it('every code the doors throw is a key of RECURRING_ERRORS', () => {
    expect([...codes].filter((code) => !(code in RECURRING_ERRORS))).toEqual([]);
  });

  it('every value resolves to a string in all four bundles', () => {
    const missing: string[] = [];
    for (const locale of ['ru', 'uz', 'zh-CN', 'en']) {
      const tree = bundle(locale);
      for (const key of new Set(Object.values(RECURRING_ERRORS))) {
        if (typeof lookup(tree, key) !== 'string') missing.push(`${locale}: ${key}`);
      }
    }
    expect(missing).toEqual([]);
  });
});

describe('W7 — the expense book’s layout', () => {
  const page = read('src/app/(protected)/accounting/expenses/page.tsx');

  it('the recurring panel comes AFTER the expense form (m7 picks the first selects)', () => {
    expect(page.indexOf('<ExpenseForm')).toBeGreaterThan(0);
    expect(page.indexOf('id="recurring"')).toBeGreaterThan(page.indexOf('<ExpenseForm'));
  });

  it('the banner carries no emoji of its own — the bundle value does (G3)', () => {
    const at = page.indexOf('data-testid="recurring-due-banner"');
    expect(at).toBeGreaterThan(0);
    const banner = page.slice(page.lastIndexOf('<a', at), page.indexOf('</a>', at));
    expect(banner).not.toContain('⏰');
  });
});

describe('W8 — the counters read the one fragment', () => {
  it('the home counter is the recurring module’s, fed the DAY', () => {
    const flows = read('src/modules/wms/home/role-flows.ts');
    expect(flows).toMatch(/import \{ recurringDueCount \} from '\.\.\/accounting\/recurring';/);
    expect(flows).not.toMatch(/function\s+recurringDueCount/);
    expect(calls(flows, 'recurringDueCount')).toEqual(['(today)']);
  });

  it('the dashboard row reads the Balans’ own figures', () => {
    const attention = read('src/app/(protected)/dashboard/sections/attention.tsx');
    expect(attention).toContain('balance.recurringArrearsTotal');
    expect(attention).toContain('balance.recurringArrearsUsd');
    expect(attention).not.toContain('recurringDueCount');
  });
});

describe('W9 — every Balans line key resolves', () => {
  it('reads the union out of its source and finds each key in all four bundles', () => {
    const source = read('src/modules/wms/accounting/balance-lines.ts');
    const union = /export type BalanceLineKey =([\s\S]*?);/.exec(source)?.[1] ?? '';
    const keys = [...union.matchAll(/'([A-Za-z]+)'/g)].map((m) => m[1]!);
    expect(keys).toContain('balRecurringArrears');
    const missing: string[] = [];
    for (const locale of ['ru', 'uz', 'zh-CN', 'en']) {
      const tree = bundle(locale);
      for (const key of keys) if (typeof lookup(tree, `accounting.${key}`) !== 'string') missing.push(`${locale}: ${key}`);
    }
    expect(missing).toEqual([]);
  });
});

describe('W10 — a template is CREATED by the form, edited only by its row control (M9)', () => {
  it('the create action reads no id and the service has no update branch', () => {
    expect(body(read(ACTIONS), 'saveRecurringAction')).not.toContain("formData.get('id')");
    expect(body(read(SERVICE), 'saveRecurring')).not.toContain('.update(recurringExpenses)');
  });
});

describe('W11 — the firm’s debt is written in the press’s own transaction (M7)', () => {
  it('chargeForExpenseTx sits inside payRecurring’s db.transaction body; the pooled wrapper is not used', () => {
    const recurring = read(RECURRING);
    const pay = body(recurring, 'payRecurring');
    const tx = pay.indexOf('db.transaction(');
    expect(tx).toBeGreaterThan(0);
    const inside = balanced(pay, tx, '(').text;
    expect(inside).toContain('chargeForExpenseTx(tx, row, ctx)');
    expect(recurring).not.toMatch(/(?<![.\w])chargeForExpense\s*\(/);
  });
});

describe('W12 — a recurring payment’s charge is not voided on the partner card (M4)', () => {
  it('the service refuses before its transaction; the card draws no ✕ for it', () => {
    const service = read('src/modules/wms/partners/service.ts');
    const fn = body(service, 'voidPartnerTx');
    expect(fn.indexOf("new PartnerError('recurring_payment')")).toBeGreaterThan(0);
    expect(fn.indexOf("new PartnerError('recurring_payment')")).toBeLessThan(fn.indexOf('db.transaction('));
    // The ✕ lives in the ELSE of the recurring-charge ternary — the guard
    // itself, not merely the name somewhere above it (the first version of
    // this fence matched the row's destructuring and stayed green).
    const page = read('src/app/(protected)/kontragentlar/[id]/page.tsx');
    const guard = page.indexOf('{tx.expenseId && expenseRecurringId && !tx.voidedAt ? (');
    const at = page.indexOf('<VoidTx');
    expect(guard, 'the recurring-charge guard').toBeGreaterThan(0);
    expect(at).toBeGreaterThan(guard);
    expect(page.slice(guard, at)).toContain(') : (');
  });
});

describe('W13 — the stop guard runs under the template lock (M3)', () => {
  it('dueNowSql and the UPDATE share one transaction, after the row lock', () => {
    const fn = body(read(SERVICE), 'updateRecurring');
    const tx = fn.indexOf('db.transaction(');
    expect(tx).toBeGreaterThan(0);
    const inside = balanced(fn, tx, '(').text;
    const lock = inside.indexOf(".for('update')");
    expect(lock).toBeGreaterThan(0);
    expect(inside.indexOf('dueNowSql(')).toBeGreaterThan(lock);
    expect(inside.indexOf('.update(recurringExpenses)')).toBeGreaterThan(lock);
    expect(fn.slice(0, tx)).not.toContain('dueNowSql(');
  });
});
