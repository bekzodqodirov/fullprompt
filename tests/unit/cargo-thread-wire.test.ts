import { readdirSync, readFileSync, statSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { describe, expect, it } from 'vitest';
import { THREAD_KINDS } from '@/modules/platform/notifications/thread-ref';
import { CARGO_THREAD_ERRORS } from '@/modules/wms/crm/cargo-thread';
import { WIDENED_THREAD_CHECKS } from '@/modules/wms/crm/thread';

/**
 * The cargo threads' WIRING (round 2, 0129), source-shape — comments stripped
 * first (#725: a fence must not match the sentence explaining it).
 *
 * The round exists twice over because a widened vocabulary FAILS SILENTLY: an
 * `if/else` chain whose last arm is another kind compiles and files a prixod
 * under the calc door, the clients table or «lid» (K1). The rest are the
 * places a correct rule is reached by the wrong road: a hand-typed kind list
 * (K2), a CHECK and its mirror and its «server behind» list drifting apart
 * (K3/K4), a door the action never asks (K5, #531), a «where it stands»
 * restated on the history (K6), a dock tab that restates grants (K7), a
 * staff clause written twice (K8), a file gate ordered after the arm it must
 * beat (K9), a word missing from a bundle (K10, #163), a place line printed
 * two ways (K11) and a mention judged without its scope (K12).
 */
const ROOT = resolve(__dirname, '../..');

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

const raw = (rel: string) => readFileSync(join(ROOT, rel), 'utf8');
const src = (rel: string) => stripComments(raw(rel));

/** From `start` to the first `end` after it. */
function between(text: string, start: string, end: string): string {
  const from = text.indexOf(start);
  expect(from, `anchor not found: ${start}`).toBeGreaterThanOrEqual(0);
  const to = text.indexOf(end, from + start.length);
  expect(to, `end not found after ${start}: ${end}`).toBeGreaterThan(from);
  return text.slice(from, to);
}

/** The index of the brace that closes the one at `open` — strings and template literals skipped. */
function closingBrace(text: string, open: number): number {
  let depth = 0;
  // A stack of contexts: 'code' (count braces) or a quote char; a template's `${` pushes code.
  const stack: string[] = ['code'];
  for (let i = open; i < text.length; i += 1) {
    const ch = text[i]!;
    const top = stack[stack.length - 1]!;
    if (top === "'" || top === '"') {
      if (ch === '\\') i += 1;
      else if (ch === top) stack.pop();
      continue;
    }
    if (top === '`') {
      if (ch === '\\') i += 1;
      else if (ch === '`') stack.pop();
      else if (ch === '$' && text[i + 1] === '{') {
        stack.push('tpl-code');
        depth += 1;
        i += 1;
      }
      continue;
    }
    if (ch === "'" || ch === '"' || ch === '`') {
      stack.push(ch);
      continue;
    }
    if (ch === '{') depth += 1;
    else if (ch === '}') {
      depth -= 1;
      if (top === 'tpl-code') {
        stack.pop();
        continue;
      }
      if (depth === 0) return i;
    }
  }
  return -1;
}

function walk(dir: string, accept: (rel: string) => boolean, found: string[] = []): string[] {
  for (const name of readdirSync(join(ROOT, dir))) {
    const rel = `${dir}/${name}`;
    if (statSync(join(ROOT, rel)).isDirectory()) walk(rel, accept, found);
    else if (accept(rel)) found.push(rel);
  }
  return found;
}

const KIND_TYPES = new Set(['ThreadRef', 'ThreadKind', 'CardKind', 'ThreadReadMark', 'idsByKind', 'isCargoKind']);

/** Every .ts file in src whose thread-ref import names a kind-carrying type or a kind helper — plus the two cargo homes. */
function kindFiles(): string[] {
  const files = walk('src', (rel) => rel.endsWith('.ts')).filter((rel) => {
    const text = raw(rel);
    for (const m of text.matchAll(/import\s+(?:type\s+)?\{([^}]*)\}\s+from\s+'[^']*notifications\/thread-ref'/g)) {
      const names = m[1]!
        .split(',')
        .map((part) => part.trim().replace(/^type\s+/, '').split(/\s+as\s+/)[0]!.trim())
        .filter(Boolean);
      if (names.some((name) => KIND_TYPES.has(name))) return true;
    }
    return false;
  });
  return [...new Set([...files, 'src/modules/wms/inventory/stands.ts', 'src/modules/wms/crm/cargo-thread.ts'])];
}

const KIND_LITERALS = THREAD_KINDS.join('|');

