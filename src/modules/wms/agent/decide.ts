import { randomBytes } from 'node:crypto';
import { and, desc, eq, gt, gte, inArray, isNotNull, isNull, lt, or, sql } from 'drizzle-orm';
import { v5 as uuidv5 } from 'uuid';
import { aiConfigured } from '../../platform/ai/model';
import { writeAudit, type AuditContext } from '../../platform/audit/service';
import { db } from '../../platform/db/client';
import {
  agentCalcLinks,
  agentConversations,
  agentDrafts,
  agentOutbox,
  agentRuns,
  calcRequests,
  crmActivities,
  leads,
  tgAccounts,
  tgMessageFlags,
  tgMessages,
  users,
} from '../../platform/db/schema';
import { enqueue } from '../../platform/jobs/boss';
import { logger } from '../../platform/logger';
import { getSetting } from '../../platform/settings/service';
import { listenerIsCurrent, readGuard } from '../crm/account-guard';
import { cardDigest, digestBody } from './card';
import { LANDING_CLAIM, renderDraftCardFull } from './card-io';
import { agentRunning, readAgentConfig } from './config';
import { bindMoved, chatIdentity } from './context';
import { zoneForOrigin } from './origin';
import { ownerPolicyFor, policyFor } from './policy-input';
import { keptFileSql } from './outbox-store';
import { asksAnew, releaseAt } from './send-step';
import { sendsToday } from './today';
import { HUMAN_TAKEOVER_HOURS } from './limits';
import { JOB_AGENT_INBOUND, type AgentInboundJob } from './queues';
import { isNudge } from './worthy';
import type { PolicyHit } from './policy';
import type { ComposedAction, DraftPolicyJson } from './types';

/**
 * His decision on a draft (spec §17.7) — ONE function for the bot's buttons
 * and the web page, so the two doors cannot disagree.
 *
 * Only the ACCOUNT HOLDER decides (leak-5): a message leaves a personal
 * account only by its holder, and a super_admin who may run the page may not
 * put words into another person's mouth. The ✅ carries a digest of what the
 * card showed (leak-3): a press on a card that has since changed is refused,
 * never applied to the new words. The policy is re-run on the STORED body
 * with the world read now; the chat is re-validated (a newer question, his own
 * reply, an edited message); and the outbox row is written in the same
 * transaction that marks the draft approved — so «approved» and «queued» are
 * one fact (regression-8).
 *
 * A calculation is landed BEFORE the reply is queued (regression-4, money-5):
 * «hisoblatishga yubordim» goes out only when the VED queue took the job.
 */

export type DraftDecision = 'send' | 'reject' | 'human' | 'edit';

export type DecideRefusal =
  | 'not_found'
  | 'not_account_holder'
  | 'agent_off'
  | 'not_live'
  | 'editing'
  | 'stale_card'
  | 'policy_block'
  | 'listener_behind'
  | 'sending_disabled'
  | 'superseded'
  | 'taken_over'
  | 'budget_spent'
  | 'calc_not_queued'
  | 'calc_in_flight'
  | 'identity_changed'
  | 'empty';

export type DecideResult =
  | {
      ok: true;
      status: string;
      sendAt?: Date;
      requestId?: string | null;
      /**
       * `submitOwnText`'s answer (C9): whether his words passed the owner
       * subset, what blocked them if not, and the digest of the card they now
       * stand on — the confirmation's own ✅ carries it, so the press is the
       * card's press and `decideDraft` compares it like any other.
       */
      blocked?: boolean;
      blocks?: PolicyHit[];
      digest?: string;
      /** What that ✅ also does — the draft's actions ride with his words (C9: the confirmation names them). */
      actions?: ComposedAction[];
      /**
       * 🙋's withdrawals, said on the press (ident fix F10): the approved
       * replies still waiting that it cancelled, and how many of them were HIS
       * OWN words (a ✏️ text, a 💵 price) — the one kind he would not expect a
       * «the chat is mine» to take back.
       */
      withdrawn?: { total: number; own: number };
    }
  | { ok: false; code: DecideRefusal; detail?: string };

export interface DeciderActor {
  id: string;
  roles: readonly string[];
  permissions: ReadonlySet<string>;
}

const NOTE_NS = '4f1c2b1e-0138-4a51-9c1e-5a6d7e8f9a0b';
/** The intake note's id for a draft — the landing is re-runnable without a second note (build-6). */
export const noteIdFor = (draftId: string) => uuidv5(draftId, NOTE_NS);

/** A positive 63-bit random id — Telegram's dedup key, minted ONCE per approved reply (ban-5). */
export function mintRandomId(): bigint {
  const b = randomBytes(8);
  b[0] = b[0]! & 0x7f;
  const v = b.readBigInt64BE(0);
  return v === 0n ? 1n : v;
}

/**
 * Has the chat moved past the draft since it was written? Re-asked at the ✅
 * from the stored rows; the pump asks the live head again before every step.
 * A newer inbound counts by `asksAnew` — the head's own rule — so a photo, a
 * voice note or a file the customer sent after the question supersedes the
 * reply exactly as a typed question does (review S4); in the stored record a
 * medium is a file this system KEPT (`keptFileSql`), which is also what tells
 * a photo from a sticker here.
 */
