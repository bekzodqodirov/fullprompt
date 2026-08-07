'use server';

import { eq, sql } from 'drizzle-orm';
import { revalidatePath } from 'next/cache';
import { redirect } from 'next/navigation';
import { z } from 'zod';
import { db } from '@/modules/platform/db/client';
import { clients } from '@/modules/platform/db/schema';
import { AuthError, authorize } from '@/modules/platform/rbac/authorize';
import { diffFields, writeAudit } from '@/modules/platform/audit/service';
import { requestMeta } from '@/modules/platform/auth/session';
import { autoLinkClientToVerifiedChats } from '@/modules/platform/telegram/client-cabinet';
import {
  ClientError,
  createClient,
  isValidClientCode,
} from '@/modules/platform/clients/service';

export interface ClientFormState {
  error?: 'validation' | 'code_exists' | 'code_format';
}

const clientSchema = z.object({
  clientCode: z
    .string()
    .trim()
    .max(20)
    .transform((v) => v.toUpperCase()),
  name: z.string().trim().min(1).max(200),
  phones: z.string().trim().max(500),
  salesManagerId: z.string().uuid().optional().or(z.literal('')),
  messengerNote: z.string().trim().max(500).optional().or(z.literal('')),
  notes: z.string().trim().max(2000).optional().or(z.literal('')),
});

function parseForm(formData: FormData) {
  return clientSchema.safeParse({
    clientCode: formData.get('clientCode'),
    name: formData.get('name'),
    phones: formData.get('phones') ?? '',
    salesManagerId: formData.get('salesManagerId') ?? '',
    messengerNote: formData.get('messengerNote') ?? '',
    notes: formData.get('notes') ?? '',
  });
}

function toValues(data: z.infer<typeof clientSchema>) {
  return {
    clientCode: data.clientCode,
    name: data.name,
    phones: data.phones
      ? data.phones
          .split(',')
          .map((p) => p.trim())
          .filter(Boolean)
      : [],
    salesManagerId: data.salesManagerId || null,
    messengerNote: data.messengerNote || null,
    notes: data.notes || null,
  };
}

/**
 * The five-second client: a name and a phone.
 *
 * The code is left EMPTY on purpose — the service reads that as «mint the
 * next one», which is the owner's own rule and the whole reason this can be
 * two boxes. Returns the new id and the code it was given rather than
 * redirecting, because a `redirect()` inside an action called from an onClick
 * rejects the promise instead of resolving it, and the modal has to be able
 * to show what it created.
 */
export interface QuickClientResult {
  ok: boolean;
  id?: string;
  name?: string;
  error?: string;
}

export async function quickCreateClientAction(input: {
  name: string;
  phones: string;
}): Promise<QuickClientResult> {
  const name = String(input?.name ?? '').trim();
  const phones = String(input?.phones ?? '').trim();
  if (name.length < 1) return { ok: false, error: 'validation' };

  let actor;
  try {
    actor = await authorize('clients.manage');
  } catch (err) {
    if (err instanceof AuthError) return { ok: false, error: 'forbidden' };
    throw err;
  }

  const meta = await requestMeta();
  try {
    const row = await createClient(
      {
        clientCode: '',
        name,
        phones: phones
          .split(',')
          .map((one) => one.trim())
          .filter(Boolean),
      },
      { actorId: actor.id, ...meta },
    );
    revalidatePath('/admin/clients');
    return { ok: true, id: row.id, name: `${row.clientCode} · ${row.name}` };
  } catch (err) {
    if (err instanceof ClientError) return { ok: false, error: err.code };
    // The deploy-morning rule (#473): an action that touches the database
    // catches, so a refusal is words rather than a digest on a white page.
    console.error('[quick-client]', err);
    return { ok: false, error: 'failed' };
  }
}

export async function createClientAction(
  _prev: ClientFormState,
  formData: FormData,
): Promise<ClientFormState> {
  const actor = await authorize('clients.manage');
  const parsed = parseForm(formData);
  if (!parsed.success) return { error: 'validation' };

  // Owner's rule: empty code ⇒ the system assigns the next sequential code;
  // a manually entered code must be well-formed and free. All of that (and
  // the cabinet auto-link) lives in the shared service, which CRM's
  // lead → client conversion calls too.
  const values = toValues(parsed.data);
  const meta = await requestMeta();
  let row;
  try {
    row = await createClient(
      {
        clientCode: values.clientCode,
        name: values.name,
        phones: values.phones,
        salesManagerId: values.salesManagerId ?? undefined,
        messengerNote: values.messengerNote ?? undefined,
        notes: values.notes ?? undefined,
      },
      { actorId: actor.id, ...meta },
    );
  } catch (err) {
    if (err instanceof ClientError) return { error: err.code };
    throw err;
  }

  revalidatePath('/admin/clients');
  // Land on the new card: the owner must SEE the assigned code (and the
  // cabinet block) right after saving — the list hid it.
  redirect(`/admin/clients/${row.id}`);
}


export async function updateClientAction(
  id: string,
  _prev: ClientFormState,
  formData: FormData,
): Promise<ClientFormState> {
  const actor = await authorize('clients.manage');
  const parsed = parseForm(formData);
  if (!parsed.success) return { error: 'validation' };
  if (!isValidClientCode(parsed.data.clientCode)) return { error: 'code_format' };

  const before = await db.query.clients.findFirst({ where: eq(clients.id, id) });
  if (!before) return { error: 'validation' };

  const duplicate = await db.query.clients.findFirst({
    where: sql`upper(${clients.clientCode}) = ${parsed.data.clientCode}`,
  });
  if (duplicate && duplicate.id !== id) return { error: 'code_exists' };

  const values = toValues(parsed.data);
  const diff = diffFields(before as unknown as Record<string, unknown>, values);
  await db.update(clients).set(values).where(eq(clients.id, id));
  if (diff) {
    const meta = await requestMeta();
    await writeAudit(
      db,
      { actorId: actor.id, ...meta },
      { entityType: 'client', entityId: id, action: 'update', ...diff },
    );
  }
  // Phone edits may connect this code to an already-verified cabinet chat.
  await autoLinkClientToVerifiedChats(id, actor.id).catch(() => {});

  revalidatePath('/admin/clients');
  redirect(`/admin/clients/${id}`);
}

export async function toggleClientActiveAction(id: string): Promise<void> {
  const actor = await authorize('clients.manage');
  const before = await db.query.clients.findFirst({ where: eq(clients.id, id) });
  if (!before) return;
  await db.update(clients).set({ active: !before.active }).where(eq(clients.id, id));
  const meta = await requestMeta();
  await writeAudit(
    db,
    { actorId: actor.id, ...meta },
    {
      entityType: 'client',
      entityId: id,
      action: 'update',
      before: { active: before.active },
      after: { active: !before.active },
    },
  );
  revalidatePath('/admin/clients');
}
