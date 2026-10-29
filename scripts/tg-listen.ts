import 'dotenv/config';
import { pgClient } from '../src/modules/platform/db/client';
import { getSetting } from '../src/modules/platform/settings/service';
import { recordCandidates, rulesFor } from '../src/modules/wms/crm/chat-rules';
import {
  claimNext,
  clientHasWritten,
  giveClaimBack,
  loadOutboxFile,
  markAttemptFailed,
  markSent,
  OUTBOX_CHANNEL,
  recordSent,
  recoverInFlight,
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
  markHistoryBackfilled,
  needsHistoryBackfill,
  recordChatRead,
  resumePoints,
  storeIncoming,
  takeListenerLock,
} from '../src/modules/wms/crm/telegram-accounts';
import {
  backfillCutoff,
  backfillStep,
  withinWindow,
  BACKFILL_DAYS,
  BACKFILL_PER_CHAT,
} from '../src/modules/wms/crm/history-backfill';
import {
  bookIsStale,
  decideIncoming,
  newBook,
  shouldRefreshOnMiss,
  HEARTBEAT_MS,
  type BookState,
  type LiveVerdict,
} from '../src/modules/wms/crm/telegram-live';
import {
  peerFromChat,
  peerIdFromUpdate,
  peerTitle,
  tgMediaPlan,
  toMessageRow,
  type DialogPeer,
  type RawMessage,
} from '../src/modules/wms/crm/telegram-import';
import {
  confirmSiteTagOnCard,
  landSiteTag,
  openOffersFor,
  recordAccountUsername,
} from '../src/modules/wms/crm/site-assign';
import {
  primaryUsername,
  siteTagAction,
  suspectsStaleBook,
} from '../src/modules/wms/crm/site-assign-rules';
import { isWorkAccount, leadForChat } from '../src/modules/wms/crm/chat-lead';
import { indexPeers, lastIndexedAt, type PeerSeen } from '../src/modules/wms/crm/peer-index';
import { saveAttachment } from '../src/modules/platform/files/service';
import { generateThumbnails } from '../src/modules/platform/jobs/thumbnails';
import { enqueue } from '../src/modules/platform/jobs/boss';
import { TELEGRAM_DEVICE } from '../src/modules/wms/crm/telegram-device';
import { FloodRecordingLogger } from '../src/modules/wms/crm/telegram-logger';
import { floodEnds, isSendFloodMethod, pumpGate, tgErrorKind } from '../src/modules/wms/crm/telegram-guard';
import { readGuard, stampAgentPump } from '../src/modules/wms/crm/account-guard';
import {
  accountFlooded,
  accountRestricted,
  agentTelegramNotice,
  announceSessionDeadToOthers,
  type AlarmAccount,
} from '../src/modules/wms/crm/account-alarm';
import { markAutoSent, markDeleted, wasAutoSent } from '../src/modules/wms/crm/message-flags';
import {
  agentRunning,
  agentTablesReady,
  readAgentConfig,
  type AgentConfig,
} from '../src/modules/wms/agent/config';
import {
  INBOUND_START_AFTER_S,
  JOB_AGENT_HUMAN_REPLY,
  JOB_AGENT_INBOUND,
  shouldStartAgentRun,
  type AgentHumanReplyJob,
  type AgentInboundJob,
} from '../src/modules/wms/agent/queues';
import {
  agentSendVerdict,
  runAgentStep,
  slotHold,
  verdictOutcome,
  type AgentOutboxRow,
  type SendTurn,
  type StepOutcome,
  type WaitReason,
} from '../src/modules/wms/agent/send-step';
import {
  agentStepStore,
  applyAgentOutcome,
  badgeRestored,
  badgesToRestore,
  dueAgentRow,
  recoverAgentInFlight,
  type OutcomeReport,
} from '../src/modules/wms/agent/outbox-store';
import { agentTelegramOver } from '../src/modules/wms/agent/gramjs-adapter';
import { isNudge } from '../src/modules/wms/agent/worthy';
import {
  isNewestInbound,
  isTelegramServiceNotice,
  noteStranger,
  stampPeerTyping,
  strangerUserOf,
  telegramNoticeKind,
  type StrangerUser,
  type TelegramNoticeKind,
} from '../src/modules/wms/agent/listener-hooks';
import {
  claimPeerPull,
  finishPeerPull,
  newestInboundSince,
  PULL_GAP_MS,
  PULL_MESSAGES,
  PULL_WINDOW_MS,
  releaseStalePulls,
} from '../src/modules/wms/agent/peer-pulls';
import { onAgentOutboxSettled } from '../src/modules/wms/agent/settle-hooks';

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
 * How often the account's own @handle is re-read (round 113). Twenty minutes
 * keeps it inside the website's one-hour trust window with two misses to
 * spare, and the same call is the session probe the heartbeat is not: a
 * revoked session keeps a live socket (round 49), so only asking Telegram
 * something that needs the authorisation says it is gone.
 */
const USERNAME_REFRESH_MS = 20 * 60_000;

/**
 * How often the lookback index is rebuilt from the account's own dialog list.
 *
 * 0064 created `tg_peer_index` and nothing has ever written to it — the table
 * is the answer to «has anybody here talked to this number», and until this
 * pass existed the answer was always no. It has to run HERE, in the listener,
 * because building it needs a live Telegram connection and this process is
 * the only thing that holds one.
 *
 * A day, and «not more often than a day»: the listener restarts on every
 * deploy, and walking four hundred dialogs on each boot is a burst with no
 * purpose. The index is a hint on a card, not a ledger — being twelve hours
 * stale costs a manager one line they would have seen anyway.
 */
const INDEX_EVERY_MS = 24 * 60 * 60 * 1000;

/**
 * How a stored message reached this process — the agent's hook asks
 * (`shouldStartAgentRun`, spec §17.3.1). Only a LIVE inbound may start a
 * run: catch-up, the connect-time week and the site sweep's replay are
 * history, and an answer to a message a day old is the shape that reads as
 * a robot. A one-peer pull asks ONCE, at its end, for the newest line.
 */
type ListenOrigin = 'live' | 'catch_up' | 'backfill' | 'site_sweep' | 'pull';

/**
 * The peer as the deciding code sees it, plus what the gramjs USER says about
 * itself — in his contacts, deleted — which `peerFromChat` leaves out because
 * nothing that decides storing may read it. Only the stranger card's hook
 * does (`noteStranger`, his Q18 ⭐).
 */
type ListenPeer = DialogPeer & { user?: StrangerUser | null };

const listenPeer = (chat: unknown): ListenPeer => ({ ...peerFromChat(chat as never), user: strangerUserOf(chat) });

/**
 * How long the agent's settings are trusted inside the message handler: a
 * busy chat must not cost a query per line, and a switch flipped on the
 * screen reaches the hook within half a minute (the worker's sweep picks up
 * what arrived in between).
 */
const AGENT_CONFIG_TTL_MS = 30_000;

/**
 * How often «a pump that knows agent_outbox is running here» is written
 * (regression-3). The app refuses ✅ unless the stamp is under two minutes
 * old (`AGENT_LIMITS.pumpFreshMs`), so a quarter of a minute keeps it fresh
 * with room for a slow tick, without an UPDATE on every knock.
 */
const PUMP_STAMP_MS = 15_000;

/** The 0138 probe while it still answers «no» — asked at most this often. */
const TABLES_RECHECK_MS = 60_000;

/** «The customer is typing» is written at most this often per chat. */
const TYPING_STAMP_MS = 5_000;

/**
 * Download an incoming photo, VOICE/AUDIO message or FILE and pin it to its
 * row (owner, item 15: "rasimlarni ko'radigan bo'lsa ham yaxshi edi"; then
 * 2026-08-07: «audio habarlar bizni sistemada korinmayabti»; then 2026-08-11:
 * «klientlar ham bizga fillar jonatishadi»).
 *
 * What deserves a download is decided by `tgMediaPlan` — pure, unit-tested,
 * and always from the message alone BEFORE any network I/O. Only for a NEW
 * row (the caller checks), so a replay never re-downloads. Thumbnails are
 * made INLINE with sharp, and only for a photo: `enqueue()` would start the
 * full pg-boss worker fleet — nine groups, nightly backup included — inside
 * this container, which is the two-backup-systems bug (#253-261) all over
 * again.
 */
