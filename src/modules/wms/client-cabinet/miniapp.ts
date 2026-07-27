import { verifyInitData, type InitDataResult } from '@/modules/platform/telegram/init-data';
import { clientsForChat, cargoOverview, debtSummary, issuedHistory } from './service';
import { localeFromTelegram } from '@/modules/platform/telegram/client-labels';

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
  | { ok: true; chatId: bigint; locale: string | null; clients: { id: string; clientCode: string; name: string }[] }
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

  return {
    ok: true,
    chatId,
    locale: linked.find((c) => c.locale)?.locale ?? localeFromTelegram(verified.user.language_code),
    clients: linked.map((c) => ({ id: c.id, clientCode: c.clientCode, name: c.name })),
  };
}

export interface CabinetPayload {
  clients: {
    id: string;
    clientCode: string;
    name: string;
    cargo: Awaited<ReturnType<typeof cargoOverview>>;
    balanceUsd: number;
    recent: Awaited<ReturnType<typeof debtSummary>>['recent'];
    history: Awaited<ReturnType<typeof issuedHistory>>;
  }[];
  locale: string | null;
  totals: { boxes: number; weightKg: number; volumeM3: number; balanceUsd: number };
}

/**
 * Everything the cabinet screen shows, for every code this chat holds.
 *
 * Assembled server-side in one call rather than one endpoint per tab, because
 * a client on a warehouse-town mobile connection should pay for one round trip
 * and then swipe between tabs instantly.
 *
 * What is deliberately NOT here: landed cost, margin, the truck's position and
 * anything belonging to another client. The first two sit one join away in
 * `cost_allocations` and would turn the cabinet into a leak of what the
 * company earns; the third is the owner's explicit instruction for now.
 */
export async function cabinetPayload(auth: CabinetAuth & { ok: true }): Promise<CabinetPayload> {
  const clients = await Promise.all(
    auth.clients.map(async (client) => {
      const [cargo, debt, history] = await Promise.all([
        cargoOverview(client.id),
        debtSummary(client.id),
        issuedHistory(client.id),
      ]);
      return {
        ...client,
        cargo,
        balanceUsd: debt.balanceUsd,
        recent: debt.recent.filter((r) => !r.voided),
        history,
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

  return { clients, locale: auth.locale, totals };
}
