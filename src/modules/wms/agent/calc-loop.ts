import { and, desc, eq, isNull, or } from 'drizzle-orm';
import { db } from '../../platform/db/client';
import {
  agentCalcLinks,
  agentConversations,
  calcRequests,
  calcVersions,
  tgMessageFlags,
  tgMessages,
} from '../../platform/db/schema';
import { logger } from '../../platform/logger';
import { notifyStaffTelegram } from '../../platform/notifications/staff';
import { parseTypedMoney } from '../calc/money-input';
import { agentRunning, readAgentConfig } from './config';
import { chatIdentity } from './context';
import { createDraft } from './drafts';
import { ownerPolicyFor } from './policy-input';

/**
 * The calculation loop (his 8, regression-5, money-4, money-7).
 *
 * The agent sends a job to the VED queue through the bot's own door; when the
 * VED answers — «Готово», a seal, a hand-back, a recalculation, and the AI-VED
 * pre-pass's estimate labelled «rasmiy emas» (his Q5 ⭐ c) — the AGENT OWNER
 * hears it as `AgentCalcAnswered`: its own type, so a «vazifalar» mute never
 * swallows the one message decision 8 exists for, and with NO exceptUserId, so
 * pressing Готово himself still gives him the door (his Q15 ⭐). Resolved through
 * the CHAIN ROOT: a correction is a new request, and its answer still belongs
 * to the chat that asked.
 *
 * The answer's figure is HIS to read (he is the owner) and is never a source
 * the machine may quote (leak-10): «✏️ Narx yozaman» records the client price
 * through `recordOffer` under his own actor, and the reply is the offer's own
 * deterministic text — no model call between his number and the customer.
 */

export type CalcEvent = 'done' | 'sealed' | 'returned' | 'recalc' | 'estimate';

const SECTION_WORDS: Record<string, string> = { yolkira: "yo'lkira", rastamojka: 'rastamojka', podklyuch: 'podklyuch' };

/** The chain's root: walk `supersedes_request_id` up (a correction is a new request, #923). */
export async function chainRoot(requestId: string): Promise<string> {
  let id = requestId;
  for (let i = 0; i < 20; i++) {
    const [row] = await db
      .select({ parent: calcRequests.supersedesRequestId })
      .from(calcRequests)
      .where(eq(calcRequests.id, id));
    if (!row?.parent) return id;
    id = row.parent;
  }
  return id;
}

async function linkFor(requestId: string) {
  const root = await chainRoot(requestId);
  const [link] = await db
    .select()
    .from(agentCalcLinks)
    .where(or(eq(agentCalcLinks.requestId, root), eq(agentCalcLinks.rootRequestId, root), eq(agentCalcLinks.requestId, requestId)))
    .orderBy(desc(agentCalcLinks.createdAt))
    .limit(1);
  return link ?? null;
}

function labelOf(identity: Awaited<ReturnType<typeof chatIdentity>>): string {
  if (identity.clientId) {
    const codes = identity.codes.map((c) => c.clientCode).join(', ');
    return identity.customerName ? `${codes} · ${identity.customerName}` : codes;
  }
  return `Lid: ${identity.customerName ?? '—'}`;
}

/**
 * Tell the agent owner a linked calculation moved. Best-effort: every caller
 * wraps this in its own catch, after its own push — the existing messages
 * must not wait on, or fail with, this one.
 */