async function chatMoved(d: typeof agentDrafts.$inferSelect): Promise<'superseded' | 'taken_over' | 'anchor_edited' | null> {
  const [anchor] = await db
    .select({ sentAt: tgMessages.sentAt, editedAt: tgMessages.editedAt })
    .from(tgMessages)
    .where(and(eq(tgMessages.managerUserId, d.managerUserId), eq(tgMessages.peerId, d.peerId), eq(tgMessages.tgMessageId, d.anchorTgMessageId)));
  if (!anchor) return 'superseded';
  if (anchor.editedAt && (!d.anchorEditedAt || anchor.editedAt.getTime() > d.anchorEditedAt.getTime())) return 'anchor_edited';
  const newer = await db
    .select({
      id: tgMessages.id,
      direction: tgMessages.direction,
      body: tgMessages.body,
      tgMessageId: tgMessages.tgMessageId,
      deletedAt: tgMessageFlags.deletedAt,
      // `${table}.id`, never `${tgMessages.id}`: inside the subquery an unqualified column binds to ITS table (#128).
      kept: keptFileSql(sql`${tgMessages}.id`).mapWith(Boolean),
    })
    .from(tgMessages)
    .leftJoin(tgMessageFlags, eq(tgMessageFlags.messageId, tgMessages.id))
    .where(and(eq(tgMessages.managerUserId, d.managerUserId), eq(tgMessages.peerId, d.peerId), gt(tgMessages.tgMessageId, d.anchorTgMessageId)));
  const live = newer.filter((m) => !m.deletedAt);
  const outIds = live.filter((m) => m.direction === 'out').map((m) => m.tgMessageId);
  const ours = outIds.length
    ? await db
        .select({ id: agentOutbox.tgMessageId })
        .from(agentOutbox)
        .where(and(eq(agentOutbox.managerUserId, d.managerUserId), inArray(agentOutbox.tgMessageId, outIds)))
    : [];
  const oursSet = new Set(ours.map((r) => String(r.id)));
  if (live.some((m) => m.direction === 'out' && !oursSet.has(String(m.tgMessageId)))) return 'taken_over';
  if (live.some((m) => m.direction === 'in' && asksAnew({ text: m.body ?? '', media: m.kept }, isNudge))) return 'superseded';
  return null;
}

/**
 * Is the chat no longer the customer this draft was written for? Asked of the
 * server's identity NOW, by the one rule the tray's withdrawal asks too
 * (context `bindMoved`).
 */
async function identityMoved(d: typeof agentDrafts.$inferSelect): Promise<boolean> {
  if (!d.clientId && !d.leadId) return false;
  return bindMoved(d, await chatIdentity(d.managerUserId, d.peerId));
}

/** Today's AI sends against the ceiling — a ✅ beyond it is refused with the text to copy (fit-8). One home: today.ts. */
async function budgetLeft(managerUserId: string, startedAt: Date | null, now: Date): Promise<number> {
  const { used, ceiling } = await sendsToday(managerUserId, startedAt, now);
  return ceiling - used;
}

async function lastInboundAt(d: typeof agentDrafts.$inferSelect): Promise<Date | null> {
  const [row] = await db
    .select({ sentAt: tgMessages.sentAt })
    .from(tgMessages)
    .where(and(eq(tgMessages.managerUserId, d.managerUserId), eq(tgMessages.peerId, d.peerId), eq(tgMessages.direction, 'in')))
    .orderBy(desc(tgMessages.sentAt))
    .limit(1);
  return row?.sentAt ?? null;
}

/**
 * The customer's newest message asked again when the draft a run stood down
 * for is gone (review: ✅ on an editing draft after the customer wrote again).
 * A run that meets a draft he is EDITING stands down after its model call
 * (`createDraft` → 'editing', the run's row `stood_down`/'editing') — he is
 * typing an answer — and nothing asked again: the sweep's gap pass reads «a
 * run exists» and goes on. So when that draft leaves the chat by a newer
 * message (`chatMoved` on ✅) or his ❌, the newest live inbound is queued
 * once more — the anchor itself when it was EDITED (an edit's job, its own
 * attempt from 100), otherwise the newer message, at the next free attempt
 * below 100 (the inbound UNIQUE is per attempt; the live hook's own job, if
 * it is still on its debounce, meets this one there and one of them stands
 * down as a duplicate). Only a stand-down for HIM is re-asked: a refusal, a
 * cap, a «no reply needed» or an error is that run's own answer (the sweep
 * retries an error itself). True = a card for the newer message is coming —
 * what the press may promise.
 */
