import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';

/**
 * The staff counterparty's doors (0101, owner M2a/M3a: «faqat buxgalter va
 * admin» = `finance.expenses`). Every kontragentlar action calls
 * `authorize()` and every page calls `getActor()`, so no integration test can
 * press them (#531) — the wiring is pinned by source shape, comments stripped
 * first so a sentence explaining a rule cannot satisfy it (#725).
 */
const strip = (src: string) => src.replace(/\/\*[\s\S]*?\*\//g, '').replace(/\/\/.*$/gm, '');
const read = (path: string) => strip(readFileSync(path, 'utf8'));

const ACTIONS = read('src/app/(protected)/kontragentlar/actions.ts');
const CARD = read('src/app/(protected)/kontragentlar/[id]/page.tsx');
const LIST = read('src/app/(protected)/kontragentlar/page.tsx');
const FORM = read('src/app/(protected)/kontragentlar/partner-form.tsx');

/** One exported action's body, up to the next export. */
function action(name: string): string {
  const start = ACTIONS.indexOf(`export async function ${name}`);
  expect(start, name).toBeGreaterThan(-1);
  const next = ACTIONS.indexOf('export async function', start + 1);
  return ACTIONS.slice(start, next === -1 ? undefined : next);
}

describe('the partner card', () => {
  it('answers notFound for a staff account unless the reader holds finance.expenses', () => {
    expect(CARD).toMatch(/const seesStaff = maySeeStaffMoney\(actor\.permissions\);/);
    expect(CARD).toMatch(/if \(row\.staff && !seesStaff\) notFound\(\);/);
    // Asked BEFORE anything of the account is read.
    expect(CARD.indexOf('if (row.staff && !seesStaff) notFound();')).toBeLessThan(
      CARD.indexOf('partnerBalanceUsd(id)'),
    );
  });
});

describe('the five doors that touch ONE account', () => {
  it('run() asks the door after authorize and before any work', () => {
    const run = ACTIONS.slice(ACTIONS.indexOf('async function run('));
    const door = run.indexOf('const refused = await door(actor);');
    expect(door).toBeGreaterThan(run.indexOf("authorize('finance.manage')"));
    expect(run.indexOf('if (refused) return { error: refused };')).toBeGreaterThan(door);
    expect(run.indexOf('await work(')).toBeGreaterThan(door);
  });

  it('staffDoor refuses a non-finance.expenses actor on a staff account', () => {
    const door = ACTIONS.slice(ACTIONS.indexOf('async function staffDoor('));
    expect(door).toMatch(/if \(!partnerId \|\| maySeeStaffMoney\(actor\.permissions\)\) return null;/);
    expect(door).toMatch(/return \(await isStaffPartner\(partnerId\)\) \? 'forbidden' : null;/);
  });

  it('setPartnerActive, addPartnerTx and voidPartnerTx each pass their account to staffDoor', () => {
    expect(action('setPartnerActiveAction')).toContain('(actor) => staffDoor(actor, id.data)');
    expect(action('addPartnerTxAction')).toContain(
      '(actor) => staffDoor(actor, parsed.data.partnerId)',
    );
    // The void judges the account the ROW sits on, never the posted partnerId.
    expect(action('voidPartnerTxAction')).toContain(
      'async (actor) => staffDoor(actor, await partnerIdOfTx(id.data))',
    );
  });

  it('the settlement asks staffDoor itself, after authorize and before the write', () => {
    const body = action('recordSettlementAction');
    const door = body.indexOf('await staffDoor(actor, parsed.data.partnerId)');
    expect(door).toBeGreaterThan(body.indexOf("authorize('finance.manage')"));
    expect(body.indexOf('recordSettlement(parsed.data')).toBeGreaterThan(door);
  });

  it('the partner form refuses a posted login, a «Hodim» type or a staff account for non-holders', () => {
    expect(action('savePartnerAction')).toContain(
      '(actor) => partnerFormDoor(actor, id, parsed.data.typeId, userPosted)',
    );
    expect(action('savePartnerAction')).toMatch(/const userPosted = formData\.has\('userId'\);/);
    // Absent posts undefined — «unchanged» — never ''.
    expect(action('savePartnerAction')).toContain(
      "userId: userPosted ? String(formData.get('userId') ?? '') : undefined,",
    );
    const door = ACTIONS.slice(ACTIONS.indexOf('async function partnerFormDoor('));
    expect(door).toMatch(/if \(maySeeStaffMoney\(actor\.permissions\)\) return null;/);
    expect(door).toMatch(/if \(userPosted\) return 'forbidden';/);
    expect(door).toMatch(/if \(await isStaffType\(typeId\)\) return 'forbidden';/);
    expect(door).toMatch(/return staffDoor\(actor, id\);/);
  });
});

describe('the login select', () => {
  it('is drawn only when the page handed it a list', () => {
    const select = FORM.indexOf('name="userId"');
    expect(select).toBeGreaterThan(-1);
    const gate = FORM.lastIndexOf('{staffUsers && (', select);
    expect(gate).toBeGreaterThan(-1);
    // Still inside that fragment: it has not closed between the gate and the select.
    expect(FORM.slice(gate, select)).not.toContain('</>');
    expect(FORM.indexOf('</>', select)).toBeGreaterThan(select);
  });

  it('both pages hand it a list only under maySeeStaffMoney', () => {
    expect(LIST).toMatch(/const seesStaff = maySeeStaffMoney\(actor\.permissions\);/);
    expect(LIST).toMatch(/const staffUsers =\s*canManage && seesStaff\s*\?/);
    expect(LIST).toContain('staffUsers={staffUsers}');
    expect(CARD).toMatch(/const editUsers =\s*canManage && seesStaff\s*\?/);
    expect(CARD).toContain('staffUsers={editUsers}');
  });

  it('the «Hodim» type is offered to nobody else', () => {
    expect(LIST).toContain("(seesStaff || type.code !== 'staff')");
    expect(CARD).toContain("(seesStaff || type.code !== 'staff')");
  });
});
