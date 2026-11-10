import { eq } from 'drizzle-orm';
import { db } from '@/modules/platform/db/client';
import { calcGroups, calcRequests } from '@/modules/platform/db/schema';

/**
 * The revision a VED's screen drawn NOW would carry — what every test press of
 * the four official doors passes as `sawRev` (docs/SAKKIZ-R3.md §10A, P6).
 *
 * The doors take it REQUIRED, so each test call became a compile error that
 * named itself (rule 3), and each was re-anchored onto this: the press is made
 * over a page loaded just before it, which is what every one of those tests
 * meant before the argument existed. Read on the POOL with no lock — a test
 * that holds the request row in a second connection still reads it.
 */
export async function sawRev(requestId: string): Promise<number> {
  const [row] = await db
    .select({ rev: calcRequests.rev })
    .from(calcRequests)
    .where(eq(calcRequests.id, requestId))
    .limit(1);
  // A request that does not exist is the door's own `not_found` to report,
  // and some tests press exactly that: any number lets the door answer.
  return row?.rev ?? 0;
}

/** The same, for a door that names a GROUP (the ✅): its request's revision. */
export async function sawRevOfGroup(groupId: string): Promise<number> {
  const [row] = await db
    .select({ rev: calcRequests.rev })
    .from(calcGroups)
    .innerJoin(calcRequests, eq(calcRequests.id, calcGroups.requestId))
    .where(eq(calcGroups.id, groupId))
    .limit(1);
  return row?.rev ?? 0;
}
