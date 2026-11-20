import { eq } from 'drizzle-orm';
import { db } from '../../platform/db/client';
import { clients, leads } from '../../platform/db/schema';
import { cardLink } from '../../platform/notifications/links';
import { actorGrants } from '../../platform/rbac/authorize';
import { getSetting, SETTING_DEFAULTS, SETTING_VALIDATORS } from '../../platform/settings/service';
import { mayOpenClientCard, seesAllClients } from '../../platform/clients/card-door';
import { groupDigits } from '../../platform/telegram/format';
import { mondayOf, tashkentDay } from '../../platform/time/tashkent';
import { mayOpenLead } from '../crm/lead-door';
import type { AgentContext } from './context';
import { sendSignal } from './signals';
import { newestMeasure, type ToolOutcome } from './tools';

/**
 * The big-cargo signal (stage 1a §4.5, his 3 b: «20 kubdan yoki fura desa — AI javob beraversin, menga xabar
 * kelsin»; «kimga — tizimda tanlanadi»). The AI answers as ever; the people he designated for «Katta yuk signali»
 * are told ONCE per chat per Tashkent week that a big load is being talked about — kub and kg, and the card's name
 * and link only for a recipient that card's own door admits. Never the customer's words or phone (round 20: a chat
 * is private to its account), never a price (law 4: a colleague may be the VED).
 *
 * Asked by `handleInbound` AFTER the draft is written, in its own try/catch: a signal never costs a draft. «AI javob
 * tayyorladi», never «berdi» — the draft it follows may be waiting for his ✅ (#1106: a claim of delivery nobody
 * has).
 */

