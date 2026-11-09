import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';
import { TRUCK_DEAL_ERROR_KEYS } from '@/components/truck-deal-errors';

/**
 * His Q8 «c» (2026-10-27, «logist o'zi tanlaydi») and the price table that
 * grew out of it (2026-11-08, his 1a: one row per deal, one press) from the
 * screen to the door. The rules themselves are proven where they run
 * (`truckDealDecision` / `truckDealParts`, unit; the price door,
 * integration); these are the halves no service test can see — a forgotten
 * line in the action, a `disabled` on the select, a second copy of the write
 * body — each passes every one of them and breaks the money (#531). Comments
 * are stripped first, so a fence cannot match the sentence that explains it
 * (#725).
 */
const strip = (source: string) =>
  source
    .replace(/\/\*[\s\S]*?\*\//g, '')
    .split('\n')
    .map((line) => (/^\s*\/\//.test(line) ? '' : line.replace(/\s\/\/\s.*$/, '')))
    .join('\n');
const read = (path: string) => strip(readFileSync(path, 'utf8'));

const between = (source: string, from: string, to: string) => {
  const start = source.indexOf(from);
  expect(start, `missing: ${from}`).toBeGreaterThan(-1);
  const end = source.indexOf(to, start);
  return source.slice(start, end > start ? end : undefined);
};

/**
 * A function's own text, by brace balance (the tx-pool way) — never by its
 * neighbour's position in the file, which is how three fences went on
 * proving nothing once the truck branch moved out (judge F2).
 */
function fn(source: string, head: string): string {
  const start = source.indexOf(head);
  expect(start, `missing: ${head}`).toBeGreaterThan(-1);
  let i = source.indexOf('(', start);
  for (let depth = 0; i < source.length; i += 1) {
    if (source[i] === '(') depth += 1;
    else if (source[i] === ')' && --depth === 0) break;
  }
  // The body's brace is the first one outside a return type's `<…>`:
  // `Promise<{ ids: string[] }>` carries a brace of its own.
  let open = i;
  for (let angle = 0; open < source.length; open += 1) {
    if (source[open] === '<') angle += 1;
    else if (source[open] === '>') angle -= 1;
    else if (source[open] === '{' && angle === 0) break;
  }
  for (let depth = 0, j = open; j < source.length; j += 1) {
    if (source[j] === '{') depth += 1;
    else if (source[j] === '}' && --depth === 0) return source.slice(start, j + 1);
  }
  return source.slice(start);
}

const PAGE = 'src/app/(protected)/batches/[id]/pricing/page.tsx';
const FORM = 'src/app/(protected)/batches/[id]/pricing/pricing-form.tsx';
const TABLE = 'src/app/(protected)/batches/[id]/pricing/pricing-table.tsx';
const SERVICE = 'src/modules/wms/finance/service.ts';
const ACTIONS = 'src/app/(protected)/finance/actions.ts';

describe('the question the screens draw is the door’s', () => {
  it('the «Narx» tab reads the door’s own query once and posts the key and the prices it drew', () => {
    const page = read(PAGE);
    expect(page).toContain('await dealCandidateRows([id], null)');
    expect(page).toMatch(/dealCandidatesOf\(\s*candidateRows\.filter\(\(row\) => row\.clientId === group\.clientId\),\s*group\.clientId,\s*\)/);
    expect(page).toContain('dealsSeen: candidates.key,');
    expect(page).toContain('pricesSeen: pricesSeenOf(prices.map((row) => row.id)),');
    // The prices it drew are the client's live charges here — the set the
    // write body re-reads under its locks.
    expect(page).toContain("row.tx.clientId === clientId && row.tx.type === 'charge'");
  });

  it('an ambiguous client is drawn the TABLE, never the single form; anybody else the single form', () => {
    const page = read(PAGE);
    expect(page).toContain('const rows = candidates.ambiguous ? tableRowsFor(group, candidates, split.shares) : null;');
    expect(page).toMatch(/single=\{\s*rows\s*\?\s*null\s*:/);
    const door = read('src/app/(protected)/batches/[id]/pricing/client-pricing.tsx');
    expect(door).toContain('{table ? <PricingTable {...props} {...table} /> : single ? <PricingForm {...props} {...single} /> : null}');
    // The single form asks no deal at all any more: its select is the
    // ledger's alone (§3.1.9).
    const form = read(FORM);
    expect(form).not.toContain('TruckDealSelect');
    expect(form).not.toContain('choiceAsks');
    expect(form).not.toContain('expectedByDeal');
  });

  it('the ledger reads the same query over its trucks — never the 40-row deal list — for a truck charge', () => {
    const page = read('src/app/(protected)/finance/[clientId]/page.tsx');
    expect(page).toContain('await dealCandidateRows(chargeTrucks.map((truck) => truck.batchId), clientId)');
    const form = read('src/app/(protected)/finance/[clientId]/tx-form.tsx');
    expect(form).toContain('{truckDeal && <input type="hidden" name="dealsSeen" value={truckDeal.key} />}');
    // The ledger's own deal select is for payments and truck-less prices.
    expect(form).toContain('{!truckDeal && deals.length > 0 && (');
  });

  it('both «Narx» bodies post the key and the prices ALWAYS, at the top level — or a truck that turns two-deal is never caught', () => {
    expect(read(FORM)).toMatch(
      /name="type" value="charge" \/>\s*<input type="hidden" name="dealsSeen" value=\{dealsSeen\} \/>\s*<input type="hidden" name="pricesSeen" value=\{pricesSeen\} \/>/,
    );
    expect(read(TABLE)).toMatch(
      /name="batchId" value=\{batchId\} \/>\s*<input type="hidden" name="dealsSeen" value=\{dealsSeen\} \/>\s*<input type="hidden" name="pricesSeen" value=\{pricesSeen\} \/>/,
    );
  });

  it('the actions pass the key, the prices and the deal to the door', () => {
    const actions = read(ACTIONS);
    const add = between(actions, 'export async function addTransactionAction', 'const voidSchema');
    expect(add).toContain("dealsSeen: formData.get('dealsSeen') || undefined,");
    // '' — «no prices here yet» — is an answer: `has`, never `|| undefined`.
    expect(add).toContain("pricesSeen: formData.has('pricesSeen') ? String(formData.get('pricesSeen')) : undefined,");
    expect(add).toContain("dealId: formData.get('dealId') || undefined,");
    expect(add).toContain('addTransaction(parsed.data,');
    const table = fn(actions, 'export async function addTruckPricesAction');
    expect(table).toContain("dealsSeen: String(formData.get('dealsSeen') ?? ''),");
    expect(table).toContain("pricesSeen: String(formData.get('pricesSeen') ?? ''),");
    expect(table).toContain('addTruckPrices(parsed.data,');
    // Blank rows go BEFORE the schema; an empty press is its own refusal.
    const blank = table.indexOf("if (text === '') continue;");
    const empty = table.indexOf("if (parts.length === 0) return { error: 'deal_parts_empty' };");
    const schema = table.indexOf('truckPricesSchema.safeParse(');
    expect(blank).toBeGreaterThan(-1);
    expect(empty).toBeGreaterThan(blank);
    expect(schema).toBeGreaterThan(empty);
    // Only an EMPTY row is blank: an unreadable one is refused by its deal.
    expect(table).toContain("if (amount === null || !(amount > 0)) return { error: 'validation', dealId };");
  });
});

describe('the ledger’s select can never post a deal nobody chose', () => {
  const select = read('src/components/truck-deal-select.tsx');

  it('is required, never disabled, and its placeholder is not disabled either', () => {
    // The whole opening tag (its onChange holds an arrow, so not «up to >»).
    const tag = between(select, '<select', 'data-testid="truck-deal-select"');
    expect(tag).toContain('name="dealId"');
    expect(tag).toContain('required');
    // A disabled select posts nothing (#171) …
    expect(tag).not.toContain('disabled');
    // … and a disabled placeholder makes an unmatched value fall onto the
    // first DEAL (review).
    expect(select).toContain('<option value="">');
    expect(select).not.toMatch(/<option[^>]*disabled/);
  });

  it('shows the choice only under the question it was made for', () => {
    expect(read('src/app/(protected)/finance/[clientId]/tx-form.tsx')).toMatch(/shownDealChoice\(choice, /);
  });
});

describe('the table’s rows can never post a figure nobody saw', () => {
  const table = read(TABLE);

  it('every amount box is controlled and never disabled (#171/#377)', () => {
    const box = between(table, 'name={`deal:${row.key}`}', '/>');
    expect(box).toContain('value={valueOf(row)}');
    expect(box).not.toContain('disabled');
  });

  it('a pre-fill fills only an untouched row, by the pure rule, with the currency the select holds NOW', () => {
    expect(table).toContain('if (row.key in typed) return typed[row.key]!;');
    expect(table).toContain('row.prefill ? prefillFor(row.prefill, currency) : null');
  });

  it('a save clears exactly the rows it wrote, and keeps them touched (judge P1-UX-3)', () => {
    expect(table).toContain("setTyped((now) => ({ ...now, ...Object.fromEntries((result.written ?? []).map((key) => [key, ''])) }));");
  });
});

describe('the confirmation is the question that is posted — on both «Narx» bodies', () => {
  it('is drawn only while what it asked about is still on the screen', () => {
    expect(read(FORM)).toContain(
      'asked.amount === amount && asked.currency === currency && asked.seen === `${dealsSeen}#${pricesSeen}`',
    );
    const table = read(TABLE);
    expect(table).toContain('asked && asked.key === askKey()');
    const key = between(table, 'const askKey = () =>', '});');
    for (const part of ['rows: rows.map((row) => [row.key, valueOf(row)])', 'currency,', 'txDate,', 'seen: `${dealsSeen}#${pricesSeen}`']) {
      expect(key, part).toContain(part);
    }
  });

  it('prints the figures it was asked with, never the live ones', () => {
    expect(read(FORM)).toContain('usd: `$${asked.usd.toFixed(2)}`');
    expect(read(TABLE)).toContain('{asked.asks.map((ask, index) => (');
  });

  it('every field takes it back, and taking it back disarms a «baribir saqlash» that never reached the action', () => {
    for (const path of [FORM, TABLE]) {
      const form = read(path);
      expect(between(form, 'name="currency"', '</select>'), path).toContain('reask()');
      expect(between(form, 'name="txDate"', '/>'), path).toContain('reask()');
      expect(between(form, 'const reask = () => {', '};'), path).toContain('confirmed.current = false;');
    }
    expect(between(read(FORM), 'name="amount"', '/>')).toContain('reask()');
    expect(between(read(TABLE), 'name={`deal:${row.key}`}', '/>')).toContain('reask()');
  });

  it('«baribir saqlash» is armed only for a press the browser will send, and cannot post twice', () => {
    for (const path of [FORM, TABLE]) {
      const form = read(path);
      const confirm = between(form, 'data-testid="pricing-deviation-confirm"', '</button>');
      const valid = confirm.indexOf('form.reportValidity()');
      const armed = confirm.indexOf('confirmed.current = true;');
      expect(valid, path).toBeGreaterThan(-1);
      expect(armed, path).toBeGreaterThan(valid);
      const before = form.slice(form.indexOf('data-testid="pricing-deviation-confirm"') - 200, form.indexOf('data-testid="pricing-deviation-confirm"'));
      expect(before, path).toContain('disabled={pending}');
    }
  });

  it('the table asks per ROW — never the false «extra bill» on a deal with nothing here', () => {
    const table = read(TABLE);
    // A deal's own price here, the chosen «bitimsiz» part, a whole-cargo price.
    expect(table).toContain("if (whole.length > 0) asks.push({ kind: 'whole', code });");
    expect(table).toContain('else if (row.hereUsd !== null) {');
    expect(table).toContain("if (row.card) asks.push({ kind: 'card', code });");
    expect(table).toContain("if (row.elsewhere.length > 0) asks.push({ kind: 'elsewhere', code, codes: row.elsewhere.join(', ') });");
    expect(table).toContain("if (currency === 'USD' && needsConfirmation(amount, row.expectedUsd)) {");
    expect(table).toContain("if (row.deferred) asks.push({ kind: 'deferred', code });");
    expect(table).toContain('if (!secondBill && asks.length === 0) return;');
  });
});

describe('ONE write body for every truck price, deciding twice on the same statement', () => {
  const service = read(SERVICE);

  it('both doors call the same pool half and the same write body — and addTransaction keeps no copy', () => {
    const add = fn(service, 'export async function addTransaction(');
    const table = fn(service, 'export async function addTruckPrices(');
    for (const [name, body] of [
      ['addTransaction', add],
      ['addTruckPrices', table],
    ] as const) {
      expect(body, name).toContain('await prepareTruckCharges({');
      expect(body, name).toContain('writeTruckCharges(plan, ctx)');
    }
    // No second cargo read or deal decision of its own (judge F2 b).
    expect(add).not.toContain('cargoAboard(');
    expect(add).not.toContain('truckDealDecision(');
    expect(add).not.toContain('FOR SHARE');
    expect(add).toContain("if (input.type === 'charge' && input.batchId) {");
  });

  it('the pool half: the internal leg before the cargo, the decision, ONE rate read, the dollar ceiling per part', () => {
    const pre = fn(service, 'export async function prepareTruckCharges(');
    const internal = pre.indexOf("if (route.internal) throw new FinanceError('internal_batch');");
    const aboard = pre.indexOf("if (!aboard.aboard) throw new FinanceError('client_not_aboard');");
    const decided = pre.indexOf('decideTruckAsk(aboard.candidates, input, input.amount)');
    expect(internal).toBeGreaterThan(-1);
    expect(aboard).toBeGreaterThan(internal);
    expect(decided).toBeGreaterThan(aboard);
    expect(pre.match(/rateFor\(/g)).toHaveLength(1);
    expect(pre).toContain("if (exceedsRowUsd(amountUsd)) throw new FinanceError('amount_too_large', part.dealId ?? 'none');");
  });

  it('the write body: the client lock, the truck locked and judged, the cargo and the decision again, the prices drawn — then one reconcile', () => {
    const body = fn(service, 'export async function writeTruckCharges(');
    const order = [
      'return db.transaction(async (tx) => {',
      'await lockOwnersTx(tx, { clientIds: [plan.clientId] });',
      'await lockTruckForPriceTx(tx, plan.batchId);',
      'await cargoAboard(plan.batchId, plan.clientId, tx);',
      'decideTruckAsk(now.candidates, plan,',
      "throw new FinanceError('deals_changed');",
      "throw new FinanceError('prices_changed');",
      '.insert(clientTransactions)',
      'await reconcileFxResidueTx(tx, { clientIds: [plan.clientId] }, ctx);',
      'await writeAudit(tx, ctx, {',
    ];
    let at = -1;
    for (const step of order) {
      const next = body.indexOf(step, at + 1);
      expect(next, step).toBeGreaterThan(at);
      at = next;
    }
    // The in-tx comparison is the per-press parts check (judge F2 c).
    expect(body).toContain('again.some((part, i) => part.dealId !== plan.parts[i]!.dealId)');
    expect(body.match(/reconcileFxResidueTx\(/g)).toHaveLength(1);
    // The table's audit says it was one press of N.
    expect(body).toContain("...(plan.ask.kind === 'parts' ? { parts: plan.parts.length } : {}),");
  });

  it('the truck lock reads the KIND on the locked row, after the cancel (judge P1-dest-change-race)', () => {
    const lock = fn(service, 'export async function lockTruckForPriceTx(');
    expect(lock).toContain('FOR SHARE OF b');
    expect(lock).toContain('JOIN warehouses o ON o.id = b.origin_warehouse_id');
    expect(lock).toContain('JOIN warehouses d ON d.id = b.dest_warehouse_id');
    const cancelled = lock.indexOf("throw new FinanceError('batch_cancelled')");
    const internal = lock.indexOf("if (isInternalLeg(truck.origin_country, truck.dest_country)) throw new FinanceError('internal_batch');");
    expect(cancelled).toBeGreaterThan(-1);
    expect(internal).toBeGreaterThan(cancelled);
  });

  it('«🚚 Ko‘chirish» locks and judges every target truck the same way, inside its transaction (judge F6)', () => {
    const move = fn(service, 'export async function moveCharge(');
    const tx = move.indexOf('await db.transaction(async (tx) => {');
    const owners = move.indexOf('await lockOwnersTx(tx, { clientIds: [row.clientId] });', tx);
    const truck = move.indexOf('await lockTruckForPriceTx(tx, batchId);', tx);
    const claim = move.indexOf('.update(clientTransactions)', tx);
    expect(owners).toBeGreaterThan(tx);
    expect(truck).toBeGreaterThan(owners);
    expect(claim).toBeGreaterThan(truck);
    expect(move).toContain('(await cargoAboard(batchId, row.clientId, tx)).aboard');
  });

  it('reads «bitimsiz» before anything treats the deal as a uuid — at both doors', () => {
    const add = fn(service, 'export async function addTransaction(');
    const sentinel = add.indexOf("input.dealId === 'none'");
    const lookup = add.indexOf('db.query.deals.findFirst');
    expect(sentinel).toBeGreaterThan(-1);
    expect(lookup).toBeGreaterThan(sentinel);
    expect(add).toContain('where: eq(deals.id, postedDeal)');
    const table = fn(service, 'export async function addTruckPrices(');
    const none = table.indexOf("part.dealId === 'none' ? { kind: 'none' } : { kind: 'deal', dealId: part.dealId }");
    expect(none).toBeGreaterThan(-1);
    expect(table.indexOf('prepareTruckCharges(')).toBeGreaterThan(none);
  });
});

describe('every refusal has words, in every bundle', () => {
  it('the map’s keys exist in all four locales', () => {
    for (const locale of ['ru', 'uz', 'en', 'zh-CN']) {
      const bundle = JSON.parse(readFileSync(`messages/${locale}.json`, 'utf8')) as { finance: Record<string, string> };
      for (const key of Object.values(TRUCK_DEAL_ERROR_KEYS)) {
        expect(bundle.finance[key], `${locale} finance.${key}`).toBeTruthy();
      }
    }
  });

  it('the table’s own refusals are in the map', () => {
    for (const code of ['deal_parts_empty', 'deal_part_duplicate', 'prices_changed']) {
      expect(Object.keys(TRUCK_DEAL_ERROR_KEYS), code).toContain(code);
    }
  });
});
