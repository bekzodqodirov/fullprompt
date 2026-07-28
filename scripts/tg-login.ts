import 'dotenv/config';
import { createInterface } from 'node:readline/promises';
import { eq } from 'drizzle-orm';
import { db, pgClient } from '../src/modules/platform/db/client';
import { users } from '../src/modules/platform/db/schema';
import { saveAccount } from '../src/modules/wms/crm/telegram-accounts';
import { sessionKey } from '../src/modules/wms/crm/telegram-session';

/**
 * Store a manager's Telegram login, once, so the bridge can reconnect.
 *
 * This is the step phase 1 deliberately did NOT take. The import held its
 * session in memory and threw it away, because reading history once needs
 * nothing kept. Receiving messages as they arrive needs a connection that
 * survives a restart, and that means the server holds a credential to a
 * personal Telegram account. The owner took that decision with the risks
 * stated; what this script owes him is that the credential is encrypted at
 * rest, bound to its owner, and replaceable by the person it belongs to.
 *
 * Run it once per manager, on the server:
 *
 *   docker compose run --rm migrate sh -c "pnpm tg-login --user +998901757800"
 *
 * `--user` is the manager's login phone in THIS system; `--tg` is the Telegram
 * number when it differs. Running it again for the same person replaces the
 * stored session — which is the supported way to recover from a sign-out.
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
  if (!userPhone) throw new Error('usage: pnpm tg-login --user +998... [--tg +998...]');
  const tgPhone = get('tg') ?? userPhone;

  const apiId = Number(process.env.TELEGRAM_API_ID);
  const apiHash = process.env.TELEGRAM_API_HASH;
  if (!apiId || !apiHash) {
    throw new Error('TELEGRAM_API_ID / TELEGRAM_API_HASH are not set in .env');
  }
  // Checked BEFORE the login, not after: making somebody type a Telegram code
  // and then telling them the key is missing wastes a code and their time.
  sessionKey();

  const manager = await db.query.users.findFirst({ where: eq(users.phone, userPhone) });
  if (!manager) throw new Error(`no user in this system with phone ${userPhone}`);

  const { TelegramClient } = await import('telegram');
  const { StringSession } = await import('telegram/sessions');

  const client = new TelegramClient(new StringSession(''), apiId, apiHash, {
    connectionRetries: 3,
  });
  await client.start({
    phoneNumber: async () => tgPhone,
    phoneCode: async () => ask('Telegram kodi (telefonga keldi): '),
    password: async () => ask('Ikki bosqichli parol (bo‘lmasa Enter): '),
    onError: (err) => console.error('telegram:', err.message),
  });

  const session = String(client.session.save());
  await client.disconnect();
  await client.destroy();

  await saveAccount({ managerUserId: manager.id, tgPhone, session });
  // Never the session, never a fragment of it: this output goes into a
  // terminal that ends up in a screenshot.
  console.log(`saqlandi: ${manager.fullName} · ${tgPhone}`);
  console.log('endi tinglovchini ishga tushiring:  pnpm tg-listen --tg ' + tgPhone);
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
