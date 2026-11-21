import { createTranslator } from 'next-intl';
import { afterAll, describe, expect, it } from 'vitest';
import en from '../../messages/en.json';
import ru from '../../messages/ru.json';
import uz from '../../messages/uz.json';
import zh from '../../messages/zh-CN.json';
import { AGENT_NIGHT_PRICES, type AgentNightPrices } from '@/modules/platform/settings/service';
import { autoWaitsOf } from '@/modules/wms/agent/auto-categories';
import { autoClassOf, autoVerdict, nightBars, type AutoGateInput } from '@/modules/wms/agent/auto-gate';
import { holdSecFor } from '@/modules/wms/agent/auto-send';
import { autoArmedWords } from '@/modules/wms/agent/bot-door';
import { mediaOf } from '@/modules/wms/agent/context';
import { systemReplyFor } from '@/modules/wms/agent/system-reply';

/**
 * What the arming words say against what the GATE does (the independent check of the seam fixes, F2/F3, and the check
 * of the F1-F3 fixes, R3/R4 — adapted from that check's own harness into the permanent fence).
 *
 * For every combination of his three boxes × his three night settings, a canonical reply of each kind is run through
 * `autoVerdict` by day and at night (`autoClassOf`, `nightBars`, `holdSecFor`) — the EXPECTED side never reads his ticks,
 * only what the gate answers. Each surface's words are then READ by each language's own nouns: the page (the numbers
 * line, the no-cap line, the arming confirm, the night select's chosen option, the night hint, the hint) in all four
 * bundles, and the bot's arming words. By day: what waits and what stays his. At night: what goes, what waits for the
 * morning. A calculation the gate holds for the morning under every setting was said nowhere on the page (R4); the AI's
 * reply to a burst with a voice note is the gate's `media` too, and the words named only a photo or a file (R3).
 */
const ORD = ['greeting', 'qualification', 'faq', 'status'];
const COMBOS = [0, 1, 2, 3, 4, 5, 6, 7].map((b) => [...ORD, ...(b & 1 ? ['price'] : []), ...(b & 2 ? ['calc_price'] : []), ...(b & 4 ? ['calc'] : [])]);
const NIGHTS = AGENT_NIGHT_PRICES;
const DAY = new Date('2026-11-11T07:00:00Z'); // 12:00 Tashkent
const NIGHT = new Date('2026-11-11T20:00:00Z'); // 01:00 Tashkent

type Kind = 'talk' | 'table' | 'avia' | 'ved' | 'mixed' | 'calc' | 'complaint' | 'tayyor';
const KINDS: Kind[] = ['talk', 'table', 'avia', 'ved', 'mixed', 'calc', 'complaint', 'tayyor'];

