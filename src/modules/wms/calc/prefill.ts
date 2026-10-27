import { and, eq, isNotNull } from 'drizzle-orm';
import { db } from '../../platform/db/client';
import { calcGroups, calcRequests, clients, deals, leads } from '../../platform/db/schema';
import { userPermissions } from '../../platform/rbac/authorize';
import { aiConfigured } from '../../platform/ai/model';
import { aiCalcBudgetLeft } from './ai-cost';
import { logger } from '../../platform/logger';
import type { AuditContext } from '../../platform/audit/service';
import {
  itemMeasure,
  sectionParts,
  type BazaBasis,
  type CalcSectionName,
  type FeeRefusal,
  type PricedItem,
} from './pricing';
import { basisLabel } from './basis';
import { loadWorkspace, proposeGroups, saveTable, type Workspace } from './workspace';
import { aiVedReplyText, type AiVedEstimate, type AiVedFreight, type AiVedLine, type AiVedLineEstimate } from './ai-reply';
import { calcJobHrefFor } from './card-door';
import { dutyText } from './duty-text';
import { blockerText, feeRefusalText, tariffReplyText } from './prefill-reply';
import { pickImportRows, type PickOutcome, type PickRequest } from './prefill-ai';
import { freightAnswerFor } from './freight-answer';
import { applyMemory, pickBazas } from './prefill-steps';
import {
  TAXMINIY_BLOCK_WORDS,
  estimateCustoms,
  estimateInputOf,
  missWords,
  type CustomsEstimate,
  type GroupEstimate,
  type RowMedian,
} from './estimate';
import { rowMediansFor } from './estimate-read';
import { tariffFor } from './tariff-read';
import { onDate } from './dictionaries';
import { weightFromTotalNote } from './intake';
import { CalcError } from './service';

/**
 * The AI VED hodimi (docs/VED-IMPORT-AI.md §3).
 *
 * The owner's ask: «AI Ved hodimi … malumotlar berilganda hamma malumotlarni
 * toliq qilib olib hsoblab beradgan bolsin». A job the bot has just landed
 * is picked up by the machine and carried as far as it honestly can — codes
 * from the model, rates from PP-3818, bazas from the customs file — and then
 * it STOPS. The request stays in the VED's queue, every group is
 * unconfirmed (which is a seal blocker), and the official price is still
 * the seal or the typed «Готово». Nothing here can price a customer.
 *
 * Every write goes through a door that already exists — `proposeGroups` and
 * `saveTable` — so the rev clock, the sweep, the measure pass, the audit row
 * and 0094's import fill all happen exactly as they do when a person works
 * the screen. There is no second writer.
 *
 * Round 2 (docs/SAKKIZ-R2.md §6) adds what the reply SAYS and nothing it
 * writes: the 📊 medians behind «Taxminiy» (his 2.1 b, 2.2 b), the road on a
 * guessed zone and a summed cube (2.6 b, 2.7 b), and a yolkira job answered
 * from the tariff at once (2.5 b). The estimate and the guess are never
 * stored — `estimate-wire.test.ts` fences both.
 *
 * The model is INJECTABLE at both points, which is how any of this is
 * provable in a container with no key.
 */

/**
 * The whole pass's wall clock (§6.7). Past it the pick is skipped and the
 * median read issues nothing — both said in words — and a step already
 * running is never interrupted; the job's pg-boss expiry (`PASS_EXPIRE_S`)
 * sits above this plus one worst step, so the queue never re-delivers a pass
 * that is still running beside itself.
 */
export const PASS_DEADLINE_MS = 10 * 60_000;

