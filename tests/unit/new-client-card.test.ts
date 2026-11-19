import { describe, expect, it } from 'vitest';
import { newClientPlan, notePlan, planMessageCount, type NoteFile, type NoteHead } from '@/modules/platform/notes/plan';
import { cardStepVerdict, noteCardOf } from '@/modules/platform/notifications/note-card';
import { isMijozStart, mijozStartUrl } from '@/modules/platform/telegram/mijoz-start';
import { newClientFooter, newClientStaffText } from '@/modules/wms/client-card/address-card';
import { GS_REMINDER } from '@/modules/wms/agent/seed-kb';
import { MAX_CAPTION_CHARS } from '@/modules/platform/telegram/limits';
import { bodyOf, read, srcFiles } from '../fixtures/source-shape';

/**
 * The new-client address card (0151, the owner, 2026-11-19): what the seller
 * of a new code is sent to forward to the customer — the ticked company
 * zametkalar merged into ONE message, the marking line, his reminder, the
 * generic bot link — and the wires that put it on exactly three doors.
 *
 * The planner, the footer, the staff line, the bot payload and the drain's two
 * cursor rules are pure and proven here. The doors and the drain's cursor run
 * against a database in tests/integration/new-client-card.integration.test.ts;
 * what can only be read is SOURCE SHAPE, comments stripped (#725).
 */

const head = (over: Partial<NoteHead> = {}): NoteHead => ({ id: 'n1', title: 'Xitoy sklad', body: null, ...over });
let seq = 0;
const file = (over: Partial<NoteFile> = {}): NoteFile => {
  seq += 1;
  return {
    partId: `p${seq}`,
    attachmentId: `a${seq}`,
    fileName: `f${seq}.jpg`,
    storageKey: `staff_note/n/${seq}`,
    sizeBytes: 1000,
    sendAs: 'photo',
    telegramFileId: null,
    telegramSentAs: null,
    ...over,
  };
};

const FOOTER = 'Markirovka / 唛头: GS777';

describe('newClientPlan — every ticked note merged into ONE message', () => {
  it('his own case — three addresses and one picture — is ONE photo with every word under it', () => {
    const sheet = file();
    const plan = newClientPlan(
      [head({ body: 'Ivu: 义乌市 …\nGuanchjou: 佛山 …\nXorgos: 霍尔果斯 …' })],
      [sheet],
      FOOTER,
    );
    expect(plan.steps).toEqual([
      {
        kind: 'media',
        as: 'photo',
        files: [sheet],
        caption: `Xitoy sklad\n\nIvu: 义乌市 …\nGuanchjou: 佛山 …\nXorgos: 霍尔果斯 …\n\n${FOOTER}`,
      },
    ]);
    expect(plan.messages).toBe(1);
  });

  it('several notes: each note’s own caption (title kept, as 📌 sends it) in the notes’ order, then the footer', () => {
    const a = file();
    const b = file({ sendAs: 'document', fileName: 'b.pdf' });
    const plan = newClientPlan([head({ id: 'n1', title: 'Ivu', body: 'manzil 1' }), head({ id: 'n2', title: 'Xorgos' })], [a, b], FOOTER);
    // A photo and then a document: two runs, the caption rides the FIRST.
    expect(plan.steps.map((s) => s.kind)).toEqual(['media', 'media']);
    const first = plan.steps[0] as Extract<(typeof plan.steps)[number], { kind: 'media' }>;
    expect(first.caption).toBe(`Ivu\n\nmanzil 1\n\nXorgos\n\n${FOOTER}`);
    expect((plan.steps[1] as typeof first).caption).toBeNull();
    expect(plan.messages).toBe(2);
  });

  it('text over 1024 goes FIRST (split, never cut) and the files after it bare — contiguous', () => {
    const photos = [file(), file()];
    const long = 'x'.repeat(MAX_CAPTION_CHARS + 50);
    const plan = newClientPlan([head({ body: long })], photos, FOOTER);
    expect(plan.steps[0]).toMatchObject({ kind: 'text' });
    expect((plan.steps[0] as { text: string }).text).toContain(FOOTER);
    expect(plan.steps.slice(1)).toEqual([{ kind: 'media', as: 'photo', files: photos, caption: null }]);
    // The count is the album's members, from the same steps.
    expect(plan.messages).toBe(planMessageCount(plan.steps));
    expect(plan.messages).toBe(3);
  });

  it('nothing ticked (the deploy morning): the footer alone, one message', () => {
    const plan = newClientPlan([], [], FOOTER);
    expect(plan.steps).toEqual([{ kind: 'text', text: FOOTER }]);
    expect(plan.messages).toBe(1);
  });

  it('a 📌 tap plans exactly as before — the shared rule changed nothing for it', () => {
    const sheet = file();
    expect(notePlan(head({ body: 'b' }), [sheet])).toEqual([{ kind: 'media', as: 'photo', files: [sheet], caption: 'Xitoy sklad\n\nb' }]);
    expect(notePlan(head(), [])).toEqual([{ kind: 'text', text: 'Xitoy sklad' }]);
  });
});

