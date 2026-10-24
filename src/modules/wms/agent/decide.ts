import { randomBytes } from 'node:crypto';
import { and, desc, eq, gt, inArray, sql } from 'drizzle-orm';
import { v5 as uuidv5 } from 'uuid';
import { writeAudit, type AuditContext } from '../../platform/audit/service';
import { db } from '../../platform/db/client';
import {
  agentCalcLinks,
  agentConversations,
  agentDrafts,
  agentOutbox,
  calcRequests,
  leads,
  tgAccounts,
  tgMessageFlags,
  tgMessages,
  users,
} from '../../platform/db/schema';
import { logger } from '../../platform/logger';
import { getSetting } from '../../platform/settings/service';
import { readGuard } from '../crm/account-guard';
import { cardDigest } from './card';
import { agentRunning, readAgentConfig } from './config';
import { chatIdentity } from './context';
import { AGENT_LIMITS } from './limits';
import { zoneForOrigin } from './origin';
import { ownerPolicyFor, policyFor } from './policy-input';
import { releaseAt } from './send-step';
import { sendsToday } from './today';
import { isNudge } from './worthy';
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
  | 'empty';

export type DecideResult =
  | { ok: true; status: string; sendAt?: Date; requestId?: string | null }
  | { ok: false; code: DecideRefusal; detail?: string };

export interface DeciderActor {
  id: string;
  roles: readonly string[];
  permissions: ReadonlySet<string>;
}

const NOTE_NS = '4f1c2b1e-0136-4a51-9c1e-5a6d7e8f9a0b';
/** The intake note's id for a draft — the landing is re-runnable without a second note (build-6). */
export const noteIdFor = (draftId: string) => uuidv5(draftId, NOTE_NS);

/** A positive 63-bit random id — Telegram's dedup key, minted ONCE per approved reply (ban-5). */
export function mintRandomId(): bigint {
  const b = randomBytes(8);
  b[0] = b[0]! & 0x7f;
  const v = b.readBigInt64BE(0);
  return v === 0n ? 1n : v;
}

