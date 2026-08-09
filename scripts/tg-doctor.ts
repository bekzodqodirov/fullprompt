import 'dotenv/config';
import { desc, eq, isNotNull, sql } from 'drizzle-orm';
import { db, pgClient } from '../src/modules/platform/db/client';
import { clients, tgAccounts, tgMessages, tgOutbox, users } from '../src/modules/platform/db/schema';
import { getSetting } from '../src/modules/platform/settings/service';
import { accountStatuses } from '../src/modules/wms/crm/telegram-accounts';
import { peerForClient, sendContextFor } from '../src/modules/wms/crm/outbox';
import { canQueue } from '../src/modules/wms/crm/telegram-send';
import { sessionKey } from '../src/modules/wms/crm/telegram-session';

/**
 * Why is the reply box not there?
 *
 * There are seven independent reasons a reply cannot be sent, and from a
 * screen they all look the same: no box. Rather than have the owner guess —
 * or have me guess for him, a message at a time — this prints the state of
 * every one of them in one place.
 *
 *   docker compose run --rm migrate sh -c "pnpm tg-doctor"
 *
 * Read-only. It touches Telegram not at all: everything it reports is already
 * in the database or the environment, which is also why it can be run on a
 * server whose bridge is down.
 */

const ok = (b: boolean) => (b ? '✅' : '❌');

