import { and, eq } from 'drizzle-orm';
import { db } from '../../platform/db/client';
import { calcRequests, clients, deals, leads } from '../../platform/db/schema';
import { logger } from '../../platform/logger';
import type { CalcOpenAs, CalcPingType } from '../../platform/notifications/calc-ping';
import { notifyStaffTelegram, userName } from '../../platform/notifications/staff';
import { userPermissions } from '../../platform/rbac/authorize';
import { clipText, groupDigits, usd } from '../../platform/telegram/format';
import { tashkentDay } from '../../platform/time/tashkent';
import { mayOpenLead } from '../crm/lead-door';
import { canWriteDeal } from '../deals/door';
import { calcJobDoorFor } from './card-door';
import { quoteNoFor, registryGoods } from './chain';
import { perM3Of } from './channel-post';
import { SECTION_LABEL } from './intake';
import { isCalcSection } from './labels';

/**
 * The five calc pings — «🧮 Hisob tayyor», «✅ Hisoblash tayyor», «olindi»,
 * «qaytarildi», «qayta hisoblanmoqda» — said in full (the owner's answers of
 * 2026-11-19): which client, which card, which goods, the route, and the
 * money with its $/m³ (his 9: «$/kub ham qo‘shilsin»).
 *
 * ONE facts source and ONE renderer, read by all five (#513). They used to be
 * five template strings over `requestLabel`, each an UNCAUGHT read after the
 * job had already closed — a throw there lost the one message that tells the
 * seller, and a second press reads «already closed» (R12). Here nothing
 * throws: the facts, the reader's grants and the extras are each read in
 * their own catch, and a ping whose facts could not be read still goes, as
 * its kind's title and its money, with no line that needed the database.
 *
 * Rendered PER RECIPIENT (D9), because two of its lines are behind the door
 * of the card they describe (SEC-9): the client and the deal's title go only
 * to whom the deal card admits (`canWriteDeal`), a lead's phone and company
 * only to whom the lead card admits (`mayOpenLead` — `crm.leads` alone is not
 * enough). The link is the same reader's door (`calcJobDoorFor`), absolute so
 * the drain lifts it into the button, and the button says which door it is.
 *
 * Money is the price alone — the sealed total or the typed answer, and its
 * per-m³ — never the customs/freight split (law 10) and never the VED's
 * internal note: this file reads named columns only and its facts type
 * carries no money and no note at all (a key test pins it; the internal-note
 * fence lists this file).
 */

/**
 * What one request is, for its pings — strings, counts and measures only: no
 * money, no note, no offer, nothing a client price could ride in (pinned by a
 * key test). Read FRESH at send time — a reassigned owner is the case the
 * second recipient exists for.
 */
export interface CalcRequestFacts {
  requestId: string;
  entityType: 'lead' | 'deal';
  entityId: string;
  /** `requestLabel`'s rule: the deal's code, the lead's name — «—» when the card is gone. */
  cardLabel: string;
  clientCode: string | null;
  clientName: string | null;
  dealTitle: string | null;
  leadPhone: string | null;
  leadCompany: string | null;
  /** The lead's owner — what `mayOpenLead` and the door ask. Null on a deal. */
  leadOwnerId: string | null;
  /** The card's CURRENT owner (the lead's or the deal's). */
  cardOwnerId: string | null;
  requestedBy: string;
  section: string | null;
  fromCity: string | null;
  toCity: string | null;
  /** The request's own columns, as the queue reads them — never summed from items. */
  weightKg: number | null;
  volumeM3: number | null;
  /** The first three goods names, in the request's order (`registryGoods`). */
  goodsFirst: string[];
  goodsCount: number;
}

const toNum = (value: string | null): number | null => {
  if (value === null) return null;
  const n = Number(value);
  return Number.isFinite(n) ? n : null;
};

/**
 * The facts of one request — ONE statement over named columns (never a
 * whole-row read of `calc_requests`, which carries the VED's internal note,
 * SEC-10) and the registry's grouped goods read. Pool reads: every caller is
 * after its own commit (#714). Null: no such request.
 */
