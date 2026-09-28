import { healthAnswer } from '@/modules/platform/diagnostics/health';

/**
 * /api/health — what the server can honestly say about itself, for Caddy, the
 * watchdog (`ops/health-probe.mjs`), Playwright's web server and a person with
 * `curl`. Every check, its budget and why none may hang live in
 * `diagnostics/health.ts`; this file only answers. 200 only when the database,
 * the object store and the job fleet are all up — the pool and schema fields
 * are information beside that verdict, never part of it.
 */
export const dynamic = 'force-dynamic';

export async function GET() {
  const { ok, body } = await healthAnswer();
  return Response.json(body, {
    status: ok ? 200 : 503,
    headers: { 'cache-control': 'no-store' },
  });
}