describe('K1 — every branch over a thread kind is exhaustive', () => {
  const files = kindFiles();

  it('the derived set holds the thread modules (a re-anchor guard)', () => {
    for (const rel of [
      'src/modules/wms/crm/thread.ts',
      'src/modules/wms/crm/thread-door.ts',
      'src/modules/wms/crm/internal-chat.ts',
      'src/modules/wms/crm/thread-reply.ts',
      'src/modules/platform/telegram/reply-door.ts',
    ]) {
      expect(files, rel).toContain(rel);
    }
  });

  // A kind is reached as `.kind` OR as a bare `entityType`/`kind` local
  // (internal-chat.ts's five card switches are `switch (entityType)`); the
  // lookbehind keeps another object's field — `request.entityType` — out.
  const KIND_EXPR = '(?:\\.kind|(?<![.\\w])(?:entityType|kind))';

  it('(a) no file compares a kind to a thread-kind literal', () => {
    const literal = new RegExp(`${KIND_EXPR}\\s*[!=]==?\\s*'(${KIND_LITERALS})'`);
    const offenders = files.filter((rel) => literal.test(src(rel)));
    expect(offenders).toEqual([]);
  });

  it('(b) every switch over a kind whose cases name a thread kind ends in a `never` default', () => {
    const caseLabel = new RegExp(`case\\s+'(${KIND_LITERALS})'\\s*:`);
    const offenders: string[] = [];
    const perFile = new Map<string, number>();
    let switches = 0;
    for (const rel of files) {
      const text = src(rel);
      for (const m of text.matchAll(/switch\s*\(([^()]*\.kind|entityType|kind)\)\s*\{/g)) {
        const open = m.index! + m[0].length - 1;
        const close = closingBrace(text, open);
        expect(close, `${rel}: unbalanced switch at ${m.index}`).toBeGreaterThan(open);
        const body = text.slice(open, close);
        if (!caseLabel.test(body)) continue;
        switches += 1;
        perFile.set(rel, (perFile.get(rel) ?? 0) + 1);
        if (!body.includes('const never: never')) offenders.push(`${rel}: switch (${m[1]})`);
      }
    }
    expect(switches, 're-anchor: no thread-kind switch found').toBeGreaterThanOrEqual(18);
    // The original fall-through sites: ownerOf, candidatesOf, involvementFilterOf,
    // cardLabel, doorlessLabel, linksFor (by `entityType`/`kind`) and the facts switch.
    expect(perFile.get('src/modules/wms/crm/internal-chat.ts') ?? 0, 're-anchor: internal-chat.ts').toBeGreaterThanOrEqual(7);
    expect(offenders).toEqual([]);
  });

  it('the dock’s THREADS block compares no row kind (its chat rows have a different union)', () => {
    const dock = src('src/components/dock.tsx');
    const start = '{tab === \'threads\' && canThreads && (';
    const end = "{tab === 'tasks' && (";
    expect(dock.split(start).length - 1, 'the threads block anchor, once').toBe(1);
    const block = between(dock, start, end);
    expect(dock.split(end).length - 1, 'the tasks block anchor, once').toBe(1);
    expect(block).not.toContain('row.kind ===');
  });
});

describe('K2 — the dock’s ping filter lists the kinds from the constant', () => {
  it('the literal list is built from THREAD_KINDS and nothing hand-types it', () => {
    const thread = src('src/modules/wms/crm/thread.ts');
    expect(thread).toContain("n.payload -> 'thread' ->> 'kind' IN (${THREAD_KIND_LIST})");
    expect(thread).toContain('const THREAD_KIND_LIST = sql.raw(THREAD_KINDS.map(');
    expect(thread).not.toContain("IN ('lead'");
  });
});

const MIGRATION = raw('src/modules/platform/db/migrations/0129_cargo_threads.sql');

/** The quoted values of one CHECK's IN list. */
const listOf = (check: string) => [...check.slice(check.indexOf('IN (')).matchAll(/'([a-z_]+)'/g)].map((m) => m[1]!);

describe('K3 — 0129’s two CHECK lists and their drizzle mirrors are the vocabulary', () => {
  it('crm_activities = every card kind; thread_reads = every thread kind; the mirrors say the same', () => {
    const cards = THREAD_KINDS.filter((kind) => kind !== 'calc');
    const entity = between(MIGRATION, 'ADD CONSTRAINT "crm_activities_entity_check"', ';');
    const reads = between(MIGRATION, 'ADD CONSTRAINT "thread_reads_kind_check"', ';');
    expect(new Set(listOf(entity))).toEqual(new Set(cards));
    expect(new Set(listOf(reads))).toEqual(new Set(THREAD_KINDS));
    const schema = src('src/modules/platform/db/schema/wms.ts');
    expect(new Set(listOf(between(schema, "check('crm_activities_entity_check'", ')`)')))).toEqual(new Set(cards));
    expect(new Set(listOf(between(schema, "check('thread_reads_kind_check'", ')`)')))).toEqual(new Set(THREAD_KINDS));
  });
});

describe('K4 — «server behind» names exactly what 0129 re-creates', () => {
  it('WIDENED_THREAD_CHECKS = the constraints the migration adds', () => {
    const added = [...MIGRATION.matchAll(/ADD CONSTRAINT "([a-z_]+)"/g)].map((m) => m[1]!);
    expect([...WIDENED_THREAD_CHECKS].sort()).toEqual(added.sort());
  });
});

describe('K5 — every door is asked where it is used (#531)', () => {
  it('the action asks the thread door and maps the half-applied deploy; both pages ask it and mark what they drew', () => {
    const action = src('src/modules/wms/crm/cargo-thread-actions.ts');
    expect(action).toContain('mayWriteThread(who, ref)');
    expect(action).toContain('isThreadWriteBehind(err)');
    for (const page of ['src/app/(protected)/receipts/[id]/page.tsx', 'src/app/(protected)/batches/[id]/page.tsx']) {
      const text = src(page);
      expect(text, page).toContain('mayReadThread(actor, cargoRef)');
      expect(text, page).toContain('<CargoThread');
      expect(text, page).toContain('<ThreadSeen refs={readMarks} />');
    }
    const read = src('src/app/api/threads/read/route.ts');
    expect(read).toContain('isThreadWriteBehind(err)');
    expect(read).not.toMatch(/import\s*\{[^}]*\bisServerBehind\b/);
  });

  it('a SCOPED person the card admits and the thread does not is told so on both pages — never a silently missing panel', () => {
    for (const page of ['src/app/(protected)/receipts/[id]/page.tsx', 'src/app/(protected)/batches/[id]/page.tsx']) {
      const text = src(page);
      expect(text.split('{cargoThread ? (').length - 1, `${page}: the branch anchor, once`).toBe(1);
      const branch = between(text, '{cargoThread ? (', '<ThreadSeen');
      expect(branch, page).toMatch(/\)\s*:\s*actor\.warehouseScoped\s*\?\s*\(/);
      expect(branch, page).toContain('data-testid="cargo-thread-elsewhere"');
      expect(branch, page).toContain("tth('cargo.elsewhere')");
      expect(branch, page).toMatch(/\)\s*:\s*null\s*\}\s*$/);
    }
  });
});

