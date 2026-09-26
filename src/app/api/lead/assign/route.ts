import { trustedIpFrom } from '@/modules/platform/auth/session';
import { logger } from '@/modules/platform/logger';
import { assignForTag } from '@/modules/wms/crm/site-assign';
import {
  admit,
  allowedOrigin,
  count,
  enter,
  leave,
} from '@/modules/wms/crm/site-assign-gate';
import { ipKey, readOfferInput } from '@/modules/wms/crm/site-assign-rules';

/**
 * «Who should this website visitor write to?» (round 113).
 *
 * The website's questionnaire asks at its LAST button, from the visitor's
 * browser, and opens `t.me/<username>` with a message carrying the tag it
 * sent us. We answer with the least busy person ticked for that team (the
 * panel on /admin/taqsimot), and remember the offer so the listener can turn
 * the visitor's first message into a lead.
 *
 * THE CONTRACT IS ONE RULE: `200 {"username": "…"}` means «send them here»,
 * and ANYTHING else — `{"username": null}`, a network error, no answer within
 * the site's 1.5 s — means «use your own list». So this door has no other
 * status to explain: nobody free, a foreign page, a caller over its limit, a
 * malformed tag, a slow database and an exception all answer the same null,
 * and none of them is ever a 500 (which reaches the site as a CORS error with
 * no status at all, since Next's own error page carries none of our headers).
 *
 * Three fences, in the order that costs least:
 *  1. ORIGIN, exactly one of the allowed pages — before the database is
 *     touched at all (the list is cached). A browser names the page it came
 *     from and a script cannot hide it, so this is what keeps another site's
 *     visitors from spending our managers' queue. It is a CSRF fence, not
 *     authentication: outside a browser anybody can type any origin.
 *  2. RATE, per caller and overall, in memory (`site-assign-gate.ts`) — the
 *     pool of ten connections is every staff screen's (#714).
 *  3. A DEADLINE: the site gives up at 1.5 s, so we give up at 0.8 s and
 *     write nothing after that — an offer nobody is waiting for would count
 *     as a visitor for a manager the visitor never reached.
 */

export const dynamic = 'force-dynamic';

const BUDGET_MS = 800;

function headers(origin: string | null): Record<string, string> {
  const out: Record<string, string> = {
    'content-type': 'application/json',
    'cache-control': 'no-store',
    // The answer differs by the page that asked: no cache in between may
    // hand one page's answer (or refusal) to another.
    vary: 'Origin',
    'x-content-type-options': 'nosniff',
  };
  if (origin) out['access-control-allow-origin'] = origin;
  return out;
}

const answer = (username: string | null, origin: string | null) =>
  new Response(JSON.stringify({ username }), { status: 200, headers: headers(origin) });

export async function GET(request: Request) {
  const started = Date.now();
  let origin: string | null = null;
  try {
    origin = await allowedOrigin(request.headers.get('origin'));
    if (!origin) {
      count('origin');
      return answer(null, null);
    }
    if (!admit(ipKey(trustedIpFrom(request.headers.get('x-forwarded-for'))))) {
      count('rate');
      return answer(null, origin);
    }
    const input = readOfferInput(new URL(request.url).searchParams);
    if (!input.tag) {
      count('invalid');
      return answer(null, origin);
    }
    if (!enter()) {
      count('busy');
      return answer(null, origin);
    }
    try {
      const stillWanted = () => !request.signal.aborted && Date.now() - started < BUDGET_MS;
      let timer: ReturnType<typeof setTimeout> | undefined;
      const late = new Promise<'late'>((resolve) => {
        timer = setTimeout(() => resolve('late'), BUDGET_MS);
      });
      const result = await Promise.race([
        assignForTag(
          { team: input.team, tag: input.tag, topic: input.topic, page: input.page, lang: input.lang },
          stillWanted,
        ),
        late,
      ]).finally(() => clearTimeout(timer));
      if (result === 'late') {
        count('deadline');
        return answer(null, origin);
      }
      count(result.username ? 'answered' : 'nobody');
      return answer(result.username, origin);
    } finally {
      leave();
    }
  } catch (err) {
    // Includes the transaction's own 400 ms statement timeout: a slow minute
    // answers «use your list», never an error page.
    logger.error({ err }, '[lead-assign] answered null after an error');
    count('error');
    return answer(null, origin);
  }
}

/**
 * The browser's preflight — only needed if the site ever adds a header of its
 * own; a plain GET needs none. Answered from the same origin list, and
 * nothing else happens here.
 */
export async function OPTIONS(request: Request) {
  let origin: string | null = null;
  try {
    origin = await allowedOrigin(request.headers.get('origin'));
  } catch {
    origin = null;
  }
  const out = headers(origin);
  if (origin) {
    out['access-control-allow-methods'] = 'GET';
    out['access-control-allow-headers'] = 'content-type';
    out['access-control-max-age'] = '600';
  }
  return new Response(null, { status: 204, headers: out });
}

/**
 * Explicit, because Next answers HEAD by running GET — and a link previewer
 * or a crawler knocking with HEAD would then pick a manager and write an
 * offer for a visitor who does not exist.
 */
export async function HEAD() {
  return new Response(null, { status: 200, headers: headers(null) });
}
