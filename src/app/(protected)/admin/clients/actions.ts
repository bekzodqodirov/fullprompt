'use server';

import { eq, sql } from 'drizzle-orm';
import { revalidatePath } from 'next/cache';
import { redirect } from 'next/navigation';
import { z } from 'zod';
import { db } from '@/modules/platform/db/client';
import { clients } from '@/modules/platform/db/schema';
import { authorize, getActor } from '@/modules/platform/rbac/authorize';
import { diffFields, writeAudit } from '@/modules/platform/audit/service';
import { requestMeta } from '@/modules/platform/auth/session';
import { autoLinkClientToVerifiedChats } from '@/modules/platform/telegram/client-cabinet';
import { activeClientsByPhone } from '@/modules/wms/client-cabinet/service';
import {
  ClientError,
  canMintClient,
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
  /**
   * The minted code on its own, because the code IS the answer (round 107,
   * owner: «yangi client ochganda qanday kod berilganini bilish imkoni
   * yo'qku»). It goes on cartons in Yiwu the same day, so the modal shows it
   * big and copyable rather than folded into a toast line.
   */
  code?: string;
  error?: string;
  /**
   * Codes this phone ALREADY holds. One person carrying 2-4 marking codes is
   * this business's normal shape (777, 555, 444 — round 32 #407), so a second
   * code for the same person is sometimes right and must never be blocked.
   * But the seller cannot see the client book, so without this they mint a
   * sibling code blind, and cargo, calls and the chat then sit on the code
   * nobody is looking at. Named, and the same press again creates it anyway.
   */
  duplicates?: { id: string; code: string; name: string }[];
  /**
   * The deal opened alongside the code. Absent when the funnel refused it —
   * the panel then shows the code without a deal link rather than claiming
   * one exists.
   */
  dealId?: string | null;
}

/**
 * The deal a new client code opens with.
 *
 * The owner's rule (round 111): «klient kod ochilganda avtomatik bitimda shu
 * odam bn bitim ochilsin yangi bolib». Both app doors call it; `createClient`
 * itself deliberately does NOT, for two reasons that would each be a defect:
 * `scripts/import-clients.ts` mints the whole book through the service and
 * would open ~1,700 shells, and `winLead` already opens its own deal after
 * minting a client, so a service-level hook would give every won lead two.
 *
 * AFTER the client is committed and in its own try/catch, never in the same
 * transaction. The code is the thing that goes on the cartons; losing it
 * because the funnel has no open stage would be a far worse trade than a
 * client whose deal has to be raised by hand. The caller renders the link only
 * when an id comes back, so «code minted, deal not» is a state the screen can
 * draw honestly.
 *
 * It lands at the BOTTOM of its column: it carries no price and no goods, and
 * the board draws forty cards per stage.
 */
async function openDealForNewClient(
  clientId: string,
  clientName: string,
  ownerId: string,
  ctx: { actorId: string },
): Promise<string | null> {
  try {
    const { createDeal } = await import('@/modules/wms/deals/service');
    return await createDeal(
      {
        clientId,
        // Named, so the board never draws a bare code. `listDeals` falls back
        // to the title when the deal has no goods line yet (round 79).
        title: clientName,
        ownerId,
      },
      ctx,
      { atBottom: true },
    );
  } catch (err) {
    // A funnel with no open stage, or any other refusal: the client stands,
    // and this is the only place that knows the difference.
    console.error('[client-deal]', err);
    return null;
  }
}

export async function quickCreateClientAction(input: {
  name: string;
  phones: string;
  /** Second press: «yes, this person really does need another code». */
  anyway?: boolean;
}): Promise<QuickClientResult> {
  const name = String(input?.name ?? '').trim();
  const phones = String(input?.phones ?? '').trim();
  if (name.length < 1) return { ok: false, error: 'validation' };

  // `authorize()` takes ONE code and this door answers to two, so it uses the
  // house pair-gate idiom (bitimlar/actions.ts) instead: fetch the actor, then
  // ask the predicate the app bar asked. The screen guard decides what
  // renders; this one decides what happens — a hand-posted call from a browser
  // console meets exactly the same rule.
  const actor = await getActor();
  if (!actor) return { ok: false, error: 'forbidden' };
  if (!canMintClient(actor.permissions)) return { ok: false, error: 'forbidden' };

  // Warn before minting, never block. The lead door has done this since round
  // 79 (`similarLeads`) and the client door — the one that puts a code on a
  // carton — had nothing, which only became urgent when the door opened to
  // people who cannot look the client up first.
  if (!input?.anyway && phones) {
    const seen = await activeClientsByPhone(phones);
    if (seen.length > 0) {
      return {
        ok: false,
        error: 'duplicateCode',
        duplicates: seen.map((one) => ({ id: one.id, code: one.clientCode, name: one.name })),
      };
    }
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
        // Whoever opens the code is its manager — the owner's own answer
        // («kod ochgan odamning ozi unga ozi manager bolib yozilishi kerak»),
        // and the only one that works: round 91 keys every seller's reads on
        // this column, so a client minted without it is invisible to the
        // person who just minted it, and the three cargo notifications
        // (ReceiptConfirmed, ReadyForPickup, BoxIssued) reach NOBODY at all
        // for a client with no manager. This door has no picker to override
        // it; the full form keeps its own.
        salesManagerId: actor.id,
      },
      { actorId: actor.id, ...meta },
    );
    const dealId = await openDealForNewClient(row.id, row.name, actor.id, {
      actorId: actor.id,
      ...meta,
    });
    revalidatePath('/admin/clients');
    revalidatePath('/bitimlar', 'layout');
    return { ok: true, id: row.id, code: row.clientCode, name: row.name, dealId };
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
        // The picker wins where somebody used it; otherwise the person who
        // opened the code is its manager, the same rule the «+» door applies
        // with no picker to ask (round 111, and #637-640's reason: a client
        // with no manager is one nobody is notified about).
        salesManagerId: values.salesManagerId ?? actor.id,
        messengerNote: values.messengerNote ?? undefined,
        notes: values.notes ?? undefined,
      },
      { actorId: actor.id, ...meta },
    );
  } catch (err) {
    if (err instanceof ClientError) return { error: err.code };
    throw err;
  }

  // The same rule as the «+» door, and it must run BEFORE the redirect:
  // `redirect()` throws NEXT_REDIRECT, so anything after it is unreachable —
  // and a try/catch wrapped around it would swallow the redirect itself.
  await openDealForNewClient(row.id, row.name, values.salesManagerId ?? actor.id, {
    actorId: actor.id,
    ...meta,
  });

  revalidatePath('/admin/clients');
  revalidatePath('/bitimlar', 'layout');
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
  try {
    await db.update(clients).set(values).where(eq(clients.id, id));
  } catch (err) {
    // The duplicate check above is a read, so two people renaming two cards
    // onto the same code both pass it and the index refuses the second. That
    // refusal is «this code is taken» — the same sentence the create path
    // gives — and never a white page (#472).
    if (typeof err === 'object' && err !== null && 'code' in err && err.code === '23505') {
      return { error: 'code_exists' };
    }
    throw err;
  }
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
