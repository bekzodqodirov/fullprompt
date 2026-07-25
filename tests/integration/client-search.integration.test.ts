import 'dotenv/config';
import { like } from 'drizzle-orm';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { db, pgClient } from '@/modules/platform/db/client';
import { clients } from '@/modules/platform/db/schema';
import { searchClients } from '@/modules/platform/clients/search';

/**
 * Receiving autocomplete (owner's report: typing the unknown code GS500
 * offered GS300 and hid the "unknown cargo" path). Digits in a code are
 * meaningful — fuzzy matching must not cross them.
 */

const PREFIX = 'ZQS';

/** Only this suite's rows (the seed has ~300 real clients). */
async function match(q: string): Promise<string[]> {
  const hits = await searchClients(q, 50);
  return hits.map((h) => h.clientCode).filter((c) => c.startsWith(PREFIX));
}

beforeAll(async () => {
  await db.delete(clients).where(like(clients.clientCode, `${PREFIX}%`));
  await db.insert(clients).values([
    { clientCode: `${PREFIX}300`, name: 'Uch yuz' },
    { clientCode: `${PREFIX}301`, name: 'Uch yuz bir' },
    { clientCode: `${PREFIX}777`, name: 'Jannat opa' },
    { clientCode: `${PREFIX}900`, name: 'Nofaol', active: false },
  ]);
});

afterAll(async () => {
  await db.delete(clients).where(like(clients.clientCode, `${PREFIX}%`));
  await pgClient.end();
});

describe('client search matching', () => {
  it('an unknown full code returns NOTHING instead of a similar one', async () => {
    expect(await match(`${PREFIX}500`)).toEqual([]);
    expect(await match(`${PREFIX}302`)).toEqual([]);
  });

  it('an existing code still resolves exactly, lowercase included', async () => {
    expect(await match(`${PREFIX}777`)).toEqual([`${PREFIX}777`]);
    expect(await match(`${PREFIX.toLowerCase()}777`)).toEqual([`${PREFIX}777`]);
  });

  it('a partial code still lists its family, exact-first', async () => {
    expect((await match(`${PREFIX}30`)).sort()).toEqual([`${PREFIX}300`, `${PREFIX}301`]);
    expect(await match('777')).toEqual([`${PREFIX}777`]);
    const family = await match(`${PREFIX}300`);
    expect(family[0]).toBe(`${PREFIX}300`);
  });

  it('name typos stay fuzzy', async () => {
    expect(await match('Jannat opa')).toEqual([`${PREFIX}777`]);
    expect(await match('Janat')).toEqual([`${PREFIX}777`]);
  });

  it('inactive clients never surface', async () => {
    expect(await match(`${PREFIX}900`)).toEqual([]);
  });

  it('an empty query returns nothing', async () => {
    expect(await searchClients('  ')).toEqual([]);
  });
});
