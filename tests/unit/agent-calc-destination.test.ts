import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';
import { AVIA_DAYS_DEFAULT } from '@/modules/platform/settings/service';
import { autoVerdict, type AutoGateInput } from '@/modules/wms/agent/auto-gate';
import {
  ASSUMED_DESTINATION,
  ASSUMED_DESTINATION_NOTE,
  checkDestination,
  DESTINATION_EVIDENCE_CHARS,
  destinationNote,
  evidenceOf,
  jobDestination,
  saidDestinationNote,
  thisJobLines,
} from '@/modules/wms/agent/calc-destination';
import { actionLines } from '@/modules/wms/agent/card-io';
import type { AgentContext, ChatMessage } from '@/modules/wms/agent/context';
import { ASSUMED_DESTINATION_TOOL_WORDS, CALC_DESTINATION_TAKEN_WORDS, CALC_PRICE_TOOL, runTool, TOOL_SPECS, type ToolEnv } from '@/modules/wms/agent/tools';

/**
 * The destination the MODEL names and the code verifies (the lead's ruling, 2026-11-21, after three checks of a
 * word-rule reader): the model's `to_city` lands only when its `to_city_words` are found in the customer's own line —
 * case, the typed apostrophe, spaces, punctuation and NFKC aside, never a transliteration — and the city is in those
 * words by its stem, at the start of a word of his line; a place outside Uzbekistan never lands; anything else is
 * Tashkent TAKEN on a truck job. The verifier's corpus is `calc_destination_check`
 * (tests/unit/fixtures/agent-reader-corpus.ts).
 */

