'use server';

import { revalidatePath } from 'next/cache';
import { redirect } from 'next/navigation';
import { AuthError, authorize, getActor } from '@/modules/platform/rbac/authorize';
import { requestMeta } from '@/modules/platform/auth/session';
import { JOB_PROCESS_EVENTS, enqueue } from '@/modules/platform/jobs/boss';
import { ClientError } from '@/modules/platform/clients/service';
import {
  activitySchema,
  addActivity,
  createLead,
  similarLeads,
  CrmError,
  deleteStage,
  FollowUpError,
  leadSchema,
  moveLead,
  setFollowUp,
  setLeadOwner,
  reorderStages,
  saveLostReason,
  saveSource,
  saveStage,
  sourceSchema,
  stageSchema,
  updateLead,
  winLead,
  type WinLeadResult,
} from '@/modules/wms/crm/service';
import { db } from '@/modules/platform/db/client';
import { clients } from '@/modules/platform/db/schema';
import { sql } from 'drizzle-orm';
import { setFieldValues, validateValues } from '@/modules/platform/fields/service';
import { customValues } from '@/modules/platform/fields/actions';
import { FieldError } from '@/modules/platform/fields/types';
import { attachClient, groupClients, personFromClient } from '@/modules/wms/crm/people';
import { announceMentions } from '@/modules/wms/crm/internal-chat';

export interface CrmFormState {
  ok?: boolean;
  error?: string;
}

/**
 * What a bulk press did, row by row.
 *
 * A count rather than a bare ok: twenty cards can include one that has moved
 * on since the board was drawn, and «19 ta ko'chdi, 1 tasi bo'lmadi» is the
 * truth. A single `error` on the whole batch would either hide the nineteen
 * that worked or claim a failure that did not happen.
 */
export interface BulkState {
  ok?: boolean;
  done?: number;
  failed?: number;
  /** The first refusal's code — they are almost always the same one. */
  error?: string;
}

type Permission = 'crm.leads' | 'crm.manage';

async function run(
  permission: Permission,
  work: (ctx: { actorId: string } & Record<string, unknown>) => Promise<unknown>,
): Promise<CrmFormState> {
  let who;
  try {
    who = await authorize(permission);
  } catch (err) {
    if (err instanceof AuthError) return { error: 'forbidden' };
    throw err;
  }
  const meta = await requestMeta();
  try {
    await work({ actorId: who.id, ...meta });
    // A stage move is an event now (phase 7); the per-minute sweep would get
    // there, but a rule that opens a task a minute after the drag feels
    // broken — kick the worker. Fire-and-forget: automation lateness must
    // never fail the user's save.
    enqueue(JOB_PROCESS_EVENTS, {}).catch(() => {});
    revalidatePath('/crm', 'layout');
    return { ok: true };
  } catch (err) {
    // Every service error carries a code the screen can translate; anything
    // else is a real fault and must not be swallowed into a red label.
    if (err instanceof CrmError || err instanceof ClientError) return { error: err.code };
    // A custom field the owner marked required, or a rule it broke, is a
    // message for the person filling the form — not a crash.
    if (err instanceof FieldError) return { error: err.code };
    throw err;
  }
}

const str = (formData: FormData, name: string) => String(formData.get(name) ?? '');

/** Numbers arrive from a form as strings; an empty box means "not answered". */
function optionalNumber(value: FormDataEntryValue | null): number | null | undefined {
  if (value === null) return undefined;
  const text = String(value).trim().replace(',', '.');
  if (!text) return null;
  const parsed = Number(text);
  return Number.isFinite(parsed) ? parsed : null;
}

function leadFields(formData: FormData) {
  return leadSchema.safeParse({
    name: str(formData, 'name'),
    phone: str(formData, 'phone'),
    company: str(formData, 'company'),
    sourceId: str(formData, 'sourceId'),
    stageId: str(formData, 'stageId'),
    ownerId: str(formData, 'ownerId'),
    note: str(formData, 'note'),
    quotedAmount: optionalNumber(formData.get('quotedAmount')),
    quotedCurrency: formData.get('quotedCurrency') ? str(formData, 'quotedCurrency') : null,
    quotedVolumeM3: optionalNumber(formData.get('quotedVolumeM3')),
    quotedWeightKg: optionalNumber(formData.get('quotedWeightKg')),
    nextActionAt: str(formData, 'nextActionAt'),
    nextActionNote: str(formData, 'nextActionNote'),
  });
}

