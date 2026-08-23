import { createHash } from 'node:crypto';
import { gzip } from 'node:zlib';
import { promisify } from 'node:util';

const gzipAsync = promisify(gzip);

/**
 * JSON for a phone at the far end of a slow link.
 *
 * Next compresses the HTML and RSC it renders. It does NOT compress a Route
 * Handler's own `Response` — measured on the loading snapshot: 28,506 bytes
 * on the wire with `Accept-Encoding: gzip` asked for, and 975 bytes when the
 * same body is gzipped (29x). The warehouse screens re-read that snapshot
 * every 15 seconds, per phone, so on the China→Europe link that difference
 * IS the owner's «xitoyda ishlatib bolmayabti» (round 110). Caddy is not the
 * place to fix it here: its config is generated inline by docker-compose and
 * nothing in this container can test an edge change before deploy morning
 * (#472's trap), while this helper is measurable by a test.
 *
 * Two jobs, both about bytes that need not travel:
 *
 * 1. **ETag.** A poll that finds nothing changed costs a 304 and no body.
 *    The tag is the hash of the body we were about to send, so it is exact
 *    by construction — it cannot claim "unchanged" about a payload that
 *    changed, whatever the query did.
 * 2. **gzip**, on the threadpool rather than the event loop: this process is
 *    the whole app's ceiling (round 74) and 250 KB of JSON is a few
 *    milliseconds of CPU it should not spend inline.
 *
 * Bodies under `MIN_GZIP` are sent as they are — the header costs more than
 * the saving, and every scan ack is tiny.
 */
const MIN_GZIP = 1024;

export interface JsonOptions {
  /** Extra response headers (Cache-Control, and anything the route owns). */
  headers?: Record<string, string>;
  status?: number;
}

export async function json(request: Request, data: unknown, options: JsonOptions = {}) {
  const body = JSON.stringify(data);
  const headers = new Headers(options.headers);
  headers.set('Content-Type', 'application/json');
  // A poll that changes nothing must not re-download itself. Weak tag: the
  // bytes are what we compare, and a proxy re-compressing them does not make
  // the resource a different one.
  const etag = `W/"${createHash('sha1').update(body).digest('base64url')}"`;
  headers.set('ETag', etag);
  // Never a shared cache: every one of these answers is scoped to the actor
  // that asked (round 91's rule, one layer down).
  if (!headers.has('Cache-Control')) headers.set('Cache-Control', 'private, no-cache');
  headers.set('Vary', 'Accept-Encoding');

  if (matchesEtag(request.headers.get('if-none-match'), etag)) {
    return new Response(null, { status: 304, headers });
  }

  const bytes = Buffer.from(body, 'utf8');
  if (bytes.byteLength >= MIN_GZIP && acceptsGzip(request.headers.get('accept-encoding'))) {
    const packed = await gzipAsync(bytes);
    headers.set('Content-Encoding', 'gzip');
    headers.set('Content-Length', String(packed.byteLength));
    return new Response(packed, { status: options.status ?? 200, headers });
  }
  headers.set('Content-Length', String(bytes.byteLength));
  return new Response(bytes, { status: options.status ?? 200, headers });
}

/**
 * `If-None-Match` is a LIST, and a proxy may hand back the tag with a
 * `-gzip` suffix bolted on (Apache does this, and so do some CDNs), so a
 * bare string compare answers "changed" about a body that did not.
 */
function matchesEtag(header: string | null, etag: string): boolean {
  if (!header) return false;
  if (header.trim() === '*') return true;
  const bare = (tag: string) => tag.trim().replace(/^W\//, '').replace(/^"|"$/g, '').replace(/-gzip$/, '');
  const mine = bare(etag);
  return header.split(',').some((tag) => bare(tag) === mine);
}

function acceptsGzip(header: string | null): boolean {
  if (!header) return false;
  return header
    .split(',')
    .map((part) => part.trim().toLowerCase())
    .some((part) => part === 'gzip' || part.startsWith('gzip;'));
}
