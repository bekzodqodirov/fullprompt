import 'dotenv/config';
import { pgClient } from '../src/modules/platform/db/client';
import { getSetting } from '../src/modules/platform/settings/service';
import { rulesFor } from '../src/modules/wms/crm/chat-rules';
import {
  claimNext,
  clientHasWritten,
  loadOutboxPhoto,
  markAttemptFailed,
  markSent,
  recordSentPhoto,
  recoverInFlight,
  releaseClaim,
  sentCounts,
  wasSentWithPhoto,
} from '../src/modules/wms/crm/outbox';
import {
  canSendNow,
  floodWaitUntil as computeFloodWait,
  isDbUnreachable,
  isPermanentSendError,
  isSessionDead,
  MAX_ATTEMPTS,
} from '../src/modules/wms/crm/telegram-send';
import { notifyStaffTelegram } from '../src/modules/platform/notifications/staff';
import {
  applyEdit,
  clientBook,
  heartbeat,
  listListenablePhones,
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
 * How long the database may be unreachable before the manager is told, in
 * their own Telegram (round 48).
 *
 * Thirty seconds of blips are normal and self-healing; his outage ran for
 * days with nothing but a log line to show for it, because the only thing
 * that could have raised the alarm was the database.
 */
const DB_ALERT_AFTER_MS = 60_000;

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

async function listenAccount(tgPhone: string): Promise<(why: string) => Promise<void>> {
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

  const { Api, TelegramClient, helpers } = await import('telegram');
  const { StringSession } = await import('telegram/sessions');
  const { NewMessage } = await import('telegram/events');
  const { EditedMessage } = await import('telegram/events/EditedMessage');

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
        // reconnect replay never re-downloads. An outgoing echo whose photo
        // WE uploaded is skipped too: the bytes are already in storage,
        // claimed onto the row by the sender. A failure here is a missing
        // picture, never a downed bridge.
        const ownUpload =
          verdict.row.direction === 'out' &&
          verdict.row.hasMedia &&
          (await wasSentWithPhoto(account.managerUserId, verdict.row.peerId, verdict.row.tgMessageId));
        if (!ownUpload) {
          await savePhotoFor(written, msg, account.managerUserId).catch((err: unknown) => {
            console.error('rasm olinmadi:', err instanceof Error ? err.message : err);
          });
        }
      }
    } catch (err) {
      // One bad event must not take the bridge down: it would stop receiving
      // for every client because of one malformed message.
      console.error('xabar ishlanmadi:', err instanceof Error ? err.message : err);
    }
  }, new NewMessage({}));

  // Edits. A client who fixes a price in an earlier message has CHANGED the
  // record the manager acts on — the stored copy must follow. UPDATE-only in
  // `applyEdit`, so an edit in a chat we never kept touches nothing, which
  // also means no book lookup is needed here at all.
  client.addEventHandler(async (event: { message?: unknown }) => {
    try {
      const msg = event.message as {
        id: number;
        message?: string | null;
        getChat?: () => Promise<unknown>;
      };
      const peer: DialogPeer = peerFromChat((await msg.getChat?.()) as never);
      if (!peer.id) return;
      const applied = await applyEdit({
        managerUserId: account.managerUserId,
        peerId: peer.id,
        tgMessageId: BigInt(msg.id),
        body: msg.message?.trim() ? msg.message : null,
      });
      if (applied) console.log('  ✎ tahrir qabul qilindi');
    } catch (err) {
      console.error('tahrir ishlanmadi:', err instanceof Error ? err.message : err);
    }
  }, new EditedMessage({}));

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

  /**
   * A message Telegram has ACCEPTED and the database has not heard about yet
   * (round 48, the owner's item 14).
   *
   * This is the gap his stuck reply fell through. The old code sent, then
   * called `markSent`, and treated a failure of the SECOND as a failure of the
   * first: on a database blip the row was marked failed — or, when the
   * database was properly gone, left in `sending` for ever while the screen
   * read «navbatda» and the client had already answered. A message that has
   * left is a fact about the outside world; it cannot be un-sent by a local
   * error, and it must never be re-sent to fix one.
   *
   * So the fact is held HERE until the database accepts it, retried on every
   * tick, and nothing else is claimed while it is outstanding — which also
   * keeps the queue in order.
   */
  let unsettled: { id: string; tgMessageId: bigint | null } | null = null;
  /** Consecutive ticks that could not reach the database at all. */
  let dbDownSince: Date | null = null;
  let dbAlertSent = false;

  /**
   * Tell the human, without the database.
   *
   * Every other alarm in this system is a row somebody reads on a screen the
   * database serves — useless for exactly this failure. The listener holds a
   * live connection to the manager's own Telegram, so it writes to their
   * Saved Messages, which needs nothing but the socket it already has. Once
   * per outage: an alarm that repeats every three seconds is an alarm nobody
   * reads twice.
   */
  const alertOwner = async (text: string) => {
    try {
      await client.sendMessage('me', { message: `⚠️ GSR: ${text}` });
    } catch {
      // Nothing left to try; the log is the last resort.
    }
  };

  /**
   * The session is dead, so the alarm cannot ride on it.
   *
   * Round 48's alarm went to the manager's own Saved Messages because the
   * DATABASE was the broken thing. Here it is the opposite: the database is
   * fine and the Telegram account is gone, so the message goes through the
   * ordinary notification path and is delivered by the BOT — a different
   * transport, which is the whole reason it still works.
   */
  const announceSessionDead = async (reason: string) => {
    try {
      await notifyStaffTelegram({
        userIds: [account.managerUserId],
        type: 'TelegramSessionEnded',
        text:
          `⚠️ Telegram seansingiz tugatilgan (${reason}).\n` +
          `Mijozlarga javob yuborib bo‘lmaydi. Saytda «Suhbatlar → Ulash» orqali ` +
          `qayta ulaning.`,
      });
    } catch (err) {
      console.error('ogohlantira olmadim:', err instanceof Error ? err.message : err);
    }
  };

  const noteDbFailure = async (err: unknown) => {
    const message = err instanceof Error ? err.message : String(err);
    console.error('navbat:', message);
    if (!dbDownSince) dbDownSince = new Date();
    const downMs = Date.now() - dbDownSince.getTime();
    if (downMs > DB_ALERT_AFTER_MS && !dbAlertSent) {
      dbAlertSent = true;
      await alertOwner(
        `bazaga ulanib bo'lmayapti (${message}). Telegram xabarlari saqlanmayapti.` +
          ` Serverda: docker compose --profile telegram restart tg-listen`,
      );
    }
  };

  const noteDbOk = () => {
    if (dbDownSince && dbAlertSent) void alertOwner('baza qaytdi, hammasi joyida.');
    dbDownSince = null;
    dbAlertSent = false;
  };

  const pump = async () => {
    // A message that already left has to be written down before anything else
    // goes out, or the queue reorders itself around a failure.
    if (unsettled) {
      try {
        await markSent(unsettled.id, unsettled.tgMessageId);
        console.log(`  → ${unsettled.id.slice(0, 8)} nihoyat yozildi`);
        unsettled = null;
        noteDbOk();
      } catch (err) {
        await noteDbFailure(err);
      }
      return;
    }

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
      let result: { id?: number; date?: number } | undefined;
      if (job.attachmentId) {
        const photo = await loadOutboxPhoto(job.attachmentId);
        if (!photo) {
          // The bytes are gone (or the row is); no retry can conjure them.
          await markAttemptFailed(job.id, 'photo_missing', true, MAX_ATTEMPTS);
          return;
        }
        const { CustomFile } = await import('telegram/client/uploads');
        result = (await client.sendFile(target, {
          file: new CustomFile(photo.fileName, photo.bytes.length, '', photo.bytes),
          caption: job.body || undefined,
        })) as { id?: number; date?: number };
      } else {
        result = await client.sendMessage(target, { message: job.body });
      }
      // From here the message EXISTS in somebody's Telegram. Every failure
      // below is a bookkeeping failure and is treated as one.
      const tgMessageId = result?.id ? BigInt(result.id) : null;
      try {
        await markSent(job.id, tgMessageId);
        noteDbOk();
      } catch (err) {
        unsettled = { id: job.id, tgMessageId };
        await noteDbFailure(err);
        return;
      }
      // The echo is written HERE, so the thread shows the photo we uploaded
      // instead of downloading a second copy when Telegram echoes it back.
      if (job.attachmentId && result?.id) {
        await recordSentPhoto({
          clientId: job.clientId,
          managerUserId: account.managerUserId,
          peerId: job.peerId,
          tgMessageId: BigInt(result.id),
          body: job.body,
          attachmentId: job.attachmentId,
          sentAt: new Date((result.date ?? Math.floor(Date.now() / 1000)) * 1000),
        }).catch((err: unknown) => {
          console.error('rasm yozilmadi:', err instanceof Error ? err.message : err);
        });
      }
      sent += 1;
      console.log(`  → ${job.clientId.slice(0, 8)} yuborildi`);
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      // Telegram's own instruction, and obeying it is not optional: carrying
      // on through a FLOOD_WAIT is the fastest way to lose the account.
      const seconds = (err as { seconds?: number })?.seconds;
      // A database that is not there is not a send that failed: the message
      // never left, so the row must go back in the queue rather than be
      // marked failed by a write that would fail too.
      if (isDbUnreachable(message)) {
        await noteDbFailure(err);
        await releaseClaim(job.id).catch(() => {});
        return;
      }
      // Telegram ended the SESSION. Nothing this account sends will work
      // again until somebody logs in, so retrying is not perseverance, it is
      // a dead loop knocking every three seconds — which is what the owner's
      // logs showed, eight «qayta urinaman» in a row against a revoked
      // session while the screen said the bridge was live.
      if (isSessionDead(message)) {
        console.error(`SESSION o‘lgan: ${message} — qayta ulanish kerak`);
        // The reply itself is fine and goes out when he reconnects; failing
        // it would throw away an answer a client is still waiting for.
        await releaseClaim(job.id).catch(() => {});
        await announceSessionDead(message);
        void stop(message, 'signed_out');
        return;
      }
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
      void noteDbFailure(err);
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

  const stop = async (
    why: string,
    status: 'stopped' | 'signed_out' = 'stopped',
    /**
     * End the session inside TELEGRAM too, not merely here.
     *
     * Set when a manager pressed «chiqish» (round 50). This process is the
     * only one holding a live connection, so it is the only place the logout
     * can actually happen — the web app deleted the stored session, which
     * stops US using the account, and this is what stops the account being
     * logged in at all. Best-effort: a session Telegram has already revoked
     * refuses the call, and that is the same outcome.
     */
    logOutOfTelegram = false,
  ) => {
    clearInterval(beat);
    clearInterval(sender);
    if (logOutOfTelegram) {
      await client.invoke(new Api.auth.LogOut()).catch((err: unknown) => {
        console.error('logout:', err instanceof Error ? err.message : err);
      });
    }
    // 'stopped' is an ordinary shutdown and the supervisor may start it again;
    // 'signed_out' is terminal and it must NOT — the screen has to say «log in
    // again» rather than «starting…» for ever.
    await markAccount(account.id, status, why);
    await releaseLock();
    console.log(
      `\n${tgPhone} to‘xtadi (${why}) · yozildi: ${stored} · o‘tkazildi: ${passed} · yuborildi: ${sent}`,
    );
    await client.disconnect();
    await client.destroy();
  };
  return stop;
}

