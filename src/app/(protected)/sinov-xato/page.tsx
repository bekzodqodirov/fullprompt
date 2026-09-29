import { notFound } from 'next/navigation';
import { getActor } from '@/modules/platform/rbac/authorize';
import { mayReadSystemErrors } from '@/modules/platform/diagnostics/errors';

export const dynamic = 'force-dynamic';

/**
 * A page that fails ON PURPOSE, so the browser suite can prove the whole road
 * of B9's error list: a render throws → Next shows the digest → the digest is
 * found on /admin/xatolar. Nothing else can make a real server error on
 * demand.
 *
 * Shut twice: it answers 404 unless the server was started with
 * `ERROR_PROBE=on` — set only in playwright.config.ts's web server, never on
 * the owner's machine — and even then only to the super admin. Not under a
 * `_`-prefixed folder: the App Router does not route private folders, so
 * `_probe` would have been a 404 whatever the switch said (the package
 * judge's first finding).
 */
export default async function ErrorProbePage() {
  if (process.env.ERROR_PROBE !== 'on') notFound();
  const actor = await getActor();
  if (!actor || !mayReadSystemErrors(actor)) notFound();
  throw new Error(`kuzatuv sinov xatosi ${Date.now()}`);
}
