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
  convertLead,
  createLead,
  CrmError,
  deleteStage,
  leadSchema,
  moveLead,
  setLeadOwner,
  reorderStages,
  saveSource,
  saveStage,
  sourceSchema,
  stageSchema,
  updateLead,
} from '@/modules/wms/crm/service';
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

function leadFields(formData: FormData) {
  return leadSchema.safeParse({
    name: str(formData, 'name'),
    phone: str(formData, 'phone'),
    company: str(formData, 'company'),
    sourceId: str(formData, 'sourceId'),
    stageId: str(formData, 'stageId'),
    ownerId: str(formData, 'ownerId'),
    note: str(formData, 'note'),
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

export async function moveLeadAction(
  id: string,
  stageId: string,
  reason: string,
): Promise<CrmFormState> {
  return run('crm.leads', (ctx) => moveLead(id, stageId, reason, ctx));
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
    const client = await convertLead(
      id,
      { clientCode: str(formData, 'clientCode'), name: str(formData, 'clientName') },
      ctx,
    );
    clientId = client.id;
  });
  if (!state.ok) return state;
  redirect(`/admin/clients/${clientId}`);
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

// --- People -----------------------------------------------------------------

export async function groupClientsAction(
  clientIds: string[],
  name: string,
): Promise<CrmFormState> {
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