export async function calcRequestFacts(requestId: string): Promise<CalcRequestFacts | null> {
  const [row] = await db
    .select({
      entityType: calcRequests.entityType,
      entityId: calcRequests.entityId,
      requestedBy: calcRequests.requestedBy,
      section: calcRequests.section,
      fromCity: calcRequests.fromCity,
      toCity: calcRequests.toCity,
      weightKg: calcRequests.weightKg,
      volumeM3: calcRequests.volumeM3,
      dealCode: deals.code,
      dealTitle: deals.title,
      dealOwnerId: deals.ownerId,
      clientCode: clients.clientCode,
      clientName: clients.name,
      leadName: leads.name,
      leadPhone: leads.phone,
      leadCompany: leads.company,
      leadOwnerId: leads.ownerId,
    })
    .from(calcRequests)
    .leftJoin(deals, and(eq(calcRequests.entityType, 'deal'), eq(deals.id, calcRequests.entityId)))
    .leftJoin(clients, eq(clients.id, deals.clientId))
    .leftJoin(leads, and(eq(calcRequests.entityType, 'lead'), eq(leads.id, calcRequests.entityId)))
    .where(eq(calcRequests.id, requestId))
    .limit(1);
  if (!row) return null;
  const goods = (await registryGoods([requestId])).get(requestId) ?? { count: 0, first: [] };
  const deal = row.entityType === 'deal';
  return {
    requestId,
    entityType: deal ? 'deal' : 'lead',
    entityId: row.entityId,
    cardLabel: (deal ? row.dealCode : row.leadName) ?? '—',
    clientCode: deal ? row.clientCode : null,
    clientName: deal ? row.clientName : null,
    dealTitle: deal ? row.dealTitle : null,
    leadPhone: deal ? null : row.leadPhone,
    leadCompany: deal ? null : row.leadCompany,
    leadOwnerId: deal ? null : row.leadOwnerId,
    cardOwnerId: (deal ? row.dealOwnerId : row.leadOwnerId) ?? null,
    requestedBy: row.requestedBy,
    section: row.section,
    fromCity: row.fromCity,
    toCity: row.toCity,
    weightKg: toNum(row.weightKg),
    volumeM3: toNum(row.volumeM3),
    goodsFirst: goods.first,
    goodsCount: goods.count,
  };
}

/** What a ping says beyond the request — the money and the moment, from its own door. */
export type CalcPing =
  | {
      type: 'CalcSealed';
      /** The V is the CHAIN's (`quoteNoFor`) — never the per-request counter, which reads «V1» on every correction (D8). */
      versionId: string;
      totalUsd: number;
      /** The engine's own figure (`totalsFor`), the one the version stores. */
      perM3Usd: number | null;
      validUntil: Date | null;
    }
  | { type: 'CalcDone'; amount: number; currency: string; sellerNote: string | null }
  | { type: 'CalcTaken'; takerId: string | null }
  | { type: 'CalcReturned'; reason: string }
  | { type: 'CalcRecalc' };

/** The ping's extras read once, before the recipients — null where the read failed. */
export interface PingResolved {
  quoteNo: number | null;
  takerName: string | null;
}

/** The reader a line is gated for: who, and their grants as the drain's own `userPermissions` reads them. */
export interface PingReader {
  id: string;
  permissions: ReadonlySet<string>;
}

// Indexed by the whole type union: a sixth calc ping in platform is a compile
// error here, never a ping that renders as nothing.
const KIND_EMOJI: Record<CalcPingType, string> = {
  CalcSealed: '🧮',
  CalcDone: '✅',
  CalcTaken: '🧮',
  CalcReturned: '↩️',
  CalcRecalc: '🔄',
};

const filled = (v: string | null | undefined): v is string => typeof v === 'string' && v.trim() !== '';

/** A money figure worth printing — finite, and not «$0.00» once it is rounded to the cent. */
function printable(value: number | null): value is number {
  return value !== null && Number.isFinite(value) && Math.round(value * 100) > 0;
}