async function redraftNewest(d: typeof agentDrafts.$inferSelect, how: 'newer' | 'edited'): Promise<boolean> {
  // The sweep's own gate: with no model a queued run writes nothing, and the press must not promise a card.
  const config = await readAgentConfig();
  if (!agentRunning(config) || config.ownerUserId !== d.managerUserId || !aiConfigured()) return false;
  const [newest] = await db
    .select({ tgMessageId: tgMessages.tgMessageId })
    .from(tgMessages)
    .leftJoin(tgMessageFlags, eq(tgMessageFlags.messageId, tgMessages.id))
    .where(
      and(
        eq(tgMessages.managerUserId, d.managerUserId),
        eq(tgMessages.peerId, d.peerId),
        eq(tgMessages.direction, 'in'),
        how === 'edited' ? gte(tgMessages.tgMessageId, d.anchorTgMessageId) : gt(tgMessages.tgMessageId, d.anchorTgMessageId),
        isNull(tgMessageFlags.deletedAt),
      ),
    )
    .orderBy(desc(tgMessages.tgMessageId))
    .limit(1);
  if (!newest) return false;
  const runs = await db
    .select({ attempt: agentRuns.attempt, outcome: agentRuns.outcome, error: agentRuns.error, createdAt: agentRuns.createdAt })
    .from(agentRuns)
    .where(
      and(
        eq(agentRuns.managerUserId, d.managerUserId),
        eq(agentRuns.peerId, d.peerId),
        eq(agentRuns.trigger, 'inbound'),
        eq(agentRuns.anchorTgMessageId, newest.tgMessageId),
      ),
    );
  // The draft's own run (an edited anchor's first draft) is no answer to the message as it stands now.
  const since = runs.filter((r) => r.createdAt.getTime() >= d.createdAt.getTime());
  if (since.some((r) => r.outcome === 'reserved' || r.outcome === 'draft')) return true;
  if (since.some((r) => !(r.outcome === 'stood_down' && r.error === 'editing'))) return false;
  if (how === 'edited' && since.length === 0) return false;
  const job: AgentInboundJob =
    how === 'edited'
      ? { managerUserId: d.managerUserId, peerId: String(d.peerId), anchorTgMessageId: String(newest.tgMessageId), origin: 'edit' }
      : {
          managerUserId: d.managerUserId,
          peerId: String(d.peerId),
          anchorTgMessageId: String(newest.tgMessageId),
          attempt: runs.length === 0 ? 0 : Math.max(...runs.filter((r) => r.attempt < 100).map((r) => r.attempt), -1) + 1,
          origin: 'sweep',
        };
  await enqueue(JOB_AGENT_INBOUND, job, { retryLimit: 0, startAfter: 1 });
  return true;
}

/** `redraftNewest`, never a reason for the press itself to fail. */
async function redraftQuietly(d: typeof agentDrafts.$inferSelect, how: 'newer' | 'edited'): Promise<boolean> {
  try {
    return await redraftNewest(d, how);
  } catch (err) {
    logger.warn({ err, draftId: d.id }, '[agent] newer message not asked again');
    return false;
  }
}

/** A claim older than this is a press that died mid-landing (a deploy, a kill), and the next ✅ takes it over. */
export const LANDING_STALE_MS = 2 * 60_000;

/**
 * The landing's claim (ident fix F12): `action_error` holds `LANDING_CLAIM`
 * while one press lands the job. Two ✅ a second apart — the bot and the
 * page, or a press redelivered — used to land it TWICE once K26 made a
 * standing note re-askable: the second press found the first one's note with
 * no request yet and opened a request of its own on it. A unique index on
 * the request's note cannot say this — a recalculation copies its note on
 * purpose (workspace `recalcFromSealed`) — so the claim is the draft's own
 * row, a compare-and-set like every other claim here.
 */
async function claimLanding(draftId: string): Promise<boolean> {
  const [row] = await db
    .update(agentDrafts)
    .set({ actionError: LANDING_CLAIM, updatedAt: new Date() })
    .where(
      and(
        eq(agentDrafts.id, draftId),
        or(sql`${agentDrafts.actionError} IS DISTINCT FROM ${LANDING_CLAIM}`, lt(agentDrafts.updatedAt, new Date(Date.now() - LANDING_STALE_MS))),
      ),
    )
    .returning({ id: agentDrafts.id });
  return row !== undefined;
}

/**
 * The calculation, landed (or found already landed) — through the bot's own
 * door, `landIntake`, so the job reaches the same queue, the same AI VED
 * pre-pass and the same stage move as one a seller collected. A landing is
 * claimed first (`claimLanding`); a press that finds another one landing is
 * told `in_flight` and writes nothing — the claim is released by whatever
 * that press writes next (the approval, or the refusal).
 */
