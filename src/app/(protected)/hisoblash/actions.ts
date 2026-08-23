'use server';

import { revalidatePath } from 'next/cache';
import { authorize, AuthError, getActor } from '@/modules/platform/rbac/authorize';
import { requestMeta } from '@/modules/platform/auth/session';
import { isServerBehind } from '@/modules/platform/db/errors';
import { logger } from '@/modules/platform/logger';
import {
  CalcError,
  finishCalcRequest,
  openCalcRequest,
  releaseCalcRequest,
  returnCalcRequest,
  takeCalcRequest,
  type CalcItemInput,
} from '@/modules/wms/calc/service';
import {
  confirmAllGroups,
  confirmGroup,
  createGroup,
  deleteExtra,
  deleteGroup,
  moveItemToGroup,
  proposeGroups,
  pullBazasFromDictionary,
  recalcFromSealed,
  saveExtra,
  sealCalc,
  setFreightZone,
  setGroupRates,
  setItemBaza,
} from '@/modules/wms/calc/workspace';
import { saveBaza, saveRates, saveTariffBand } from '@/modules/wms/calc/dictionaries';
import { isCalcSection } from '@/modules/wms/calc/labels';
import { canWriteDeal } from '@/modules/wms/deals/service';

export interface CalcFormState {
  ok?: boolean;
  error?: string;
}

/**
 * Every door into the queue.
 *
 * All four VED actions gate on `ved.docs` — the queue's own grant — and every
 * id that arrives on a form is re-derived or re-checked in the service, never
 * trusted: an `assigneeId` is not accepted anywhere at all (the queue decides
 * who calculates), and the section is validated against the bot's own list
 * rather than defaulted, because a control that renders as chosen and posts
 * nothing is the shape #171 keeps finding.
 */
async function run(
  permission: 'ved.docs',
  work: (ctx: { actorId: string } & Record<string, unknown>) => Promise<unknown>,
  revalidate: string,
): Promise<CalcFormState> {
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
  } catch (err) {
    if (err instanceof CalcError) return { error: err.code };
    // Deploy morning: the app can be a release ahead of the migration, and
    // this module's columns landed in 0085 (#472's rule).
    if (isServerBehind(err)) {
      logger.error({ err }, '[calc] server behind — migration 0085 not applied');
      return { error: 'server_behind' };
    }
    throw err;
  }
  revalidatePath(revalidate);
  revalidatePath('/hisoblash');
  return { ok: true };
}

export async function takeCalcAction(id: string, revalidate: string): Promise<CalcFormState> {
  return run('ved.docs', (ctx) => takeCalcRequest(id, ctx), revalidate);
}

export async function releaseCalcAction(id: string, revalidate: string): Promise<CalcFormState> {
  return run('ved.docs', (ctx) => releaseCalcRequest(id, ctx), revalidate);
}

export async function returnCalcAction(
  id: string,
  reason: string,
  revalidate: string,
): Promise<CalcFormState> {
  return run('ved.docs', (ctx) => returnCalcRequest(id, reason, ctx), revalidate);
}

export async function finishCalcAction(
  id: string,
  answer: { amount: number | null; currency: string; note: string },
  revalidate: string,
): Promise<CalcFormState> {
  return run(
    'ved.docs',
    (ctx) =>
      finishCalcRequest(
        id,
        { amount: answer.amount, currency: answer.currency, note: answer.note },
        ctx,
      ),
    revalidate,
  );
}

export interface SubmitCalcInput {
  entityType: 'deal' | 'lead';
  entityId: string;
  section: string;
  fromCity: string;
  toCity: string;
  weightKg: number | null;
  volumeM3: number | null;
  goods: CalcItemInput[];
  noteId: string;
  noteText: string;
  revalidate: string;
}

/**
 * The seller's door — «Hisoblatishga yuborish» on a lead or deal card.
 *
 * Gated as working the card is (`canWriteDeal`), not as the queue is: the
 * people who ask for a price are the people who work cards. A lead is
 * additionally held to the lead card's own rule, so a seller cannot open a
 * request against a colleague's prospect they could not even open.
 *
 * Called with an object rather than a FormData because the files are uploaded
 * separately (a server action's body caps at 1 MB, #291) and the caller keeps
 * its typed values across a refusal (#377).
 */