describe('checkDestination: the words are the customer’s, the city is in them', () => {
  it('the ruling’s four: a dative with a question, a label, Russian with a comma, a region', () => {
    expect(checkDestination({ toCity: 'Andijon', words: 'Andijonga' }, ['Andijonga 3 kub qachon keladi'])).toEqual({ kind: 'said', toCity: 'Andijon', evidence: 'Andijonga 3 kub qachon keladi' });
    expect(checkDestination({ toCity: 'Andijon', words: 'manzil Andijon' }, ['Ivudan 3 kub kiyim', 'manzil Andijon'])).toEqual({ kind: 'said', toCity: 'Andijon', evidence: 'manzil Andijon' });
    expect(checkDestination({ toCity: 'Андижан', words: 'Андижан' }, ['Андижан, 3 куба'])).toEqual({ kind: 'said', toCity: 'Андижан', evidence: 'Андижан, 3 куба' });
    expect(checkDestination({ toCity: 'Andijon', words: 'Andijon viloyati' }, ['Andijon viloyati'])).toMatchObject({ kind: 'said', toCity: 'Andijon' });
  });

  it('the evidence is the CUSTOMER’s LINE around the place, cut out of his text — never the model’s copy, never its bare quote (F2)', () => {
    expect(checkDestination({ toCity: 'Andijon', words: 'andijonga 3 kub' }, ['ANDIJONGA   3 KUB'])).toEqual({ kind: 'said', toCity: 'Andijon', evidence: 'ANDIJONGA 3 KUB' });
    expect(checkDestination({ toCity: "Qo'qon", words: "Qo'qonga" }, ['Qo‘qonga 2 kub'])).toEqual({ kind: 'said', toCity: "Qo'qon", evidence: 'Qo‘qonga 2 kub' });
    // The bare quote hides the word that undoes it: the VED reads «emas» beside the city.
    expect(checkDestination({ toCity: 'Toshkent', words: 'Toshkentga' }, ['Toshkentga emas, Andijonga 3 kub'])).toEqual({ kind: 'said', toCity: 'Toshkent', evidence: 'Toshkentga emas, Andijonga 3 kub' });
    const long = 'Assalomu alaykum hurmatli kompaniya, bizda Ivudan 3 kub kiyim bor, 450 kg, iltimos narxini ayting, yuk Andijonga ketadi, rahmat oldindan';
    const ev = checkDestination({ toCity: 'Andijon', words: long }, [long]);
    expect(ev.kind).toBe('said');
    const evidence = (ev as { evidence: string }).evidence;
    expect(evidence).toContain('Andijonga');
    expect(evidence.length).toBeLessThanOrEqual(DESTINATION_EVIDENCE_CHARS);
    expect(evidenceOf('Ivudan 3 kub,\n  Toshkentga', 20)).toBe('Ivudan 3 kub, Toshkentga');
  });

  it('the city by its stem — the case ending may differ, a Chinese name anywhere in the quote', () => {
    expect(checkDestination({ toCity: 'Андижан', words: 'до Андижана' }, ['Доставка до Андижана, 3 куба'])).toMatchObject({ kind: 'said', toCity: 'Андижан' });
    expect(checkDestination({ toCity: 'Андижан', words: 'Андижонга' }, ['Андижонга юк бор'])).toMatchObject({ kind: 'said', toCity: 'Андижан' });
    expect(checkDestination({ toCity: 'Ош', words: 'Ошга' }, ['Ошга 2 куб'])).toMatchObject({ kind: 'foreign', toCity: 'Ош' });
    expect(checkDestination({ toCity: '安集延', words: '到安集延' }, ['从义乌到安集延3方'])).toMatchObject({ kind: 'said', toCity: '安集延' });
  });

  it('a city of six letters or more by its first five, and only at the start of a word of HIS line (F4)', () => {
    expect(checkDestination({ toCity: 'Toshloq', words: 'Toshkentga' }, ['Toshkentga 3 kub'])).toEqual({ kind: 'unread', why: 'not_in_words' });
    expect(checkDestination({ toCity: 'Янгиер', words: 'Янгийўлга' }, ['Янгийўлга 2 куб'])).toEqual({ kind: 'unread', why: 'not_in_words' });
    expect(checkDestination({ toCity: 'Toshloq', words: 'Toshloqqa' }, ['Toshloqqa 2 kub'])).toMatchObject({ kind: 'said', toCity: 'Toshloq' });
    // «osh» copied out of «Toshkentga» stands inside his word: no Osh anywhere he wrote.
    expect(checkDestination({ toCity: 'Osh', words: 'osh' }, ['Ivudan Toshkentga 3 kub'])).toEqual({ kind: 'unread', why: 'not_in_lines' });
    // A shorter city keeps four letters — the case ending still differs.
    expect(checkDestination({ toCity: 'Nukus', words: 'Nukusgacha' }, ['Nukusgacha qancha?'])).toMatchObject({ kind: 'said', toCity: 'Nukus' });
  });

  it('quote marks, punctuation and a dropped comma are no word; a preposition or «г.» before the city does not land with it (F5)', () => {
    const line = 'Ivudan Andijonga 3 kub kiyim, qachon keladi?';
    for (const words of ['«Andijonga 3 kub»', '"Andijonga 3 kub"', "'Andijonga 3 kub'", '‘Andijonga 3 kub’', '(Andijonga 3 kub)', 'Andijonga 3 kub…', 'Andijonga 3 kub kiyim qachon keladi']) {
      expect(checkDestination({ toCity: 'Andijon', words }, [line]), words).toEqual({ kind: 'said', toCity: 'Andijon', evidence: line });
    }
    expect(checkDestination({ toCity: '«Andijon»', words: 'Andijonga' }, [line])).toMatchObject({ kind: 'said', toCity: 'Andijon' });
    expect(checkDestination({ toCity: 'в Андижан', words: 'в Андижан' }, ['Из Иу в Андижан 3 куба'])).toMatchObject({ kind: 'said', toCity: 'Андижан' });
    expect(checkDestination({ toCity: 'г. Андижан', words: 'в г. Андижан' }, ['Доставка в г. Андижан, 3 куба'])).toMatchObject({ kind: 'said', toCity: 'Андижан' });
    // A city HE put in single quotes or backticks is read (the final check's T-R2); a word's own last apostrophe stays.
    for (const [words, line] of [
      ['Andijon', "Manzil 'Andijon' 3 kub"],
      ['Andijonga', '‘Andijonga’ 3 kub'],
      ['Andijon', 'Manzil `Andijon`'],
      ["'Andijon'", "Manzil 'Andijon', Qo'qonga emas"],
    ] as const) {
      expect(checkDestination({ toCity: 'Andijon', words }, [line]), line).toEqual({ kind: 'said', toCity: 'Andijon', evidence: line });
    }
    expect(checkDestination({ toCity: 'Андижан', words: 'Андижан' }, ["Адрес 'Андижан', 3 куба"])).toMatchObject({ kind: 'said', toCity: 'Андижан' });
    expect(checkDestination({ toCity: "Qo'qon", words: "Qo'qonga" }, ["Qo'qonga 2 kub"])).toMatchObject({ kind: 'said' });
    // …and the city stripped of its «в» is still read with it in HIS line: Osh is still asked.
    expect(checkDestination({ toCity: 'в Ош', words: '«в Ош»' }, ['в Ош 2 куба'])).toEqual({ kind: 'foreign', toCity: 'Ош' });
  });

  it('refused: words in no line, the city not in the words, a transliteration, the country itself, one letter', () => {
    expect(checkDestination({ toCity: 'Andijon', words: 'Andijonga' }, ['Ivudan 3 kub kiyim'])).toEqual({ kind: 'unread', why: 'not_in_lines' });
    expect(checkDestination({ toCity: 'Andijon', words: 'Ivudan' }, ['Ivudan 3 kub kiyim'])).toEqual({ kind: 'unread', why: 'not_in_words' });
    expect(checkDestination({ toCity: 'Andijon', words: 'Andijonga' }, ['Андижонга юк бор'])).toEqual({ kind: 'unread', why: 'not_in_lines' });
    expect(checkDestination({ toCity: "O'zbekiston", words: "O'zbekistonga" }, ["Xitoydan O'zbekistonga 3 kub"])).toEqual({ kind: 'unread', why: 'country' });
    expect(checkDestination({ toCity: 'A', words: 'Andijonga' }, ['Andijonga 3 kub'])).toEqual({ kind: 'unread', why: 'none' });
    expect(checkDestination({ toCity: '', words: '' }, ['Andijonga 3 kub'])).toEqual({ kind: 'unread', why: 'none' });
  });

  it('outside Uzbekistan is foreign — China and the neighbours; Uzbekistan’s own places the gate lists are not', () => {
    for (const [city, words, line] of [
      ['Almaty', 'Almatiga', 'Almatiga 3 kub'],
      ['Ош', 'в Ош', 'в Ош 2 куба'],
      ['Ош', 'Доставка в г. Ош', 'Доставка в г. Ош, 2 куба'],
      ['Bishkek', 'Bishkekka', 'Bishkekka yuk bor'],
      ['Xitoy', 'Xitoyga', 'Toshkentdan Xitoyga 3 kub'],
      ['阿拉木图', '运到阿拉木图', '运到阿拉木图3方'],
      // The bare city quoted out of its grammar is read in HIS line (F1): the preposition, his whole word, «shahri».
      ['Osh', 'Osh', 'Osh shahriga 3 kub'],
      ['Ош', 'Ош', 'В Ош доставляете? 3 куба'],
      ['Osh', 'Osh', 'Oshga 3 kub'],
      ['Ош', 'Ош', 'Ош шаҳрига 3 куб'],
      ['Osh', 'Osh', 'Manzil: Osh, 2 kub'],
      // Norin and Karasu are Uzbekistan's — unless his line speaks of Kyrgyzstan (F3); Kara-Suu spelt so is Kyrgyz.
      ['Norin', 'Noringa', "Qirg'izistonga, Noringa 2 kub"],
      ['Нарын', 'в Нарын', 'Кыргызстан, в Нарын 2 куба'],
      // «Нарын» in Russian with no Namangan in his line is the Kyrgyz town (the final check's T-R4).
      ['Нарын', 'в Нарын', 'в Нарын 3 куба'],
      ['Нарын', 'Нарынга', 'Нарынга 3 куб'],
      // A place's own ending after a hyphen is still read with it.
      ['Osh', 'Osh', 'Osh-ga 3 kub'],
      ['Кара-Суу', 'Кара-Суу', 'в Кара-Суу 2 куба'],
    ] as const) {
      expect(checkDestination({ toCity: city, words }, [line]), city).toEqual({ kind: 'foreign', toCity: city });
    }
    for (const [city, words, line] of [
      ['Chirchiq', 'Chirchiqqa', 'Chirchiqqa 3 kub'],
      ['Qarshi', 'Qarshiga', 'Qarshiga 3 kub'],
      ['Samarqand', 'Samarqandga', 'Ivudan Samarqandga 5 kub'],
      ['Chinoz', 'chinozga', 'ivudan chinozga 3 kub'],
      // A foreign place in the quote is where the cargo comes FROM — only the words before the city are asked.
      ['Chinoz', 'Olmaotadan chinozga', 'Olmaotadan chinozga 3 kub'],
      // His line's grammar around an Uzbek place keeps it Uzbek; the word after it is read only as a town word.
      ['Qarshi', 'Qarshi', 'Qarshi shahriga 2 kub'],
      ['Андижан', 'Андижан', 'В Андижан доставляете? 3 куба'],
      ['Toshkent', 'Toshkentga', 'Toshkentga, Andijonga emas'],
      ['Norin', 'Noringa', 'Noringa 2 kub'],
      ['Норин', 'Норин туманига', 'Норин туманига 2 куб'],
      ['Нарын', 'в Нарын', 'в Нарын (Наманганская обл.) 2 куба'],
      ['Карасу', 'в Карасу', 'в Карасу 2 куба'],
      // The next place of a hyphenated route is no ending of this one (the final check's T-R1).
      ['Toshkent', 'Toshkent', 'Toshkent-Samarqand 3 kub'],
      ['Ташкент', 'Ташкент', 'Иу-Ташкент-Андижан 3 куба'],
      ['Sergeli', 'Sergeli', 'Sergeli-Andijon 2 kub'],
    ] as const) {
      expect(checkDestination({ toCity: city, words }, [line]), city).toMatchObject({ kind: 'said', toCity: city });
    }
  });
});

