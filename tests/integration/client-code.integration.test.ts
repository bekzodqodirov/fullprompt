import 'dotenv/config';
import { like } from 'drizzle-orm';
import { afterAll, afterEach, describe, expect, it } from 'vitest';
import { db, pgClient } from '@/modules/platform/db/client';
import { clients } from '@/modules/platform/db/schema';
import { nextClientCode } from '@/modules/platform/clients/code';

/**
 * The real SQL path of the auto client code (owner's 425 + 777/5564/5909
 * report). Uses throwaway prefixes so the seeded GS clients never interfere.
 */

const PREFIXES = ['ZZT', 'ZZ2', 'ZZ.'];

async function seedCodes(prefix: string, numbers: number[]) {
  await db.insert(clients).values(
    numbers.map((n) => ({ clientCode: `${prefix}${n}`, name: `auto ${prefix}${n}` })),
  );
}

afterEach(async () => {
  for (const prefix of PREFIXES) {
    await db.delete(clients).where(like(clients.clientCode, `${prefix}%`));
  }
});

afterAll(async () => {
  await pgClient.end();
});

describe('nextClientCode (DB path)', () => {
  it('continues the main run and steps over one-off codes', async () => {
    const numbers = Array.from({ length: 425 }, (_, i) => i + 1);
    await seedCodes('ZZT', [...numbers, 777, 5564, 5909]);
    expect(await nextClientCode(db, 'ZZT')).toBe('ZZT426');
  });

  it('starts at 100 when the prefix has no clients yet', async () => {
    expect(await nextClientCode(db, 'ZZT')).toBe('ZZT100');
  });

  it('a prefix ending in a digit does not swallow its own last character', async () => {
    // ZZ2150 must read as ZZ2 + 150, not ZZ + 2150.
    await seedCodes('ZZ2', [150, 151]);
    expect(await nextClientCode(db, 'ZZ2')).toBe('ZZ2152');
  });

  it('a lowercase prefix setting still produces DB-valid uppercase codes', async () => {
    await seedCodes('ZZT', [200, 201]);
    // clients_code_upper_check would reject 'zzt202'.
    expect(await nextClientCode(db, 'zzt')).toBe('ZZT202');
  });

  it('a prefix with regex metacharacters matches literally', async () => {
    await seedCodes('ZZ.', [300]);
    // 'ZZ.' must not match 'ZZT...' rows — those belong to another prefix.
    await seedCodes('ZZT', [900]);
    expect(await nextClientCode(db, 'ZZ.')).toBe('ZZ.301');
  });
});