/** A canonical gate input for one kind of reply — everything else clean, the layer armed, a work account. */
function input(kind: Kind, cats: string[], night: AgentNightPrices, at: Date, media: 'none' | 'request' | 'newer'): AutoGateInput {
  const est = (tool: string) => ({
    tools: [{ name: tool, ok: true, estimate: true }],
    ledger: [{ kind: 'money', origin: 'tool', tool, role: 'total' }],
  });
  const ved = { tools: [{ name: 'calc_price', ok: true, estimate: false }], ledger: [{ kind: 'money', origin: 'tool', tool: 'calc_price', role: 'total' }] };
  let tools: AutoGateInput['tools'] = [];
  let ledger: AutoGateInput['draft']['ledger'] = [];
  let body = 'Yukingiz omborga kelgach, sizga darhol xabar beramiz.';
  let actionTypes: string[] = [];
  let category = 'qualification';
  let systemAck = false;
  if (kind === 'table' || kind === 'avia') {
    ({ tools, ledger } = est(kind === 'table' ? 'yolkira_estimate' : 'avia_estimate') as never);
    body = 'Toshkentgacha 3 kub uchun taxminan 480 $ bo‘ladi.';
    category = 'price';
  } else if (kind === 'ved') {
    ({ tools, ledger } = ved as never);
    body = 'Rastamojka bilan jami 1 200 $ bo‘ladi.';
    category = 'price';
  } else if (kind === 'mixed') {
    const a = est('yolkira_estimate');
    tools = [...a.tools, ...ved.tools] as never;
    ledger = [...a.ledger, ...ved.ledger] as never;
    body = 'Toshkentgacha yo‘lkira 480 $, rastamojka bilan jami 1 200 $ bo‘ladi.';
    category = 'price';
  } else if (kind === 'calc') {
    actionTypes = ['calc_submit'];
    body = 'Hisoblatishga yubordim, javob kelishi bilan aytaman.';
    category = 'price';
  } else if (kind === 'complaint') {
    category = 'complaint';
    body = 'Kechirasiz, hozir menejerimiz siz bilan bog‘lanadi.';
  } else if (kind === 'tayyor') {
    systemAck = true;
    category = 'other';
    body = systemReplyFor({ reason: 'media', locale: 'uz', peerId: 1n }).replyText;
  }
  const priced = kind === 'table' || kind === 'avia' || kind === 'mixed';
  const vedPriced = kind === 'ved' || kind === 'mixed';
  return {
    config: { armed: true, categories: cats, maxChars: 400, perDay: null },
    agentOn: true,
    draft: {
      kind: 'reply',
      status: 'pending',
      ownText: false,
      blocked: false,
      needsOwner: false,
      warningCodes: [],
      noteCodes: [],
      systemAck,
      honestLine: false,
      actionTypes,
      category,
      language: 'uz',
      body,
      confidence: systemAck ? null : 0.9,
      ledger,
      hasEstimate: priced,
      estimatesStored: priced,
      calcPricesStored: vedPriced,
      rail: false,
      customerLocale: { locale: 'uz', confident: true },
      unreadNumeral: false,
    },
    tools,
    money: { unnamed: false, moved: false, tariffUnconfirmed: false, foreignDestination: false, ownerPersonal: false, answerStale: false, ownerFigure: false },
    burstMedia: media !== 'none',
    calc: kind === 'calc' ? { unproven: false, foreign: false, refused: false, recent: false, fileMissing: false } : null,
    calcPrice: vedPriced ? { unconfirmed: false, moved: false, ownerPriced: false, personOffer: false, foreign: false, media: media === 'newer' } : null,
    chat: { hasOwner: true, prospect: false, offUntil: null, humanUntil: null, muted: false },
    workAccount: true,
    at,
    now: at,
    loop: false,
    complaint: false,
    nightPrices: night,
    pressedToday: 0,
    budgetLeft: 10,
    sendingEnabled: true,
    listenerCurrent: true,
  } as unknown as AutoGateInput;
}

type Behaviour = 'now' | 'hold' | 'morning' | 'his';
/** What the GATE does with this kind: goes with no hold / waits the price hold / waits for the morning / stays his. */
function behaviour(kind: Kind, cats: string[], night: AgentNightPrices, when: 'day' | 'night', media: 'none' | 'request' | 'newer', talkHold = 0): Behaviour {
  const day = autoVerdict(input(kind, cats, night, DAY, media));
  if (!day.eligible) return 'his';
  const cls = autoClassOf(input(kind, cats, night, DAY, media));
  if (when === 'night') {
    const n = autoVerdict(input(kind, cats, night, NIGHT, media));
    if (!n.eligible) {
      // The night is the only thing the night changes — anything else is a fixture that no longer means what it says.
      expect(n.reasons, `${kind} night`).toEqual(['night']);
      expect(nightBars(cls, night)).toBe(true);
      return 'morning';
    }
  }
  return holdSecFor(cls, { talk: talkHold, price: 120 }) === 0 ? 'now' : 'hold';
}