/**
 * May the machine still touch this request?
 *
 * The pass moved to pg-boss so a deploy could not lose it, and that opened a
 * wider hole than it closed: the job no longer runs seconds after the seller
 * presses ✅, it runs whenever the queue drains, and `enqueue` re-delivers it
 * up to five times. Meanwhile `applyProposal` DELETES every group and
 * re-inserts them, and `saveTable`'s import fill ends by clearing the
 * confirmations of every group it touched. So a late or re-delivered job
 * could destroy an evening of a VED's typing — rates, bazas, a certificate
 * flag — and silently un-tick the ✅ that phase E1 exists to record.
 *
 * The rev clock answers it exactly. The job carries the revision the request
 * stood at when it was queued; if anything has moved it since, a person has
 * been here and the machine stands down. A confirmed group or a closed
 * request is the same answer said louder.
 *
 * COST, stated: a pass killed half-way is not retried, because its own first
 * half has already moved the clock. That is the safer half of the trade —
 * the request is in the VED's queue either way, and re-running
 * `applyProposal` over work somebody has since done is the loss this guard
 * exists to prevent. The refusal is logged, never silent.
 */
export type PrefillStand = 'ok' | 'touched' | 'confirmed' | 'closed' | 'not_found';

export async function prefillStanding(
  requestId: string,
  expectRev: number | null,
): Promise<PrefillStand> {
  const [request] = await db
    .select({ rev: calcRequests.rev, completedAt: calcRequests.completedAt })
    .from(calcRequests)
    .where(eq(calcRequests.id, requestId));
  if (!request) return 'not_found';
  if (request.completedAt) return 'closed';
  if (expectRev !== null && request.rev !== expectRev) return 'touched';
  const [confirmed] = await db
    .select({ id: calcGroups.id })
    .from(calcGroups)
    .where(and(eq(calcGroups.requestId, requestId), isNotNull(calcGroups.confirmedAt)))
    .limit(1);
  return confirmed ? 'confirmed' : 'ok';
}

/** The revision to quote back when the pass finally runs. */
export async function prefillTicket(requestId: string): Promise<number | null> {
  const [row] = await db
    .select({ rev: calcRequests.rev })
    .from(calcRequests)
    .where(eq(calcRequests.id, requestId));
  return row?.rev ?? null;
}

export interface PrefillDeps {
  /** The grouping pass. Default: `proposeGroups` (the ✨ button's own door). */
  propose?: typeof proposeGroups;
  /** The baza pick. Default: `pickImportRows`. Null answers = not available;
   * the usage rides beside them (`PickOutcome`, K5) and is null when the
   * model never answered. */
  pick?: (rows: PickRequest[]) => Promise<PickOutcome>;
  /** Overridable so a test can run without a customs import in the database. */
  configured?: boolean;
  /**
   * Who READS `text` — the person the job's worker sends it to. The link is
   * chosen for them (`calcJobHrefFor`); absent, the reply carries none.
   */
  replyTo?: string;
  /** The pass's deadline (epoch ms) — `start + PASS_DEADLINE_MS` unless a
   * test hands one in already spent. */
  deadline?: number;
}

export interface PrefillOutcome {
  /** The message for the chat that asked — its link chosen for `replyTo`. */
  text: string;
  /**
   * The same reply with NO link, for the card's lenta: a `/hisoblash` link
   * there bounces the seller reading it, and a card link points at the page
   * the reader is already on. When the reply carries an estimate, the VED's
   * own «🔎 VED uchun:» line stands under its heading (§2.6).
   */
  lentaText: string;
  /** The workspace's EXACT customs total — never the estimate. */
  customsUsd: number | null;
  freightUsd: number | null;
  /** The chat's «Taxminiy» (his 2.2 b) — for the log of THIS pass, and read
   * nowhere else: no default, hint, seal or post may take it (§3). */
  taxminiyUsd: number | null;
  codesStamped: number;
  ratesPulled: number;
  importFilled: number;
  /** How many bazas the model chose a declaration for. */
  picked: number;
  /** Codes the SEALED memory supplied before the model was asked anything. */
  memoryCoded: number;
  /** Bazas a sealed calculation of ours answered (0096) — every save of the
   * pass counted (steps 0, 1 and 2), not only step 0's. */
  memoryFilled: number;
  /** Bazas the `calc_bazas` book answered — round 2's fill. */
  dictionaryFilled: number;
  aiUsed: boolean;
  /** The deadline passed before the pick or the median read — said in words. */
  pastDeadline: boolean;
  /**
   * Non-null: the pass stood down BEFORE writing anything, and the texts are
   * empty — the job's section moved since it was queued (§6.8). The worker
   * says the stand-down sentence instead of a reply.
   */
  stood: 'touched' | null;
}

