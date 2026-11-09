import { globSync, readFileSync } from 'node:fs';
import { createTranslator } from 'next-intl';
import { describe, expect, it } from 'vitest';
import { NUMBER_KEPT } from '@/modules/wms/batches/batch-number';
import { numberStopWords } from '@/modules/wms/batches/number-stop-words';
import { DEST_CHANGE_REFUSALS, notBeforeDepartureWhy } from '@/modules/wms/batches/reroute-rules';
import en from '../../messages/en.json';
import ru from '../../messages/ru.json';
import uz from '../../messages/uz.json';
import zh from '../../messages/zh-CN.json';

/*
 * The cancelled truck's number and the destination before departure — the
 * wiring (docs/NARX-VA-RAQAM.md §3.2). Source-shape on purpose: every half
 * here WORKS on its own, and what the fence is about is ORDER (which lock
 * first, a give-back after the cancel's commit and never inside it), which
 * file writes what, and which key an audit row carries — a behavioural test
 * proves only the doors it happens to call (#531). The behaviour is
 * tests/integration/batch-number-release.integration.test.ts and
 * batch-dest-before.integration.test.ts.
 *
 * Comments stripped first, strings kept (#725: a fence must not match the
 * sentence explaining it), and anchored on names it MUST find (#720).
 */

function stripComments(source: string): string {
  let out = '';
  let quote: string | null = null;
  for (let i = 0; i < source.length; i += 1) {
    const ch = source[i]!;
    const next = source[i + 1];
    if (quote) {
      out += ch;
      if (ch === '\\') {
        out += next ?? '';
        i += 1;
      } else if (ch === quote) {
        quote = null;
      }
      continue;
    }
    if (ch === "'" || ch === '"' || ch === '`') {
      quote = ch;
      out += ch;
    } else if (ch === '/' && next === '/') {
      while (i < source.length && source[i] !== '\n') i += 1;
      out += '\n';
    } else if (ch === '/' && next === '*') {
      i += 2;
      while (i < source.length && !(source[i] === '*' && source[i + 1] === '/')) i += 1;
      i += 1;
    } else {
      out += ch;
    }
  }
  return out;
}

const read = (path: string) => stripComments(readFileSync(path, 'utf8'));

/** A top-level function's text, from its declaration to the next top-level one. */
function body(path: string, fn: string): string {
  const src = read(path);
  const start = src.search(new RegExp(`(export\\s+)?(async\\s+)?function ${fn}\\(`));
  expect(start, `${fn} in ${path}`).toBeGreaterThanOrEqual(0);
  const rest = src.slice(start + 1);
  const next = rest.search(/\n(export |async function |function |const |interface |type |class )/);
  return next === -1 ? src.slice(start) : src.slice(start, start + 1 + next);
}

/** Each marker strictly after the one before it. */
function inOrder(text: string, markers: string[]) {
  let last = -1;
  for (const marker of markers) {
    const at = text.indexOf(marker, last + 1);
    expect(at, marker).toBeGreaterThan(last);
    last = at;
  }
}

const RENAME = 'src/modules/wms/batches/rename.ts';
const NUMBER = 'src/modules/wms/batches/batch-number.ts';
const UNLOAD = 'src/modules/wms/scanning/unload.ts';
const REROUTE = 'src/modules/wms/batches/reroute.ts';
const ACTIONS = 'src/app/(protected)/batches/batch-actions-server.ts';
const PLAN_ACTIONS = 'src/app/(protected)/plans/actions.ts';
const SRC = globSync('src/**/*.{ts,tsx}').map((path) => ({ path, text: read(path) }));