export async function submitCalcAction(input: SubmitCalcInput): Promise<CalcFormState> {
  const actor = await getActor();
  if (!actor) return { error: 'unauthenticated' };
  if (!canWriteDeal(actor.permissions)) return { error: 'forbidden' };
  if (!isCalcSection(input.section)) return { error: 'bad_section' };
  if (input.entityType !== 'deal' && input.entityType !== 'lead') return { error: 'validation' };
  if (input.entityType === 'lead' && !actor.permissions.has('crm.leads')) {
    return { error: 'forbidden' };
  }
  const meta = await requestMeta();
  try {
    await openCalcRequest(
      {
        entityType: input.entityType,
        entityId: input.entityId,
        section: input.section,
        fromCity: input.fromCity,
        toCity: input.toCity,
        weightKg: input.weightKg,
        volumeM3: input.volumeM3,
        items: input.goods,
        note: input.noteId ? { id: input.noteId, text: input.noteText } : null,
        source: 'card',
      },
      { actorId: actor.id, ...meta },
    );
  } catch (err) {
    if (err instanceof CalcError) return { error: err.code };
    if (isServerBehind(err)) {
      logger.error({ err }, '[calc] server behind — migration 0085 not applied');
      return { error: 'server_behind' };
    }
    throw err;
  }
  revalidatePath(input.revalidate);
  revalidatePath('/hisoblash');
  return { ok: true };
}

// ---------------------------------------------------------------------------
// Phase B — the workspace, the dictionaries and the seal
// ---------------------------------------------------------------------------

/**
 * Every workspace door is `ved.docs` and re-derives what it is given.
 *
 * A group id, an item seq and an extra id all arrive from a form, and every
 * one of them is checked against the REQUEST in the service before it is
 * written — a hand-posted id must not move one customer's cargo into
 * another's calculation. The tariff is the exception in the other direction:
 * it is read here and written only under `admin.dictionaries.manage`, because
 * the VED must not be able to rewrite the list price his own discount is
 * measured against.
 */
const ws = (id: string) => `/hisoblash/${id}`;

export async function setZoneAction(id: string, zone: string): Promise<CalcFormState> {
  return run('ved.docs', (ctx) => setFreightZone(id, zone || null, ctx), ws(id));
}

export async function createGroupAction(id: string, label: string): Promise<CalcFormState> {
  return run('ved.docs', (ctx) => createGroup(id, { label }, ctx), ws(id));
}

export async function deleteGroupAction(id: string, groupId: string): Promise<CalcFormState> {
  return run('ved.docs', (ctx) => deleteGroup(groupId, ctx), ws(id));
}

export async function moveItemAction(
  id: string,
  itemSeq: number,
  groupId: string,
): Promise<CalcFormState> {
  return run('ved.docs', (ctx) => moveItemToGroup(id, itemSeq, groupId || null, ctx), ws(id));
}

export async function setRatesAction(
  id: string,
  groupId: string,
  input: {
    label: string;
    tnvedCode: string;
    dutyPct: number | null;
    vatPct: number | null;
    feeUsd: number | null;
    dutyFree: boolean;
    vatFree: boolean;
  },
): Promise<CalcFormState> {
  return run(
    'ved.docs',
    (ctx) =>
      setGroupRates(
        groupId,
        {
          label: input.label,
          tnvedCode: input.tnvedCode,
          dutyPct: input.dutyPct,
          vatPct: input.vatPct,
          feeUsd: input.feeUsd,
          dutyFree: input.dutyFree,
          vatFree: input.vatFree,
          // A person typed these. The column's CHECK knows only 'dictionary'
          // and 'typed', so a model's estimate has nowhere to land.
          source: 'typed',
        },
        ctx,
      ),
    ws(id),
  );
}

export async function pullRatesAction(
  id: string,
  groupId: string,
  input: { label: string; tnvedCode: string; dutyPct: number; vatPct: number; feeUsd: number },
): Promise<CalcFormState> {
  return run(
    'ved.docs',
    (ctx) =>
      setGroupRates(
        groupId,
        {
          label: input.label,
          tnvedCode: input.tnvedCode,
          dutyPct: input.dutyPct,
          vatPct: input.vatPct,
          feeUsd: input.feeUsd,
          dutyFree: false,
          vatFree: false,
          source: 'dictionary',
        },
        ctx,
      ),
    ws(id),
  );
}

export async function setBazaAction(
  id: string,
  itemSeq: number,
  bazaUsd: number | null,
  basis: 'unit' | 'kg',
): Promise<CalcFormState> {
  return run('ved.docs', (ctx) => setItemBaza(id, itemSeq, { bazaUsd, basis, source: 'typed' }, ctx), ws(id));
}

export async function pullBazasAction(id: string): Promise<CalcFormState> {
  return run('ved.docs', (ctx) => pullBazasFromDictionary(id, ctx), ws(id));
}

export async function confirmGroupAction(id: string, groupId: string): Promise<CalcFormState> {
  return run('ved.docs', (ctx) => confirmGroup(groupId, ctx), ws(id));
}

