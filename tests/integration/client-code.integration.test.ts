import 'dotenv/config';
import { like, sql } from 'drizzle-orm';
import { afterAll, afterEach, beforeAll, describe, expect, it } from 'vitest';
import { db, pgClient } from '@/modules/platform/db/client';
import { clients, settings } from '@/modules/platform/db/schema';
import { nextClientCode } from '@/modules/platform/clients/code';
import { ClientError, createClient } from '@/modules/platform/clients/service';

/**
 * The real SQL path of the auto client code (owner's 425 + 777/5564/5909
 * report). Uses throwaway prefixes so the seeded GS clients never interfere.
 */

const PREFIXES = ['ZZT', 'ZZ2', 'ZZ.', 'ZZR'];

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

/**
 * Two people creating a client at the same moment.
 *
 * The generator serialises against itself with an advisory lock, and that
 * half is proven below by running eight presses at once. The half the lock
 * cannot cover is a code somebody TYPED — the manual path inserts without
 * it — and the person who typed nothing must not be told their code is
 * taken.
 *
 * The deadlock that lived here (the prefix setting read from a pool
 * connection while the transaction already held one) is deliberately NOT
 * pressed from a test: it needs more simultaneous transactions than the pool
 * has, and a test that deadlocks the pool takes its own worker's remaining
 * files down with it. `tests/unit/tx-pool.test.ts` reads the code instead,
 * for every transaction in `src/`.
 */
describe('createClient under a race', () => {
  let restorePrefix: string | null = null;

  // Snapshotted ONCE, before anything has touched it. Re-reading it at the
  // top of every test looks tidier and restores ZZR at the end, because by
  // the second test the "original" value is already this file's own — which
  // is how the prefix survived a whole local run before this comment existed.
  beforeAll(async () => {
    const row = await db.query.settings.findFirst({
      where: sql`${settings.key} = 'client_code_prefix'`,
    });
    restorePrefix = row ? JSON.stringify(row.value) : null;
    await db
      .insert(settings)
      .values({ key: 'client_code_prefix', value: 'ZZR', updatedBy: null })
      .onConflictDoUpdate({ target: settings.key, set: { value: 'ZZR' } });
  });

  afterAll(async () => {
    // The prefix is CONFIGURATION — every screen that mints a code reads it,
    // so leaving ZZR behind would change what the next spec creates (#183).
    if (restorePrefix === null) {
      await db.delete(settings).where(sql`${settings.key} = 'client_code_prefix'`);
    } else {
      await db
        .update(settings)
        .set({ value: JSON.parse(restorePrefix) })
        .where(sql`${settings.key} = 'client_code_prefix'`);
    }
  });

  async function actorId(): Promise<string> {
    const who = await db.query.users.findFirst();
    if (!who) throw new Error('the suite needs at least one user');
    return who.id;
  }

  it('eight simultaneous presses get eight different codes', async () => {
    const ctx = { actorId: await actorId(), ip: null, userAgent: null };
    const made = await Promise.all(
      Array.from({ length: 8 }, (_unused, i) =>
        createClient({ clientCode: '', name: `poyga ${i}`, phones: [] }, ctx),
      ),
    );
    const codes = made.map((row) => row.clientCode);
    expect(new Set(codes).size, codes.join(' ')).toBe(8);
    // …and they are the sequence, not eight numbers scattered anywhere.
    expect(codes.map((c) => Number(c.slice(3))).sort((a, b) => a - b)).toEqual(
      Array.from({ length: 8 }, (_unused, i) => 100 + i),
    );
  });

  it('losing to a code typed at the same instant takes the NEXT one, not a refusal', async () => {
    const ctx = { actorId: await actorId(), ip: null, userAgent: null };
    await db.insert(clients).values({ clientCode: 'ZZR100', name: 'bor mijoz' });

    // Somebody typed ZZR101 by hand and their transaction has not committed
    // yet — invisible to our SELECT, fatal to our INSERT.
    let release = () => {};
    const typed = new Promise<void>((resolve) => {
      release = resolve;
    });
    const holder = pgClient.begin(async (tx) => {
      await tx`INSERT INTO clients (id, client_code, name)
               VALUES (gen_random_uuid(), 'ZZR101', 'qo''lda yozilgan')`;
      await typed;
    });

    await new Promise((r) => setTimeout(r, 100));
    // Reads ZZR100, mints ZZR101, then blocks on the unique index.
    const racing = createClient({ clientCode: '', name: 'avtomatik', phones: [] }, ctx);
    await new Promise((r) => setTimeout(r, 300));
    release();
    await holder;

    const made = await racing;
    expect(made.clientCode).toBe('ZZR102');
  });

  it('a typed code that is already taken is still refused', async () => {
    const ctx = { actorId: await actorId(), ip: null, userAgent: null };
    await db.insert(clients).values({ clientCode: 'ZZR500', name: 'birinchi' });
    // Retrying a TYPED code would hand the person a different one from the
    // number they wrote on the carton — the refusal is the honest answer.
    await expect(
      createClient({ clientCode: 'ZZR500', name: 'ikkinchi', phones: [] }, ctx),
    ).rejects.toThrow(ClientError);
  });
});
