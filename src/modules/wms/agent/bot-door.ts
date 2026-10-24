import { and, desc, eq, sql } from 'drizzle-orm';
import { db } from '../../platform/db/client';
import { agentConversations, agentDrafts, clients, notifications, tgChatRules, tgPeerPulls } from '../../platform/db/schema';
import { logger } from '../../platform/logger';
import { notifyStaffTelegram } from '../../platform/notifications/staff';
import { actorGrants } from '../../platform/rbac/authorize';
import { agentRunning, readAgentConfig, setAgentMode, AgentConfigError } from './config';
import { decideDraft, submitOwnText, type DecideRefusal } from './decide';
import { KbError, writeKbFact } from './kb';
import { priceDraftFromText, type PriceRefusal } from './calc-loop';
import type { DraftPolicyJson } from './types';

/**
 * The bot's side of the agent, as plain functions the grammY shell calls
 * (platform reaches wms by dynamic import — the startBoss crossing). Every
 * answer is WORDS: a refusal the person cannot read is a button that «does
 * nothing».
 */

export type AgentOp = 's' | 'e' | 'r' | 'h' | 'p' | 'n' | 'k' | 'x' | 'c' | 'b' | 'g' | 'u' | 'z';
export type AgentWaitKind = 'agent_edit' | 'agent_price' | 'agent_code';

export interface PressAnswer {
  toast: string;
  reply?: string;
  /** A one-text wait the shell arms (and drops the other agent waits). */
  arm?: { kind: AgentWaitKind; payload: Record<string, string> };
  /** Drop this wait (the press answered it). */
  drop?: AgentWaitKind;
}

const DECIDE_WORDS: Record<DecideRefusal, string> = {
  not_found: 'Qoralama topilmadi.',
  not_account_holder: "Bu qoralama sizning akkauntingizdan emas — faqat akkaunt egasi tasdiqlaydi.",
  agent_off: "AI sotuvchi o'chirilgan.",
  not_live: 'Bu qoralama endi faol emas.',
  editing: "Avval o'z matningizni yozing.",
  stale_card: "Karta o'zgargan — yangi kartadagi ✅ ni bosing.",
  policy_block: "Qoidaga to'g'ri kelmaydi — ✏️ bilan o'zingiz yozing.",
  listener_behind: "Telegram ko'prigi (tinglovchi) yangilanmagan — xabar ketmaydi. Serverda tg-listen'ni qayta quring.",
  sending_disabled: "CRM'dan Telegramga yuborish o'chirilgan (Sozlamalar) — javob ketmaydi. Matnni nusxalab o'zingiz yuboring.",
  superseded: 'Mijoz yana yozdi — yangi qoralama tayyorlanadi.',
  taken_over: "Siz allaqachon o'zingiz javob bergansiz.",
  budget_spent: "Bugungi AI yuborish chegarasi tugadi — matnni nusxalab o'zingiz yuboring.",
  calc_not_queued: 'Hisoblatish navbatga tushmadi — javob yuborilmadi.',
  empty: "Javob bo'sh.",
};

const PRICE_WORDS: Record<PriceRefusal, string> = {
  not_linked: "Bu hisob AI sotuvchi orqali yuborilmagan.",
  not_account_holder: 'Bu suhbat sizning akkauntingizda emas.',
  bad_number: "Narxni dollarda son bilan yozing, masalan: 1250",
  pending: "Narx poldan past — tasdiq kutilmoqda. Mijozga hech narsa yozilmadi.",
  no_anchor: "Bu hisobning narxi yoki javobi topilmadi.",
  refused: 'Narx yozilmadi',
};

function hhmm(d: Date): string {
  const t = new Date(d.getTime() + 5 * 3_600_000);
  return `${String(t.getUTCHours()).padStart(2, '0')}:${String(t.getUTCMinutes()).padStart(2, '0')}`;
}

async function deciderFor(userId: string) {
  const grants = await actorGrants(userId);
  return { id: userId, roles: grants.roles, permissions: grants.permissions };
}