describe('the footer — his words, one home', () => {
  it('the marking line in both languages, then his reminder VERBATIM, then the bot line', () => {
    const footer = newClientFooter({ code: 'GS777', notesText: 'Ivu manzili', botUrl: 'https://t.me/gsr_bot?start=mijoz' });
    const lines = footer.split('\n');
    expect(lines[0]).toBe('Markirovka / 唛头: GS777');
    expect(lines[1]).toBe(GS_REMINDER);
    expect(lines[2]).toBe('Yuklaringizni Telegramda kuzatish uchun botimiz: https://t.me/gsr_bot?start=mijoz');
    expect(lines).toHaveLength(3);
  });

  it('the reminder is left out when the ticked notes already say it — 唛头 or markirovka, any case', () => {
    for (const notesText of ['Har qutiga 唛头 yozing', 'MARKIROVKA: GS', 'markirovkani unutmang']) {
      const footer = newClientFooter({ code: 'GS1', notesText, botUrl: null });
      expect(footer, notesText).toBe('Markirovka / 唛头: GS1');
    }
  });

  it('no bot name, no bot line — never «t.me/null»', () => {
    const footer = newClientFooter({ code: 'GS2', notesText: '', botUrl: null });
    expect(footer).not.toContain('t.me');
    expect(footer).not.toContain('null');
  });

  it('a customer with a language reads the bot line in it', () => {
    expect(newClientFooter({ code: 'GS3', notesText: '', botUrl: 'https://t.me/b?start=mijoz', locale: 'ru' })).toContain(
      'Telegram-боте: https://t.me/b?start=mijoz',
    );
  });
});

describe('the staff line', () => {
  it('names the code and the client, counts the messages below it, the card link last', () => {
    const text = newClientStaffText({
      code: 'GS777',
      name: 'Bobur aka',
      messages: 2,
      noNote: false,
      alreadyLinked: false,
      cardUrl: 'https://app.example/admin/clients/1',
    });
    expect(text).toBe('🆕 GS777 · Bobur aka — pastdagi 2 ta xabarni belgilab mijozga forward qiling\nhttps://app.example/admin/clients/1');
  });

  it('says the address is missing, and that the customer is already in the bot', () => {
    const text = newClientStaffText({ code: 'GS1', name: 'A', messages: 1, noNote: true, alreadyLinked: true, cardUrl: null });
    expect(text.split('\n')).toEqual([
      '🆕 GS1 · A — pastdagi 1 ta xabarni belgilab mijozga forward qiling',
      '⚠ Manzil zametkasi belgilanmagan — bu xabarda sklad manzili yo‘q',
      'ℹ️ Mijoz botga allaqachon ulangan',
    ]);
  });
});