export async function createLeadAction(
  _prev: CrmFormState,
  formData: FormData,
): Promise<CrmFormState> {
  const parsed = leadFields(formData);
  if (!parsed.success) return { error: 'validation' };
  let leadId = '';
  const custom = await customValues(formData);
  const state = await run('crm.leads', async (ctx) => {
    // Checked BEFORE the lead exists. The two writes are not one transaction,
    // so a value the rules reject used to leave a saved lead behind an error
    // message that read as if nothing had been created.
    await validateValues('lead', custom);
    const lead = await createLead(parsed.data, ctx);
    leadId = lead.id;
    await setFieldValues('lead', lead.id, custom, ctx);
  });
  if (!state.ok) return state;
  // Land on the card: the next thing anyone does is log the first call.
  redirect(`/crm/leads/${leadId}`);
}

/**
 * The five-second lead: a name, maybe a phone, nothing else.
 *
 * A separate action rather than a flag on `createLeadAction`, for a reason
 * that is about the framework and not about taste: that one ends in
 * `redirect()`, and a `redirect()` inside a server action called from an
 * onClick REJECTS the promise with NEXT_REDIRECT instead of resolving — an
 * async click handler has no error boundary to catch it. A modal has to be
 * told what happened, so this returns it (the `CrateActionResult` shape).
 *
 * Everything it leaves out is already defaulted by the service: the stage
 * falls back to the first one, the owner to whoever pressed the button. The
 * card is where the rest of a lead gets filled in — including any custom
 * field the owner made required, which this deliberately does not ask for.
 */
export interface QuickCreateResult {
  ok: boolean;
  id?: string;
  name?: string;
  error?: string;
  /** Open leads that look like this one — a warning, never a refusal. */
  duplicates?: { id: string; name: string; phone: string | null; ownerName: string | null }[];
}

export async function quickCreateLeadAction(input: {
  name: string;
  phone: string;
  /** Second press: the person has read the warning and means it. */
  anyway?: boolean;
}): Promise<QuickCreateResult> {
  const name = String(input?.name ?? '').trim();
  const phone = String(input?.phone ?? '').trim();
  if (name.length < 2) return { ok: false, error: 'validation' };

  // Asked BEFORE the write and answered with names, so the seller can open the
  // card and see whose enquiry it already is. Never a block: the second press
  // creates it. Two people ringing one customer about one shipment is the
  // harm; a deliberate second lead is a legitimate record.
  if (!input?.anyway) {
    const duplicates = await similarLeads({ phone, name });
    if (duplicates.length > 0) return { ok: false, error: 'duplicate', duplicates };
  }

  let created: { id: string; name: string } | null = null;
  const state = await run('crm.leads', async (ctx) => {
    const lead = await createLead({ name, phone }, ctx);
    created = { id: lead.id, name: lead.name };
  });
  if (!state.ok) return { ok: false, error: state.error ?? 'failed' };
  return { ok: true, id: created!.id, name: created!.name };
}

export async function updateLeadAction(
  id: string,
  _prev: CrmFormState,
  formData: FormData,
): Promise<CrmFormState> {
  const parsed = leadFields(formData);
  if (!parsed.success) return { error: 'validation' };
  const custom = await customValues(formData);
  return run('crm.leads', async (ctx) => {
    await updateLead(id, parsed.data, ctx);
    await setFieldValues('lead', id, custom, ctx);
  });
}

/**
 * `beforeId` is the DRAG saying where the card landed: the id of the card it
 * must sit directly above, or `null` for the end of the column (round 96).
 * `undefined` — every other door — means «say nothing about position», and
 * the service puts the card at the top of wherever it arrived.
 */
/**
 * «Bajarildi» / «Ertaga» on a day-screen call row.
 *
 * Its own action rather than `run()`: the day screen is not `/crm`, so the
 * revalidate target differs, and the service needs to know whether this
 * person may act on somebody else's row (`crm.leads.view_all`, the same grant
 * that decides whose calls they were shown in the first place).
 */
export async function setFollowUpAction(
  kind: 'lead' | 'client',
  id: string,
  until: string | null,
): Promise<CrmFormState> {
  let who;
  try {
    who = await authorize('crm.leads');
  } catch (err) {
    if (err instanceof AuthError) return { error: 'forbidden' };
    throw err;
  }
  const meta = await requestMeta();
  try {
    await setFollowUp(kind, id, until, {
      actorId: who.id,
      ...meta,
      viewAll: who.permissions.has('crm.leads.view_all'),
    });
  } catch (err) {
    if (err instanceof FollowUpError) return { error: err.code };
    throw err;
  }
  revalidatePath('/bugun');
  revalidatePath('/crm', 'layout');
  return { ok: true };
}

export async function moveLeadAction(
  id: string,
  stageId: string,
  reason: string,
  beforeId?: string | null,
): Promise<CrmFormState> {
  return run('crm.leads', (ctx) =>
    moveLead(id, stageId, reason, ctx, beforeId === undefined ? undefined : { beforeId }),
  );
}

