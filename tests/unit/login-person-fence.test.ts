import { readdirSync, readFileSync, statSync } from 'node:fs';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';

/**
 * A person who never signs in (0120, the owner's 2b) is an ordinary `users`
 * row — so every place that ever read `users.active` to mean «a colleague»
 * would quietly offer a warehouse worker in China as a task assignee, a
 * mention, a lead owner, a website manager or a Telegram recipient. The rule
 * has ONE home (`platform/users/login.ts`: `canLogIn` / `canLogInSql`), and
 * this fence is DERIVED from the tree so a site written tomorrow is red the
 * day it is written, not the day he sees a Chinese worker's name in a picker.
 *
 *  (1) THE `.active` RULE — every `users.active` (and every `<alias>.active`
 *      for an alias a raw query declares over `users`) is counted per file:
 *      zero outside the rule's home, the writer's module, and a named payroll
 *      allowlist with EXACT counts (a stale entry is red too).
 *  (2) NAMED GUARDS the regex cannot see — relational reads and row objects
 *      (`person.active`) — anchored on function names the scan must find
 *      (#720: a fence that finds nothing proves nothing).
 *  (3) THE WRITER — only platform/users/service.ts writes a person's
 *      credentials, activity, login switch, roles and warehouses; login →
 *      no-login has no writer at all.
 *  (4) WHO MAY CALL WHAT — /hodimlar's actions reach the three no-login
 *      doors and nothing else; the login doors are /admin/users' alone.
 *
 * Comments are stripped first (#725 — a fence that reads the codebase's own
 * explanations as code finds the sentence explaining itself). The line form
 * keeps `https://` alive.
 *
 * BLIND SPOTS, decided and not forgotten:
 *  - an UNALIASED raw `FROM users … WHERE active` (no `users.` prefix, no
 *    alias) is invisible to (1); none exists today;
 *  - relational `columns: { active: true }` reads are invisible to (1) —
 *    `openPromiseTask` is anchored by name in (2); the notification drain's
 *    `recipient?.active` (notifications/service.ts) is deliberately LEFT: a
 *    no-login row is never linked to a chat, so the drain settles it `muted`;
 *  - the custom-field lookup to the `user` entity (fields/registry.ts +
 *    fields/service.ts `lookupChoices`) is deliberately a DATA picker: a
 *    lookup value records which person a card is about and notifies nobody,
 *    and «who measured this» may well be a worker in China.
 */