describe('K6 — «where it stands» is the live pointers, from the one status list', () => {
  it('stands.ts imports the live list and the unload counter, and reads no history', () => {
    const stands = src('src/modules/wms/inventory/stands.ts');
    expect(stands).toMatch(/import\s*\{[^}]*\bCLIENT_ACTIVE_STATUSES\b[^}]*\}\s*from '\.\.\/boxes\/active'/);
    expect(stands).toMatch(/import\s*\{[^}]*\bawaitingUnloadCounts\b[^}]*\}\s*from '\.\.\/scanning\/unload'/);
    expect(stands).not.toContain('box_movements');
    expect(stands).not.toContain("'in_stock'");
  });
});

describe('K7 — the dock tab asks the door', () => {
  it('layout.tsx hands the Dock `mayHaveThreads(actor)` and restates no grant there', () => {
    const layout = src('src/app/(protected)/layout.tsx');
    expect(layout).toContain('canThreads={mayHaveThreads(actor)}');
    const dock = between(layout, '<Dock', '/>');
    expect(dock).not.toContain("permissions.has('ved.docs')");
    expect(dock).not.toContain('permissions.has(');
  });
});

describe('K8 — «staff of a warehouse» is one clause with two askers', () => {
  it('both helpers ask scopedRoleSql; the staff list asks canLogIn', () => {
    const service = src('src/modules/platform/notifications/service.ts');
    const staff = between(service, 'export async function warehouseStaff(', '\n}\n');
    expect(staff).toContain("canLogInSql('u')");
    expect(staff).toContain('scopedRoleSql(');
    const withPermission = between(service, 'export async function warehouseStaffWithPermission(', '\n}\n');
    expect(withPermission).toContain('scopedRoleSql(');
    expect(service.split('FROM user_roles wsr').length - 1, 'the clause is written once').toBe(1);
  });
});