/** One press of an agent button. `staffId` is the chat's linked person — never an id from the button. */
export async function agentPress(staffId: string, op: AgentOp, id: string, digest: string | undefined): Promise<PressAnswer> {
  const actor = await deciderFor(staffId);
  const ctx = { actorId: staffId };
  switch (op) {
    case 's': {
      const r = await decideDraft(actor, id, 'send', { digest: digest ?? null }, ctx);
      if (!r.ok) {
        // Both refusals leave him to send it himself — so the text comes with the words.
        if (r.code === 'budget_spent' || r.code === 'sending_disabled') {
          const [d] = await db.select({ body: agentDrafts.finalBody, proposed: agentDrafts.proposedBody }).from(agentDrafts).where(eq(agentDrafts.id, id));
          const toast = r.code === 'budget_spent' ? '⛔ Chegara tugadi' : '⛔ Yuborish o‘chirilgan';
          return { toast, reply: `${DECIDE_WORDS[r.code]}\n\n${d?.body ?? d?.proposed ?? ''}` };
        }
        return { toast: DECIDE_WORDS[r.code].slice(0, 190), reply: r.code === 'listener_behind' ? DECIDE_WORDS.listener_behind : undefined };
      }
      const soon = !r.sendAt || r.sendAt.getTime() <= Date.now() + 60_000;
      return { toast: soon ? '✅ Yuborilmoqda' : `✅ ${hhmm(r.sendAt!)} da ketadi` };
    }
    case 'e': {
      const r = await decideDraft(actor, id, 'edit', {}, ctx);
      if (!r.ok) return { toast: DECIDE_WORDS[r.code].slice(0, 190) };
      return {
        toast: '✏️',
        reply: "✏️ Mijozga ketadigan javobni yozing — shu kartaga javob (reply) qilib yoki oddiy xabar bilan. Men uni kartaga qo'yaman, siz ✅ bosasiz.",
        arm: { kind: 'agent_edit', payload: { draftId: id } },
      };
    }
    case 'r':
    case 'h': {
      const r = await decideDraft(actor, id, op === 'r' ? 'reject' : 'human', {}, ctx);
      if (!r.ok) return { toast: DECIDE_WORDS[r.code].slice(0, 190) };
      return { toast: op === 'r' ? '❌ Rad etildi' : '🙋 Suhbat 24 soat sizniki', drop: 'agent_edit' };
    }
    case 'p': {
      return {
        toast: '💵',
        reply: "💵 Mijozga beriladigan narxni dollarda yozing (masalan 1250). Men uni taklif sifatida yozib, mijoz tilida qoralama tayyorlayman — siz ✅ bosasiz.",
        arm: { kind: 'agent_price', payload: { requestId: id } },
      };
    }
    case 'g':
    case 'u':
    case 'z':
      return kbPress(staffId, op, id);
    case 'n':
    case 'k':
    case 'x':
    case 'c':
    case 'b':
      return strangerPress(staffId, op, id, digest);
  }
}

/**
 * His typed text, for the agent: a reply (swipe) to an agent card names its
 * own target; otherwise the one live agent wait does. Null = not the agent's.
 */
export async function agentText(
  staffId: string,
  target: { kind: AgentWaitKind; payload: Record<string, string> } | null,
  text: string,
): Promise<string | null> {
  if (!target) return null;
  const actor = await deciderFor(staffId);
  const ctx = { actorId: staffId };
  if (target.kind === 'agent_edit') {
    const r = await submitOwnText(actor, target.payload.draftId!, text, ctx);
    return r.ok ? '✏️ Matningiz kartaga qo‘yildi — tekshirib ✅ bosing.' : DECIDE_WORDS[r.code];
  }
  if (target.kind === 'agent_price') {
    const r = await priceDraftFromText(staffId, target.payload.requestId!, text);
    if (r.ok) return '💵 Narx taklif sifatida yozildi — qoralama kartasini tekshirib ✅ bosing.';
    return r.code === 'refused' ? `${PRICE_WORDS.refused}: ${r.detail ?? ''}` : PRICE_WORDS[r.code];
  }
  return codeEcho(staffId, target.payload.ruleId!, text);
}