const NOTHING_DONE = {
  customsUsd: null,
  freightUsd: null,
  taxminiyUsd: null,
  codesStamped: 0,
  ratesPulled: 0,
  importFilled: 0,
  picked: 0,
  memoryCoded: 0,
  memoryFilled: 0,
  dictionaryFilled: 0,
  aiUsed: false,
  pastDeadline: false,
  stood: null,
} satisfies Omit<PrefillOutcome, 'text' | 'lentaText'>;

/** A save refused because a person saved in between (K14's compare-and-set). */
const isOvertaken = (err: unknown) => err instanceof CalcError && err.code === 'conflict';

export async function aiPrefill(
  requestId: string,
  ctx: AuditContext,
  deps: PrefillDeps = {},
  /**
   * `expectCustoms`: the job's queue (§6.8) — a customs pass, or a tariff
   * reply. A section changed since queueing stands the pass down rather than
   * running a customs pass from the tariff queue or a tariff reply from the
   * customs one. Absent: no comparison (a direct caller, a test).
   *
   * `expectRev`: the revision the worker CHECKED the job against
   * (`prefillStanding`) — the chain starts there, not from a fresh read, or a
   * person's save landing between that check and the first machine write
   * becomes the machine's own base and is overwritten by the grouping.
   * Absent or null: a direct caller, and the chain starts from a fresh read.
   */
  opts: { expectCustoms?: boolean; expectRev?: number | null } = {},
): Promise<PrefillOutcome> {
  const deadline = deps.deadline ?? Date.now() + PASS_DEADLINE_MS;
  const propose = deps.propose ?? proposeGroups;
  const pick = deps.pick ?? pickImportRows;

  /**
   * DOES THIS JOB HAVE A CUSTOMS SIDE AT ALL?
   *
   * The pass once ran the whole customs half on a **yolkira** request: the
   * model grouped the goods, `applyProposal` COMMITTED customs groups onto a
   * quote that has no customs, and `blockersFor` then raised
   * `customs_on_yolkira` — a blocker no screen can clear. A freight quote is
   * priced on the TOTALS, so a yolkira job makes no model call and no save:
   * it is answered from the tariff table (his 2.5 b).
   */
  const [row] = await db
    .select({ section: calcRequests.section })
    .from(calcRequests)
    .where(eq(calcRequests.id, requestId));
  const parts = row?.section
    ? sectionParts(row.section as CalcSectionName)
    : { customs: true, freight: true, extras: true };

  if (opts.expectCustoms !== undefined && parts.customs !== opts.expectCustoms) {
    logger.info(
      { requestId, expectCustoms: opts.expectCustoms },
      '[calc-prefill] the section moved since the job was queued — stood down',
    );
    return { ...NOTHING_DONE, text: '', lentaText: '', stood: 'touched' };
  }
  if (!parts.customs) return tariffOnly(requestId, deps);

  /**
   * Configured AND within the day's budget — one flag, because to everything
   * downstream they mean the same thing: no model on this pass.
   *
   * The memory, the sweep and the import fill all still run; they are the
   * model-free half and they are what a server with no key has always had.
   * The reply says which it was, in words: «AI sozlanmagan» is a fact about
   * the server and «AI kunlik limiti tugadi» is a fact about today, and a
   * seller reading the second must not be told the first.
   */
  const hasKey = deps.configured ?? aiConfigured();
  const budgetLeft = hasKey ? await aiCalcBudgetLeft() : 0;
  const configured = hasKey && budgetLeft > 0;

  let codesStamped = 0;
  let ratesPulled = 0;
  let importFilled = 0;
  let memoryCoded = 0;
  let memoryFilled = 0;
  let dictionaryFilled = 0;
  let aiUsed = false;
  let pastDeadline = false;

  /**
   * THE REVISION CHAIN (K14, concurrency-3). Every machine save carries the
   * revision the machine's own previous write left; a person's save in
   * between turns the machine's next save into `conflict`, which writes
   * nothing, and the machine writes nothing more — a person is working on
   * the request, and the pick's model call alone can take two minutes. The
   * pass still goes on to the reply. Stated: the grouping's own seconds
   * between `releaseAiClaim` and the end of `priceProposedGroups` are not
   * under it (the claim covers the model call before them).
   *
   * It STARTS at the revision the job was checked against (`expectRev`), so
   * a save in the gap after that check is a conflict too — a fresh read here
   * would adopt it as the machine's own.
   */
  let rev: number | null = opts.expectRev ?? (await prefillTicket(requestId));
  let overtaken = false;
  const overtakenAt = (step: string) => {
    overtaken = true;
    logger.info({ requestId, step }, '[calc-prefill] a person saved meanwhile — the machine writes nothing more');
  };

  /**
   * 0. THE SEALED MEMORY GOES FIRST (0096), before a token is spent.
   *
   * The owner's own order: «shu muhrlangan datani AI xotirasiga qo'yish
   * kerak». What a VED person confirmed and sealed for this product is this
   * company's answer about it — so the machine reads it before the model,
   * before the quarterly file, and before anything is billed.
   */
  try {
    const out = await applyMemory(requestId, ctx, rev);
    memoryCoded = out.coded;
    memoryFilled = out.filled;
    rev = out.rev;
  } catch (err) {
    if (isOvertaken(err)) overtakenAt('step 0');
    else logger.warn({ err, requestId }, '[calc-prefill] memory pass failed');
  }

  // 1. The model groups the goods and names their codes; `proposeGroups`
  //    then prices what it proposed (the book's rates, the code onto the
  //    row) and 0094's import fill runs inside its save.
  //
  //    `applyProposal` DELETES and re-inserts the groups and its claim tests
  //    no revision, so the chain is compared HERE, right before it: step 0
  //    compare-and-sets only when it had codes to post, and a person's save
  //    since the job's check would otherwise be grouped over and then
  //    adopted below. Stated: this is a check, not the claim — the
  //    milliseconds between it and `proposeGroups`'s claim are not under it
  //    until that claim carries the revision itself (the kernel's).
  if (configured && !overtaken && rev !== null && (await prefillTicket(requestId)) !== rev) {
    overtakenAt('step 1');
  }
  if (configured && !overtaken) {
    try {
      const out = await propose(requestId, ctx);
      codesStamped += out.codesStamped;
      ratesPulled += out.ratesPulled;
      importFilled += out.importFilled;
      // The tail's save fills from the memory too — counted, or the outcome
      // said «0 from the memory» about a pass whose bazas came from it.
      memoryFilled += out.memoryFilled;
      dictionaryFilled += out.dictionaryFilled;
      aiUsed = true;
    } catch (err) {
      // A model that refused, a key that expired, a request somebody closed
      // between landing and here — none of it is fatal. What follows still
      // runs, and the reply says what was and was not done.
      logger.warn({ err, requestId }, '[calc-prefill] propose failed');
    }
    // The grouping's own saves moved the clock; the chain picks up here.
    // ADOPTED, not compared: `proposeGroups` does not say which revision its
    // own last save left, so a save inside its unclaimed tail is taken as
    // the machine's (the window stated above the chain).
    rev = await prefillTicket(requestId);
  }

  // 2. …and with or without a model: the SWEEP. Intake prefills codes from
  //    the TNVED memory, so the commonest request arrives already coded, and
  //    an empty save is what places those items in groups (with rates at
  //    mint) and fires the import fill. This is the whole model-free half of
  //    the feature, and it is why a server with no key still gets a figure.
  if (!overtaken) {
    try {
      const swept = await saveTable(requestId, { items: [], adds: [] }, ctx, rev === null ? undefined : { expectRev: rev });
      importFilled += swept.importFilled.length;
      memoryFilled += swept.memoryFilled.length;
      dictionaryFilled += swept.dictionaryFilled.length;
      rev = swept.rev;
    } catch (err) {
      if (isOvertaken(err)) overtakenAt('step 2');
      else logger.warn({ err, requestId }, '[calc-prefill] sweep failed');
    }
  }

  // 3. The bazas the file could not fill by itself: the model is shown the
  //    candidates and picks a DECLARATION, never a number — unless the
  //    pass's deadline has passed, which is said rather than overrun.
  let picked = 0;
  if (configured && !overtaken) {
    if (Date.now() > deadline) {
      pastDeadline = true;
      logger.warn({ requestId }, '[calc-prefill] past the pass deadline — the pick is skipped');
    } else {
      try {
        const out = await pickBazas(requestId, ctx, pick, rev);
        picked = out.picked;
        rev = out.rev;
        if (out.capped || out.refused || out.overtaken || out.timedOut) {
          logger.info(
            { requestId, capped: out.capped, refused: out.refused, overtaken: out.overtaken, timedOut: out.timedOut },
            '[calc-prefill] the pick left rows for the VED',
          );
        }
        if (picked > 0) aiUsed = true;
      } catch (err) {
        if (isOvertaken(err)) overtakenAt('step 3');
        else logger.warn({ err, requestId }, '[calc-prefill] pick failed');
      }
    }
  }

  // 4. Read what the engine now says, and say it in words.
  const ws = await loadWorkspace(requestId);
  if (!ws) throw new Error(`calc request ${requestId} vanished during the pass`);
  /**
   * «NOTHING TO PRICE» IS NOT «PRICED AT ZERO» (audit A17): an empty customs
   * list is the engine's `null`, so the screen, the seal gate and this reply
   * refuse in the same place. The `groups.length` clause stays as the belt —
   * a workspace read by an older server would still spell it 0.
   */
  const customsUsd = ws.parts.customs && ws.groups.length > 0 ? ws.customsUsd : null;
  // `listUsd` is the road's LIST price on the STORED zone — what the tariff
  // says before any concession, and never a guessed zone's figure.
  const freightUsd = ws.freight && ws.freight.ok ? ws.freight.listUsd : null;

  /**
   * The 📊 estimate (his 2.1 b), only where there is no exact total: an exact
   * total needs no estimate. The medians are a READ — a failure there is
   * logged and leaves the rows unestimated; it never costs the reply.
   */
  let estimate: CustomsEstimate | null = null;
  if (ws.parts.customs && ws.customsUsd === null) {
    let medians = new Map<string, RowMedian>();
    if (Date.now() > deadline) pastDeadline = true;
    try {
      medians = await rowMediansFor(ws, { deadline });
    } catch (err) {
      logger.warn({ err, requestId }, '[calc-prefill] medians not read — no estimate');
    }
    estimate = estimateCustoms({ ...estimateInputOf(ws), medians });
  }

  const road = await roadOf(ws);
  // Who the answer is ABOUT — the card's own code, and the customer's, so a
  // seller with three open jobs can tell which one this is.
  const about = await requestAbout(requestId, deps.replyTo ?? null);
  const lines = replyLines(ws, estimate);
  const reply = (link: string | null, audience: 'chat' | 'lenta') =>
    aiVedReplyText({
      clientLabel: about?.clientCode ?? null,
      cardLabel: about?.cardLabel ?? null,
      lines,
      ungrouped: ws.ungrouped.map((i) => i.label),
      fee: ws.fee && ws.fee.ok ? { bhm: ws.fee.bhmCoefficient, usd: ws.fee.feeUsd } : null,
      totalUsd: customsUsd,
      feeRefusal: ws.fee && !ws.fee.ok ? feeRefusalText(ws.fee.reason) : null,
      hasCertificate: ws.hasCertificate,
      freight: road,
      link,
      aiConfigured: hasKey,
      budgetSpent: hasKey && budgetLeft <= 0,
      estimate: estimate ? totalsWords(estimate) : null,
      audience,
    });

  return {
    ...NOTHING_DONE,
    text: reply(about?.link ?? null, 'chat'),
    lentaText: reply(null, 'lenta'),
    customsUsd,
    freightUsd,
    taxminiyUsd: estimate?.taxminiy?.customsUsd ?? null,
    codesStamped,
    ratesPulled,
    importFilled,
    picked,
    memoryCoded,
    memoryFilled,
    dictionaryFilled,
    aiUsed,
    pastDeadline,
  };
}