/** «25.11.2026», in Tashkent. */
function dottedDay(at: Date): string {
  const m = /^(\d{4})-(\d{2})-(\d{2})$/.exec(tashkentDay(at));
  return m ? `${m[3]}.${m[2]}.${m[1]}` : tashkentDay(at);
}

/** One line per name — a customs description carries its own newlines. */
const oneLine = (s: string) => s.replace(/\s+/g, ' ').trim();

function titleOf(ping: CalcPing, resolved: PingResolved, label: string): string {
  switch (ping.type) {
    case 'CalcSealed':
      return `🧮 Hisob tayyor${resolved.quoteNo !== null ? ` — V${resolved.quoteNo}` : ''}: ${label}`;
    case 'CalcDone':
      return `✅ Hisoblash tayyor: ${label}`;
    case 'CalcTaken':
      return `🧮 Hisoblash olindi: ${label}`;
    case 'CalcReturned':
      return `↩️ Hisoblash qaytarildi: ${label}`;
    case 'CalcRecalc':
      return `🔄 ${label}: narx qayta hisoblanmoqda — eski narx endi amal qilmaydi`;
    default: {
      const never: never = ping;
      return never;
    }
  }
}

/** Who and what — the card's people behind the card's own door, the job's route and goods for its readers. */
function headLines(facts: CalcRequestFacts, reader: PingReader | null): string[] {
  const lines: string[] = [];
  if (facts.entityType === 'deal') {
    // The deal card's door: a reader it bounces keeps the deal code alone,
    // exactly as `requestLabel` always printed it (warehouse staff's 🧮).
    if (reader && canWriteDeal(reader.permissions)) {
      const who = [facts.clientCode, facts.clientName].filter(filled).map(oneLine).join(' · ');
      if (who) lines.push(`👤 Mijoz: ${clipText(who, 80)}`);
      if (filled(facts.dealTitle)) lines.push(`📋 ${clipText(oneLine(facts.dealTitle), 80)}`);
    }
  } else if (reader && mayOpenLead(reader, { ownerId: facts.leadOwnerId })) {
    // A lead's phone is the CRM card's, and that card bounces a seller who
    // does not own the lead (SEC-9) — the same door the link asks.
    const contact = [
      filled(facts.leadPhone) ? `📞 ${oneLine(facts.leadPhone)}` : null,
      filled(facts.leadCompany) ? `🏢 ${clipText(oneLine(facts.leadCompany), 60)}` : null,
    ].filter(filled);
    if (contact.length > 0) lines.push(contact.join(' · '));
  }
  const section = isCalcSection(facts.section) ? SECTION_LABEL[facts.section] : null;
  const route =
    filled(facts.fromCity) || filled(facts.toCity)
      ? `${filled(facts.fromCity) ? oneLine(facts.fromCity) : '—'} → ${filled(facts.toCity) ? oneLine(facts.toCity) : '—'}`
      : null;
  if (section) lines.push(route ? `${section} · ${route}` : section);
  else if (route) lines.push(`📍 ${route}`);
  const names = facts.goodsFirst.map(oneLine).filter(filled).map((n) => clipText(n, 40));
  const more = facts.goodsCount - facts.goodsFirst.length;
  const goods = names.length > 0 ? `${names.join(', ')}${more > 0 ? ` +${more}` : ''}` : null;
  const measures = [
    facts.weightKg !== null && facts.weightKg > 0 ? `${groupDigits(facts.weightKg)} kg` : null,
    facts.volumeM3 !== null && facts.volumeM3 > 0 ? `${groupDigits(facts.volumeM3)} m³` : null,
  ];
  const cargo = [goods, ...measures].filter(filled);
  if (cargo.length > 0) lines.push(`📦 ${cargo.join(' · ')}`);
  return lines;
}

/**
 * The answer's per-m³ — his 9 — or null. Dollars only: a so‘m or yuan answer
 * divided by a cube is a different sentence, and the price channel prints
 * none either (`pickPerUnit`). No volume, no figure; never a $0 or a NaN.
 */
export function donePerM3(amount: number, currency: string, volumeM3: number | null): number | null {
  if (currency !== 'USD') return null;
  const value = perM3Of(amount, volumeM3);
  return printable(value) ? value : null;
}