describe('jobDestination: what the checklist lands', () => {
  it('a truck job with nothing verified takes Tashkent; a customs-only job takes nothing; a foreign city lands neither', () => {
    const lines = ['Ivudan 3 kub kiyim'];
    expect(jobDestination({ toCity: '', words: '' }, lines, true)).toEqual({ toCity: ASSUMED_DESTINATION, assumed: true, evidence: null, foreign: null, refused: null });
    expect(jobDestination({ toCity: 'Andijon', words: 'Andijonga' }, lines, true)).toEqual({ toCity: ASSUMED_DESTINATION, assumed: true, evidence: null, foreign: null, refused: 'not_in_lines' });
    expect(jobDestination({ toCity: '', words: '' }, lines, false)).toEqual({ toCity: null, assumed: false, evidence: null, foreign: null, refused: null });
    expect(jobDestination({ toCity: 'Almaty', words: 'Almatiga' }, ['Almatiga 3 kub'], true)).toEqual({ toCity: null, assumed: false, evidence: null, foreign: 'Almaty', refused: null });
  });

  it('the lines: his inbound ones since the last landed job — ours never, a handed-back chain no cut', () => {
    const at = (n: number) => new Date(Date.UTC(2026, 10, 21, 8, n));
    const messages = [
      { direction: 'in', body: 'Andijonga 3 kub', sentAt: at(0) },
      { direction: 'out', body: "Toshkentgacha 300 $ bo'ladi", sentAt: at(5) },
      { direction: 'in', body: 'Ivudan 2 kub', sentAt: at(20) },
    ];
    expect(thisJobLines(messages, [])).toEqual(['Andijonga 3 kub', 'Ivudan 2 kub']);
    expect(thisJobLines(messages, [{ status: 'answered', createdAt: at(10) }])).toEqual(['Ivudan 2 kub']);
    expect(thisJobLines(messages, [{ status: 'returned', createdAt: at(10) }])).toEqual(['Andijonga 3 kub', 'Ivudan 2 kub']);
  });
});

