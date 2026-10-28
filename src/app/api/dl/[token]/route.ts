import { logger } from '@/modules/platform/logger';
import {
  DELEGATED_USER_HEADER,
  INTERNAL_HEADER,
  internalKey,
  readDownloadToken,
} from '@/modules/platform/auth/download-link';

export const dynamic = 'force-dynamic';

/** What the file route said that the phone needs to hear — never its cookies, never an encoding the fetch already undid. */
const PASSED = ['content-type', 'content-disposition', 'cache-control', 'last-modified', 'etag'];

const EXPIRED_PAGE = `<!doctype html><meta charset="utf-8"><meta name="viewport" content="width=device-width">
<body style="font:16px system-ui;padding:24px">
<p>Havola eskirgan. Sahifaga qaytib, faylni qayta bosing.</p>
<p>Ссылка устарела. Вернитесь на страницу и нажмите на файл ещё раз.</p></body>`;

/**
 * Serve a download link (`download-link.ts`): the file route named in the
 * token, asked AS the token's person.
 *
 * The phone's download manager arrives here with no cookie. The token says
 * who and what; this route asks the real file route on the app's own port
 * with the delegated-user header and the process's internal key, so the file
 * route runs its own door exactly as for that person's browser — the act's
 * warehouse check, the attachment's audience, the report's money sight — and
 * nothing is decided here but the signature and the deadline. A refusal from
 * the file route (403, 404) comes back as itself.
 */
export async function GET(request: Request, { params }: { params: Promise<{ token: string }> }) {
  const { token } = await params;
  const read = readDownloadToken(token);
  if (!read.ok) {
    if (read.reason !== 'expired') logger.warn({ reason: read.reason }, '[download-link] refused');
    return new Response(EXPIRED_PAGE, {
      status: read.reason === 'expired' ? 410 : 404,
      headers: { 'content-type': 'text/html; charset=utf-8', 'cache-control': 'no-store' },
    });
  }
  const key = internalKey();
  if (!key) return new Response('Not found', { status: 404 });

  const port = process.env.PORT ?? '3000';
  let upstream: Response;
  try {
    upstream = await fetch(`http://127.0.0.1:${port}${read.grant.path}`, {
      method: 'GET',
      cache: 'no-store',
      redirect: 'manual',
      headers: {
        [INTERNAL_HEADER]: key,
        [DELEGATED_USER_HEADER]: read.grant.userId,
        'accept-language': request.headers.get('accept-language') ?? '',
        'user-agent': request.headers.get('user-agent') ?? '',
      },
    });
  } catch (err) {
    logger.error({ err, path: read.grant.path }, '[download-link] file route unreachable');
    return new Response('Unavailable', { status: 502 });
  }

  const headers = new Headers({ 'x-robots-tag': 'noindex' });
  for (const name of PASSED) {
    const value = upstream.headers.get(name);
    if (value) headers.set(name, value);
  }
  // A link is single-person and short-lived: no shared cache may keep its bytes.
  headers.set('cache-control', 'private, no-store');
  return new Response(upstream.body, { status: upstream.status, headers });
}
