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
  deleteExtra,
  deleteItem,
  proposeGroups,
  pullBazasFromDictionary,
  pullRatesFromDictionary,
  recalcFromSealed,
  recordOffer,
  saveExtra,
  saveTable,
  sealCalc,
  setCargoFacts,
  setFreightZone,
  setRequestCertificate,
  setGroupRates,
  type TableItemEdit,
  type TableNewItem,
  type TableSaveResult,
} from '@/modules/wms/calc/workspace';
import { saveBaza, savePriceBook, saveRates, saveTariffBand } from '@/modules/wms/calc/dictionaries';
import { loneWeightKg } from '@/modules/wms/calc/intake';
import { isCalcSection } from '@/modules/wms/calc/labels';
import { canWriteDeal } from '@/modules/wms/deals/service';
import { canReadTg } from '@/modules/wms/crm/conversations';
import { mayApproveBelowFloor, mayOffer } from '@/modules/wms/calc/upsale-scope';

export interface CalcFormState {
  ok?: boolean;
  error?: string;
}

/**
 * The table's answer: a refusal NAMES the row (`seq`) — one bare code over
 * a 100-row save is the owner's «mujmal» complaint rebuilt — and a success
 * carries what the sticky bar announces (freshly minted groups, so a typo'd
 * code surfaces as a surprise one-item group; and how many pre-coded items
 * the sweep placed).
 */
