import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';
import { buttonsFor, parseCallback } from '@/modules/platform/telegram/staff-bot';
import { cardAsks, cardExtra } from '@/modules/wms/agent/card';
import { ANSWER_STATUS_LINE, ANSWER_TAKEN_LINE, FROM_ANSWER_LINE, answeredNow, renderDraftCard, type DraftRow } from '@/modules/wms/agent/card-io';
import { extractNumbers, numberLedger, ownerAnswerSources, phonesIn, type NumberSource } from '@/modules/wms/agent/numbers';
import { ANSWER_CONTACT_WORDS, answerContactWords, answerHoldsFigure, answerTextRefusal, ownerAnswerInstruction } from '@/modules/wms/agent/owner-answer';
import { foreignPhones } from '@/modules/wms/agent/policy';
import { answerNoDraftWhy } from '@/modules/wms/agent/owner-answer-job';
import { stableHead } from '@/modules/wms/agent/prompt';
import { memoryFor, withAviaGuard, withRailRule, type ComposeReply, type RunResult } from '@/modules/wms/agent/run';
import type { AgentContext, ChatMessage } from '@/modules/wms/agent/context';

/**
 * «Bilmayman» → he answers the FACT → the AI writes the customer's words (spec SPEC-P1-v2 §2) — the pure rules: his
 * answer as a source and nothing more, what the bot refuses to take, the instruction, the card's button and lines,
 * and every way a redraft can fail being said.
 */

const ID = '0f1e2d3c-4b5a-4968-8776-655443322110';

function compose(over: Partial<ComposeReply> = {}): ComposeReply {
  return {
    replyNeeded: true,
    replyText: 'Aniqlab aytaman.',
    language: 'uz',
    glossUz: '',
    category: 'other',
    confidence: 0.5,
    needsOwner: false,
    ownerQuestion: '',
    nextStep: 'wait',
    actions: [],
    usedFactIds: [],
    citedMessageRefs: [],
    ...over,
  };
}

function msg(body: string): ChatMessage {
  return {
    ref: '#1',
    id: '00000000-0000-4000-8000-000000000001',
    tgMessageId: 1n,
    direction: 'in',
    body,
    media: null,
    fileName: null,
    sentAt: new Date(),
    autoSent: false,
    editedAt: null,
  };
}

function draft(over: Partial<DraftRow> = {}): DraftRow {
  return {
    id: ID,
    runId: null,
    managerUserId: '00000000-0000-4000-8000-0000000000aa',
    peerId: 1n,
    clientId: null,
    leadId: null,
    identityStrength: null,
    anchorTgMessageId: 1n,
    anchorEditedAt: null,
    kind: 'reply',
    status: 'pending',
    proposedBody: 'Aniqlab aytaman.',
    finalBody: null,
    glossUz: null,
    language: 'uz',
    category: 'other',
    confidence: '0.50',
    nextStep: 'wait',
    policy: { blocks: [], warnings: [], ledger: [], notes: [], card: { customerLabel: 'GS1 · Ali', lastOut: null, customerLines: [] } },
    blocked: false,
    needsOwner: true,
    ownerQuestion: 'Suyuqlik olamizmi?',
    actions: [],
    citedMessageIds: [],
    offerId: null,
    ...over,
  } as DraftRow;
}

function ctxWith(body: string): AgentContext {
  const m = msg(body);
  return {
    managerUserId: 'u',
    peerId: 1n,
    messages: [m],
    history: [m],
    anchor: m,
    burst: [m],
    lastOut: null,
    identity: { clientId: null, leadId: 'l', strength: 'lead', codes: [], customerName: null, managerName: null, cargoAllowed: false },
    storedLocale: null,
    customerScript: 'latin',
    measures: [],
    openCalcs: [],
    lastQuote: null,
    ruleDecision: null,
  };
}
const usage = { inputTokens: 0, outputTokens: 0, cacheReadTokens: 0, cacheWriteTokens: 0 };