/**
 * Move several leads at once.
 *
 * ONE `run()` around the loop, not one per id: that means one permission
 * check, one revalidate and one kick of the rules worker, instead of twenty
 * of each. What is NOT batched is the write — every lead goes through
 * `moveLead`, because that is the only path that writes the audit row and
 * emits `LeadStageChanged`, which the phase-7 rules listen to. A bare
 * `UPDATE ... WHERE id IN (...)` would be a silent third stage-write path,
 * exactly the shape round 18 closed.
 */
export async function bulkMoveLeadsAction(
  ids: string[],
  stageId: string,
  reason: string,
): Promise<BulkState> {
  return runBulk('crm.leads', ids, (id, ctx) => moveLead(id, stageId, reason, ctx));
}

/** Hand several leads to one person. */
export async function bulkAssignLeadsAction(ids: string[], ownerId: string): Promise<BulkState> {
  return runBulk('crm.leads', ids, (id, ctx) => setLeadOwner(id, ownerId || null, ctx));
}

async function runBulk(
  permission: Permission,
  ids: string[],
  work: (id: string, ctx: { actorId: string } & Record<string, unknown>) => Promise<unknown>,
): Promise<BulkState> {
  if (ids.length === 0) return { ok: true, done: 0, failed: 0 };
  let done = 0;
  let failed = 0;
  let error: string | undefined;
  const outcome = await run(permission, async (ctx) => {
    for (const id of ids) {
      try {
        await work(id, ctx);
        done += 1;
      } catch (err) {
        // One row's refusal must not abandon the other nineteen — a bulk
        // press that stops halfway leaves the board disagreeing with the
        // database and nobody able to tell where it stopped.
        failed += 1;
        if (!error && (err instanceof CrmError || err instanceof ClientError)) error = err.code;
        if (!error) error = 'failed';
      }
    }
  });
  if (outcome.error) return { error: outcome.error };
  return { ok: failed === 0, done, failed, ...(error ? { error } : {}) };
}

export async function convertLeadAction(
  id: string,
  _prev: CrmFormState,
  formData: FormData,
): Promise<CrmFormState> {
  let clientId = '';
  const state = await run('crm.leads', async (ctx) => {
    // Round 107: converting IS winning now — the same landing as the board's
    // dialog, so this door also opens the deal the owner's rule demands.
    const won = await winLead(
      id,
      { clientCode: str(formData, 'clientCode'), name: str(formData, 'clientName') },
      ctx,
    );
    clientId = won.clientId;
  });
  if (!state.ok) return state;
  redirect(`/admin/clients/${clientId}`);
}

export interface WinLeadState {
  ok?: boolean;
  error?: string;
  result?: WinLeadResult;
}

/**
 * The won dialog's confirm (round 107). Its OWN action on purpose: wiring a
 * `viaConvert` flag through `moveLeadAction` would let any hand-crafted POST
 * skip the mandatory convert — a public action's arguments are the caller's
 * to invent (#514's rule, one layer down).
 */
export async function winLeadAction(
  id: string,
  input: { stageId?: string; attachCode?: string; clientCode?: string; name?: string },
): Promise<WinLeadState> {
  let result: WinLeadResult | undefined;
  const state = await run('crm.leads', async (ctx) => {
    result = await winLead(
      id,
      {
        stageId: String(input?.stageId ?? '') || undefined,
        attachCode: String(input?.attachCode ?? '') || undefined,
        clientCode: String(input?.clientCode ?? '') || undefined,
        name: String(input?.name ?? '') || undefined,
      },
      ctx,
    );
  });
  if (!state.ok) return state;
  return { ok: true, result };
}

/**
 * «GS777 — kim u?» for the dialog's attach step: the typed code is echoed
 * back as a NAME so a typo'd but existing code is caught by the person, not
 * by the customer whose chat it would re-key. Within precedent: the deal form
 * already prints the whole client book to the same permission.
 */
export async function resolveClientCodeAction(
  code: string,
): Promise<{ ok?: boolean; error?: string; name?: string; clientCode?: string }> {
  try {
    await authorize('crm.leads');
  } catch (err) {
    if (err instanceof AuthError) return { error: 'forbidden' };
    throw err;
  }
  const clean = String(code ?? '').trim().toUpperCase();
  if (!clean) return { error: 'client_not_found' };
  const row = await db.query.clients.findFirst({
    where: sql`upper(${clients.clientCode}) = ${clean}`,
  });
  if (!row) return { error: 'client_not_found' };
  if (!row.active) return { error: 'client_inactive' };
  return { ok: true, name: row.name, clientCode: row.clientCode };
}

