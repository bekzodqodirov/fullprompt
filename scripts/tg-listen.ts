import 'dotenv/config';
import { pgClient } from '../src/modules/platform/db/client';
import { rulesFor } from '../src/modules/wms/crm/chat-rules';
import {
  clientBook,
  heartbeat,
  loadAccount,
  markAccount,
  storeIncoming,
  takeListenerLock,
} from '../src/modules/wms/crm/telegram-accounts';
import {
  bookIsStale,
  decideIncoming,
  newBook,
  shouldRefreshOnMiss,
  HEARTBEAT_MS,
  type BookState,
} from '../src/modules/wms/crm/telegram-live';
import type { DialogPeer } from '../src/modules/wms/crm/telegram-import';

/**
 * The live bridge: a client's message reaches the CRM within seconds.
 *
 * A long-lived process rather than a pg-boss job, because it is one open
 * connection that must stay open — a job that runs and exits would reconnect
 * to Telegram on a schedule, and repeated connects from a personal account are
 * exactly the pattern that gets one limited.
 *
 * It is a thin shell on purpose, like `tg-import`. Every decision it makes
 * lives in `crm/telegram-live.ts` and is unit tested without a network; what
 * is left here is gramjs glue, a lock, and a heartbeat.
 *
 *   docker compose run -d --name tg-listen migrate sh -c "pnpm tg-listen --tg +998901757800"
 *
 * It only ever READS. There is no code path here that sends a message —
 * replying from the CRM is phase 4 and a separate decision.
 */

async function main() {
  const argv = process.argv.slice(2);
  const i = argv.indexOf('--tg');
  const tgPhone = i >= 0 ? argv[i + 1] : undefined;
  if (!tgPhone) throw new Error('usage: pnpm tg-listen --tg +998...');

  const apiId = Number(process.env.TELEGRAM_API_ID);
  const apiHash = process.env.TELEGRAM_API_HASH;
  if (!apiId || !apiHash) throw new Error('TELEGRAM_API_ID / TELEGRAM_API_HASH are not set');

  const account = await loadAccount(tgPhone);
  if (!account) throw new Error(`no stored session for ${tgPhone} — run: pnpm tg-login --user ...`);

  // Before connecting, not after: the whole point is to never open a second
  // connection on this account, and connecting first would have already done it.
  const releaseLock = await takeListenerLock(account.id);
  if (!releaseLock) {
    throw new Error(`another listener already holds ${tgPhone} — refusing to connect twice`);
  }

  const { TelegramClient, Api } = await import('telegram');
  const { StringSession } = await import('telegram/sessions');
  const { NewMessage } = await import('telegram/events');

  const client = new TelegramClient(new StringSession(account.session), apiId, apiHash, {
    connectionRetries: -1, // reconnect for ever; a warehouse loses its link often
  });
  await client.connect();
  if (!(await client.checkAuthorization())) {
    await markAccount(account.id, 'signed_out', 'Telegram ended the session — log in again');
    throw new Error(`${tgPhone}: Telegram has ended this session. Run pnpm tg-login again.`);
  }

  let book: BookState = newBook(await clientBook(), Date.now());
  // Re-read on the same tick as the book, so a decision taken on the screen
  // takes effect within ten minutes without touching the connection.
  let rules = await rulesFor(account.managerUserId);
  let stored = 0;
  let passed = 0;
  console.log(
    `tinglayapman: ${account.managerName} · ${tgPhone} · ${book.clients.length} mijoz · ${rules.size} qoida`,
  );

  client.addEventHandler(async (event: { message?: unknown }) => {
    try {
      const msg = event.message as {
        id: number;
        out?: boolean;
        message?: string | null;
        date: number;
        media?: unknown;
        getSender?: () => Promise<unknown>;
      };
      const sender = (await msg.getSender?.()) ?? null;
      const user = sender instanceof Api.User ? sender : null;
      // The same four facts the import reduces a dialog to, so the same
      // function decides. A live message must not be judged by a second rule.
      const peer: DialogPeer = {
        id: BigInt(user?.id?.toString() ?? '0'),
        phone: user?.phone ?? null,
        isPrivate: user !== null,
        isBot: Boolean(user?.bot),
      };

      const now = Date.now();
      if (bookIsStale(book, now)) {
        book = newBook(await clientBook(), now);
        rules = await rulesFor(account.managerUserId);
      }

      let verdict = decideIncoming(peer, msg, book.clients, rules);
      // A number we do not know MIGHT be a client added since the book was
      // read. Ask once, rate-limited, before concluding they are a stranger.
      if (!verdict.store && verdict.reason === 'not_a_client' && shouldRefreshOnMiss(book, now)) {
        book = { ...newBook(await clientBook(), now), missRefreshedAt: now };
        rules = await rulesFor(account.managerUserId);
        verdict = decideIncoming(peer, msg, book.clients, rules);
      }

      if (!verdict.store) {
        // Counted, never named. This is the manager's private life.
        passed += 1;
        return;
      }
      const written = await storeIncoming({
        clientId: verdict.clientId,
        managerUserId: account.managerUserId,
        row: verdict.row,
      });
      if (written) {
        stored += 1;
        console.log(`  ${verdict.clientCode} ← ${verdict.row.direction}`);
      }
    } catch (err) {
      // One bad event must not take the bridge down: it would stop receiving
      // for every client because of one malformed message.
      console.error('xabar ishlanmadi:', err instanceof Error ? err.message : err);
    }
  }, new NewMessage({}));

  const beat = setInterval(() => {
    void heartbeat(account.id).catch(() => {
      // A heartbeat that cannot be written is not a reason to drop the
      // connection; the screen will say "stale" and that is the correct story.
    });
  }, HEARTBEAT_MS);
  await heartbeat(account.id);

  const stop = async (why: string) => {
    clearInterval(beat);
    await markAccount(account.id, 'stopped', why);
    await releaseLock();
    console.log(`\nto‘xtadi (${why}) · yozildi: ${stored} · o‘tkazildi: ${passed}`);
    await client.disconnect();
    await client.destroy();
    await pgClient.end();
    process.exit(0);
  };
  process.on('SIGINT', () => void stop('SIGINT'));
  process.on('SIGTERM', () => void stop('SIGTERM'));

  // Telegram replays a little history on reconnect. The unique index absorbs
  // it, which is why nothing here tracks "where did I get to".
}

main().catch(async (err) => {
  console.error(err instanceof Error ? err.message : err);
  await pgClient.end();
  process.exit(1);
});
