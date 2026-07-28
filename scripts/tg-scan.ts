import 'dotenv/config';
import { createInterface } from 'node:readline/promises';
import { eq } from 'drizzle-orm';
import { db, pgClient } from '../src/modules/platform/db/client';
import { clients, users } from '../src/modules/platform/db/schema';
import { recordCandidates, rulesFor, type CandidateInput } from '../src/modules/wms/crm/chat-rules';
import {
  peerFromChat,
  peerTitle,
  scanVerdict,
  type ClientPhones,
  type DialogPeer,
} from '../src/modules/wms/crm/telegram-import';

/**
 * List the chats the automatic rule does NOT take, so a person can answer for
 * them on the «Qaysi chatlar» screen.
 *
 * Owner: "qaysi chatlarni qo'shish kerak va qaysini qo'shmaslik." The phone
 * match cannot see a client Telegram will not reveal a number for — 122 of
 * them in the first real import — and cannot know that a number IN the book
 * belongs to a chat nobody wants kept. Both need a person, and a person needs
 * a list.
 *
 * Run by the manager, against their OWN account, and that is the whole of what
 * makes it acceptable: it writes down the display names of their unmatched
 * chats — which includes their family and their friends — so that they can be
 * ruled out. What it writes is a name, an id and a number if Telegram shows
 * one. It reads NO messages, and cannot: nothing here opens a conversation.
 *
 *   docker compose run --rm migrate sh -c "pnpm tg-scan --user +998901757800"
 *
 * Safe to re-run. It refreshes labels and adds new questions; it never
 * un-answers one.
 */

const ask = async (question: string): Promise<string> => {
  const rl = createInterface({ input: process.stdin, output: process.stdout });
  try {
    return (await rl.question(question)).trim();
  } finally {
    rl.close();
  }
};

async function main() {
  const argv = process.argv.slice(2);
  const get = (name: string) => {
    const i = argv.indexOf(`--${name}`);
    return i >= 0 ? argv[i + 1] : undefined;
  };
  const userPhone = get('user');
  if (!userPhone) throw new Error('usage: pnpm tg-scan --user +998... [--tg +998...]');
  const tgPhone = get('tg') ?? userPhone;

  const apiId = Number(process.env.TELEGRAM_API_ID);
  const apiHash = process.env.TELEGRAM_API_HASH;
  if (!apiId || !apiHash) throw new Error('TELEGRAM_API_ID / TELEGRAM_API_HASH are not set in .env');

  const manager = await db.query.users.findFirst({ where: eq(users.phone, userPhone) });
  if (!manager) throw new Error(`no user in this system with phone ${userPhone}`);

  const book: ClientPhones[] = await db
    .select({ id: clients.id, clientCode: clients.clientCode, phones: clients.phones })
    .from(clients);
  const rules = await rulesFor(manager.id);

  const { TelegramClient } = await import('telegram');
  const { StringSession } = await import('telegram/sessions');

  // An empty session, never saved — the same choice as the import. Scanning is
  // a one-off a person sits through; it does not need a stored login.
  const client = new TelegramClient(new StringSession(''), apiId, apiHash, {
    connectionRetries: 3,
  });
  await client.start({
    phoneNumber: async () => tgPhone,
    phoneCode: async () => ask('Telegram kodi (telefonga keldi): '),
    password: async () => ask('Ikki bosqichli parol (bo‘lmasa Enter): '),
    onError: (err) => console.error('telegram:', err.message),
  });

  const found: CandidateInput[] = [];
  let auto = 0;
  let answered = 0;
  let skipped = 0;

  for await (const dialog of client.iterDialogs({})) {
    const peer: DialogPeer = peerFromChat(dialog.entity as never);
    const verdict = scanVerdict(peer, book, rules);
    if (verdict === 'auto') auto += 1;
    else if (verdict === 'answered') answered += 1;
    else if (verdict === 'skip') skipped += 1;
    else found.push({ peerId: peer.id, title: peerTitle(peer), phone: peer.phone ?? null });
  }

  await client.disconnect();
  await client.destroy();

  const { added, refreshed } = await recordCandidates(manager.id, found);

  console.log('\n--- natija ---');
  console.log(`o‘zi tushadi (savol yo‘q):  ${auto}`);
  console.log(`allaqachon hal qilingan:    ${answered}`);
  console.log(`guruh/bot (so‘ralmaydi):    ${skipped}`);
  console.log(`yangi savol:                ${added}`);
  console.log(`nomi yangilandi:            ${refreshed}`);
  console.log('\nendi ochib javob bering:  Suhbatlar → «Qaysi chatlar»');
}

main()
  .then(async () => {
    await pgClient.end();
    process.exit(0);
  })
  .catch(async (err) => {
    console.error(err instanceof Error ? err.message : err);
    await pgClient.end();
    process.exit(1);
  });