describe('his answer is a source, read as a fact is — for one redraft (spec §2.2)', () => {
  const ledger = (reply: string, answer: string) => numberLedger(reply, ownerAnswerSources(answer));

  it('a money figure with its currency WRITTEN vouches for the same money, as a total — and names him', () => {
    const [line] = ledger('Narxi taxminan 1200 $.', 'VED 1200$ hisobladi, mijozga ayting');
    expect(line).toMatchObject({ kind: 'money', origin: 'owner', role: 'total', source: 'sizning javobingiz' });
  });

  it('…said per unit it is a rate, and vouches for a rate only', () => {
    const src = ownerAnswerSources('kilosiga 17 $ dan');
    expect(src.find((s) => s.kind === 'money')).toMatchObject({ value: 17, role: 'rate', currency: 'USD', origin: 'owner' });
  });

  it('a bare «narxi 1200» with no currency written vouches for no price', () => {
    const src = ownerAnswerSources('narxi 1200');
    expect(src.every((s: NumberSource) => s.kind !== 'money')).toBe(true);
    expect(ledger('Narxi 1200 $.', 'narxi 1200')[0]).toMatchObject({ source: null });
  });

  it('a day count of his vouches for the same day count (the company speaking) — the gate then sees `owner`', () => {
    const [line] = ledger('Taxminan 3 kunda tayyor bo‘ladi.', 'VED 3 kunda hisoblaydi');
    expect(line).toMatchObject({ kind: 'duration', origin: 'owner' });
  });

  it('a house number in his answer never vouches for a day count (the kb plain-figure fence, §2.2)', () => {
    expect(ledger('Taxminan 29 kunda yetib keladi.', 'Ombor 29-uyda')[0]).toMatchObject({ source: null });
  });
});

describe('the redraft’s memory carries his answer as SOURCES and nothing else (§2.2)', () => {
  const loop = { compose: compose(), tools: [], outcomes: [], usage };

  it('his figures are in the stored sources, origin «owner» — so his ✅ and the press re-run the policy on them', () => {
    const memory = memoryFor(ctxWith('Atir olib kelasizmi?'), loop, [], 'gsr-t', 'VED 1200 $ hisobladi, 3 kunda tayyor');
    const mine = memory.sources.filter((s) => s.origin === 'owner');
    expect(mine.map((s) => [s.kind, s.value])).toEqual([
      ['money', 1200],
      ['duration', 3],
    ]);
    // …and a run with no answer carries none.
    expect(memoryFor(ctxWith('Atir olib kelasizmi?'), loop, [], 'gsr-t').sources.some((s) => s.origin === 'owner')).toBe(false);
  });

  it('it adds no phone, no link, no name and no Chinese text a reply may carry — an address is his ✏️ text', () => {
    const plain = memoryFor(ctxWith('Ombor qayerda?'), loop, [], 'gsr-t');
    const withAnswer = memoryFor(ctxWith('Ombor qayerda?'), loop, [], 'gsr-t', 'Tel +998 90 123 45 67, https://example.com/x, 义乌市 稠州北路, Shahzod aka biladi');
    expect(withAnswer.allowedPhones).toEqual(plain.allowedPhones);
    expect(withAnswer.allowedUrls).toEqual(plain.allowedUrls);
    expect(withAnswer.mapUrls).toEqual(plain.mapUrls);
    expect(withAnswer.quotableHan).toEqual(plain.quotableHan);
    expect(withAnswer.factNameWords).toEqual(plain.factNameWords);
  });

  it('in a rail chat his money is no source — rail’s price is his ✏️ text — while his day count still is', () => {
    const memory = memoryFor(ctxWith("Temir yo'l bilan qancha bo'ladi?"), loop, [], 'gsr-t', 'Temir yo‘l 900 $, 25 kunda');
    const mine = memory.sources.filter((s) => s.origin === 'owner');
    expect(memory.rail).toBe(true);
    expect(mine.some((s) => s.kind === 'money')).toBe(false);
    expect(mine.some((s) => s.kind === 'duration' && s.value === 25)).toBe(true);
  });
});

