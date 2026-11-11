'use server';

import { revalidatePath } from 'next/cache';
import { requestMeta } from '@/modules/platform/auth/session';
import { isBusyError, isServerBehind } from '@/modules/platform/db/errors';
import { enqueue } from '@/modules/platform/jobs/boss';
import { AuthError, requireActor } from '@/modules/platform/rbac/authorize';
import { JOB_CLIENT_NOTICES } from '@/modules/wms/notices/arrival-jobs';
import { ClientAskError, ClientDisputeError, askClientAboutReceipt, dismissClientDisputes } from '@/modules/wms/receipts/client-confirm';
import { askFits } from '@/modules/wms/receipts/client-confirm-text';

/**
 * The prixod card's «📨 Mijozdan so'rash» and «E'tirozni yopish» (0144,
 * docs/TARKIB-TAKLIFLAR.md §4.5). Called with an `await` from a button,
 * never as a form action; every refusal comes back as a CODE the card turns
 * into a sentence — a white page on a server one migration behind is the
 * morning this file must not have (#472).
 */
export type ClientAskActionResult = { ok: true; lots: number } | { ok: false; error: string };

function refusalOf(err: unknown): ClientAskActionResult {
  if (err instanceof ClientAskError || err instanceof ClientDisputeError) return { ok: false, error: err.code };
  if (err instanceof AuthError) return { ok: false, error: 'forbidden' };
  if (isBusyError(err) || isBusyError((err as { cause?: unknown } | null)?.cause)) return { ok: false, error: 'busy' };
  if (isServerBehind(err)) return { ok: false, error: 'server_behind' };
  console.error('[client-ask]', err);
  return { ok: false, error: 'other' };
}

function afterWrite(receiptId: string): void {
  revalidatePath(`/receipts/${receiptId}`);
  revalidatePath('/stock');
  revalidatePath('/');
}

/** Queue the question — and wake the sweep, so it goes out now and not on the next two-minute tick. */
export async function askClientAction(receiptId: string): Promise<ClientAskActionResult> {
  try {
    const actor = await requireActor();
    const meta = await requestMeta();
    const { lots } = await askClientAboutReceipt(String(receiptId), actor, { actorId: actor.id, ...meta }, askFits);
    await enqueue(JOB_CLIENT_NOTICES, {}).catch(() => {});
    afterWrite(String(receiptId));
    return { ok: true, lots };
  } catch (err) {
    return refusalOf(err);
  }
}

/** Close the client's ❌ on one lot, or on every disputed lot of the prixod — only the ones the card drew. */
export async function dismissDisputesAction(payload: {
  receiptId: string;
  seen: { lotId: string; token: string }[];
  note?: string;
}): Promise<ClientAskActionResult> {
  const receiptId = String(payload?.receiptId ?? '');
  try {
    const actor = await requireActor();
    const meta = await requestMeta();
    const seen = Array.isArray(payload?.seen)
      ? payload.seen.map((row) => ({ lotId: String(row?.lotId ?? ''), token: String(row?.token ?? '') }))
      : [];
    const { lots } = await dismissClientDisputes(
      { receiptId, seen, note: typeof payload?.note === 'string' ? payload.note : null },
      actor,
      { actorId: actor.id, ...meta },
    );
    afterWrite(receiptId);
    return { ok: true, lots };
  } catch (err) {
    const result = refusalOf(err);
    // «The card is out of date»: re-render it, so the next press carries the current answer.
    if (!result.ok && result.error === 'check_changed' && receiptId) afterWrite(receiptId);
    return result;
  }
}
