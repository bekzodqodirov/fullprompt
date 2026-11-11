import { NextResponse } from 'next/server';
import { getActor } from '@/modules/platform/rbac/authorize';
import { logger } from '@/modules/platform/logger';
import { readTarkibFile } from '@/modules/wms/receipts/tarkib-read';

/**
 * «🤖 Fayldan to'ldirish» in the tarkib editor (docs/TARKIB-TAKLIFLAR.md §3)
 * — a route handler, pressed, never a server action: a reading may take a
 * minute and a half, and a page's actions queue behind each other (and an
 * action's request body and its patience are both the framework's).
 *
 * The body is two ids — `{ lotId, attachmentId }`; the bytes are read from
 * storage on the server. Every door is the service's
 * (`wms/receipts/tarkib-read.ts`), re-derived there because this app has no
 * middleware (#721-726). A refusal is `200 { ok: false, error }` in a code
 * the editor words; only a missing session is a 401. Nothing is cached, and
 * a thrown error is «failed» with a line in the log — never a white page.
 *
 * It writes nothing but its own bill line: the proposal it answers with
 * fills the editor's DRAFT, and «Saqlash» stays the person's press.
 */
const NO_STORE = { 'Cache-Control': 'private, no-store' };

export async function POST(request: Request) {
  const actor = await getActor();
  if (!actor) return NextResponse.json({ ok: false, error: 'unauthorized' }, { status: 401, headers: NO_STORE });
  let body: { lotId?: unknown; attachmentId?: unknown } | null;
  try {
    body = (await request.json()) as { lotId?: unknown; attachmentId?: unknown } | null;
  } catch {
    body = null;
  }
  try {
    const answer = await readTarkibFile(actor, { lotId: body?.lotId, attachmentId: body?.attachmentId });
    return NextResponse.json(answer, { headers: NO_STORE });
  } catch (err) {
    // A database blip is not a refusal of access: the button says «failed».
    logger.error({ err, lotId: body?.lotId, attachmentId: body?.attachmentId }, '[tarkib-read] route failed');
    return NextResponse.json({ ok: false, error: 'failed' }, { headers: NO_STORE });
  }
}
