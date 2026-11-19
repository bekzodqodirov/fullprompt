import { readFileSync } from 'node:fs';
import { createTranslator } from 'next-intl';
import { describe, expect, it } from 'vitest';
import { newClientPlan, notePlan, planMessageCount, type NoteFile, type NoteHead } from '@/modules/platform/notes/plan';
import {
  CARD_CALL_DEADLINE_MS,
  CARD_RECLAIM_MINUTES,
  CARD_STEP_MAX_CALLS,
  cardStepVerdict,
  noteCardOf,
  SOURCE_UNREADABLE,
} from '@/modules/platform/notifications/note-card';
import { CONNECT_PHASE } from '@/modules/platform/telegram/staff-group-rules';
import { clientLabels } from '@/modules/platform/telegram/client-labels';
import { isMijozStart, mijozStartUrl } from '@/modules/platform/telegram/mijoz-start';
import {
  cardRecipient,
  hasLinkablePhone,
  newClientFooter,
  newClientStaffText,
} from '@/modules/wms/client-card/address-card';
import { addressFlashOf, addressWordOf } from '@/app/(protected)/admin/clients/address-flash';
import { flagShown } from '@/app/(protected)/zametkalar/flag-press';
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

  it('the reminder is left out only when the ticked notes already carry its CHINESE instruction (唛头)', () => {
    const footer = newClientFooter({ code: 'GS1', notesText: 'Har qutiga 唛头 yozing', botUrl: null });
    expect(footer).toBe('Markirovka / 唛头: GS1');
  });

  it('a passing Uzbek «markirovka» in a note keeps the reminder — the supplier reads only its Chinese half (review CUST-5)', () => {
    for (const notesText of ['MARKIROVKA: GS', 'markirovkani unutmang', 'Markirovka: GS kod']) {
      const footer = newClientFooter({ code: 'GS1', notesText, botUrl: null });
      expect(footer.split('\n'), notesText).toEqual(['Markirovka / 唛头: GS1', GS_REMINDER]);
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
  const plain = { noNote: false, noPhone: false, noBotLink: false, alreadyLinked: false } as const;

  it('the code and the client alone on the first line, the instruction under it, the card link last', () => {
    const text = newClientStaffText({
      code: 'GS777',
      name: 'Bobur aka',
      messages: 2,
      ...plain,
      cardUrl: 'https://app.example/admin/clients/1',
    });
    expect(text.split('\n')).toEqual([
      '🆕 GS777 · Bobur aka',
      'Pastdagi 2 ta xabarni belgilab mijozga forward qiling ⬇️',
      'https://app.example/admin/clients/1',
    ]);
  });

  it('the first line fits the drain’s 80-character bold title for an ordinary long name (review RG-2)', () => {
    // The drain bolds a first line of at most 80 characters (staff-html.ts
    // TITLE_MAX); the instruction once rode it and a 14-letter name pushed it past.
    const name = 'Abdurahmonov Muhammadali Olimjon o‘g‘li';
    const first = newClientStaffText({ code: 'GS10234', name, messages: 3, ...plain, cardUrl: null }).split('\n')[0]!;
    expect(first).toBe(`🆕 GS10234 · ${name}`);
    expect([...first].length).toBeLessThanOrEqual(80);
  });

  it('says the address is missing, and that the customer is already in the bot', () => {
    const text = newClientStaffText({ code: 'GS1', name: 'A', messages: 1, ...plain, noNote: true, alreadyLinked: true, cardUrl: null });
    expect(text.split('\n')).toEqual([
      '🆕 GS1 · A',
      'Pastdagi 1 ta xabarni belgilab mijozga forward qiling ⬇️',
      '⚠ Manzil zametkasi belgilanmagan — bu xabarda sklad manzili yo‘q',
      'ℹ️ Mijoz botga allaqachon ulangan',
    ]);
  });

  it('a card with no phone is told the bot link cannot connect the customer (review CUST-1)', () => {
    const text = newClientStaffText({ code: 'GS2', name: 'Ali', messages: 1, ...plain, noPhone: true, cardUrl: null });
    expect(text.split('\n')).toContain(
      '⚠ Mijoz kartasida telefon yo‘q — botdagi havola uni ulay olmaydi: raqamini kartaga yozdiring (admin)',
    );
  });

  it('a card that went without its bot line says so (review CUST-6)', () => {
    const text = newClientStaffText({ code: 'GS3', name: 'Ali', messages: 1, ...plain, noBotLink: true, cardUrl: null });
    expect(text.split('\n').some((line) => line.startsWith('⚠ Bot havolasi qo‘shilmadi'))).toBe(true);
    expect(newClientStaffText({ code: 'GS3', name: 'Ali', messages: 1, ...plain, cardUrl: null })).not.toContain('Bot havolasi');
  });
});

describe('a phone the bot could ever match — the matcher’s own rule', () => {
  it('needs an array with a number of at least seven digits; anything else is no phone', () => {
    expect(hasLinkablePhone(['+998 90 123 45 67'])).toBe(true);
    expect(hasLinkablePhone(['', '1234567'])).toBe(true);
    for (const phones of [[], [''], ['12-34'], null, undefined, '+998901234567', [998901234567], { a: 1 }]) {
      expect(hasLinkablePhone(phones), JSON.stringify(phones) ?? String(phones)).toBe(false);
    }
  });
});

describe('who gets the card (judge R14)', () => {
  const reach = (entries: Record<string, 'ok' | 'no_chat' | 'muted'>) => new Map(Object.entries(entries));

  it('the seller when the bot can reach him', () => {
    expect(cardRecipient('s', 'p', reach({ s: 'ok', p: 'ok' }))).toEqual({ to: 's', outcome: 'seller' });
  });

  it('the presser only when the seller’s Telegram is not linked', () => {
    expect(cardRecipient('s', 'p', reach({ s: 'no_chat', p: 'ok' }))).toEqual({ to: 'p', outcome: 'presser' });
    expect(cardRecipient(null, 'p', reach({ p: 'ok' }))).toEqual({ to: 'p', outcome: 'presser' });
  });

  it('a seller who MUTED it gets nothing, and his choice is never moved onto the presser', () => {
    expect(cardRecipient('s', 'p', reach({ s: 'muted', p: 'ok' }))).toEqual({ to: null, outcome: 'muted' });
    // …and the sentence never sends an unlinked presser to «📨» (third review WORDS-2).
    expect(cardRecipient('s', 'p', reach({ s: 'muted', p: 'no_chat' }))).toEqual({ to: null, outcome: 'muted_unlinked' });
    expect(cardRecipient('s', 'p', reach({ s: 'muted', p: 'muted' }))).toEqual({ to: null, outcome: 'muted' });
    expect(cardRecipient('s', 's', reach({ s: 'muted' }))).toEqual({ to: null, outcome: 'muted' });
  });

  it('nobody when nobody who could get it is reachable', () => {
    expect(cardRecipient('s', 's', reach({ s: 'no_chat' }))).toEqual({ to: null, outcome: 'nobody' });
    expect(cardRecipient(null, null, reach({}))).toEqual({ to: null, outcome: 'nobody' });
    // A presser who muted these messages can still take the card with «📨» (it goes past his mute).
    expect(cardRecipient('s', 'p', reach({ s: 'no_chat', p: 'muted' }))).toEqual({ to: null, outcome: 'nobody' });
  });

  it('a presser whose OWN Telegram is unlinked too is told so — «📨» would refuse him (review W-4)', () => {
    expect(cardRecipient('s', 'p', reach({ s: 'no_chat', p: 'no_chat' }))).toEqual({ to: null, outcome: 'unlinked' });
    // Never about his own card: the seller who pressed is `nobody`, said in the second person.
    expect(cardRecipient('s', 's', reach({ s: 'no_chat' })).outcome).toBe('nobody');
  });
});

describe('which sentence a door says (review W-1, W-4)', () => {
  it('to the seller HIMSELF when he is the one who pressed — never «Sotuvchi …» about his own switch', () => {
    expect(addressWordOf('muted', true)).toBe('addressSelfMuted');
    expect(addressWordOf('nobody', true)).toBe('addressSelfNobody');
    expect(addressWordOf('muted', false)).toBe('addressMuted');
    expect(addressWordOf('nobody', false)).toBe('addressNobody');
  });

  it('a presser unlinked too is sent to his own Profile, not to «📨»; the usual way says nothing', () => {
    expect(addressWordOf('unlinked', false)).toBe('addressNobodyUnlinked');
    expect(addressWordOf('muted_unlinked', false)).toBe('addressMutedUnlinked');
    expect(addressWordOf('muted_unlinked', true)).toBe('addressSelfMuted');
    expect(addressWordOf('presser', false)).toBe('addressPresser');
    expect(addressWordOf('failed', true)).toBe('addressFailed');
    for (const quiet of ['seller', undefined, null, 'x']) expect(addressWordOf(quiet, false)).toBeNull();
  });

  it('the won dialog and the client card’s flash both say it through the one chooser, with the presser’s own answer', () => {
    const won = read('src/components/won-dialog.tsx');
    expect(won).toContain("addressWordOf(result.addressCard, result.addressCardSelf === true)");
    const button = read('src/app/(protected)/admin/clients/address-card-button.tsx');
    expect(button).toContain('const flashWord = addressWordOf(flash, self);');
    const page = read('src/app/(protected)/admin/clients/[id]/page.tsx');
    expect(page).toContain('self={client.salesManagerId === actor.id}');
    const crm = read('src/modules/wms/crm/service.ts');
    expect(crm).toContain('addressCardSelf: sellerId === ctx.actorId');
    expect(crm).toContain('salesManagerId: sellerId,');
  });
});

describe('the outcome’s sentences, in all four bundles', () => {
  const bundles = Object.fromEntries(
    ['uz', 'ru', 'zh-CN', 'en'].map((locale) => [locale, JSON.parse(readFileSync(`messages/${locale}.json`, 'utf8'))]),
  ) as Record<string, Record<string, unknown>>;
  const KEYS = [
    'quick.addressPresser',
    'quick.addressMuted',
    'quick.addressNobody',
    'quick.addressNobodyUnlinked',
    'quick.addressMutedUnlinked',
    'quick.addressFailed',
    'quick.addressSelfMuted',
    'quick.addressSelfNobody',
    'clients.addressInactive',
    'notes.errors.failed',
  ];

  it('every one formats (ICU-valid) and every outcome has words of its own', () => {
    for (const [locale, messages] of Object.entries(bundles)) {
      const t = createTranslator({
        locale,
        messages: messages as never,
        onError: (error) => {
          throw error;
        },
      }) as unknown as (key: string) => string;
      const said = KEYS.map((key) => t(key));
      for (const [i, line] of said.entries()) {
        expect(line.trim(), `${locale} ${KEYS[i]}`).not.toBe('');
        expect(line, `${locale} ${KEYS[i]}`).not.toContain(KEYS[i]!);
      }
      expect(new Set(said).size, locale).toBe(KEYS.length);
    }
  });

  it('the presser and the muted cause are no longer one merged sentence (review P1-DOORS-2 / R14)', () => {
    const quick = bundles.uz!.quick as Record<string, string>;
    expect(quick.addressPresser).not.toContain('o‘chirgan');
    expect(quick.addressMuted).toContain('o‘chirgan');
    // The «+» speaks to the seller himself (CUST-8).
    expect(quick.addressSelfNobody).toContain('Telegramingiz');
    expect(quick.addressNobody).toContain('Sotuvchining');
    // W-4: a muted seller's card is still the presser's to take with «📨»; an
    // unlinked presser is sent to his own Profile FIRST — and then told the
    // step after it (third review WORDS-3), for both causes (WORDS-2).
    expect(quick.addressMuted).toContain('«📨 Manzil xabarini menga yuborish»');
    for (const unlinked of [quick.addressNobodyUnlinked!, quick.addressMutedUnlinked!]) {
      expect(unlinked).toContain('Sizning Telegramingiz ham ulanmagan — avval Profil → Telegram');
      expect(unlinked.indexOf('Profil → Telegram')).toBeLessThan(unlinked.indexOf('📨'));
      expect(unlinked).toContain('keyin');
    }
    expect(quick.addressMutedUnlinked).toContain('o‘chirgan');
    // W-3: a checkbox that did not save says «try again», never «check the fields».
    const notes = bundles.uz!.notes as { errors: Record<string, string> };
    expect(notes.errors.failed).not.toBe(notes.errors.validation);
    expect(notes.errors.failed).toContain('qaytadan urinib ko‘ring');
  });
});

describe('?manzil= — read as one of the closed set or as nothing', () => {
  it('accepts the six outcomes the full form can redirect with', () => {
    for (const word of ['presser', 'muted', 'muted_unlinked', 'nobody', 'unlinked', 'failed'] as const) {
      expect(addressFlashOf(word)).toBe(word);
    }
  });

  it('draws nothing for anything else — the seller outcome, a typo, a repeated param', () => {
    for (const raw of ['seller', 'NOBODY', '', 'x', undefined, null, ['nobody']]) expect(addressFlashOf(raw)).toBeNull();
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

describe('the 🆕 press is tied to the row’s revision, never to the boolean (review W-2)', () => {
  it('stands while the row is the one it was pressed against, and never comes back to life', () => {
    const press = { want: true, at: 'r1' };
    // Pressed, the round trip in flight: the box shows the press.
    expect(flagShown({ forNewClient: false, updatedAt: 'r1' }, press)).toBe(true);
    // The success refresh: the row moved — the server's value from here on.
    expect(flagShown({ forNewClient: true, updatedAt: 'r2' }, press)).toBe(true);
    // «Shaxsiy qilish» cleared the flag, then «Hammaga» shared it again — unticked,
    // although the server is back at the value the press was made against.
    expect(flagShown({ forNewClient: false, updatedAt: 'r3' }, press)).toBe(false);
    expect(flagShown({ forNewClient: false, updatedAt: 'r4' }, press)).toBe(false);
    // A colleague unticked it in another tab.
    expect(flagShown({ forNewClient: false, updatedAt: 'r5' }, { want: true, at: 'r2' })).toBe(false);
    // No press: the server.
    expect(flagShown({ forNewClient: true, updatedAt: 'r1' }, undefined)).toBe(true);
  });
});

describe('the card’s short reclaim (review FR1-1)', () => {
  it('outlasts the longest a LIVE drain is silent on one step, and is shorter than the drain’s ten minutes', () => {
    expect(CARD_STEP_MAX_CALLS).toBe(3);
    expect(CARD_RECLAIM_MINUTES * 60_000).toBeGreaterThan(CARD_CALL_DEADLINE_MS * CARD_STEP_MAX_CALLS);
    expect(CARD_RECLAIM_MINUTES).toBeLessThan(10);
    // The sender's deadline IS the one the window is measured against.
    expect(read('src/modules/platform/telegram/note-send.ts')).toContain('const SEND_TIMEOUT_MS = CARD_CALL_DEADLINE_MS;');
  });
});

describe('the drain’s cursor rules', () => {
  it('reads a card off a row, and refuses a row of another shape', () => {
    expect(
      noteCardOf({ card: { steps: [{ kind: 'text', text: 'a' }], done: 2, head: 5, ids: [5, 6], maybe: [1], skipped: [2] } }),
    ).toEqual({
      steps: [{ kind: 'text', text: 'a' }],
      done: 2,
      head: 5,
      ids: [5, 6],
      maybe: [1],
      skipped: [2],
    });
    // A row queued before FR1-4 carries no `skipped`: nothing was stepped over.
    expect(noteCardOf({ card: { steps: [] } })).toEqual({ steps: [], done: 0, head: null, ids: [], maybe: [], skipped: [] });
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

  it('our own file that could not be read is retried — nothing can be in the chat (review P1-DLV-2)', () => {
    const verdict = (description: string) => cardStepVerdict({ status: 0, description, retryAfter: null, botDown: false });
    expect(verdict(`${SOURCE_UNREADABLE} sklad.jpg (staff_note/n/1): ENOENT ENOENT: no such file or directory`)).toBe('retry');
    // A reset to MinIO reads «ECONNRESET» like a cut Telegram answer; the tag decides, not the words after it.
    expect(verdict(`${SOURCE_UNREADABLE} sklad.jpg (staff_note/n/1): ECONNRESET socket hang up`)).toBe('retry');
    // …and the shared connect-phase rule is untouched: the same reset from Telegram stays ambiguous.
    expect(verdict('socket hang up ECONNRESET')).toBe('ambiguous');
    expect(CONNECT_PHASE.source).toBe('\\b(ENOTFOUND|EAI_AGAIN|ECONNREFUSED|EHOSTUNREACH|ENETUNREACH|UND_ERR_CONNECT_TIMEOUT)\\b');
    // P1-DLV-5: the export reads as the house writes an assignment.
    expect(read('src/modules/platform/telegram/staff-group-rules.ts')).toContain('export const CONNECT_PHASE = /\\b(');
  });
});

describe('the customer who taps the bot line', () => {
  it('reads ONE greeting that ends in the phone request — never askPhone’s own hello after a welcome (review CUST-4)', () => {
    for (const locale of ['uz', 'ru', 'en'] as const) {
      const t = clientLabels(locale);
      const hello = { uz: 'Assalomu alaykum', ru: 'Здравствуйте', en: 'Hello' }[locale];
      expect(t.mijozStart.split(hello).length - 1, locale).toBe(1);
      expect(t.mijozStart.startsWith(hello), locale).toBe(true);
      expect(t.mijozStart, locale).not.toContain(t.askPhone);
    }
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
    // ONE message (review CUST-4): the greeting alone, never askPhone glued on.
    expect(body).toContain('await ctx.reply(clientLabels(tg).mijozStart, { reply_markup: phoneKeyboard(tg) });');
    expect(body).not.toContain('askPhone');
    // The contact it asks for is the cabinet's (review CUST-2): an earlier
    // advert visit and an earlier «Hodim» press are forgotten FIRST.
    const ask = body.indexOf('await ctx.reply(clientLabels(tg).mijozStart');
    expect(body.indexOf('clearAdVisit(ctx.chat.id);')).toBeGreaterThan(body.indexOf('await bareStart();'));
    expect(body.indexOf('clearAdVisit(ctx.chat.id);')).toBeLessThan(ask);
    expect(body.indexOf('dropStaffEntry(chatId);')).toBeGreaterThan(body.indexOf('await bareStart();'));
    expect(body.indexOf('dropStaffEntry(chatId);')).toBeLessThan(ask);
  });

  it('the screens: the flash steps aside once the button answers, the 🆕 tick answers at once, the AI link opens the knowledge', () => {
    const button = read('src/app/(protected)/admin/clients/address-card-button.tsx');
    // CUST-7: «went nowhere» never stands over «✅ Yuborildi».
    expect(button).toContain('{flashWord && said === null && (');
    const page = read('src/app/(protected)/admin/clients/[id]/page.tsx');
    // P1-DOORS-4: no resend button on a deactivated code; the flash read from the closed set.
    expect(page).toContain('{client.active && (\n        <AddressCardButton clientId={client.id} flash={addressFlash}');
    expect(page).toContain('const addressFlash = addressFlashOf(manzil);');
    const list = read('src/app/(protected)/zametkalar/note-list.tsx');
    // CUST-9: the box shows the press until the round trip lands, and a refusal takes it back —
    // the press tied to the row's revision (W-2, `flag-press.ts`), never to the boolean.
    expect(list).toContain('checked={flagShown(note, pressed[note.id])}');
    expect(list).toContain('setPressed((all) => ({ ...all, [note.id]: { want: on, at: note.updatedAt } }));');
    // W-3: the request that failed has words of its own.
    expect(list).toContain("failed: t('errors.failed'),");
    expect(read('src/app/(protected)/zametkalar/page.tsx')).toContain('updatedAt: row.updatedAt.toISOString(),');
    const refused = list.slice(list.indexOf('const res = await setNewClientFlagAction(note.id, on)'), list.indexOf('if (on) setDrift(true);'));
    expect(refused).toContain('if (res.error) {');
    expect(refused).toContain('delete rest[note.id];');
    // WORDS-4: a «failed» that may still have committed re-reads the page — the box then says what the server holds.
    expect(refused).toMatch(/setRowError\(\{ id: note\.id, code: res\.error \}\);[\s\S]*router\.refresh\(\);\s*return;/);
    // CUST-3: the knowledge tab, not the page's default section.
    expect(list).toContain('href="/suhbatlar/ai?bolim=bilimlar"');
    // CUST-8: the «+» says it TO the seller, who is the presser there.
    const quick = read('src/components/quick-create.tsx');
    expect(quick).toContain("t('addressSelfNobody')");
    expect(quick).toContain("t('addressSelfMuted')");
    expect(quick).not.toContain("t('addressNobody')");
  });

  it('the reminder has ONE home: the footer imports it, never restates it', () => {
    expect(helper).toContain("import { GS_REMINDER } from '../agent/seed-kb';");
    expect(helper).not.toContain('发货前请');
  });
});