/** Which agent card a swipe-reply answers — resolved from HIS OWN notification row by `payload.tg` (reply-door's rule). */
export async function agentCardFor(
  staffId: string,
  chatId: bigint,
  messageId: number,
): Promise<{ kind: AgentWaitKind; payload: Record<string, string> } | null> {
  const [row] = await db
    .select({ type: notifications.type, payload: notifications.payload })
    .from(notifications)
    .where(
      and(
        eq(notifications.userId, staffId),
        sql`${notifications.type} IN ('AgentDraft', 'AgentCalcAnswered')`,
        sql`(${notifications.payload}->'tg'->>'chatId') = ${String(chatId)}`,
        sql`(${notifications.payload}->'tg'->>'messageId') = ${String(messageId)}`,
      ),
    )
    .orderBy(desc(notifications.createdAt))
    .limit(1);
  if (!row) return null;
  const p = row.payload as Record<string, unknown>;
  // A swipe-reply IS an edit: `submitOwnText` takes a pending draft as well as an editing one.
  if (row.type === 'AgentDraft' && typeof p.draftId === 'string') return { kind: 'agent_edit', payload: { draftId: p.draftId } };
  if (row.type === 'AgentCalcAnswered' && typeof p.requestId === 'string' && p.priceable === true) {
    return { kind: 'agent_price', payload: { requestId: p.requestId } };
  }
  return null;
}

async function kbPress(staffId: string, op: 'g' | 'u' | 'z', draftId: string): Promise<PressAnswer> {
  const [d] = await db.select().from(agentDrafts).where(eq(agentDrafts.id, draftId));
  if (!d || d.managerUserId !== staffId) return { toast: 'Topilmadi' };
  // The card offers this only under an APPROVED answer of his own to a question
  // the machine asked (card-io `kbAsk`); a forged press on anything else is refused.
  if (d.status !== 'approved' || !d.needsOwner || !d.finalBody) return { toast: 'Topilmadi' };
  const p = (d.policy ?? {}) as Partial<DraftPolicyJson> & { kb?: string };
  if (p.kb === 'saved' || p.kb === 'skipped') return { toast: 'Allaqachon hal qilingan' };
  const setKb = async (kb: string) => {
    await db.update(agentDrafts).set({ policy: { ...p, kb } }).where(eq(agentDrafts.id, draftId));
    const { refreshAgentCard } = await import('./card-io');
    await refreshAgentCard(draftId);
  };
  if (op === 'z') {
    await setKb('skipped');
    return { toast: '✖ Saqlanmadi' };
  }
  if (op === 'g' && p.kb !== 'general_armed') {
    // A general fact is read in EVERY chat: the first press only asks (leak-2).
    await setKb('general_armed');
    return { toast: '📌 Yana bir marta bosing', reply: "📌 Bu javob BARCHA mijozlarga qo'llanadi. Rozi bo'lsangiz, «📌 Umumiy qoida» ni yana bir marta bosing." };
  }
  try {
    const names = await db.select({ name: clients.name }).from(clients).where(eq(clients.id, d.clientId ?? '00000000-0000-0000-0000-000000000000'));
    await writeKbFact(
      {
        scope: op === 'g' ? 'general' : d.clientId ? 'client' : 'lead',
        clientId: op === 'g' ? null : d.clientId,
        leadId: op === 'g' ? null : d.clientId ? null : d.leadId,
        question: d.ownerQuestion,
        answer: d.finalBody ?? '',
        locale: d.language,
        sourceRef: { draftId },
        knownNames: names.map((n) => n.name),
      },
      { actorId: staffId },
    );
  } catch (err) {
    if (err instanceof KbError) {
      const words: Record<string, string> = {
        money: "Narx bilimga yozilmaydi — narx «💵 Narx yozaman» orqali beriladi.",
        personal: "Matnda mijoz ma'lumoti bor — «👤 Faqat shu mijoz» ni tanlang.",
        empty: "Matn bo'sh.",
        too_long: 'Matn juda uzun.',
        scope: "Bu chat mijoz yoki lidga bog'lanmagan.",
      };
      return { toast: '⚠️', reply: words[err.code] ?? err.code };
    }
    throw err;
  }
  await setKb('saved');
  return { toast: op === 'g' ? '📌 Umumiy qoida saqlandi' : '👤 Shu mijoz uchun saqlandi' };
}

