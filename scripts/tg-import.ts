import 'dotenv/config';
import { createInterface } from 'node:readline/promises';
import { and, eq, inArray } from 'drizzle-orm';
import { db, pgClient } from '../src/modules/platform/db/client';
import { attachments, clients, tgMessages, users } from '../src/modules/platform/db/schema';
import { rulesFor } from '../src/modules/wms/crm/chat-rules';
import {
  classifyWithRules,
  countVerdict,
  mediaBackfillPlan,
  peerFromChat,
  emptySummary,
  isWorthKeeping,
  toMessageRow,
  tgPhotoPlan,
  type ClientPhones,
  type DialogPeer,
} from '../src/modules/wms/crm/telegram-import';
import { saveAttachment } from '../src/modules/platform/files/service';
import { generateThumbnails } from '../src/modules/platform/jobs/thumbnails';

/**
 * One-off: bring a manager's existing Telegram conversations into the CRM.
 *
 * Owner's decision, with the risks stated and accepted: the company talks to
 * 95 % of its clients on Telegram, from managers' personal accounts, and that
 * history is worth more to the business than it is to the phone it lives on.
 *
 * Deliberately a HAND-RUN SCRIPT and not a server feature:
 *
 *  - it needs a login code typed by the person whose account it is, so it
 *    cannot run unattended anyway;
 *  - **nothing is persisted.** The session lives in memory for the length of
 *    the run and is thrown away at the end, so the server never holds a
 *    credential to anybody's personal Telegram. Live receiving (phase 2)
 *    needs a stored session and that is a separate decision to take with its
 *    own protections;
 *  - it only ever READS. There is no code path here that sends a message, and
 *    sending is what gets accounts limited.
 *
 * Run it, once per manager:
 *
 *   docker compose run --rm migrate sh -c "pnpm tg-import --user +998901757800"
 *
 * `--user` is the manager's login phone in THIS system; `--tg` is the phone of
 * the Telegram account to read, when it differs. `--months` bounds how far
 * back to go (default 12).
 */

interface Args {
  userPhone: string;
  tgPhone: string;
  months: number;
  /** Photos per chat to (back)fill; 0 = the old text-only behaviour. */
  media: number;
}

function parseArgs(argv: string[]): Args {
  const get = (name: string) => {
    const i = argv.indexOf(`--${name}`);
    return i >= 0 ? argv[i + 1] : undefined;
  };
  const userPhone = get('user');
  if (!userPhone)
    throw new Error(
      'usage: pnpm tg-import --user +998... [--tg +998...] [--months 12] [--media 50]',
    );
  const mediaFlag = process.argv.includes('--media');
  return {
    userPhone,
    tgPhone: get('tg') ?? userPhone,
    months: Number(get('months') ?? 12),
    // `--media` alone means the default cap; `--media 100` raises it. Absent
    // means what the import always did: text only.
    media: mediaFlag ? Number(get('media')) || 50 : 0,
  };
}

const ask = async (question: string): Promise<string> => {
  const rl = createInterface({ input: process.stdin, output: process.stdout });
  try {
    return (await rl.question(question)).trim();
  } finally {
    rl.close();
  }
};