describe('«javobingizda raqam bo‘lsa — karta» is asked of HIS words, never of who the ledger says vouched (0148 fix, his Q2 a ⭐)', () => {
  it.each([
    // The review's three: a figure the customer also wrote, a price the redraft may swap for the tool's, a day count.
    '300 kg dan kam yukni olmaymiz',
    'Ha, 700$ ga qilib beramiz',
    'VED 3 kunda hisoblaydi',
    // …and every other way a number is written: in words, with its ending, vague, in another script.
    'Uch kunda hisoblaymiz',
    'Besh yuz dollarga qilib beramiz',
    'Mingga yaqin chiqadi',
    'Ikkita omborimiz bor',
    'Bir haftada keladi',
    'Примерно двадцать дней',
    'Около пятисот',
    'About a grand',
    'حدود بیست روز',
    '۳ روز',
    'Yarim narxiga',
  ])('«%s» holds a figure', (text) => {
    expect(answerHoldsFigure(text)).toBe(true);
  });

  // Fix pass 3: the number ONE in words — every language leaves «one» out of its numerals (beside a cube it is the
  // article as often as a count), and his «Bir kubdan kam yukni olmaymiz» is the company's truck minimum: the redraft
  // «Ha, 1 kub yukingizni bemalol olib kelamiz» turned it round and went by itself. In HIS answer one beside what it
  // counts is a figure, and the half too.
  it.each([
    'Bir kubdan kam yukni olmaymiz',
    'Bitta karobkani olmaymiz',
    'Bittadan ortiq olmaymiz',
    'Bir tonnagacha olamiz',
    'Бир кубдан кам юк олмаймиз',
    'Битта коробкани олмаймиз',
    'Меньше одного куба не берём',
    'Нет, один не берём',
    'Одну коробку не берём',
    'Полкуба берём',
    'We do not take less than one cube',
    'Less than a single box we do not take',
    'کمتر از یک متر مکعب نمی‌گیریم',
    'Yarimta',
    'Yarim kub ham olamiz',
    'Half a cube is fine',
  ])('«%s» holds a figure — one, or a half, in words', (text) => {
    expect(answerHoldsFigure(text)).toBe(true);
  });

  it.each([
    'Ha, suyuqlik olmaymiz',
    'Yo‘q, batareya olmaymiz',
    'Ha, olamiz',
    'Да, принимаем',
    'Hozircha yo‘q, keyinroq aytaman',
    // «bir» as the article, beside nothing it counts.
    'Bir narsa aytaman: suyuqlik olmaymiz',
    'Bir oz kuting, aniqlab aytaman',
    'Да, это одна из наших услуг',
    'Yes, one of our managers will call',
    'Полностью согласен, принимаем',
  ])(
    '«%s» holds none — such an answer may go by itself',
    (text) => {
      expect(answerHoldsFigure(text)).toBe(false);
    },
  );

  it('the redraft’s mark carries it and the question’s own edit stamp — written where the redraft is (run `fromAnswer`)', () => {
    const src = readFileSync('src/modules/wms/agent/run.ts', 'utf8');
    expect(src).toMatch(/figures: answerHoldsFigure\(answer\.text\)/u);
    expect(src).toMatch(/questionAnchorEditedAt: answer\.questionAnchorEditedAt\?\.toISOString\(\) \?\? null/u);
    // …and the job hands the QUESTION draft's stamp, never the redraft's.
    expect(readFileSync('src/modules/wms/agent/owner-answer-job.ts', 'utf8')).toMatch(/questionAnchorEditedAt: q\.anchorEditedAt/u);
    // …and when the QUESTION was drafted — what the rest of its burst is compared with (fix pass 3).
    expect(src).toMatch(/questionDraftedAt: answer\.questionDraftedAt\?\.toISOString\(\) \?\? null/u);
    expect(readFileSync('src/modules/wms/agent/owner-answer-job.ts', 'utf8')).toMatch(/questionDraftedAt: q\.createdAt/u);
  });
});