async function chatMoved(d: typeof agentDrafts.$inferSelect): Promise<'superseded' | 'taken_over' | 'anchor_edited' | null> {
  const [anchor] = await db
    .select({ sentAt: tgMessages.sentAt, editedAt: tgMessages.editedAt })
    .from(tgMessages)
    .where(and(eq(tgMessages.managerUserId, d.managerUserId), eq(tgMessages.peerId, d.peerId), eq(tgMessages.tgMessageId, d.anchorTgMessageId)));
  if (!anchor) return 'superseded';
  if (anchor.editedAt && (!d.anchorEditedAt || anchor.editedAt.getTime() > d.anchorEditedAt.getTime())) return 'anchor_edited';
  const newer = await db
    .select({ id: tgMessages.id, direction: tgMessages.direction, body: tgMessages.body, tgMessageId: tgMessages.tgMessageId, deletedAt: tgMessageFlags.deletedAt })
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
  if (live.some((m) => m.direction === 'in' && !isNudge(m.body ?? ''))) return 'superseded';
  return null;
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
 * The calculation, landed (or found already landed) — through the bot's own
 * door, `landIntake`, so the job reaches the same queue, the same AI VED
 * pre-pass and the same stage move as one a seller collected.
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
    return { queued: req !== undefined, requestId: req?.id ?? null, queueError: req ? null : 'already_landed' };
  }
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
  const target = await landIntake({
    noteId,
    section: action.section,
    facts: action.facts,
    steps: [
      "AI sotuvchi mijozning Telegram suhbatidan yig'di, egasi tasdiqladi.",
      // His 9 (2026-10-24): «kelib chiqish sertifikati bor, biz o'zimiz olamiz».
      "Kelib chiqish sertifikati: kompaniya o'zi oladi",
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
    // The zone the bot's own buttons would choose for the place the customer
    // named (Kashgar → kashgar, Horgos → horgos, Yiwu/Guangzhou → cn), or
    // none — the VED chooses; never «cn» by default (review A11).
    freightZone: action.section === 'podklyuch' ? zoneForOrigin(action.facts.fromCity ?? null) : null,
  });
  return { queued: target.queued === true && Boolean(target.requestId), requestId: target.requestId ?? null, queueError: target.queueError ?? null };
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
    const changed = await db.transaction(async (tx) => {
      const [row] = await tx
        .update(agentDrafts)
        .set({
          status,
          updatedAt: new Date(),
          ...(decision === 'edit' ? {} : { decidedBy: actor.id, decidedAt: new Date() }),
        })
        .where(and(eq(agentDrafts.id, draftId), inArray(agentDrafts.status, ['pending', 'editing'])))
        .returning({ id: agentDrafts.id });
      if (!row) return false;
      if (decision === 'human') {
        const until = new Date(Date.now() + 24 * 3_600_000);
        await tx
          .insert(agentConversations)
          .values({ managerUserId: d.managerUserId, peerId: d.peerId, humanUntil: until })
          .onConflictDoUpdate({
            target: [agentConversations.managerUserId, agentConversations.peerId],
            set: { humanUntil: until, updatedAt: new Date() },
          });
      }
      if (decision !== 'edit') {
        await writeAudit(tx, ctx, { entityType: 'agent_draft', entityId: draftId, action: 'status_change', before: { status: d.status }, after: { status } });
      }
      return true;
    });
    if (!changed) return { ok: false, code: 'not_live' };
    await refreshDraftCard(draftId);
    return { ok: true, status };
  }

  // ✅
  if (d.status === 'editing') return { ok: false, code: 'editing' };
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
  if (!guard?.agentPumpAt || now.getTime() - guard.agentPumpAt.getTime() > AGENT_LIMITS.pumpFreshMs) {
    return { ok: false, code: 'listener_behind' };
  }

  const p = (d.policy ?? {}) as Partial<DraftPolicyJson>;
  // His own words — typed, or the offer text made from his typed price — pass
  // the owner subset; the machine's pass the whole policy again.
  const policy = d.finalBody || d.kind === 'price'
    ? await ownerPolicyFor(body, p.memory?.ownCodes ?? [])
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
    if (policy) {
      await db
        .update(agentDrafts)
        .set({ blocked: true, policy: { ...p, blocks: policy.blocks, ledger: policy.ledger }, updatedAt: new Date() })
        .where(eq(agentDrafts.id, draftId));
      await refreshDraftCard(draftId);
    }
    return { ok: false, code: 'policy_block', detail: policy?.blocks.map((b) => b.code).join(',') };
  }

  const moved = await chatMoved(d);
  if (moved) {
    const status = moved === 'taken_over' ? 'taken_over' : 'superseded';
    await db.update(agentDrafts).set({ status, updatedAt: new Date() }).where(and(eq(agentDrafts.id, draftId), eq(agentDrafts.status, 'pending')));
    await refreshDraftCard(draftId);
    return { ok: false, code: moved === 'taken_over' ? 'taken_over' : 'superseded' };
  }
  if ((await budgetLeft(d.managerUserId, config!.startedAt, now)) <= 0) return { ok: false, code: 'budget_spent' };

  // The calculation first — the reply promises it (regression-4).
  const calc = actions.find((a): a is Extract<ComposedAction, { type: 'calc_submit' }> => a.type === 'calc_submit');
  let requestId: string | null = null;
  if (calc) {
    const landed = await landCalc(d, calc, actor);
    if (!landed.queued || !landed.requestId) {
      await db
        .update(agentDrafts)
        .set({ actionStatus: 'failed', actionError: landed.queueError ?? 'not_queued', updatedAt: new Date() })
        .where(eq(agentDrafts.id, draftId));
      await refreshDraftCard(draftId, [`Hisoblatish navbatga tushmadi (${landed.queueError ?? '—'}) — javob yuborilmadi. Kartadan qo'lda yuboring yoki matnni o'zgartiring.`]);
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
      .where(and(eq(agentDrafts.id, draftId), eq(agentDrafts.status, 'pending')))
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
      before: { status: 'pending' },
      after: { status: 'approved', edited: d.finalBody !== null, sendAt: sendAt.toISOString(), requestId },
    });
    return true;
  });
  if (!approved) return { ok: false, code: 'not_live' };
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
  const policy = await ownerPolicyFor(body, p.memory?.ownCodes ?? []);
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
    .returning({ id: agentDrafts.id });
  if (!row) return { ok: false, code: 'not_live' };
  await writeAudit(db, ctx, { entityType: 'agent_draft', entityId: draftId, action: 'update', after: { finalBody: true } });
  await refreshDraftCard(draftId);
  return { ok: true, status: 'pending' };
}

async function refreshDraftCard(draftId: string, notes: string[] = []): Promise<void> {
  try {
    const { refreshAgentCard } = await import('./card-io');
    await refreshAgentCard(draftId, notes);
  } catch (err) {
    logger.warn({ err, draftId }, '[agent] card not refreshed');
  }
}