describe('his card says what the VED will read', () => {
  const submit = (toCityAssumed?: boolean) => ({
    type: 'calc_submit' as const,
    section: 'podklyuch' as const,
    facts: { fromCity: 'Yiwu', toCity: 'Toshkent', weightKg: 450, volumeM3: 3, goods: [] },
    fromOurWarehouse: false,
    ...(toCityAssumed === undefined ? {} : { toCityAssumed }),
    citedMessageIds: [],
  });

  it('a destination taken, not read, is on the line ✅ also does — «taxmin», and the VED’s own words', () => {
    expect(actionLines([submit(true)])[0]).toContain(` · taxmin: ${ASSUMED_DESTINATION_NOTE}`);
  });

  it('a destination READ is on it with the customer’s words; an action stored before the evidence names neither', () => {
    const read = { ...submit(false), facts: { ...submit(false).facts, toCity: 'Andijon' }, toCitySaid: 'Ivudan Andijonga 3 kub' };
    expect(actionLines([read])[0]).toContain(' · Manzil mijoz xabaridan: «Ivudan Andijonga 3 kub»');
    expect(actionLines([read])[0]).not.toContain('taxmin');
    expect(actionLines([submit(false)])[0]).not.toMatch(/Manzil|taxmin/u);
    expect(actionLines([submit()])[0]).not.toMatch(/Manzil|taxmin/u);
  });

  it('his card and the VED’s screens say ONE sentence (uz): the bundle’s words are `destinationNote`’s', () => {
    const uz = JSON.parse(readFileSync('messages/uz.json', 'utf8')) as { calc: { destinationTaken: string; destinationSaid: string } };
    expect(uz.calc.destinationTaken).toBe(destinationNote({ taken: true }));
    expect(uz.calc.destinationSaid.replace('{evidence}', 'X')).toBe(saidDestinationNote('X'));
    expect(destinationNote({ taken: false, evidence: 'X' })).toBe(saidDestinationNote('X'));
  });
});