async function landCalc(
  d: typeof agentDrafts.$inferSelect,
  action: Extract<ComposedAction, { type: 'calc_submit' }>,
  actor: DeciderActor,
): Promise<{ queued: boolean; requestId: string | null; queueError: string | null }> {
  const noteId = noteIdFor(d.id);
  const { intakeNoteExists } = await import('./calc-note');
  if (await intakeNoteExists(noteId)) {
    const [req] = await db.select({ id: calcRequests.id }).from(calcRequests).where(eq(calcRequests.noteId, noteId));
    if (req) return { queued: true, requestId: req.id, queueError: null };
    // The note landed and the QUEUE refused (final review K26): a server
    // mid-deploy. `landIntake` writes the note and moves the stage before it
    // asks the queue, so this ✅ is the job asked again — never «already
    // landed» for ever over a job no VED will ever see.
    if (!(await claimLanding(d.id))) return { queued: false, requestId: null, queueError: 'in_flight' };
    return requeueLanded(noteId, action, actor);
  }
  if (!(await claimLanding(d.id))) return { queued: false, requestId: null, queueError: 'in_flight' };
  const identity = await chatIdentity(d.managerUserId, d.peerId);
  const cited = action.citedMessageIds.length
    ? await db
        .select({ body: tgMessages.body, sentAt: tgMessages.sentAt, hasMedia: tgMessages.hasMedia })
        .from(tgMessages)
        .where(
          and(
            eq(tgMessages.managerUserId, d.managerUserId),
            eq(tgMessages.peerId, d.peerId),
            eq(tgMessages.direction, 'in'),
            inArray(tgMessages.id, action.citedMessageIds),
          ),
        )
        .orderBy(tgMessages.sentAt)
    : [];
  const files = cited.filter((m) => m.hasMedia).length;
  const material = [
    ...cited.map((m) => m.body ?? '').filter((b) => b.trim() !== ''),
    ...(files > 0 ? [`(Chatda ${files} ta fayl/rasm bor — Telegram suhbatida.)`] : []),
  ];
  const [me] = await db.select({ name: users.fullName }).from(users).where(eq(users.id, actor.id));
  const client = identity.clientId
    ? { id: identity.clientId, clientCode: identity.codes[0]?.clientCode ?? '', name: identity.customerName ?? '' }
    : null;
  let lead: { id: string; name: string; ownerId: string | null } | null = null;
  if (!client && identity.leadId) {
    const [l] = await db.select({ id: leads.id, name: leads.name, ownerId: leads.ownerId }).from(leads).where(eq(leads.id, identity.leadId));
    lead = l ?? null;
  }
  const { landIntake } = await import('../calc/intake-land');
  const { CalcError } = await import('../calc/service');
  // The landing refuses BEFORE it writes a card or a note when the sender has
  // twenty requests open (docs/UCH-BAND.md: a coded client gets a new deal per
  // request, and a refused mint must leave no empty deal behind). That is the
  // queue's own refusal, for the card to say in words; with no note written,
  // the next ✅ lands the job afresh (K26).
  const target = await landIntake({
    noteId,
    section: action.section,
    facts: action.facts,
    steps: [
      "AI sotuvchi mijozning Telegram suhbatidan yig'di, egasi tasdiqladi.",
      // His 9 (2026-10-24): «kelib chiqish sertifikati bor, biz o'zimiz olamiz».
      "Kelib chiqish sertifikati: kompaniya o'zi oladi",
      // His third set «3»: cargo from China or a place we have no warehouse in is priced from ours —
      // the VED reads what the customer was told. `=== true`: an action stored before it carries none.
      ...(action.fromOurWarehouse === true ? ['Narx Xitoydagi omborimizdan; zavoddan omborgacha olib kelish alohida.'] : []),
    ],
    fileCount: 0,
    material,
    collectedBy: actor.id,
    collectedByName: me?.name ?? '',
    client,
    lead,
    leadName: identity.customerName ?? 'Telegram',
    leadPhone: null,
    // Every agent job carries the company's certificate (his 9) — never the
    // customer's answer, which the AI no longer asks for.
    hasCertificate: true,
    freightZone: freightZoneOf(action),
  }).catch((err: unknown) => {
    if (err instanceof CalcError) return { refused: err.code } as const;
    throw err;
  });
  if ('refused' in target) return { queued: false, requestId: null, queueError: target.refused };
  return { queued: target.queued === true && Boolean(target.requestId), requestId: target.requestId ?? null, queueError: target.queueError ?? null };
}

/**
 * The zone the bot's own buttons would choose for the place the customer
 * named (Kashgar → kashgar, Horgos → horgos, Yiwu/Guangzhou → cn), or none —
 * the VED chooses; never «cn» by default (review A11). Cargo priced from our
 * China warehouses IS the China column (his third set «3»). One home for the
 * landing and its re-ask.
 */
function freightZoneOf(action: Extract<ComposedAction, { type: 'calc_submit' }>): string | null {
  if (action.section !== 'podklyuch') return null;
  return action.fromOurWarehouse === true ? 'cn' : zoneForOrigin(action.facts.fromCity ?? null);
}

/**
 * The queue asked again for a landing whose note already stands (K26) — on
 * the card that note sits on, with the request `landIntake` would have
 * opened: the same facts through the same `landingItems`, the company's
 * certificate, the same zone; and the AI VED hodimi handed the job the same
 * way. The note and the stage move are not repeated: they happened. A
 * refusal comes back as the queue's own code, for the card to say in words.
 */
