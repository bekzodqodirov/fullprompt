import { describe, expect, it } from 'vitest';
import { LOCALES } from '@/modules/platform/i18n/locales';
import { SETTING_DEFAULTS } from '@/modules/platform/settings/service';
import { BRIDGE_LABELS } from '@/components/telegram-bridge-status';
import en from '../../messages/en.json';
import ru from '../../messages/ru.json';
import uz from '../../messages/uz.json';
import zh from '../../messages/zh-CN.json';

/**
 * Four languages × ~650 strings is more than anyone checks by eye. next-intl
 * throws at RENDER time on a missing key and on a placeholder that does not
 * line up, so a forgotten translation would surface as a broken page for
 * whoever happens to use that language — usually not the person who added it.
 */

type Tree = { [key: string]: string | Tree };

const BUNDLES: Record<string, Tree> = { ru, uz, 'zh-CN': zh, en };
/** Russian is the default locale and therefore the reference bundle. */
const REFERENCE = 'ru';

function flatten(tree: Tree, prefix = ''): [string, string][] {
  return Object.entries(tree).flatMap(([key, value]) =>
    typeof value === 'string'
      ? ([[prefix + key, value]] as [string, string][])
      : flatten(value, `${prefix}${key}.`),
  );
}

const placeholders = (text: string) =>
  [...text.matchAll(/\{([a-zA-Z0-9_]+)\}/g)].map((m) => m[1]).sort();

describe('locale bundles', () => {
  const reference = new Map(flatten(BUNDLES[REFERENCE]!));

  it('ships a bundle for every locale the app offers', () => {
    for (const locale of LOCALES) expect(BUNDLES[locale], locale).toBeDefined();
    expect(Object.keys(BUNDLES).sort()).toEqual([...LOCALES].sort());
  });

  for (const locale of Object.keys(BUNDLES)) {
    if (locale === REFERENCE) continue;

    it(`${locale} has every key, and no key the reference lacks`, () => {
      const keys = new Set(flatten(BUNDLES[locale]!).map(([key]) => key));
      expect([...reference.keys()].filter((key) => !keys.has(key))).toEqual([]);
      expect([...keys].filter((key) => !reference.has(key))).toEqual([]);
    });

    it(`${locale} keeps the same placeholders`, () => {
      const mismatched = flatten(BUNDLES[locale]!)
        .filter(([key, text]) => {
          const source = reference.get(key);
          return source !== undefined && placeholders(source).join() !== placeholders(text).join();
        })
        .map(([key]) => key);
      expect(mismatched).toEqual([]);
    });

    it(`${locale} leaves nothing untranslated by accident`, () => {
      // A value identical to the Russian one is almost always a copy-paste
      // that was never translated. Codes, brand names and bare numbers are
      // legitimately the same in every language.
      const suspicious = flatten(BUNDLES[locale]!).filter(([key, text]) => {
        const source = reference.get(key);
        if (source === undefined || source !== text) return false;
        return /\p{Script=Cyrillic}/u.test(source);
      });
      expect(suspicious.map(([key]) => key)).toEqual([]);
    });
  }
});

describe('export labels', () => {
  it('report columns exist in every locale and fall back on an unknown one', async () => {
    const { reportLabels } = await import('@/modules/wms/reports/labels');
    const ru = reportLabels('ru');
    for (const locale of LOCALES) {
      const labels = reportLabels(locale);
      expect(Object.keys(labels), locale).toEqual(Object.keys(ru));
      expect(
        Object.entries(labels).filter(([, value]) => !value),
        `${locale} has empty labels`,
      ).toEqual([]);
    }
    // A user row could carry anything; the builder must not produce blanks.
    expect(reportLabels('xx-YY')).toEqual(ru);
    expect(reportLabels(undefined)).toEqual(ru);
  });

  it('customs document labels stay bilingual, never one language', async () => {
    const { DOC } = await import('@/modules/wms/documents/labels');
    // A customs officer reads Russian, a forwarding agent reads English —
    // these documents leave the company, so every label carries both.
    const oneSided = Object.entries(DOC).filter(
      ([, value]) => !/\p{Script=Cyrillic}/u.test(value) || !/[A-Za-z]/.test(value),
    );
    expect(oneSided).toEqual([]);
  });
});