/** The customer's lines, `minutesAgo` each, as a run's recent window holds them. */
function chat(lines: readonly [string, number][], openCalcs: AgentContext['openCalcs'] = []): AgentContext {
  const now = Date.now();
  const messages: ChatMessage[] = lines.map(([body, minutesAgo], i) => ({
    ref: `#${i + 1}`,
    id: `00000000-0000-4000-8000-${String(i + 1).padStart(12, '0')}`,
    tgMessageId: BigInt(i + 1),
    direction: 'in',
    media: null,
    fileName: null,
    sentAt: new Date(now - minutesAgo * 60_000),
    autoSent: false,
    editedAt: null,
    body,
  }));
  const last = messages.at(-1)!;
  return {
    managerUserId: 'u',
    peerId: 1n,
    messages,
    history: messages,
    anchor: last,
    burst: [last],
    lastOut: null,
    identity: { clientId: null, leadId: 'l', strength: 'lead', codes: [], customerName: null, managerName: null, cargoAllowed: false },
    storedLocale: null,
    customerScript: 'latin',
    measures: [],
    openCalcs,
    lastQuote: null,
    ruleDecision: null,
  };
}

const env = (ctx: AgentContext): ToolEnv => ({
  ctx,
  day: '2026-11-21',
  aviaUsdPerKg: 17,
  kb: async () => [],
  chinaPlaces: async () => new Set(['Yiwu', 'Guangzhou']),
  priceArmed: false,
  calcArmed: false,
  calcPricing: false,
  aviaDays: AVIA_DAYS_DEFAULT,
});

const goods = [{ name: 'kiyim', quantity: 200, unit: 'dona', weight_kg: null }];