async function requeueLanded(
  noteId: string,
  action: Extract<ComposedAction, { type: 'calc_submit' }>,
  actor: DeciderActor,
): Promise<{ queued: boolean; requestId: string | null; queueError: string | null }> {
  const [note] = await db
    .select({ entityType: crmActivities.entityType, entityId: crmActivities.entityId })
    .from(crmActivities)
    .where(eq(crmActivities.id, noteId));
  if (!note || (note.entityType !== 'deal' && note.entityType !== 'lead')) return { queued: false, requestId: null, queueError: 'not_found' };
  const { CalcError, openCalcRequest } = await import('../calc/service');
  try {
    const { landingItems } = await import('../calc/intake');
    const opened = await openCalcRequest(
      {
        entityType: note.entityType,
        entityId: note.entityId,
        section: action.section,
        fromCity: action.facts.fromCity ?? null,
        toCity: action.facts.toCity ?? null,
        weightKg: action.facts.weightKg ?? null,
        volumeM3: action.facts.volumeM3 ?? null,
        items: landingItems(action.facts),
        noteId,
        source: 'bot',
        hasMaterials: false,
        hasCertificate: true,
        freightZone: freightZoneOf(action),
      },
      { actorId: actor.id },
    );
    const { queueCalcPrefill } = await import('../calc/prefill-queue');
    await queueCalcPrefill({ requestId: opened.id, staffId: actor.id, section: action.section });
    return { queued: true, requestId: opened.id, queueError: null };
  } catch (err) {
    logger.error({ err, noteId }, '[agent] calc re-queue failed');
    return { queued: false, requestId: null, queueError: err instanceof CalcError ? err.code : 'server_behind' };
  }
}