/**
 * How the bridge runs since round 21: ONE process, EVERY stored account.
 *
 * `--tg +998...` still pins a single account (the shape the old compose
 * block used). Without it, the supervisor scans `tg_accounts` once a
 * minute and starts a listener for any account it is not already holding
 * — which is what lets a manager connect their Telegram from the app
 * («ulash» screen) and start receiving without anybody touching docker.
 * `signed_out` accounts are skipped entirely: Telegram ended those, and a
 * knock a minute on a dead session is how accounts get flagged. A failed
 * start backs off five minutes so a broken account cannot turn the scan
 * into a hammer.
 */
const SCAN_MS = 60_000;
const START_BACKOFF_MS = 5 * 60_000;

async function main() {
  const argv = process.argv.slice(2);
  const i = argv.indexOf('--tg');
  const pinned = i >= 0 ? argv[i + 1] : undefined;

  const running = new Map<
    string,
    (why: string, status?: 'stopped' | 'signed_out', logOut?: boolean) => Promise<void>
  >();
  const nextTryAt = new Map<string, number>();

  const startOne = async (phone: string) => {
    try {
      running.set(phone, await listenAccount(phone));
    } catch (err) {
      running.delete(phone);
      nextTryAt.set(phone, Date.now() + START_BACKOFF_MS);
      console.error(`${phone}:`, err instanceof Error ? err.message : err);
    }
  };

  const scan = async () => {
    const phones = pinned ? [pinned] : await listListenablePhones();
    // Round 50: the scan STOPS as well as starts. It only ever started, so a
    // manager who disconnected on the «ulash» screen stayed connected until
    // somebody restarted the container — which made the button a promise the
    // server did not keep. An account leaves this list only by a deliberate
    // act (disconnect, or a session Telegram ended), so leaving it is an
    // instruction: drop the connection, and log out of Telegram while we
    // still hold one.
    if (!pinned) {
      const listenable = new Set(phones);
      for (const [phone, stop] of [...running.entries()]) {
        if (listenable.has(phone)) continue;
        running.delete(phone);
        console.log(`${phone}: uzildi — tinglashni to‘xtatdim`);
        await stop('disconnected by the manager', 'signed_out', true).catch(() => {});
      }
    }
    for (const phone of phones) {
      if (running.has(phone)) continue;
      if ((nextTryAt.get(phone) ?? 0) > Date.now()) continue;
      await startOne(phone);
    }
  };

  await scan();
  if (pinned && !running.has(pinned)) {
    // The old single-account contract: a pinned phone that cannot start is
    // a fatal error the container's restart policy (and its backoff below)
    // should see — not something to idle on for ever.
    throw new Error(`${pinned}: ishga tushmadi — yuqoridagi xatoni ko‘ring`);
  }
  const rescans = setInterval(() => {
    void scan().catch((err) => {
      console.error('scan:', err instanceof Error ? err.message : err);
    });
  }, SCAN_MS);

  const stopAll = async (why: string) => {
    clearInterval(rescans);
    for (const stop of running.values()) {
      await stop(why).catch(() => {});
    }
    await pgClient.end();
    process.exit(0);
  };
  process.on('SIGINT', () => void stopAll('SIGINT'));
  process.on('SIGTERM', () => void stopAll('SIGTERM'));
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