export interface TableFormState {
  ok?: boolean;
  error?: string;
  /** The row the refusal names — NEGATIVE for a ghost (new) row. */
  seq?: number;
  minted?: string[];
  swept?: number;
  added?: number;
  merged?: string[];
  measuresCleared?: number[];
  measuresDropped?: number[];
  basisSuspect?: number[];
  /** Rows the customs import filled — the bar says «📥 N qator». */
  importFilled?: number[];
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
        // The same derivation both read-doors apply: one line means the
        // shipment's weight IS that line's weight, and customs is calculated
        // per line (`loneWeightKg`, the one home for the rule).
        items: input.goods.map((g) => ({
          ...g,
          weightKg: g.weightKg ?? loneWeightKg(input.goods.length, input.weightKg),
        })),
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

/**
 * The cargo facts the VED types when the bot's reading came back empty.
 *
 * Same door as every other workspace write (`ved.docs`); the SERVICE
 * validates, because a number posted from a form is a claim (#531).
 */
export async function setCargoFactsAction(
  id: string,
  input: {
    fromCity: string | null;
    toCity: string | null;
    weightKg: number | null;
    volumeM3: number | null;
  },
): Promise<CalcFormState> {
  return run('ved.docs', (ctx) => setCargoFacts(id, input, ctx), ws(id));
}

export async function setCertificateAction(id: string, has: boolean): Promise<CalcFormState> {
  return run('ved.docs', (ctx) => setRequestCertificate(id, has, ctx), ws(id));
}

/** The table door — `run()`'s gate and catches, plus the row-naming answer. */
async function runTable(
  work: (ctx: { actorId: string } & Record<string, unknown>) => Promise<TableSaveResult>,
  revalidate: string,
): Promise<TableFormState> {
  let who;
  try {
    who = await authorize('ved.docs');
  } catch (err) {
    if (err instanceof AuthError) return { error: 'forbidden' };
    throw err;
  }
  const meta = await requestMeta();
  let result: TableSaveResult;
  try {
    result = await work({ actorId: who.id, ...meta });
  } catch (err) {
    if (err instanceof CalcError) return { error: err.code, seq: err.seq };
    if (isServerBehind(err)) {
      logger.error({ err }, '[calc] server behind — migration 0085 not applied');
      return { error: 'server_behind' };
    }
    throw err;
  }
  revalidatePath(revalidate);
  revalidatePath('/hisoblash');
  return {
    ok: true,
    minted: result.minted,
    swept: result.swept,
    added: result.added,
    merged: result.merged,
    measuresCleared: result.measuresCleared,
    measuresDropped: result.measuresDropped,
    basisSuspect: result.basisSuspect,
    importFilled: result.importFilled,
  };
}

/** ONE door for the whole save — edits AND new rows in one transaction, so a
 * row born with code + baza + measure prices on its first save. */
export async function saveTableAction(
  id: string,
  input: { items: TableItemEdit[]; adds: TableNewItem[] },
): Promise<TableFormState> {
  return runTable((ctx) => saveTable(id, input, ctx), ws(id));
}

export async function deleteItemAction(id: string, itemId: string): Promise<TableFormState> {
  return runTable(async (ctx) => {
    await deleteItem(id, itemId, ctx);
    return {
      minted: [],
      swept: 0,
      added: 0,
      merged: [],
      measuresCleared: [],
      measuresDropped: [],
      basisSuspect: [],
      importFilled: [],
    };
  }, ws(id));
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

/**
 * «Take the rates from the dictionary» reads the dictionary HERE.
 *
 * It used to accept duty/vat/fee from the browser and stamp them
 * `source: 'dictionary'` — so a hand-posted call could write any rate at all
 * and label it as the dictionary's word, which is precisely the provenance
 * `rate_source` exists to record. The browser now sends only which group; the
 * numbers come from the same reader the screen displayed.
 */
export async function pullRatesAction(id: string, groupId: string): Promise<CalcFormState> {
  return run('ved.docs', (ctx) => pullRatesFromDictionary(groupId, ctx), ws(id));
}

export async function pullBazasAction(
  id: string,
): Promise<CalcFormState & { filled?: number; skipped?: number }> {
  let counts: { filled: number; skipped: number } = { filled: 0, skipped: 0 };
  const state = await run(
    'ved.docs',
    async (ctx) => {
      counts = await pullBazasFromDictionary(id, ctx);
    },
    ws(id),
  );
  // A skipped hit is not an error — the dictionary's basis is one this row
  // cannot measure — but the person must hear the count, not a silence.
  return state.ok ? { ...state, ...counts } : state;
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
  basis: 'unit' | 'kg' | 'juft' | 'litr' | 'm2';
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
  /** 'correction' when the workspace's «lug'atga yozish» taught it (law 6). */
  source?: 'manual' | 'correction';
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

// ---------------------------------------------------------------------------
// Phase C — the offer and the price book
// ---------------------------------------------------------------------------

export interface OfferFormState extends CalcFormState {
  /** The recorded offer's id — what the PDF link is keyed on (phase 4). */
  id?: string;
  text?: string | null;
  pending?: boolean;
  belowFloor?: boolean;
  delivered?: boolean;
}

/**
 * «Mijozga taklif» — the SELLER's door, not the queue's.
 *
 * Gated exactly as `submitCalcAction` is: the people who quote customers are
 * the people who work cards, so `ved.docs` would be the wrong grant here (a
 * calculator does not talk to the client, and every seller would be locked
 * out of their own offer). The card is named by the caller so the lead branch
 * can be held to the lead card's own rule, and the service then proves the
 * sealed version really belongs to that card.
 */
export async function makeOfferAction(
  // Phase 4: the offer stands on a sealed version OR a Готово answer — the
  // form posts whichever anchor the panel rendered, and `recordOffer`
  // re-derives every admission server-side.
  anchor: { versionId: string } | { requestId: string },
  input: {
    clientPriceUsd: number;
    locale: 'uz' | 'ru' | 'en';
    clientName: string | null;
    belowFloorReason?: string;
    entityType: 'deal' | 'lead';
    entityId: string;
    revalidate: string;
  },
): Promise<OfferFormState> {
  const actor = await getActor();
  if (!actor) return { error: 'unauthenticated' };
  if (!canWriteDeal(actor.permissions)) return { error: 'forbidden' };
  // Law 4: the client price is the SELLER's to enter. This comment's own
  // sibling in `makeOfferAction`'s doc says a calculator does not talk to the
  // customer, and `canWriteDeal` carries `ved.docs`, so it had to be said in
  // code as well as in prose.
  if (!mayOffer(actor)) return { error: 'forbidden' };
  if (input.entityType !== 'deal' && input.entityType !== 'lead') return { error: 'validation' };
  if (input.entityType === 'lead' && !actor.permissions.has('crm.leads')) {
    return { error: 'forbidden' };
  }
  if (input.locale !== 'uz' && input.locale !== 'ru' && input.locale !== 'en') {
    return { error: 'validation' };
  }
  const meta = await requestMeta();
  try {
    const res = await recordOffer(
      anchor,
      {
        clientPriceUsd: input.clientPriceUsd,
        locale: input.locale,
        clientName: input.clientName,
        belowFloorReason: input.belowFloorReason,
        // Law 4: below-floor is admin-only. Asked HERE, where the permission
        // set lives, and handed down — the services take an actor id and
        // never a permission set.
        mayApprove: mayApproveBelowFloor(actor),
        expect: { entityType: input.entityType, entityId: input.entityId },
      },
      { actorId: actor.id, ...meta },
    );
    revalidatePath(input.revalidate);
    return {
      ok: true,
      id: res.id,
      text: res.text,
      belowFloor: res.belowFloor,
      delivered: res.delivered,
      pending: res.pending,
    };
  } catch (err) {
    if (err instanceof CalcError) return { error: err.code };
    // 0087 is this release's migration, and the offer ledger is its table.
    if (isServerBehind(err)) {
      logger.error({ err }, '[calc] server behind — migration 0087 not applied');
      return { error: 'server_behind' };
    }
    throw err;
  }
}

/**
 * The price book is a DICTIONARY, so it is written where the other three are.
 *
 * `ved.docs` and not `admin.dictionaries.manage`: this is the VED's own memory
 * of what a code was quoted at, the same hand that types a baza. The freight
 * tariff stays the exception — a discount only means something against a list
 * price its giver cannot move.
 */
export async function savePriceBookAction(input: {
  tnvedCode: string;
  label: string;
  priceUsd: number;
  unit: 'm3' | 'kg';
  effectiveDate: string;
}): Promise<CalcFormState> {
  return run('ved.docs', (ctx) => savePriceBook(input, ctx), '/hisoblash/lugatlar');
}

/**
 * The THIRD door — «Hisoblatishga yuborish» from a CRM Telegram thread
 * (owner, 2026-08-25). Same write gate as `submitCalcAction` — working the
 * card is the power that asks for a price — PLUS the tg read fence, because
 * the material is a conversation and `threadMaterial` re-loads it under the
 * viewer's own scope. Two steps: the first press reads, the second lands;
 * the material is rebuilt server-side on BOTH.
 */
function threadCalcGate(
  actor: NonNullable<Awaited<ReturnType<typeof getActor>>>,
  entity: import('@/modules/wms/calc/from-thread').ThreadCalcEntity,
  section: string,
): CalcFormState | null {
  if (!canReadTg(actor)) return { error: 'forbidden' };
  if (!canWriteDeal(actor.permissions)) return { error: 'forbidden' };
  if (!isCalcSection(section)) return { error: 'bad_section' };
  if (entity.kind === 'lead' && !actor.permissions.has('crm.leads')) return { error: 'forbidden' };
  return null;
}

export async function threadCalcAnalyzeAction(input: {
  entity: import('@/modules/wms/calc/from-thread').ThreadCalcEntity;
  section: import('@/modules/wms/calc/intake').CalcSection;
  messageIds: string[];
}): Promise<CalcFormState & { preview?: import('@/modules/wms/calc/from-thread').ThreadCalcPreview }> {
  const actor = await getActor();
  if (!actor) return { error: 'unauthenticated' };
  const refused = threadCalcGate(actor, input.entity, input.section);
  if (refused) return refused;
  try {
    const { threadCalcAnalyze } = await import('@/modules/wms/calc/from-thread');
    const preview = await threadCalcAnalyze(actor, input);
    return { ok: true, preview };
  } catch (err) {
    if (err instanceof CalcError) return { error: err.code };
    if (isServerBehind(err)) return { error: 'server_behind' };
    throw err;
  }
}

export async function threadCalcSendAction(input: {
  entity: import('@/modules/wms/calc/from-thread').ThreadCalcEntity;
  section: import('@/modules/wms/calc/intake').CalcSection;
  messageIds: string[];
  noteId: string;
  facts?: import('@/modules/wms/calc/intake').CalcFacts | null;
  steps?: string[] | null;
}): Promise<CalcFormState & { landed?: { kind: 'deal' | 'lead'; id: string } }> {
  const actor = await getActor();
  if (!actor) return { error: 'unauthenticated' };
  const refused = threadCalcGate(actor, input.entity, input.section);
  if (refused) return refused;
  const meta = await requestMeta();
  try {
    const { threadCalcSend } = await import('@/modules/wms/calc/from-thread');
    const landed = await threadCalcSend(actor, input, { actorId: actor.id, ...meta });
    revalidatePath('/hisoblash');
    return { ok: true, landed: { kind: landed.kind, id: landed.id } };
  } catch (err) {
    if (err instanceof CalcError) return { error: err.code };
    if (isServerBehind(err)) return { error: 'server_behind' };
    throw err;
  }
}