describe('?start=mijoz — a link that names nobody', () => {
  it('is recognised exactly, never as a prefix of a stranger’s string', () => {
    expect(isMijozStart('mijoz')).toBe(true);
    expect(isMijozStart(' Mijoz ')).toBe(true);
    for (const other of ['mijozX', 'ad_mijoz', 'cmijoz', '', null, undefined]) expect(isMijozStart(other), String(other)).toBe(false);
  });

  it('builds the link only from a real bot name', () => {
    expect(mijozStartUrl('gsr_bot')).toBe('https://t.me/gsr_bot?start=mijoz');
    expect(mijozStartUrl('@gsr_bot')).toBe('https://t.me/gsr_bot?start=mijoz');
    expect(mijozStartUrl(null)).toBeNull();
    expect(mijozStartUrl('')).toBeNull();
  });
});

describe('the drain’s cursor rules', () => {
  it('reads a card off a row, and refuses a row of another shape', () => {
    expect(noteCardOf({ card: { steps: [{ kind: 'text', text: 'a' }], done: 2, head: 5, ids: [5, 6], maybe: [1] } })).toEqual({
      steps: [{ kind: 'text', text: 'a' }],
      done: 2,
      head: 5,
      ids: [5, 6],
      maybe: [1],
    });
    expect(noteCardOf({ card: { steps: [] } })).toEqual({ steps: [], done: 0, head: null, ids: [], maybe: [] });
    expect(noteCardOf({})).toBeNull();
    expect(noteCardOf({ card: { done: 1 } })).toBeNull();
  });

  it('a message that may be in the chat is never sent twice; a refused connect and Telegram’s «no» are retried', () => {
    const verdict = (status: number, description = '', retryAfter: number | null = null, botDown = false) =>
      cardStepVerdict({ status, description, retryAfter, botDown });
    expect(verdict(429, 'Too Many Requests', 3)).toBe('pause');
    expect(verdict(401, 'Unauthorized', null, true)).toBe('pause');
    expect(verdict(0, 'The operation was aborted due to timeout')).toBe('ambiguous');
    expect(verdict(0, 'socket hang up ECONNRESET')).toBe('ambiguous');
    expect(verdict(502)).toBe('ambiguous');
    expect(verdict(504)).toBe('ambiguous');
    expect(verdict(0, 'request to api.telegram.org failed, reason: connect ECONNREFUSED')).toBe('retry');
    expect(verdict(0, 'getaddrinfo ENOTFOUND api.telegram.org')).toBe('retry');
    expect(verdict(400, 'Bad Request: chat not found')).toBe('retry');
    expect(verdict(500)).toBe('retry');
  });
});

