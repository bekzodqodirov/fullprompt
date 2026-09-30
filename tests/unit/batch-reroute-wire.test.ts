import { existsSync, readdirSync, readFileSync, statSync } from 'node:fs';
import { dirname, join, relative } from 'node:path';
import { describe, expect, it } from 'vitest';
import { FOUNDERS, MUTE_GROUPS } from '@/modules/platform/notifications/mutes';
import { RULE_EVENTS } from '@/modules/platform/automation/service';
import { REROUTE_REFUSALS } from '@/modules/wms/batches/reroute-rules';
import en from '../../messages/en.json';
import ru from '../../messages/ru.json';
import uz from '../../messages/uz.json';
import zh from '../../messages/zh-CN.json';

/*
 * «Yo'nalishni o'zgartirish» — the wiring (the reroute round). Source-shape on
 * purpose: every half here WORKS on its own — the fence is about who writes
 * the destination, which door carries which warehouse, and in what order
 * (#531: a behavioural test proves only the doors it happens to call). The
 * behaviour is `tests/integration/batch-reroute.integration.test.ts`.
 *
 * DERIVED where it can be, and anchored on names it MUST find, so a parse
 * that silently finds nothing cannot pass (#720).
 */

/** Comments out, strings kept — batch-door-wire's stripper (#725: a fence must not match its own sentence). */
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

function walk(dir: string): string[] {
  return readdirSync(dir).flatMap((name) => {
    const path = join(dir, name);
    if (statSync(path).isDirectory()) return walk(path);
    return /\.tsx?$/.test(name) ? [path] : [];
  });
}

/** The argument text of every call to `name(` — balanced. */
function callArgs(text: string, name: string): string[] {
  const out: string[] = [];
  for (const match of text.matchAll(new RegExp(`\\b${name}\\(`, 'g'))) {
    const open = match.index! + match[0].length - 1;
    let depth = 0;
    for (let i = open; i < text.length; i += 1) {
      if (text[i] === '(') depth += 1;
      else if (text[i] === ')') {
        depth -= 1;
        if (depth === 0) {
          out.push(text.slice(open + 1, i));
          break;
        }
      }
    }
  }
  return out;
}

/** A top-level function's text, from its declaration to the next top-level one. */
function body(path: string, fn: string): string {
  const src = read(path);
  const start = src.search(new RegExp(`(export\\s+)?(async\\s+)?function ${fn}\\(`));
  expect(start, `${fn} in ${path}`).toBeGreaterThanOrEqual(0);
  const rest = src.slice(start + 1);
  const next = rest.search(/\n(export |async function |function |const |interface |type )/);
  return next === -1 ? src.slice(start) : src.slice(start, start + 1 + next);
}

const REROUTE = 'src/modules/wms/batches/reroute.ts';
const RULES = 'src/modules/wms/batches/reroute-rules.ts';
const UNLOAD = 'src/modules/wms/scanning/unload.ts';
const SYNC = 'src/modules/wms/scanning/sync.ts';
const ACTIONS = 'src/app/(protected)/batches/batch-actions-server.ts';