/**
 * A yolkira job (his 2.5 b): answered from the tariff table — no budget, no
 * memory, no model, no save — with the card's labels and the road through
 * the ONE freight answer the podklyuch reply prints too.
 */
async function tariffOnly(requestId: string, deps: PrefillDeps): Promise<PrefillOutcome> {
  const ws = await loadWorkspace(requestId);
  if (!ws) throw new Error(`calc request ${requestId} vanished during the pass`);
  const road: AiVedFreight = (await roadOf(ws)) ?? {
    // A freight-only section always has a road; a section without one has
    // nothing to answer, and says so rather than a silence.
    ok: false,
    refusal: 'bu bo‘limda yo‘lkira yo‘q',
    tail: 'ved',
  };
  const about = await requestAbout(requestId, deps.replyTo ?? null);
  const said = (link: string | null, audience: 'chat' | 'lenta') =>
    tariffReplyText({
      clientLabel: about?.clientCode ?? null,
      cardLabel: about?.cardLabel ?? null,
      freight: road,
      link,
      audience,
    });
  return {
    ...NOTHING_DONE,
    text: said(about?.link ?? null, 'chat'),
    lentaText: said(null, 'lenta'),
    freightUsd: ws.freight && ws.freight.ok ? ws.freight.listUsd : null,
  };
}

