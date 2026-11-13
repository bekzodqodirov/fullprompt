import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';
import { clientLabels } from '@/modules/platform/telegram/client-labels';
import { CONFIRM_PREFIX, confirmCallback, isConfirmButton, parseConfirmCallback } from '@/modules/platform/telegram/confirm-callback';
import { groupDigits, htmlToPlain, visibleLength } from '@/modules/platform/telegram/format';
import { clientPushKeyboard } from '@/modules/platform/telegram/menu-button';
import { parseCallback } from '@/modules/platform/telegram/staff-bot';
import { MUTE_GROUPS, FOUNDERS } from '@/modules/platform/notifications/mutes';
import { NIGHT_SILENT_TYPES } from '@/modules/platform/notifications/night';
import { receivedText } from '@/modules/wms/notices/client-text';
import { ASK_MAX_CHARS, askFailureOf, askTag, type ClientAskFacts } from '@/modules/wms/receipts/client-confirm';
import { askFits, askText } from '@/modules/wms/receipts/client-confirm-text';
import { read, srcFiles } from '../fixtures/source-shape';

/**
 * The client's own ✅ / ❌ in Telegram (0144, docs/TARKIB-TAKLIFLAR.md §4) —
 * the halves no database is needed for, and the shapes no behavioural test
 * can see: a button nobody answers spins for fifteen seconds with no error
 * anywhere, a second writer of the answers' table would be a second rule, a
 * column DECLARED on an old drizzle table is a 42703 on every prixod of a
 * server one migration behind.
 *
 * Comments are stripped before any source is read (#725).
 */

const RECEIPT = '0190d4b2-7c3a-7a11-8f00-3c5a9d2e41aa';

describe('the button’s grammar — yt:<1|0>:<receipt>:<tag>', () => {
  it('round-trips, both verdicts, and fits Telegram’s 64 bytes with room', () => {
    for (const verdict of ['yes', 'no'] as const) {
      const data = confirmCallback(verdict, { receiptId: RECEIPT, tag: 'a1b2c3d4' })!;
      expect(data).toBe(`yt:${verdict === 'yes' ? 1 : 0}:${RECEIPT}:a1b2c3d4`);
      expect(Buffer.byteLength(data, 'utf8')).toBe(50);
      expect(parseConfirmCallback(data)).toEqual({ verdict, receiptId: RECEIPT, tag: 'a1b2c3d4' });
    }
  });

  it('refuses to BUILD what it would not read back — a refused button costs the message its whole keyboard', () => {
    expect(confirmCallback('yes', { receiptId: 'not-a-uuid', tag: 'a1b2c3d4' })).toBeNull();
    expect(confirmCallback('yes', { receiptId: RECEIPT, tag: 'A1B2C3D4' })).toBeNull();
    expect(confirmCallback('yes', { receiptId: RECEIPT, tag: 'a1b2c3' })).toBeNull();
    expect(confirmCallback('no', { receiptId: RECEIPT, tag: 'a1b2c3d4 ' })).toBeNull();
    // …and the keyboard then carries neither button, never one.
    const rows = clientPushKeyboard('https://x.test', 'uz', { lotId: null, confirm: { receiptId: 'nope', tag: 'a1b2c3d4' } })!.inline_keyboard;
    expect(rows.flat().some(isConfirmButton)).toBe(false);
  });

  it('reads nothing else: garbage, a third verdict, a longer tail', () => {
    for (const data of ['yt:', 'yt:2:x:y', `yt:1:${RECEIPT}`, `yt:1:${RECEIPT}:a1b2c3d4:more`, `xyt:1:${RECEIPT}:a1b2c3d4`, 'mg', '']) {
      expect(parseConfirmCallback(data), data).toBeNull();
    }
  });

  it('is the cabinet’s, not the staff parser’s — a customer’s press the staff handler swallowed would never be answered', () => {
    expect(parseCallback(`yt:1:${RECEIPT}:a1b2c3d4`)).toBeNull();
    expect(parseCallback(`yt:0:${RECEIPT}:a1b2c3d4`)).toBeNull();
    expect(CONFIRM_PREFIX).toBe('yt:');
  });

  it('the row is the LAST of the push keyboard, both buttons or neither, in the chat’s language', () => {
    const ask = { receiptId: RECEIPT, tag: 'a1b2c3d4' };
    for (const locale of ['uz', 'ru', 'en'] as const) {
      const t = clientLabels(locale);
      const rows = clientPushKeyboard('https://x.test', locale, { lotId: null, contact: true, confirm: ask })!.inline_keyboard;
      expect(rows).toHaveLength(3);
      expect(rows[2]).toEqual([
        { text: t.confirmYes, callback_data: `yt:1:${RECEIPT}:a1b2c3d4` },
        { text: t.confirmNo, callback_data: `yt:0:${RECEIPT}:a1b2c3d4` },
      ]);
    }
    // No ask → exactly the keyboard every push has always had.
    expect(clientPushKeyboard('https://x.test', 'uz', { lotId: null, contact: true })!.inline_keyboard).toHaveLength(2);
    expect(clientPushKeyboard('https://x.test', 'uz', { lotId: null, contact: true, confirm: null })!.inline_keyboard).toHaveLength(2);
  });
});

/**
 * DERIVED: every callback the customer's side can put under a message has a
 * handler in the cabinet. The sources are read for what they BUILD, so a new
 * button turns this red the day it is written — an unanswered callback is
 * fifteen seconds of a spinning button and nothing in any log.
 */