describe('what the bot refuses to take as an answer (§2.2 — an address or a phone is his ✏️ text)', () => {
  it('a phone, a link, Chinese text: refused in words', () => {
    for (const text of ['Telefoni +998 90 123 45 67', 'https://example.com/manzil', '义乌市 稠州北路 2255号']) {
      expect(answerTextRefusal(text)?.code, text).toBe('contact');
    }
    expect(ANSWER_CONTACT_WORDS).toContain('✏️');
  });

  it('a plain fact is taken', () => {
    expect(answerTextRefusal('Ha, suyuqlik olmaymiz')).toBeNull();
    expect(answerTextRefusal('VED 1200$ hisobladi')).toBeNull();
  });

  /**
   * The review of 0148 as built (bot lens): §2.2 expects him to answer with MONEY and DAYS — its own example is a
   * price — and «a phone» was any nine digits joined by spaces, dashes or dots, so two figures of a range, a sum in
   * so'm or a date read as one phone and the fact was refused with a sentence about an address he never wrote. The
   * review's six first, then their neighbours.
   */
  it.each([
    "Rastamojka taxminan 10000-12000 dollar bo'ladi",
    "Yetkazib berish 100 000 - 150 000 so'm",
    '9000-10000 dollar',
    "120 000 000 so'm",
    'Yuk 20.11.2026-25.11.2026 orasida keladi',
    'Yuk 15.11.2026 10:00 da keladi',
    // …the neighbours: the currency before, glued, other currencies and scripts, a dotted thousand, measures and counts.
    'Narxi $10000-12000 atrofida',
    'Rastamojka 10000-12000$',
    'Растаможка примерно 100 000 - 150 000 сум',
    'Тахминан 10000-12000 доллар бўлади',
    '120 000 000 сўм',
    "150.000.000 so'm atrofida",
    "Jami 1 250 000 000 so'm",
    'Bir oyda 10000-15000 kg olib kelamiz',
    'Zavod 10000-12000 dona chiqaradi',
    'Yuk 20.11.2026 - 25.11.2026 kunlari keladi',
    'Yuk 05.12.2026 14:30 da yetib keladi, 06.12.2026 09:00 dan olib ketsa bo‘ladi',
    'Reys 15.11.2026 da, keyingisi 22.11.2026 da',
    // …other spellings: a hard space between the thousands, spaced thousands in a range, every currency a reply
    // may name, another script's digits, a cube and a percent.
    '120\u00a0000\u00a0000 so‘m',
    '10 000-12 000 dollar',
    'Narxi 10000-12000 USD',
    '10000-12000 yuan bo‘ladi',
    'هزینه ۱۰۰۰۰-۱۲۰۰۰ دلار است',
    '10000-12000 у.е.',
    '100 000-150 000 рублей',
    '10000-12000 евро',
    'Bir oyda 10000-12000 kub',
    'Muddat: 01.12.2026-15.12.2026.',
  ])('money, a measure or a day is a FACT, never a contact: «%s»', (text) => {
    expect(answerTextRefusal(text), JSON.stringify(phonesIn(text))).toBeNull();
    expect(phonesIn(text)).toEqual([]);
  });

  it.each([
    ['Telefoni +998 90 123 45 67', '+998 90 123 45 67'],
    ['Telefoni 90 123 45 67', '90 123 45 67'],
    ['Telefoni 901234567', '901234567'],
    ['Telefoni 90-123-45-67', '90-123-45-67'],
    ['Telefon (90) 123-45-67', '90) 123-45-67'],
    ['Tel 8 (495) 123-45-67', '8 (495) 123-45-67'],
    ['Xitoydagi raqami 13800138000', '13800138000'],
    ['+86 138 0013 8000 ga yozsin', '+86 138 0013 8000'],
    ['998901234567 ga qo‘ng‘iroq qilsin', '998901234567'],
    // A card number and a tracking number are no fact for the AI to retype either.
    ['Karta 8600 1234 5678 9012', '8600 1234 5678 9012'],
    ['Trek raqami 773812345678', '773812345678'],
    // A phone beside a date, a price or a unit is still a phone: only an AMOUNT's own shape with its unit is not.
    ['Tel 901234567, 15.11.2026 dan keyin', '901234567'],
    ['Telefon 901234567 kun bo‘yi ishlaydi', '901234567'],
    ['Telefoni 901234567 ta xodimda bor', '901234567'],
    ['+998901234567 dollar masalasida', '+998901234567'],
    ['90 123 45 67 dollar masalasida', '90 123 45 67'],
    ['901-234-567 kg', '901-234-567'],
    // …and digits with NO unit beside them are nobody's amount: he is told what was read and how to say it.
    ['Narxi 9000-10000', '9000-10000'],
    ['Narxi 120 000 000', '120 000 000'],
    // A range runs up: «90123-4567 dollar» is no range.
    ['90123-4567 dollar', '90123-4567'],
    // A phone beside a fact is still the phone: each run is judged on its own.
    ['Tel 90 123 45 67 dan 10000-12000 dollar so‘rang', '90 123 45 67'],
    ['25.11.2026 14:00 da, tel 901234567', '901234567'],
  ])('…while «%s» is still refused — and the words name what was read', (text, read) => {
    const refused = answerTextRefusal(text);
    expect(refused).toEqual({ code: 'contact', what: 'phone', read });
    const words = answerContactWords(refused!);
    expect(words).toContain(`«${read}»`);
    expect(words).toContain('✏️');
    // …and the way out for a fact that is no phone: its unit beside it.
    expect(words).toMatch(/birligi/u);
  });

  it('a link and Chinese text are named as what they are', () => {
    expect(answerTextRefusal('Manzil: https://example.com/manzil')).toEqual({ code: 'contact', what: 'link', read: 'https://example.com/manzil' });
    expect(answerContactWords(answerTextRefusal('Manzil: https://example.com/manzil')!)).toContain('havola');
    expect(answerTextRefusal('义乌市 稠州北路 2255号')).toMatchObject({ code: 'contact', what: 'han' });
    expect(answerContactWords(answerTextRefusal('义乌市 稠州北路 2255号')!)).toContain('xitoycha');
  });

  it('the fact he was allowed to state reaches the redraft as SOURCES — the same reader on both sides (numbers `phonesIn`)', () => {
    // What is no phone at the door is no phone to the figure reader, or the redraft quoting it could never keep its ✅.
    expect(ownerAnswerSources("Rastamojka taxminan 10000-12000 dollar bo'ladi")).toEqual([
      expect.objectContaining({ value: 10000, kind: 'money', origin: 'owner' }),
      expect.objectContaining({ value: 12000, kind: 'money', origin: 'owner' }),
    ]);
    expect(ownerAnswerSources("Yetkazib berish 100 000 - 150 000 so'm").map((s) => [s.value, s.kind])).toEqual([
      [100000, 'money'],
      [150000, 'money'],
    ]);
    // The day is read as a day (its hour as a time always was: one plain figure) — before, both were blanked as a phone.
    expect(extractNumbers('Yuk 15.11.2026 10:00 da keladi').map((f) => [f.raw, f.kind])).toEqual([
      ['15.11.2026', 'date'],
      ['10:00', 'plain'],
    ]);
    // A whole dd.mm.yyyy is a date whatever word follows (fix pass 3): «15.11.2026 kuni» read as 15.11 and a duration
    // of 2026 days — «kuni» is «day» — so his answer lent no date and the reply naming it was blocked «2026».
    for (const said of ['Yuk 15.11.2026 kuni keladi', 'Yuk 20.11.2026 – 25.11.2026 kunlari keladi', 'Груз будет 15.11.2026 дня', 'Arrives on 15.11.2026 day one']) {
      expect(
        extractNumbers(said)
          .filter((f) => f.kind === 'date')
          .map((f) => f.raw),
        said,
      ).toEqual(said.match(/\d{2}\.\d{2}\.\d{4}/gu));
    }
    // …while «1.50 kg» stays a weight, never the first of May.
    expect(extractNumbers('Yukingiz 1.50 kg').map((f) => f.kind)).toEqual(['measure']);
    // …and to G6: a reply that repeats his range is not «another's phone» — its figures are G1's to hold.
    expect(foreignPhones("Rastamojka taxminan 10000-12000 dollar bo'ladi", [])).toEqual([]);
    expect(foreignPhones('Yuk 20.11.2026-25.11.2026 orasida keladi', [])).toEqual([]);
    // A phone stays G6's in every spelling, and is never read as a figure.
    for (const phone of ['+998 90 123 45 67', '90 123 45 67', '901234567', '90-123-45-67', '8600 1234 5678 9012']) {
      expect(foreignPhones(`Tel: ${phone}`, []), phone).toEqual([phone]);
      expect(extractNumbers(`Tel: ${phone}`), phone).toEqual([]);
    }
  });
});