/**
 * The road this reply prints (§6.4): the stored zone or the city's guess,
 * the request's cube or the lines' Σ, the brutto kilos ASKED — one function,
 * `freightAnswerFor`, for the podklyuch reply and the tariff reply alike.
 */
async function roadOf(ws: Workspace): Promise<AiVedFreight | null> {
  const tariff = ws.parts.freight ? await tariffFor(onDate()) : [];
  return freightAnswerFor(
    {
      hasFreight: ws.parts.freight,
      freightZone: ws.freightZone,
      guessedZone: ws.guessedZone,
      fromCity: ws.fromCity,
      weightKg: ws.weightKg,
      volumeM3: ws.volumeM3,
      volumeFromLines: ws.volumeFromLines,
      lines: [...ws.groups.flatMap((g) => g.items), ...ws.ungrouped],
      stored: ws.freight,
    },
    tariff,
  );
}

/** Why Taxminiy is absent, as the sentence §2.2 prints after the dash. */
function blockWords(block: CustomsEstimate['taxminiyBlock']): string | null {
  if (block === null) return null;
  if (block === 'ungrouped' || block === 'refused_measure' || block === 'budget' || block === 'refused') {
    return TAXMINIY_BLOCK_WORDS[block];
  }
  const fee: FeeRefusal = block;
  return `bojxona yig‘imi: ${feeRefusalText(fee)}`;
}