export async function addActivityAction(
  _prev: CrmFormState,
  formData: FormData,
): Promise<CrmFormState> {
  const parsed = activitySchema.safeParse({
    entityType: str(formData, 'entityType'),
    entityId: str(formData, 'entityId'),
    kind: str(formData, 'kind'),
    note: str(formData, 'note'),
    happenedAt: str(formData, 'happenedAt'),
    nextActionAt: str(formData, 'nextActionAt'),
    nextActionNote: str(formData, 'nextActionNote'),
  });
  if (!parsed.success) return { error: 'validation' };
  const state = await run('crm.leads', (ctx) => addActivity(parsed.data, ctx));
  // The contact log broadcasts to nobody (a record, not a conversation) —
  // but a colleague NAMED in it must still hear their name. After the save
  // and never blocking it, like every announce here.
  if (state.ok) {
    const who = await getActor();
    if (who) {
      await announceMentions({
        entityType: parsed.data.entityType as 'client' | 'lead' | 'deal',
        entityId: parsed.data.entityId,
        note: parsed.data.note,
        authorId: who.id,
      }).catch(() => {});
    }
  }
  // The client card lives outside /crm, so it needs its own refresh.
  if (parsed.data.entityType === 'client') revalidatePath(`/admin/clients/${parsed.data.entityId}`);
  return state;
}

// --- Settings (crm.manage) --------------------------------------------------

export async function saveStageAction(
  _prev: CrmFormState,
  formData: FormData,
): Promise<CrmFormState> {
  const parsed = stageSchema.safeParse({
    name: str(formData, 'name'),
    kind: str(formData, 'kind') || 'open',
    color: str(formData, 'color') || 'gray',
    sortOrder: Number(formData.get('sortOrder')) || 100,
    active: formData.getAll('active').at(-1) !== 'off',
  });
  if (!parsed.success) return { error: 'validation' };
  const id = str(formData, 'id') || undefined;
  return run('crm.manage', (ctx) => saveStage({ ...parsed.data, id }, ctx));
}

export async function deleteStageAction(id: string, moveToId: string): Promise<CrmFormState> {
  return run('crm.manage', (ctx) => deleteStage(id, moveToId, ctx));
}

export async function reorderStagesAction(ids: string[]): Promise<CrmFormState> {
  return run('crm.manage', (ctx) => reorderStages(ids, ctx));
}

export async function saveSourceAction(
  _prev: CrmFormState,
  formData: FormData,
): Promise<CrmFormState> {
  const parsed = sourceSchema.safeParse({
    name: str(formData, 'name'),
    sortOrder: Number(formData.get('sortOrder')) || 100,
    active: formData.getAll('active').at(-1) !== 'off',
  });
  if (!parsed.success) return { error: 'validation' };
  const id = str(formData, 'id') || undefined;
  return run('crm.manage', (ctx) => saveSource({ ...parsed.data, id }, ctx));
}

/**
 * The lost-reason dictionary (round 98). Same door as the sources — a list
 * the owner edits, `crm.manage`, and deactivating is the only removal: the
 * recorded text on old cards outlives the row that offered it.
 */
export async function saveLostReasonAction(
  _prev: CrmFormState,
  formData: FormData,
): Promise<CrmFormState> {
  const label = str(formData, 'label');
  if (label.trim().length < 2) return { error: 'validation' };
  const id = str(formData, 'id') || undefined;
  return run('crm.manage', (ctx) =>
    saveLostReason(
      {
        id,
        label,
        sortOrder: Number(formData.get('sortOrder')) || 100,
        active: formData.getAll('active').at(-1) !== 'off',
      },
      ctx,
    ),
  );
}

/**
 * Which stage a request for a price lands on (round 83).
 *
 * A SETTING rather than a column — it names one stage — and gated on
 * `crm.manage` like the funnel it points into. An empty value is a real
 * answer: «leave the card where it is».
 */
export async function setCalcStageAction(
  _prev: CrmFormState,
  formData: FormData,
): Promise<CrmFormState> {
  const stageId = str(formData, 'stageId');
  const board = str(formData, 'board') === 'deal' ? 'deal' : 'lead';
  return run('crm.manage', async (ctx) => {
    const { setSetting } = await import('@/modules/platform/settings/service');
    await setSetting(board === 'deal' ? 'deal_calc_stage' : 'crm_calc_stage', stageId, ctx.actorId);
  });
}

// --- People -----------------------------------------------------------------

export async function groupClientsAction(clientIds: string[], name: string): Promise<CrmFormState> {
  return run('crm.manage', (ctx) => groupClients(clientIds, { name }, ctx));
}

export async function personFromClientAction(clientId: string): Promise<CrmFormState> {
  const state = await run('crm.manage', (ctx) => personFromClient(clientId, ctx));
  revalidatePath(`/admin/clients/${clientId}`);
  return state;
}

export async function attachClientAction(
  clientId: string,
  personId: string | null,
): Promise<CrmFormState> {
  const state = await run('crm.manage', (ctx) => attachClient(clientId, personId, ctx));
  revalidatePath(`/admin/clients/${clientId}`);
  return state;
}
