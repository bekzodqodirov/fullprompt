import 'dotenv/config';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { eq, inArray } from 'drizzle-orm';
import { db, pgClient } from '@/modules/platform/db/client';
import { users } from '@/modules/platform/db/schema';
import { findUserByIdentifier } from '@/modules/platform/auth/identify';
import { hashPassword } from '@/modules/platform/auth/password';

/**
 * Who the login box means.
 *
 * `phone` and `username` are each unique, and that is exactly what makes the
 * OR of them dangerous: one row can answer to a string by phone while a
 * DIFFERENT row answers to the same string by username. The old read asked for
 * both in one query with `limit(1)` and no ORDER BY, so the planner chose whose
 * password got checked — and the loser is a colleague refused with the right
 * password, at random, with nothing to explain it.
 *
 * This file mints exactly that collision, which no fixture in the suite had.
 */

const SUFFIX = String(Date.now()).slice(-9);
const SHARED = `+9989${SUFFIX}`;

let phoneUserId = '';
let usernameUserId = '';

beforeAll(async () => {
  const passwordHash = await hashPassword('demo1234');
  // The USERNAME holder is inserted FIRST, and that ordering is the test.
  // A single `or(phone, username)` read returns whichever row Postgres reaches
  // first, and for two fresh rows that is the earlier one — so the broken
  // version hands back this person and the fixed one does not. Written the
  // other way round the test passes with the defect in place, which is how it
  // was first written here and why it proved nothing.
  //
  // Nothing forbids the collision: the admin form takes any string up to 50
  // characters as a username and checks duplicates against phones alone.
  const [byUsername] = await db
    .insert(users)
    .values({
      fullName: `Login egasi ${SUFFIX}`,
      phone: `+9988${SUFFIX}`,
      username: SHARED,
      passwordHash,
      active: true,
    })
    .returning();
  usernameUserId = byUsername!.id;

  const [byPhone] = await db
    .insert(users)
    .values({
      fullName: `Telefon egasi ${SUFFIX}`,
      phone: SHARED,
      passwordHash,
      active: true,
    })
    .returning();
  phoneUserId = byPhone!.id;
});

afterAll(async () => {
  await db.delete(users).where(inArray(users.id, [phoneUserId, usernameUserId]));
  await pgClient.end();
});

describe('a string that two different people answer to', () => {
  it('resolves to the PHONE owner, every time', async () => {
    // Ten reads, because the defect this replaces was a coin toss the planner
    // made — a single green read proves nothing about it.
    for (let i = 0; i < 10; i += 1) {
      const found = await findUserByIdentifier(SHARED);
      expect(found?.id).toBe(phoneUserId);
    }
  });

  it('still finds somebody who only has a username', async () => {
    const found = await findUserByIdentifier(`+9988${SUFFIX}`);
    expect(found?.id).toBe(usernameUserId);
    const [row] = await db.select().from(users).where(eq(users.id, usernameUserId));
    expect(row!.username).toBe(SHARED);
  });

  it('answers nothing for a string nobody owns', async () => {
    expect(await findUserByIdentifier(`+000${SUFFIX}`)).toBeUndefined();
  });
});