/** The estimate's two totals, in the reply's vocabulary. */
function totalsWords(e: CustomsEstimate): AiVedEstimate {
  return {
    rows: e.rows,
    exactRows: e.exactRows,
    exactUsd: e.exactUsd,
    taxminiyUsd: e.taxminiy?.customsUsd ?? null,
    taxminiyFee: e.taxminiy
      ? { bhm: e.taxminiy.fee.overridden ? null : e.taxminiy.fee.bhmCoefficient, usd: e.taxminiy.fee.feeUsd }
      : null,
    taxminiyBlock: blockWords(e.taxminiyBlock),
  };
}

/**
 * The card this calculation belongs to, for the reply's own heading.
 *
 * A deal is named by its CODE and a lead by its name — the same rule
 * `requestLabel` follows one file over — and the client code beside it is
 * what the office actually addresses cargo by (#581).
 *
 * The LINK is chosen for the person who reads the reply (`replyTo`) — the
 * collector, the same person the bot's ✅ answered — by `calcJobHrefFor`, the
 * ✅'s own rule: a card they can open, the calculation's screen for the VED,
 * else none. No reader, no link.
 */
async function requestAbout(
  requestId: string,
  replyTo: string | null,
): Promise<{ clientCode: string | null; cardLabel: string | null; link: string | null } | null> {
  const [row] = await db
    .select({ entityType: calcRequests.entityType, entityId: calcRequests.entityId })
    .from(calcRequests)
    .where(eq(calcRequests.id, requestId));
  if (!row) return null;
  const entityType = row.entityType === 'lead' ? 'lead' : 'deal';
  const linkFor = async (leadOwnerId: string | null): Promise<string | null> => {
    if (!replyTo) return null;
    try {
      const href = calcJobHrefFor(
        { id: replyTo, permissions: await userPermissions(replyTo) },
        { entityType, entityId: row.entityId, leadOwnerId, requestId },
      );
      return href ? `${(process.env.APP_URL ?? '').replace(/\/$/, '')}${href}` : null;
    } catch (err) {
      // A link nobody could check is not sent — and it must not cost the answer.
      logger.warn({ err, requestId }, '[calc-prefill] reply link not resolved — sent without one');
      return null;
    }
  };
  if (row.entityType === 'deal') {
    const [deal] = await db
      .select({ code: deals.code, clientCode: clients.clientCode })
      .from(deals)
      .leftJoin(clients, eq(clients.id, deals.clientId))
      .where(eq(deals.id, row.entityId));
    return { clientCode: deal?.clientCode ?? null, cardLabel: deal?.code ?? null, link: await linkFor(null) };
  }
  const [lead] = await db
    .select({ name: leads.name, ownerId: leads.ownerId })
    .from(leads)
    .where(eq(leads.id, row.entityId));
  return { clientCode: null, cardLabel: lead?.name ?? null, link: await linkFor(lead?.ownerId ?? null) };
}

