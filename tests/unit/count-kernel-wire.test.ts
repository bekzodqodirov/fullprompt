import { readdirSync, readFileSync, statSync } from 'node:fs';
import { join, relative } from 'node:path';
import { describe, expect, it } from 'vitest';
import {
  COUNT_REASONS,
  NO_DOOR,
  SERVER_SCAN_REASONS,
  countReasonsFor,
  isServerScanReason,
} from '@/modules/wms/scanning/count-rules';
import { FOUNDERS, MUTE_GROUPS } from '@/modules/platform/notifications/mutes';
import { RULE_EVENTS } from '@/modules/platform/automation/service';

/*
 * The QR-siz kernel's wiring (0112). Source-shape on purpose: every half here
 * WORKS on its own — the fence is about which door can reach which body, and
 * a behavioural test only ever proves the doors it happens to call (#531).
 * Comments are stripped first, or a fence matches the sentence explaining it
 * (#725).
 */

const stripComments = (source: string) =>
  source.replace(/\/\*[\s\S]*?\*\//g, '').replace(/(^|[^:])\/\/.*$/gm, '$1');

const read = (path: string) => stripComments(readFileSync(path, 'utf8'));

function walk(dir: string): string[] {
  return readdirSync(dir).flatMap((name) => {
    const path = join(dir, name);
    if (statSync(path).isDirectory()) return walk(path);
    return /\.tsx?$/.test(name) ? [path] : [];
  });
}
const SRC = walk('src').map((path) => ({ path: relative('.', path), text: read(path) }));

/** The body of a top-level function, up to the next top-level declaration. */
function body(path: string, fn: string): string {
  const src = read(path);
  const start = src.search(new RegExp(`(export\\s+)?async function ${fn}\\(`));
  expect(start, `${fn} in ${path}`).toBeGreaterThanOrEqual(0);
  const rest = src.slice(start + 1);
  const next = rest.search(/\n(export |async function |function )/);
  return next === -1 ? src.slice(start) : src.slice(start, start + 1 + next);
}

const SERVICE = 'src/modules/wms/scanning/service.ts';
const UNLOAD = 'src/modules/wms/scanning/unload.ts';

describe('count kernel wiring', () => {
  /*
   * AMENDED deliberately in the reroute round (recorded in DECISIONS): the
   * phone's body moved out of the route into `wms/scanning/sync.ts`, which
   * partitions the body per truck, and the unload call now carries WHERE each
   * truck was admitted (`UnloadGuard.expectDest`, a fourth argument that is
   * not a door). What this fence exists for is unchanged and still asserted:
   * the phone's third argument is `NO_DOOR` and nothing else, and no door's
   * power (`door:`, `boxId`, `quietSpot`, `noticeWindowMinutes`) rides along.
   */
  it('the phone sync route reaches both ingests with no door', () => {
    const route = read('src/app/api/scan/sync/route.ts');
    expect(route).toContain('syncScans(');
    expect(route).not.toMatch(/ingest(Load|Unload)Scans\(/);
    const sync = read('src/modules/wms/scanning/sync.ts');
    const loads = [...sync.matchAll(/ingestLoadScans\(([^)]*)\)/g)].map((m) => m[1]);
    const unloads = [...sync.matchAll(/ingestUnloadScans\(([^)]*\}?)\)/g)].map((m) => m[1]);
    expect(loads).toEqual(['loads, ctx']);
    expect(unloads).toEqual(['unloads, ctx, NO_DOOR, { expectDest }']);
    for (const power of [/\bdoor\s*:/, /\bboxId\b/, /\bquietSpot\b/, /\bnoticeWindowMinutes\b/]) {
      expect(sync).not.toMatch(power);
      expect(route).not.toMatch(power);
    }
  });

  it('NO_DOOR is an empty frozen object — the phone’s answer, named', () => {
    const rules = read('src/modules/wms/scanning/count-rules.ts');
    expect(rules).toContain('export const NO_DOOR: Readonly<DoorOpts> = Object.freeze({});');
    expect(Object.keys(NO_DOOR)).toEqual([]);
    expect(Object.isFrozen(NO_DOOR)).toBe(true);
  });

  it('a door is opened only by the count doors and «Hammasini qabul qilish»', () => {
    // «door» is an ordinary word in this codebase (a cost-void door, a
    // legacy door); the one this fence is about is `DoorOpts.door`, which a
    // file can only hold by importing the count rules.
    const openers = SRC.filter(
      (f) => /from '[^']*count-rules'/.test(f.text) && /\bdoor\s*:/.test(f.text),
    ).map((f) => f.path);
    const allowed = [
      'src/modules/wms/scanning/count-load.ts',
      'src/modules/wms/scanning/count-accept.ts',
      UNLOAD,
    ];
    expect(openers.filter((p) => !allowed.includes(p))).toEqual([]);
    // Inside unload.ts, only «accept the rest» opens one.
    const unload = read(UNLOAD);
    const opened = [...unload.matchAll(/\bdoor\s*:/g)].map((m) => m.index!);
    const remaining = unload.indexOf('export async function unloadRemaining(');
    const after = unload.indexOf('\nexport ', remaining + 1);
    for (const at of opened) {
      expect(at > remaining && at < after, 'a door opened outside unloadRemaining').toBe(true);
    }
  });

  it('the shared bodies are called only from their ingest and their count door', () => {
    const callers = (fn: string) =>
      SRC.filter((f) => new RegExp(`\\b${fn}\\(`).test(f.text.replace(new RegExp(`function ${fn}\\(`, 'g'), '')))
        .map((f) => f.path)
        .sort();
    const load = callers('loadScanInTx');
    const unload = callers('landUnloadInput');
    expect(load.filter((p) => ![SERVICE, 'src/modules/wms/scanning/count-load.ts'].includes(p))).toEqual([]);
    expect(unload.filter((p) => ![UNLOAD, 'src/modules/wms/scanning/count-accept.ts'].includes(p))).toEqual([]);
    expect(load).toContain(SERVICE);
    expect(unload).toContain(UNLOAD);
  });

  it('a forged server reason is refused before anything is written — and before the arrival flip', () => {
    for (const [path, fn] of [
      [SERVICE, 'loadScanInTx'],
      [UNLOAD, 'landUnloadInput'],
    ] as const) {
      const text = body(path, fn);
      const reserved = text.indexOf("'reserved_reason'");
      expect(reserved, fn).toBeGreaterThan(0);
      expect(text.indexOf('isServerScanReason(input.manualReason)'), fn).toBeLessThan(reserved);
      // Before the replay check, the first read and every write.
      for (const later of ['clientEventUuid, input.clientEventUuid)', 'tx.query.batches', 'tx.update(', 'tx.insert(']) {
        const at = text.indexOf(later);
        if (at !== -1) expect(reserved, `${fn}: ${later}`).toBeLessThan(at);
      }
    }
    const unload = body(UNLOAD, 'landUnloadInput');
    expect(unload.indexOf("'reserved_reason'")).toBeLessThan(unload.indexOf("status: 'arrived'"));
  });

  it('every loading change takes the truck lock as its first statement', () => {
    for (const [path, fn] of [
      [SERVICE, 'removeLoadedCode'],
      [SERVICE, 'finishLoading'],
      [SERVICE, 'departBatch'],
      [UNLOAD, 'cancelBatch'],
    ] as const) {
      const text = body(path, fn);
      const tx = text.indexOf('db.transaction(async (tx) => {');
      expect(tx, fn).toBeGreaterThan(0);
      const firstAwait = text.indexOf('await ', tx);
      expect(text.slice(firstAwait, firstAwait + 'await lockTruckLoading(tx'.length), fn).toBe(
        'await lockTruckLoading(tx',
      );
    }
  });

  it('the count reasons are exactly the ones 0112 indexes', () => {
    const migration = readFileSync('src/modules/platform/db/migrations/0112_qr_less.sql', 'utf8');
    const inList = /"manual_reason" IN \(([^)]*)\)/.exec(migration)?.[1];
    expect(inList).toBeDefined();
    const indexed = [...inList!.matchAll(/'([a-z_]+)'/g)].map((m) => m[1]).sort();
    expect(indexed).toEqual([...COUNT_REASONS].sort());
    // …and the schema says the same, or `drizzle-kit` would drift from it.
    const schema = readFileSync('src/modules/platform/db/schema/wms.ts', 'utf8');
    const schemaList = /manualReason\} IN \(([^)]*)\)/.exec(schema)?.[1];
    expect([...schemaList!.matchAll(/'([a-z_]+)'/g)].map((m) => m[1]).sort()).toEqual(indexed);
  });

  it('the count rules never name the departure — membership is batchMemberFilter’s', () => {
    expect(readFileSync('src/modules/wms/scanning/count-rules.ts', 'utf8')).not.toContain('batch_departed');
  });
});

