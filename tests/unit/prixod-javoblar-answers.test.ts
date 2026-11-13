import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';
import { ROLE_MATRIX } from '@/modules/platform/rbac/catalog';
import { SETTING_DEFAULTS } from '@/modules/platform/settings/service';
import { mayAddReceiptFiles } from '@/modules/wms/receipts/files-door';
import { clientLabels } from '@/modules/platform/telegram/client-labels';

/**
 * His answers of 2026-11-12 to the seven questions sent with «Prixod xabari»
 * — «1 b / 2 b / 4 b / 7 …» (docs/PRIXOD-JAVOBLAR.md).
 *
 * Three CHANGED the system (1b, 2b, 4b) and are pinned here by the code and
 * the tests that hold them. Three were not answered and their ⭐ stand (3a,
 * 5a, 6a) — and «the default stands» is only true of the code on the server,
 * so each is checked against it and named here: a default that drifts, or a
 * test that pinned it and was deleted, turns this file red with the answer's
 * own number. 7 is asked again (7.1 / 7.2) and nothing of it is built.
 */
const read = (file: string) => readFileSync(file, 'utf8');
const code = (file: string) =>
  read(file)
    .replace(/\/\*[\s\S]*?\*\//g, '')
    .replace(/^\s*\/\/.*$/gm, '');
const hasTest = (file: string, title: string) => read(file).includes(title);

describe('the three answers that changed something', () => {
  it('1 b — «yuk qayta tortilganda mijozga savol o‘zi qayta borsin»: on by default, said why to the customer, armed by every re-weigh', () => {
    expect(SETTING_DEFAULTS.client_reask_on_reweigh).toBe(true);
    for (const locale of ['uz', 'ru', 'en']) expect(clientLabels(locale).confirmAskUpdated.startsWith('🔄')).toBe(true);
    expect(hasTest('tests/integration/client-reask.integration.test.ts', 'armed after the commit, due ten minutes after the LAST correction')).toBe(true);
    expect(hasTest('tests/integration/client-reask.integration.test.ts', 'the sweep sends the question with its «updated» line and the NEW tag')).toBe(true);
    expect(hasTest('tests/unit/client-reask-wire.test.ts', 'only two modules write `total_weight_kg` / `total_volume_m3` of an existing lot')).toBe(true);
  });

  it('2 b — «xodim qo‘ygan ✅ ham kg/kub o‘zgarsa «o‘zgardi» bo‘lsin»: the tick compares its remembered measures; the tarkib always did', () => {
    const sentence = code('src/modules/wms/receipts/lot-check-sql.ts');
    expect(sentence).toContain('measures: tickMeasuresHoldSql(refs),');
    expect(sentence).toContain('const ticked = sql`(${tickedFacts} AND ${terms.measures})`;');
    // …and the ❌ an answering tick settled is decided on its FACTS, so a re-weigh never brings it back (K3).
    expect(sentence).toContain('WHEN ${dispute} AND NOT (${tickedFacts} AND ${refs.check}.checked_at > ${LOT_CLIENT}.answered_at) THEN \'none\'');
    expect(hasTest('tests/integration/lot-check.integration.test.ts', '5. a re-weigh a list would show (kg alone, m³ alone) makes it «stale» naming the weight')).toBe(true);
    // «yoki yozilgan tarkib»: already true before this answer, and pinned where it was.
    expect(hasTest('tests/integration/lot-check.integration.test.ts', '12. a composition the lot has outgrown reads «stale»')).toBe(true);
    expect(sentence).toMatch(/AND \$\{LOT_TARKIB\}\.kg = \$\{lot\}\.total_weight_kg\s*AND \$\{LOT_TARKIB\}\.m3 = \$\{lot\}\.total_volume_m3/);
  });

  it('4 b — «sotuvchi prixod kartasida (saytda) ham fayl qo‘sha olsin»: the bot’s rule, one predicate for both doors', () => {
    const door = code('src/modules/wms/receipts/files-door.ts');
    expect(door).toContain('if (!mayAttachReceiptFile(row)) return { ok: false, error: \'not_found\' };');
    expect(door).toContain("if (!mayAddReceiptFiles(actor)) return { ok: false, error: 'forbidden' };");
    expect(code('src/app/(protected)/receipts/[id]/page.tsx')).toContain('const mayAttach = mayAttachReceiptFile(receipt) && mayAddReceiptFiles(actor);');
    expect(code('src/app/api/files/upload/route.ts')).toContain("if (receipt && receipt.status === 'confirmed' && !mayAddReceiptFiles(actor)) {");
    expect(hasTest('tests/integration/receipt-files-site.integration.test.ts', 'a seller’s picture is stored as a PAPER')).toBe(true);
  });
});

describe('who adds a file to a prixod — the list he was told, over the seeded roles (the owner lens, O7)', () => {
  it('the warehouse, the logist, the VED, the sellers and the admins — never the accountant or a report-only viewer', () => {
    const adds = Object.fromEntries(
      Object.entries(ROLE_MATRIX).map(([role, grants]) => [role, mayAddReceiptFiles({ permissions: new Set<string>(grants) })]),
    );
    expect(adds).toEqual({
      super_admin: true,
      admin: true,
      logist: true,
      ved_manager: true,
      warehouse_manager: true,
      warehouse_operator: true,
      sales_manager: true,
      accountant: false,
      viewer: false,
    });
  });
});

describe('the ⭐ that stand', () => {
  it('3 a — a ✅ is for the figures it was given, wherever the cargo stands: neither comparison carries a place', () => {
    const sentence = code('src/modules/wms/receipts/lot-check-sql.ts');
    const client = sentence.slice(sentence.indexOf('export function clientMeasuresHoldSql('), sentence.indexOf('export function clientHoldsSql('));
    const tick = sentence.slice(sentence.indexOf('function tickMeasuresHoldSql('), sentence.indexOf('export function lotShownKgSql('));
    for (const part of [client, tick]) {
      expect(part.length).toBeGreaterThan(50);
      expect(part).not.toMatch(/country|askable|lotAskableSql|warehouse/i);
    }
  });

  it('5 a — a file added (bot or site) tells nobody: no event, no notification on either door', () => {
    for (const file of ['src/modules/wms/receipts/files-door.ts', 'src/app/api/files/upload/route.ts']) {
      expect(code(file), file).not.toMatch(/emitEvent|notifyStaffTelegram|queueStaffTelegram|insert\(events\)/);
    }
  });

  it('6 a — «hisob-kitobga to‘g‘ri kelmadi» and «va’dadan farq qildi» stay their own messages', () => {
    const arrival = code('src/modules/platform/notifications/receipt-arrival.ts');
    expect(arrival).toContain("const ARRIVAL_ROW_TYPES: readonly string[] = ['ReceiptConfirmed', 'UnlinkedCargo', 'UnquotedCargo'];");
    expect(code('src/modules/platform/notifications/service.ts')).toContain(
      "if (event.payload.folded === true && event.type !== 'DealDeviation' && event.type !== 'DealDeferralEnded') {",
    );
  });
});
