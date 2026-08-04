'use server';

import { randomBytes } from 'node:crypto';
import { eq } from 'drizzle-orm';
import { revalidatePath } from 'next/cache';
import { db } from '@/modules/platform/db/client';
import { clientTelegramLinks } from '@/modules/platform/db/schema';
import { authorize } from '@/modules/platform/rbac/authorize';
import { requestMeta } from '@/modules/platform/auth/session';
import { writeAudit } from '@/modules/platform/audit/service';

/** Mint a one-time cabinet code the staff sends to the client (Phase 2.2). */
export async function createClientCabinetCodeAction(formData: FormData): Promise<void> {
  const clientId = String(formData.get('clientId') ?? '');
  if (!clientId) return;
  const actor = await authorize('clients.manage');
  const meta = await requestMeta();
  const code = `c${randomBytes(12).toString('base64url')}`;
  const [row] = await db
    .insert(clientTelegramLinks)
    .values({ clientId, linkCode: code, status: 'pending', createdBy: actor.id })
    .returning();
  await writeAudit(db, { actorId: actor.id, ...meta }, {
    entityType: 'client_telegram_link',
    entityId: row!.id,
    action: 'create',
    after: { clientId },
  });
  revalidatePath(`/admin/clients/${clientId}`);
}

/** Revoke a pending code or an already-linked chat — access ends immediately. */
export async function revokeClientCabinetLinkAction(formData: FormData): Promise<void> {
  const linkId = String(formData.get('linkId') ?? '');
  if (!linkId) return;
  const actor = await authorize('clients.manage');
  const meta = await requestMeta();
  const link = await db.query.clientTelegramLinks.findFirst({
    where: eq(clientTelegramLinks.id, linkId),
  });
  if (!link) return;
  await db
    .update(clientTelegramLinks)
    .set({ status: 'revoked', linkCode: null })
    .where(eq(clientTelegramLinks.id, linkId));
  await writeAudit(db, { actorId: actor.id, ...meta }, {
    entityType: 'client_telegram_link',
    entityId: linkId,
    action: 'void',
    after: { clientId: link.clientId },
  });
  revalidatePath(`/admin/clients/${link.clientId}`);
}