describe('the checklist lands the model’s city only on THIS job’s words (review R2, the lead’s ruling)', () => {
  const landed = (minutesAgo: number, status: string) => ({
    requestId: 'r',
    section: 'podklyuch',
    createdAt: new Date(Date.now() - minutesAgo * 60_000),
    status,
  });
  const andijon = { to_city: 'Andijon', to_city_words: 'Andijonga 3 kub' };
  const lines: [string, number][] = [
    ['Andijonga 3 kub kiyim', 120],
    ['Ivudan 3 kub 450 kg kiyim, 200 dona', 5],
  ];

  it('«Andijonga» for the job that landed an hour ago is no destination of today’s: Tashkent taken, and the model told why', async () => {
    const fresh = await runTool('calc_checklist', { section: 'podklyuch', goods, ...andijon }, env(chat(lines)));
    // Control — no job landed: the line is this job's.
    expect(fresh.checklist).toMatchObject({ complete: true, toCityAssumed: false, toCityEvidence: 'Andijonga 3 kub kiyim', facts: { toCity: 'Andijon' } });
    const after = await runTool('calc_checklist', { section: 'podklyuch', goods, ...andijon }, env(chat(lines, [landed(60, 'answered')])));
    expect(after.checklist).toMatchObject({ complete: true, toCityAssumed: true, facts: { toCity: ASSUMED_DESTINATION } });
    expect(after.text).toContain("to_city_words mijozning xabarlarida so'zma-so'z topilmadi");
    expect(after.text).not.toContain('qaysi shaharga');
  });

  it('a chain the VED handed back is no cut: the hand-back loop’s resubmission is the same job, its destination said before it landed', async () => {
    const out = await runTool('calc_checklist', { section: 'podklyuch', goods, ...andijon }, env(chat(lines, [landed(60, 'returned')])));
    expect(out.checklist).toMatchObject({ toCityAssumed: false, facts: { toCity: 'Andijon' } });
  });

  it('the staff intake’s route reader no longer names the destination: «Ivudan Andijonga kelishi» with nothing from the model is TAKEN', async () => {
    const out = await runTool('calc_checklist', { section: 'yolkira', goods, to_city: '', to_city_words: '' }, env(chat([['Ivudan Andijonga kelishi qancha, 3 kub 450 kg kiyim, 200 dona', 5]])));
    expect(out.checklist).toMatchObject({ toCityAssumed: true, facts: { toCity: ASSUMED_DESTINATION } });
  });

  it('a city outside Uzbekistan is asked, never taken for Tashkent', async () => {
    const out = await runTool('calc_checklist', { section: 'podklyuch', goods, to_city: 'Almaty', to_city_words: 'Almatiga' }, env(chat([['Ivudan 3 kub 450 kg kiyim, 200 dona, Almatiga', 5]])));
    expect(out.checklist).toMatchObject({ complete: false, toCityAssumed: false, facts: { toCity: null } });
    expect(out.text).toContain('qaysi shaharga');
    expect(out.text).toContain("«Almaty» O'zbekistondan tashqarida");
  });

  it('a customs-only job takes no Tashkent: its destination is the verified one or none', async () => {
    const none = await runTool('calc_checklist', { section: 'rastamojka', goods }, env(chat([['Ivudan 3 kub 450 kg kiyim, 200 dona', 5]])));
    expect(none.checklist).toMatchObject({ toCityAssumed: false, facts: { toCity: null } });
    const said = await runTool('calc_checklist', { section: 'rastamojka', goods, to_city: 'Andijon', to_city_words: 'Andijonga' }, env(chat([['Andijonga, 3 kub 450 kg kiyim, 200 dona', 5]])));
    expect(said.checklist).toMatchObject({ toCityAssumed: false, toCityEvidence: 'Andijonga, 3 kub 450 kg kiyim, 200 dona', facts: { toCity: 'Andijon' } });
  });
});

describe('the model is told one thing about a taken destination (review F5, the lead’s ruling)', () => {
  it('«don’t ask, don’t say it as his» — «o‘qilmadi», never «mijoz aytmagan» — and «Toshkentgacha» in a price', async () => {
    expect(ASSUMED_DESTINATION_TOOL_WORDS).toContain('«Toshkentgacha»');
    expect(ASSUMED_DESTINATION_TOOL_WORDS).toContain('Manzil o‘qilmadi');
    expect(ASSUMED_DESTINATION_TOOL_WORDS).not.toMatch(/manzilni aytmagan/u);
    expect(CALC_DESTINATION_TAKEN_WORDS).toContain('Manzil o‘qilmadi, Toshkent deb olindi');
    expect(CALC_DESTINATION_TAKEN_WORDS).not.toMatch(/manzilni aytmagan/u);
    const out = await runTool('calc_checklist', { section: 'podklyuch', goods }, env(chat([['Ivudan 3 kub 450 kg kiyim, 200 dona', 5]])));
    expect(out.checklist).toMatchObject({ complete: true, toCityAssumed: true });
    expect(out.text).toContain(ASSUMED_DESTINATION_TOOL_WORDS);
  });

  it('the tool asks the model for the city and the customer’s words, and never «qaysi shaharga» for a truck job', () => {
    const spec = TOOL_SPECS.find((t) => t.name === 'calc_checklist')!;
    const props = (spec.input_schema as { properties: Record<string, unknown>; required: string[] }).properties;
    expect(Object.keys(props)).toEqual(expect.arrayContaining(['to_city', 'to_city_words']));
    expect(spec.description).toContain('to_city_words');
    expect(spec.description).toContain("so'zma-so'z");
    // Its examples wear no quote marks (F5): a model copies the marks its example stands in.
    expect(spec.description).toContain('masalan: Andijonga 3 kub.');
    expect(spec.description).toContain('Andijonga → Andijon, в Андижан → Андижан');
    expect(spec.description).not.toMatch(/«Andijon/u);
    // «Mijoz manzilni aytmagan» is never told as a fact (the ruling) — «aytmagan bo'lsa» is an instruction.
    expect(spec.description).not.toMatch(/manzilni aytmagan/u);
  });
});