async function saveMediaFor(
  messageRowId: string,
  msg: { id: number; media?: unknown; downloadMedia?: () => Promise<unknown> },
  managerUserId: string,
): Promise<void> {
  const plan = tgMediaPlan(msg.media, msg.id);
  if (!plan.download || typeof msg.downloadMedia !== 'function') return;
  const bytes = await msg.downloadMedia();
  if (!Buffer.isBuffer(bytes) || bytes.length === 0) return;
  const { id } = await saveAttachment(
    {
      entityType: 'tg_message',
      entityId: messageRowId,
      fileName: plan.fileName,
      contentType: plan.contentType,
      body: bytes,
      uploadedBy: managerUserId,
    },
    { thumbnails: 'skip' },
  );
  // A voice note has no thumbnail, and asking sharp for one logs a failure
  // for every message a client speaks.
  if (plan.kind === 'photo') await generateThumbnails(id).catch(() => {});
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
  const { NewMessage, Raw } = await import('telegram/events');
  const { EditedMessage } = await import('telegram/events/EditedMessage');

  /** Who an account alarm names, and whose agent it may switch off. */
  const alarmAccount: AlarmAccount = {
    id: account.id,
    managerUserId: account.managerUserId,
    managerName: account.managerName,
  };

  /**
   * A FLOOD_WAIT gramjs slept through (≤ 60 s) — a row now, not a silence
   * (ban-2). Fire-and-forget from inside gramjs's invoke loop, and never
   * allowed to throw back into it.
   */
  const onFloodSleep = (sleep: { seconds: number; method: string }) => {
    void accountFlooded(alarmAccount, { ...sleep, source: 'sleep' }).catch((err: unknown) => {
      console.error('flood yozilmadi:', err instanceof Error ? err.message : err);
    });
  };

  const client = new TelegramClient(new StringSession(account.session), apiId, apiHash, {
    // Infinity, NOT -1. GramJS uses this as a loop bound
    // (`for (attempt = 0; attempt < retries; …)` in MTProtoSender), so -1
    // means ZERO attempts: `connect()` returns false in a few milliseconds
    // and no socket is ever opened. Infinity is the library's own default and
    // is what "reconnect for ever" actually spells — a warehouse link drops.
    connectionRetries: Infinity,
    // One honest device name on every connect (ban-12), never the kernel
    // version of whichever machine the container landed on.
    ...TELEGRAM_DEVICE,
    // gramjs keeps its 60-second flood sleep (ban-2's DEVIATION); this
    // logger is how a sleep becomes a ledger row the agent's fuse can count.
    baseLogger: new FloodRecordingLogger(onFloodSleep),
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

  // The account's own @handle, read BEFORE the bridge reports itself live:
  // the website sends visitors to this name, and the panel reads «live, never
  // stamped» as «this listener predates round 113» — so the stamp must never
  // trail the first heartbeat.
  let selfId: string | null = null;
  const readOwnUsername = async () => {
    const me = (await client.getMe()) as {
      id?: { toString(): string };
      username?: string | null;
      usernames?: { username: string; active?: boolean }[] | null;
    };
    selfId = me.id?.toString() ?? selfId;
    await recordAccountUsername(account.id, primaryUsername(me));
  };
  await readOwnUsername().catch((err: unknown) => {
    const message = err instanceof Error ? err.message : String(err);
    // Not fatal: the next refresh tries again, and until then the website
    // simply does not offer this account.
    console.error('username o‘qilmadi:', message);
  });

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
  // Strangers put on the tray for the manager to answer about (round 79).
  let asked = 0;
  let workAccount = await isWorkAccount(account.managerUserId);
  console.log(
    `tinglayapman: ${account.managerName} · ${tgPhone} · ${book.clients.length} mijoz · ${rules.size} qoida`,
  );

  /**
   * Does 0138 exist here? The kernel's probe caches only TRUE, so on a
   * database one migration behind it would ask on every tick; the answer
   * «no» is re-asked once a minute instead. Every agent path, and every new
   * read in the human pump, goes through this first — on an old schema the
   * listener runs exactly the code it ran before (regression-3 b).
   */
  let tablesKnownReady = false;
  let tablesCheckedAt = 0;
  const tablesReady = async (): Promise<boolean> => {
    if (tablesKnownReady) return true;
    if (Date.now() - tablesCheckedAt < TABLES_RECHECK_MS) return false;
    tablesCheckedAt = Date.now();
    tablesKnownReady = await agentTablesReady();
    return tablesKnownReady;
  };

  /** The agent's settings as the message handler sees them — cached, never a query per line. */
  let agentConfigCache: { at: number; value: AgentConfig | null } | null = null;
  const agentConfigSoon = async (): Promise<AgentConfig | null> => {
    if (agentConfigCache && Date.now() - agentConfigCache.at < AGENT_CONFIG_TTL_MS) return agentConfigCache.value;
    const value = (await tablesReady()) ? await readAgentConfig() : null;
    agentConfigCache = { at: Date.now(), value };
    return value;
  };
  /** Is the agent speaking from THIS account right now (by the cached settings)? */
  const agentHere = async (): Promise<boolean> => {
    const config = await agentConfigSoon();
    return agentRunning(config) && config.ownerUserId === account.managerUserId;
  };

  /**
   * Telegram itself wrote to this account (his ⭐2, final review K33): the
   * agent goes off at once when it speaks from here, and the alarm says so in
   * words (`agentTelegramNotice`) — unless the line is his own login traffic
   * (`telegramNoticeKind`), which switches nothing off and costs nothing of
   * the waiting work. Not the cached settings — a notice minutes after the
   * switch was flipped on must not slip through a stale cache — and nothing
   * of the message is stored, logged or forwarded by this: only its KIND
   * arrives here, and the line goes on to `handleMessage` exactly as it
   * always did. A database one migration behind has no agent to switch off.
   * A failure is a logged line, never a downed bridge.
   */
  const telegramNoticeSeen = async (kind: TelegramNoticeKind) => {
    try {
      if (!(await tablesReady())) return;
      const { agentOff } = await agentTelegramNotice(alarmAccount, kind);
      if (agentOff) console.error('TELEGRAM XIZMATI (777000) XABAR YUBORDI — AI sotuvchi o‘chirildi');
      else if (kind === 'login') console.log('  🔑 Telegram (777000): kirish kodi yoki yangi kirish — AI o‘chirilmadi');
    } catch (err) {
      console.error('Telegram xizmati xabari AI ni o‘chirmadi:', err instanceof Error ? err.message : err);
    }
  };

  /**
   * A website visitor's tag, turned into the chat's rule BEFORE the message
   * is decided (round 113) — so the tagged message and every later one take
   * the lead-rule road that already works, instead of a second one.
   *
   * The rule goes into the in-memory map in the SAME step it is written: the
   * map is otherwise reloaded every ten minutes, and a visitor's «Salom, 20
   * kub yuk bor» two seconds after the tag would be decided against the old
   * map and dropped as a hidden number, for good.
   */
  const applySiteTag = async (
    peer: DialogPeer,
    msg: RawMessage & { id: number },
    verdict: LiveVerdict,
  ): Promise<boolean> => {
    const action = siteTagAction(verdict, toMessageRow(peer.id, msg));
    if (!action) return false;
    if (action.kind === 'confirm') {
      await confirmSiteTagOnCard({
        managerUserId: account.managerUserId,
        tag: action.tag,
        peerId: peer.id,
        clientId: action.clientId,
        leadId: action.leadId,
      }).catch((err: unknown) => {
        console.error('sayt belgisi:', err instanceof Error ? err.message : err);
      });
      return false;
    }
    const name = [peer.firstName, peer.lastName].filter(Boolean).join(' ').trim();
    const landing = await landSiteTag({
      managerUserId: account.managerUserId,
      tag: action.tag,
      peer: { id: peer.id, phone: peer.phone ?? null, title: name || null, username: peer.username ?? null },
      text: (msg.message ?? '').trim(),
      // The first-contact fence: one message older than this one means this
      // person already talks to the manager, and a tag they paste is not a
      // website arrival. Asked only for a tagged message; an error answers
      // «yes», so a Telegram hiccup sends the chat to the tray, never past it.
      wroteBefore: async () => {
        try {
          const older = await client.getMessages(helpers.returnBigInt(peer.id.toString()), {
            limit: 1,
            maxId: msg.id,
          });
          return older.length > 0;
        } catch {
          return true;
        }
      },
    });
    if (!landing.landed) {
      console.log(`  🌐 ${action.tag}: ${landing.reason}`);
      return false;
    }
    rules.set(peer.id, {
      peerId: peer.id,
      decision: 'include',
      clientId: landing.clientId,
      clientCode: landing.clientCode,
      leadId: landing.leadId,
    });
    console.log(`  🌐 sayt ${action.tag} → ${landing.outcome}`);
    return true;
  };

  /**
   * One conversation's messages are handled one at a time. gramjs runs event
   * handlers concurrently, and a tagged first message and the photo sent a
   * second after it must not race each other past the rule the first one is
   * writing. Different conversations still run side by side.
   */
  const inFlightByPeer = new Map<string, Promise<unknown>>();
  const serialised = <T>(key: string, work: () => Promise<T>): Promise<T | undefined> => {
    const prior = inFlightByPeer.get(key) ?? Promise.resolve();
    // Never rejects: `work` catches its own errors, and a rejected link here
    // would be an unhandled rejection that takes the whole bridge down.
    const next = prior.then(work, work).catch(() => undefined);
    inFlightByPeer.set(key, next);
    void next.finally(() => {
      if (inFlightByPeer.get(key) === next) inFlightByPeer.delete(key);
    });
    return next;
  };

  client.addEventHandler(async (event: { message?: unknown }) => {
    try {
      const msg = event.message as RawMessage & {
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
      const peer = listenPeer(await msg.getChat?.());
      // Before anything else decides about the line: an official notice switches the agent off first.
      if (isTelegramServiceNotice(peer, msg.out === true)) await telegramNoticeSeen(telegramNoticeKind(msg.message ?? ''));
      await serialised(peer.id.toString(), () => handleMessage(peer, msg, 'live'));
    } catch (err) {
      // One bad event must not take the bridge down: it would stop receiving
      // for every client because of one malformed message.
      console.error('xabar ishlanmadi:', err instanceof Error ? err.message : err);
    }
  }, new NewMessage({}));

  /**
   * What a NEW stored row tells the agent (spec §17.3.1), after its media
   * is saved: the customer's own robot is flagged FIRST (ban-4 — the worker
   * reads the flag when the job arrives), then the pure decision says whether
   * this line starts a run or retires one. The listener only enqueues; the
   * worker decides what a human reply means. A failure here is a missed
   * draft, never a downed bridge.
   */
  const afterStored = async (
    writtenId: string,
    row: { peerId: bigint; tgMessageId: bigint; direction: 'in' | 'out' },
    msg: unknown,
    origin: ListenOrigin,
  ) => {
    try {
      if (wasAutoSent(msg)) await markAutoSent(writtenId);
      // A pull stores a whole day of the chat; it asks for ONE run, for its
      // newest line, when it is done — not one per message it walked.
      if (origin === 'pull') return;
      const config = await agentConfigSoon();
      const decision = shouldStartAgentRun({
        origin,
        direction: row.direction,
        accountManagerUserId: account.managerUserId,
        agentOwnerUserId: config?.ownerUserId ?? null,
        agentOn: agentRunning(config),
        stored: true,
      });
      if (decision === 'run') {
        // Only a live line reaches 'run' here (the origin rule above).
        await enqueue<AgentInboundJob>(
          JOB_AGENT_INBOUND,
          {
            managerUserId: account.managerUserId,
            peerId: row.peerId.toString(),
            anchorTgMessageId: row.tgMessageId.toString(),
            origin: 'live',
          },
          { startAfter: INBOUND_START_AFTER_S, retryLimit: 0 },
        );
      } else if (decision === 'human_reply') {
        await enqueue<AgentHumanReplyJob>(
          JOB_AGENT_HUMAN_REPLY,
          {
            managerUserId: account.managerUserId,
            peerId: row.peerId.toString(),
            tgMessageId: row.tgMessageId.toString(),
          },
          { retryLimit: 0 },
        );
      }
    } catch (err) {
      console.error('AI navbatiga qo‘yilmadi:', err instanceof Error ? err.message : err);
    }
  };

  /**
   * A stranger's line on the AGENT OWNER's account (his Q18 ⭐, review fit-7):
   * whether they are in his contacts, and for a hidden number the pending rule
   * the «📵» card acts on (`noteStranger`). Inbound only — a stranger's
   * message, not his — and only while the agent speaks from here; every other
   * account, and this one with the agent off, does exactly what it did. Never
   * a word of the message. A failure is a missed card, never a lost message.
   */
  const strangerSeen = async (peer: ListenPeer, out: boolean, verdict: 'ask' | 'no_phone') => {
    if (out || !peer.user) return;
    try {
      if (!(await agentHere())) return;
      await noteStranger({
        managerUserId: account.managerUserId,
        peerId: peer.id,
        title: peerTitle(peer),
        verdict,
        user: peer.user,
      });
    } catch (err) {
      console.error('notanish belgisi yozilmadi:', err instanceof Error ? err.message : err);
    }
  };

  const handleMessage = async (
    peer: ListenPeer,
    msg: RawMessage & { id: number; out?: boolean; message?: string | null },
    origin: ListenOrigin,
  ): Promise<string | null> => {
    try {
      const now = Date.now();
      if (bookIsStale(book, now)) {
        book = newBook(await clientBook(), now);
        rules = await rulesFor(account.managerUserId);
        // Re-read on the same tick as the book: the manager may have flipped
        // «ish raqami» on the screen while the listener was running, and a
        // switch that needs a restart is a switch nobody trusts.
        workAccount = await isWorkAccount(account.managerUserId);
      }

      let verdict = decideIncoming(peer, msg, book.clients, rules, workAccount);
      // A number we do not know MIGHT be a client added since the book was
      // read. Ask once, rate-limited, before concluding they are a stranger.
      // Keyed on the verdicts a stranger actually gets since round 79 — the
      // old `not_a_client` key had not been reachable since then.
      if (suspectsStaleBook(verdict) && shouldRefreshOnMiss(book, now)) {
        book = { ...newBook(await clientBook(), now), missRefreshedAt: now };
        rules = await rulesFor(account.managerUserId);
        verdict = decideIncoming(peer, msg, book.clients, rules, workAccount);
      }
      // A website visitor's tag may turn this stranger into a lead's chat.
      if (await applySiteTag(peer, msg, verdict)) {
        verdict = decideIncoming(peer, msg, book.clients, rules, workAccount);
      }

      if (!verdict.store) {
        if ('ask' in verdict) {
          // A stranger on a PERSONAL number. The tray gets who to ask about
          // and nothing else — not one word of what was said (round 79).
          await recordCandidates(account.managerUserId, [
            { peerId: verdict.peerId, title: verdict.title, phone: verdict.phone },
          ]);
          asked += 1;
          await strangerSeen(peer, msg.out === true, 'ask');
          return null;
        }
        // A hidden number on the agent owner's account gets the «📵» card's
        // rule; everywhere else it stays what it was —
        if (verdict.reason === 'no_phone') await strangerSeen(peer, msg.out === true, 'no_phone');
        // counted, never named. This is the manager's private life.
        passed += 1;
        return null;
      }

      // A stranger on a WORK number opens a lead, and the conversation is
      // kept on it until the lead becomes a client (0064).
      let ownerClientId: string | null = null;
      let ownerLeadId: string | null = null;
      let label = '';
      if ('openLead' in verdict) {
        ownerLeadId = await leadForChat(account.managerUserId, verdict.peer, {
          actorId: account.managerUserId,
          ip: null,
          userAgent: null,
        });
        label = 'LID';
      } else if ('leadId' in verdict) {
        // Somebody answered «Lid ochish» on the tray (0065). The lead is
        // already there — nothing to mint, nothing to name.
        ownerLeadId = verdict.leadId;
        label = 'LID';
      } else {
        ownerClientId = verdict.clientId;
        label = verdict.clientCode;
      }
      const written = await storeIncoming({
        clientId: ownerClientId,
        leadId: ownerLeadId,
        managerUserId: account.managerUserId,
        row: verdict.row,
      });
      if (written) {
        stored += 1;
        console.log(`  ${label} ← ${verdict.row.direction}`);
        // The photograph or the voice note itself — only for a NEW row, so a
        // reconnect replay never re-downloads. An outgoing echo whose photo
        // WE uploaded is skipped too: the bytes are already in storage,
        // claimed onto the row by the sender. A failure here is a missing
        // picture, never a downed bridge.
        const ownUpload =
          verdict.row.direction === 'out' &&
          verdict.row.hasMedia &&
          (await wasSentWithPhoto(account.managerUserId, verdict.row.peerId, verdict.row.tgMessageId));
        if (!ownUpload) {
          await saveMediaFor(written, msg, account.managerUserId).catch((err: unknown) => {
            console.error('media olinmadi:', err instanceof Error ? err.message : err);
          });
        }
        await afterStored(written, verdict.row, msg, origin);
      }
      return written;
    } catch (err) {
      console.error('xabar ishlanmadi:', err instanceof Error ? err.message : err);
      return null;
    }
  };

  /**
   * An edit of the customer's NEWEST line is a new question in the old
   * message's place (regression-10): the draft written against its first
   * words is re-thought. An edit of an older line rewrites the record and
   * asks nothing of the reply.
   */
  const rethinkOnEdit = async (peerId: bigint, tgMessageId: bigint) => {
    try {
      if (!(await agentHere())) return;
      if (!(await isNewestInbound(account.managerUserId, peerId, tgMessageId))) return;
      await enqueue<AgentInboundJob>(
        JOB_AGENT_INBOUND,
        {
          managerUserId: account.managerUserId,
          peerId: peerId.toString(),
          anchorTgMessageId: tgMessageId.toString(),
          origin: 'edit',
        },
        { startAfter: INBOUND_START_AFTER_S, retryLimit: 0 },
      );
    } catch (err) {
      console.error('tahrir AI ga yetmadi:', err instanceof Error ? err.message : err);
    }
  };

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
      if (applied) {
        console.log('  ✎ tahrir qabul qilindi');
        await rethinkOnEdit(peer.id, BigInt(msg.id));
      }
    } catch (err) {
      console.error('tahrir ishlanmadi:', err instanceof Error ? err.message : err);
    }
  }, new EditedMessage({}));

  // Deletes (review leak-8). A message deleted for both sides used to stay in
  // tg_messages for good, and the agent's context would have presented it as
  // said — his own mis-sent lines included. Telegram names only the message
  // ids; a private chat's ids are unique inside this account's box, so the
  // stored rows are found by (manager, id). Deletes made while this listener
  // was down are not learned (stated in the spec).
  client.addEventHandler(async (update: unknown) => {
    try {
      const gone = (update as { messages?: unknown }).messages;
      if (!Array.isArray(gone) || gone.length === 0) return;
      if (!(await tablesReady())) return;
      const ids = gone.filter((id): id is number => typeof id === 'number').map((id) => BigInt(id));
      const marked = await markDeleted(account.managerUserId, ids);
      if (marked > 0) console.log(`  🗑 ${marked} ta xabar o‘chirilgan`);
    } catch (err) {
      console.error("o'chirish belgisi yozilmadi:", err instanceof Error ? err.message : err);
    }
  }, new Raw({ types: [Api.UpdateDeleteMessages] }));

  // «The customer is typing» (fit-9) — only on the account the agent speaks
  // from, and only for a chat already kept (`stampPeerTyping`). Telegram
  // repeats the update every few seconds while somebody types, so one write
  // per chat per few seconds says everything the worker needs.
  const typingStampedAt = new Map<string, number>();
  client.addEventHandler(async (update: unknown) => {
    try {
      const typing = update as { userId?: { toString(): string }; action?: { className?: string } };
      if (!typing.userId || typing.action?.className === 'SendMessageCancelAction') return;
      const key = typing.userId.toString();
      const last = typingStampedAt.get(key) ?? 0;
      if (Date.now() - last < TYPING_STAMP_MS) return;
      if (!(await agentHere())) return;
      typingStampedAt.set(key, Date.now());
      await stampPeerTyping(account.managerUserId, BigInt(key));
    } catch (err) {
      console.error('yozmoqda belgisi yozilmadi:', err instanceof Error ? err.message : err);
    }
  }, new Raw({ types: [Api.UpdateUserTyping] }));

  // "The manager has read this chat" — round 88, and the reason the warning
  // can finally stop lying. Telegram ALREADY knows this: opening a dialog on
  // any device sends a read receipt, and every other device is told about it.
  // So we do not invent a second notion of "seen" out of our own screens (a
  // manager who answers on their phone would trip it, and a supervisor's
  // glance at /suhbatlar would silence somebody else's alarm) — we copy the
  // fact Telegram already has.
  //
  // A raw update, not an event: gramjs models NewMessage and EditedMessage
  // and nothing else, so this one is matched by class.
  client.addEventHandler(async (update: unknown) => {
    try {
      const read = update as { peer?: unknown; maxId?: number };
      const peerId = peerIdFromUpdate(
        read.peer as { className?: string; userId?: { toString(): string } } | undefined,
      );
      // Only a one-to-one chat can be a client's. A group's read mark says
      // nothing about a conversation this system stores.
      if (peerId === null || typeof read.maxId !== 'number') return;
      await recordChatRead({
        managerUserId: account.managerUserId,
        peerId,
        maxTgMessageId: BigInt(read.maxId),
      });
    } catch (err) {
      console.error("o'qildi belgisi yozilmadi:", err instanceof Error ? err.message : err);
    }
  }, new Raw({ types: [Api.UpdateReadHistoryInbox] }));

  // Telegram's notices about the account itself — the API terms, a
  // limitation, a popup — need not arrive as a message from 777000 at all:
  // the API delivers them as `updateServiceNotification`, which a client is
  // expected to file into the 777000 chat ITSELF (K33's follow-up). gramjs
  // turns no such update into a NewMessage, so it is matched by class like
  // the reads above, or his ⭐2 «off at once on any official notice» hears
  // only the login codes. Always a notice, never login traffic, and never
  // kept: the update IS the notice.
  // One that came while this listener was down is not learned (stated).
  client.addEventHandler(async () => {
    await telegramNoticeSeen('notice');
  }, new Raw({ types: [Api.UpdateServiceNotification] }));

  // The manager renamed their own @handle (round 113). Written at once rather
  // than at the next refresh: a released handle can be registered by a
  // stranger, and the website must not go on sending visitors to it.
  client.addEventHandler(async (update: unknown) => {
    try {
      const change = update as {
        userId?: { toString(): string };
        usernames?: { username: string; active?: boolean }[];
      };
      if (!selfId || change.userId?.toString() !== selfId) return;
      await recordAccountUsername(account.id, primaryUsername({ usernames: change.usernames ?? [] }));
      console.log('username yangilandi');
    } catch (err) {
      console.error('username yozilmadi:', err instanceof Error ? err.message : err);
    }
  }, new Raw({ types: [Api.UpdateUserName] }));

  /* ---------------------------------------------------------------- *
   * The sender — phase 4. Replies queued on the screen go out here,
   * because this is the only process holding a connection to the account.
   * ---------------------------------------------------------------- */

  const recovered = await recoverInFlight(account.managerUserId);
  if (recovered > 0) {
    console.log(`⚠ ${recovered} ta xabar yuborilayotganda uzilib qolgan — tekshiring`);
  }
  // The agent's half of the same question, with the stricter answer: an AI
  // reply that was being sent when the process died is 'unknown' and never
  // re-sent (ban-5) — its card asks him to look. A one-peer pull that was
  // half-walked is simply owed again (storing is idempotent).
  if (await tablesReady()) {
    try {
      const unknown = await recoverAgentInFlight(account.managerUserId);
      for (const id of unknown) await onAgentOutboxSettled(id).catch(() => undefined);
      if (unknown.length > 0) console.log(`⚠ ${unknown.length} ta AI javobi yuborilayotganda uzilib qolgan — tekshiring`);
      await releaseStalePulls(account.managerUserId);
    } catch (err) {
      console.error('AI navbati tiklanmadi:', err instanceof Error ? err.message : err);
    }
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
  let unsettled: {
    id: string;
    tgMessageId: bigint | null;
    /**
     * The thread's copy rides WITH the queue-row fact, or a db blip in the
     * gap between them loses it (the audit's find): markSent threw, the
     * catch returned before the echo block, and the retry re-ran markSent
     * alone — so the outbox read «sent», the «navbatda» bubble vanished, and
     * the CRM thread never got the reply the customer already has. One
     * outage, one message, gone for good — Telegram will not echo it back
     * on this connection (round 53), so nothing else can ever write it.
     */
    echo: Parameters<typeof recordSent>[0] | null;
  } | null = null;
  /**
   * The echo row for a message that HAS gone out, not yet written down.
   *
   * Round 53 made the listener write its own outgoing rows, because Telegram
   * does not echo a message sent on the same connection — so this write is the
   * only record a text reply has. Its failure was swallowed with a
   * `console.error`, which puts the system back in the state the owner
   * reported: the queue says «sent», the client has the message, and the CRM
   * thread shows nothing. Held here and retried, exactly like `unsettled`.
   */
  let unrecorded: Parameters<typeof recordSent>[0] | null = null;
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
    // And the colleagues who can still reach him (ban-10): the bot's chat
    // with a manager may live on the very account that just died, and a
    // banned account's own person is the one who may never read it.
    await announceSessionDeadToOthers(alarmAccount, reason).catch((err: unknown) => {
      console.error('ogohlantira olmadim:', err instanceof Error ? err.message : err);
    });
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

  /* ---------------------------------------------------------------- *
   * The agent's replies (spec §17.8) — after the human rows, on the
   * row's own clock, one reply in flight per account.
   * ---------------------------------------------------------------- */

  /**
   * True once this process has walked every stored chat's gap (catch-up,
   * below). Until then tg_messages may be missing the very line that makes
   * an approved reply wrong — gramjs never recovers an update gap (ban-3) —
   * so an agent row waits for it, and the stamp tells the app so.
   */
  let caughtUp = false;

  /**
   * A wait Telegram ordered on one of the AGENT's own reads or cosmetic calls
   * — GetHistory for the verify step or a pull, ReadHistory, SetTyping
   * (review S9). Those no longer move the guard's `flood_until`, which would
   * stop every person's reply for a wait on a method they never call; the
   * agent's own calls wait it out here instead: rows by the verdict's flood
   * clock, pulls and badges by `agentHeld()`. In memory, like the human
   * pump's clock: a restart forgets it, and Telegram says it again.
   */
  let agentHoldUntil: Date | null = null;
  const agentHeld = () => agentHoldUntil !== null && agentHoldUntil.getTime() > Date.now();
  const laterOf = (a: Date | null, b: Date | null) => (!a ? b : !b ? a : a.getTime() >= b.getTime() ? a : b);

  const stepStore = agentStepStore({
    accountId: account.id,
    caughtUp: () => caughtUp,
    memoryFloodUntil: () => laterOf(floodWaitUntil, agentHoldUntil),
  });

  /**
   * One send at a time on this account, and no two closer than
   * `MIN_SEND_GAP_MS` — whoever sends (review S10). The gap used to be kept by
   * the NOTIFY knock alone and measured from when a pump STARTED, so the
   * three-second interval could put a person's reply and the agent's ~100 ms
   * apart. Every Telegram send — the human queue's message or file, the
   * agent's reply — goes through here, and the gap runs from the last SEND.
   * A chain, not a flag: the agent's tick runs beside the human pump (S12),
   * and the two must queue for the slot, never race for it.
   *
   * And a send that queued here has waited: what it checked before it came —
   * the flood clock, the pause, the chat's live head — can have changed in
   * the meantime, and the send ahead of it is exactly what changes it. So the
   * turn asks again (`slotHold`) from what the sends ahead of it wrote down
   * INSIDE the slot, before they let the next one through: a send-method wait
   * (`floodWaitUntil`, a person's and the agent's alike), a restriction
   * (`slotRestrictedAt`, until the guard row is seen to hold it), and when
   * each chat was last sent to (`peerSentAt`) — so the agent's reply never
   * follows a person's CRM reply into the chat its head check saw clean. A
   * refused turn makes no call and throws `SlotHeld`.
   */
  const MIN_SEND_GAP_MS = 1200;
  let lastSendAt = 0;
  let sendTail: Promise<unknown> = Promise.resolve();
  let slotRestrictedAt: Date | null = null;
  const peerSentAt = new Map<string, number>();
  class SlotHeld extends Error {
    constructor(
      readonly reason: WaitReason,
      readonly until: Date,
    ) {
      super(`slot_held: ${reason}`);
    }
  }
  /** What a send's failure means for the ACCOUNT, written before the slot lets the next send go. */
  const noteSlotFlood = (seconds: number) => {
    floodWaitUntil = laterOf(floodWaitUntil, computeFloodWait(seconds));
  };
  /**
   * A restriction a send met, held by the slot until the guard row is seen to
   * hold the pause — and only where there IS a guard row (final review K22).
   * One migration behind, nothing writes the pause and nothing clears this
   * note (`guard` is null below), the restricted reply fails the old way, and
   * a two-minute hold would only bounce every later person's reply off the
   * slot: today's path is to try them, and on an old schema the listener runs
   * today's paths (regression-3 b).
   */
  const noteSlotRestricted = () => {
    if (tablesKnownReady) slotRestrictedAt = new Date();
  };
  const noteSlotFailure = (err: unknown) => {
    const kind = tgErrorKind(err);
    if (kind.kind === 'flood') noteSlotFlood(kind.seconds);
    else if (kind.kind === 'restricted') noteSlotRestricted();
  };
  const sendSlot = <T>(turn: { peerId: bigint | null; headAt: Date | null }, work: () => Promise<T>): Promise<T> => {
    const run = async () => {
      const wait = lastSendAt + MIN_SEND_GAP_MS - Date.now();
      if (wait > 0) await new Promise((resolve) => setTimeout(resolve, wait));
      const peerAt = turn.peerId === null ? undefined : peerSentAt.get(turn.peerId.toString());
      const hold = slotHold(
        {
          now: new Date(),
          floodUntil: floodWaitUntil,
          restrictedAt: slotRestrictedAt,
          peerSentAt: peerAt === undefined ? null : new Date(peerAt),
        },
        turn.headAt,
      );
      // Refused before the call: no SendMessage, so nothing for the gap to count either.
      if (hold) throw new SlotHeld(hold.reason, hold.until);
      try {
        return await work();
      } catch (err) {
        noteSlotFailure(err);
        throw err;
      } finally {
        lastSendAt = Date.now();
        if (turn.peerId !== null) {
          // A chat's stamp matters only against a head read seconds before; older ones are dropped here.
          for (const [peer, at] of peerSentAt) if (lastSendAt - at > 10 * 60_000) peerSentAt.delete(peer);
          peerSentAt.set(turn.peerId.toString(), lastSendAt);
        }
      }
    };
    const next = sendTail.then(run, run);
    sendTail = next.catch(() => undefined);
    return next;
  };

  const agentTg = agentTelegramOver(client, { Api, helpers });

  /**
   * The agent's send step's turn of the slot: its claim and its SendMessage
   * run inside it (`runAgentStep`'s `sendTurn`). The step classifies its own
   * errors into an outcome, so what the outcome says about the account is
   * noted here, inside the slot, the way a person's send's error is. A held
   * turn is a WAIT: the row is stepped again, and its head read anew.
   */
  const agentTurn: SendTurn = async (turn, send) => {
    try {
      return await sendSlot(turn, async () => {
        const outcome = await send();
        if (outcome.kind === 'flooded') noteSlotFlood(outcome.seconds);
        else if (outcome.kind === 'failed' && outcome.error.kind === 'restricted') noteSlotRestricted();
        return outcome;
      });
    } catch (err) {
      if (err instanceof SlotHeld) return { kind: 'wait', nextStepAt: err.until, reason: err.reason };
      throw err;
    }
  };

  /**
   * An outcome Telegram already produced and the database has not taken yet
   * — the agent's `unsettled`. Held only for a database that is not there
   * (`isDbUnreachable`); every write in `applyAgentOutcome` names the states
   * it may move from, so applying it again is safe. Above all a 'sent': the
   * message is in the customer's Telegram, and only this object knows.
   */
  let agentUnsettled: { row: AgentOutboxRow; outcome: StepOutcome; at: Date } | null = null;

  /**
   * Give a chat its unread badge back (regression-12) and record that it
   * was: the pump's own aborts call this at once, and `badgesToRestore`
   * finds the replies somebody else ended after their read («off», a forced
   * «off»). A dead session cannot mark anything — the row is only recorded.
   * Cosmetic either way: a refusal here is logged, never retried.
   */
  const restoreBadge = async (rowId: string, peerId: bigint, lastError: string | null) => {
    if (!isSessionDead(lastError ?? '')) {
      await agentTg.markUnread(peerId).catch((err: unknown) => {
        console.error("o'qilmagan belgisi qaytmadi:", err instanceof Error ? err.message : err);
      });
    }
    await badgeRestored(rowId);
  };

  /**
   * Write one outcome. `at` is the instant Telegram gave it — kept with a
   * held outcome and passed again on the replay, so the flood ledger's
   * one-row-per-wait key recognises the replay (review S7) instead of
   * counting one FLOOD_WAIT twice and switching the agent off for it.
   * `telegram: false` while the account is paused (S8), or while a wait on
   * the agent's own read holds it: the outcome is written, and a badge it
   * owes waits for `badgesToRestore` — after «Tekshirdim», whose day it
   * counts from — rather than costing a call now.
   */
  const settleAgentOutcome = async (
    row: AgentOutboxRow,
    outcome: StepOutcome,
    opts: { at: Date; telegram: boolean },
  ) => {
    // A wait on the agent's own read or cosmetic call holds the agent, never a person (S9).
    if (outcome.kind === 'flooded' && !isSendFloodMethod(outcome.method)) {
      agentHoldUntil = laterOf(agentHoldUntil, floodEnds(outcome.seconds, opts.at));
    }
    let report: OutcomeReport;
    try {
      report = await applyAgentOutcome(row, outcome, alarmAccount, opts.at);
      agentUnsettled = null;
      noteDbOk();
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      if (isDbUnreachable(message)) {
        agentUnsettled = { row, outcome, at: opts.at };
        await noteDbFailure(err);
        return;
      }
      agentUnsettled = null;
      // A row left 'sending' by this is recovered as 'unknown' on the next
      // start — never re-sent, which is the side to err on.
      console.error(`AI javobi (${row.id.slice(0, 8)}) holati yozilmadi:`, message);
      return;
    }
    if (outcome.kind === 'sent') {
      sent += 1;
      console.log(`  🤖 → ${row.id.slice(0, 8)} yuborildi`);
    } else if (report.final) {
      const why = 'reason' in outcome ? ` (${outcome.reason})` : '';
      console.log(`  🤖 ${row.id.slice(0, 8)}: ${outcome.kind}${why}`);
    }
    // The question was read on his phone and nothing went (regression-12):
    // the badge comes back, so the chat still asks for him — now, or after
    // the pause from the row `badgesToRestore` still finds.
    if (report.markUnread && opts.telegram && !agentHeld()) await restoreBadge(row.id, row.peerId, null);
    if (report.sessionDead) {
      console.error(`SESSION o‘lgan: ${report.sessionDead} — qayta ulanish kerak`);
      await announceSessionDead(report.sessionDead);
      void stop(report.sessionDead, 'signed_out');
    }
  };

  /**
   * One stranger's chat pulled in (spec §17.11), at most one per tick and
   * `PULL_GAP_MS` apart. The rules are re-read FIRST: the app wrote this
   * chat's include rule a moment ago, the in-memory map is ten minutes old,
   * and a pull decided against it would put the whole day on the tray.
   */
  let lastPullAt = 0;
  let pulling = false;
  /**
   * Off the pump's own flight: a day of a stranger's chat can carry photos
   * to download, and a read must never hold a person's reply in the queue.
   * Single-flight of its own, so pulls stay one at a time.
   */
  const startPull = () => {
    if (pulling || Date.now() - lastPullAt < PULL_GAP_MS || agentHeld()) return;
    pulling = true;
    void pullTick()
      .catch((err: unknown) => {
        console.error('suhbat tortilmadi:', err instanceof Error ? err.message : err);
      })
      .finally(() => {
        pulling = false;
      });
  };
  const pullTick = async () => {
    const pull = await claimPeerPull(account.managerUserId);
    if (!pull) return;
    lastPullAt = Date.now();
    let storedCount = 0;
    try {
      rules = await rulesFor(account.managerUserId);
      const since = new Date(Date.now() - PULL_WINDOW_MS);
      for await (const msg of client.iterMessages(helpers.returnBigInt(pull.peerId.toString()), {
        limit: PULL_MESSAGES,
      })) {
        // Newest first; the first line past the window ends the walk.
        if (msg.date * 1000 < since.getTime()) break;
        const peer = listenPeer(await msg.getChat?.());
        const written = await serialised(peer.id.toString(), () => handleMessage(peer, msg as never, 'pull'));
        if (written) storedCount += 1;
      }
      await finishPeerPull(pull.id, { storedCount, error: null });
      console.log(`  ⤓ suhbat tortildi: ${storedCount} ta xabar`);
      // ONE run, for the newest line — the live hook ran for none of them.
      const config = await readAgentConfig();
      const anchor = await newestInboundSince(account.managerUserId, pull.peerId, since);
      const decision = shouldStartAgentRun({
        origin: 'pull',
        direction: 'in',
        accountManagerUserId: account.managerUserId,
        agentOwnerUserId: config?.ownerUserId ?? null,
        agentOn: agentRunning(config),
        stored: anchor !== null,
      });
      if (anchor !== null && decision === 'run') {
        await enqueue<AgentInboundJob>(
          JOB_AGENT_INBOUND,
          {
            managerUserId: account.managerUserId,
            peerId: pull.peerId.toString(),
            anchorTgMessageId: anchor.toString(),
            origin: 'pull',
          },
          { retryLimit: 0 },
        );
      }
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      const kind = tgErrorKind(err);
      if (kind.kind === 'flood') {
        // A read's wait: the ledger has it, and the agent's calls wait it out — a person's replies do not (S9).
        const at = new Date();
        agentHoldUntil = laterOf(agentHoldUntil, floodEnds(kind.seconds, at));
        await accountFlooded(
          alarmAccount,
          { method: 'messages.GetHistory', seconds: kind.seconds, source: 'raise' },
          at,
        ).catch(() => undefined);
      }
      // Not this chat's fault — a wait Telegram ordered, a database blip, a
      // connection going down under a stop: the pull is owed again (storing
      // is idempotent). Anything else is the chat's answer, written down.
      if (kind.kind === 'flood' || kind.kind === 'db' || client.connected === false) {
        console.error('suhbat tortish keyinga qoldi:', message);
        await releaseStalePulls(account.managerUserId).catch(() => undefined);
        return;
      }
      console.error('suhbat tortilmadi:', message);
      await finishPeerPull(pull.id, { storedCount, error: message }).catch(() => undefined);
    }
  };

  /**
   * The agent's share of a tick: a held outcome first, then the one row
   * whose clock is due, and only when no row was stepped, a pull. Every
   * Telegram call a step makes is decided by `runAgentStep` from facts read
   * NOW — including the switch, the pause and the flood clock.
   *
   * `steps: false` is the tick a refused gate still runs: the due row's
   * verdict is asked on its own, and what can no longer be sent is cancelled
   * in the database — no step, so no send and no read of the chat.
   * `telegram: false` on top of it while the account is PAUSED (review S8):
   * nothing here calls Telegram, not a pull, not a badge.
   */
  type TickOpts = { pulls: boolean; telegram: boolean; steps: boolean };
  const agentTick = async (opts: TickOpts) => {
    try {
      await agentTickBody(opts);
    } catch (err) {
      // Only a database that is not there feeds the outage alarm; anything
      // else the agent's half throws is a logged line, never «baza yo'q» in
      // the manager's Saved Messages.
      const message = err instanceof Error ? err.message : String(err);
      if (isDbUnreachable(message)) await noteDbFailure(err);
      else console.error('AI navbati:', message);
    }
  };
  const agentTickBody = async (opts: TickOpts) => {
    if (!(await tablesReady())) return;
    if (agentUnsettled) {
      await settleAgentOutcome(agentUnsettled.row, agentUnsettled.outcome, {
        at: agentUnsettled.at,
        telegram: opts.telegram,
      });
      return;
    }
    // A wait on the agent's own read holds every agent call as well (S9).
    const telegram = opts.telegram && !agentHeld();
    if (telegram) {
      const [badge] = await badgesToRestore(account.managerUserId, new Date());
      if (badge) {
        await restoreBadge(badge.id, badge.peerId, badge.lastError);
        return;
      }
    }
    const row = await dueAgentRow(account.managerUserId, new Date());
    if (row) {
      if (!opts.steps || !opts.telegram) {
        const now = new Date();
        const refused = verdictOutcome(row, agentSendVerdict(row, await stepStore.facts(row, now)));
        if (refused) await settleAgentOutcome(row, refused, { at: now, telegram });
        return;
      }
      const outcome = await runAgentStep(row, {
        tg: agentTg,
        store: stepStore,
        classify: tgErrorKind,
        isNudge,
        sendTurn: agentTurn,
      });
      await settleAgentOutcome(row, outcome, { at: new Date(), telegram });
      return;
    }
    if (opts.pulls && telegram) startPull();
  };

  /**
   * The agent's tick runs BESIDE the human pump, never inside its flight
   * (review S12): gramjs sleeps through a wait of up to a minute inside an
   * invoke (`floodSleepThreshold`, ban-2's deviation), and an agent
   * GetHistory or SetTyping sleeping there held a person's freshly queued
   * reply for the whole of it. Single-flight of its own — one agent step at a
   * time per account — and the two meet only at `sendSlot`, which keeps the
   * sends one at a time and apart.
   */
  let agentTicking = false;
  const startAgentTick = (opts: TickOpts) => {
    if (agentTicking) return;
    agentTicking = true;
    void agentTick(opts).finally(() => {
      agentTicking = false;
    });
  };

  /** A CRM reply on the agent's account retires the chat's live draft — the worker decides how. */
  const crmReplied = async (peerId: bigint, tgMessageId: bigint) => {
    try {
      if (!(await agentHere())) return;
      await enqueue<AgentHumanReplyJob>(
        JOB_AGENT_HUMAN_REPLY,
        { managerUserId: account.managerUserId, peerId: peerId.toString(), tgMessageId: tgMessageId.toString() },
        { retryLimit: 0 },
      );
    } catch (err) {
      console.error('AI navbatiga qo‘yilmadi:', err instanceof Error ? err.message : err);
    }
  };

  /** «A current listener runs here» for the app's ✅ (regression-3) — throttled, and at once when catch-up ends. */
  let lastStampAt = 0;
  let stampedCaughtUp: boolean | null = null;
  const stampTick = async () => {
    if (stampedCaughtUp === caughtUp && Date.now() - lastStampAt < PUMP_STAMP_MS) return;
    try {
      await stampAgentPump(account.id, caughtUp);
      lastStampAt = Date.now();
      stampedCaughtUp = caughtUp;
    } catch (err) {
      console.error('pump belgisi yozilmadi:', err instanceof Error ? err.message : err);
    }
  };

  const pump = async () => {
    // A message that already left has to be written down before anything else
    // goes out, or the queue reorders itself around a failure.
    if (unsettled) {
      try {
        await markSent(unsettled.id, unsettled.tgMessageId);
        console.log(`  → ${unsettled.id.slice(0, 8)} nihoyat yozildi`);
        const echo = unsettled.echo;
        unsettled = null;
        noteDbOk();
        // The echo travels to its own retry slot rather than being dropped —
        // settling the queue row is half the bookkeeping, not all of it.
        if (echo) {
          try {
            await recordSent(echo);
          } catch (err) {
            unrecorded = echo;
            await noteDbFailure(err);
          }
        }
      } catch (err) {
        await noteDbFailure(err);
      }
      return;
    }
    // Same rule for the thread's own copy: the message exists in the world,
    // and until this row lands the CRM is missing a reply that was sent.
    if (unrecorded) {
      try {
        await recordSent(unrecorded);
        unrecorded = null;
        noteDbOk();
      } catch (err) {
        await noteDbFailure(err);
      }
      return;
    }

    const ready = await tablesReady();
    if (ready) await stampTick();

    // The gate before EVERY claim, a person's reply included (review ban-1):
    // the company switch, the account's pause, and the wait Telegram ordered
    // — the pause and the wait read from the guard row each tick, so a
    // restart cannot forget them. Cheap enough to ask every tick, and the
    // switch has to be able to stop sending WITHOUT anybody restarting a
    // process on a server. On a database without 0138 there is no guard row
    // and this is exactly the old two checks.
    const guard = ready ? await readGuard(account.id) : null;
    // The guard row holds the pause now: the slot's own note of the restriction has done its work.
    if (guard?.pausedAt) slotRestrictedAt = null;
    const gate = pumpGate({
      sendingEnabled: (await getSetting('tg_sending_enabled')) === true,
      pausedAt: guard?.pausedAt ?? null,
      floodUntil:
        guard?.floodUntil && (!floodWaitUntil || guard.floodUntil.getTime() > floodWaitUntil.getTime())
          ? guard.floodUntil
          : floodWaitUntil,
      now: new Date(),
    });
    if (!gate.ok) {
      // A switch or a pause makes an approved AI reply WRONG to send, not
      // late: the agent's own verdict cancels it, and no step is taken. While
      // the account is PAUSED nothing on that tick calls Telegram — not a
      // pull, not a badge (S8). The switch alone stops sending and nothing
      // else: a pull and a badge are reads, and «Yangi lid» on a stranger's
      // card still pulls the chat with sending off. A flood wait makes it
      // late, and everything waits.
      if (gate.reason !== 'flood_wait') {
        const paused = guard?.pausedAt != null;
        startAgentTick({ pulls: !paused, telegram: !paused, steps: false });
      }
      return;
    }
    // A turn the slot would refuse is never claimed (final review K22): a
    // restriction the send ahead of this one met, which the guard row does
    // not hold yet. Claimed anyway, the slot throws `SlotHeld`, and every tick
    // and every knock of the two-minute hold cost the reply one of its
    // attempts. The same question the slot asks at the turn, from the same
    // memory, before the claim — a wait that lands while this tick is on its
    // way is still caught there, and that claim is given back.
    if (
      slotHold({ now: new Date(), floodUntil: floodWaitUntil, restrictedAt: slotRestrictedAt, peerSentAt: null }, null)
    ) {
      return;
    }

    const job = await claimNext(account.managerUserId);
    if (!job) {
      // People first: the machine's reply takes a tick only when no person's
      // reply is waiting for it.
      startAgentTick({ pulls: true, telegram: true, steps: true });
      return;
    }
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
        // and those must not sit in the queue pretending they will go. «Not
        // yet» gives the claim back WITH its attempt (K22's follow-up): the
        // limit is the account's minute or day, nothing was tried, and a
        // reply that bounced twice here used to fail for good on its first
        // real network blip (`markAttemptFailed` against MAX_ATTEMPTS).
        if (verdict.reason === 'never_wrote_first') {
          await markAttemptFailed(job.id, 'never_wrote_first', true, MAX_ATTEMPTS);
        } else {
          await giveClaimBack(job.id);
        }
        return;
      }

      // Through the library's own big-integer type: a JS `bigint` is not an
      // `EntityLike`, and `Number()` on a Telegram id is a silent wrong
      // recipient. The id resolves out of the entity cache this connection has
      // already filled from the conversation itself.
      const target = helpers.returnBigInt(job.peerId.toString());
      let result: { id?: number; date?: number } | undefined;
      // Telegram wants the quoted message's own id, which is exactly what the
      // queue row carries (0072). A reply to a message the client has since
      // deleted is sent as an ordinary message rather than refused — that is
      // Telegram's own behaviour and the reply still has to reach them.
      const replyTo = job.replyToTgMessageId ? Number(job.replyToTgMessageId) : undefined;
      if (job.attachmentId) {
        const upload = await loadOutboxFile(job.attachmentId);
        if (!upload) {
          // The bytes are gone (or the row is); no retry can conjure them.
          await markAttemptFailed(job.id, 'photo_missing', true, MAX_ATTEMPTS);
          return;
        }
        const { CustomFile } = await import('telegram/client/uploads');
        result = (await sendSlot({ peerId: job.peerId, headAt: null }, () =>
          client.sendFile(target, {
            file: new CustomFile(upload.fileName, upload.bytes.length, '', upload.bytes),
            caption: job.body || undefined,
            // A spreadsheet must arrive AS a file. Without this gramjs offers
            // an image-shaped document to Telegram, which re-encodes anything
            // it decides is a picture and drops the filename — so a PDF the
            // client needs to open becomes an unnamed blob.
            forceDocument: upload.contentType.startsWith('image/') ? undefined : true,
            replyTo,
          }),
        )) as { id?: number; date?: number };
      } else {
        result = await sendSlot({ peerId: job.peerId, headAt: null }, () =>
          client.sendMessage(target, { message: job.body, replyTo }),
        );
      }
      // From here the message EXISTS in somebody's Telegram. Every failure
      // below is a bookkeeping failure and is treated as one.
      const tgMessageId = result?.id ? BigInt(result.id) : null;
      // The echo is BUILT before the first database write, because it has to
      // survive that write failing (round 53: Telegram does not deliver a
      // NewMessage back for a message sent on this same connection, so this
      // object is the only record a text reply has).
      const echo = result?.id
        ? {
            clientId: job.clientId,
            managerUserId: account.managerUserId,
            peerId: job.peerId,
            tgMessageId: BigInt(result.id),
            body: job.body,
            attachmentId: job.attachmentId,
            replyToTgMessageId: job.replyToTgMessageId,
            sentAt: new Date((result.date ?? Math.floor(Date.now() / 1000)) * 1000),
          }
        : null;
      try {
        await markSent(job.id, tgMessageId);
        noteDbOk();
      } catch (err) {
        unsettled = { id: job.id, tgMessageId, echo };
        await noteDbFailure(err);
        return;
      }
      if (echo) {
        await recordSent(echo).catch(async (err: unknown) => {
          // Retried on the next tick rather than lost: this row IS the thread's
          // copy of a message the client already has.
          unrecorded = echo;
          await noteDbFailure(err);
        });
      }
      sent += 1;
      console.log(`  → ${job.clientId.slice(0, 8)} yuborildi`);
      // A person answered from the CRM (fit-3) — the same «he replied
      // himself» the live hook raises for his phone, which this echo never
      // passes through. Off the send path entirely: the message has left,
      // and nothing here may be mistaken for a failed send below.
      if (echo) void crmReplied(echo.peerId, echo.tgMessageId);
    } catch (err) {
      // The slot refused the turn — a wait or a restriction the send ahead of
      // this one met. Nothing was called: the reply goes back to the queue
      // with its claim GIVEN BACK (final review K4) — `claimNext` counted an
      // attempt, and the account's trouble must not spend the reply's retries
      // — and the gate says why on the next tick.
      if (err instanceof SlotHeld) {
        console.log(`  ⏸ ${job.id.slice(0, 8)}: navbatga qaytdi (${err.reason})`);
        await giveClaimBack(job.id).catch(() => {});
        return;
      }
      const message = err instanceof Error ? err.message : String(err);
      // Telegram's own instruction, and obeying it is not optional: carrying
      // on through a FLOOD_WAIT is the fastest way to lose the account.
      const seconds = (err as { seconds?: number })?.seconds;
      // A database that is not there is not a send that failed: the message
      // never left, so the row must go back in the queue — its claim given
      // back, nothing was tried — rather than be marked failed by a write
      // that would fail too.
      if (isDbUnreachable(message)) {
        await noteDbFailure(err);
        await giveClaimBack(job.id).catch(() => {});
        return;
      }
      // Telegram ended the SESSION. Nothing this account sends will work
      // again until somebody logs in, so retrying is not perseverance, it is
      // a dead loop knocking every three seconds — which is what the owner's
      // logs showed, eight «qayta urinaman» in a row against a revoked
      // session while the screen said the bridge was live.
      if (isSessionDead(message)) {
        console.error(`SESSION o‘lgan: ${message} — qayta ulanish kerak`);
        // The reply itself is fine and goes out when he reconnects, with every
        // retry it had; failing it would throw away an answer a client is
        // still waiting for.
        await giveClaimBack(job.id).catch(() => {});
        await announceSessionDead(message);
        void stop(message, 'signed_out');
        return;
      }
      // What the error means for the ACCOUNT (review ban-1), read by the one
      // classifier the agent's pump uses too.
      const kind = tgErrorKind(err);
      // PEER_FLOOD, USER_RESTRICTED, FROZEN_*: Telegram says the ACCOUNT is
      // already limited, and failing this one row while the next is tried
      // three seconds later is exactly the knocking that makes it worse. The
      // pause is committed FIRST — the gate above reads it before the next
      // claim, human rows included — and the row goes back to the queue with
      // its claim given back (final review K4: `claimNext` had counted it):
      // the reply is fine, the account is not, and «Tekshirdim» must find the
      // reply with every retry it had. On a database without 0138 there is
      // nowhere to keep a pause, so the old answer (the row fails,
      // permanently) stands below.
      if (kind.kind === 'restricted' && (await tablesReady())) {
        console.error(`AKKAUNT CHEKLANDI (${kind.code}) — yuborish to‘xtatildi, «Tekshirdim» kutilmoqda`);
        await accountRestricted(alarmAccount, { pause: kind.pause, code: kind.code }).catch(async (e: unknown) => {
          await noteDbFailure(e);
        });
        await giveClaimBack(job.id).catch(() => {});
        return;
      }
      if (typeof seconds === 'number') {
        floodWaitUntil = computeFloodWait(seconds);
        console.error(`FLOOD_WAIT ${seconds}s — ${floodWaitUntil.toISOString()} gacha to‘xtadim`);
        // Telegram refused the CALL with a wait — about the account, never this reply: the claim goes back whole.
        await giveClaimBack(job.id);
        // The wait itself, persisted UNCAPPED on the guard row (ban-2): the
        // in-memory clock above stays as the fast path, capped as it always
        // was, and is all a database without 0138 gets. It only ever reaches
        // here past gramjs's own 60-second sleep.
        await accountFlooded(alarmAccount, {
          method: job.attachmentId ? 'messages.SendMedia' : 'messages.SendMessage',
          seconds,
          source: 'raise',
        }).catch((e: unknown) => {
          console.error('flood yozilmadi:', e instanceof Error ? e.message : e);
        });
        return;
      }
      const permanent = isPermanentSendError(message);
      await markAttemptFailed(job.id, message, permanent, MAX_ATTEMPTS);
      console.error(`yuborilmadi (${permanent ? 'qaytarilmaydi' : 'qayta urinaman'}):`, message);
    }
  };

  // One message per tick, deliberately. Not a batch loop: a queue that drains
  // as fast as it can is exactly the burst that gets an account flagged.
  //
  // The TICK is a floor, not the pacing. A manager typing a reply on the
  // screen watched it sit at «navbatda» for a beat that was pure polling —
  // nothing was being rate-limited, the sender simply had not looked yet. So
  // `queueReply` now pokes a postgres channel and the poke pumps immediately,
  // while `sendSlot` keeps the thing that actually matters: no two messages
  // leave closer together than `MIN_SEND_GAP_MS`, however loud the knocking —
  // on the knock, on this interval, and between a person and the agent.
  let lastPumpAt = 0;
  let pumping = false;
  const runPump = async () => {
    if (pumping) return;
    pumping = true;
    lastPumpAt = Date.now();
    try {
      await pump();
    } catch (err) {
      await noteDbFailure(err);
    } finally {
      pumping = false;
    }
  };

  const sender = setInterval(() => {
    void runPump();
  }, 3000);

  // The knock. Fenced end to end: a database that will not take a LISTEN
  // leaves the three-second tick exactly as it was, which is the behaviour
  // this listener has always had.
  let unlistenOutbox: (() => Promise<unknown>) | null = null;
  try {
    const sub = await pgClient.listen(OUTBOX_CHANNEL, () => {
      if (Date.now() - lastPumpAt < MIN_SEND_GAP_MS) return; // the tick has it
      void runPump();
    });
    unlistenOutbox = sub.unlisten;
    console.log(`navbat kanali tinglanmoqda: ${OUTBOX_CHANNEL}`);
  } catch (err) {
    console.error('navbat kanalini tinglab bo\'lmadi, 3 soniyalik tsikl ishlaydi:', err);
  }

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
          // The same decision the live path makes, including the work-account
          // widening — a message that arrived during an outage is the same
          // message it would have been a minute earlier.
          const verdict = decideIncoming(peer, msg, book.clients, rules, workAccount);
          if (!verdict.store) continue;
          // The same three owners the live path resolves, in the same order.
          let catchUpClientId: string | null = null;
          let catchUpLeadId: string | null = null;
          if ('openLead' in verdict) {
            catchUpLeadId = await leadForChat(account.managerUserId, verdict.peer, {
              actorId: account.managerUserId,
              ip: null,
              userAgent: null,
            });
          } else if ('leadId' in verdict) {
            catchUpLeadId = verdict.leadId;
          } else {
            catchUpClientId = verdict.clientId;
          }
          const written = await storeIncoming({
            clientId: catchUpClientId,
            leadId: catchUpLeadId,
            managerUserId: account.managerUserId,
            row: verdict.row,
          });
          if (written) {
            recovered += 1;
            await saveMediaFor(written, msg, account.managerUserId).catch(() => {});
            // The agent's sweep drafts a deploy-gap line from STORED rows, so
            // a customer's auto-reply caught up here must carry its flag too
            // (ban-4). Catch-up starts no run of its own.
            if (wasAutoSent(msg)) await markAutoSent(written).catch(() => {});
          }
        }
      } catch (err) {
        // One unreachable chat must not stop the rest catching up.
        console.error('catch-up:', err instanceof Error ? err.message : err);
      }
    }
    if (recovered > 0) console.log(`uzilish davridagi ${recovered} ta xabar olindi`);
  };
  /**
   * The walk, retried (review S11). A failed catch-up used to leave
   * `caughtUp` false for the life of the process: every approved AI reply
   * looped on `not_caught_up` until its six-hour expiry, while the app —
   * which read only the pump stamp — went on accepting ✅. Now a failure is
   * tried again a minute later, a bounded number of times, and the app reads
   * the catch-up stamp too (`listenerIsCurrent`), so a listener that never
   * walked its gap is refused at the ✅ in words.
   */
  const CATCHUP_RETRY_MS = 60_000;
  const CATCHUP_ATTEMPTS = 5;
  let catchUpAttempts = 0;
  let catchUpRetry: ReturnType<typeof setTimeout> | null = null;
  const runCatchUp = async (): Promise<void> => {
    catchUpAttempts += 1;
    try {
      await catchUp();
      // The gap is walked: from here tg_messages is as complete as this
      // connection can make it, and an approved AI reply may take its steps.
      caughtUp = true;
    } catch (err) {
      // Never fatal: a bridge that refuses to start because it could not
      // backfill is worse than one that starts and is a little behind. The
      // agent's replies, though, wait — a gap nobody walked is exactly what
      // its verdict must not decide over (ban-3).
      console.error('catch-up umuman ishlamadi:', err instanceof Error ? err.message : err);
      if (catchUpAttempts < CATCHUP_ATTEMPTS) {
        catchUpRetry = setTimeout(() => {
          catchUpRetry = null;
          void runCatchUp();
        }, CATCHUP_RETRY_MS);
      } else {
        console.error(`catch-up ${CATCHUP_ATTEMPTS} marta o‘tmadi — AI javoblari qayta ishga tushirilguncha kutadi`);
      }
    }
  };
  await runCatchUp();

  /**
   * Website visitors who wrote while this listener was down (round 113).
   *
   * Catch-up above walks only chats that already have stored rows, and a
   * website visitor is by definition a chat with none — so a tag that arrived
   * during a deploy would otherwise never be seen, and the visitor would sit
   * on the tray as a stranger. Bounded by our own record, not by the dialog
   * list: only the tags this account was offered and that never reached a
   * card are looked for, one global search each, and every hit goes through
   * the SAME step a live message takes.
   */
  const siteTagSweep = async () => {
    const offers = await openOffersFor(account.managerUserId);
    for (const offer of offers) {
      try {
        for await (const msg of client.iterMessages(undefined, { search: offer.tag, limit: 5 })) {
          if (msg.out) continue;
          const peer = listenPeer(await msg.getChat?.());
          if (!peer.isPrivate) continue;
          await serialised(peer.id.toString(), () => handleMessage(peer, msg as never, 'site_sweep'));
        }
      } catch (err) {
        console.error('sayt qidiruvi:', err instanceof Error ? err.message : err);
      }
    }
  };
  await siteTagSweep().catch((err) => {
    console.error('sayt belgilari tekshirilmadi:', err instanceof Error ? err.message : err);
  });

  /* ---------------------------------------------------------------- *
   * The connect-time week. Owed once per connect, stamped when done.
   * ---------------------------------------------------------------- */

  /**
   * The last BACKFILL_DAYS of this account's CLIENT conversations, pulled
   * the first time the listener starts after a connect (owner: «1 haftalik
   * tarixi bilan tushsin yangi ulanganda»).
   *
   * Same decide-and-store path as a live message, so the unique index makes
   * a re-run idempotent — which is why the stamp is written only at the END:
   * a listener killed mid-pull simply owes the walk again. The one verdict
   * history refuses is `openLead` (see `backfillOwner`): a week of strangers
   * must not become a week of leads in one silent burst.
   */
  const historyBackfill = async () => {
    if (!(await needsHistoryBackfill(account.id))) return;
    const cutoff = backfillCutoff(new Date());
    let kept = 0;
    let chats = 0;
    for await (const dialog of client.iterDialogs({})) {
      const peer: DialogPeer = peerFromChat(dialog.entity as never);
      if (!peer.isPrivate || peer.isBot || peer.isSelf) continue;
      // A chat whose NEWEST message is older than the window has nothing in
      // the window — skipped before a single message is fetched.
      if (!withinWindow(dialog.message?.date, cutoff)) continue;
      try {
        let inChat = 0;
        for await (const msg of client.iterMessages(
          helpers.returnBigInt(peer.id.toString()),
          { limit: BACKFILL_PER_CHAT },
        )) {
          // Newest first; the first message past the cutoff ends the chat.
          if (!withinWindow(msg.date, cutoff)) break;
          const step = backfillStep(
            decideIncoming(peer, msg, book.clients, rules, workAccount),
          );
          if (step.kind === 'stop') break; // the whole chat is not ours
          if (step.kind === 'skip') continue; // a client's service row
          const written = await storeIncoming({
            clientId: step.clientId,
            leadId: step.leadId,
            managerUserId: account.managerUserId,
            row: step.row,
          });
          if (written) {
            inChat += 1;
            await saveMediaFor(written, msg, account.managerUserId).catch(() => {});
            if (wasAutoSent(msg)) await markAutoSent(written).catch(() => {});
          }
        }
        if (inChat > 0) {
          kept += inChat;
          chats += 1;
        }
      } catch (err) {
        // One unreachable chat must not cost the rest of the week.
        console.error('tarix:', err instanceof Error ? err.message : err);
      }
    }
    await markHistoryBackfilled(account.id);
    console.log(`ulanish tarixi: ${chats} ta suhbatdan ${kept} ta xabar olindi (oxirgi ${BACKFILL_DAYS} kun)`);
  };
  await historyBackfill().catch((err) => {
    // Not stamped on failure, so the next start owes it again.
    console.error('ulanish tarixi olinmadi:', err instanceof Error ? err.message : err);
  });

  /* ---------------------------------------------------------------- *
   * The lookback index. Fingerprints of the numbers this account knows.
   * ---------------------------------------------------------------- */

  /**
   * Walk the account's dialogs and record each peer's number as a HASH.
   *
   * Nothing about the conversation is read and nothing readable is stored —
   * `indexPeers` keeps `sha256(pepper + last nine)` and no name, which is the
   * whole reason the owner's «bu raqam bilan gaplashilganmi» feature can
   * exist over people's personal accounts at all (#588).
   *
   * A peer whose number Telegram hides is simply not indexed: there is
   * nothing to match on, so the screen's honest answer stays «topilmadi»
   * rather than «yo'q».
   */
  const refreshIndex = async () => {
    const last = await lastIndexedAt(account.managerUserId);
    if (last && Date.now() - last.getTime() < INDEX_EVERY_MS) return;
    const seen: PeerSeen[] = [];
    for await (const dialog of client.iterDialogs({})) {
      const peer: DialogPeer = peerFromChat(dialog.entity as never);
      // Groups, channels and bots have no number worth asking about, and the
      // manager's own Saved Messages is not somebody they talked to.
      if (!peer.isPrivate || peer.isBot || peer.isSelf) continue;
      seen.push({
        peerId: peer.id,
        phone: peer.phone ?? null,
        // Telegram dates are SECONDS. Multiplying is the difference between
        // «last spoke yesterday» and «last spoke in 1970».
        lastMessageAt: dialog.message?.date ? new Date(dialog.message.date * 1000) : null,
      });
    }
    const written = await indexPeers(account.managerUserId, seen);
    console.log(`raqam indeksi: ${written} ta chat belgilandi (${seen.length} tadan)`);
  };
  await refreshIndex().catch((err) => {
    // A hint on a card is never worth a bridge. The next tick tries again.
    console.error('raqam indeksi yangilanmadi:', err instanceof Error ? err.message : err);
  });
  const indexer = setInterval(() => {
    void refreshIndex().catch((err) => {
      console.error('raqam indeksi yangilanmadi:', err instanceof Error ? err.message : err);
    });
  }, INDEX_EVERY_MS);

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

  // The handle again, on a clock — and the one probe that can tell a live
  // socket from a live SESSION (round 49): Telegram answers getMe only for an
  // authorised account.
  const usernameRefresh = setInterval(() => {
    void readOwnUsername().catch(async (err: unknown) => {
      const message = err instanceof Error ? err.message : String(err);
      if (isSessionDead(message)) {
        console.error(`SESSION o‘lgan: ${message} — qayta ulanish kerak`);
        await announceSessionDead(message);
        void stop(message, 'signed_out');
        return;
      }
      console.error('username o‘qilmadi:', message);
    });
  }, USERNAME_REFRESH_MS);

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
    clearInterval(indexer);
    clearInterval(usernameRefresh);
    if (catchUpRetry) clearTimeout(catchUpRetry);
    if (unlistenOutbox) await unlistenOutbox().catch(() => undefined);
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
      `\n${tgPhone} to‘xtadi (${why}) · yozildi: ${stored} · o‘tkazildi: ${passed}` +
        ` · so‘raladi: ${asked} · yuborildi: ${sent}`,
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