async function main() {
  console.log('\n=== Telegram: nima ishlayapti, nima yo‘q ===\n');

  // --- 1. environment ---------------------------------------------------
  const apiId = Boolean(process.env.TELEGRAM_API_ID);
  const apiHash = Boolean(process.env.TELEGRAM_API_HASH);
  let keyOk = false;
  let keyNote = '';
  try {
    sessionKey();
    keyOk = true;
  } catch (err) {
    keyNote = err instanceof Error ? err.message : String(err);
  }
  console.log('1) .env');
  console.log(`   ${ok(apiId)} TELEGRAM_API_ID`);
  console.log(`   ${ok(apiHash)} TELEGRAM_API_HASH`);
  console.log(`   ${ok(keyOk)} TG_SESSION_KEY ${keyNote}`);

  // --- 2. the switch ----------------------------------------------------
  const sending = (await getSetting('tg_sending_enabled')) === true;
  console.log('\n2) Yuborish tugmasi');
  console.log(`   ${ok(sending)} tg_sending_enabled = ${sending}`);
  if (!sending) {
    console.log('      → Sozlamalar → «Telegram orqali yuborish» ni yoqing.');
    console.log('      → Bu O‘CHIQ bo‘lsa javob oynasi HECH QAYERDA ko‘rinmaydi.');
  }

  // --- 3. the accounts --------------------------------------------------
  const accounts = await accountStatuses();
  console.log('\n3) Ulangan akkauntlar');
  if (accounts.length === 0) {
    console.log('   ❌ birorta ham yo‘q → pnpm tg-login --user +998...');
  }
  for (const a of accounts) {
    const seen = a.lastSeenAt ? `${Math.round((Date.now() - a.lastSeenAt.getTime()) / 1000)} s oldin` : 'hech qachon';
    console.log(`   ${ok(a.state === 'live')} ${a.managerName} · ${a.tgPhone} · ${a.state} · ${seen}`);
    if (!a.keyOpens) console.log('      ⚠ TG_SESSION_KEY bu qatorni ocholmayapti — .env dagi kalit boshqa.');
    if (a.lastError) console.log(`      ⚠ ${a.lastError}`);
    if (a.state !== 'live') {
      console.log('      → tinglovchi ishlamayapti: docker start tg-listen-...');
    }
  }

  // --- 4. what is actually stored --------------------------------------
  const [counts] = await db
    .select({
      messages: sql<number>`count(*)`,
      chats: sql<number>`count(DISTINCT ${tgMessages.clientId})`,
    })
    .from(tgMessages);
  console.log('\n4) Bazadagi yozishmalar');
  console.log(`   ${ok(Number(counts?.messages ?? 0) > 0)} ${counts?.messages ?? 0} ta xabar · ${counts?.chats ?? 0} ta mijoz`);
  if (Number(counts?.messages ?? 0) === 0) {
    console.log('      → hali import qilinmagan: pnpm tg-import --user +998...');
  }

  // --- 5. the queue -----------------------------------------------------
  const queue = await db
    .select({ status: tgOutbox.status, n: sql<number>`count(*)` })
    .from(tgOutbox)
    .groupBy(tgOutbox.status);
  console.log('\n5) Yuborish navbati');
  if (queue.length === 0) console.log('   — bo‘sh');
  for (const q of queue) console.log(`   ${q.status}: ${q.n}`);

  // --- 6. the real question, on a real client --------------------------
  //
  // Everything above can look fine and the box still be absent, because the
  // answer is per CONVERSATION. So it is asked the way the screen asks it,
  // on the client who wrote most recently.
  console.log('\n6) Haqiqiy tekshiruv — oxirgi yozgan mijoz bo‘yicha');
  const [recent] = await db
    .select({
      clientId: tgMessages.clientId,
      managerUserId: tgMessages.managerUserId,
      code: clients.clientCode,
      name: clients.name,
      manager: users.fullName,
    })
    .from(tgMessages)
    .innerJoin(clients, eq(tgMessages.clientId, clients.id))
    .innerJoin(users, eq(tgMessages.managerUserId, users.id))
    // `client_id` is nullable since 0064 — a conversation may belong to an
    // open LEAD instead. This check is about the reply window on a CLIENT, so
    // it says so rather than relying on the join to imply it.
    .where(isNotNull(tgMessages.clientId))
    .orderBy(desc(tgMessages.sentAt))
    .limit(1);

  const recentClientId = recent?.clientId;
  if (!recent || !recentClientId) {
    console.log('   — tekshirish uchun yozishma yo‘q');
  } else {
    const peerId = await peerForClient(recentClientId, recent.managerUserId);
    const ctx = await sendContextFor({
      clientId: recentClientId,
      managerUserId: recent.managerUserId,
      peerId,
    });
    const verdict = canQueue('x', ctx);
    console.log(`   ${recent.code} ${recent.name} · akkaunt: ${recent.manager}`);
    console.log(`   ${ok(ctx.clientHasWrittenFirst)} mijoz sizga yozganmi`);
    console.log(`   ${ok(ctx.bridgeLive)} tinglovchi tirikmi`);
    console.log(`   ${ok(ctx.sendingEnabled)} yuborish yoqilganmi`);
    console.log(
      `   bugun yuborilgan: ${ctx.sentLastDay} · oxirgi daqiqada: ${ctx.sentLastMinute}`,
    );
    console.log(`\n   ${verdict.ok ? '✅ JAVOB OYNASI KO‘RINISHI KERAK' : `❌ ko‘rinmaydi: ${verdict.reason}`}`);
    if (!verdict.ok) {
      // The screen shows this same reason; printing it here is for the case
      // where somebody is looking at a terminal rather than at the app.
      const fix: Record<string, string> = {
        sending_disabled: 'Sozlamalar → «Telegram orqali yuborish» ni yoqing',
        never_wrote_first: 'mijoz sizga yozmagan — birinchi bo‘lib yozib bo‘lmaydi',
        bridge_down: 'tinglovchini yoqing: docker start tg-listen-...',
        rate_minute: 'juda tez-tez — bir daqiqa kuting',
        rate_day: 'kunlik chegaraga yetdi',
        rate_chat: 'shu chatga juda tez-tez',
      };
      console.log(`   → ${fix[verdict.reason] ?? verdict.reason}`);
    }
  }

  // Whose accounts hold conversations — the "not your conversation" case,
  // which is the one nobody guesses.
  const owners = await db
    .select({ manager: users.fullName, n: sql<number>`count(DISTINCT ${tgMessages.clientId})` })
    .from(tgMessages)
    .innerJoin(users, eq(tgMessages.managerUserId, users.id))
    .groupBy(users.fullName);
  console.log('\n7) Yozishmalar kimning akkauntida');
  for (const o of owners) console.log(`   ${o.manager}: ${o.n} ta mijoz`);
  console.log('   ⚠ Faqat O‘Z akkauntingizdagi yozishmaga javob yoza olasiz.\n');

  void tgAccounts;
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