export async function decideDraft(
  actor: DeciderActor,
  draftId: string,
  decision: DraftDecision,
  opts: { digest?: string | null },
  ctx: AuditContext,
): Promise<DecideResult> {
  const [d] = await db.select().from(agentDrafts).where(eq(agentDrafts.id, draftId));
  if (!d) return { ok: false, code: 'not_found' };
  if (d.managerUserId !== actor.id) return { ok: false, code: 'not_account_holder' };
  const config = await readAgentConfig();
  if (decision !== 'reject' && decision !== 'human' && (!agentRunning(config) || config.ownerUserId !== d.managerUserId)) {
    return { ok: false, code: 'agent_off' };
  }
  if (d.status !== 'pending' && d.status !== 'editing') return { ok: false, code: 'not_live', detail: d.status };

  if (decision === 'reject' || decision === 'human' || decision === 'edit') {
    const status = decision === 'reject' ? 'rejected' : decision === 'human' ? 'taken_over' : 'editing';
    const changed = await db.transaction(async (tx): Promise<{ held: string[]; own: number } | null> => {
      const [row] = await tx
        .update(agentDrafts)
        .set({
          status,
          updatedAt: new Date(),
          ...(decision === 'edit' ? {} : { decidedBy: actor.id, decidedAt: new Date() }),
        })
        .where(and(eq(agentDrafts.id, draftId), inArray(agentDrafts.status, ['pending', 'editing'])))
        .returning({ id: agentDrafts.id });
      if (!row) return null;
      let held: string[] = [];
      let own = 0;
      if (decision === 'human') {
        const until = new Date(Date.now() + HUMAN_TAKEOVER_HOURS * 3_600_000);
        await tx
          .insert(agentConversations)
          .values({ managerUserId: d.managerUserId, peerId: d.peerId, humanUntil: until })
          .onConflictDoUpdate({
            target: [agentConversations.managerUserId, agentConversations.peerId],
            set: { humanUntil: until, updatedAt: new Date() },
          });
        // 🙋 «the chat is mine for 24 h» covers the replies he approved BEFORE
        // it and that are still waiting (final review K2) — night-held to
        // 08:30, a flood, a cap: sent later, they would speak into the chat he
        // has just taken over. In this same transaction, by `agent_off`'s
        // compare-and-set on 'agent' (withdrawTypedBind's): the send step
        // claims by that status, so a row already claimed is the one in flight
        // — and its next step reads the press (`human_until`, approved before
        // it: send-step `approvedBeforePress`) and stands down. A reply he
        // approves AFTER the press is his newer word and goes. His own words
        // go with the machine's — the send step cannot tell them apart and
        // must not — so the press SAYS how many it took (F10).
        const cancelled = await tx
          .update(agentOutbox)
          .set({ status: 'cancelled', lastError: 'taken_over: 🙋 he took the chat over for 24 hours' })
          .where(and(eq(agentOutbox.managerUserId, d.managerUserId), eq(agentOutbox.peerId, d.peerId), eq(agentOutbox.status, 'agent')))
          .returning({ draftId: agentOutbox.draftId });
        held = cancelled.map((o) => o.draftId);
        if (held.length > 0) {
          const mine = await tx
            .select({ id: agentDrafts.id })
            .from(agentDrafts)
            .where(and(inArray(agentDrafts.id, held), or(isNotNull(agentDrafts.finalBody), eq(agentDrafts.kind, 'price'))));
          own = mine.length;
        }
      }
      if (decision !== 'edit') {
        await writeAudit(tx, ctx, {
          entityType: 'agent_draft',
          entityId: draftId,
          action: 'status_change',
          before: { status: d.status },
          after: { status, ...(held.length > 0 ? { cancelledWaiting: held.length } : {}) },
        });
      }
      return { held, own };
    });
    if (!changed) return { ok: false, code: 'not_live' };
    await refreshDraftCard(draftId);
    // Each cancelled reply's own card says it will not go (card-io's CANCEL_WORDS `taken_over`).
    for (const held of changed.held) await refreshDraftCard(held);
    // ❌ on a draft he had opened for editing: a newer message that stood down for that edit is asked again.
    if (decision === 'reject' && d.status === 'editing') await redraftQuietly(d, 'newer');
    return { ok: true, status, ...(decision === 'human' ? { withdrawn: { total: changed.held.length, own: changed.own } } : {}) };
  }

  // ✅ — on an `editing` draft too, while he has written nothing for it (2026-10-29): ✏️ pressed and
  // thought better of is the machine's text exactly as if ✏️ had not been pressed — the same digest,
  // the same policy, the same CAS below on the status read here. His own words, once typed, are
  // the body; a second ✏️ over them means he is changing them, and ✅ waits for the new ones.
  if (d.status === 'editing' && d.finalBody !== null) return { ok: false, code: 'editing' };
  const body = (d.finalBody ?? d.proposedBody ?? '').trim();
  if (!body) return { ok: false, code: 'empty' };
  const actions = (d.actions ?? []) as ComposedAction[];
  if (opts.digest !== undefined && opts.digest !== cardDigest(body, actions)) return { ok: false, code: 'stale_card' };

  // The CRM's own send switch stops the pump too (send-step `sending_disabled`
  // is FINAL), so an approval made while it is off would only be cancelled a
  // minute later. Said here, before anything is queued.
  if ((await getSetting('tg_sending_enabled')) !== true) return { ok: false, code: 'sending_disabled' };
  const [acc] = await db.select({ id: tgAccounts.id }).from(tgAccounts).where(eq(tgAccounts.managerUserId, d.managerUserId));
  const guard = acc ? await readGuard(acc.id) : null;
  const now = new Date();
  // A fresh pump AND a finished catch-up (review S11): a listener whose start-up walk failed would hold the
  // row on `not_caught_up` until the six-hour expiry — refused here, in words, instead.
  if (!listenerIsCurrent(guard, now)) {
    return { ok: false, code: 'listener_behind' };
  }

  const p = (d.policy ?? {}) as Partial<DraftPolicyJson>;
  // His own words — typed, or the offer text made from his typed price — pass
  // the owner subset; the machine's pass the whole policy again.
  const policy = d.finalBody || d.kind === 'price'
    ? // The press asks only the blocks; the same-text warning was on the card he pressed.
      await ownerPolicyFor(body, p.memory?.ownCodes ?? [], null)
    : p.memory
      ? await policyFor({
          managerUserId: d.managerUserId,
          peerId: d.peerId,
          body,
          memory: p.memory,
          strip: p.card?.customerLabel ? p.card.customerLabel.split(/[\s,·]+/u) : [],
        })
      : null;
  if (!policy || !policy.ok) {
    // A machine draft with no stored memory (a legacy or hand-made row) cannot be checked again,
    // so it cannot go — written as a block like any other, so the card loses its ✅ and SAYS why,
    // instead of a button that answers «policy» to every press and shows nothing.
    const blocks: PolicyHit[] = policy ? policy.blocks : [{ rule: 'G1', code: 'memory_missing' }];
    await db
      .update(agentDrafts)
      .set({ blocked: true, policy: { ...p, blocks, ...(policy ? { ledger: policy.ledger } : {}) }, updatedAt: new Date() })
      .where(eq(agentDrafts.id, draftId));
    await refreshDraftCard(draftId);
    return { ok: false, code: 'policy_block', detail: blocks.map((b) => b.code).join(',') };
  }

  const moved = await chatMoved(d);
  if (moved) {
    const status = moved === 'taken_over' ? 'taken_over' : 'superseded';
    const [retired] = await db
      .update(agentDrafts)
      .set({ status, updatedAt: new Date() })
      .where(and(eq(agentDrafts.id, draftId), eq(agentDrafts.status, d.status)))
      .returning({ id: agentDrafts.id });
    if (moved === 'taken_over') {
      await refreshDraftCard(draftId);
      return { ok: false, code: 'taken_over' };
    }
    // «Yangi qoralama tayyorlanadi» only where one is coming (`redraftNewest`); otherwise the press AND
    // the card tell him to answer (card-io STALE_WORDS `no_redraft`).
    const coming = retired ? await redraftQuietly(d, moved === 'anchor_edited' ? 'edited' : 'newer') : false;
    if (retired && !coming) {
      await db
        .update(agentDrafts)
        .set({ policy: sql`coalesce(${agentDrafts.policy}, '{}'::jsonb) || ${JSON.stringify({ stale: 'no_redraft' })}::jsonb` })
        .where(eq(agentDrafts.id, draftId));
    }
    await refreshDraftCard(draftId);
    return { ok: false, code: 'superseded', detail: coming ? 'redrafting' : 'no_draft' };
  }

  // Whose chat it is NOW (final review K7). The draft was written for a client
  // or a lead, and the bind may have been taken back since — the web tray's
  // ↩, «Shaxsiy», another code: approving it would queue that customer's name
  // and codes, and land its calculation on that card, in a chat that is no
  // longer theirs. Asked of the server's own identity, the run's: a phone
  // sibling is the same person (fit-12), and a lead that was WON is still the
  // lead its draft was written for (`chatIdentity` keeps it, K25).
  if (await identityMoved(d)) {
    await db
      .update(agentDrafts)
      .set({ status: 'expired', updatedAt: new Date() })
      .where(and(eq(agentDrafts.id, draftId), inArray(agentDrafts.status, ['pending', 'editing'])));
    await refreshDraftCard(draftId, ["↩ Chat endi boshqa mijozga bog'langan (yoki bog'lanmagan) — bu javob ketmaydi."]);
    return { ok: false, code: 'identity_changed' };
  }
  if ((await budgetLeft(d.managerUserId, config!.startedAt, now)) <= 0) return { ok: false, code: 'budget_spent' };

  // The calculation first — the reply promises it (regression-4).
  const calc = actions.find((a): a is Extract<ComposedAction, { type: 'calc_submit' }> => a.type === 'calc_submit');
  let requestId: string | null = null;
  if (calc) {
    const landed = await landCalc(d, calc, actor);
    // Another press is landing this very job: nothing is written here — its own outcome releases the claim (F12).
    if (landed.queueError === 'in_flight') return { ok: false, code: 'calc_in_flight' };
    if (!landed.queued || !landed.requestId) {
      await db
        .update(agentDrafts)
        .set({ actionStatus: 'failed', actionError: landed.queueError ?? 'not_queued', updatedAt: new Date() })
        .where(eq(agentDrafts.id, draftId));
      // The card says why, in words, for as long as it stands (card-io `statusLine`, `calcQueueWords`).
      await refreshDraftCard(draftId);
      return { ok: false, code: 'calc_not_queued', detail: landed.queueError ?? undefined };
    }
    requestId = landed.requestId;
  }

  const sendAt = releaseAt(now, await lastInboundAt(d));
  const approved = await db.transaction(async (tx) => {
    const [row] = await tx
      .update(agentDrafts)
      .set({
        status: 'approved',
        decidedBy: actor.id,
        decidedAt: now,
        updatedAt: now,
        // 'pending' while ANY action is on the draft — the calculation is
        // landed above, the follow-up and the mute run after the commit, and
        // only `runDraftActions` says 'done', when every one has (A10).
        ...(actions.length ? { actionStatus: 'pending', actionError: null } : {}),
      })
      // The status read at the top — `editing` included (with no words of his: a text he typed
      // since makes the row a different card, and the digest above was over the machine's).
      .where(and(eq(agentDrafts.id, draftId), eq(agentDrafts.status, d.status), d.finalBody === null ? isNull(agentDrafts.finalBody) : undefined))
      .returning({ id: agentDrafts.id });
    if (!row) return false;
    await tx.insert(agentOutbox).values({
      draftId,
      managerUserId: d.managerUserId,
      peerId: d.peerId,
      clientId: d.clientId,
      leadId: d.clientId ? null : d.leadId,
      body,
      randomId: mintRandomId(),
      answersTgMessageId: d.anchorTgMessageId,
      queuedBy: actor.id,
      queuedAt: now,
      nextStepAt: sendAt,
      // The night held it (his Q14 ⭐): the approval's age counts from the morning it was promised for (S2).
      releaseAt: sendAt.getTime() > now.getTime() ? sendAt : null,
    });
    if (requestId) {
      await tx
        .insert(agentCalcLinks)
        .values({ requestId, rootRequestId: requestId, managerUserId: d.managerUserId, peerId: d.peerId, draftId })
        .onConflictDoNothing();
    }
    await writeAudit(tx, ctx, {
      entityType: 'agent_draft',
      entityId: draftId,
      action: 'status_change',
      before: { status: d.status },
      after: { status: 'approved', edited: d.finalBody !== null, sendAt: sendAt.toISOString(), requestId },
    });
    return true;
  });
  if (!approved) {
    // The row moved under the press — his own words landed on it between the read and here (the
    // `finalBody` guard above): the draft is live, the card is a different one, and «faol emas» is false.
    const [after] = await db.select({ status: agentDrafts.status }).from(agentDrafts).where(eq(agentDrafts.id, draftId));
    return { ok: false, code: after?.status === 'pending' || after?.status === 'editing' ? 'stale_card' : 'not_live' };
  }
  await runDraftActions(draftId, actor).catch((err: unknown) => logger.error({ err, draftId }, '[agent] actions failed'));
  await refreshDraftCard(draftId);
  return { ok: true, status: 'approved', sendAt, requestId };
}