describe('K9 — the file gate beats the CRM arms', () => {
  it('a cargo note’s files are refused before the deal arm is reached', () => {
    const access = src('src/modules/wms/attachments/access.ts');
    const branch = between(access, "case 'crm_activity'", "case 'call_log'");
    const refuse = branch.indexOf("'cargo-thread-no-files'");
    const deal = branch.indexOf("row.entityType === 'deal'");
    expect(refuse).toBeGreaterThan(0);
    expect(deal, 'the cargo refusal comes first').toBeGreaterThan(refuse);
  });
});

describe('K10 — the words (#163 — anchored on the code, never bundle-vs-bundle)', () => {
  const bundles = ['uz', 'ru', 'en', 'zh-CN'].map((locale) => ({
    locale,
    data: JSON.parse(raw(`messages/${locale}.json`)) as Record<string, unknown>,
  }));
  const has = (data: Record<string, unknown>, path: string) =>
    path.split('.').reduce<unknown>((node, key) => (node as Record<string, unknown> | undefined)?.[key], data) !==
    undefined;

  it('every threads.cargo.* key the panel, the box and both pages name exists in all four bundles', () => {
    const keys = new Set<string>();
    for (const rel of [
      'src/components/cargo-thread.tsx',
      'src/components/cargo-thread-box.tsx',
      'src/app/(protected)/receipts/[id]/page.tsx',
      'src/app/(protected)/batches/[id]/page.tsx',
    ]) {
      const text = src(rel);
      const names = [...text.matchAll(/const (\w+) = (?:await )?(?:useTranslations|getTranslations)\('threads'\)/g)].map(
        (m) => m[1]!,
      );
      expect(names.length, `${rel} binds a threads translator`).toBeGreaterThan(0);
      for (const name of names) {
        for (const m of text.matchAll(new RegExp(`\\b${name}\\('(cargo\\.[^']+)'`, 'g'))) keys.add(m[1]!);
      }
    }
    expect(keys.size).toBeGreaterThanOrEqual(10);
    for (const { locale, data } of bundles) {
      for (const key of keys) expect(has(data, `threads.${key}`), `${locale} threads.${key}`).toBe(true);
      for (const code of CARGO_THREAD_ERRORS) {
        expect(has(data, `threads.cargo.errors.${code}`), `${locale} threads.cargo.errors.${code}`).toBe(true);
      }
      for (const field of ['noStaffAt', 'noOffice', 'nobody', 'more']) {
        expect(has(data, `threads.cargo.${field}`), `${locale} threads.cargo.${field}`).toBe(true);
      }
    }
  });

  it('the box speaks its own errors — never round 1’s «calculation not found»', () => {
    const box = src('src/components/cargo-thread-box.tsx');
    expect(box).toContain('t(`cargo.errors.${state.error}`)');
    expect(box).not.toMatch(/t\(`errors\./);
  });
});

describe('K11 — one place formatter over one dictionary', () => {
  it('the panel and the ping both call cargoNowLine; the place words are read in cargo-thread.ts alone', () => {
    const panel = src('src/components/cargo-thread.tsx');
    expect(panel).toContain('cargoNowLine(');
    expect(panel).toContain('notificationLabels(');
    expect(src('src/modules/wms/crm/internal-chat.ts')).toContain('cargoNowLine(');
    const home = 'src/modules/wms/crm/cargo-thread.ts';
    const words = ['cargoShelf', 'cargoRoad', 'cargoNoneLive', 'truckLoading', 'truckCancelled'];
    for (const word of words) expect(src(home), word).toContain(`.${word}`);
    const readers = walk('src', (rel) => /\.(ts|tsx)$/.test(rel) && rel !== home).filter((rel) => {
      const text = src(rel);
      return words.some((word) => new RegExp(`\\.${word}\\b`).test(text));
    });
    expect(readers).toEqual([]);
    for (const locale of ['uz', 'ru', 'en', 'zh-CN']) {
      const cargo = (JSON.parse(raw(`messages/${locale}.json`)) as { threads: { cargo: Record<string, unknown> } }).threads
        .cargo;
      expect(Object.keys(cargo).filter((key) => key === 'now' || key.startsWith('place') || key.startsWith('truck')), locale).toEqual(
        [],
      );
    }
  });
});

describe('K12 — the mention path judges the scope', () => {
  it('announceMentions loads actorGrants, never the grants alone', () => {
    const chat = src('src/modules/wms/crm/internal-chat.ts');
    const body = between(chat, 'export async function announceMentions(', '\n}\n');
    expect(body).toContain('actorGrants(');
    expect(body).not.toContain('userPermissions(');
  });
});
