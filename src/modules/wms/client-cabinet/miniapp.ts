import { and, eq, inArray } from 'drizzle-orm';
import { cabinetMap, type CabinetMapPlace } from './map';
import { basemapAvailable } from '../tracking/basemap';
import { db } from '@/modules/platform/db/client';
import { boxes, receiptLots, receipts, warehouses } from '@/modules/platform/db/schema';
import { logger } from '@/modules/platform/logger';
import { verifyInitData, type InitDataResult } from '@/modules/platform/telegram/init-data';
import {
  clientsForChat,
  cargoOverview,
  debtSummary,
  issuedHandovers,
  managersFor,
  officeContact,
  paidHistory,
} from './service';
import {
  clientLabels,
  isClientLocale,
  localeFromTelegram,
  type ClientLocale,
} from '@/modules/platform/telegram/client-labels';
import { setChatLocale } from '@/modules/platform/telegram/cabinet-locale';
import { sendText } from '@/modules/platform/telegram/send';

/**
 * The Mini App's door.
 *
 * Every request carries the same `initData` Telegram signed when the app was
 * opened, and it is re-checked on each one. No session cookie, no server-side
 * session store: the blob is already signed, already short-lived and already
 * in the client's hands, so minting a second credential beside it would add a
 * store to keep, a cookie to scope and a CSRF surface, in exchange for
 * nothing but one HMAC per request.
 *
 * The identity that comes out is the CHAT, never a client id from the
 * request. A client id in a query string is a client id somebody can change.
 */

export type CabinetAuth =
  | {
      ok: true;
      chatId: bigint;
      /** What the screen speaks: the chat's stored choice, else Telegram's own hint. */
      locale: string | null;
      /**
       * What the PERSON chose, and nothing else (round C, CX-7) — the one the
       * language switch highlights. `locale` above falls back to Telegram's
       * interface language, which is a guess and must not read as a choice.
       */
      storedLocale: string | null;
      clients: { id: string; clientCode: string; name: string; locale: string | null }[];
    }
  | { ok: false; status: 401 | 403; reason: string };

/** Read the signed blob off a request. */
export function initDataFrom(request: Request): string {
  return request.headers.get('x-telegram-init-data') ?? '';
}

export async function authenticateCabinet(initData: string): Promise<CabinetAuth> {
  const token = process.env.TELEGRAM_BOT_TOKEN;
  // No token means the signature cannot be checked AT ALL. Refuse rather than
  // degrade: a cabinet that opens without verification is worse than one that
  // does not open.
  if (!token) return { ok: false, status: 401, reason: 'not_configured' };

  const verified: InitDataResult = verifyInitData(initData, token);
  if (!verified.ok) return { ok: false, status: 401, reason: verified.reason };

  const chatId = BigInt(verified.chatId);
  const linked = await clientsForChat(chatId);
  // Signed in as a real Telegram user, but this chat has never been connected
  // to a client — a stranger who found the link, or somebody whose access was
  // revoked. 403 rather than 401: the identity is fine, the authorization is
  // not.
  if (linked.length === 0) return { ok: false, status: 403, reason: 'not_linked' };

  // `clientsForChat` is ordered oldest link first — `chatLocaleFor`'s rule, so
  // the app and the bot agree on which choice a chat made.
  const storedLocale = linked.find((c) => c.locale)?.locale ?? null;
  return {
    ok: true,
    chatId,
    locale: storedLocale ?? localeFromTelegram(verified.user.language_code),
    storedLocale,
    clients: linked.map((c) => ({ id: c.id, clientCode: c.clientCode, name: c.name, locale: c.locale })),
  };
}

/**
 * A person a customer may contact, as the customer sees them. Spelled out
 * here rather than re-exported from `managersFor`: this is what crosses to a
 * phone, and a field added to the staff-side type later (an id, a login) must
 * not ride along by inheritance (judge PRIV-13).
 */
export interface CabinetContact {
  name: string;
  phone: string | null;
  telegramUrl: string | null;
}