export async function announceAgentCalc(
  requestId: string,
  event: CalcEvent,
  detail: { amountText?: string | null; reason?: string | null } = {},
): Promise<boolean> {
  const config = await readAgentConfig();
  if (!config) return false;
  const link = await linkFor(requestId);
  if (!link) return false;
  if (config.ownerUserId !== link.managerUserId) return false;
  const identity = await chatIdentity(link.managerUserId, link.peerId);
  const [req] = await db.select({ section: calcRequests.section }).from(calcRequests).where(eq(calcRequests.id, requestId));
  const section = SECTION_WORDS[req?.section ?? ''] ?? req?.section ?? '';
  const who = labelOf(identity);
  const lines: Record<CalcEvent, string> = {
    done: `💵 Hisob javobi keldi — ${who}\n${section}: ${detail.amountText ?? '—'}\nNarx bersangiz bo'ladi.`,
    sealed: `💵 Hisob muhrlandi — ${who}\n${section}: ${detail.amountText ?? '—'}\nNarx bersangiz bo'ladi.`,
    estimate: `🤖 AI-VED taxmini (rasmiy emas) — ${who}\n${section}: ${detail.amountText ?? '—'}\nVED javobini kuting yoki shu bilan narx bering.`,
    returned: `🔁 VED hisobni qaytardi — ${who}\n${detail.reason ?? ''}`,
    recalc: `🔄 Qayta hisoblanmoqda — ${who}\n${section}: eski narx endi amal qilmaydi.`,
  };
  await notifyStaffTelegram({
    userIds: [link.managerUserId],
    type: 'AgentCalcAnswered',
    text: lines[event],
    extra: { requestId, priceable: event === 'done' || event === 'sealed' || event === 'estimate', event },
  });
  await db
    .update(agentCalcLinks)
    .set({ lastNotifiedKind: event, lastNotifiedAt: new Date() })
    .where(eq(agentCalcLinks.requestId, link.requestId));
  if (event === 'returned' && agentRunning(config)) {
    // The hand-back's question goes to the CUSTOMER as a draft he approves —
    // the seller-facing reason is the model's instruction, never the reply.
    const { runOwnerTriggered } = await import('./run');
    await runOwnerTriggered({
      trigger: 'hand_back',
      managerUserId: link.managerUserId,
      peerId: link.peerId,
      sourceKey: `${requestId}:returned`,
      instruction: `VED hisobni qaytardi, sababi (ichki, mijozga so'zma-so'z aytma): «${detail.reason ?? ''}». Mijozdan yetishmayotganini qisqa so'ra.`,
    }).catch((err: unknown) => logger.error({ err, requestId }, '[agent] hand-back run failed'));
  }
  return true;
}

/** `announceAgentCalc`, never throwing — the shape every calc hook calls. */
export async function announceAgentCalcSafe(
  requestId: string,
  event: CalcEvent,
  detail: { amountText?: string | null; reason?: string | null } = {},
): Promise<void> {
  try {
    await announceAgentCalc(requestId, event, detail);
  } catch (err) {
    logger.error({ err, requestId, event }, '[agent] calc announce failed');
  }
}

export type PriceRefusal = 'not_linked' | 'not_account_holder' | 'bad_number' | 'pending' | 'no_anchor' | 'refused';

/** The customer's language as `recordOffer` speaks it (fa/zh → en, money-4). */
export function offerLocaleOf(locale: string | null): 'uz' | 'ru' | 'en' {
  if (locale === 'ru') return 'ru';
  if (locale === 'uz' || locale === 'uz_cyrl' || locale === null) return 'uz';
  return 'en';
}

/**
 * «✏️ Narx yozaman»: his typed dollars → `recordOffer` on the request's own
 * anchor (its newest seal, else its Готово answer) under HIS actor → a price
 * draft whose body is the offer's own text, in the customer's language.
 */
