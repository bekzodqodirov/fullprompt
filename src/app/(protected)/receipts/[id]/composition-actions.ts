'use server';

import { eq } from 'drizzle-orm';
import { revalidatePath } from 'next/cache';
import { z, ZodError } from 'zod';
import { db } from '@/modules/platform/db/client';
import { receiptLots } from '@/modules/platform/db/schema';
import { requestMeta } from '@/modules/platform/auth/session';
import { AuthError, requireActor } from '@/modules/platform/rbac/authorize';
import { isBusyError, isServerBehind } from '@/modules/platform/db/errors';
import {
  clearComposition,
  CompositionError,
  lotTrucksFor,
  saveComposition,
} from '@/modules/wms/receipts/lot-composition';

/**
 * The receipt card's lot tarkibi doors (docs/LOT-TARKIBI.md §8). Called with
 * an `await` from the editor, never as a form action: React resets an
 * uncontrolled form after a form Action, and a refused save must keep every
 * typed value (#171, #463). Every refusal comes back in a CODE the panel maps
 * to a sentence; nothing here throws at the person.
 */
export type CompositionActionResult =
  | { ok: true; rev: number; frozen: string[] }
  | {
      ok: false;
      error: string;
      seq?: number;
      field?: string;
      sums?: { sum: string; lot: string };
    };

function refusalOf(err: unknown): CompositionActionResult {
  if (err instanceof CompositionError) {
    return {
      ok: false,
      error: err.code === 'composition_changed' && err.bySelf ? 'composition_changed_self' : err.code,
      seq: err.seq,
      field: err.field,
      sums: err.sums,
    };
  }
  if (err instanceof AuthError) return { ok: false, error: 'forbidden' };
  if (err instanceof ZodError) return { ok: false, error: 'validation' };
  if (isBusyError(err)) return { ok: false, error: 'busy' };
  if (isServerBehind(err)) return { ok: false, error: 'server_behind' };
  // A CHECK the parse should have refused first — a belt, never a white page.
  const code = (err as { code?: string; cause?: { code?: string } } | null)?.code;
  if (code === '23514' || (err as { cause?: { code?: string } })?.cause?.code === '23514') {
    return { ok: false, error: 'validation' };
  }
  throw err;
}

/**
 * Revalidates the prixod and every truck the lot rides (its Bojxona tab and
 * the card's «TNVED kodsiz»); answers the codes of the trucks that hold a
 * frozen copy of THIS lot, so ✅ can say they stay as sent. The copy and not
 * `sent_to_agent_at`: a lot that boarded after the tick reads live on that
 * truck, and «stays as sent» would be a false promise there.
 */
async function afterWrite(lotId: string): Promise<string[]> {
  const lot = await db.query.receiptLots.findFirst({
    where: eq(receiptLots.id, lotId),
    columns: { receiptId: true },
  });
  if (lot) revalidatePath(`/receipts/${lot.receiptId}`);
  const trucks = (await lotTrucksFor(db, [lotId])).get(lotId) ?? [];
  for (const truck of trucks) {
    revalidatePath(`/batches/${truck.batchId}/tnved`);
    revalidatePath(`/batches/${truck.batchId}`);
  }
  return trucks.filter((truck) => truck.frozen).map((truck) => truck.code);
}

export async function saveLotCompositionAction(payload: unknown): Promise<CompositionActionResult> {
  try {
    const actor = await requireActor();
    const meta = await requestMeta();
    const { rev } = await saveComposition(payload, actor, { actorId: actor.id, ...meta });
    const lotId = (payload as { lotId: string }).lotId;
    return { ok: true, rev, frozen: await afterWrite(lotId) };
  } catch (err) {
    return refusalOf(err);
  }
}

/** The clear's post, parsed like the save's — a forged `null` is a refusal, not a TypeError. */
const clearInputSchema = z.object({ lotId: z.string().uuid(), seenRev: z.number().int().min(0) });

export async function clearLotCompositionAction(payload: {
  lotId: string;
  seenRev: number;
}): Promise<CompositionActionResult> {
  try {
    const actor = await requireActor();
    const meta = await requestMeta();
    const input = clearInputSchema.parse(payload);
    await clearComposition(input, actor, { actorId: actor.id, ...meta });
    return { ok: true, rev: 0, frozen: await afterWrite(input.lotId) };
  } catch (err) {
    return refusalOf(err);
  }
}