export interface CabinetPayload {
  clients: {
    id: string;
    clientCode: string;
    name: string;
    cargo: Awaited<ReturnType<typeof cargoOverview>>;
    balanceUsd: number;
    recent: Awaited<ReturnType<typeof debtSummary>>['recent'];
    history: Awaited<ReturnType<typeof issuedHandovers>>;
    /** Money the client handed us in the same window — payments only. */
    payments: Awaited<ReturnType<typeof paidHistory>>;
    /*
     * Round C — OPTIONAL in the type on purpose: the screen must draw without
     * them (an older server mid-deploy, the e2e fixture), so the compiler makes
     * every reader handle their absence rather than luck.
     */
    /** Who this code writes to (`managersFor`) — a name, a phone, a chat link. */
    manager?: CabinetContact | null;
    /** Where this code's ready-for-pickup boxes stand, by NAME. */
    readyPlaces?: { name: string; address: string | null }[];
  }[];
  locale: string | null;
  /** The chat's stored language choice; null when nobody has chosen. */
  storedLocale?: string | null;
  /** The office, for a code with no manager — what the offer PDF prints. */
  office?: { name: string; phone: string | null };
  totals: { boxes: number; weightKg: number; volumeM3: number; balanceUsd: number };
  /** Where the cargo is, for the map (item 11) — only this chat's own. */
  map: CabinetMapPlace[];
  /**
   * Is the self-hosted street map installed on this server? Without it the
   * map still zooms and pans, over a plain background with city names.
   */
  basemap: boolean;
}

/**
 * Everything the cabinet screen shows, for every code this chat holds.
 *
 * Assembled server-side in one call rather than one endpoint per tab, because
 * a client on a warehouse-town mobile connection should pay for one round trip
 * and then swipe between tabs instantly.
 *
 * What is deliberately NOT here: landed cost, margin and anything belonging
 * to another client. The first two sit one join away in `cost_allocations`
 * and would turn the cabinet into a leak of what the company earns. The
 * truck's position IS here since item 11 (2026-09-26), as `cabinetMap` draws
 * it — the owner's round-98 condition («until every client can see their own
 * cargo on a real map») is what that map is.
 */
export async function cabinetPayload(auth: CabinetAuth & { ok: true }): Promise<CabinetPayload> {
  const ids = auth.clients.map((c) => c.id);
  // One grouped read each for the whole chat, never one per code (#432).
  const [managers, office, readyPlaces] = await Promise.all([
    managersFor(ids),
    officeContact(),
    readyPlacesFor(ids),
  ]);
  const clients = await Promise.all(
    auth.clients.map(async (client) => {
      const [cargo, debt, history, payments] = await Promise.all([
        cargoOverview(client.id),
        debtSummary(client.id),
        issuedHandovers(client.id),
        paidHistory(client.id),
      ]);
      const m = managers.get(client.id);
      return {
        // Field by field, not a spread: the auth row also carries the code's
        // stored language, which is the chat's business and not the screen's.
        id: client.id,
        clientCode: client.clientCode,
        name: client.name,
        cargo,
        balanceUsd: debt.balanceUsd,
        recent: debt.recent.filter((r) => !r.voided),
        history,
        payments,
        manager: m ? { name: m.name, phone: m.phone, telegramUrl: m.telegramUrl } : null,
        readyPlaces: readyPlaces.get(client.id) ?? [],
      };
    }),
  );

  const totals = clients.reduce(
    (acc, c) => {
      for (const lot of c.cargo) {
        acc.boxes += lot.total;
        acc.weightKg += lot.weightKg;
        acc.volumeM3 += lot.volumeM3;
      }
      acc.balanceUsd += c.balanceUsd;
      return acc;
    },
    { boxes: 0, weightKg: 0, volumeM3: 0, balanceUsd: 0 },
  );
  totals.weightKg = Math.round(totals.weightKg * 100) / 100;
  totals.volumeM3 = Math.round(totals.volumeM3 * 1000) / 1000;
  totals.balanceUsd = Math.round(totals.balanceUsd * 100) / 100;

  // Every code this chat holds, on one map — its own cargo and nobody else's.
  const map = await cabinetMap(auth.clients.map((c) => c.id));

  return {
    clients,
    locale: auth.locale,
    storedLocale: auth.storedLocale,
    office: { name: office.name, phone: office.phone },
    totals,
    map,
    basemap: basemapAvailable(),
  };
}

