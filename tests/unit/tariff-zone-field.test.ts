import { describe, expect, it } from 'vitest';
import { normaliseZone, readTariffZoneField } from '@/modules/wms/costing/tariff-zone-field';

/**
 * docs/YOLKIRA-TAQSIMOT.md §2.5 — «absent» and «empty» are different answers.
 * A post without the field (a page drawn before 0132, or one migration behind,
 * where the select is not drawn) must leave the warehouse's column ALONE; only
 * «— tanlanmagan» deletes it (#171).
 */
const fd = (entries: [string, string][]) => {
  const f = new FormData();
  for (const [k, v] of entries) f.append(k, v);
  return f;
};

describe('readTariffZoneField', () => {
  it('absent → undefined (leave the mapping alone)', () => {
    expect(readTariffZoneField(fd([['address', 'x']]))).toBeUndefined();
  });
  it("'' → null (delete it)", () => {
    expect(readTariffZoneField(fd([['tariffZone', '']]))).toBeNull();
  });
  it('whitespace only → null', () => {
    expect(readTariffZoneField(fd([['tariffZone', '   ']]))).toBeNull();
  });
  it("' CN ' → 'cn' (the tariff writer's own normalisation)", () => {
    expect(readTariffZoneField(fd([['tariffZone', ' CN ']]))).toBe('cn');
    expect(normaliseZone(' Kashgar\t')).toBe('kashgar');
  });
});