// ---- the words' readers ----------------------------------------------------------------------------------------------
type Noun = 'table' | 'ved' | 'calc' | 'complaint';
const NOUNS: Record<string, [string, Noun[]][]> = {
  uz: [
    ['yo‘lkira va avia narxi', ['table']],
    ['hisoblatishga yuborish', ['calc']],
    ['VED narxi', ['ved']],
    ['hisoblatish', ['calc']],
    ['shikoyat', ['complaint']],
    ['narx', ['table', 'ved']],
  ],
  ru: [
    ['цена по таблице', ['table']],
    ['цена ВЭД', ['ved']],
    ['расчёт', ['calc']],
    ['жалобы', ['complaint']],
    ['цена', ['table', 'ved']],
  ],
  en: [
    ['a customs desk price', ['ved']],
    ['customs desk prices', ['ved']],
    ['a table price', ['table']],
    ['table prices', ['table']],
    ['a calculation', ['calc']],
    ['complaints', ['complaint']],
    ['a price', ['table', 'ved']],
    ['prices', ['table', 'ved']],
  ],
  'zh-CN': [
    ['运价表报价', ['table']],
    ['报关部报价', ['ved']],
    ['核算请求', ['calc']],
    ['投诉', ['complaint']],
    ['报价', ['table', 'ved']],
  ],
};
const GLUE: Record<string, RegExp> = { uz: /\b(va|hamda|har doim)\b/gu, ru: /(^|\s)и(\s|$)/gu, en: /\b(and|always stay)\b/gu, 'zh-CN': /和/gu };

const problems: string[] = [];

/** The nouns a phrase names — every word of it read, or it is a problem (a word the reader does not know says nothing). */
function nouns(locale: string, phrase: string | null, where: string): Set<Noun> {
  const out = new Set<Noun>();
  if (phrase === null) return out;
  let rest = /^\p{Lu}(?!\p{Lu})/u.test(phrase) ? phrase.charAt(0).toLowerCase() + phrase.slice(1) : phrase;
  for (const [w, ns] of NOUNS[locale]!) {
    if (rest.includes(w)) {
      ns.forEach((n) => out.add(n));
      rest = rest.split(w).join(' ');
    }
  }
  rest = rest.replace(GLUE[locale]!, ' ').replace(/[\s,;.]+/gu, '');
  if (rest !== '') problems.push(`${where}: unread «${rest}» in «${phrase}»`);
  return out;
}

const BUNDLES: Record<string, unknown> = { uz, ru, en, 'zh-CN': zh };
const T = (locale: string) =>
  createTranslator({ locale, messages: BUNDLES[locale] as never, namespace: 'agentAi' as never }) as unknown as (k: string, v?: Record<string, unknown>) => string;

/**
 * Each language's halves: what waits (group 1), the calculation's night beside it (group 2), what stays his — on the
 * numbers lines and on the arming confirm.
 */
const PAGE: Record<string, { waits: RegExp; stays: RegExp; cWaits: RegExp; cStays: RegExp }> = {
  uz: {
    waits: / · ([^·]+?) HOLDX kutadi(?: \(((?:hisoblatish )?kechasi — ertalab)\))?,/u,
    stays: / · ([^·]+) sizga qoladi$/u,
    cWaits: /\)\. ([^;]+?) kartada kutadi(?: \(((?:hisoblatish )?kechasi — ertalab)\))? —/u,
    cStays: /(?:; |\)\. )([^;)]+) har doim sizga qoladi\.$/u,
  },
  ru: {
    waits: / · ([^·]+?) (?:ждёт|ждут) HOLDX(?: \(((?:расчёт )?ночью — до утра)\))?,/u,
    stays: / · ([^·]+) всегда остаются за вами$/u,
    cWaits: /\)\. ([^;]+?) (?:ждёт|ждут) на карточке(?: \(((?:расчёт )?ночью — до утра)\))? —/u,
    cStays: /(?:; |\)\. )([^;)]+) всегда остаются за вами\.$/u,
  },
  en: {
    waits: / · ([^·]+?) (?:waits|wait) HOLDX(?: \(((?:a calculation )?at night, until the morning)\))?,/u,
    stays: / · ([^·]+) with you$/u,
    cWaits: /\)\. ([^;]+?) (?:waits|wait) on (?:its|their) card(?: \(((?:a calculation )?at night, until the morning)\))? —/u,
    cStays: /(?:; |\)\. )([^;)]+) always stay with you\.$/u,
  },
  'zh-CN': {
    waits: / · ([^·]+?)等待 HOLDX(?:（((?:核算请求)?夜间等到早上)）)?，/u,
    stays: / · ([^·]+)始终由您处理$/u,
    cWaits: /）。([^；]+?)会在卡片上等待(?:（((?:核算请求)?夜间等到早上)）)? —/u,
    cStays: /(?:；|）。)([^；）]+)始终由您处理。$/u,
  },
};