/**
 * EVERY action of an approved draft, after the commit and re-runnable
 * (build-6, A10): the calculation (landed before the approval — asked again
 * here, and `noteIdFor` makes that a read of the one already landed), a
 * follow-up through the CRM's own door under the approver, a mute on the
 * conversation. 'done' only when all of them have run; a replay — the
 * sweep's, after a crash between the commit and this — writes nothing twice.
 * The outcome is stored on the draft.
 */
export async function runDraftActions(draftId: string, actor: DeciderActor): Promise<void> {
  const [d] = await db.select().from(agentDrafts).where(eq(agentDrafts.id, draftId));
  if (!d || d.actionStatus !== 'pending') return;
  const actions = (d.actions ?? []) as ComposedAction[];
  try {
    for (const a of actions) {
      if (a.type === 'calc_submit') {
        const landed = await landCalc(d, a, actor);
        if (!landed.queued) throw new Error(landed.queueError ?? 'calc_not_queued');
      } else if (a.type === 'set_followup') {
        const kind = d.clientId ? 'client' : 'lead';
        const id = d.clientId ?? d.leadId;
        if (!id) continue;
        const { setFollowUp } = await import('../crm/service');
        await setFollowUp(kind, id, a.date, { actorId: actor.id, viewAll: actor.permissions.has('crm.leads.view_all') });
      } else if (a.type === 'mute') {
        // A replay keeps the first mute's moment — the chat went quiet then.
        await db
          .insert(agentConversations)
          .values({ managerUserId: d.managerUserId, peerId: d.peerId, mutedAt: new Date(), muteReason: a.reason })
          .onConflictDoUpdate({
            target: [agentConversations.managerUserId, agentConversations.peerId],
            // `${table}.column`: inside ON CONFLICT the bare name is the
            // proposed row's as much as the existing one's (#128's cousin).
            set: {
              mutedAt: sql`coalesce(${agentConversations}.muted_at, now())`,
              muteReason: sql`CASE WHEN ${agentConversations}.muted_at IS NULL THEN ${a.reason} ELSE ${agentConversations}.mute_reason END`,
              updatedAt: new Date(),
            },
          });
      }
    }
    await db.update(agentDrafts).set({ actionStatus: 'done', actionError: null }).where(eq(agentDrafts.id, draftId));
  } catch (err) {
    await db
      .update(agentDrafts)
      .set({ actionStatus: 'failed', actionError: err instanceof Error ? err.message.slice(0, 300) : 'error' })
      .where(eq(agentDrafts.id, draftId));
    throw err;
  }
}