function bodyLines(ping: CalcPing, resolved: PingResolved, facts: CalcRequestFacts | null): string[] {
  switch (ping.type) {
    case 'CalcSealed': {
      // The engine's own figure, the one the version stores — null with no
      // volume, and never printed as «$0.00».
      // Spelled as the price channel spells a per-unit figure (grouped
      // digits, two places — `usd`), so one cube reads the same in both.
      const perM3 = printable(ping.perM3Usd) ? ` · ${usd(ping.perM3Usd)}/m³` : '';
      // The total in the same spelling as the per-m³ beside it (review
      // P2F-3) — one line, one way of writing a dollar figure. `usd` prints a
      // figure it cannot read as «$0.00» where `toFixed` threw, so the guard
      // is said here: an unreadable total is the fallback's line, never a $0.
      if (typeof ping.totalUsd !== 'number' || !Number.isFinite(ping.totalUsd)) throw new Error('sealed total not a number');
      const lines = [`💵 ${usd(ping.totalUsd)}${perM3}`];
      if (ping.validUntil) lines.push(`⏳ ${dottedDay(ping.validUntil)} gacha amal qiladi`);
      return lines;
    }
    case 'CalcDone': {
      // «💵 1200.46 USD» stays the substring it always was (ved-tarix pins
      // it): the STORED figure, as a JS number, in the typed currency.
      const perM3 = donePerM3(ping.amount, ping.currency, facts?.volumeM3 ?? null);
      const lines = [`💵 ${ping.amount} ${ping.currency}${perM3 !== null ? ` · ${usd(perM3)}/m³` : ''}`];
      if (filled(ping.sellerNote)) lines.push(`📝 ${clipText(ping.sellerNote, 300)}`);
      return lines;
    }
    case 'CalcTaken':
      return filled(resolved.takerName) ? [`🙋 Oldi: ${clipText(resolved.takerName, 60)}`] : [];
    case 'CalcReturned':
      return filled(ping.reason) ? [`📝 ${clipText(ping.reason, 300)}`] : [];
    case 'CalcRecalc':
      return [];
    default: {
      const never: never = ping;
      return never;
    }
  }
}

/**
 * One ping as ONE reader reads it. Pure. `facts` null = the request could not
 * be read: the title with «—», the money, no head, no link — a line that
 * needed no database (R12). `reader` null = their grants could not be read:
 * every gated line and the link are left out, the rest stands.
 */
export function renderCalcPing(
  ping: CalcPing,
  resolved: PingResolved,
  facts: CalcRequestFacts | null,
  reader: PingReader | null,
  appUrl: string,
): { text: string; openAs: CalcOpenAs | null } {
  const label = facts ? clipText(oneLine(facts.cardLabel) || '—', 60) : '—';
  const lines = [titleOf(ping, resolved, label), ...(facts ? headLines(facts, reader) : []), ...bodyLines(ping, resolved, facts)];
  const door =
    facts && reader
      ? calcJobDoorFor(reader, {
          entityType: facts.entityType,
          entityId: facts.entityId,
          leadOwnerId: facts.leadOwnerId,
          requestId: facts.requestId,
        })
      : null;
  // The LAST line, whole and absolute: that is what the drain lifts into the
  // button (`takeOwnLink`). No door, no line — a link that bounces home is a
  // dead door (#1281).
  if (door) lines.push(`${appUrl.replace(/\/$/, '')}${door.href}`);
  return { text: lines.join('\n'), openAs: door?.openAs ?? null };
}

/**
 * The renderer that cannot throw — what every sender calls. A failure in the
 * full render falls back to the no-read render; a failure there to the kind's
 * emoji alone. Never the reason a ping is not sent.
 */
