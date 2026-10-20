'use server';

import { revalidatePath } from 'next/cache';
import { requestMeta } from '@/modules/platform/auth/session';
import { getActor } from '@/modules/platform/rbac/authorize';
import { isBusyError, isServerBehind } from '@/modules/platform/db/errors';
import { mayReadReceipt } from '@/modules/wms/receipts/read-door';
import { db } from '@/modules/platform/db/client';
import { receipts } from '@/modules/platform/db/schema';
import { eq } from 'drizzle-orm';
import { FtlError, ftlDoorFor } from '@/modules/wms/ftl/door';
import { isLoadMode } from '@/modules/wms/ftl/sql';
import { setDealLoad, setReceiptLoad, type CascadeSkip } from '@/modules/wms/ftl/service';

/**
 * The prixod card's «Yuk turi» (0135, the owner's 1a 2a 6a). Awaited from the
 * block, never a form action, and every refusal comes back as a CODE the
 * block turns into a sentence (lot-check-actions' shape). The door itself —
 * who may write which mode on whose cargo, and the paid-month freeze — is the
 * SERVICE's (`setReceiptLoad`, `setDealLoad`); this file only finds the person
 * and asks the card's own read door first (#531: a hidden button is not a
 * refusal).
 */
export type LoadActionResult =
  | {
      ok: true;
      changed: boolean;
      /** The deal's own cascade — named prixod by prixod, never silent. */
      cascade?: { changed: number; skipped: { number: string | null; why: CascadeSkip }[] };
    }
  | { ok: false; error: string; month?: string; sellerName?: string | null };

function refusalOf(err: unknown): LoadActionResult {
  if (err instanceof FtlError) {
    return { ok: false, error: err.code, month: err.detail?.month, sellerName: err.detail?.sellerName ?? null };
  }
  if (isBusyError(err)) return { ok: false, error: 'busy' };
  if (isServerBehind(err)) return { ok: false, error: 'server_behind' };
  throw err;
}

async function readableReceipt(receiptId: string) {
  const actor = await getActor();
  if (!actor) return { actor: null, receipt: null } as const;
  const receipt = await db.query.receipts.findFirst({
    where: eq(receipts.id, receiptId),
    columns: { id: true, warehouseId: true, dealId: true },
  });
  if (!receipt || !(await mayReadReceipt(actor, { id: receipt.id, warehouseId: receipt.warehouseId }))) {
    return { actor, receipt: null } as const;
  }
  return { actor, receipt } as const;
}

export async function setReceiptLoadAction(receiptId: string, mode: unknown): Promise<LoadActionResult> {
  if (typeof receiptId !== 'string' || !isLoadMode(mode)) return { ok: false, error: 'validation' };
  const { actor, receipt } = await readableReceipt(receiptId);
  if (!actor) return { ok: false, error: 'forbidden' };
  if (!receipt) return { ok: false, error: 'not_found' };
  try {
    const result = await setReceiptLoad(receiptId, mode, ftlDoorFor(actor), { actorId: actor.id, ...(await requestMeta()) });
    revalidatePath(`/receipts/${receiptId}`);
    return { ok: true, changed: result.changed };
  } catch (err) {
    return refusalOf(err);
  }
}

/**
 * The office's «Bitimni ham LTL qilish» — the accountant cannot open a deal
 * card, so the deal's own mode is offered here for the deal THIS prixod is on
 * — and its «FTL'ni ofis nomidan tasdiqlash», which takes a seller's mark as
 * the office's and passes it to the cargo it had stopped short of.
 * The door is office-only in the service; the deal id is the receipt's, never
 * one a form posted.
 */
export async function setLinkedDealLoadAction(receiptId: string, mode: unknown): Promise<LoadActionResult> {
  if (typeof receiptId !== 'string' || !isLoadMode(mode)) return { ok: false, error: 'validation' };
  const { actor, receipt } = await readableReceipt(receiptId);
  if (!actor) return { ok: false, error: 'forbidden' };
  if (!receipt?.dealId) return { ok: false, error: 'not_found' };
  try {
    const result = await setDealLoad(receipt.dealId, mode, ftlDoorFor(actor), {
      actorId: actor.id,
      ...(await requestMeta()),
    });
    revalidatePath(`/receipts/${receiptId}`);
    revalidatePath(`/bitimlar/${receipt.dealId}`);
    return {
      ok: true,
      changed: result.changed,
      cascade: result.cascade
        ? {
            changed: result.cascade.changed,
            skipped: result.cascade.skipped.map((skip) => ({ number: skip.number, why: skip.why })),
          }
        : undefined,
    };
  } catch (err) {
    return refusalOf(err);
  }
}