export async function priceDraftFromText(
  staffId: string,
  requestId: string,
  text: string,
): Promise<{ ok: true; draftId: string } | { ok: false; code: PriceRefusal; detail?: string }> {
  const link = await linkFor(requestId);
  if (!link) return { ok: false, code: 'not_linked' };
  if (link.managerUserId !== staffId) return { ok: false, code: 'not_account_holder' };
  const amount = parseTypedMoney(text.replace(/\$|usd|dollar/giu, ''));
  if (amount === null || !(amount > 0)) return { ok: false, code: 'bad_number' };
  const [req] = await db
    .select({ entityType: calcRequests.entityType, entityId: calcRequests.entityId })
    .from(calcRequests)
    .where(eq(calcRequests.id, requestId));
  if (!req) return { ok: false, code: 'no_anchor' };
  const [version] = await db
    .select({ id: calcVersions.id })
    .from(calcVersions)
    .where(eq(calcVersions.requestId, requestId))
    .orderBy(desc(calcVersions.versionNo))
    .limit(1);
  const [conv] = await db
    .select({ locale: agentConversations.locale })
    .from(agentConversations)
    .where(and(eq(agentConversations.managerUserId, link.managerUserId), eq(agentConversations.peerId, link.peerId)));
  const identity = await chatIdentity(link.managerUserId, link.peerId);
  const { recordOffer } = await import('../calc/workspace');
  let offer;
  try {
    offer = await recordOffer(
      version ? { versionId: version.id } : { requestId },
      {
        clientPriceUsd: amount,
        locale: offerLocaleOf(conv?.locale ?? null),
        clientName: identity.customerName,
        mayApprove: false,
        expect: { entityType: req.entityType === 'lead' ? 'lead' : 'deal', entityId: req.entityId },
      },
      { actorId: staffId },
    );
  } catch (err) {
    return { ok: false, code: 'refused', detail: (err as { code?: string }).code ?? (err instanceof Error ? err.message : 'error') };
  }
  if (offer.pending || !offer.text) return { ok: false, code: 'pending' };

  // The draft answers the chat's newest live inbound.
  const [anchor] = await db
    .select({ tgMessageId: tgMessages.tgMessageId, editedAt: tgMessages.editedAt })
    .from(tgMessages)
    .leftJoin(tgMessageFlags, eq(tgMessageFlags.messageId, tgMessages.id))
    .where(
      and(
        eq(tgMessages.managerUserId, link.managerUserId),
        eq(tgMessages.peerId, link.peerId),
        eq(tgMessages.direction, 'in'),
        isNull(tgMessageFlags.deletedAt),
      ),
    )
    .orderBy(desc(tgMessages.sentAt))
    .limit(1);
  if (!anchor) return { ok: false, code: 'no_anchor' };
  const policy = await ownerPolicyFor(offer.text, identity.codes.map((c) => c.clientCode));
  const written = await createDraft({
    runId: null,
    managerUserId: link.managerUserId,
    peerId: link.peerId,
    clientId: identity.clientId,
    leadId: identity.leadId,
    identityStrength: identity.strength,
    anchorTgMessageId: anchor.tgMessageId,
    anchorEditedAt: anchor.editedAt,
    kind: 'price',
    body: offer.text,
    glossUz: null,
    language: conv?.locale ?? null,
    category: 'price',
    confidence: null,
    nextStep: 'quote',
    policy: {
      blocks: policy.blocks,
      warnings: policy.warnings,
      ledger: [],
      memory: {
        language: (conv?.locale as never) ?? 'uz',
        customerScript: null,
        sources: [{ value: amount, kind: 'money', label: 'sizning narxingiz' }],
        allowedPhones: [],
        allowedUrls: [],
        mapUrls: [],
        askedLocation: false,
        hasEstimate: false,
        ownCodes: identity.codes.map((c) => c.clientCode),
        managerName: identity.managerName,
        canary: '',
      },
      card: { customerLabel: labelOf(identity), lastOut: null, customerLines: [] },
      notes: [`Narx: ${amount} $ — taklif sifatida yozildi (${offer.belowFloor ? 'poldan past' : 'pol ustida'}).`],
    },
    blocked: !policy.ok,
    needsOwner: false,
    ownerQuestion: null,
    actions: [],
    citedMessageIds: [],
    offerId: offer.id,
  });
  if (written.kind === 'editing') return { ok: false, code: 'refused', detail: 'editing' };
  return { ok: true, draftId: written.draftId };
}