describe('(a) the one writer of a truck’s destination', () => {
  const files = walk('src').map((path) => ({ path: relative('.', path), text: read(path) }));

  it('exactly one — drizzle or raw SQL — and it is the reroute service', () => {
    const hits: string[] = [];
    let updates = 0;
    for (const { path, text } of files) {
      for (const match of text.matchAll(/\.update\(batches\)/g)) {
        updates += 1;
        const after = text.slice(match.index!);
        const set = callArgs(after, 'set')[0] ?? '';
        // `.set(` must belong to THIS update: nothing but whitespace between.
        if (/^\.update\(batches\)\s*\.set\(/.test(after) && /\bdestWarehouseId\b/.test(set)) hits.push(path);
      }
      for (const _ of text.matchAll(/UPDATE\s+batches\s+SET\b((?:(?!\bWHERE\b)[^`])*?)\bdest_warehouse_id\s*=/gi)) {
        hits.push(`${path} (raw)`);
      }
    }
    // The parse found the codebase's truck writers at all (finish, depart,
    // the pin, the flags…) — a scan that sees none proves nothing.
    expect(updates).toBeGreaterThanOrEqual(10);
    expect(hits).toEqual([REROUTE]);
  });
});

describe('(b) the action’s door', () => {
  it('rerouteBatchAction asks the card’s door with the reroute’s own power', () => {
    const text = body(ACTIONS, 'rerouteBatchAction');
    expect(callArgs(text, 'authorizeOnBatch')).toEqual(["'plans.manage', batchId"]);
    expect(callArgs(text, 'authorize')).toEqual([]);
    expect(text).toContain("if (!door) return { ok: false, error: 'batch_not_found' };");
    // A scope refusal is its own sentence, not «only an admin or a logist».
    expect(text).toContain("'out_of_scope' : 'forbidden'");
  });
});

describe('(c) the phone’s landing re-judges the destination it was admitted at', () => {
  const text = body(UNLOAD, 'landUnloadInput');
  const replay = text.indexOf("detail: 'replay'");
  const compare = text.indexOf('if (expected && batch.destWarehouseId !== expected)');
  const branch = text.indexOf("if (batch.status === 'in_transit') {");

  it('the compare runs on EVERY read — after the replay check, before the in-transit branch', () => {
    expect(replay).toBeGreaterThan(0);
    expect(text).toContain('const expected = guard.expectDest?.get(input.batchId);');
    expect(compare).toBeGreaterThan(replay);
    expect(branch).toBeGreaterThan(compare);
  });

  it('inside the branch: the row lock, then the re-read, then the flip', () => {
    const inside = text.slice(branch, text.indexOf('const isCrate', branch));
    const lock = inside.indexOf(".for('no key update')");
    const flip = inside.indexOf('.update(batches)');
    expect(lock).toBeGreaterThan(0);
    expect(flip).toBeGreaterThan(lock);
    expect(inside).toContain("detail: 'batch_not_unloading'");
    expect(inside).toContain('if (fresh.destWarehouseId !== (expected ?? batch.destWarehouseId))');
    expect(inside).toContain('reroutedAck(tx, input, fresh.destWarehouseId)');
    expect(body(UNLOAD, 'reroutedAck')).toContain("detail: 'batch_rerouted'");
  });
});

describe('(d) the phone’s sync', () => {
  it('passes NO_DOOR and the destination each truck was admitted at', () => {
    const sync = read(SYNC);
    expect(sync).toContain('ingestUnloadScans(unloads, ctx, NO_DOOR, { expectDest })');
    expect(sync).toContain('expectDest.set(truck.id, truck.destWarehouseId);');
    // Per truck — the whole-body refusal lives nowhere in the body now.
    expect(sync).not.toMatch(/\bauthorize\(/);
    expect(read('src/app/api/scan/sync/route.ts')).toContain(
      'if (result.acks.length === 0 && result.withheld.length > 0)',
    );
  });
});

describe('(e) the office doors', () => {
  it('«Hammasini qabul qilish» refuses before it writes its audit row', () => {
    const text = body(UNLOAD, 'unloadRemaining');
    const upFront = text.indexOf("if (opts.expectDestId && batch.destWarehouseId !== opts.expectDestId) throw new ScanError('batch_rerouted');");
    const afterAcks = text.indexOf("if (rerouted > 0 && landed.length === 0) throw new ScanError('batch_rerouted');");
    const audit = text.indexOf('writeAudit(');
    expect(upFront).toBeGreaterThan(0);
    expect(afterAcks).toBeGreaterThan(upFront);
    expect(audit).toBeGreaterThan(afterAcks);
    expect(text).toContain('{ expectDest: new Map([[batchId, opts.expectDestId ?? batch.destWarehouseId]]) }');
  });

  it('«Tushirish tugadi» compares on the LOCKED row', () => {
    const text = body(UNLOAD, 'finishUnload');
    const lock = text.indexOf(".for('no key update')");
    const compare = text.indexOf('if (opts.expectDestId && batch.destWarehouseId !== opts.expectDestId)');
    expect(lock).toBeGreaterThan(0);
    expect(compare).toBeGreaterThan(lock);
    expect(text.indexOf("throw new ScanError('batch_rerouted')")).toBeGreaterThan(compare);
    expect(text.indexOf('.update(boxes)')).toBeGreaterThan(compare);
  });

  it('both actions post the destination the page was drawn for', () => {
    for (const fn of ['unloadRemainingAction', 'finishUnloadAction']) {
      const text = body(ACTIONS, fn);
      expect(text, fn).toContain('const at = isUuidShaped(seenDestWarehouseId) ? seenDestWarehouseId : batch.destWarehouseId;');
      expect(text, fn).toMatch(/authorize\('(receipts\.void|scan\.unload)', \{ warehouseId: at \}\)/);
      expect(text, fn).toContain('expectDestId: at');
    }
    const buttons = read('src/app/(protected)/batches/[id]/unload-actions.tsx');
    expect(buttons).toContain('unloadRemainingAction(batchId, destWarehouseId)');
    expect(buttons).toContain('finishUnloadAction(batchId, destWarehouseId)');
    const panel = read('src/app/(protected)/batches/[id]/count-accept-panel.tsx');
    expect(panel.match(/seenDestWarehouseId: destWarehouseId/g) ?? []).toHaveLength(2);
    const page = read('src/app/(protected)/batches/[id]/yuklash/page.tsx');
    expect(page.match(/destWarehouseId=\{batch\.destWarehouseId\}/g) ?? []).toHaveLength(2);
  });
});

describe('(f) every refusal reaches the person in words', () => {
  it('the office buttons name it; the phone screen hears it before the count-only refusals', () => {
    const buttons = read('src/app/(protected)/batches/[id]/unload-actions.tsx');
    expect(buttons).toContain("case 'batch_rerouted':");
    expect(buttons).toContain("t('errors.batch_rerouted')");
    const screen = read('src/app/(protected)/batches/[id]/unload/unload-screen.tsx');
    const branch = screen.indexOf("if (ack.detail === 'batch_rerouted') {");
    expect(branch).toBeGreaterThan(0);
    expect(branch).toBeLessThan(screen.indexOf('isScanRefusal(ack.detail)'));
    expect(screen).toContain('data-testid="unload-rerouted"');
    // A 409 drops the cached snapshot instead of applying it.
    expect(screen).toContain('localStorage.removeItem(cacheKey);');
  });

  it('every reroute refusal has its sentence in all four bundles', () => {
    for (const [name, bundle] of Object.entries({ en, ru, uz, zh })) {
      const errors = (bundle as { batches: { reroute: { errors: Record<string, string> } } }).batches.reroute.errors;
      for (const code of [...REROUTE_REFUSALS, 'busy_retry', 'validation', 'offline']) {
        expect(typeof errors[code], `${name}: batches.reroute.errors.${code}`).toBe('string');
      }
    }
  });
});

describe('(g) the Telegram can be muted, as work news', () => {
  it('is in «ish jarayoni», a newcomer, and no automation trigger', () => {
    expect(MUTE_GROUPS.operations).toContain('BatchRerouted');
    for (const founders of Object.values(FOUNDERS)) expect(founders).not.toContain('BatchRerouted');
    expect(RULE_EVENTS as readonly string[]).not.toContain('BatchRerouted');
  });
});

describe('(h) the Mashina tab draws the form for the reroute’s own door', () => {
  it('only under mayRerouteTruck, with the options the service admits', () => {
    const page = read('src/app/(protected)/batches/[id]/mashina/page.tsx');
    expect(page).toContain('const mayReroute = mayRerouteTruck(actor, batch);');
    expect(page).toContain('const rerouteOptions = mayReroute ? await rerouteTargets(batch, head, actor) : [];');
    expect(page).toMatch(/\{mayReroute && \(\s*<RerouteForm/);
    // The form imports the refusal TYPE only (#276).
    const form = read('src/app/(protected)/batches/[id]/mashina/reroute-form.tsx');
    expect(form).toContain("import type { RerouteErrorCode } from '@/modules/wms/batches/reroute-rules';");
    expect(form).not.toMatch(/import \{[^}]*\} from '@\/modules\/wms\/batches\/reroute/);
  });
});

describe('(i) answer 5a holds the customer’s journey', () => {
  it('journey.ts keys on the departure’s COUNTRY and the rule still refuses another country', () => {
    const journey = read('src/modules/wms/client-cabinet/journey.ts');
    expect(journey).toContain("if (e.cause === 'batch_departed') {");
    expect(journey).toContain("if (e.toCountry === 'CN') claim('toHub', e.at);");
    // Widening answer 5 turns THIS red, at the reader that must change first.
    expect(read(RULES)).toContain("if (from !== to) return 'other_country';");
  });
});

describe('(j) the pure rules stay pure', () => {
  it('nothing reroute-rules.ts imports reaches the database client, however far', () => {
    const seen = new Set<string>();
    const resolve = (from: string, spec: string): string | null => {
      let base: string;
      if (spec.startsWith('@/')) base = join('src', spec.slice(2));
      else if (spec.startsWith('.')) base = join(dirname(from), spec);
      else return null; // a package
      for (const candidate of [`${base}.ts`, `${base}.tsx`, join(base, 'index.ts')]) {
        if (existsSync(candidate)) return candidate;
      }
      return null;
    };
    const visit = (path: string) => {
      if (seen.has(path)) return;
      seen.add(path);
      const src = read(path);
      for (const m of src.matchAll(/(?:from\s+|import\()\s*'([^']+)'/g)) {
        // A type-only import ships nothing to the browser.
        const line = src.slice(src.lastIndexOf('\n', m.index!) + 1, m.index!);
        if (/^\s*import\s+type\b/.test(line)) continue;
        const next = resolve(path, m[1]!);
        if (next) visit(next);
      }
    };
    visit(RULES);
    // Anchored: the walk found what it must.
    expect([...seen]).toContain('src/modules/wms/batches/country-key.ts');
    expect([...seen]).toContain('src/modules/platform/rbac/scope.ts');
    expect([...seen].filter((p) => p.includes('platform/db/'))).toEqual([]);
  });
});