const strip = (src: string) => src.replace(/\/\*[\s\S]*?\*\//g, '').replace(/(^|[^:])\/\/.*$/gm, '$1');

function walk(dir: string, out: string[] = []): string[] {
  for (const name of readdirSync(dir)) {
    const path = join(dir, name);
    if (statSync(path).isDirectory()) walk(path, out);
    else if (/\.(ts|tsx)$/.test(name)) out.push(path);
  }
  return out;
}

const FILES = walk('src').map((path) => ({ path, src: strip(readFileSync(path, 'utf8')) }));
const byPath = (path: string) => {
  const file = FILES.find((f) => f.path === path);
  expect(file, path).toBeDefined();
  return file!.src;
};

/** A function's body: from `function <name>` to the next line that begins with `}`. */
function body(path: string, name: string): string {
  const src = byPath(path);
  const start = src.search(new RegExp(`\\bfunction\\s+${name}\\s*[(<]`));
  expect(start, `${path}#${name}`).toBeGreaterThan(-1);
  const end = src.indexOf('\n}', start);
  return src.slice(start, end === -1 ? undefined : end);
}

const KEYWORDS = new Set([
  'on', 'where', 'join', 'left', 'inner', 'using', 'and', 'or', 'set', 'order', 'group', 'limit',
  'lateral', 'cross', 'natural', 'full', 'right', 'select', 'values',
]);

function activeReads(src: string): number {
  let n = (src.match(/\busers\.active\b/g) ?? []).length;
  const aliases = new Set<string>();
  for (const m of src.matchAll(/\b(?:FROM|JOIN)\s+users\s+(?:AS\s+)?([a-z_]\w*)/gi)) {
    if (!KEYWORDS.has(m[1]!.toLowerCase())) aliases.add(m[1]!);
  }
  for (const alias of aliases) n += (src.match(new RegExp(`\\b${alias}\\.active\\b`, 'g')) ?? []).length;
  return n;
}

const EXEMPT = new Set(['src/modules/platform/users/login.ts', 'src/modules/platform/users/service.ts']);

/** Payroll WANTS the person, logins or not — each read counted exactly. */
const ALLOW: Record<string, { count: number; why: string }> = {
  'src/app/(protected)/hodimlar/page.tsx': { count: 1, why: 'payroll lists everyone' },
  'src/app/(protected)/accounting/expenses/page.tsx': {
    count: 1,
    why: 'an employee on an expense is anyone paid',
  },
  'src/app/(protected)/kontragentlar/page.tsx': {
    count: 1,
    why: 'a staff advance account may belong to a person with no login',
  },
  'src/app/(protected)/kontragentlar/[id]/page.tsx': {
    count: 2,
    why: 'the same, plus the leaver already linked',
  },
  'src/modules/wms/partners/service.ts': { count: 1, why: 'savePartner validates that link' },
  'src/modules/wms/crm/seller-report.ts': {
    count: 1,
    why: 'marks a seller who holds stamped money «(faol emas)» (4a); it names, it never picks a colleague',
  },
  'src/modules/wms/accounting/service.ts': {
    count: 1,
    why: 'saveRecurring mints a salary only on a person who still works here, logins or not',
  },
};

describe('(1) a users-table .active read is the rule’s, the writer’s or payroll’s', () => {
  it('scans the tree it guards', () => {
    expect(FILES.length).toBeGreaterThanOrEqual(1000);
    const allowHits = Object.keys(ALLOW).filter((path) => activeReads(byPath(path)) > 0);
    expect(allowHits.length).toBeGreaterThan(0);
  });

  it('every other file reads a colleague through canLogIn', () => {
    const offenders = FILES.filter((f) => !EXEMPT.has(f.path) && !(f.path in ALLOW) && activeReads(f.src) > 0).map(
      (f) => `${f.path}: ${activeReads(f.src)}`,
    );
    expect(offenders).toEqual([]);
  });

  it('each payroll entry still matches its count — a stale allowance is red too', () => {
    for (const [path, { count, why }] of Object.entries(ALLOW)) {
      expect(activeReads(byPath(path)), `${path} (${why})`).toBe(count);
    }
  });
});

describe('(2) the single-row guards ask the rule, by name', () => {
  const GUARDS: [path: string, fn: string, token: string][] = [
    ['src/modules/platform/auth/actions.ts', 'loginAction', 'canLogIn('],
    ['src/modules/platform/auth/session.ts', 'getSessionUser', 'canLogIn('],
    ['src/modules/platform/tasks/service.ts', 'createTask', 'canLogIn('],
    ['src/modules/platform/tasks/service.ts', 'reassignTask', 'canLogIn('],
    ['src/modules/wms/debt/promises.ts', 'openPromiseTask', 'canLogIn('],
    ['src/modules/platform/telegram/staff-bot.ts', 'staffForChat', 'canLogInSql('],
    ['src/modules/platform/telegram/staff-bot.ts', 'staffByPhone', 'canLogInSql('],
    ['src/modules/platform/tasks/view.ts', 'assignablePeople', 'canLogInSql('],
    ['src/modules/platform/tasks/digest.ts', 'sendTaskDigest', 'canLogInSql('],
    ['src/modules/wms/crm/internal-chat.ts', 'mentionablePeople', 'canLogInSql('],
    ['src/modules/wms/crm/share.ts', 'shareTargets', 'canLogInSql('],
    ['src/modules/wms/crm/share.ts', 'shareMessage', 'canLogInSql('],
    ['src/modules/wms/crm/routing.ts', 'rotaMembers', 'canLogInSql('],
    ['src/modules/wms/crm/routing.ts', 'setRotaMembers', 'canLogInSql('],
    ['src/modules/wms/crm/routing.ts', 'createRoute', 'canLogInSql('],
    ['src/modules/wms/crm/routing.ts', 'nextInboundOwner', 'canLogInSql('],
    ['src/modules/wms/crm/site-assign.ts', 'roster', 'canLogInSql('],
    ['src/modules/wms/crm/site-assign.ts', 'saveSiteTeams', 'canLogInSql('],
    ['src/modules/wms/crm/site-assign.ts', 'assignForTag', 'canLogInSql('],
    ['src/modules/platform/users/service.ts', 'enableLogin', 'staffPhonesMatch('],
  ];
  for (const [path, fn, token] of GUARDS) {
    it(`${path.replace('src/modules/', '')}#${fn} asks ${token}`, () => {
      expect(body(path, fn)).toContain(token);
    });
  }

  it('both identity reads skip a row that is not a login', () => {
    const find = body('src/modules/platform/auth/identify.ts', 'findUserByIdentifier');
    expect(find.match(/loginRowSql\(/g)?.length ?? 0).toBeGreaterThanOrEqual(2);
  });

  it('the audit screen’s actor filter lists logins, leavers included', () => {
    expect(byPath('src/app/(protected)/admin/audit/page.tsx')).toContain('loginRowSql(');
  });
});

describe('(3) one writer of a person', () => {
  const WRITER = 'src/modules/platform/users/service.ts';
  // A relational `columns: { … }` projection READS a column; it writes nothing.
  const withoutProjections = (src: string) => src.replace(/columns:\s*\{[^}]*\}/g, '');
  const RULES: [label: string, pattern: RegExp][] = [
    ['writes user_roles / user_warehouses', /\b(insert|delete|update)\((userRoles|userWarehouses)\)/],
    ['writes user_roles / user_warehouses in raw SQL', /\b(INSERT INTO|DELETE FROM|UPDATE)\s+user_(roles|warehouses)\b/i],
    ['inserts a person', /\binsert\(users\)/],
    [
      'sets a person’s activity, login switch, password or phone',
      /\bupdate\(users\)\s*\.set\(\{[^}]*\b(active|loginEnabled|passwordHash|phone)\s*:/,
    ],
    ['writes the login switch', /loginEnabled:\s*(true|false)|login_enabled\s*=\s*(true|false)/],
  ];

  for (const [label, pattern] of RULES) {
    it(`nobody but the writer ${label}`, () => {
      const hits = FILES.filter((f) => f.path !== WRITER && pattern.test(withoutProjections(f.src))).map((f) => f.path);
      expect(hits).toEqual([]);
    });
  }

  it('the writer is found and does write', () => {
    const writer = byPath(WRITER);
    for (const [label, pattern] of RULES.slice(0, 1).concat(RULES.slice(2))) {
      expect(pattern.test(writer), label).toBe(true);
    }
  });

  it('«no login» is written only by the mint, «a login» only by the conversion — login → no-login has no writer', () => {
    const writer = byPath(WRITER);
    const mint = body(WRITER, 'mintNoLoginPerson');
    const enable = body(WRITER, 'enableLogin');
    const falses = writer.match(/loginEnabled:\s*false/g)?.length ?? 0;
    const trues = writer.match(/loginEnabled:\s*true/g)?.length ?? 0;
    expect(falses).toBeGreaterThan(0);
    expect(trues).toBeGreaterThan(0);
    expect(mint.match(/loginEnabled:\s*false/g)?.length ?? 0).toBe(falses);
    expect(enable.match(/loginEnabled:\s*true/g)?.length ?? 0).toBe(trues);
  });

  it('the three no-login doors never touch roles or warehouses', () => {
    for (const fn of ['mintNoLoginPerson', 'editNoLoginPerson', 'setNoLoginPersonActive']) {
      const b = body(WRITER, fn);
      expect(b, fn).not.toMatch(/setRolesAndWarehouses|userRoles|userWarehouses/);
    }
  });

  it('the roles writer and the activity flip are private', () => {
    expect(byPath(WRITER)).not.toMatch(/export\s+(async\s+)?function\s+(setRolesAndWarehouses|flipActive)\b/);
  });
});

describe('(4) who may call which door', () => {
  it('/hodimlar reaches exactly the three no-login doors', () => {
    const actions = byPath('src/app/(protected)/hodimlar/actions.ts');
    const imp = /import\s*\{([^}]*)\}\s*from\s*'@\/modules\/platform\/users\/service'/.exec(actions);
    expect(imp, 'the import').not.toBeNull();
    const names = imp![1]!
      .split(',')
      .map((s) => s.trim())
      .filter(Boolean)
      .sort();
    expect(names).toEqual(['UserWriteError', 'editNoLoginPerson', 'mintNoLoginPerson', 'setNoLoginPersonActive']);
  });

  it('the login doors are called from /admin/users and nowhere else', () => {
    const callers = FILES.filter((f) => /\b(createLogin|updateLogin|enableLogin|toggleUserActive)\(/.test(f.src)).map(
      (f) => f.path,
    );
    expect(callers.sort()).toEqual(
      ['src/app/(protected)/admin/users/actions.ts', 'src/modules/platform/users/service.ts'].sort(),
    );
  });
});