/**
 * His own words for a draft (✏️): they become the body, the card comes back
 * with ✅ — never sent on their own, and never rewritten by the model (the map's
 * recommendation; spec §7.1.4 contradicts shadow as written).
 */
export async function submitOwnText(actor: DeciderActor, draftId: string, text: string, ctx: AuditContext): Promise<DecideResult> {
  const [d] = await db.select().from(agentDrafts).where(eq(agentDrafts.id, draftId));
  if (!d) return { ok: false, code: 'not_found' };
  if (d.managerUserId !== actor.id) return { ok: false, code: 'not_account_holder' };
  if (d.status !== 'editing' && d.status !== 'pending') return { ok: false, code: 'not_live', detail: d.status };
  const body = text.trim();
  if (!body) return { ok: false, code: 'empty' };
  const p = (d.policy ?? {}) as Partial<DraftPolicyJson>;
  // His words pass the owner subset; the same-text count is only a warning on his card (K3).
  const policy = await ownerPolicyFor(body, p.memory?.ownCodes ?? [], {
    managerUserId: d.managerUserId,
    peerId: d.peerId,
    strip: p.card?.customerLabel ? p.card.customerLabel.split(/[\s,·]+/u) : [],
  });
  const [row] = await db
    .update(agentDrafts)
    .set({
      finalBody: body,
      status: 'pending',
      blocked: !policy.ok,
      policy: { ...p, blocks: policy.blocks, warnings: policy.warnings, ledger: [] },
      updatedAt: new Date(),
    })
    .where(and(eq(agentDrafts.id, draftId), inArray(agentDrafts.status, ['editing', 'pending'])))
    .returning();
  if (!row) return { ok: false, code: 'not_live' };
  await writeAudit(db, ctx, { entityType: 'agent_draft', entityId: draftId, action: 'update', after: { finalBody: true } });
  await refreshDraftCard(draftId);
  // What the bot answers him (C9): a ✅ only where the card draws one — the policy passed AND the
  // card can show his whole text (card-io `renderDraftCardFull`); the digest is the card's own.
  const tooLong = renderDraftCardFull(row, null).tooLong;
  return {
    ok: true,
    status: 'pending',
    blocked: !policy.ok || tooLong,
    blocks: policy.blocks,
    digest: cardDigest(digestBody(row), (row.actions ?? []) as ComposedAction[]),
    actions: (row.actions ?? []) as ComposedAction[],
  };
}

async function refreshDraftCard(draftId: string, notes: string[] = []): Promise<void> {
  try {
    const { refreshAgentCard } = await import('./card-io');
    await refreshAgentCard(draftId, notes);
  } catch (err) {
    logger.warn({ err, draftId }, '[agent] card not refreshed');
  }
}