/** The stranger card's buttons (§17.11): a lead, a client by its code (echoed first), or personal. */
async function strangerPress(
  staffId: string,
  op: 'n' | 'k' | 'x' | 'c' | 'b',
  ruleId: string,
  echoedTail: string | undefined,
): Promise<PressAnswer> {
  const [rule] = await db.select().from(tgChatRules).where(eq(tgChatRules.id, ruleId));
  if (!rule || rule.managerUserId !== staffId) return { toast: 'Topilmadi' };
  const ctx = { actorId: staffId };
  const { decideChat, openLeadForChat } = await import('../crm/chat-rules');
  if (op === 'x') {
    await decideChat({ id: ruleId, decision: 'exclude' }, ctx);
    return { toast: '🚫 Shaxsiy — saqlanmaydi' };
  }
  if (op === 'n') {
    try {
      await openLeadForChat(ruleId, ctx);
    } catch (err) {
      return { toast: '⚠️', reply: `Lid ochilmadi: ${(err as { code?: string }).code ?? (err instanceof Error ? err.message : '')}` };
    }
    await queuePull(staffId, rule.peerId);
    return { toast: '🆕 Lid ochildi' };
  }
  if (op === 'k') {
    return { toast: '👤', reply: 'Mijoz kodini yozing (masalan GS777).', arm: { kind: 'agent_code', payload: { ruleId } } };
  }
  if (op === 'b') {
    await db
      .update(agentConversations)
      .set({ identityClientId: null, identityStrength: null, updatedAt: new Date() })
      .where(and(eq(agentConversations.managerUserId, staffId), eq(agentConversations.peerId, rule.peerId)));
    return { toast: '↩ Bekor qilindi' };
  }
  // 'c' — the echo was right: the chat is this client's, by a code HE typed.
  const [conv] = await db
    .select({ clientId: agentConversations.identityClientId })
    .from(agentConversations)
    .where(and(eq(agentConversations.managerUserId, staffId), eq(agentConversations.peerId, rule.peerId)));
  if (!conv?.clientId) return { toast: 'Kod topilmadi — qaytadan yozing' };
  // The card confirms the code IT showed (leak-4): a newer typed code needs its own card.
  if (!echoedTail || conv.clientId.slice(-8).toLowerCase() !== echoedTail) return { toast: 'Kod o‘zgargan — oxirgi kartani tasdiqlang' };
  await decideChat({ id: ruleId, decision: 'include', clientId: conv.clientId }, ctx);
  await db
    .update(agentConversations)
    .set({ identityStrength: 'typed_code', updatedAt: new Date() })
    .where(and(eq(agentConversations.managerUserId, staffId), eq(agentConversations.peerId, rule.peerId)));
  await queuePull(staffId, rule.peerId);
  return { toast: '✅ Bog‘landi' };
}

/** The typed code, echoed before anything is written (leak-4, winLead's idiom). */
async function codeEcho(staffId: string, ruleId: string, text: string): Promise<string> {
  const code = text.trim().toUpperCase();
  if (!/^[A-Z0-9]{2,10}$/u.test(code)) return 'Kod bitta so‘z bo‘lishi kerak, masalan GS777.';
  const [rule] = await db.select().from(tgChatRules).where(eq(tgChatRules.id, ruleId));
  if (!rule || rule.managerUserId !== staffId) return 'Topilmadi.';
  const [client] = await db
    .select({ id: clients.id, code: clients.clientCode, name: clients.name, phones: clients.phones })
    .from(clients)
    .where(eq(clients.clientCode, code));
  if (!client) return `${code} — bunday kod yo'q.`;
  await db
    .insert(agentConversations)
    .values({ managerUserId: staffId, peerId: rule.peerId, identityClientId: client.id })
    .onConflictDoUpdate({
      target: [agentConversations.managerUserId, agentConversations.peerId],
      set: { identityClientId: client.id, identityStrength: null, updatedAt: new Date() },
    });
  const phones = Array.isArray(client.phones) ? (client.phones as string[]).join(', ') : '';
  const chatPhone = rule.peerPhone ?? 'yashirin';
  await notifyStaffTelegram({
    userIds: [staffId],
    type: 'AgentCodeEcho',
    text: `👤 Shu mijozmi?\n${client.code} · ${client.name}\nKartadagi raqamlar: ${phones || '—'}\nChat raqami: ${chatPhone}\n\nChat raqami kartada bo'lmasa, AI bu chatda yuk va qarzni aytmaydi.`,
    extra: { ruleId, clientId: client.id },
  });
  return '👆 Tekshiring va tasdiqlang.';
}

