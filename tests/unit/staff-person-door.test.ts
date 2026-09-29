import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';

/**
 * The doors of a person who never signs in (0120, the owner's 2b), pinned by
 * SHAPE because a server action reads cookies and cannot be driven from an
 * integration test (#531): the services behind them are integration-tested
 * in no-login-staff.integration.test.ts; what this file guards is that every
 * door asks its question, parses what was posted, and only then calls the
 * writer — in that order.
 */
const strip = (src: string) =>
  src.replace(/\/\*[\s\S]*?\*\//g, '').replace(/\{\/\*[\s\S]*?\*\/\}/g, '').replace(/(^|[^:])\/\/.*$/gm, '$1');
const read = (path: string) => strip(readFileSync(path, 'utf8'));

function fn(src: string, name: string): string {
  const start = src.indexOf(`export async function ${name}(`);
  expect(start, name).toBeGreaterThan(-1);
  const end = src.indexOf('\nexport ', start + 10);
  return src.slice(start, end === -1 ? undefined : end);
}

describe('/hodimlar — the payroll door, then the parse, then the writer', () => {
  const actions = read('src/app/(protected)/hodimlar/actions.ts');
  const DOORS: [action: string, service: string][] = [
    ['mintPersonAction', 'mintNoLoginPerson('],
    ['editPersonAction', 'editNoLoginPerson('],
    ['setPersonActiveAction', 'setNoLoginPersonActive('],
  ];
  for (const [action, service] of DOORS) {
    it(action, () => {
      const body = fn(actions, action);
      const door = body.indexOf('maySeeStaffMoney(actor.permissions)');
      const parse = body.indexOf('safeParse(');
      const call = body.indexOf(service);
      expect(door, 'door').toBeGreaterThan(-1);
      expect(parse, 'parse').toBeGreaterThan(door);
      expect(call, 'service').toBeGreaterThan(parse);
    });
  }
});

describe('/admin/users — thin doors over the one writer', () => {
  const actions = read('src/app/(protected)/admin/users/actions.ts');

  it('the conversion starts at the admin door', () => {
    const body = fn(actions, 'enableLoginAction');
    expect(body.indexOf("authorize('admin.users.manage')")).toBeGreaterThan(-1);
    expect(body.indexOf("authorize('admin.users.manage')")).toBeLessThan(body.indexOf('enableLogin('));
  });

  it('the conversion is called from a click, so it never redirects (round 60)', () => {
    expect(fn(actions, 'enableLoginAction')).not.toContain('redirect(');
  });

  it('create, update and toggle call the writer', () => {
    expect(fn(actions, 'createUserAction')).toContain('createLogin(');
    expect(fn(actions, 'updateUserAction')).toContain('updateLogin(');
    expect(fn(actions, 'toggleUserActiveAction')).toContain('toggleUserActive(');
  });

  it('writes no person itself, and the super_admin rule lives in the writer alone (judge A4)', () => {
    expect(actions).not.toMatch(/db\.insert\(users\)/);
    expect(actions).not.toMatch(/db\.update\(users\)/);
    expect(actions).not.toContain("'super_admin'");
  });
});

describe('/hodimlar — the add fold is outside the slow boundary', () => {
  it('<NoLoginPersonNew renders before the first <Suspense', () => {
    const page = read('src/app/(protected)/hodimlar/page.tsx');
    const fold = page.indexOf('<NoLoginPersonNew');
    expect(fold).toBeGreaterThan(-1);
    expect(fold).toBeLessThan(page.indexOf('<Suspense'));
  });
});
