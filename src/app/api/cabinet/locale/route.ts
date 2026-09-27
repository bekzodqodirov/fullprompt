import { logger } from '@/modules/platform/logger';
import {
  authenticateCabinet,
  changeCabinetLocale,
  initDataFrom,
} from '@/modules/wms/client-cabinet/miniapp';

/**
 * The Mini App's language switch (round C).
 *
 * The same door as every other cabinet request: the signed `initData` in the
 * HEADER and nothing else — never in the body, never in the URL — and the
 * identity that comes out is the chat, so the only codes a request can
 * re-language are the ones this chat already holds (#273). A header a form
 * post cannot set is also what makes this safe from another site's page.
 *
 * The body is `{ "locale": "uz" | "ru" | "en" }`; anything else is a 400.
 */
export const dynamic = 'force-dynamic';

const NO_STORE = { 'cache-control': 'no-store, private' };

export async function POST(request: Request) {
  const auth = await authenticateCabinet(initDataFrom(request));
  if (!auth.ok) return Response.json({ error: auth.reason }, { status: auth.status, headers: NO_STORE });

  // A language is two letters; a body bigger than a sentence is not a choice.
  const raw = await request.text().catch(() => '');
  let requested: unknown = null;
  if (raw.length <= 200) {
    try {
      requested = (JSON.parse(raw) as { locale?: unknown } | null)?.locale ?? null;
    } catch {
      requested = null;
    }
  }

  try {
    const out = await changeCabinetLocale(auth, requested);
    if (!out.ok) return Response.json({ error: out.reason }, { status: out.status, headers: NO_STORE });
    return Response.json({ ok: true, locale: out.locale, changed: out.changed }, { headers: NO_STORE });
  } catch (err) {
    // The screen puts the old language back; the reason is for the log.
    logger.error({ err, chatId: String(auth.chatId) }, 'cabinet language change failed');
    return Response.json({ error: 'failed' }, { status: 500, headers: NO_STORE });
  }
}
