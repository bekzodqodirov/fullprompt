import 'dotenv/config';
import { eq, like, sql } from 'drizzle-orm';
import { afterAll, describe, expect, it } from 'vitest';
import { db, pgClient } from '@/modules/platform/db/client';
import { kbFacts, users } from '@/modules/platform/db/schema';
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

afterAll(async () => {
  await db.delete(kbFacts).where(like(sql`${kbFacts.sourceRef}->>'seed'`, `${BASE}@%`));
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