/** One stranger's chat pulled into the CRM by the listener (tg_peer_pulls, one open per chat). */
async function queuePull(managerUserId: string, peerId: bigint): Promise<void> {
  await db
    .insert(tgPeerPulls)
    .values({ managerUserId, peerId, requestedBy: managerUserId })
    .onConflictDoNothing()
    .catch((err: unknown) => logger.warn({ err }, '[agent] pull not queued'));
}

/** «/agent», «/agent on», «/agent off» — the bot's kill switch (spec §1, his 16 ⭐). */
export async function agentCommand(staffId: string, arg: string): Promise<string> {
  const actor = await deciderFor(staffId);
  const config = await readAgentConfig();
  if (!config) return "AI sotuvchi hali o'rnatilmagan (baza yangilanmagan).";
  const want = arg.trim().toLowerCase();
  if (want === 'off' || want === 'on') {
    try {
      const r = await setAgentMode(actor, want === 'on' ? 'shadow' : 'off', { actorId: staffId });
      if (want === 'off' && r.expiredDraftIds.length > 0) {
        const { refreshAgentCard } = await import('./card-io');
        for (const id of r.expiredDraftIds) await refreshAgentCard(id).catch(() => {});
      }
      return want === 'on'
        ? '🤖 AI sotuvchi yoqildi — har bir javobni o‘zingiz tasdiqlaysiz.'
        : `⏹ AI sotuvchi o'chirildi. Navbatdan olindi: ${r.cancelledOutboxIds.length}, qoralamalar: ${r.expiredDraftIds.length}.`;
    } catch (err) {
      if (err instanceof AgentConfigError) {
        const words: Record<string, string> = {
          forbidden: "Bu buyruq faqat AI egasi yoki super admin uchun.",
          not_account_holder: "Yoqishni faqat Telegram akkaunti AI'ga ulangan odam qiladi.",
          no_owner: "Avval «Suhbatlar → AI sotuvchi» sahifasida akkaunt tanlang.",
          session_not_confirmed: "Avval sahifada «Eski serverda Telegram sessiyasi yo'q qilindi» ni tasdiqlang.",
          owner_not_connected: "AI egasining Telegram akkaunti ulanmagan.",
          not_ready: 'Baza yangilanmagan.',
        };
        return words[err.code] ?? err.code;
      }
      throw err;
    }
  }
  const running = agentRunning(config);
  return running ? '🤖 AI sotuvchi ishlayapti (soya rejimi). O‘chirish: /agent off' : "⏹ AI sotuvchi o'chiq. Yoqish: /agent on";
}

/** A second ✏️ elsewhere: the first draft is no longer being edited — never silently re-targeted (leak-6). */
export async function releaseEdit(staffId: string, draftId: string): Promise<void> {
  const rows = await db
    .update(agentDrafts)
    .set({ status: 'pending', updatedAt: new Date() })
    .where(and(eq(agentDrafts.id, draftId), eq(agentDrafts.status, 'editing'), eq(agentDrafts.managerUserId, staffId)))
    .returning({ id: agentDrafts.id });
  if (rows.length === 0) return;
  const { refreshAgentCard } = await import('./card-io');
  await refreshAgentCard(draftId, ["✏️ Tahrir bekor — boshqa qoralamani tahrirlayapsiz."]);
}