describe('the wires', () => {
  const drain = read('src/modules/platform/notifications/service.ts');
  const card = bodyOf(drain, 'async function deliverNoteCard(');
  const actions = read('src/app/(protected)/admin/clients/actions.ts');
  const crm = read('src/modules/wms/crm/service.ts');
  const helper = read('src/modules/wms/client-card/address-card.ts');

  it('the drain branch sends the forwardable part through the zametka sender, never the staff dressing', () => {
    expect(card, 're-anchor: deliverNoteCard moved').not.toBe('');
    expect(card).toContain('sendPlan(api, chatId, card.steps, {');
    expect(card).toContain("onRateLimit: 'return'");
    // send.ts's senders take whole Buffers and cannot cache an album (judge D2);
    // the staff dressing (bold title, «↗️ Ochish», the cap) never touches the
    // customer's message (the drain hands in the staff line already composed).
    for (const banned of ['composeStaffHtml(', 'composeStaffMessage(', 'buttonsFor(', 'sendDocument(', 'sendAlbum(', 'sendPhoto(', 'protect_content']) {
      expect(card, banned).not.toContain(banned);
    }
    // The cursor is stamped in SQL, the frozen plan beside it untouched.
    expect(card).toContain("jsonb_set(payload, '{card}', (payload->'card') ||");
    // In the chain, before the offer sheet and the plain sender.
    const chain = drain.indexOf('(await deliverNoteCard(');
    expect(chain).toBeGreaterThan(-1);
    expect(chain).toBeLessThan(drain.indexOf('(await deliverWithSheet('));
  });

  it('the card is queued for ONE person and never with the presser excepted (judge D5)', () => {
    expect(helper).toContain('userIds: [recipientId],');
    expect(helper).not.toContain('exceptUserId');
  });

  it('exactly THREE doors call it — the «+», the full form, the won lead’s mint — and never createClient or the import', () => {
    const calls = srcFiles().flatMap((f) =>
      [...f.text.matchAll(/\bsendNewClientCard\(/g)].map(() => f.path),
    );
    const callers = calls.filter((path) => !path.endsWith('wms/client-card/address-card.ts'));
    expect(callers.sort()).toEqual(
      ['src/app/(protected)/admin/clients/actions.ts', 'src/app/(protected)/admin/clients/actions.ts', 'src/modules/wms/crm/service.ts'].sort(),
    );
    expect(read('src/modules/platform/clients/service.ts')).not.toMatch(/sendNewClientCard|address-card/);
    expect(read('scripts/import-clients.ts')).not.toMatch(/sendNewClientCard|address-card/);
  });

  it('the «+» calls it inside its try, after the celebration; the full form before its redirect', () => {
    const quick = bodyOf(actions, 'export async function quickCreateClientAction(');
    const tryAt = quick.indexOf('try {');
    const callAt = quick.indexOf('await sendNewClientCard(row.id, actor.id)');
    expect(callAt).toBeGreaterThan(quick.indexOf('await celebrateNewClient(row.id, actor.id)'));
    expect(callAt).toBeGreaterThan(tryAt);
    expect(callAt).toBeLessThan(quick.indexOf('} catch (err) {'));
    expect(quick).toContain('addressCard };');
    const full = bodyOf(actions, 'export async function createClientAction(');
    expect(full.indexOf('await sendNewClientCard(row.id, actor.id)')).toBeLessThan(full.indexOf('redirect('));
    expect(full.indexOf('await sendNewClientCard(row.id, actor.id)')).toBeGreaterThan(-1);
  });

  it('winLead sends it only on the press that MINTED, right after the client lands on the lead, before the deal transaction (judge R7)', () => {
    const win = bodyOf(crm, 'export async function winLead(');
    const write = win.indexOf('.set({ clientId, updatedAt: new Date() })');
    const guarded = win.indexOf('if (minted) {');
    const call = win.indexOf('addressCard = await sendNewClientCard(clientId!, ctx.actorId);');
    expect(write).toBeGreaterThan(-1);
    expect(call).toBeGreaterThan(guarded);
    expect(guarded).toBeGreaterThan(write);
    expect(call).toBeLessThan(win.indexOf("entityType: 'lead',"));
    expect(call).toBeLessThan(win.indexOf('db.transaction('));
  });

  it('the generic link is answered before the link-code lookup and never arms an advert visit', () => {
    const bot = read('src/modules/platform/telegram/bot.ts');
    const branch = bot.indexOf('if (isMijozStart(code)) {');
    expect(branch).toBeGreaterThan(-1);
    expect(branch).toBeLessThan(bot.indexOf('const link = await db.query.telegramLinks.findFirst({'));
    const body = bot.slice(branch, bot.indexOf('const link = await db.query.telegramLinks.findFirst({'));
    expect(body).not.toContain('rememberAdVisit');
    expect(body).toContain('await bareStart();');
    expect(body).toContain('reply_markup: phoneKeyboard(tg)');
  });

  it('the reminder has ONE home: the footer imports it, never restates it', () => {
    expect(helper).toContain("import { GS_REMINDER } from '../agent/seed-kb';");
    expect(helper).not.toContain('发货前请');
  });
});