export function calcPingText(
  ping: CalcPing,
  resolved: PingResolved,
  facts: CalcRequestFacts | null,
  reader: PingReader | null,
  appUrl: string,
): { text: string; openAs: CalcOpenAs | null } {
  try {
    return renderCalcPing(ping, resolved, facts, reader, appUrl);
  } catch (err) {
    logger.error({ err, type: ping.type }, '[calc] ping not rendered — sent without its head');
  }
  try {
    return renderCalcPing(ping, resolved, null, null, appUrl);
  } catch (err) {
    logger.error({ err, type: ping.type }, '[calc] ping fallback not rendered');
  }
  return { text: `${KIND_EMOJI[ping.type]} —`, openAs: null };
}

async function resolvePing(ping: CalcPing): Promise<PingResolved> {
  const out: PingResolved = { quoteNo: null, takerName: null };
  if (ping.type === 'CalcSealed') {
    // Null — never «Vnull»: the title then reads «🧮 Hisob tayyor» bare.
    out.quoteNo = await quoteNoFor(ping.versionId).catch((err: unknown) => {
      logger.error({ err, versionId: ping.versionId }, '[calc] seal number not resolved');
      return null;
    });
  }
  if (ping.type === 'CalcTaken' && ping.takerId) {
    out.takerName = await userName(ping.takerId).catch((err: unknown) => {
      logger.error({ err }, '[calc] taker name not resolved');
      return null;
    });
  }
  return out;
}

/**
 * Who hears a ping (R13): the requester, as always — and the card's CURRENT
 * owner when that is somebody else (a reassigned lead or deal: the person now
 * working the client is the one the answer is for). Not when the AI sotuvchi
 * speaks for the job: its owner hears the answer as the agent's own price card
 * (`AgentCalcAnswered`), and a plain «💵 X USD» beside the machine's pending
 * price invites a second, manual quote. A predicate that cannot be asked
 * counts as «it speaks» — the second message is the one left out, never the
 * requester's.
 */
async function recipientsOf(requestId: string, requestedBy: string, facts: CalcRequestFacts | null): Promise<string[]> {
  const owner = facts?.cardOwnerId ?? null;
  if (!owner || owner === requestedBy) return [requestedBy];
  const speaks = await import('../agent/calc-loop')
    .then((m) => m.agentSpeaksForCalc(requestId))
    .catch((err: unknown) => {
      logger.error({ err, requestId }, '[calc] agent link not read — the card owner is not told');
      return true;
    });
  return speaks ? [requestedBy] : [requestedBy, owner];
}

/**
 * Send one calc ping — ONE `notifyStaffTelegram` per recipient, because the
 * text and the link are each recipient's own (D9). Never throws: every step
 * is caught where it stands, and the requester is told even when nothing
 * about the request could be read. `exceptUserId` is the caller's, as it was:
 * the person who did the thing is not told what they did.
 */
export async function sendCalcPing(input: {
  requestId: string;
  ping: CalcPing;
  /** The person told today — from the caller's own write, so a failed read cannot lose them. */
  requestedBy: string;
  exceptUserId: string | null;
}): Promise<void> {
  try {
    const facts = await calcRequestFacts(input.requestId).catch((err: unknown) => {
      logger.error({ err, requestId: input.requestId }, '[calc] head not resolved');
      return null;
    });
    const resolved = await resolvePing(input.ping);
    const recipients = await recipientsOf(input.requestId, input.requestedBy, facts);
    const appUrl = process.env.APP_URL ?? '';
    for (const userId of recipients) {
      const reader = await userPermissions(userId)
        .then((permissions): PingReader => ({ id: userId, permissions }))
        .catch((err: unknown) => {
          logger.error({ err, userId }, '[calc] reader grants not read — sent without the gated lines');
          return null;
        });
      const { text, openAs } = calcPingText(input.ping, resolved, facts, reader, appUrl);
      await notifyStaffTelegram({
        userIds: [userId],
        type: input.ping.type,
        text,
        ...(openAs ? { extra: { openAs } } : {}),
        exceptUserId: input.exceptUserId,
      }).catch((err: unknown) =>
        logger.error({ err, requestId: input.requestId, type: input.ping.type }, '[calc] ping not queued'),
      );
    }
  } catch (err) {
    logger.error({ err, requestId: input.requestId, type: input.ping.type }, '[calc] ping failed');
  }
}
