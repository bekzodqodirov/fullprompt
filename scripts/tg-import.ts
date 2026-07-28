import 'dotenv/config';
import { createInterface } from 'node:readline/promises';
import { eq } from 'drizzle-orm';
import { db, pgClient } from '../src/modules/platform/db/client';
import { clients, tgMessages, users } from '../src/modules/platform/db/schema';
import {
  classifyDialog,
  countVerdict,
  emptySummary,
  isWorthKeeping,
  toMessageRow,
  type ClientPhones,
  type DialogPeer,
} from '../src/modules/wms/crm/telegram-import';

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
}

function parseArgs(argv: string[]): Args {
  const get = (name: string) => {
    const i = argv.indexOf(`--${name}`);
    return i >= 0 ? argv[i + 1] : undefined;
  };
  const userPhone = get('user');
  if (!userPhone) throw new Error('usage: pnpm tg-import --user +998... [--tg +998...] [--months 12]');
  return {
    userPhone,
    tgPhone: get('tg') ?? userPhone,
    months: Number(get('months') ?? 12),
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
  console.log(`client book: ${book.length} codes · manager: ${manager.fullName}`);

  // Imported here rather than at the top: `telegram` is a large, node-only
  // package and nothing else in this repo should pull it in by accident.
  const { TelegramClient } = await import('telegram');
  const { StringSession } = await import('telegram/sessions');
  const { Api } = await import('telegram');

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
    const entity = dialog.entity;
    // Read through a narrow shape rather than gramjs's own classes: the only
    // four facts that decide anything are here, and `classifyDialog` — which
    // is what the tests exercise — never sees a Telegram type at all.
    const user = entity instanceof Api.User ? entity : null;
    const peer: DialogPeer = {
      id: BigInt(entity?.id?.toString() ?? '0'),
      phone: user?.phone ?? null,
      isPrivate: Boolean(dialog.isUser) && user !== null,
      isBot: Boolean(user?.bot),
    };
    const verdict = classifyDialog(peer, book);
    countVerdict(summary, verdict);
    // A conversation that is not a client's is passed over in silence — not
    // logged by name, not counted by name, not stored.
    if (!verdict.keep) continue;

    let importedHere = 0;
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
  console.log(`guruh/bot (o‘tkazildi):  ${summary.skippedOther}`);
  console.log(`yangi xabar yozildi:     ${summary.messagesImported}`);
  console.log(`allaqachon bor edi:      ${summary.messagesAlreadyThere}`);
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