describe('the give-back writes in one place, in one order', () => {
  const release = body(RENAME, 'releaseTrailingCodes');

  it('counter → plain verdict → name locks → truck row → verdict again → rename → CAS → audit', () => {
    inOrder(release, [
      'db.transaction(',
      "SET LOCAL lock_timeout = '3s'",
      'lockCounterRow(tx',
      'numberVerdict(tx, code)',
      'lockBatchCode(tx, code)',
      'freeBekorName(tx',
      'FOR UPDATE',
      'numberVerdict(tx, code)',
      '.update(batches)',
      'rewindCounter(tx',
      'writeAudit(',
    ]);
  });

  it('never takes a truck’s LOADING lock — the cancel committed it, a rename waits on it', () => {
    expect(release).not.toContain('lockTruckLoading(');
    expect(body(RENAME, 'releaseNumberAfterCancel')).not.toContain('lockTruckLoading(');
  });

  it('a bekor name is locked before it is asked «ever worn» — the mint’s own walk', () => {
    const fn = body(RENAME, 'freeBekorName');
    inOrder(fn, ['lockBatchCode(tx, name)', 'codeEverWorn(tx, name, holderId)']);
  });

  it('its audit row says `released` and NEVER a `reason` — a reason would burn the number for ever', () => {
    const at = release.indexOf('writeAudit(');
    const audit = release.slice(at, release.indexOf('});', at));
    // …and the number it FREED, which in the plate case nothing else on the row names (review C1).
    expect(audit).toContain('after: { code: name, released: true, number: code }');
    expect(audit).toContain('before: { code: holder.code }');
    expect(audit).not.toMatch(/\breason\b/);
    // The truck's OWN origin scope, so a shared prefix's rename sits where it belongs.
    expect(audit).toContain('warehouseId: holder.originWarehouseId');
  });

  it('DERIVED: only rename.ts writes `batches.code`, and only the give-back writes `released: true`', () => {
    const codeWriters: string[] = [];
    let updates = 0;
    for (const { path, text } of SRC) {
      for (const match of text.matchAll(/\.update\(batches\)\s*\.set\(\s*\{([^}]*)\}/g)) {
        updates += 1;
        if (/\bcode\b\s*[:,}]/.test(match[1]!)) codeWriters.push(path);
      }
      if (/UPDATE\s+batches\s+SET\s+code\b/i.test(text)) codeWriters.push(`${path} (raw)`);
    }
    expect(updates).toBeGreaterThanOrEqual(10);
    expect([...new Set(codeWriters)]).toEqual([RENAME]);
    const released = SRC.filter(({ text }) => /\breleased:\s*true\b/.test(text)).map(({ path }) => path);
    expect(released).toEqual([RENAME]);
  });
});

