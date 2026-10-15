import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';
import { OPEN_STATUSES, PICKUP_STATUSES } from '@/modules/wms/pickups/service';

const read = (path: string) => readFileSync(path, 'utf8');
const strip = (src: string) => src.replace(/\/\*[\s\S]*?\*\//g, '').replace(/^\s*\/\/.*$/gm, '');
const LOCALES = ['ru', 'uz', 'zh-CN', 'en'] as const;
const bundle = (locale: string) => JSON.parse(read(`messages/${locale}.json`)) as Record<string, Record<string, unknown>>;

/**
 * «Zavod reysi yopiladi» (0133) — the halves no integration test can press:
 * runtime i18n keys, the status list against the migration's CHECK, and the
 * transaction helpers each writer must call (#531, #163).
 */
describe('zavod reysi yopiladi — wiring', () => {
  it('every refusal the pickup forms can name has a sentence in all four bundles', () => {
    const forms = read('src/app/(protected)/zavod/pickup-forms.tsx');
    const list = forms.slice(forms.indexOf('const KNOWN_ERRORS = ['), forms.indexOf('] as const;', forms.indexOf('const KNOWN_ERRORS')));
    const codes = [...list.matchAll(/'([a-z_]+)'/g)].map((m) => m[1]!);
    expect(codes).toEqual(expect.arrayContaining(['closed', 'already_closed', 'line_answered', 'server_behind']));
    for (const locale of LOCALES) {
      const errors = (bundle(locale).pickups as { errors: Record<string, string> }).errors;
      for (const code of [...codes, 'generic']) expect(errors[code], `${locale}: pickups.errors.${code}`).toBeTruthy();
    }
  });

  it('the statuses are the migration’s CHECK, and each has its words; every /zavod tab has a label', () => {
    const sql = read('src/modules/platform/db/migrations/0133_pickup_close.sql');
    const check = sql.match(/"pickups_status_check"\s*CHECK \("status" IN \(([^)]*)\)\)/)![1]!;
    expect(check.split(',').map((v) => v.trim().replace(/'/g, ''))).toEqual([...PICKUP_STATUSES]);
    expect([...OPEN_STATUSES]).toEqual(['planned', 'on_road', 'arrived']);
    const page = read('src/app/(protected)/zavod/page.tsx');
    const tabs = [...page.slice(page.indexOf('const TABS = ['), page.indexOf('] as const', page.indexOf('const TABS'))).matchAll(/'([a-z]+)'/g)].map(
      (m) => m[1]!,
    );
    expect(tabs).toEqual(expect.arrayContaining(['closed', 'xarajatsiz']));
    for (const locale of LOCALES) {
      const p = bundle(locale).pickups as { status: Record<string, string>; tabs: Record<string, string> };
      for (const s of PICKUP_STATUSES) expect(p.status[s], `${locale}: status.${s}`).toBeTruthy();
      for (const tab of tabs) expect(p.tabs[tab], `${locale}: tabs.${tab}`).toBeTruthy();
    }
  });

  it('the receive door and the card link answer lines and close INSIDE their transaction, through `tx`', () => {
    const receipts = strip(read('src/modules/wms/receipts/service.ts'));
    const tx = receipts.slice(receipts.indexOf('const result = await db.transaction(async (tx) => {'));
    expect(tx).toContain('await answerLinesInTx(\n          tx,');
    expect(tx).toContain('await closeIfAnsweredInTx(tx, pickupId,');
    expect(tx).toContain("mode: 'door'");
    const service = strip(read('src/modules/wms/pickups/service.ts'));
    const link = service.slice(service.indexOf('export async function linkReceiptToStop('), service.indexOf('// The road (D1)'));
    expect(link).toContain("assertStopReceivable(tx, stopId, receipt.warehouseId, 'card')");
    expect(link).toContain("mode: 'card'");
    expect(link).toContain('closeIfAnsweredInTx(tx, afterPickup,');
    // A writer that changes the LINES closes what is left by itself (his 1a).
    for (const fn of ['export async function removeStop(', 'export async function saveStopLines(']) {
      const body = service.slice(service.indexOf(fn), service.indexOf('\n}\n', service.indexOf(fn)));
      expect(body, fn).toContain('closeIfAnsweredInTx(tx, stop.pickupId,');
    }
  });

  it('the door question is never served from the service worker’s cache', () => {
    const sw = read('src/app/sw.ts');
    expect(sw).toContain("pathname === '/api/receive/pickups'");
  });

  it('the wizard says the four new door refusals in words, not the old «boshqa skladga» sentence', () => {
    const wizard = read('src/app/(protected)/receive/receive-wizard.tsx');
    for (const [code, key] of [
      ['pickup_closed', 'pickupClosed'],
      ['pickup_line_answered', 'pickupLineAnswered'],
      ['pickup_line_not_on_stop', 'pickupLineGone'],
      ['pickup_line_owner_mismatch', 'pickupLineOwner'],
    ] as const) {
      expect(wizard).toContain(`error === '${code}'`);
      expect(wizard).toContain(`t('${key}')`);
    }
  });
});
