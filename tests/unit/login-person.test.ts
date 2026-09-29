import { readFileSync } from 'node:fs';
import { and, eq } from 'drizzle-orm';
import { PgDialect } from 'drizzle-orm/pg-core';
import { describe, expect, it } from 'vitest';
import { canLogIn, canLogInSql, loginRowSql, noLoginPhone, staffPhonesMatch } from '@/modules/platform/users/login';
import { users } from '@/modules/platform/db/schema';

/**
 * «Who is a colleague NOW» (0120, the owner's 2b) — the one rule every site
 * that picks, notifies, routes to or authenticates a person asks. Pure, so it
 * is tested as a function and by what it RENDERS: a predicate whose SQL named
 * the wrong column would type-check and silently widen every list it guards.
 */

const dialect = new PgDialect();
const render = (fragment: ReturnType<typeof canLogInSql>) => dialect.sqlToQuery(fragment).sql;

describe('canLogIn — active AND a login', () => {
  it('is true only when both are true', () => {
    expect(canLogIn({ active: true, loginEnabled: true })).toBe(true);
    expect(canLogIn({ active: false, loginEnabled: true })).toBe(false);
    expect(canLogIn({ active: true, loginEnabled: false })).toBe(false);
    expect(canLogIn({ active: false, loginEnabled: false })).toBe(false);
  });
});

describe('canLogInSql renders the same rule', () => {
  it('names both columns, qualified, when it stands in a where', () => {
    expect(render(canLogInSql())).toBe('("users"."active" AND "users"."login_enabled")');
  });

  it('takes the ALIAS a raw query declares — "users"."active" against `FROM users u` is refused by postgres', () => {
    expect(render(canLogInSql('u'))).toBe('("u".active AND "u".login_enabled)');
  });

  it('loginRowSql names login_enabled and nothing else', () => {
    const sql = render(loginRowSql());
    expect(sql).toContain('login_enabled');
    expect(sql).not.toContain('active');
  });

  it('keeps its own parentheses inside a caller’s and() — drizzle embeds members verbatim', () => {
    const both = dialect.sqlToQuery(and(eq(users.id, '00000000-0000-0000-0000-000000000000'), canLogInSql())!);
    expect(both.sql).toBe('("users"."id" = $1 and ("users"."active" AND "users"."login_enabled"))');
  });
});

describe('noLoginPhone — a payroll phone is phone-shaped or nothing', () => {
  it('empty is «no phone», never a refusal', () => {
    expect(noLoginPhone('')).toEqual({ ok: true, phone: null });
    expect(noLoginPhone('   ')).toEqual({ ok: true, phone: null });
  });

  it('drops spaces, dashes, dots and parentheses', () => {
    expect(noLoginPhone('+86 139-1234 (5678)')).toEqual({ ok: true, phone: '+8613912345678' });
    expect(noLoginPhone('90.175.78.00')).toEqual({ ok: true, phone: '901757800' });
  });

  it('refuses a name, a short number, a long one and a doubled plus — none can shadow a username', () => {
    expect(noLoginPhone('bekzod')).toEqual({ ok: false });
    expect(noLoginPhone('123456')).toEqual({ ok: false });
    expect(noLoginPhone('1234567890123456')).toEqual({ ok: false });
    expect(noLoginPhone('++8613912345678')).toEqual({ ok: false });
  });
});

describe('staffPhonesMatch — the bot’s own rule, moved and unchanged', () => {
  it('matches on the last nine digits, formats and all', () => {
    expect(staffPhonesMatch('+998 90 175-78-00', '901757800')).toBe(true);
  });

  it('never trusts under seven digits', () => {
    expect(staffPhonesMatch('12345', '12345')).toBe(false);
  });
});

describe('the words a no-login refusal needs exist in every bundle', () => {
  // Anchored on the SOURCE (#163): the literal the service throws and the
  // audit field the conversion writes, never bundle-against-bundle.
  const service = readFileSync('src/modules/platform/tasks/service.ts', 'utf8');
  const fields = readFileSync('src/modules/platform/audit/fields.ts', 'utf8');

  it('reads the anchors it guards', () => {
    expect(service).toContain("'assignee_no_login'");
    expect(fields).toContain("loginEnabled: 'loginEnabled'");
  });

  for (const locale of ['ru', 'uz', 'en', 'zh-CN']) {
    it(locale, () => {
      const bundle = JSON.parse(readFileSync(`messages/${locale}.json`, 'utf8')) as {
        tasks: { errors: Record<string, string> };
        audit: { fields: Record<string, string> };
      };
      expect(bundle.tasks.errors.assignee_no_login?.trim()).toBeTruthy();
      expect(bundle.audit.fields.loginEnabled?.trim()).toBeTruthy();
    });
  }
});
