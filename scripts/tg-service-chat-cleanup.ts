import 'dotenv/config';
import { pgClient } from '../src/modules/platform/db/client';
import {
  cleanUpServiceChat,
  serviceChatInventory,
  type ServiceChatAccount,
} from '../src/modules/wms/crm/service-chat-cleanup';

/**
 * One-off: what Telegram's own service chat (777000 — login codes, «new
 * login», limitation notices) left in the CRM before the doors refused it.
 * The rules live in `wms/crm/service-chat-cleanup.ts`, where they are tested.
 *
 *   docker compose run --rm migrate pnpm exec tsx scripts/tg-service-chat-cleanup.ts
 *       # counts per account and prints, changes nothing
 *   docker compose run --rm migrate pnpm exec tsx scripts/tg-service-chat-cleanup.ts --apply
 *       # «hech qachon» on every account's 777000, its stored messages deleted
 *
 * Through `migrate`, never `app`: the runner image has no tsx and no source.
 * Not a package.json command on purpose (#1228's lesson about what a deploy
 * has to fetch). COUNTS ONLY are printed — a body may carry a login code, and
 * this output is read aloud and pasted into chats.
 *
 * Its audit rows carry no actor: this is a server step run once, not anybody's
 * press on the tray, and a name on it would claim a decision nobody made.
 */
const apply = process.argv.includes('--apply');

function decisionWord(decision: ServiceChatAccount['decision']): string {
  if (decision === null) return "qoida yo'q";
  if (decision === 'pending') return 'savol (pending)';
  if (decision === 'include') return "qo'shilgan (include)";
  return "hech qachon (exclude)";
}

async function main() {
  const accounts = await serviceChatInventory();
  console.log(`Telegram xizmat chati (777000): ${accounts.length} ta akkauntda iz bor`);
  for (const a of accounts) {
    console.log(
      `  ${a.managerName} — ${decisionWord(a.decision)} · xabar: ${a.messages} · fayl: ${a.attachments}` +
        (a.leadIds.length > 0 ? ` · lid: ${a.leadIds.length}` : ''),
    );
    for (const id of a.leadIds) console.log(`      lid ${id} (qoladi — kerak bo'lsa qo'lda «yo'qotildi» qiling)`);
  }
  const messages = accounts.reduce((n, a) => n + a.messages, 0);
  const files = accounts.reduce((n, a) => n + a.attachments, 0);
  console.log(`Jami: ${messages} ta xabar, ${files} ta fayl.`);

  if (!apply) {
    console.log("\nDRY RUN — hech narsa o'zgarmadi. O'chirish uchun --apply bilan qayta ishga tushiring.");
    return;
  }
  if (accounts.length === 0) return;

  const done = await cleanUpServiceChat({ actorId: null });
  console.log('\n--- bajarildi ---');
  for (const d of done) {
    console.log(
      `  ${d.managerName} — hech qachon qilindi (oldin: ${decisionWord(d.before)}) · ` +
        `o'chirildi: ${d.messages} ta xabar, ${d.photos} ta fayl`,
    );
  }
}

main()
  .catch((err) => {
    console.error(err);
    process.exitCode = 1;
  })
  .finally(() => pgClient.end());
