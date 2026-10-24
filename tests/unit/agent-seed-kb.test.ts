import { describe, expect, it } from 'vitest';
import { SEED_FACTS } from '@/modules/wms/agent/seed-kb';
import { extractNumbers, PHONE_RE, urlsIn } from '@/modules/wms/agent/numbers';
import { normalizeDigits } from '@/modules/wms/agent/digits';
import { AGENT_LIMITS } from '@/modules/wms/agent/limits';

/**
 * The starting knowledge is a REVIEWED list, and these are the review's rules
 * as code (spec §16.12, his answer 8 ⭐): no prices, none of the website's
 * extras, never «our warehouse», and the one phone and the one link he gave
 * — each where it belongs. A fact is read in EVERY chat, so a slip here is a
 * slip in every customer's draft.
 */

const text = (f: { question: string; answer: string }) => normalizeDigits(`${f.question}\n${f.answer}`);

describe('the seeded knowledge', () => {
  it('carries no money figure at all — prices come from the calculation (money-3, money-9)', () => {
    for (const f of SEED_FACTS) {
      expect(extractNumbers(text(f)).filter((n) => n.kind === 'money'), f.key).toEqual([]);
    }
  });

  it('states none of the site’s extras — storage days, insurance, photos, repacking, door delivery (Q8 ⭐)', () => {
    const extras = /bepul|sug[ʻ‘’']?urta|foto|suratga|qadoqla|saqlash|uygacha|eshikkacha/iu;
    for (const f of SEED_FACTS) expect(extras.test(text(f)), f.key).toBe(false);
  });

  it('never calls a receiving point «ours» — but for the price rule he dictated in his own words', () => {
    // His third set «3» (2026-10-24): «skladlarimizdan narxi shuncha». The one fact that says «ours»,
    // and it names no point: it says where a price is counted from.
    const OWN_WORDS = new Set(['china_warehouse_price@1']);
    const ours = /ombor(?:lar)?imiz|bizning ombor|склад(?:ы)?\s+наш|наш(?:его|ем|их|и)?\s+склад/iu;
    for (const f of SEED_FACTS) expect(ours.test(text(f)), f.key).toBe(OWN_WORDS.has(f.key));
  });

  it('holds exactly one phone (the Tashkent contact) and one link (the map, in a fact of its own)', () => {
    const phones = SEED_FACTS.flatMap((f) => [...text(f).matchAll(PHONE_RE)].map((m) => [f.key, m[0]] as const));
    expect(phones.map(([key]) => key)).toEqual(['tashkent_warehouse@1']);
    const links = SEED_FACTS.flatMap((f) => urlsIn(text(f)).map((u) => [f.key, u] as const));
    expect(links).toEqual([['tashkent_map@1', 'https://yandex.uz/maps/-/CXQr78ni']]);
  });

  it('says what he asked to have written down (2026-10-24) — and with the numbers the agent itself obeys', () => {
    const byKey = new Map(SEED_FACTS.map((f) => [f.key, normalizeDigits(f.answer)]));
    const { m3, kg } = AGENT_LIMITS.minShipment;
    expect(byKey.get('min_shipment@1')).toContain(`${m3} kub yoki ${kg} kg`);
    const avia = byKey.get('avia@1')!;
    expect(avia).toContain(`${AGENT_LIMITS.avia.minKg} kg`);
    expect(avia).toContain(`${AGENT_LIMITS.avia.daysMin}–${AGENT_LIMITS.avia.daysMax} kun`);
    expect(byKey.get('certificate@1')).toMatch(/kompaniyamiz oʻzi/u);
  });

  it('keys every fact once, with a version, inside the kb CHECK’s 2 000 characters', () => {
    const keys = SEED_FACTS.map((f) => f.key);
    expect(new Set(keys).size).toBe(keys.length);
    for (const f of SEED_FACTS) {
      expect(f.key).toMatch(/^[a-z_]+@\d+$/u);
      expect([...f.answer].length).toBeLessThanOrEqual(2000);
      expect(f.question.trim()).not.toBe('');
    }
  });
});
