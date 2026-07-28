import 'dotenv/config';
import { pgClient } from '../src/modules/platform/db/client';
import { getSetting } from '../src/modules/platform/settings/service';
import { rulesFor } from '../src/modules/wms/crm/chat-rules';
import {
  claimNext,
  clientHasWritten,
  markAttemptFailed,
  markSent,
  recoverInFlight,
  releaseClaim,
  sentCounts,
} from '../src/modules/wms/crm/outbox';
import {
  canSendNow,
  floodWaitUntil as computeFloodWait,
  isPermanentSendError,
  MAX_ATTEMPTS,
} from '../src/modules/wms/crm/telegram-send';
import {
  clientBook,
  heartbeat,
  loadAccount,
  markAccount,
  markAccountActive,
  resumePoints,
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
import { peerFromChat, tgPhotoPlan, type DialogPeer } from '../src/modules/wms/crm/telegram-import';
import { saveAttachment } from '../src/modules/platform/files/service';
import { generateThumbnails } from '../src/modules/platform/jobs/thumbnails';

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
 * From phase 4 it also SENDS — the one thing phases 1-3 could promise it never
 * did. Replies queued on the «Suhbatlar» screen go out from here, because this
 * is the only process holding a connection to the account. Every rule that
 * governs when a message may go is in `crm/telegram-send.ts`, pure and tested;
 * this file obeys them, one message per tick and never a batch.
 */

/**
 * How far back one chat is caught up on a restart. Two hundred messages is
 * far more than any gap a deploy makes, and it bounds a chat that has been
 * talking all week so startup cannot turn into a full re-import.
 */
const CATCHUP_PER_CHAT = 200;

/**
 * Download an incoming photo and pin it to its message row (owner, item 15:
 * "rasimlarni ko'radigan bo'lsa ham yaxshi edi").
 *
 * Photos only, size stated up front, and only for a NEW row (the caller
 * checks) — a replay never re-downloads. Thumbnails are made INLINE with
 * sharp: `enqueue()` would start the full pg-boss worker fleet — nine
 * groups, nightly backup included — inside this container, which is the
 * two-backup-systems bug (#253-261) all over again.
 */
async function savePhotoFor(
  messageRowId: string,
  msg: { id: number; media?: unknown; downloadMedia?: () => Promise<unknown> },
  managerUserId: string,
): Promise<void> {
  const plan = tgPhotoPlan(msg.media);
  if (!plan.download || typeof msg.downloadMedia !== 'function') return;
  const bytes = await msg.downloadMedia();
  if (!Buffer.isBuffer(bytes) || bytes.length === 0) return;
  const { id } = await saveAttachment(
    {
      entityType: 'tg_message',
      entityId: messageRowId,
      fileName: `photo_${msg.id}.jpg`,
      contentType: 'image/jpeg',
      body: bytes,
      uploadedBy: managerUserId,
    },
    { thumbnails: 'skip' },
  );
  await generateThumbnails(id).catch(() => {});
}

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

  const { TelegramClient, helpers } = await import('telegram');
  const { StringSession } = await import('telegram/sessions');
  const { NewMessage } = await import('telegram/events');

  const client = new TelegramClient(new StringSession(account.session), apiId, apiHash, {
    // Infinity, NOT -1. GramJS uses this as a loop bound
    // (`for (attempt = 0; attempt < retries; …)` in MTProtoSender), so -1
    // means ZERO attempts: `connect()` returns false in a few milliseconds
    // and no socket is ever opened. Infinity is the library's own default and
    // is what "reconnect for ever" actually spells — a warehouse link drops.
    connectionRetries: Infinity,
  });
  // `connect()` reports failure by returning false rather than by throwing,
  // so ignoring its result is how a listener ends up cheerfully doing nothing.
  const connected = await client.connect();
  if (connected === false) {
    throw new Error(`${tgPhone}: Telegram'ga ulanib bo‘lmadi`);
  }
  if (!(await client.checkAuthorization())) {
    await markAccount(account.id, 'signed_out', 'Telegram ended the session — log in again');
    throw new Error(`${tgPhone}: Telegram has ended this session. Run pnpm tg-login again.`);
  }

  // Back to 'active'. A graceful stop writes 'stopped', and nothing else ever
  // wrote 'active' again except a fresh login — so one clean restart left the
  // bridge reading "stopped" for ever, which also made every reply
  // unsendable, because queueing refuses when the bridge is not live.
  await markAccountActive(account.id);

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
        getChat?: () => Promise<unknown>;
      };
      // The CHAT, not the sender. An outgoing private message has no sender at
      // all in GramJS, so reading the sender drops every reply we send while
      // the client's half keeps arriving — see `peerFromChat` and
      // `telegram-peer.test.ts`. The chat is the same person either way, and
      // it is what the import iterates, so both paths reduce a conversation
      // identically.
      const peer: DialogPeer = peerFromChat((await msg.getChat?.()) as never);

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
        // The photograph itself (owner, item 15) — only for a NEW row, so a
        // reconnect replay never re-downloads. A failure here is a missing
        // picture, never a downed bridge.
        await savePhotoFor(written, msg, account.managerUserId).catch((err: unknown) => {
          console.error('rasm olinmadi:', err instanceof Error ? err.message : err);
        });
      }
    } catch (err) {
      // One bad event must not take the bridge down: it would stop receiving
      // for every client because of one malformed message.
      console.error('xabar ishlanmadi:', err instanceof Error ? err.message : err);
    }
  }, new NewMessage({}));

  /* ---------------------------------------------------------------- *
   * The sender — phase 4. Replies queued on the screen go out here,
   * because this is the only process holding a connection to the account.
   * ---------------------------------------------------------------- */

  const recovered = await recoverInFlight(account.managerUserId);
  if (recovered > 0) {
    console.log(`⚠ ${recovered} ta xabar yuborilayotganda uzilib qolgan — tekshiring`);
  }

  // Held in this process rather than in the database: it is a fact about THIS
  // connection's conversation with Telegram, it expires by itself, and a
  // restart is exactly when it should be forgotten.
  let floodWaitUntil: Date | null = null;
  let sent = 0;

  const pump = async () => {
    // Cheap enough to ask every tick, and the switch has to be able to stop
    // sending WITHOUT anybody restarting a process on a server.
    if ((await getSetting('tg_sending_enabled')) !== true) return;
    if (floodWaitUntil && floodWaitUntil.getTime() > Date.now()) return;

    const job = await claimNext(account.managerUserId);
    if (!job) return;
    try {
      const [counts, wroteFirst] = await Promise.all([
        sentCounts(account.managerUserId, job.peerId),
        clientHasWritten(job.clientId, account.managerUserId),
      ]);
      const verdict = canSendNow({
        ...counts,
        clientHasWrittenFirst: wroteFirst,
        sendingEnabled: true,
        floodWaitUntil,
        bridgeLive: true,
      });
      if (!verdict.ok) {
        // A limit is "not yet", not "never" — except the two that ARE never,
        // and those must not sit in the queue pretending they will go.
        if (verdict.reason === 'never_wrote_first') {
          await markAttemptFailed(job.id, 'never_wrote_first', true, MAX_ATTEMPTS);
        } else {
          await releaseClaim(job.id);
        }
        return;
      }

      // Through the library's own big-integer type: a JS `bigint` is not an
      // `EntityLike`, and `Number()` on a Telegram id is a silent wrong
      // recipient. The id resolves out of the entity cache this connection has
      // already filled from the conversation itself.
      const target = helpers.returnBigInt(job.peerId.toString());
      const result = await client.sendMessage(target, { message: job.body });
      await markSent(job.id, result?.id ? BigInt(result.id) : null);
      sent += 1;
      console.log(`  → ${job.clientId.slice(0, 8)} yuborildi`);
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      // Telegram's own instruction, and obeying it is not optional: carrying
      // on through a FLOOD_WAIT is the fastest way to lose the account.
      const seconds = (err as { seconds?: number })?.seconds;
      if (typeof seconds === 'number') {
        floodWaitUntil = computeFloodWait(seconds);
        console.error(`FLOOD_WAIT ${seconds}s — ${floodWaitUntil.toISOString()} gacha to‘xtadim`);
        await releaseClaim(job.id);
        return;
      }
      const permanent = isPermanentSendError(message);
      await markAttemptFailed(job.id, message, permanent, MAX_ATTEMPTS);
      console.error(`yuborilmadi (${permanent ? 'qaytarilmaydi' : 'qayta urinaman'}):`, message);
    }
  };

  // One message per tick, deliberately. Not a batch loop: a queue that drains
  // as fast as it can is exactly the burst that gets an account flagged, and
  // at three seconds a message the human on the other end cannot tell.
  const sender = setInterval(() => {
    void pump().catch((err) => {
      console.error('navbat:', err instanceof Error ? err.message : err);
    });
  }, 3000);

  /* ---------------------------------------------------------------- *
   * Catch-up. Everything sent while this listener was down.
   * ---------------------------------------------------------------- */

  /**
   * GramJS does NOT do this for us. `catchUp()` in the pinned version is an
   * empty stub (`client/updates.js:65`) and the package never calls
   * `updates.GetDifference`, so a reconnect simply resumes from wherever the
   * new session starts — every message sent in between is delivered to
   * nobody, ever. A `docker compose up -d --build` takes the listener down
   * for a minute or two, and this company deploys.
   *
   * So each conversation is picked back up from the highest message id
   * already stored for it, through the SAME decide-and-store path a live
   * message takes. The unique index makes it idempotent, which is what lets
   * this run on every start without bookkeeping of its own.
   */
  const catchUp = async () => {
    const points = await resumePoints(account.managerUserId);
    if (points.length === 0) return;
    let recovered = 0;
    for (const point of points) {
      try {
        for await (const msg of client.iterMessages(
          helpers.returnBigInt(point.peerId.toString()),
          // Strictly newer than what we hold. `limit` bounds a chat that has
          // been busy for a week; anything older than that gap is history and
          // belongs to `pnpm tg-import`, not to a restart.
          { minId: Number(point.lastMessageId), limit: CATCHUP_PER_CHAT },
        )) {
          const peer = peerFromChat((await msg.getChat?.()) as never);
          const verdict = decideIncoming(peer, msg, book.clients, rules);
          if (!verdict.store) continue;
          const written = await storeIncoming({
            clientId: verdict.clientId,
            managerUserId: account.managerUserId,
            row: verdict.row,
          });
          if (written) {
            recovered += 1;
            await savePhotoFor(written, msg, account.managerUserId).catch(() => {});
          }
        }
      } catch (err) {
        // One unreachable chat must not stop the rest catching up.
        console.error('catch-up:', err instanceof Error ? err.message : err);
      }
    }
    if (recovered > 0) console.log(`uzilish davridagi ${recovered} ta xabar olindi`);
  };
  await catchUp().catch((err) => {
    // Never fatal: a bridge that refuses to start because it could not
    // backfill is worse than one that starts and is a little behind.
    console.error('catch-up umuman ishlamadi:', err instanceof Error ? err.message : err);
  });

  const beat = setInterval(() => {
    // Only while the LINK is up. Writing it unconditionally would prove the
    // process is alive, which is not the question anybody is asking: a
    // listener sitting there with a dead socket would read as "connected" and
    // the messages would simply stop.
    if (client.connected === false) return;
    void heartbeat(account.id).catch(() => {
      // A heartbeat that cannot be written is not a reason to drop the
      // connection; the screen will say "stale" and that is the correct story.
    });
  }, HEARTBEAT_MS);
  await heartbeat(account.id);

  const stop = async (why: string) => {
    clearInterval(beat);
    clearInterval(sender);
    await markAccount(account.id, 'stopped', why);
    await releaseLock();
    console.log(
      `\nto‘xtadi (${why}) · yozildi: ${stored} · o‘tkazildi: ${passed} · yuborildi: ${sent}`,
    );
    await client.disconnect();
    await client.destroy();
    await pgClient.end();
    process.exit(0);
  };
  process.on('SIGINT', () => void stop('SIGINT'));
  process.on('SIGTERM', () => void stop('SIGTERM'));

}

/**
 * Terminal failures back off before exiting.
 *
 * The container runs under `restart: unless-stopped`, which is right for a
 * bridge that must come back after a reboot — and wrong for a session
 * Telegram has ended, or a lock another listener holds, because docker would
 * restart it instantly, for ever. Thirty seconds turns a spin into a slow
 * knock, which is what those conditions deserve: they need a person, not a
 * retry.
 */
const BACKOFF_MS = 30_000;

main().catch(async (err) => {
  const message = err instanceof Error ? err.message : String(err);
  console.error(message);
  await pgClient.end();
  await new Promise((resolve) => setTimeout(resolve, BACKOFF_MS));
  process.exit(1);
});