/**
 * The workspace's groups as the reply's lines.
 *
 * ONE LINE PER GROUP, never per item, and that is a property of the ENGINE
 * rather than a layout choice: `customsFor` prices a GROUP, and splitting its
 * figure across the members would be inventing an allocation — the same
 * refusal `groupPerUnit` makes on the price history (#780). The group names
 * its items instead, which is what the seller wrote anyway.
 *
 * The baza mark is the group's own answer only when its members AGREE about
 * where the price came from: a group carrying one remembered baza and one the
 * VED typed wears no mark at all, because a 🧠 over a mixed row would claim
 * a provenance for a number that is half somebody's typing. On an estimated
 * group the agreement is asked of the rows that HAVE a baza; the rest wear
 * the 📊 beside it.
 */
function replyLines(ws: Workspace, estimate: CustomsEstimate | null): AiVedLine[] {
  return ws.groups.map((g) => {
    const ge = estimate?.groups.get(g.id) ?? null;
    const sourceRows = ge?.kind === 'estimated' ? g.items.filter((i) => i.bazaUsd !== null) : g.items;
    const sources = [...new Set(sourceRows.map((i) => i.bazaSource))];
    const bazaSource = sources.length === 1 ? sources[0]! : null;
    // The refusal the reply prints is the SHADOW's whenever an estimate was
    // attempted for the group (§2.1): what still blocks even the estimate.
    const refused = g.customs.ok ? null : ge?.kind === 'refused' ? ge.customs : g.customs;
    return {
      label: g.items.map((i) => i.label).join(', ') || g.label,
      code: g.tnvedCode,
      // The shorthand «100 dona × $20/dona» is printed only where it is TRUE
      // of the whole group; the figure beside it is exact either way.
      measureText: measureTextOf(g.items),
      bazaSource,
      dutyText: g.dutyFree ? 'yo‘q (lgota)' : dutyText(g),
      addDutyPct: g.customs.ok ? g.customs.addDutyPct : ge?.kind === 'estimated' ? ge.customs.addDutyPct : 0,
      exciseText: exciseWords(g),
      vatPct: g.vatFree ? 0 : g.vatPct,
      customsUsd: g.customs.ok ? g.customs.customsUsd : null,
      // Already words — `blockerText` owns the engine's whole vocabulary and
      // a second map here would drift from it (#513). The WHOLE detail rides
      // along (P2.9): the row, the unit and the half.
      refusal: refused
        ? blockerText({
            kind: 'customs',
            groupSeq: g.seq,
            groupLabel: g.label,
            reason: refused.reason,
            itemLabel: refused.itemLabel,
            itemSeq: refused.itemSeq,
            unit: refused.unit,
            half: refused.half,
            rate: refused.rate,
          })
        : null,
      // Who can fix the refusal (§0.1(7)): a missing count or weight is a
      // fact only the customer has — the same split the Taxminiy block makes
      // (`refused_measure`), or one reply names two fixers for one fact.
      refusalTail: refused?.reason === 'measure_missing' ? 'seller' : 'ved',
      estimated: estimateLine(ge),
      // ⭐ of his Question 4: a weight copied from the shipment's BRUTTO
      // total is said beside the measure, on every row whose measure is
      // PRINTED — a row with its own baza (§6.7), which a REFUSED group still
      // prints in its head, and every row of an estimated group, whose shadow
      // measure is printed instead (§2.1). Gating on «the group priced» hid
      // the mark on exactly the line that asks the seller for a fact.
      weightFromTotal: g.items.some(
        (i) => weightFromTotalNote(i.note) && (i.bazaUsd !== null || ge?.kind === 'estimated'),
      ),
      // The workspace's own age rule for the row's baza (`bazaStale`, law 5),
      // asked of the rows that HAVE one — the VED's screen wears the same ⚠.
      staleBaza: g.items.some((i) => i.bazaUsd !== null && i.bazaStale),
    };
  });
}