/** The fold every word below is matched in: lower case, one apostrophe for the six an Uzbek keyboard types. */
function fold(text: string): string {
  return text.toLowerCase().replace(/[‘’ʻʼ`´]/gu, "'");
}

/** Where one statement ends and the next begins — a negation never reaches across it («fura kerak, LCL emas»). */
const CLAUSE_BREAK = /[.,;:!?\n؟。，！？；、]|\s(?:lekin|ammo|biroq|лекин|аммо|но|а|but|however|ولی|اما)\s/u;

/** The words of a clause — letters, digits and the Uzbek apostrophe inside a word. */
const WORD = /[\p{L}\p{N}]+(?:'[\p{L}\p{N}]+)*/gu;

/**
 * «Fura» with its case endings, in both Uzbek scripts and in Russian — and nothing that only begins like it:
 * «furazolidon», «фурнитура», «фураж» are goods (`full_truck` corpus).
 */
const TRUCK_WORD =
  /^(?:fura(?:lar)?(?:ga|da|dan|ni|ning|si|siga|sida|sidan|dagi|day|mi|chi|li)?|фура(?:лар)?(?:га|да|дан|ни|нинг|си|сига|сида|ми|чи)?|фур(?:ы|е|у|ой|ою|ам|ами|ах)?|ftl)$/u;

/** A truck — said after an adjective that makes it a WHOLE one («to‘liq mashina», «полную машину», «full truck»). */
const VEHICLE_WORD =
  /^(?:(?:yuk)?mashina\p{L}*|avtomashina\p{L}*|машина\p{L}*|машин\p{L}*|truck|trucks|truckload|truckloads|lorry|کامیون\p{L}*)$/u;

const WHOLE_WORD =
  /^(?:to'liq|toliq|to'la|tola|butun|тўлиқ|тулик|тўла|бутун|полн(?:ая|ую|ой|ые|ых|ыми)|цел(?:ая|ую|ой|ые|ых|ыми)|отдельн(?:ая|ую|ой|ые|ых|ыми)|full|whole|entire|dedicated|کامل|دربست)$/u;

/** «Mashina to‘liq», «машину целиком», «کامیون کامل»: the whole-word AFTER the vehicle. */
const WHOLE_AFTER = /^(?:to'liq|toliq|to'la|тўлиқ|тўла|целиком|полностью|کامل|دربست)$/u;

/** Said BEFORE the hit within three words: «не нужна фура», «not a full truck», «less than a full truck», «без фуры». */
const NEG_BEFORE = /^(?:не|нет|без|not|no|dont|don't|without|less|isn't|isnt|doesn't|doesnt|نه|بدون)$/u;

/** …or AFTER it within three: «fura kerak emas», «фура не нужна», «کامیون کامل نیست». */
const NEG_AFTER = /^(?:emas|kerakmas|shartmas|yo'q|yoq|bo'lmaydi|эмас|керакмас|йўқ|не|нет|not|نیست|نه|نمی\p{L}*)$/u;

/** A Chinese whole truck or container, and the negations that precede it («不需要整车»). */
const HAN_WHOLE = /整车|整柜/gu;
const HAN_NEG = /[不没無无非]/u;

function negated(words: readonly string[], from: number, to: number): boolean {
  for (let i = Math.max(0, from - 3); i < from; i += 1) if (NEG_BEFORE.test(words[i]!)) return true;
  for (let i = to + 1; i <= Math.min(words.length - 1, to + 3); i += 1) if (NEG_AFTER.test(words[i]!)) return true;
  return false;
}

/** One clause: does it ask for a whole truck, and not say it does not want one? */
function clauseSaysFullTruck(clause: string): boolean {
  for (const m of clause.matchAll(HAN_WHOLE)) {
    const before = clause.slice(Math.max(0, (m.index ?? 0) - 3), m.index ?? 0);
    if (!HAN_NEG.test(before)) return true;
  }
  const words = clause.match(WORD) ?? [];
  for (let i = 0; i < words.length; i += 1) {
    const w = words[i]!;
    if (TRUCK_WORD.test(w)) {
      if (!negated(words, i, i)) return true;
      continue;
    }
    // «to‘liq mashina», «полную машину», «full truck», «whole 40ft truck» — the vehicle within the next two words.
    if (WHOLE_WORD.test(w)) {
      for (let j = i + 1; j <= Math.min(words.length - 1, i + 2); j += 1) {
        if (VEHICLE_WORD.test(words[j]!) && !negated(words, i, j)) return true;
      }
    }
    // «mashina to‘liq», «машину целиком», «کامیون کامل».
    if (VEHICLE_WORD.test(w) && i + 1 < words.length && WHOLE_AFTER.test(words[i + 1]!) && !negated(words, i, i + 1)) return true;
  }
  return false;
}

/**
 * The customer asked for a WHOLE truck (his 3 b, «fura desa»), in any of the six languages the agent speaks: «fura»
 * with its endings, «to‘liq mashina», «полная машина», «full truck», FTL, 整车 / 整柜, «کامیون کامل». A negation in the
 * same clause takes it back («fura kerak emas», «不需要整车»). Over the customer's lines only — never ours.
 *
 * A FREE-TEXT READER: every change runs the reader corpus first (`full_truck`, both kinds). A miss is the dangerous
 * direction here — the people he chose do not hear of the load his answer is about; a false hit costs one ping a
 * chat a week.
 */
export function saysFullTruck(lines: readonly string[]): boolean {
  return lines.some((line) => fold(line).split(CLAUSE_BREAK).some((clause) => clauseSaysFullTruck(clause)));
}

/** The big-cargo settings as the signal reads them — a stored value its shape refuses is the default. */
export interface BigCargoSettings {
  /** The line in kub; 0 = no size signal. */
  m3: number;
  /** «Fura» alone also signals. */
  words: boolean;
}

export async function readBigCargoSettings(): Promise<BigCargoSettings> {
  const [m3, words] = await Promise.all([getSetting('agent_big_cargo_m3'), getSetting('agent_big_cargo_words')]);
  return {
    m3: SETTING_VALIDATORS.agent_big_cargo_m3!(String(m3)) ? Number(m3) : SETTING_DEFAULTS.agent_big_cargo_m3,
    words: SETTING_VALIDATORS.agent_big_cargo_words!(String(words)) ? String(words) === 'true' : SETTING_DEFAULTS.agent_big_cargo_words,
  };
}

/** What made it big, and the load as the customer stated it (or as the run priced it). */
export interface BigCargo {
  m3: number | null;
  kg: number | null;
  by: 'size' | 'words';
}

/**
 * Is this burst about a big load? Pure. The volume is the one THIS burst stated (`newestMeasure`'s rule — a stated
 * figure beats one computed from cartons — over the burst's own lines) or the one this run priced (a yo'lkira
 * estimate's `m3`); a figure from last week's lines does not re-signal every week. ≥ `settings.m3` (when it is not 0)
 * is big by size; otherwise, with `settings.words`, the customer's own «fura» is.
 */
export function bigCargoOf(
  ctx: Pick<AgentContext, 'burst' | 'measures'>,
  outcomes: readonly ToolOutcome[],
  settings: BigCargoSettings,
): BigCargo | null {
  const burstRefs = new Set(ctx.burst.map((m) => m.ref));
  const fresh = { measures: ctx.measures.filter((m) => burstRefs.has(m.messageRef)) };
  const priced = [...outcomes].reverse().find((o) => o.priced && o.priced.m3 !== null)?.priced ?? null;
  const m3 = priced?.m3 ?? newestMeasure(fresh, 'volume')?.value ?? null;
  const kg = priced?.kg ?? newestMeasure(fresh, 'weight')?.value ?? null;
  if (settings.m3 > 0 && m3 !== null && m3 >= settings.m3) return { m3, kg, by: 'size' };
  if (settings.words && saysFullTruck(ctx.burst.filter((m) => m.direction === 'in').map((m) => m.body))) return { m3, kg, by: 'words' };
  return null;
}

/** The card a recipient may open, named — or null. */
export interface OpenCard {
  name: string;
  href: string;
}

/**
 * The signal as ONE recipient reads it. Counts and the load only for everybody; the card's name and its link (the
 * last line, which the drain turns into «↗️ Ochish») only when that recipient may open that card.
 */
export function bigCargoText(cargo: BigCargo, open: OpenCard | null): string {
  const parts = [
    cargo.m3 !== null ? `${groupDigits(cargo.m3)} kub` : null,
    cargo.kg !== null ? `${groupDigits(cargo.kg)} kg` : null,
    cargo.by === 'words' ? 'to‘liq mashina (fura)' : null,
  ].filter((p): p is string => p !== null);
  const head = `🚛 Katta yuk: ${parts.join(' · ')} · AI javob tayyorladi.`;
  return open ? [head, `👤 ${open.name}`, open.href].join('\n') : head;
}

/** The ISO week a signal is said once in — its Monday, on Tashkent's calendar. */
export function bigCargoWeek(now: Date): string {
  return mondayOf(tashkentDay(now));
}

/**
 * The card this chat is about, as a recipient may see it: the lead's (its own door, `mayOpenLead` — «everything that
 * draws a lead link asks THIS»), else, for a coded client with no lead, the client card's (`mayOpenClientCard`, and
 * the book's own sight — a seller reads the clients he manages). The recipient's grants are read the way a job reads
 * a person with no session (`actorGrants`); nothing here restates a role or a permission.
 */
async function cardFor(
  recipientId: string,
  card: { lead: { id: string; ownerId: string | null; name: string } | null; client: { id: string; managerId: string | null; name: string } | null },
): Promise<OpenCard | null> {
  const grants = await actorGrants(recipientId);
  const reader = { id: recipientId, permissions: grants.permissions };
  if (card.lead) {
    const href = cardLink('lead', card.lead.id);
    return href && mayOpenLead(reader, { ownerId: card.lead.ownerId }) ? { name: card.lead.name, href } : null;
  }
  if (card.client) {
    const href = cardLink('client', card.client.id);
    const own = seesAllClients(reader) || card.client.managerId === recipientId;
    return href && mayOpenClientCard(reader) && own ? { name: card.client.name, href } : null;
  }
  return null;
}

/**
 * The run's one call (stage 1a §4.5): judge the burst, and when it is big, say so once this week to the people
 * designated for «Katta yuk signali». Returns whether a signal went. Never throws past its own reads — the caller
 * still wraps it, a signal never costs a draft.
 */
export async function signalBigCargo(
  ctx: Pick<AgentContext, 'managerUserId' | 'peerId' | 'burst' | 'measures' | 'identity'>,
  outcomes: readonly ToolOutcome[],
  now: Date,
): Promise<boolean> {
  const cargo = bigCargoOf(ctx, outcomes, await readBigCargoSettings());
  if (!cargo) return false;
  const leadId = ctx.identity.leadId;
  const clientId = leadId ? null : ctx.identity.clientId;
  const [lead] = leadId
    ? await db.select({ id: leads.id, ownerId: leads.ownerId, name: leads.name }).from(leads).where(eq(leads.id, leadId))
    : [];
  const [client] = clientId
    ? await db
        .select({ id: clients.id, managerId: clients.salesManagerId, code: clients.clientCode, name: clients.name })
        .from(clients)
        .where(eq(clients.id, clientId))
    : [];
  const card = {
    lead: lead ? { id: lead.id, ownerId: lead.ownerId, name: lead.name } : null,
    client: client ? { id: client.id, managerId: client.managerId, name: [client.code, client.name].filter(Boolean).join(' ') } : null,
  };
  const out = await sendSignal(
    {
      topic: 'big_cargo',
      managerUserId: ctx.managerUserId,
      peerId: ctx.peerId,
      leadId: card.lead?.id ?? null,
      clientId: card.client?.id ?? null,
      facts: { m3: cargo.m3, kg: cargo.kg, by: cargo.by },
      dedupeKey: `big_cargo:${ctx.managerUserId}:${String(ctx.peerId)}:${bigCargoWeek(now)}`,
    },
    async (recipientId) => bigCargoText(cargo, await cardFor(recipientId, card)),
  );
  return out.claimed;
}