describe('the cancel gives the number back AFTER its commit', () => {
  const cancel = body(UNLOAD, 'cancelBatch');

  it('the release is called once, after the transaction closes — never inside it', () => {
    const tx = cancel.indexOf('db.transaction(async (tx) => {');
    expect(tx).toBeGreaterThan(0);
    const closed = cancel.indexOf('retireTaskCopiesSoon(');
    const call = cancel.indexOf('releaseNumberAfterCancel(batchId, ctx)');
    expect(closed).toBeGreaterThan(tx);
    expect(call).toBeGreaterThan(closed);
    expect(cancel.match(/releaseNumberAfterCancel\(/g) ?? []).toHaveLength(1);
    expect(cancel.slice(tx, closed)).not.toMatch(/release(TrailingCodes|NumberAfterCancel)\(/);
    expect(cancel).toContain('return { ...out, batch: now ?? out.batch, number };');
  });

  it('the action passes the answer on', () => {
    const action = body(PLAN_ACTIONS, 'cancelBatchAction');
    expect(action).toContain('number: result.number');
  });

  it('the answer is read from the truck’s own rows after the walk', () => {
    const fn = body(RENAME, 'releaseNumberAfterCancel');
    inOrder(fn, ['releaseTrailingCodes(', 'batchNumberState(batchId)']);
  });
});

describe('the card says it durably, and the papers of a cancelled truck are not «sent»', () => {
  it('a cancelled truck’s header prints batch-number-state from the read-only predicate', () => {
    const card = read('src/app/(protected)/batches/[id]/batch-card.tsx');
    expect(card).toContain("cancelled ? await soft('number state', () => batchNumberState(id)) : null");
    expect(card).toContain('data-testid="batch-number-state"');
  });

  it('a given-back number a truck since carried on the road is not promised to the next truck (review RVF3-2)', () => {
    // The state names those numbers (`taken`, read live — the integration
    // test proves it); the card must keep them OUT of «keyingi mashinaga
    // beriladi» and say who took each instead.
    const card = read('src/app/(protected)/batches/[id]/batch-card.tsx');
    expect(card).toContain('const promised = numberState.numbers.filter((number) => !taken.some((t) => t.number === number));');
    expect(card).toContain("...(promised.length ? [tn('stateReturned', { number: promised.join(', ') })] : []),");
    expect(card).toContain("...taken.map((t) => tn('stateReturnedTaken', { number: t.number, name: t.name })),");
    expect(card).not.toContain('numberState.numbers.join(');
    // …and it wears neither the good-news colour nor the plain «returned» state.
    expect(card).toContain("numberState.kind === 'returned' && !numberState.taken ? 'text-good' : 'text-ink-700'");
    expect(card).toContain("(numberState.taken ? 'returned_taken' : 'returned')");
  });

  it('the «taken» sentence names the number and the truck in every bundle, and promises nothing', () => {
    const promise = { uz: 'keyingi mashinaga', ru: 'следующая машина', en: 'the next truck', zh: '下一辆车' } as const;
    for (const [name, bundle] of Object.entries({ en, ru, uz, zh })) {
      const t = createTranslator({ locale: name, messages: bundle as never, namespace: 'batches.number' as never });
      const line = (t as unknown as (key: string, values: Record<string, string>) => string)('stateReturnedTaken', {
        number: 'YW-002',
        name: '01A777BA',
      });
      expect(line, name).toContain('YW-002');
      expect(line, name).toContain('01A777BA');
      expect(line, name).not.toContain(promise[name as keyof typeof promise]);
    }
  });

  it('the tick refuses a cancelled truck on the LOCKED row, before anything is frozen', () => {
    const tick = body(ACTIONS, 'setSentToAgentAction');
    inOrder(tick, ['lockTruckForTickInTx(tx, batchId)', "sending && row.status === 'cancelled'", 'freezeCompositionsInTx(']);
    // …and the half-applied-deploy toggle says the same.
    expect(tick).toContain("and(isNull(batches.sentToAgentAt), ne(batches.status, 'cancelled'))");
    const lock = body('src/modules/wms/receipts/lot-composition.ts', 'lockTruckForTickInTx');
    expect(lock).toMatch(/sent_to_agent_at::text AS sent_at, status FROM batches[^`]*FOR NO KEY UPDATE/);
    const page = read('src/app/(protected)/batches/[id]/tnved/page.tsx');
    expect(page).toContain("(batch.status !== 'cancelled' || batch.sentToAgentAt)");
  });

  it('the release’s verdict counts a tick ever pressed, not only the one standing', () => {
    const holder = body('src/modules/wms/batches/former-codes.ts', 'numberHolderOf');
    expect(holder).toContain('b.sent_to_agent_at IS NOT NULL OR EXISTS (');
    expect(holder).toContain("(t.after->>'sentToAgent') = 'true'");
    // The writer of that key is the tick.
    expect(read(ACTIONS)).toContain('after: { sentToAgent: true,');
  });

  it('the bot falls back to a released number LAST, after the former name', () => {
    const lookup = body('src/modules/wms/bot/lookup.ts', 'botLookupAnswer');
    inOrder(lookup, ['lookupBatch(actor, upper)', 'lookupClient(actor, upper)', 'lookupFormerBatch(actor, upper)', 'lookupReleasedBatch(actor, upper)']);
  });
});

describe('the destination before departure', () => {
  const fn = body(REROUTE, 'changeDestBeforeDeparture');

  it('the cancel’s lock order: loading lock, the row, money under it, the target, then the write', () => {
    inOrder(fn, [
      'db.transaction(async (tx) => {',
      'await lockTruckLoading(tx, batchId)',
      ".for('no key update')",
      'mayChangeDestDoor(actor, batch.originWarehouseId)',
      "['forming', 'loading'].includes(batch.status)",
      'batch.destWarehouseId !== input.seenDestWarehouseId',
      'cost_entries',
      'client_transactions',
      ".for('share')",
      'destChangeRefusal(',
      "writeDestTx(tx, batchId, target!.id, input.seenDestWarehouseId, ['forming', 'loading'])",
      'writeAudit(',
    ]);
  });

  it('its audit carries its OWN key — never the reroute’s marker — and it emits nothing', () => {
    const at = fn.indexOf('writeAudit(');
    const audit = fn.slice(at, fn.indexOf('});', at));
    expect(audit).toContain('before: { destBeforeDeparture: batch.destWarehouseId }');
    expect(audit).toContain('after: { destBeforeDeparture: target!.id }');
    expect(audit).not.toContain('destWarehouseId:');
    expect(fn).not.toContain('emitEvent(');
  });

  it('ONE write site: both doors go through writeDestTx', () => {
    const src = read(REROUTE);
    expect(src.match(/\.update\(batches\)/g) ?? []).toHaveLength(1);
    expect(body(REROUTE, 'writeDestTx')).toContain('.update(batches)');
    expect(body(REROUTE, 'rerouteBatch')).toContain("writeDestTx(tx, batchId, target!.id, input.seenDestWarehouseId, ['in_transit'])");
    expect(fn).toContain('writeDestTx(');
  });

  it('the action asks the cancel’s door at the origin, the service asks it again', () => {
    const action = body(ACTIONS, 'changeDestBeforeDepartureAction');
    expect(action).toContain("mayAt(actor, 'batches.depart_close', batch.originWarehouseId) ? 'batches.depart_close' : 'plans.manage'");
    expect(action).toContain('authorize(code, { warehouseId: batch.originWarehouseId })');
    expect(action.indexOf('changeDestBeforeDeparture(')).toBeGreaterThan(action.indexOf('authorize(code'));
  });

  it('the Mashina tab offers it under the service’s own predicate', () => {
    const page = read('src/app/(protected)/batches/[id]/mashina/page.tsx');
    expect(page).toContain('const mayChangeDest = mayChangeDestBeforeDeparture(actor, batch);');
    expect(page).toMatch(/\{mayChangeDest && \(\s*<Panel/);
    const form = read('src/app/(protected)/batches/[id]/mashina/dest-change-form.tsx');
    expect(form).toContain("import type { DestChangeErrorCode } from '@/modules/wms/batches/reroute-rules';");
  });

  it('a truck past forming/loading is refused by what it IS, and the stale panel is redrawn (review D3)', () => {
    // Only a truck ON THE ROAD is told to use the road's door.
    expect(notBeforeDepartureWhy('in_transit')).toBe('not_before_departure');
    expect(notBeforeDepartureWhy('cancelled')).toBe('batch_cancelled');
    for (const status of ['arrived', 'unloaded', 'closed']) expect(notBeforeDepartureWhy(status), status).toBe('already_unloaded');
    expect(fn).toContain('throw new DestChangeError(notBeforeDepartureWhy(batch.status))');
    const form = read('src/app/(protected)/batches/[id]/mashina/dest-change-form.tsx');
    expect(form).toContain('if (STALE_PAGE.has(res.error)) router.refresh();');
    const stale = form.match(/const STALE_PAGE[^;]*;/)?.[0] ?? '';
    for (const code of ['dest_changed', 'batch_cancelled', 'not_before_departure', 'already_unloaded']) {
      expect(stale, code).toContain(`'${code}'`);
    }
  });
});

describe('the quick batch asks first', () => {
  it('the first press only asks; «Ha, ochish» is the form’s submit; no native dialog', () => {
    const form = read('src/app/(protected)/batches/quick-batch-form.tsx');
    expect(form).toContain('<form action={createQuickBatchAction}');
    expect(form).toMatch(/type="button"[^>]*data-testid="create-quick-batch"/);
    expect(form).toMatch(/type="submit"[^>]*data-testid="quick-batch-yes"/);
    expect(form).toMatch(/type="button"[^>]*data-testid="quick-batch-no"/);
    expect(form).not.toContain('window.confirm');
    // The select names the specs and the action read.
    expect(form).toContain('name="originId"');
    expect(form).toContain('name="destId"');
    expect(read('src/app/(protected)/batches/page.tsx')).toContain('<QuickBatchForm');
  });
});

describe('every answer has its words in all four bundles', () => {
  it('the number’s states and the destination change’s refusals', () => {
    for (const [name, bundle] of Object.entries({ en, ru, uz, zh })) {
      const b = (bundle as unknown as {
        batches: {
          number: { stateReturned: string; stateReturnedTaken: string; kept: Record<string, string> };
          destChange: { errors: Record<string, string> };
          quickConfirm: string;
        };
        audit: { fields: Record<string, string> };
      });
      expect(typeof b.batches.number.stateReturned, `${name}: stateReturned`).toBe('string');
      expect(typeof b.batches.number.stateReturnedTaken, `${name}: stateReturnedTaken`).toBe('string');
      for (const why of NUMBER_KEPT) expect(typeof b.batches.number.kept[why], `${name}: kept.${why}`).toBe('string');
      for (const code of [...DEST_CHANGE_REFUSALS, 'busy_retry', 'validation', 'offline', 'unauthenticated']) {
        expect(typeof b.batches.destChange.errors[code], `${name}: destChange.errors.${code}`).toBe('string');
      }
      expect(typeof b.batches.quickConfirm, `${name}: quickConfirm`).toBe('string');
      expect(typeof b.audit.fields.released, `${name}: audit.fields.released`).toBe('string');
      expect(typeof b.audit.fields.destBeforeDeparture, `${name}: audit.fields.destBeforeDeparture`).toBe('string');
    }
  });

  it('the plan page names the PLAN’s destination as the approved one — «rejada» is the Mashina tab’s word (review D2)', () => {
    // The Mashina tab's badge «↪ {now} · rejada {planned}» reads the DEPARTURE
    // destination; the plan page's suffix is the plan's own approval, so it
    // must not borrow that word for a different warehouse.
    const approved = { uz: 'tasdiqlangan', ru: 'утверждён', en: 'approved', zh: '审批' } as const;
    for (const [name, bundle] of Object.entries({ en, ru, uz, zh })) {
      const line = (bundle as unknown as { plans: { truckNow: string } }).plans.truckNow;
      expect(line, name).toContain('{dest}');
      expect(line, name).toContain('{planned}');
      expect(line, name).toContain(approved[name as keyof typeof approved]);
    }
    expect((uz as unknown as { plans: { truckNow: string } }).plans.truckNow).not.toContain('rejada');
  });

  it('«pending» and «busy» promise the number back only while no new truck is opened first (review C4)', () => {
    // `nextBatchCode` releases nothing — it bumps past a number no walk has
    // freed — so the next cancel or `--apply` gives it back ONLY if no truck
    // of the prefix was minted first; after that it is a gap for good. The
    // unconditional «keyingi bekor qilishda qaytadi» was a promise the mint breaks.
    const condition = {
      uz: 'undan oldin yangi mashina ochilmasa',
      ru: 'если до этого не откроют новую машину',
      en: 'unless a new truck is opened first',
      zh: '若在此之前未开出新车',
    } as const;
    for (const [name, bundle] of Object.entries({ en, ru, uz, zh })) {
      const kept = (bundle as unknown as { batches: { number: { kept: Record<string, string> } } }).batches.number.kept;
      for (const why of ['pending', 'busy']) {
        expect(kept[why], `${name}: kept.${why}`).toContain(condition[name as keyof typeof condition]);
        expect(kept[why], `${name}: kept.${why}`).toContain('batch-raqam --apply');
      }
    }
  });

  it('the card’s map names every kept reason (a literal map — #163)', () => {
    const card = read('src/app/(protected)/batches/[id]/batch-card.tsx');
    for (const why of NUMBER_KEPT) expect(card, why).toContain(`${why}: tn('kept.${why}', values)`);
  });
});

describe('the dry run says why the walk stops in his words (review C5)', () => {
  it('every reason has an Uzbek sentence — never the raw code', () => {
    for (const why of NUMBER_KEPT) {
      const line = numberStopWords({ why, number: 'YW-010', name: '01A777BA' });
      expect(line, why).not.toMatch(new RegExp(`\\b${why}\\b`));
      expect(line.length, why).toBeGreaterThan(10);
    }
    expect(numberStopWords({ why: 'agent', number: 'YW-010', name: 'YW-010' })).toBe(
      'YW-010: bekor qilingan, hujjatlari agentga yuborilgan — raqami saqlanadi',
    );
    expect(numberStopWords({ why: 'newer', number: 'YW-011', name: 'YW-011' })).toBe('YW-011 allaqachon ochilgan');
    expect(numberStopWords('empty')).toContain('sanoq boshiga yetdi');
  });

  it('both script lines print the stop through that map — the report’s reason, and the walk’s', () => {
    const script = read('scripts/batch-raqam.ts');
    expect(script).toContain('numberStopWords(p.stoppedBy)');
    expect(script).toContain('numberStopWords(walk.stop)');
    expect(script).not.toMatch(/\$\{walk\.stop\.why\}/);
    // The one fixed sentence it used to print for every empty walk.
    expect(script).not.toContain('oxirgi raqam yo‘lga chiqqan yoki ochiq mashinada');
  });
});

describe('the verdict reads the number as the mint builds it', () => {
  it('no parse: numberOfCode compares the built string', () => {
    const fn = body(NUMBER, 'numberOfCode');
    expect(fn).toContain('batchSeqCode(prefix, n).toUpperCase() === upper');
    expect(body('src/modules/wms/codes.ts', 'nextBatchCode')).toContain('batchSeqCode(prefix, seq)');
  });
});
