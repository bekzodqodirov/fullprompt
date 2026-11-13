import { readdirSync, readFileSync, statSync } from 'node:fs';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { REASK_QUIET, askFailureOf, reaskFailureOf } from '@/modules/wms/receipts/client-confirm';

/**
 * The automatic re-ask's wiring (the owner's «1 b» of 2026-11-12,
 * docs/PRIXOD-JAVOBLAR.md §1) — the parts no behavioural test can see: that
 * EVERY writer of a lot's stored totals reaches the arm (a fourth writer is
 * red the day it is written), that every reason the send can give up has a
 * word or is a right silence, and that 0147's columns stay SQL-only and
 * named where they are probed.
 */
const read = (file: string) => readFileSync(file, 'utf8');
// Comments out (#725): a sentence about a call must not keep a fence green.
const code = (file: string) =>
  read(file)
    .replace(/\{\/\*[\s\S]*?\*\/\}/g, '')
    .replace(/\/\*[\s\S]*?\*\//g, '')
    .replace(/^\s*\/\/.*$/gm, '');

function walk(dir: string): string[] {
  return readdirSync(dir).flatMap((name) => {
    const path = join(dir, name);
    if (statSync(path).isDirectory()) return walk(path);
    return /\.(ts|tsx)$/.test(name) ? [path] : [];
  });
}
const SRC = walk('src');

describe('every writer of a lot’s stored totals reaches the arm', () => {
  it('only two modules write `total_weight_kg` / `total_volume_m3` of an existing lot — and both are named here', () => {
    const writers = SRC.filter((file) => {
      const text = code(file);
      const drizzle = [...text.matchAll(/\.update\(receiptLots\)\s*\.set\(\{([\s\S]*?)\}\)/g)].some((m) => /totalWeightKg|totalVolumeM3/.test(m[1]!));
      const raw = /UPDATE\s+"?receipt_lots"?[\s\S]{0,400}?SET[\s\S]{0,400}?total_(weight_kg|volume_m3)/i.test(text);
      return drizzle || raw;
    });
    // A third writer must arm the re-ask after its commit (and be added here, with the reason).
    expect(writers.sort()).toEqual(['src/modules/wms/receipts/edit.ts', 'src/modules/wms/receipts/grow-lot.ts']);
  });

  it('`editLot` arms it after its commit, when the stored totals or the carton count moved', () => {
    const edit = code('src/modules/wms/receipts/edit.ts');
    const tail = edit.slice(edit.indexOf('}).then(async (result) => {'), edit.indexOf('/** Reverted codes an audit row names at most'));
    expect(tail).toMatch(/if \(totalsChanged \|\| countChange\) \{\s*const \{ armClientReask \} = await import\('\.\/client-reask'\);\s*await armClientReask\(lot\.id\);\s*\}/);
  });

  it('the count doors reach it through `afterLotGrown`, after their commits', () => {
    const grow = code('src/modules/wms/receipts/grow-lot.ts');
    const after = grow.slice(grow.indexOf('export async function afterLotGrown('), grow.indexOf('export async function grownCodesOnTruck('));
    expect(after).toContain("const { armClientReask } = await import('./client-reask');");
    expect(after).toContain('await armClientReask(lotId);');
    expect(code('src/modules/wms/scanning/count-load.ts')).toContain('if (result.grown > 0 || result.shrunk > 0) await afterLotGrown(lotId);');
    const accept = code('src/modules/wms/scanning/count-accept.ts');
    expect(accept.indexOf('if (grew) await afterLotGrown(input.lotId);')).toBeGreaterThan(accept.indexOf('} finally {'));
  });

  it('the arm never throws at a committed correction (U41): its body is one try', () => {
    const reask = code('src/modules/wms/receipts/client-reask.ts');
    const arm = reask.slice(reask.indexOf('export async function armClientReask('), reask.indexOf('export async function reaskSendable('));
    expect(arm).toMatch(/^export async function armClientReask\(lotId: string\): Promise<void> \{\s*try \{/);
    expect(arm).toMatch(/\} catch \(err\) \{\s*logger\.warn\(/);
  });
});

describe('why the system’s question was not sent — a word, or a right silence', () => {
  it('every reason `reaskSendable` gives is a word on the card or one of the quiet list', () => {
    const reask = code('src/modules/wms/receipts/client-reask.ts');
    const fn = reask.slice(reask.indexOf('export async function reaskSendable('), reask.indexOf('export async function recordReaskSent('));
    const literal = [...fn.matchAll(/skip: '([a-z_]+)'/g)].map((m) => m[1]!);
    expect(literal.sort()).toEqual(['not_askable', 'not_needed', 'switched_off', 'too_long']);
    for (const reason of [...literal, 'superseded', 'client_changed', 'receipt_gone', 'voided', 'not_confirmed', 'no_client', 'no_lots', 'no_linked_chat', 'client_gone']) {
      const quiet = (REASK_QUIET as readonly string[]).includes(reason);
      const word = reaskFailureOf('skipped', reason);
      if (quiet) expect(word, reason).toBeNull();
      else {
        expect(word, reason).not.toBeNull();
        expect(word, reason).not.toBe('telegram');
      }
    }
  });

  it('the quiet list is exactly the four right silences — and never quiet for a PERSON’s question', () => {
    expect([...REASK_QUIET].sort()).toEqual(['not_askable', 'not_needed', 'superseded', 'switched_off']);
    for (const reason of REASK_QUIET) expect(askFailureOf('skipped', reason), reason).not.toBeNull();
  });
});

describe('0147’s columns stay SQL-only and are named where they are probed', () => {
  const namers = (re: RegExp) => SRC.filter((file) => re.test(code(file))).sort();

  it('`asked_tag` / `asked_at` — the sweep writes them, the re-ask reads them, the probe asks for them', () => {
    expect(namers(/\basked_(tag|at)\b/)).toEqual([
      'src/modules/wms/notices/arrival.ts',
      'src/modules/wms/receipts/client-confirm.ts',
      'src/modules/wms/receipts/client-reask.ts',
      'src/modules/wms/receipts/lot-check-ready.ts',
    ]);
    expect(code('src/modules/platform/db/schema/wms.ts')).not.toMatch(/asked_tag|askedTag/);
  });

  it('`seen_kg` / `seen_m3` — the tick writes them, the sentence compares them, the probe asks for them', () => {
    expect(namers(/\bseen_(kg|m3)\b/)).toEqual([
      'src/modules/wms/receipts/lot-check-ready.ts',
      'src/modules/wms/receipts/lot-check-sql.ts',
      'src/modules/wms/receipts/lot-check.ts',
    ]);
    expect(code('src/modules/platform/db/schema/wms.ts')).not.toMatch(/seen_kg|seenKg/);
  });

  it('the re-ask’s settle and defer touch only the claim the sweep holds — a re-arm while it was out survives; every other kind as before', () => {
    const arrival = code('src/modules/wms/notices/arrival.ts');
    expect(arrival).toContain('.where(heldClaim(id, claimedAt))');
    const held = arrival.slice(arrival.indexOf('function heldClaim('), arrival.indexOf('export async function dueArrivalNotices('));
    expect(held).toContain('if (!claimedAt) return eq(clientNotices.id, id);');
    expect(held).toContain("eq(clientNotices.status, 'sending'),");
    const jobs = code('src/modules/wms/notices/arrival-jobs.ts');
    expect(jobs).toContain('const claimOf = (notice: NoticeRow): Date | null => (notice.kind === NOTICE_LOT_REASK ? notice.claimedAt : null);');
    // Every settle and defer in the sweep passes it.
    const sweep = jobs.slice(jobs.indexOf('export async function sendDueArrivalNotices('), jobs.indexOf('export async function registerClientNoticeWorker('));
    const settles = [...sweep.matchAll(/settleArrivalNotice\(([\s\S]*?)\)(?:\.catch|;)/g)].map((m) => m[1]!);
    expect(settles.length).toBeGreaterThanOrEqual(6);
    for (const args of settles) expect(args).toContain('claimOf(notice)');
    expect(sweep).toContain('deferNotice(notice.id, delivery.retryAfter, delivery.detail, claimOf(notice))');
  });

  it('a delivery is remembered whatever the settle wrote, and nothing after it may throw out of the sweep', () => {
    const jobs = code('src/modules/wms/notices/arrival-jobs.ts');
    const after = jobs.slice(jobs.indexOf('async function afterDelivered('), jobs.indexOf('const claimOf ='));
    expect(after).not.toContain('wrote');
    expect(after).toMatch(/try \{\s*if \(delivery\.askedTag && \(await askedTagReady\(\)\)\) await rememberAskedTag\(notice\.id, delivery\.askedTag\);\s*\} catch/);
    expect(after).toContain('await delivery.afterSent().catch(');
  });

  it('a person’s «Mijozdan so’rash» stands a held automatic question down', () => {
    const confirm = code('src/modules/wms/receipts/client-confirm.ts');
    const door = confirm.slice(confirm.indexOf('export async function askClientAboutReceipt('), confirm.indexOf('export const REASK_SUPERSEDED'));
    expect(door).toMatch(/UPDATE client_notices SET status = 'skipped', last_error = \$\{REASK_SUPERSEDED\}[\s\S]*kind = \$\{NOTICE_LOT_REASK\}[\s\S]*status = 'pending'/);
  });
});

describe('0147’s remembered answers are read only where a probe was awaited (L1-1)', () => {
  it('the sync flag of the tick’s measures is read by the sentence and the card’s view alone', () => {
    const readers = SRC.filter((file) => /lotTickMeasuresReady\(/.test(code(file))).sort();
    expect(readers).toEqual([
      'src/modules/wms/receipts/lot-check-ready.ts',
      'src/modules/wms/receipts/lot-check-sql.ts',
      'src/modules/wms/receipts/lot-check.ts',
    ]);
    // In lot-check.ts: inside the view, after it awaited the probe — never in a writer.
    const check = code('src/modules/wms/receipts/lot-check.ts');
    const view = check.slice(check.indexOf('export async function lotCheckViewsFor('));
    expect(view.indexOf('await lotChecksReady()')).toBeGreaterThan(-1);
    expect(view.indexOf('lotTickMeasuresReady()')).toBeGreaterThan(view.indexOf('await lotChecksReady()'));
    expect(check.slice(0, check.indexOf('export async function lotCheckViewsFor('))).not.toContain('lotTickMeasuresReady()');
  });

  it('the tick and its undo ask the probe themselves, on the pool, before their transaction', () => {
    const check = code('src/modules/wms/receipts/lot-check.ts');
    for (const fn of ['export async function checkLot(', 'export async function uncheckLot(']) {
      const body = check.slice(check.indexOf(fn), check.indexOf('db.transaction(', check.indexOf(fn)));
      expect(body, fn).toContain('const tickSide = await tickMeasuresReady();');
    }
  });

  it('the sweep, the arm, the card’s reading and the answer ask for the remembered question themselves', () => {
    expect(code('src/modules/wms/notices/arrival-jobs.ts')).toContain('if (delivery.askedTag && (await askedTagReady())) await rememberAskedTag(');
    const reask = code('src/modules/wms/receipts/client-reask.ts');
    expect(reask).toContain('if (!(await clientMeasuresReady()) || !(await askedTagReady())) return;');
    const confirm = code('src/modules/wms/receipts/client-confirm.ts');
    expect(confirm.slice(confirm.indexOf('async function lastAsk('), confirm.indexOf('function staffText('))).toContain('const withAuto = await askedTagReady();');
    expect(confirm.slice(confirm.indexOf('export async function clientReaskStatusFor('))).toContain('if (!(await askedTagReady())) return null;');
  });
});