async function main() {
  const args = parseArgs(process.argv.slice(2));
  const apiId = Number(process.env.TELEGRAM_API_ID);
  const apiHash = process.env.TELEGRAM_API_HASH;
  if (!apiId || !apiHash) {
    throw new Error('TELEGRAM_API_ID / TELEGRAM_API_HASH are not set in .env');
  }

  const manager = await db.query.users.findFirst({ where: eq(users.phone, args.userPhone) });
  if (!manager) throw new Error(`no user in this system with phone ${args.userPhone}`);

  const book: ClientPhones[] = await db
    .select({ id: clients.id, clientCode: clients.clientCode, phones: clients.phones })
    .from(clients);
  // What a person decided on the «Qaysi chatlar» screen, which beats the
  // automatic match both ways. Read once: the import is a single pass and a
  // decision taken while it runs belongs to the next run.
  const rules = await rulesFor(manager.id);
  console.log(
    `client book: ${book.length} codes · rules: ${rules.size} · manager: ${manager.fullName}`,
  );

  // Imported here rather than at the top: `telegram` is a large, node-only
  // package and nothing else in this repo should pull it in by accident.
  const { TelegramClient } = await import('telegram');
  const { StringSession } = await import('telegram/sessions');

  // An EMPTY session, never saved. The account is unlocked for this process
  // and forgotten when it exits.
  const client = new TelegramClient(new StringSession(''), apiId, apiHash, {
    connectionRetries: 3,
  });

  await client.start({
    phoneNumber: async () => args.tgPhone,
    phoneCode: async () => ask('Telegram kodi (telefonga keldi): '),
    password: async () => ask('Ikki bosqichli parol (bo‘lmasa Enter): '),
    onError: (err) => console.error('telegram:', err.message),
  });
  console.log('connected — reading dialogs (nothing is sent)');

  const since = new Date();
  since.setMonth(since.getMonth() - args.months);
  const summary = emptySummary();

  for await (const dialog of client.iterDialogs({})) {
    // Reduced by the SAME function the live listener uses, so a conversation
    // cannot be judged one way when imported and another way when it arrives.
    const peer: DialogPeer = peerFromChat(dialog.entity as never);
    const verdict = classifyWithRules(peer, book, rules);
    countVerdict(summary, verdict);
    // A conversation that is not a client's is passed over in silence — not
    // logged by name, not counted by name, not stored.
    if (!verdict.keep) continue;

    let importedHere = 0;
    // The photograph carriers seen in THIS chat, kept so `--media` can pick
    // which of them still owe their picture — the message object holds the
    // download handle, so the choice must be made while it is in hand.
    const mediaSeen: {
      tgMessageId: bigint;
      sentAt: Date;
      hasMedia: boolean;
      msg: { id: number; media?: unknown; downloadMedia?: () => Promise<unknown> };
    }[] = [];
    for await (const msg of client.iterMessages(dialog.id, { limit: 5000 })) {
      const row = toMessageRow(peer.id, {
        id: msg.id,
        out: msg.out ?? false,
        message: msg.message,
        date: msg.date,
        media: msg.media,
      });
      if (row.sentAt < since) break; // iterMessages walks newest → oldest
      if (!isWorthKeeping(row)) continue;

      const written = await db
        .insert(tgMessages)
        .values({
          clientId: verdict.clientId,
          managerUserId: manager.id,
          peerId: row.peerId,
          tgMessageId: row.tgMessageId,
          direction: row.direction,
          body: row.body,
          hasMedia: row.hasMedia,
          sentAt: row.sentAt,
        })
        // Re-running the import is free — the unique index decides, not a
        // "have I done this" flag somebody forgets to set.
        .onConflictDoNothing()
        .returning({ id: tgMessages.id });
      if (written.length > 0) {
        summary.messagesImported += 1;
        importedHere += 1;
      } else {
        summary.messagesAlreadyThere += 1;
      }
      if (args.media > 0 && row.hasMedia && tgPhotoPlan(msg.media).download) {
        mediaSeen.push({
          tgMessageId: row.tgMessageId,
          sentAt: row.sentAt,
          hasMedia: row.hasMedia,
          msg: msg as never,
        });
      }
    }

    // `--media`: fetch the photographs the stored rows still owe — newest
    // first, capped per chat, replay-safe (a row that already holds its
    // photo is skipped, so re-running downloads nothing twice).
    if (args.media > 0 && mediaSeen.length > 0) {
      const stored = await db
        .select({ id: tgMessages.id, tgMessageId: tgMessages.tgMessageId })
        .from(tgMessages)
        .where(
          and(
            eq(tgMessages.managerUserId, manager.id),
            eq(tgMessages.peerId, peer.id),
            inArray(tgMessages.tgMessageId, mediaSeen.map((m) => m.tgMessageId)),
          ),
        );
      const rowIdByTg = new Map(stored.map((r) => [r.tgMessageId, r.id]));
      const withPhoto = new Set(
        stored.length === 0
          ? []
          : (
              await db
                .select({ entityId: attachments.entityId })
                .from(attachments)
                .where(
                  and(
                    eq(attachments.entityType, 'tg_message'),
                    inArray(attachments.entityId, stored.map((r) => r.id)),
                  ),
                )
            ).map((a) => a.entityId),
      );
      const plan = mediaBackfillPlan(
        mediaSeen
          .filter((m) => rowIdByTg.has(m.tgMessageId))
          .map((m) => ({
            ...m,
            hasPhoto: withPhoto.has(rowIdByTg.get(m.tgMessageId)!),
          })),
        args.media,
      );
      for (const item of plan) {
        try {
          const bytes = await item.msg.downloadMedia?.();
          if (!Buffer.isBuffer(bytes) || bytes.length === 0) continue;
          const { id } = await saveAttachment(
            {
              entityType: 'tg_message',
              entityId: rowIdByTg.get(item.tgMessageId)!,
              fileName: `photo_${item.msg.id}.jpg`,
              contentType: 'image/jpeg',
              body: bytes,
              uploadedBy: manager.id,
            },
            { thumbnails: 'skip' },
          );
          await generateThumbnails(id).catch(() => {});
          summary.photosFetched = (summary.photosFetched ?? 0) + 1;
        } catch (err) {
          console.error('  rasm olinmadi:', err instanceof Error ? err.message : err);
        }
      }
    }
    console.log(`  ${verdict.clientCode}: +${importedHere}`);
  }

  await client.disconnect();
  await client.destroy();

  console.log('\n--- natija ---');
  console.log(`suhbatlar ko‘rildi:      ${summary.dialogsSeen}`);
  console.log(`mijoz deb topildi:       ${summary.matched}`);
  console.log(`raqami ko‘rinmadi:       ${summary.skippedNoPhone}  ← kontaktga saqlansa topiladi`);
  console.log(`mijoz emas (o‘tkazildi): ${summary.skippedNotClient}`);
  console.log(`siz rad etgansiz:        ${summary.skippedExcluded}`);
  console.log(`guruh/bot (o‘tkazildi):  ${summary.skippedOther}`);
  console.log(`yangi xabar yozildi:     ${summary.messagesImported}`);
  console.log(`allaqachon bor edi:      ${summary.messagesAlreadyThere}`);
  if (args.media > 0) console.log(`rasm olindi:             ${summary.photosFetched ?? 0}`);
}

main()
  .then(async () => {
    await pgClient.end();
    process.exit(0);
  })
  .catch(async (err) => {
    console.error(err);
    await pgClient.end();
    process.exit(1);
  });
