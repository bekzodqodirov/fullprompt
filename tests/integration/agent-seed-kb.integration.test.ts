import 'dotenv/config';
import { eq, like, sql } from 'drizzle-orm';
import { afterAll, describe, expect, it } from 'vitest';
import { db, pgClient } from '@/modules/platform/db/client';
import { kbFacts, users } from '@/modules/platform/db/schema';
import { WAREHOUSE_ADDRESS_SEED, warehouseAddressTexts } from '@/modules/wms/agent/kb';
import { policyFor, type PolicyMemory } from '@/modules/wms/agent/policy-input';
import { seedKb, seededKeys } from '@/modules/wms/agent/seed-kb';

/**
 * A newer seed version retires the untouched older one (his fourth set:
 * china_points@3 → @4) — two answers to one question would both sit in every
 * prompt. His own edited copy is never touched. The keys are this run's own
 * (letters only, as the seed's keys are), and every row goes in `afterAll`:
 * a general fact is in every run's prompt while it lives (#183).
 */

const BASE = `zz_seedprobe_${Date.now().toString(36).replace(/\d/gu, (d) => 'abcdefghij'[Number(d)]!)}`;
const fact = (v: number) => ({ key: `${BASE}@${v}`, question: `Sinov savoli ${v}?`, answer: `Sinov javobi, versiya ${v}.` });
const rowsOf = async () =>
  db
    .select({ id: kbFacts.id, source: kbFacts.source, key: sql<string>`${kbFacts.sourceRef}->>'seed'`, retiredAt: kbFacts.retiredAt })
    .from(kbFacts)
    .where(like(sql`${kbFacts.sourceRef}->>'seed'`, `${BASE}@%`));

// A receiving warehouse of this run's own, under the address key the policy reads (review D3).
const ADDR = `${WAREHOUSE_ADDRESS_SEED}${BASE}`;

afterAll(async () => {
  await db.delete(kbFacts).where(like(sql`${kbFacts.sourceRef}->>'seed'`, `${BASE}@%`));
  await db.delete(kbFacts).where(like(sql`${kbFacts.sourceRef}->>'seed'`, `${ADDR}@%`));
  await pgClient.end();
});

describe('seedKb — a new version supersedes the old one the seed wrote', () => {
  it('@2 retires the untouched @1, leaves his edited copy alone, and a re-run moves nothing', async () => {
    expect(await seedKb([fact(1)])).toEqual([`${BASE}@1`]);
    // His ✎ on the page writes a NEW row as source 'owner', carrying the seed key it came from (editKbFact).
    const [who] = await db.select({ id: users.id }).from(users).limit(1);
    const [edited] = await db
      .insert(kbFacts)
      .values({ scope: 'general', question: 'Sinov savoli 1?', answer: 'Uning o‘z so‘zlari.', locale: 'uz', source: 'owner', sourceRef: { seed: `${BASE}@1`, door: 'web' }, approvedAt: new Date(), approvedBy: who!.id })
      .returning({ id: kbFacts.id });

    expect(await seedKb([fact(2)])).toEqual([`${BASE}@2`]);
    const rows = await rowsOf();
    const seeded1 = rows.find((r) => r.source === 'seed' && r.key === `${BASE}@1`)!;
    const seeded2 = rows.find((r) => r.source === 'seed' && r.key === `${BASE}@2`)!;
    expect(seeded1.retiredAt).not.toBeNull();
    expect(seeded2.retiredAt).toBeNull();
    expect(rows.find((r) => r.id === edited!.id)!.retiredAt).toBeNull();

    // Idempotent: nothing inserted, and a version never retires itself.
    expect(await seedKb([fact(2)])).toEqual([]);
    const [again] = await db.select({ retiredAt: kbFacts.retiredAt }).from(kbFacts).where(eq(kbFacts.id, seeded2.id));
    expect(again!.retiredAt).toBeNull();
    // A retired key still counts as seeded — it is never written again.
    const keys = await seededKeys();
    expect(keys.has(`${BASE}@1`)).toBe(true);
    expect(keys.has(`${BASE}@2`)).toBe(true);
  });
});

describe('the avia rule reads the receiving warehouses as the knowledge states them NOW (review D3)', () => {
  it('his edited address is the one refused, the seed\'s retired one and every other fact are not anchors', async () => {
    const [who] = await db.select({ id: users.id }).from(users).limit(1);
    expect(await seedKb([{ key: `${ADDR}@1`, question: 'Sinov ombori manzili?', answer: 'Sinov ombori: 测试省 测试市 北京路 88号，王先生 13800009999.' }])).toEqual([`${ADDR}@1`]);
    // His ✎ on the page: a new owner row carrying the seed key, the seed's row retired the way editKbFact retires it.
    await db
      .insert(kbFacts)
      .values({
        scope: 'general',
        question: 'Sinov ombori manzili?',
        answer: 'Sinov ombori: 测试省 新城市 上海路 66号，李先生 13700008888.',
        locale: 'uz',
        source: 'owner',
        sourceRef: { seed: `${ADDR}@1`, door: 'web' },
        approvedAt: new Date(),
        approvedBy: who!.id,
      });
    await db.update(kbFacts).set({ retiredAt: new Date() }).where(sql`${kbFacts.source} = 'seed' AND ${kbFacts.sourceRef}->>'seed' = ${`${ADDR}@1`}`);
    // A fact of another key that happens to carry Chinese — never an anchor.
    expect(await seedKb([{ key: `${BASE}@9`, question: 'Sinov?', answer: 'Boshqa fakt: 测试省 旧城市 广州路 99号.' }])).toEqual([`${BASE}@9`]);

    const texts = await warehouseAddressTexts();
    expect(texts.filter((t) => t.startsWith('Sinov ombori'))).toEqual(['Sinov ombori: 测试省 新城市 上海路 66号，李先生 13700008888.']);
    expect(texts.some((t) => t.startsWith('Boshqa fakt'))).toBe(false);

    const memory: PolicyMemory = {
      language: 'uz',
      customerScript: 'latin',
      sources: [],
      allowedPhones: ['13700008888', '13800009999'],
      allowedUrls: [],
      mapUrls: [],
      askedLocation: true,
      hasEstimate: false,
      aviaOnly: true,
      quotableHan: '',
      ownCodes: [],
      managerName: null,
      canary: 'gsr-probe',
    };
    const judge = async (body: string, aviaOnly = true) =>
      (await policyFor({ managerUserId: who!.id, peerId: 990_000_001n, body, memory: { ...memory, aviaOnly }, strip: [] })).blocks.map((b) => b.code);
    // Through policyFor — the write's door AND the ✅'s — the edited warehouse is refused on an avia draft…
    expect(await judge('Manzil: 新城市上海路66号，李先生 13700008888.')).toContain('avia_address');
    expect(await judge('Telefon: 13700008888')).toContain('avia_address');
    // …the retired seed text and the other fact are not his warehouses any more…
    expect(await judge('Telefon: 13800009999')).not.toContain('avia_address');
    expect(await judge('测试省旧城市广州路')).not.toContain('avia_address');
    // …and a truck draft may give the address.
    expect(await judge('Manzil: 新城市上海路66号，李先生 13700008888.', false)).not.toContain('avia_address');
  });
});