export async function confirmAllAction(id: string): Promise<CalcFormState> {
  return run('ved.docs', (ctx) => confirmAllGroups(id, ctx), ws(id));
}

export async function saveExtraAction(
  id: string,
  input: { id?: string; costTypeId: string; label: string; amountUsd: number; note: string },
): Promise<CalcFormState> {
  return run(
    'ved.docs',
    (ctx) =>
      saveExtra(
        id,
        {
          id: input.id || undefined,
          costTypeId: input.costTypeId || null,
          label: input.label,
          amountUsd: input.amountUsd,
          note: input.note || null,
        },
        ctx,
      ),
    ws(id),
  );
}

export async function deleteExtraAction(id: string, extraId: string): Promise<CalcFormState> {
  return run('ved.docs', (ctx) => deleteExtra(extraId, ctx), ws(id));
}

export async function sealAction(
  id: string,
  input: {
    discountUsd: number;
    discountReason: string;
    bandOverrideMin: number | null;
    bandOverrideReason: string;
  },
): Promise<CalcFormState> {
  return run(
    'ved.docs',
    (ctx) =>
      sealCalc(
        id,
        {
          discountUsd: input.discountUsd,
          discountReason: input.discountReason.trim() || null,
          bandOverrideMin: input.bandOverrideMin,
          bandOverrideReason: input.bandOverrideReason.trim() || null,
        },
        ctx,
      ),
    ws(id),
  );
}

/**
 * «Qayta hisoblash» — a correction, which is a NEW request.
 *
 * Gated on `admin.settings.manage` (#170, no new permission code): a sealed
 * price is what the client was told, so re-opening the question is the
 * owner's call and not the calculator's. The seller and the VED both see the
 * button's absence rather than a refusal.
 */
export async function recalcAction(id: string): Promise<CalcFormState & { newId?: string }> {
  let who;
  try {
    who = await authorize('admin.settings.manage');
  } catch (err) {
    if (err instanceof AuthError) return { error: 'forbidden' };
    throw err;
  }
  const meta = await requestMeta();
  try {
    const newId = await recalcFromSealed(id, { actorId: who.id, ...meta });
    revalidatePath('/hisoblash');
    revalidatePath(ws(id));
    return { ok: true, newId };
  } catch (err) {
    if (err instanceof CalcError) return { error: err.code };
    if (isServerBehind(err)) return { error: 'server_behind' };
    throw err;
  }
}

export async function saveBazaAction(input: {
  name: string;
  label: string;
  tnvedCode: string;
  bazaUsd: number;
  basis: 'unit' | 'kg';
  effectiveDate: string;
}): Promise<CalcFormState> {
  return run(
    'ved.docs',
    (ctx) =>
      saveBaza(
        {
          name: input.name,
          label: input.label,
          tnvedCode: input.tnvedCode.trim() || null,
          bazaUsd: input.bazaUsd,
          basis: input.basis,
          effectiveDate: input.effectiveDate,
          note: null,
        },
        ctx,
      ),
    '/hisoblash/lugatlar',
  );
}

export async function saveRatesAction(input: {
  tnvedCode: string;
  dutyPct: number;
  vatPct: number;
  feeUsd: number;
  effectiveDate: string;
}): Promise<CalcFormState> {
  return run('ved.docs', (ctx) => saveRates(input, ctx), '/hisoblash/lugatlar');
}

/**
 * The freight tariff is written under `admin.dictionaries.manage` — the
 * cost-types door — and NOT under `ved.docs`.
 *
 * The VED gives the discount, and a discount only means anything against a
 * list price somebody else owns. His own screen shows the tariff read-only.
 */
export async function saveTariffAction(input: {
  zone: string;
  minDensity: number;
  maxDensity: number | null;
  priceUsd: number;
  perKg: boolean;
  effectiveDate: string;
}): Promise<CalcFormState> {
  let who;
  try {
    who = await authorize('admin.dictionaries.manage');
  } catch (err) {
    if (err instanceof AuthError) return { error: 'forbidden' };
    throw err;
  }
  const meta = await requestMeta();
  try {
    await saveTariffBand(input, { actorId: who.id, ...meta });
  } catch (err) {
    if (err instanceof CalcError) return { error: err.code };
    if (isServerBehind(err)) return { error: 'server_behind' };
    throw err;
  }
  revalidatePath('/admin/tarif');
  revalidatePath('/hisoblash/lugatlar');
  return { ok: true };
}

export async function proposeAction(id: string): Promise<CalcFormState> {
  return run('ved.docs', (ctx) => proposeGroups(id, ctx), `/hisoblash/${id}`);
}
