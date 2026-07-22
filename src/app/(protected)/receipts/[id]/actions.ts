'use server';

import { eq } from 'drizzle-orm';
import { revalidatePath } from 'next/cache';
import { z } from 'zod';
import { db } from '@/modules/platform/db/client';
import { receipts } from '@/modules/platform/db/schema';
import { authorize } from '@/modules/platform/rbac/authorize';
import { requestMeta } from '@/modules/platform/auth/session';
import { voidReceipt } from '@/modules/wms/receipts/service';

const voidSchema = z.object({
  receiptId: z.string().uuid(),
  reason: z.string().trim().min(3).max(500),
});

export async function voidReceiptAction(formData: FormData): Promise<void> {
  const parsed = voidSchema.safeParse({
    receiptId: formData.get('receiptId'),
    reason: formData.get('reason'),
  });
  if (!parsed.success) return;

  const receipt = await db.query.receipts.findFirst({
    where: eq(receipts.id, parsed.data.receiptId),
  });
  if (!receipt) return;

  const actor = await authorize('receipts.void', { warehouseId: receipt.warehouseId });
  const meta = await requestMeta();
  await voidReceipt(parsed.data.receiptId, parsed.data.reason, { actorId: actor.id, ...meta });
  revalidatePath(`/receipts/${parsed.data.receiptId}`);
}