/**
 * Where each code's READY boxes stand — the one place name the «olib ketishga
 * tayyor» card needs and a lot cannot give: `warehousePlaces` lists every
 * place ANY of a lot's boxes stands, so a lot half in Yiwu and half ready in
 * Tashkent would name both and send the customer toward China.
 *
 * `ready_for_pickup` is exactly the `ready` rung (`cargoStage`), so the card's
 * count and this list are the same boxes.
 */
async function readyPlacesFor(clientIds: string[]) {
  const out = new Map<string, { name: string; address: string | null }[]>();
  if (clientIds.length === 0) return out;
  const rows = await db
    .selectDistinct({ clientId: receipts.clientId, name: warehouses.name, address: warehouses.address })
    .from(boxes)
    .innerJoin(receiptLots, eq(boxes.lotId, receiptLots.id))
    .innerJoin(receipts, eq(receiptLots.receiptId, receipts.id))
    .innerJoin(warehouses, eq(boxes.currentWarehouseId, warehouses.id))
    .where(and(inArray(receipts.clientId, clientIds), eq(boxes.status, 'ready_for_pickup')))
    .orderBy(warehouses.name);
  for (const r of rows) {
    if (!r.clientId) continue;
    if (!out.has(r.clientId)) out.set(r.clientId, []);
    out.get(r.clientId)!.push({ name: r.name, address: r.address?.trim() || null });
  }
  return out;
}

/** One real change per chat per this many ms — see `changeCabinetLocale`. */
export const LOCALE_CHANGE_GAP_MS = 10_000;
const lastLocaleChange = new Map<string, number>();

export type CabinetLocaleChange =
  | { ok: true; changed: boolean; locale: ClientLocale }
  | { ok: false; status: 400 | 429; reason: 'bad_locale' | 'too_fast' };

/**
 * The Mini App's language switch (round C) — the bot's 🌐 Til, reached from
 * inside the app.
 *
 * The same three effects as the bot's door, through the same writer
 * (`setChatLocale`): every code in the chat, the corner button, and — because
 * a reply keyboard can only change by SENDING a message — one «✅ Til
 * o'zgartirildi» into the chat carrying the keyboard `replyKeyboardFor`
 * derives, so a chat that is staff AND client keeps its staff row.
 *
 * Two brakes, both about that message (judge PRIV-8): a press that changes
 * nothing (every code already speaks it) writes nothing and sends nothing,
 * and a chat changes at most once per ten seconds — a thumb sliding along
 * three buttons must not become three messages, and a script holding a
 * signed blob must not become a way to flood a customer's chat from our bot.
 * In memory: one process serves the app, and a restart forgetting a
 * ten-second window forgives nothing that matters.
 */
export async function changeCabinetLocale(
  auth: CabinetAuth & { ok: true },
  requested: unknown,
  now: number = Date.now(),
): Promise<CabinetLocaleChange> {
  if (!isClientLocale(requested)) return { ok: false, status: 400, reason: 'bad_locale' };
  if (auth.clients.every((c) => c.locale === requested)) {
    return { ok: true, changed: false, locale: requested };
  }
  const key = String(auth.chatId);
  const last = lastLocaleChange.get(key);
  if (last !== undefined && now - last < LOCALE_CHANGE_GAP_MS) {
    return { ok: false, status: 429, reason: 'too_fast' };
  }
  // Stamped BEFORE the first await: two presses arriving together must not
  // both find the window open.
  lastLocaleChange.set(key, now);
  if (lastLocaleChange.size > 5_000) {
    for (const [k, at] of lastLocaleChange) if (now - at >= LOCALE_CHANGE_GAP_MS) lastLocaleChange.delete(k);
  }

  await setChatLocale(auth.chatId, requested);
  // The keyboard's composer lives with the bot; reached the way the bot's own
  // language door reaches it.
  const { replyKeyboardFor } = await import('@/modules/platform/telegram/keyboards');
  const keyboard = await replyKeyboardFor(auth.chatId, requested).catch(() => undefined);
  const sent = await sendText({
    chatId: auth.chatId,
    text: clientLabels(requested).languageSet,
    replyMarkup: keyboard,
    // Inside a request the customer is waiting on: a slow Telegram must not
    // hold the screen — the choice is already stored.
    timeoutMs: 8_000,
  });
  if (!sent.ok) {
    logger.warn(
      { chatId: key, status: sent.status, description: sent.description },
      'cabinet language: the keyboard message was not sent',
    );
  }
  return { ok: true, changed: true, locale: requested };
}
