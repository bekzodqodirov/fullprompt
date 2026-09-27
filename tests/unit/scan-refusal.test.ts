import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';
import { SCAN_REFUSALS, isScanRefusal } from '@/offline/scan-refusal';
import { isOwnCodeShape, looksLikeRetailBarcode } from '@/offline/code-shape';
import en from '../../messages/en.json';
import ru from '../../messages/ru.json';
import uz from '../../messages/uz.json';
import zh from '../../messages/zh-CN.json';

/**
 * The phone's three count-only refusals (0112) are a runtime key —
 * `scanRefusal.<detail>` — so the bundles are checked against the list here,
 * not against each other (#163: comparing bundles cannot catch a key missing
 * from all four).
 */
describe('scan refusals', () => {
  it('knows its three and nothing else', () => {
    for (const d of SCAN_REFUSALS) expect(isScanRefusal(d)).toBe(true);
    for (const d of ['batch_not_loading', 'box_issued', '', null, 1]) expect(isScanRefusal(d)).toBe(false);
  });

  it('every refusal has its sentence in all four bundles', () => {
    for (const [name, bundle] of Object.entries({ en, ru, uz, zh })) {
      const refusals = (bundle as { scanRefusal?: Record<string, string> }).scanRefusal ?? {};
      expect(Object.keys(refusals).sort(), name).toEqual([...SCAN_REFUSALS].sort());
      for (const d of ['lot_counted', 'qr_less_count_only'] as const) {
        expect(refusals[d], `${name}.${d}`).toContain('{lot}');
      }
    }
  });

  it('the server writes exactly these details', () => {
    const service = readFileSync('src/modules/wms/scanning/service.ts', 'utf8');
    const unload = readFileSync('src/modules/wms/scanning/unload.ts', 'utf8');
    for (const d of SCAN_REFUSALS) {
      expect(service, d).toContain(`'${d}'`);
      expect(unload, d).toContain(`'${d}'`);
    }
  });
});

describe('code shapes', () => {
  it('our own labels', () => {
    for (const c of ['YW26-000123', 'GS777-00012', 'CR-YW26-00007', 'cr-yw26-00007']) {
      expect([c, isOwnCodeShape(c)]).toEqual([c, true]);
    }
    for (const c of ['https://m.tb.cn/h.abc', '4607001234567', 'GS777', 'YW26-12']) {
      expect([c, isOwnCodeShape(c)]).toEqual([c, false]);
    }
  });

  it('a factory retail barcode is 8 to 14 digits', () => {
    for (const c of ['46070012', '4607001234567', '12345678901234', ' 4607001234567 ']) {
      expect([c, looksLikeRetailBarcode(c)]).toEqual([c, true]);
    }
    for (const c of ['1234567', '123456789012345', 'YW26-000123', '4607-001']) {
      expect([c, looksLikeRetailBarcode(c)]).toEqual([c, false]);
    }
  });
});