/**
 * The night as each language says it: the night select's chosen option, read clause by clause (its prices and whether
 * they go or wait for the morning — a clause naming prices with no verb of its own shares the clause before it, as in
 * «уходят и цена по таблице, и цена ВЭД»), and the calculation's morning in the night hint and the hint.
 */
const NIGHT_WORDS: Record<string, { prices: [string, ('table' | 'ved')[]][]; morning: RegExp; goes: RegExp; split: RegExp; calc: RegExp; talk: RegExp }> = {
  uz: {
    prices: [['jadval va VED narxi', ['table', 'ved']], ['hech qaysi narx', ['table', 'ved']], ['jadval narxi', ['table']], ['VED narxi', ['ved']]],
    morning: /ertalab/u,
    goes: /ketadi/u,
    split: /, /u,
    calc: /hisoblatish[^.;]*(?:ertalab|kechasi — ertalab)/u,
    talk: /^Oddiy javob [^·]+ ketadi, kechasi ham/u,
  },
  ru: {
    prices: [['никакая цена', ['table', 'ved']], ['цена по таблице', ['table']], ['цена ВЭД', ['ved']]],
    morning: /утр/u,
    goes: /уход/u,
    split: /, /u,
    calc: /расч[её]т[^.;]*(?:утр)/u,
    talk: /^Обычный ответ уходит [^·]+, и ночью тоже/u,
  },
  en: {
    prices: [
      ['both the table and the customs desk price', ['table', 'ved']],
      ['no price', ['table', 'ved']],
      ['the table price', ['table']],
      ['a customs desk price', ['ved']],
    ],
    morning: /morning/u,
    goes: /\bgo(?:es)?\b/u,
    split: /, /u,
    calc: /calculation[^.;]*morning/u,
    talk: /^An ordinary reply goes [^·]+, at night too/u,
  },
  'zh-CN': {
    prices: [['运价表和报关部报价', ['table', 'ved']], ['任何报价', ['table', 'ved']], ['运价表报价', ['table']], ['报关部报价', ['ved']]],
    morning: /早上/u,
    goes: /发出/u,
    split: /，/u,
    calc: /核算请求[^。；]*早上/u,
    talk: /^普通回复[^·]+发出，夜间也是/u,
  },
};

function nightOption(locale: string, text: string, where: string): Partial<Record<'table' | 'ved', 'goes' | 'morning'>> {
  const w = NIGHT_WORDS[locale]!;
  const out: Partial<Record<'table' | 'ved', 'goes' | 'morning'>> = {};
  let last: 'goes' | 'morning' | null = null;
  for (const clause of text.split(w.split)) {
    let rest = clause;
    const named: ('table' | 'ved')[] = [];
    for (const [p, ps] of w.prices) {
      if (rest.includes(p)) {
        named.push(...ps);
        rest = rest.split(p).join(' ');
      }
    }
    const verdict: 'goes' | 'morning' | null = w.morning.test(clause) ? 'morning' : w.goes.test(clause) ? 'goes' : last;
    if (verdict === null) problems.push(`${where}: no verb in «${clause}» of «${text}»`);
    else for (const p of named) out[p] = verdict;
    last = verdict;
  }
  return out;
}

