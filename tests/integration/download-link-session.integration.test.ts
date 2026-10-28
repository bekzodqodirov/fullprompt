import 'dotenv/config';
import { eq } from 'drizzle-orm';
import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';

/**
 * The session side of a download link: the link route asks a file route AS
 * the token's person, and `getSessionUser` honours that only beside the
 * process's internal key (`download-link.ts`). `next/headers` is replaced by
 * a stand-in carrying exactly the headers each case sends — there is no
 * request here, and the cookie path must answer «nobody» so that every
 * success below is the delegation's and nothing else's.
 */

let requestHeaders = new Headers();
vi.mock('next/headers', () => ({
  headers: async () => requestHeaders,
  cookies: async () => ({ get: () => undefined, set: () => undefined, delete: () => undefined }),
}));

const { db, pgClient } = await import('@/modules/platform/db/client');
const { users } = await import('@/modules/platform/db/schema');
const { getSessionUser } = await import('@/modules/platform/auth/session');
const { DELEGATED_USER_HEADER, INTERNAL_HEADER, internalKey } = await import(
  '@/modules/platform/auth/download-link'
);

const STAMP = String(Date.now()).slice(-7);
const savedSecret = process.env.SESSION_SECRET;
let liveId = '';
let goneId = '';

beforeAll(async () => {
  process.env.SESSION_SECRET = 'integration-download-secret';
  const [live] = await db
    .insert(users)
    .values({ phone: `+99891${STAMP}`, fullName: `Link live ${STAMP}`, passwordHash: 'x', locale: 'ru' })
    .returning({ id: users.id });
  const [gone] = await db
    .insert(users)
    .values({ phone: `+99892${STAMP}`, fullName: `Link gone ${STAMP}`, passwordHash: 'x', active: false })
    .returning({ id: users.id });
  liveId = live!.id;
  goneId = gone!.id;
});

beforeEach(() => {
  requestHeaders = new Headers();
});

afterAll(async () => {
  await db.delete(users).where(eq(users.id, liveId));
  await db.delete(users).where(eq(users.id, goneId));
  if (savedSecret === undefined) delete process.env.SESSION_SECRET;
  else process.env.SESSION_SECRET = savedSecret;
  await pgClient.end();
});

describe('a file route asked by the link route', () => {
  it('runs as the token’s person when the internal key is the process’s own', async () => {
    requestHeaders = new Headers({ [INTERNAL_HEADER]: internalKey()!, [DELEGATED_USER_HEADER]: liveId });
    const user = await getSessionUser();
    expect(user).toMatchObject({ id: liveId, fullName: `Link live ${STAMP}`, locale: 'ru', sessionId: '' });
  });

  it('is a stranger without the key, or with a wrong one — the header alone opens nothing', async () => {
    requestHeaders = new Headers({ [DELEGATED_USER_HEADER]: liveId });
    expect(await getSessionUser()).toBeNull();
    requestHeaders = new Headers({ [INTERNAL_HEADER]: `${internalKey()}x`, [DELEGATED_USER_HEADER]: liveId });
    expect(await getSessionUser()).toBeNull();
  });

  it('gets nothing for a person deactivated since the link was minted', async () => {
    requestHeaders = new Headers({ [INTERNAL_HEADER]: internalKey()!, [DELEGATED_USER_HEADER]: goneId });
    expect(await getSessionUser()).toBeNull();
  });
});