describe('the shortfall alarm', () => {
  it('is an alert a person can mute, a newcomer to its group, and no automation trigger', () => {
    expect(MUTE_GROUPS.alerts).toContain('CountShortfall');
    for (const founders of Object.values(FOUNDERS)) expect(founders).not.toContain('CountShortfall');
    // A rule firing on it would be a second alarm for one missing carton.
    expect(RULE_EVENTS as readonly string[]).not.toContain('CountShortfall');
  });
});

describe('server reasons', () => {
  it('knows exactly its four, trimmed, and nothing a phone writes', () => {
    for (const r of SERVER_SCAN_REASONS) {
      expect(isServerScanReason(r)).toBe(true);
      expect(isServerScanReason(` ${r} `)).toBe(true);
    }
    for (const r of ['manual', 'sticker_lost', 'COUNT_LOAD', 'count', '', null, undefined]) {
      expect(isServerScanReason(r as string | null | undefined)).toBe(false);
    }
  });

  it('a side names its own count reasons', () => {
    expect(countReasonsFor('load')).toEqual(['count_load']);
    expect([...countReasonsFor('unload')].sort()).toEqual(['count_accept', 'count_over']);
    expect([...countReasonsFor('any')].sort()).toEqual([...COUNT_REASONS].sort());
  });
});