describe('the redraft’s instruction (§2.2, judge learn)', () => {
  it('quotes his words verbatim and names them a source', () => {
    const text = 'Ha, suyuqlik olmaymiz — faqat quruq yuk';
    const i = ownerAnswerInstruction(`  ${text}  `);
    expect(i).toContain(`«${text}»`);
    expect(i).toMatch(/^Bekzodning javobi \(manba/u);
  });

  it('the AI’s own question rides beside it — his «Ha» answers THAT sentence — after his words, named as no source, clipped', () => {
    const i = ownerAnswerInstruction('Ha, olamiz', 'Mijoz shisha idish yubormoqchi —\n mo‘rt yuk olamizmi?');
    expect(i).toMatch(/^Bekzodning javobi \(manba — undagi raqamni o'zgartirmay ishlat\): «Ha, olamiz»\./u);
    expect(i).toContain('(savol manba emas, undagi sonni ishlatma): «Mijoz shisha idish yubormoqchi — mo‘rt yuk olamizmi?»');
    expect(i.indexOf('«Ha, olamiz»')).toBeLessThan(i.indexOf('savol manba emas'));
    // No question (a draft from before the round, an empty one): the answer alone, as before.
    expect(ownerAnswerInstruction('Ha, olamiz', '  ')).toBe(ownerAnswerInstruction('Ha, olamiz'));
    expect(ownerAnswerInstruction('Ha, olamiz')).not.toContain('savol manba emas');
    const long = ownerAnswerInstruction('Ha', 'x'.repeat(2000));
    expect(long.length).toBeLessThan(800);
    expect(long).toContain('…»');
  });

  it('prompt rule 1 says the task’s answer is a source too — in the cached head, once', () => {
    const head = stableHead({ styleGuide: null, facts: [], priceArmed: false, lessons: [] });
    expect(head.match(/VAZIFAdagi Bekzodning javobi ham manba/gu)?.length).toBe(1);
  });
});

describe('«✍️ Savolga javob» on the card (§2.2)', () => {
  it('a question the MODEL raised offers it, first, and its callback parses', () => {
    const rows = buttonsFor('AgentDraft', { draftId: ID, digest: 'a1b2c3d4', live: true, blocked: false, kind: 'reply', ask: true });
    expect(rows![0]).toEqual([{ text: '✍️ Savolga javob', callback_data: `ag:j:${ID}` }]);
    expect(parseCallback(`ag:j:${ID}`)).toEqual({ kind: 'agent', op: 'j', id: ID });
    expect(parseCallback(`ag:q:${ID}`)).toBeNull();
  });

  it('…no question, a dead card, or a forced one: none', () => {
    const plain = buttonsFor('AgentDraft', { draftId: ID, digest: 'a1b2c3d4', live: true, blocked: false, kind: 'reply', ask: false });
    expect(JSON.stringify(plain)).not.toContain('ag:j:');
    expect(cardExtra({ id: ID, body: 'x', actions: [], blocked: false, live: false, kind: 'reply', ask: true }).ask).toBe(false);
    expect(cardAsks(draft())).toBe(true);
    expect(cardAsks(draft({ needsOwner: false }))).toBe(false);
    expect(cardAsks(draft({ status: 'approved' }))).toBe(false);
    expect(cardAsks(draft({ policy: { ...(draft().policy as object), forcedQuestion: 'rail' } }))).toBe(false);
    expect(cardAsks(draft({ policy: { ...(draft().policy as object), forcedQuestion: 'avia' } }))).toBe(false);
  });

  it('…and only on a REPLY: a hand-back’s or a price draft’s question is his ✏️ (the redraft would lose what it was made of)', () => {
    expect(cardAsks(draft({ kind: 'hand_back' }))).toBe(false);
    expect(cardAsks(draft({ kind: 'price' }))).toBe(false);
    expect(cardAsks(draft({ status: 'editing' }))).toBe(true);
  });

  it('the avia guard records that it forced the question — and a rail question forced first keeps its name', () => {
    const blocked = { blocks: [{ rule: 'G4', code: 'avia_address' }] } as Parameters<typeof withAviaGuard>[1];
    const ctx = { burst: [msg('Avia bilan 40 kg yubormoqchiman')], messages: [msg('Avia bilan 40 kg yubormoqchiman')], measures: [], lastQuote: null };
    const loop = { tools: [], outcomes: [] };
    const forced = withAviaGuard(compose({ replyText: 'Manzil: …' }), blocked, loop, ctx);
    expect(forced).toMatchObject({ needsOwner: true, forcedQuestion: 'avia' });
    const railFirst = withAviaGuard(compose({ needsOwner: true, forcedQuestion: 'rail', ownerQuestion: 'Temir yo‘l narxi?' }), blocked, loop, ctx);
    expect(railFirst.forcedQuestion).toBe('rail');
    // No avia block: nothing forced, the model's own question stays the model's.
    const own = withAviaGuard(compose({ needsOwner: true, ownerQuestion: 'Suyuqlik olamizmi?' }), { blocks: [] }, loop, ctx);
    expect(own.forcedQuestion).toBeUndefined();
  });

  it('the rail rule records that it FORCED the question; the model’s own question carries no mark', () => {
    const forced = withRailRule(compose(), { burst: [msg("Temir yo'l bilan qancha bo'ladi?")] });
    expect(forced).toMatchObject({ needsOwner: true, forcedQuestion: 'rail' });
    const own = withRailRule(compose({ needsOwner: true, ownerQuestion: 'Suyuqlik olamizmi?' }), { burst: [msg('Atir olib kelasizmi?')] });
    expect(own.forcedQuestion).toBeUndefined();
  });

  it('while he answers, the card says where the answer goes — and once it is in, that the AI is writing', () => {
    const since = '2026-11-12T10:00:00.000Z';
    const answering = { since, until: '2026-11-12T10:30:00.000Z' };
    const waiting = draft({ status: 'editing', policy: { ...(draft().policy as object), answering } });
    expect(renderDraftCard(waiting, null)).toContain(ANSWER_STATUS_LINE);
    expect(answeredNow(waiting)).toBe(false);
    const taken = draft({ status: 'editing', policy: { ...(draft().policy as object), answering, ownerAnswer: { text: 'Ha', at: '2026-11-12T10:05:00.000Z', messageId: 7 } } });
    expect(renderDraftCard(taken, null)).toContain(ANSWER_TAKEN_LINE);
    expect(answeredNow(taken)).toBe(true);
    // An answer from an EARLIER press is no answer to this one.
    const old = draft({ status: 'editing', policy: { ...(draft().policy as object), answering, ownerAnswer: { text: 'Ha', at: '2026-11-12T09:00:00.000Z', messageId: 7 } } });
    expect(answeredNow(old)).toBe(false);
  });

  it('the reply the AI wrote from his answer says so on its card — until his own words replace it', () => {
    const fromAnswer = { questionDraftId: ID, questionAnchor: '1', questionAnchorEditedAt: null, questionDraftedAt: null, personal: [], figures: false };
    const redraft = draft({ needsOwner: false, ownerQuestion: null, proposedBody: 'Afsuski, suyuq yuk olmaymiz.', policy: { ...(draft().policy as object), fromAnswer } as never });
    expect(renderDraftCard(redraft, null)).toContain(FROM_ANSWER_LINE);
    expect(renderDraftCard({ ...redraft, finalBody: 'O‘zim yozdim.' }, null)).not.toContain(FROM_ANSWER_LINE);
    expect(renderDraftCard(draft({ needsOwner: false, ownerQuestion: null }), null)).not.toContain(FROM_ANSWER_LINE);
  });

  it('the question his answer superseded says so — never «↪️ Mijoz yana yozdi»', () => {
    const closed = draft({ status: 'superseded', policy: { ...(draft().policy as object), stale: 'owner_answered' } as never });
    const text = renderDraftCard(closed, null);
    expect(text).toContain('✍️ Javobingiz olindi — AI qayta yozdi');
    expect(text).not.toContain('Mijoz yana yozdi');
  });
});

describe('every way his answer makes no reply is said (§2.2)', () => {
  it('all but a draft have words', () => {
    const outcomes: RunResult[] = [
      { outcome: 'skipped', reason: 'no_fresh_inbound' },
      { outcome: 'skipped', reason: 'agent_off' },
      { outcome: 'skipped', reason: 'ai_not_configured' },
      { outcome: 'stood_down', reason: 'duplicate' },
      { outcome: 'stood_down', reason: 'question_gone' },
      { outcome: 'rescheduled', reason: 'peer_typing' },
      { outcome: 'refused', reason: 'human_active' },
      { outcome: 'capped', reason: 'daily_token_cap' },
      { outcome: 'notice', reason: 'x' },
      { outcome: 'no_reply' },
      { outcome: 'error', reason: 'wall_clock' },
    ];
    for (const out of outcomes) expect(answerNoDraftWhy(out), JSON.stringify(out)).toMatch(/\S/u);
    expect(answerNoDraftWhy({ outcome: 'draft', draftId: ID, blocked: false })).toBeNull();
  });
});

describe('the source key is his answer’s own (§2.2: one shared with another run would answer «duplicate» in silence)', () => {
  it('answer:<question>:<his message>', () => {
    const src = readFileSync('src/modules/wms/agent/owner-answer-job.ts', 'utf8');
    expect(src).toMatch(/sourceKey: `answer:\$\{q\.id\}:\$\{job\.messageId\}`/u);
  });
});