describe('worksheet names', () => {
  it('never contain a character Excel rejects', async () => {
    const { DOC } = await import('@/modules/wms/documents/labels');
    // Excel refuses \ / ? * [ ] : in a tab name — a bilingual label with a
    // slash used as a sheet name made every manifest download 500.
    const illegal = Object.entries(DOC).filter(
      ([key, value]) => key.startsWith('sheet') && /[\\/?*[\]:]/.test(value),
    );
    expect(illegal).toEqual([]);
  });
});

describe('staff Telegram messages', () => {
  it('render in the recipient language and never leak an untranslated word', async () => {
    const { renderTelegramText } = await import('@/modules/platform/notifications/service');
    const payload = {
      receiptId: '019f0000-0000-7000-8000-000000000001',
      batchId: '019f0000-0000-7000-8000-000000000002',
      error: 'pg_restore exited 1',
      personName: 'Ali',
      number: 'YW-25-0001',
      clientCode: 'GS777',
      clientName: 'Test',
      warehouseCode: 'YW',
      batchCode: 'YW-001',
      boxCount: 3,
      shortCodes: ['YW26-000001'],
      lots: [],
    };
    const en = renderTelegramText('ReceiptConfirmed', payload, 'en');
    expect(en).toContain('Receipt');
    expect(en).toContain('Warehouse: YW');
    // The Russian labels must be gone, not merely joined by English ones.
    expect(en).not.toMatch(/Приёмка|Склад|Клиент/);

    const uz = renderTelegramText('BoxIssued', payload, 'uz');
    expect(uz).toContain('Mijozga berildi');

    // An unknown locale must not produce "undefined" in a message that goes
    // out to a real phone.
    for (const type of ['ReceiptConfirmed', 'MissingInTransit', 'RestoreTestFailed']) {
      expect(renderTelegramText(type, payload, 'xx'), type).not.toContain('undefined');
      expect(renderTelegramText(type, payload, null), type).not.toContain('undefined');
    }
  });
});

/**
 * The settings screen renders `t('descriptions.<key>')` for EVERY key in
 * SETTING_DEFAULTS, and next-intl throws at render on a missing key — so
 * adding a setting without a description takes the whole admin page down.
 *
 * The bundle-parity test above cannot catch this: `crm_dormant_days` was
 * missing from all four bundles equally, so they matched each other perfectly
 * while /admin/settings threw on every visit for weeks.
 */
describe('every setting can be described', () => {
  for (const locale of Object.keys(BUNDLES)) {
    it(`${locale} describes all ${Object.keys(SETTING_DEFAULTS).length} settings`, () => {
      const descriptions =
        ((BUNDLES[locale] as Tree).settings as Tree | undefined)?.descriptions ?? {};
      const missing = Object.keys(SETTING_DEFAULTS).filter(
        (key) => typeof (descriptions as Tree)[key] !== 'string',
      );
      expect(missing, `${locale} is missing setting descriptions`).toEqual([]);
    });
  }
});

/**
 * Same trap, second instance: the bridge status renders one of five strings
 * chosen at RUNTIME from the connection's state, so no bundle-to-bundle
 * comparison can notice one missing from all four — and the one that is
 * missing is the one that only appears when something has already gone wrong.
 *
 * `BRIDGE_LABELS` is the source of truth outside the bundles (#163), which is
 * why the component exports a map instead of building the key from the state.
 */
describe('every bridge state has something to say', () => {
  for (const locale of Object.keys(BUNDLES)) {
    it(`${locale} names all ${Object.keys(BRIDGE_LABELS).length} bridge states`, () => {
      const crm = ((BUNDLES[locale] as Tree).crm as Tree | undefined) ?? {};
      const missing = Object.values(BRIDGE_LABELS).filter((key) => typeof crm[key] !== 'string');
      expect(missing, `${locale} is missing bridge status strings`).toEqual([]);
    });
  }
});