/** A VED price reply the machine may press — every fact clean, «VED narxi» ticked (agent-full-p2-price's own shape). */
function calcQuote(body: string, destinationTaken: boolean): AutoGateInput {
  return {
    config: { armed: true, categories: ['greeting', 'qualification', 'faq', 'status', 'calc_price'], maxChars: 400, perDay: null },
    agentOn: true,
    draft: {
      kind: 'reply',
      status: 'pending',
      ownText: false,
      blocked: false,
      needsOwner: false,
      warningCodes: [],
      noteCodes: [],
      systemAck: false,
      honestLine: false,
      actionTypes: [],
      category: 'price',
      language: 'uz',
      body,
      confidence: 0.9,
      ledger: [{ kind: 'money', origin: 'tool', tool: CALC_PRICE_TOOL, role: 'total' }],
      hasEstimate: false,
      estimatesStored: false,
      rail: false,
      calcPricesStored: true,
      customerLocale: { locale: 'uz', confident: true },
      unreadNumeral: false,
    },
    tools: [{ name: CALC_PRICE_TOOL, ok: true, estimate: false }],
    money: { unnamed: false, moved: false, tariffUnconfirmed: false, foreignDestination: false, ownerPersonal: false, answerStale: false, ownerFigure: false },
    burstMedia: false,
    calc: null,
    calcPrice: { unconfirmed: false, moved: false, foreign: false, media: false, ownerPriced: false, personOffer: false, destinationTaken },
    chat: { hasOwner: true, prospect: false, offUntil: null, humanUntil: null, muted: false },
    workAccount: true,
    at: new Date('2026-11-12T07:00:00Z'),
    now: new Date('2026-11-12T07:00:00Z'),
    loop: false,
    complaint: false,
    nightPrices: 'table',
    pressedToday: 0,
    budgetLeft: 10,
    sendingEnabled: true,
    listenerCurrent: true,
  };
}

describe('a VED price on a job whose destination was TAKEN says «Toshkentgacha» or waits for him (review F2)', () => {
  it('no Tashkent word → `destination_unsaid`; «Toshkentgacha» → goes; a destination said → as before', () => {
    expect(autoVerdict(calcQuote('VED javobi keldi: podklyuch 1 000 $ bo‘ladi.', true)).reasons).toEqual(['destination_unsaid']);
    expect(autoVerdict(calcQuote('VED javobi keldi: Toshkentgacha podklyuch 1 000 $ bo‘ladi.', true))).toEqual({ eligible: true, reasons: [] });
    expect(autoVerdict(calcQuote('VED javobi keldi: podklyuch 1 000 $ bo‘ladi.', false))).toEqual({ eligible: true, reasons: [] });
  });
});

describe('the VED’s two screens mark the destination’s reading where they print the route (review F4, the T check)', () => {
  for (const page of ['src/app/(protected)/hisoblash/page.tsx', 'src/app/(protected)/hisoblash/[id]/page.tsx']) {
    it(page, () => {
      const src = readFileSync(page, 'utf8');
      // The one reader (calc-price `destinationReadings`, integration-tested) and the two marks beside the route.
      expect(src).toContain('destinationReadings(');
      const at = src.indexOf('data-testid="calc-destination-taken"');
      expect(at, 're-anchor: the taken mark').toBeGreaterThan(0);
      expect(src.slice(at, at + 200)).toContain("t('destinationTaken')");
      // …in the same block as the route's arrow — never a line somewhere else on the screen.
      expect(src.slice(Math.max(0, at - 400), at)).toMatch(/→ \$?\{row\.toCity \?\? '—'\}/u);
      const said = src.indexOf('data-testid="calc-destination-said"');
      expect(said, 're-anchor: the read mark').toBeGreaterThan(at);
      expect(src.slice(said, said + 200)).toContain("t('destinationSaid', { evidence:");
      expect(said - at, 'the read mark sits beside the taken one').toBeLessThan(600);
    });
  }
});