/** The noun a gate kind is said by, on every surface. Mixed and talk have none of their own. */
const NOUN_OF: Partial<Record<Kind, Noun>> = { table: 'table', avia: 'table', ved: 'ved', calc: 'calc', complaint: 'complaint' };

/**
 * The kinds of file the burst's `has_media` counts (auto-send `burstHadMedia` asks no kind), as the context names them
 * — and the words each language says them by, in the AI's reply half of the hint and the bot.
 */
const FILE_KINDS = new Set(['image/jpeg', 'audio/ogg', 'audio/mpeg', 'application/pdf'].map((ct) => mediaOf(ct, ct === 'audio/ogg' ? 'voice.ogg' : null)));
const FILE_WORD: Record<string, Record<'photo' | 'voice' | 'audio' | 'document', RegExp>> = {
  uz: { photo: /rasm/u, voice: /ovoz/u, audio: /ovoz/u, document: /fayl/u },
  ru: { photo: /фото/u, voice: /голосов/u, audio: /голосов/u, document: /файл/u },
  en: { photo: /photo/u, voice: /voice note/u, audio: /voice note/u, document: /file/u },
  'zh-CN': { photo: /图片/u, voice: /语音/u, audio: /语音/u, document: /文件/u },
};
/** The AI's-reply half of the media clause, as each language writes it. */
const AI_MEDIA_HALF: Record<string, RegExp> = {
  uz: /; ([^;—]+?) xabarga AI yozgan javob sizga qoladi/u,
  ru: /; ответ ИИ на сообщение с ([^—]+?) остаётся за вами/u,
  en: /; the AI’s reply to a message with ([^—]+?) stays with you/u,
  'zh-CN': /；AI 对带([^—]+?)的消息的回复由您处理/u,
};

