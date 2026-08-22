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