describe('every customer button is answered', () => {
  const cabinet = read('src/modules/platform/telegram/client-cabinet.ts');
  const sources = [
    'src/modules/platform/telegram/client-cabinet.ts',
    'src/modules/platform/telegram/menu-button.ts',
    'src/modules/platform/telegram/confirm-callback.ts',
    'src/modules/wms/client-cabinet/bot-text.ts',
  ].map((path) => read(path));
  const built = new Set<string>();
  for (const text of sources) {
    // `callback_data: 'mg'` / `callback_data: \`ph:${…}\`` — the literal head of the data.
    for (const m of text.matchAll(/callback_data:\s*['`]([a-z]+:?)/g)) built.add(m[1]!);
    // `kb.text(label, \`lang:${…}\`)` — grammy's builder.
    for (const m of text.matchAll(/\.text\([^,]+,\s*['`]([a-z]+:?)/g)) built.add(m[1]!);
    // The confirm row's data is built by a helper from its prefix constant.
    for (const m of text.matchAll(/const data = `\$\{CONFIRM_PREFIX\}/g)) if (m) built.add(CONFIRM_PREFIX);
  }

  it('finds the four the cabinet has — or the fence is reading nothing', () => {
    expect([...built].sort()).toEqual(['lang:', 'mg', 'ph:', 'yt:']);
  });

  it('each has its handler', () => {
    const handler: Record<string, string> = {
      mg: "bot.callbackQuery('mg',",
      'ph:': 'bot.callbackQuery(/^ph:(.+)$/,',
      'lang:': 'bot.callbackQuery(/^lang:(.+)$/,',
      'yt:': 'bot.callbackQuery(/^yt:/,',
    };
    for (const prefix of built) {
      expect(handler[prefix], `a button «${prefix}» with no handler named here`).toBeDefined();
      expect(cabinet, prefix).toContain(handler[prefix]!);
    }
  });
});

describe('what the question lists is what it asks about (L5-7)', () => {
  const base: ClientAskFacts = {
    receiptId: RECEIPT,
    receiptNumber: 'YW-0001',
    clientId: 'c-1',
    clientCode: 'GS777',
    warehouseName: 'Yiwu',
    receivedAt: null,
    lots: [],
    scope: 'basic',
    tag: 'a1b2c3d4',
    basicTag: 'a1b2c3d4',
  };
  const kgs = { kg: 12.5, m3: 0.4, shownKg: '12.50', shownM3: '0.400' };
  const plain = { lotId: 'l-1', letter: 'A', zh: '键盘', ru: 'Клавиатура', count: 3, goodsKey: null, goods: [], ...kgs };
  const withGoods = { lotId: 'l-2', letter: 'B', zh: '杂货', ru: 'Мышь +1', count: 2, goodsKey: 'k', goods: [{ name: 'Мышь', pieces: 500 }, { name: 'Коврик', pieces: null }], ...kgs };

  it('a plain lot: «name and box count»', () => {
    for (const locale of ['uz', 'ru', 'en'] as const) {
      const text = htmlToPlain(askText({ ...base, lots: [plain] }, locale));
      expect(text, locale).toContain(clientLabels(locale).confirmAskLine);
      expect(text, locale).not.toContain(clientLabels(locale).confirmAskLineGoods);
    }
  });

  it('a FULL question (0146) asks about the weight and the volume too — in the words of ITS scope, never the 0144 ones', () => {
    for (const locale of ['uz', 'ru', 'en'] as const) {
      const t = clientLabels(locale);
      const one = htmlToPlain(askText({ ...base, scope: 'full', lots: [plain] }, locale));
      expect(one, locale).toContain(t.confirmAskLineFull);
      expect(one, locale).not.toContain(t.confirmAskLine);
      const goods = htmlToPlain(askText({ ...base, scope: 'full', lots: [plain, withGoods] }, locale));
      expect(goods, locale).toContain(t.confirmAskLineGoodsFull);
      expect(goods, locale).not.toContain(t.confirmAskLineFull);
    }
  });

  it('a tarkib’s goods are listed WITH their pieces — and the answer is compared with names AND pieces — so the question asks about the pieces too', () => {
    for (const locale of ['uz', 'ru', 'en'] as const) {
      const text = htmlToPlain(askText({ ...base, lots: [plain, withGoods] }, locale));
      expect(text, locale).toContain(clientLabels(locale).confirmAskLineGoods);
      expect(text, locale).not.toContain(clientLabels(locale).confirmAskLine);
      expect(text, locale).toContain('500');
    }
    expect(clientLabels('uz').confirmAskLineGoods).toContain('donasi');
  });
});

describe('«the server is behind» is ONE sentence — it tells the admin, never «wait a little» (L5-6)', () => {
  it('the tarkib’s own refusal says what the lot check’s does, in four languages', () => {
    // «Server yangilanmoqda — birozdan keyin» sent the VED to wait for an update that is not running:
    // the refusal means a migration did not land, and that ends only when somebody runs it.
    for (const locale of ['uz', 'ru', 'en', 'zh-CN']) {
      const bundle = JSON.parse(readFileSync(`messages/${locale}.json`, 'utf8')) as {
        tarkib: { errors: Record<string, string> };
        lotCheck: { errors: Record<string, string> };
      };
      expect(bundle.tarkib.errors.server_behind, locale).toBe(bundle.lotCheck.errors.server_behind);
    }
    const uz = JSON.parse(readFileSync('messages/uz.json', 'utf8')) as { tarkib: { errors: Record<string, string> } };
    expect(uz.tarkib.errors.server_behind).toContain('yangilanmagan');
    expect(uz.tarkib.errors.server_behind).toContain('administrator');
  });
});

describe('the card’s clock, its mounted block, and words that follow their constant (lens 3)', () => {
  const page = read('src/app/(protected)/receipts/[id]/page.tsx');
  const askPanel = read('src/app/(protected)/receipts/[id]/client-ask-panel.tsx');
  const lotPanel = read('src/app/(protected)/receipts/[id]/lot-check-panel.tsx');

  it('who vouched and when is printed on the OFFICE clock, like the History under the card — never the warehouse’s zone (L3-2)', () => {
    // The two days of the lot panel and the question's «sent at».
    expect(page).toContain('day: tashkentDay(view.person.at),');
    expect(page).toContain('day: tashkentDay(view.client.at),');
    expect(page).not.toMatch(/dayIn\(view\.(person|client)\.at/);
    const when = page.slice(page.indexOf('when: askCard.status.deliveredAt'), page.indexOf('by: askCard.status.askedBy'));
    expect(when).toContain("format.dateTime(askCard.status.deliveredAt, { dateStyle: 'short', timeStyle: 'short' })");
    expect(when).not.toContain('timeZone');
  });

  it('the ask block is MOUNTED wherever the client’s side exists — it keeps its own «✅ yopildi» when the face empties (L3-6)', () => {
    expect(page).toContain('{askFace && <ClientAskPanel receiptId={id} face={askFace} show={askShow} />}');
    expect(page).toMatch(/const askFace = askCard\n\s+\? \{/);
    expect(askPanel).toContain('if (!show && !said && !error) return null;');
    // «Queued» is the status line's to say once it is there — never both.
    expect(askPanel).toContain("const said = done === 'closed' || (done === 'asked' && !status) ? done : null;");
  });

  it('«✅ Saqlandi» is never drawn under a veto (L3-6)', () => {
    expect(lotPanel).toContain('{done && !vetoed && (');
  });

  it('the «too soon» sentence names the cool-down the service really keeps', async () => {
    const { ASK_COOLDOWN_MINUTES } = await import('@/modules/wms/receipts/client-confirm');
    for (const locale of ['uz', 'ru', 'en', 'zh-CN']) {
      const bundle = JSON.parse(readFileSync(`messages/${locale}.json`, 'utf8')) as { lotCheck: { askErrors: Record<string, string> } };
      expect(bundle.lotCheck.askErrors.too_soon, locale).toContain(String(ASK_COOLDOWN_MINUTES));
    }
  });
});

describe('the press handler', () => {
  const cabinet = read('src/modules/platform/telegram/client-cabinet.ts');
  const start = cabinet.indexOf('bot.callbackQuery(/^yt:/, async (ctx) => {');
  const body = cabinet.slice(start, cabinet.indexOf("bot.on('message:text'", start));

  it('is registered on the PREFIX — a push stays in the chat for ever, and a later grammar’s old buttons must still be answered', () => {
    expect(start).toBeGreaterThan(-1);
    expect(body).toContain('parseConfirmCallback(ctx.callbackQuery.data)');
  });

  it('answers exactly ONCE, after deciding — the toast is the outcome’s', () => {
    expect(body.match(/answerPress\(/g)).toHaveLength(1);
    // `again`: «busy» and «failed» ASK for a second press — a late one must not be remembered as handled (L2-1).
    expect(body).toContain('await answerPress(ctx, toastOf[outcome], { again: !settled });');
    expect(body.indexOf("const settled = outcome !== 'busy' && outcome !== 'failed';")).toBeLessThan(body.indexOf('answerPress('));
    expect(body.indexOf('answerClientAsk(')).toBeLessThan(body.indexOf('answerPress('));
    // Typed over every outcome: a seventh is a compile error, never a silent «undefined» toast.
    expect(body).toContain('const toastOf: Record<ConfirmOutcome, string | undefined> = {');
    // A throw is caught, logged and still answered — never left to `bot.catch` with the button spinning.
    const caught = body.slice(body.indexOf('} catch (err) {'), body.indexOf('const t = clientLabels(locale);'));
    expect(caught).toContain("logger.error({ err, chatId: String(chatId) }, '[cabinet] confirm press failed');");
    expect(caught).toContain("outcome = 'failed';");
    // No progress toast: this handler's toast is a RESULT (press-fence pins the two `say: false` sites).
    expect(body).not.toContain('say: false');
  });

  it('a ❌ gets no toast — its one sentence is a message, and a late press would otherwise say it twice', () => {
    expect(body).toMatch(/no: undefined,/);
  });

  it('what it leaves behind goes off the poller, and only the ✅/❌ row is taken off the pressed message', () => {
    expect(body).toContain("dispatch('confirm', chatId, async () => {");
    expect(body).toContain('row.filter((button) => !isConfirmButton(button))');
    expect(body).toContain('editMarkup({');
    // «Busy» and «failed» wrote nothing: the row stays so the press can be repeated.
    expect(body).toContain("const settled = outcome !== 'busy' && outcome !== 'failed';");
    expect(body.indexOf('if (!settled) return;')).toBeLessThan(body.indexOf("dispatch('confirm'"));
    // A message Telegram no longer echoes the keyboard of still loses the row: its two standing rows are rebuilt (L2-5).
    expect(body).toContain("clientPushKeyboard(process.env.APP_URL, locale, { contact: true })?.inline_keyboard ?? []");
    expect(body).toContain('if (!pressed) return;');
  });

  it('the ❌’s sentence goes FIRST, through the ordered send — never a bare send behind the keyboard edit (L2-2)', () => {
    const say = body.indexOf("await sendInOrder(chatId, [{ html: h(staff ? t.confirmNoted : t.confirmTellUs) }], 'confirm-tell');");
    expect(say).toBeGreaterThan(-1);
    expect(say).toBeLessThan(body.indexOf('editMarkup({'));
    expect(body).not.toMatch(/await sendText\(/);
  });

  it('a ❌ is remembered for the words that follow it — the relay sends them to THAT prixod’s seller (L2-3)', () => {
    expect(body).toContain('if (disputing && about) rememberDispute(String(chatId), about);');
    expect(body).toContain("if (answer.outcome === 'recorded') about = { clientId: answer.facts.clientId, receiptId: answer.facts.receiptId };");
    expect(body).toContain("else if (answer.outcome === 'stale') about = { clientId: answer.clientId, receiptId: press.receiptId };");
    const relay = cabinet.slice(cabinet.indexOf('export async function forwardClientMessage('), cabinet.indexOf('export const ACK_QUIET_MS'));
    expect(relay).toContain('const about = disputeOf(chatKey);');
    expect(relay).toContain('const owner = (disputed && reachable(disputed) ? disputed : null) ?? linked.find(reachable) ?? null;');
    expect(relay).toContain("const card = about && disputed ? cardLink('receipt', about.receiptId) : cardLink('client', first.id);");
  });

  it('in a chat that is also a staff chat the relay does not run — so it is never promised', () => {
    expect(body).toContain('await staffForChat(BigInt(chatId))');
    expect(body).toContain("if (!(staff && outcome !== 'no')) {");
    expect(body).toContain('h(staff ? t.confirmNoted : t.confirmTellUs)');
  });

  it('reaches wms by a dynamic import, and the identity is the CHAT — never an id the button carried (#273)', () => {
    expect(body).toContain("await import('../../wms/receipts/client-confirm')");
    expect(cabinet).not.toMatch(/^import .*wms\/receipts\/client-confirm/m);
    expect(body).toContain('answerClientAsk({ chatId: BigInt(chatId), ...press })');
  });
});

describe('one writer, one probe, and columns that stay SQL-only', () => {
  it('`lot_client_confirms` is written by client-confirm.ts and by nothing else in src/', () => {
    const writers = srcFiles()
      .filter(({ path }) => !path.includes('/db/migrations/'))
      .filter(({ text }) =>
        /\.insert\(lotClientConfirms\)|\.update\(lotClientConfirms\)|\.delete\(lotClientConfirms\)|INSERT INTO lot_client_confirms|UPDATE lot_client_confirms|DELETE FROM lot_client_confirms/.test(
          text,
        ),
      )
      .map(({ path }) => path);
    expect(writers).toEqual(['src/modules/wms/receipts/client-confirm.ts']);
  });

  it('the probe gives TWO answers: 0122/0123’s, and 0144’s table apart — one flag would have switched off what has been live since 0123', () => {
    const ready = read('src/modules/wms/receipts/lot-check-ready.ts');
    expect(ready).toContain("to_regclass('public.lot_client_confirms') IS NOT NULL AS client");
    // The first answer names the three older tables and NOT the new one.
    const ok = ready.slice(ready.indexOf('SELECT ('), ready.indexOf(') AS ok'));
    expect(ok).toContain("to_regclass('public.lot_checks')");
    expect(ok).not.toContain('lot_client_confirms');
    expect(ready).toContain('export function lotClientConfirmsReady(): boolean {');
    // The sentence and the joins ask the second answer before they name the alias.
    const sentence = read('src/modules/wms/receipts/lot-check-sql.ts');
    expect(sentence.match(/lotClientConfirmsReady\(\)/g)!.length).toBeGreaterThanOrEqual(2);
    const state = sentence.slice(sentence.indexOf('export function lotCheckStateSql('), sentence.indexOf('export function askableSql('));
    expect(state.indexOf('if (!lotClientConfirmsReady())')).toBeGreaterThan(-1);
    expect(state.indexOf('if (!lotClientConfirmsReady())')).toBeLessThan(state.indexOf('clientDisputeSql(refs)'));
  });

  it('0146: the probe gives a THIRD answer — the measure columns — and remembers it only when all three are yes', () => {
    const ready = read('src/modules/wms/receipts/lot-check-ready.ts');
    // The columns, asked of the catalogue (a table that exists says nothing
    // about a column added to it later).
    expect(ready).toContain("AND attname IN ('shown_kg', 'shown_m3') AND NOT attisdropped) AS measures");
    // The early return reads ALL THREE flags: with the first two alone, a
    // process that had seen 0144 and not 0146 never asked again, and the
    // repaired migration switched nothing on until a restart.
    expect(ready).toContain('if (ready && clientReady && measuresReady) return true;');
    expect(ready).not.toContain('if (ready && clientReady) return true;');
  });

  it('0146: the measure columns are named in four files and nowhere else, and the remembered third answer is read only by the sentence and the card', () => {
    // SQL-only columns (a drizzle column would be named in every whole-row
    // read of the table, one migration behind): each file that names them
    // either asked the third answer first or IS the probe / the migration.
    const namers = srcFiles()
      .filter(({ text }) => /shown_kg|shown_m3/.test(text))
      .map(({ path }) => path)
      .sort();
    expect(namers).toEqual([
      'src/modules/wms/receipts/client-confirm.ts',
      'src/modules/wms/receipts/lot-check-ready.ts',
      'src/modules/wms/receipts/lot-check-sql.ts',
      'src/modules/wms/receipts/lot-check.ts',
    ]);
    const syncReaders = srcFiles()
      .filter(({ path }) => path !== 'src/modules/wms/receipts/lot-check-ready.ts')
      .filter(({ text }) => text.includes('lotClientMeasuresReady('))
      .map(({ path }) => path)
      .sort();
    // The sentence's builders (their callers await the probe) and the card's
    // view (which awaits it itself). The WRITER never reads the remembered
    // flag: it asks `clientMeasuresReady()`, the probe, on its own path.
    expect(syncReaders).toEqual(['src/modules/wms/receipts/lot-check-sql.ts', 'src/modules/wms/receipts/lot-check.ts']);
    const writer = read('src/modules/wms/receipts/client-confirm.ts');
    expect(writer).not.toContain('lotClientMeasuresReady(');
    expect(writer).toContain('await clientMeasuresReady()');
    // …and the card's read sits in a function that awaited the probe.
    const card = read('src/modules/wms/receipts/lot-check.ts');
    for (const hit of card.matchAll(/lotClientMeasuresReady\(\)/g)) {
      const before = card.slice(0, hit.index);
      const opened = Math.max(before.lastIndexOf('\nexport async function '), before.lastIndexOf('\nasync function '));
      expect(before.slice(opened)).toContain('await lotChecksReady()');
    }
  });

  it('the REMEMBERED answer is read only where the probe was asked on the same path — a writer never trusts what another screen warmed (L1-1)', () => {
    // A server action lives in a module instance of its own: after a restart
    // nothing in it has probed, so a writer reading the flag alone read «no
    // such table» and refused the logist's ✅ on every answered lot until
    // somebody pressed «Mijozdan so'rash». The fence is DERIVED: every file
    // that reads the flag is on this list, and a new one is red the day it is written.
    const readers = srcFiles()
      .filter(({ path }) => path !== 'src/modules/wms/receipts/lot-check-ready.ts')
      .filter(({ text }) => text.includes('lotClientConfirmsReady('))
      .map(({ path }) => path)
      .sort();
    expect(readers).toEqual([
      // The sentence's builders return SQL and cannot await — every reader of
      // theirs awaits `lotChecksReady()` before it builds a statement.
      'src/modules/wms/receipts/lot-check-sql.ts',
      // The card's views: the probe is awaited in the same function, two lines above.
      'src/modules/wms/receipts/lot-check.ts',
    ]);
    const tick = read('src/modules/wms/receipts/lot-check.ts');
    const reads = [...tick.matchAll(/lotClientConfirmsReady\(\)/g)];
    expect(reads).toHaveLength(1);
    for (const hit of reads) {
      const before = tick.slice(0, hit.index);
      const opened = Math.max(before.lastIndexOf('\nexport async function '), before.lastIndexOf('\nasync function '));
      expect(before.slice(opened)).toContain('await lotChecksReady()');
    }
    // The press asks the probe ITSELF, on the pool, before its transaction opens (#714).
    const press = tick.slice(tick.indexOf('export async function checkLot('), tick.indexOf('async function lockCheckRow('));
    const asked = press.indexOf('const clientSide = await clientConfirmsReady();');
    expect(asked).toBeGreaterThan(-1);
    expect(asked).toBeLessThan(press.indexOf('db.transaction('));
    expect(press).toContain('await clientAnswerFor(tx, lot.id, current.client_id, clientSide)');
    expect(tick).toContain('if (!clientSide) return { token: null, outranksTick: false };');
  });

  it('`client_notices.asked_by` is not on the drizzle table — the receipt’s own claim inserts through it inside confirmReceipt’s transaction', () => {
    const platform = readFileSync('src/modules/platform/db/schema/platform.ts', 'utf8');
    const start = platform.indexOf("pgTable(\n  'client_notices',");
    expect(start).toBeGreaterThan(-1);
    const table = platform.slice(start, platform.indexOf('\n);\n', start));
    expect(table).not.toMatch(/asked_by|askedBy/);
  });

  it('a tick and an answer about one lot take the SAME lock — one helper, both writers', () => {
    const tick = read('src/modules/wms/receipts/lot-check.ts');
    const answer = read('src/modules/wms/receipts/client-confirm.ts');
    expect(tick).toContain('export async function lockLotAnswersTx(tx: Tx, lotId: string): Promise<void> {');
    expect(tick.match(/await lockLotAnswersTx\(tx, lotId\)/g)).toHaveLength(1);
    expect(answer).toContain('for (const id of [...lotIds].sort()) await lockLotAnswersTx(tx, id);');
    // The answer's clock is the wall clock: it may have waited behind a tick that began after it.
    expect(answer.match(/answeredAt: sql`clock_timestamp\(\)`/g)).toHaveLength(2);
    expect(answer).toContain("await tx.execute(sql`SET LOCAL lock_timeout = '3s'`);");
  });
});

describe('who hears, and when', () => {
  it('a dispute is an ALERT, a confirmation is routine — and neither rings at night', () => {
    expect(MUTE_GROUPS.alerts).toContain('ClientLotDisputed');
    expect(MUTE_GROUPS.operations).toContain('ClientLotConfirmed');
    expect(NIGHT_SILENT_TYPES.has('ClientLotDisputed')).toBe(true);
    expect(NIGHT_SILENT_TYPES.has('ClientLotConfirmed')).toBe(true);
  });

  it('…and neither is a FOUNDER: a mute list written before this round must not start reading «whole group ticked» because of them', () => {
    for (const group of Object.keys(FOUNDERS) as (keyof typeof FOUNDERS)[]) {
      expect(FOUNDERS[group]).not.toContain('ClientLotDisputed');
      expect(FOUNDERS[group]).not.toContain('ClientLotConfirmed');
    }
  });
});

const facts = (lots: ClientAskFacts['lots'], scope: ClientAskFacts['scope'] = 'full'): ClientAskFacts => ({
  receiptId: RECEIPT,
  receiptNumber: 'YW-000123',
  clientId: '0190d4b2-7c3a-7a11-8f00-3c5a9d2e41bb',
  clientCode: 'GS777',
  warehouseName: 'Yiwu',
  receivedAt: new Date('2026-11-09T04:00:00Z'),
  lots,
  scope,
  tag: askTag('0190d4b2-7c3a-7a11-8f00-3c5a9d2e41bb', lots, scope),
  basicTag: askTag('0190d4b2-7c3a-7a11-8f00-3c5a9d2e41bb', lots, 'basic'),
});
const PLAIN = {
  lotId: 'l1',
  letter: 'A',
  zh: '键盘',
  ru: 'Клавиатура',
  count: 100,
  goodsKey: null,
  goods: [],
  kg: 1000,
  m3: 2.5,
  shownKg: '1000.00',
  shownM3: '2.500',
};
const TARKIB = {
  lotId: 'l2',
  letter: 'B',
  zh: '杂货',
  ru: 'Мышь +1',
  count: 2,
  kg: 450.5,
  m3: 3.2,
  shownKg: '450.50',
  shownM3: '3.200',
  goodsKey: 'k',
  goods: [
    { name: 'Мышь <USB>', pieces: 1500 },
    { name: 'Коврик', pieces: null },
  ],
};

describe('the question a person sends («Mijozdan so‘rash»)', () => {
  it('a FULL question prints what its ✅ is ABOUT: per lot the goods, the carton count and the LOT’s kilos and cubic metres — a tarkib’s on the lot line, never per good — and the prixod’s total', () => {
    const text = htmlToPlain(askText(facts([PLAIN, TARKIB]), 'uz'));
    const t = clientLabels('uz');
    const lines = text.split('\n').filter((line) => line.trim() !== '');
    expect(lines[0]).toBe(t.confirmAskTitle);
    expect(lines.slice(2, 7)).toEqual([
      `📦 A · Клавиатура — 100 quti · ${groupDigits(1000)} kg · 2.5 m³`,
      '📦 B — 2 quti · 450.5 kg · 3.2 m³',
      `   • Мышь <USB> — ${groupDigits(1500)} ${t.unitDona}`,
      '   • Коврик',
      `${t.arrivedTotal}: 102 quti · ${groupDigits(1450.5)} kg · 5.7 m³`,
    ]);
    // Goods are listed with their pieces, so the question asks about them too — and about the measures.
    expect(lines).toContain(t.confirmAskLineGoodsFull);
    expect(lines.at(-1)).toContain('YW-000123');
    // «Urg'u»: the ask is bold in the message itself.
    expect(askText(facts([PLAIN, TARKIB]), 'uz')).toContain(`<b>${t.confirmAskLineGoodsFull.replace(/&/g, '&amp;')}</b>`);
  });

  it('one lot is its own total — no «Jami» line under a single lot', () => {
    const text = htmlToPlain(askText(facts([PLAIN]), 'uz'));
    expect(text).not.toContain(clientLabels('uz').arrivedTotal);
    expect(text).toContain(`100 quti · ${groupDigits(1000)} kg · 2.5 m³`);
  });

  it('a BASIC question (a server without 0146) prints what ITS ✅ is about and nothing else: no kilos, no cubic metres, the 0144 words', () => {
    const text = htmlToPlain(askText(facts([PLAIN, TARKIB], 'basic'), 'uz'));
    const t = clientLabels('uz');
    const lines = text.split('\n').filter((line) => line.trim() !== '');
    expect(lines[0]).toBe(t.confirmAskTitle);
    expect(lines[1]).toContain('GS777');
    expect(lines[1]).toContain('Yiwu');
    expect(lines.slice(2, 6)).toEqual([
      '📦 A · Клавиатура — 100 quti',
      '📦 B — 2 quti',
      `   • Мышь <USB> — ${groupDigits(1500)} ${t.unitDona}`,
      '   • Коврик',
    ]);
    // Goods are listed with their pieces, so the question asks about the pieces too (L5-7).
    expect(lines).toContain(t.confirmAskLineGoods);
    expect(lines.at(-1)).toContain('YW-000123');
    expect(text).not.toMatch(/\bkg\b|\bкг\b|m³|м³/);
  });

  it('is HTML-safe: a name with «<» is escaped, never a refused message', () => {
    expect(askText(facts([TARKIB]), 'ru')).toContain('Мышь &lt;USB&gt;');
  });

  it('says it in the chat’s language — and the question names WHAT is being confirmed, never «hammasi»', () => {
    for (const locale of ['uz', 'ru', 'en'] as const) {
      const t = clientLabels(locale);
      const text = htmlToPlain(askText(facts([PLAIN], 'basic'), locale));
      expect(text).toContain(t.confirmAskTitle);
      expect(text).toContain(t.confirmAskLine);
    }
    // Under the FULL scope the same subjects come first, in the same order, then the two measures
    // and the ask to CHECK — the owner's «tekshirib olsin klient va tasdiqlasin» (0146).
    for (const locale of ['uz', 'ru', 'en'] as const) {
      expect(htmlToPlain(askText(facts([PLAIN], 'basic'), locale))).not.toContain(clientLabels(locale).confirmAskLineFull);
    }
    expect(clientLabels('uz').confirmAskLineFull).toMatch(/nomi.*quti soni.*og‘irligi.*hajmi.*Tekshirib/);
    expect(clientLabels('ru').confirmAskLineFull).toMatch(/[Нн]азвание товара.*количество коробок.*вес.*объём.*Проверьте/);
    expect(clientLabels('en').confirmAskLineFull).toMatch(/names.*box count.*weight.*volume.*check/);
    expect(clientLabels('uz').confirmAskLineGoodsFull).toMatch(/donasi.*quti soni.*og‘irligi.*hajmi/);
    expect(clientLabels('uz').confirmThanksFull).toMatch(/nomi.*quti soni.*og‘irligi.*hajmi/);
    // A toast is 200 characters at most (Telegram's own limit on a callback answer).
    for (const locale of ['uz', 'ru', 'en'] as const) {
      expect(clientLabels(locale).confirmThanksFull.length, locale).toBeLessThanOrEqual(200);
    }
    expect(clientLabels('uz').confirmAskLine).toMatch(/nomi.*quti soni/);
    // The question counts in the SAME word as the lines above it («коробок», `boxMany`) — never «мест»
    // — and every language names the NAME (L5-7).
    expect(clientLabels('ru').confirmAskLine).toMatch(/[Нн]азвание товара.*количество коробок/);
    expect(clientLabels('ru').confirmAskLine).not.toContain('мест');
    expect(clientLabels('ru').confirmThanks).not.toContain('мест');
    expect(clientLabels('en').confirmAskLine).toMatch(/names/);
    expect(clientLabels('en').confirmAskLine).toMatch(/goods.*box count/);
    // The BASIC ✅'s thanks repeat ITS subject — a press on a message sent before 0146 confirmed no weight.
    expect(clientLabels('uz').confirmThanks).toMatch(/nomi.*quti soni/);
    expect(clientLabels('uz').confirmThanks).not.toMatch(/og‘irli|hajm/);
  });

  it('a list that would not fit one message is refused to the PRESSER, in every language at once', () => {
    expect(askFits(facts([PLAIN, TARKIB]))).toBe(true);
    const long = Array.from({ length: 30 }, (_, i) => ({
      ...TARKIB,
      lotId: `x${i}`,
      goods: Array.from({ length: 20 }, (__, j) => ({ name: `Товар ${i}-${j} ${'я'.repeat(70)}`, pieces: 1000 + j })),
    }));
    const big = facts(long);
    expect(visibleLength(askText(big, 'ru'))).toBeGreaterThan(ASK_MAX_CHARS);
    expect(askFits(big)).toBe(false);
  });

  it('the tag covers what the question prints: a name, a count, the goods, the owner — and not the letter’s order of keys', () => {
    const base = facts([PLAIN, TARKIB]).tag;
    expect(base).toMatch(/^[0-9a-f]{8}$/);
    expect(facts([{ ...PLAIN, ru: 'Клавиатуры' }, TARKIB]).tag).not.toBe(base);
    expect(facts([{ ...PLAIN, count: 101 }, TARKIB]).tag).not.toBe(base);
    expect(facts([PLAIN, { ...TARKIB, goodsKey: 'other' }]).tag).not.toBe(base);
    expect(askTag('another-client', [PLAIN, TARKIB], 'full')).not.toBe(base);
    // The goods' printed list rides in `goodsKey` (the reader's own digest), so the array itself is not hashed twice.
    expect(facts([PLAIN, { ...TARKIB, goods: [] }]).tag).toBe(base);
  });

  it('a FULL tag covers the two measures as the customer reads them; the BASIC tag is the 0144 recipe byte for byte (0146)', () => {
    const full = facts([PLAIN, TARKIB]);
    // The recipe every button already in a customer's chat was hashed with — a LITERAL, computed from
    // the 0144 function before it was touched: a changed basic recipe kills every such button at deploy.
    expect(full.basicTag).toBe('5a0ae98c');
    expect(askTag(full.clientId, full.lots)).toBe('5a0ae98c');
    expect(full.tag).not.toBe(full.basicTag);
    // …and the FULL recipe is under every button sent from 0146 on, so it is a LITERAL too (computed
    // from the function as it shipped): a later change to how the measures are spelled into the hash —
    // `lotShownKgSql`, its `::text`, a `trim_scale` — would answer «eskirgan» under every full button
    // already in customers' chats, with the relational assertions below all still green.
    expect(full.tag).toBe('3795624c');
    // A re-weigh a customer would SEE moves the full tag and leaves the basic one alone…
    expect(facts([{ ...PLAIN, shownKg: '1000.01' }, TARKIB]).tag).not.toBe(full.tag);
    expect(facts([PLAIN, { ...TARKIB, shownM3: '3.201' }]).tag).not.toBe(full.tag);
    expect(facts([{ ...PLAIN, shownKg: '1000.01' }, TARKIB]).basicTag).toBe(full.basicTag);
    // …and the STORED figures are not hashed at all: a correction below what any list prints
    // (1000.000 → 1000.004 kg, both «1 000 kg») leaves both tags where they were.
    expect(facts([{ ...PLAIN, kg: 1000.004 }, TARKIB]).tag).toBe(full.tag);
  });
});

describe('«yukingiz qabul qilindi» with the question', () => {
  const summary = {
    clientCode: 'GS777',
    receiptNumber: 'YW-000123',
    warehouseName: 'Yiwu',
    receivedAt: new Date('2026-11-09T04:00:00Z'),
    lines: [{ lotId: 'l1', letter: 'A', name: 'Клавиатура', boxCount: 100, weightKg: 1000, volumeM3: 2.5 }],
    stage: 'cn_stock' as never,
    fresh: true,
  };

  it('the question is the LAST block, and without it the push is byte for byte what it was', () => {
    for (const locale of ['uz', 'ru', 'en'] as const) {
      const plain = receivedText(summary, locale);
      const asking = receivedText(summary, locale, { ask: 'basic' });
      expect(receivedText(summary, locale, {})).toBe(plain);
      expect(receivedText(summary, locale, { ask: undefined })).toBe(plain);
      expect(asking.startsWith(plain)).toBe(true);
      expect(htmlToPlain(asking).trimEnd().split('\n').at(-1)).toBe(clientLabels(locale).confirmAskLine);
    }
  });

  it('a FULL question (0146) asks about the kilos and cubic metres the lines above it print — in bold, still the LAST block', () => {
    for (const locale of ['uz', 'ru', 'en'] as const) {
      const t = clientLabels(locale);
      const plain = receivedText(summary, locale);
      const asking = receivedText(summary, locale, { ask: 'full' });
      expect(asking.startsWith(plain)).toBe(true);
      expect(htmlToPlain(asking).trimEnd().split('\n').at(-1)).toBe(t.confirmAskLineFull);
      expect(asking.trimEnd().endsWith('</b>')).toBe(true);
      // The line it asks about IS on the push: the lot's kilos and cubic metres.
      expect(htmlToPlain(plain)).toMatch(new RegExp(`${groupDigits(1000)} ${t.kg} · 2\\.5 ${t.m3}`));
    }
  });
});

describe('why a question did not arrive — words, never a Bot API sentence', () => {
  it('every reason the sweep can skip a question for has its word', () => {
    const jobs = read('src/modules/wms/notices/arrival-jobs.ts');
    const prepare = jobs.slice(jobs.indexOf('async function prepareLotAsk('), jobs.indexOf('async function prepareIssued('));
    const deliver = jobs.slice(jobs.indexOf('async function deliverNotice('), jobs.indexOf('export async function sendDueArrivalNotices('));
    const literal = [...prepare.matchAll(/skip: '([a-z_]+)'/g), ...deliver.matchAll(/reason: '([a-z_]+)'/g)].map((m) => m[1]!);
    expect(literal.sort()).toEqual(['client_gone', 'no_linked_chat', 'too_long', 'unknown_kind']);
    for (const reason of [...literal, 'client_changed', 'receipt_gone', 'voided', 'not_confirmed', 'no_client', 'no_lots']) {
      const word = askFailureOf('skipped', reason);
      expect(word, reason).not.toBeNull();
      // «telegram» is the word for what nobody can name; a NAMED reason must not fall into it — except the one that is our own bug.
      if (reason !== 'unknown_kind') expect(word, reason).not.toBe('telegram');
    }
  });

  it('a refusal by Telegram is «blocked» only when it says so; a question still waiting or delivered has no failure', () => {
    expect(askFailureOf('failed', '403 Forbidden: bot was blocked by the user')).toBe('blocked');
    expect(askFailureOf('failed', '400 Bad Request: chat not found')).toBe('blocked');
    expect(askFailureOf('failed', '502 Bad Gateway')).toBe('telegram');
    expect(askFailureOf('failed', null)).toBe('telegram');
    expect(askFailureOf('skipped', 'something_new')).toBe('telegram');
    for (const status of ['pending', 'sending', 'sent']) expect(askFailureOf(status, 'whatever')).toBeNull();
  });

  it('the card draws the WORD: the panel has a sentence for each, and never prints the row’s own error', () => {
    const panel = read('src/app/(protected)/receipts/[id]/client-ask-panel.tsx');
    expect(panel).toContain('t(`askFailed.${status.failure}`)');
    expect(panel).not.toMatch(/reason|last_error|lastError/);
    const uz = JSON.parse(readFileSync('messages/uz.json', 'utf8')) as { lotCheck: { askFailed: Record<string, string> } };
    expect(Object.keys(uz.lotCheck.askFailed).sort()).toEqual(['blocked', 'client_changed', 'no_chat', 'receipt_changed', 'telegram', 'too_long']);
  });
});
