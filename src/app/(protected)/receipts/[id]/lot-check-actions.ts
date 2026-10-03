'use server';

import { eq } from 'drizzle-orm';
import { revalidatePath } from 'next/cache';
import { ZodError } from 'zod';
import { db } from '@/modules/platform/db/client';
import { receiptLots } from '@/modules/platform/db/schema';
import { requestMeta } from '@/modules/platform/auth/session';
import { AuthError, requireActor } from '@/modules/platform/rbac/authorize';
import { isBusyError, isServerBehind } from '@/modules/platform/db/errors';
import { checkLot, LotCheckError, uncheckLot } from '@/modules/wms/receipts/lot-check';

/**
 * The prixod card's «✅ To'g'ri — mijoz tasdiqladi» and «Bekor qilish»
 * (docs/YUK-TEKSHIRUV.md §5). Called with an `await` from the panel, never as
 * a form action, so a refusal keeps the typed note (#463), and every refusal
 * comes back as a CODE the panel turns into a sentence.
 */
export type LotCheckActionResult = { ok: true; changed: boolean } | { ok: false; error: string };

function refusalOf(err: unknown): LotCheckActionResult {
  if (err instanceof LotCheckError) return { ok: false, error: err.code };
  if (err instanceof AuthError) return { ok: false, error: 'forbidden' };
  if (err instanceof ZodError) return { ok: false, error: 'validation' };
  if (isBusyError(err)) return { ok: false, error: 'busy' };
  // A deploy whose migration did not land (#472): a sentence, never a white page.
  if (isServerBehind(err)) return { ok: false, error: 'server_behind' };
  const code = (err as { code?: string; cause?: { code?: string } } | null)?.code;
  if (code === '23514' || (err as { cause?: { code?: string } })?.cause?.code === '23514') {
    return { ok: false, error: 'validation' };
  }
  throw err;
}

/** The prixod, the shelf, the plan editor's list and the homes read the state. */
async function afterWrite(lotId: string): Promise<void> {
  const lot = await db.query.receiptLots.findFirst({
    where: eq(receiptLots.id, lotId),
    columns: { receiptId: true },
  });
  if (lot) revalidatePath(`/receipts/${lot.receiptId}`);
  revalidatePath('/stock');
  revalidatePath('/');
}

export async function checkLotAction(payload: unknown): Promise<LotCheckActionResult> {
  try {
    const actor = await requireActor();
    const meta = await requestMeta();
    const { changed } = await checkLot(payload, actor, { actorId: actor.id, ...meta });
    await afterWrite((payload as { lotId: string }).lotId);
    return { ok: true, changed };
  } catch (err) {
    return refusalOf(err);
  }
}

export async function uncheckLotAction(payload: unknown): Promise<LotCheckActionResult> {
  try {
    const actor = await requireActor();
    const meta = await requestMeta();
    const { changed } = await uncheckLot(payload, actor, { actorId: actor.id, ...meta });
    await afterWrite((payload as { lotId: string }).lotId);
    return { ok: true, changed };
  } catch (err) {
    return refusalOf(err);
  }
}
