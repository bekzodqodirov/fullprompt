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

  it('holds the phones he gave — the Tashkent contact and the three China warehouses — and one link (the map, in a fact of its own)', () => {
    const phones = SEED_FACTS.flatMap((f) => [...text(f).matchAll(PHONE_RE)].map((m) => [f.key, m[0]] as const));
    expect(phones).toEqual([
      ['china_address_yiwu@1', '13429089596'],
      ['china_address_guangzhou@1', '13266376775'],
      ['china_address_horgos@1', '18309082036'],
      ['tashkent_warehouse@1', '+998 95 018 30 33'],
    ]);
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

  it('the China points fact defers the customer nowhere and names HIS three warehouses (K27, his 10 b and fourth set)', () => {
    const points = SEED_FACTS.filter((f) => f.key.startsWith('china_points@'));
    expect(points.map((f) => f.key)).toEqual(['china_points@4']);
    const answer = normalizeDigits(points[0]!.answer);
    for (const city of ['Ivu', 'Guanchjou', 'Xorgos', '义乌', '广州', '霍尔果斯']) expect(answer).toContain(city);
    // His list is three warehouses; Qashqar is not one of them.
    expect(answer).not.toMatch(/qashqar|喀什/iu);
    expect(answer).not.toMatch(/kelishuvdan keyin|menejer aytadi|keyin beriladi|bu bilimda yoʻq/iu);
  });

  it('…and says, where every run reads it, that the flight\'s address is his (his «2 … telegramda sorasin»)', () => {
    const answer = normalizeDigits(SEED_FACTS.find((f) => f.key.startsWith('china_points@'))!.answer);
    expect(answer).toMatch(/avia uchun manzilni AI aytmaydi/iu);
    expect(answer).toMatch(/akkaunt egasidan soʻraydi/iu);
    expect(answer).toContain('needs_owner=true');
  });

  it('each China warehouse is a fact of its own, its address in the Chinese he sent, with the GS reminder in both languages', () => {
    const byKey = new Map(SEED_FACTS.map((f) => [f.key, f.answer]));
    // His fourth set, character for character (the supplier reads it).
    expect(byKey.get('china_address_yiwu@1')).toContain('浙江省 义乌市 稠江街道 荷花南街 2255号，周先生，小周 13429089596');
    expect(byKey.get('china_address_guangzhou@1')).toContain('广东省佛山市南海区里水镇胜利社区胜利工业区29号3栋 拓派国际物流有限公司');
    expect(byKey.get('china_address_guangzhou@1')).toContain('提货调车电话：王红 13266376775');
    expect(byKey.get('china_address_horgos@1')).toContain(
      '霍尔果斯金亿国际物流中心 新疆维吾尔自治区伊犁哈萨克自治州霍尔果斯市南京路与宁波路交叉口正东方向168米左右',
    );
    expect(byKey.get('china_address_horgos@1')).toContain('ASQAR 18309082036');
    // The map app's «966 km from you» was where HE stood — never a customer's distance.
    for (const f of SEED_FACTS) expect(f.answer, f.key).not.toMatch(/距你|公里/u);
    for (const key of ['china_address_yiwu@1', 'china_address_guangzhou@1', 'china_address_horgos@1']) {
      expect(byKey.get(key), key).toContain('GS kodini (markirovka) yozishni unutmang');
      expect(byKey.get(key), key).toContain('发货前请不要忘记标注GS编码（唛头）');
    }
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