/** A group's 📊 line, or the words for why its rows got none. */
function estimateLine(ge: GroupEstimate | null): AiVedLineEstimate | null {
  if (ge?.kind === 'estimated') {
    return {
      priced: true,
      customsUsd: ge.customs.customsUsd,
      measureText: measureTextOf(ge.items),
      // Rows of one code share a series: the same count said once.
      declarations: [...new Set(ge.medians.map((m) => m.n))],
      oldFileEnd: ge.medians.find((m) => m.stale)?.batchEnd ?? null,
    };
  }
  if (ge?.kind === 'refused' && ge.misses.length > 0) {
    return { priced: false, misses: ge.misses.map((m) => `${m.seq}-qator — ${missWords(m.miss, m.n)}`) };
  }
  return null;
}

/**
 * «300 kg × $4.10/kg» — when every member carries the same baza and basis.
 * The measure is the one the BASIS reads (0125) — «12 m³ × $40/m³», never
 * the dona count beside a per-kg price.
 */
function measureTextOf(items: readonly PricedItem[]): string | null {
  const bazas = [...new Set(items.map((i) => `${i.bazaUsd}|${i.bazaBasis}`))];
  const first = items[0];
  return bazas.length === 1 && first && first.bazaUsd !== null && first.bazaBasis !== null
    ? `${measureOf(items, first.bazaBasis)} × $${first.bazaUsd}/${basisLabel(first.bazaBasis, 'dona')}`
    : null;
}

/**
 * A group's excise as the seller reads it — the percentage or, since 0131,
 * the amount per unit; nothing when the group has none (an answered «yo‘q»
 * is a 0 % and prints nothing, like a code that carries no excise at all).
 */
function exciseWords(g: Workspace['groups'][number]): string | null {
  if (g.excisePct !== null && g.excisePct > 0) return `aksiz ${g.excisePct}%`;
  if (g.exciseSpecific !== null && g.exciseUnit !== null) {
    return `aksiz $${g.exciseSpecific}/${g.exciseUnit === '1000_dona' ? '1000 dona' : g.exciseUnit}`;
  }
  return null;
}

/**
 * How much of the group the baza is per — through the engine's own resolver
 * (`itemMeasure`), so the reply states the very quantity the value was
 * multiplied by. It used to print the dona count first whatever the basis:
 * «100 dona × $2/kg». A member that cannot answer in that unit is the
 * engine's own refusal, so the shorthand gives up rather than summing a part.
 */
function measureOf(items: readonly PricedItem[], basis: BazaBasis): string {
  let sum = 0;
  for (const item of items) {
    const m = itemMeasure(item, basis);
    if (m === null || !(m > 0)) return '—';
    sum += m;
  }
  return `${round3(sum)} ${basisLabel(basis, 'dona')}`;
}

const round3 = (n: number) => Math.round(n * 1000) / 1000;