describe('every surface × every tick × every night setting says what the gate does, by day and at night', () => {
  afterAll(() => {
    // Printed for the reader of a red run: every problem, once.
    if (problems.length) console.log(`problems (${problems.length}):\n${[...new Set(problems)].join('\n')}`);
  });

  it.each(COMBOS.map((c) => [c.slice(4).join('+') || 'nothing', c] as const))('the page — %s', (_, cats) => {
    const waits = autoWaitsOf(cats);
    for (const locale of Object.keys(BUNDLES)) {
      const t = T(locale);
      const texts = {
        numbers: t('autoNumbers', { talk: 'TALKX', priceHold: 'HOLDX', waits, perDay: 30, maxChars: 400 }),
        noCap: t('autoNumbersNoCap', { talk: 'TALKX', priceHold: 'HOLDX', waits, maxChars: 400 }),
        confirm: t('autoArmConfirm', { waits }),
      };
      const re = PAGE[locale]!;
      const nw = NIGHT_WORDS[locale]!;
      const nightHint = t('autoNightHint');
      const hint = t('autoHint');
      for (const night of NIGHTS) {
        const option = t(`autoNight.${night}`);
        const optionSays = nightOption(locale, option, `${locale} night option ${night}`);
        for (const [name, text] of Object.entries(texts)) {
          const where = `${locale} ${name} [${_} · ${night}]`;
          const wm = (name === 'confirm' ? re.cWaits : re.waits).exec(text);
          const w = nouns(locale, wm?.[1] ?? null, where);
          const s = nouns(locale, (name === 'confirm' ? re.cStays : re.stays).exec(text)?.[1] ?? null, where);
          const calcMorning = (wm?.[2] ?? null) !== null;
          // Ordinary talk: the numbers lines say it goes, at night too — the gate never holds it for the morning.
          if (name !== 'confirm' && !nw.talk.test(text)) problems.push(`${where} talk unsaid — «${text}»`);
          if (name !== 'confirm' && behaviour('talk', cats, night, 'night', 'none') === 'morning') problems.push(`${where} talk: the gate holds it for the morning`);
          for (const kind of KINDS) {
            const noun = NOUN_OF[kind];
            if (!noun) continue;
            const day = behaviour(kind, cats, night, 'day', 'none');
            const said = w.has(noun) ? 'waits' : s.has(noun) ? 'his' : 'unsaid';
            // An unticked calculation is said nowhere to stay his — unsaid, never said to go.
            if (!(kind === 'calc' && said === 'unsaid' && day === 'his') && said !== (day === 'his' ? 'his' : 'waits'))
              problems.push(`${where} ${kind} by day: words ${said}, gate ${day} — «${text}»`);
            if (day === 'his') continue;
            // At night.
            const n = behaviour(kind, cats, night, 'night', 'none');
            let nightSaid: 'goes' | 'morning' | 'unsaid';
            if (kind === 'calc') nightSaid = calcMorning && nw.calc.test(nightHint) && nw.calc.test(hint) ? 'morning' : 'unsaid';
            else if (kind === 'complaint') continue;
            else nightSaid = optionSays[noun as 'table' | 'ved'] ?? 'unsaid';
            if (nightSaid !== (n === 'morning' ? 'morning' : 'goes'))
              problems.push(`${where} ${kind} at night: words ${nightSaid}, gate ${n} — «${text}» / «${option}» / «${nightHint}»`);
          }
          // The calculation's night is said beside it exactly when it waits — never about one that stays his.
          if (calcMorning && behaviour('calc', cats, night, 'day', 'none') === 'his') problems.push(`${where}: a calculation's night said while it stays his`);
        }
      }
    }
  });

  it.each(COMBOS.map((c) => [c.slice(4).join('+') || 'nothing', c] as const))('the bot — %s', (_, cats) => {
    for (const night of NIGHTS) {
      for (const talkHold of [0, 90]) {
        const words = autoArmedWords({ holdSec: 120, perDay: null, categories: cats }, { talkHoldSec: talkHold, nightPrices: night });
        const where = `bot [${_} · ${night} · talk ${talkHold}]`;
        const w = nouns('uz', /\. ([^.]+?) kartada \d+ daqiqa kutadi, keyin o‘zi ketadi/u.exec(words)?.[1] ?? null, where);
        const s = nouns('uz', /; ([^;]+) har doim sizga qoladi;/u.exec(words)?.[1] ?? null, where);
        const nightClause = /; kechasi ([^.]+)\./u.exec(words)?.[1] ?? '';
        const exceptRaw = /xabarga AI yozgan javob sizga qoladi(?: \((.+?) bundan mustasno)?/u.exec(words);
        const except = nouns('uz', exceptRaw?.[1] ?? null, `${where} except`);
        // Talk, by day and at night.
        const talk = behaviour('talk', cats, night, 'night', 'none', talkHold);
        const talkSaid =
          talkHold === 0
            ? /oddiy javob darhol o‘zi ketadi — kechasi ham/u.test(words)
            : /oddiy javob 90 soniya kutib o‘zi ketadi \(⏸ bilan to‘xtatasiz\) — kechasi ham/u.test(words);
        if (!talkSaid || talk !== (talkHold === 0 ? 'now' : 'hold')) problems.push(`${where} talk: gate ${talk} — «${words}»`);
        for (const kind of KINDS) {
          const noun = NOUN_OF[kind];
          if (!noun) continue;
          const day = behaviour(kind, cats, night, 'day', 'none');
          const said = w.has(noun) ? 'waits' : s.has(noun) ? 'his' : 'unsaid';
          if (!(kind === 'calc' && said === 'unsaid' && day === 'his') && said !== (day === 'his' ? 'his' : 'waits'))
            problems.push(`${where} ${kind} by day: words ${said}, gate ${day} — «${words}»`);
          if (day !== 'his' && kind !== 'complaint') {
            const n = behaviour(kind, cats, night, 'night', 'none');
            let nightSaid: 'goes' | 'morning' | 'unsaid' = 'unsaid';
            if (kind === 'calc') nightSaid = /VEDga o‘zi ketadi \(kechasi — ertalab\)/u.test(words) ? 'morning' : 'unsaid';
            else if (noun === 'table') {
              if (/hech qaysi narx o‘zi ketmaydi|jadval narxi o‘zi ketmaydi/u.test(nightClause)) nightSaid = 'morning';
              else if (/jadval narxi ketadi|jadval narxi ham ketadi|jadval va VED narxi ketadi/u.test(nightClause)) nightSaid = 'goes';
            } else if (noun === 'ved') {
              if (/hech qaysi narx o‘zi ketmaydi|VED narxi ertalab|VED narxi o‘zi ketmaydi/u.test(nightClause)) nightSaid = 'morning';
              else if (/VED narxi ham ketadi|jadval va VED narxi ketadi/u.test(nightClause)) nightSaid = 'goes';
            }
            if (nightSaid !== (n === 'morning' ? 'morning' : 'goes')) problems.push(`${where} ${kind} at night: words ${nightSaid}, gate ${n} — «${words}»`);
          }
          // A file in the burst: the request's own file (the VED price), or any file (everything else).
          const m = behaviour(kind, cats, night, 'day', 'request');
          const mSaid = day === 'his' ? 'his' : except.has(noun) ? 'goes' : 'his';
          if (mSaid !== (m === 'his' ? 'his' : 'goes')) problems.push(`${where} ${kind} with a file in the burst: words ${mSaid}, gate ${m} — «${words}»`);
          if (kind === 'ved' && m !== 'his' && behaviour(kind, cats, night, 'day', 'newer') !== 'his')
            problems.push(`${where} ved with a file NEWER than the job: gate lets it go, words say the request's own file only`);
        }
        // The model's reply to a file in the burst stays his; the tayyor matn to it goes.
        if (behaviour('talk', cats, night, 'day', 'request') !== 'his') problems.push(`${where} talk with a file: gate lets it go`);
        if (behaviour('tayyor', cats, night, 'day', 'request') === 'his') problems.push(`${where} tayyor matn with a file: gate keeps it`);
        if (!/«yozib yuboring» degan tayyor matn esa o‘zi ketadi/u.test(words)) problems.push(`${where} tayyor matn unsaid`);
        // R3: the AI's reply half names every kind of file the burst's `has_media` counts — the voice note included.
        const half = /([^;]+?) xabarga AI yozgan javob sizga qoladi/u.exec(words)?.[1] ?? '';
        for (const k of FILE_KINDS) if (k && !FILE_WORD.uz![k as 'photo'].test(half)) problems.push(`${where}: the AI's reply half names no ${k} — «${half}»`);
      }
    }
  });

  it('the hint — the AI’s reply half names every kind of file the burst counts, in all four (R3)', () => {
    expect([...FILE_KINDS].sort()).toEqual(['audio', 'document', 'photo', 'voice']);
    for (const locale of Object.keys(BUNDLES)) {
      const hint = T(locale)('autoHint');
      const half = AI_MEDIA_HALF[locale]!.exec(hint)?.[1] ?? null;
      if (half === null) {
        problems.push(`${locale} hint: no AI reply half — «${hint}»`);
        continue;
      }
      for (const k of FILE_KINDS) if (k && !FILE_WORD[locale]![k as 'photo'].test(half)) problems.push(`${locale} hint: the AI's reply half names no ${k} — «${half}»`);
    }
  });

  it('no surface says anything the gate does not do', () => {
    expect([...new Set(problems)]).toEqual([]);
  });
});
