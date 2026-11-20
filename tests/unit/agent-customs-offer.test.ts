import { readdirSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { AVIA_DAYS_DEFAULT } from '@/modules/platform/settings/service';
import { EYE_ONLY_WARNINGS } from '@/modules/wms/agent/auto-gate';
import { customerScriptOf, type AgentContext, type ChatMessage, type MeasureCandidate } from '@/modules/wms/agent/context';
import { AGENT_LOCALES, type AgentLocale } from '@/modules/wms/agent/locale';
import { checkAgentReply, CUSTOMS_OFFER_SENTENCE, EXCLUSION_SENTENCE, type PolicyInput } from '@/modules/wms/agent/policy';
import {
  BOT_ANSWER_RULE,
  CUSTOMS_YES_RULE,
  KASHGAR_REFUSAL,
  KASHGAR_RULE,
  MEDIA_RULE,
  stableHead,
} from '@/modules/wms/agent/prompt';
import { memoryFor, ourLineAsks, type ComposeReply } from '@/modules/wms/agent/run';
import { runTool, type ToolEnv, type ToolOutcome } from '@/modules/wms/agent/tools';
import { draftWorthy } from '@/modules/wms/agent/worthy';

/**
 * Rule 8's customs offer (stage 1a §6.1, his 2 a), J1's «ha» to it, rule 11's «ha → podklyuch», rules 17 and 18, and
 * J24's Kashgar: the offer passes the policy beside a real truck quote in the six languages while the wordings that
 * promise customs still block; the head carries the ONE copy of each sentence and is the same bytes for one persona;
 * «ha» after the offer is an answer even when a sentence follows it; Kashgar is refused by the truck tool and the
 * checklist with his words, Horgos and Urumchi as before.
 */

let seq = 0;
const msg = (body: string, direction: 'in' | 'out' = 'in'): ChatMessage => {
  seq += 1;
  return {
    ref: `#${seq}`,
    id: `00000000-0000-4000-8000-${String(seq).padStart(12, '0')}`,
    tgMessageId: BigInt(seq),
    direction,
    media: null,
    fileName: null,
    sentAt: new Date('2026-11-20T07:00:00Z'),
    autoSent: false,
    editedAt: null,
    body,
  };
};

function chat(lines: readonly string[], measures: MeasureCandidate[] = []): AgentContext {
  const messages = lines.map((b) => msg(b));
  return {
    managerUserId: 'u',
    peerId: 1n,
    messages,
    history: messages,
    anchor: messages.at(-1)!,
    burst: messages,
    lastOut: null,
    lastQuote: null,
    identity: { clientId: null, leadId: 'l', strength: 'lead', codes: [], customerName: null, managerName: null, cargoAllowed: false },
    storedLocale: null,
    customerScript: customerScriptOf(messages),
    measures,
    openCalcs: [],
    ruleDecision: null,
  };
}

/** The customer's question in each language: 5 kub, 800 kg from Yiwu, the price. */
const ASK: Record<AgentLocale, string> = {
  uz: 'Ivudan Toshkentga 5 kub 800 kg yuk bor, narxi qancha?',
  uz_cyrl: 'Иудан Тошкентга 5 куб 800 кг юк бор, нархи қанча?',
  ru: 'Из Иу в Ташкент 5 кубов 800 кг, сколько стоит?',
  en: 'From Yiwu to Tashkent, 5 cbm 800 kg, how much?',
  fa: 'از ییوو تا تاشکند ۵ متر مکعب ۸۰۰ کیلو، قیمت چند است؟',
  zh: '从义乌到塔什干5立方800公斤，多少钱？',
};

/** The quote's own sentence, as rule 8 asks it: hedged, the load named, «Toshkentgacha». */
const QUOTE: Record<AgentLocale, string> = {
  uz: "5 kub, 800 kg yukingiz uchun Toshkentgacha taxminan 960 $ bo'ladi.",
  uz_cyrl: '5 куб, 800 кг юкингиз учун Тошкентгача тахминан 960 $ бўлади.',
  ru: 'За 5 кубов, 800 кг до Ташкента примерно 960 $.',
  en: 'For 5 cbm, 800 kg to Tashkent it is about $960.',
  fa: 'برای ۵ متر مکعب، ۸۰۰ کیلو تا تاشکند حدود ۹۶۰ دلار است.',
  zh: '5立方、800公斤运到塔什干大约960美元。',
};

/** The truck tool's answer for that load (tools `yolkira`): the total, the rate, the days, the load. */
const TRUCK: ToolOutcome = {
  ok: true,
  text: '',
  estimate: true,
  sources: [
    { value: 960, kind: 'money', label: "yo'lkira (sayt kalkulyatori)", origin: 'tool', tool: 'yolkira_estimate', currency: 'USD', role: 'total' },
    { value: 192, kind: 'money', label: "yo'lkira tarifi (sayt)", origin: 'tool', tool: 'yolkira_estimate', currency: 'USD', role: 'rate' },
    { value: 5, kind: 'measure', label: 'mijoz #1', origin: 'tool', tool: 'yolkira_estimate' },
    { value: 800, kind: 'measure', label: 'mijoz #1', origin: 'tool', tool: 'yolkira_estimate' },
  ],
};

const compose = (language: AgentLocale, replyText: string): ComposeReply => ({
  replyNeeded: true,
  replyText,
  language,
  glossUz: language === 'zh' || language === 'fa' || language === 'en' ? "Narxi taxminan 960 $, rastamojkani ham hisoblab beraymi?" : '',
  category: 'price',
  confidence: 0.9,
  needsOwner: false,
  ownerQuestion: '',
  nextStep: 'quote',
  actions: [],
  usedFactIds: [],
  citedMessageRefs: [],
});

/** The policy over a reply quoting the truck, on the memory a real run stores. */
function judge(language: AgentLocale, reply: string) {
  const ctx = chat([ASK[language]]);
  const c = compose(language, reply);
  const mem = memoryFor(ctx, { compose: c, tools: [{ name: 'yolkira_estimate', ok: true, text: '', estimate: true }], outcomes: [TRUCK], usage: { inputTokens: 0, outputTokens: 0, cacheReadTokens: 0, cacheWriteTokens: 0 }, aviaDays: AVIA_DAYS_DEFAULT }, [], 'gsr-test');
  const input: PolicyInput = {
    body: reply,
    language: mem.language,
    customerScript: mem.customerScript,
    numberSources: mem.sources,
    removeWhole: [],
    ownCodes: [],
    bookCodes: new Set(),
    codePrefix: 'GS',
    allowedPhones: mem.allowedPhones,
    allowedUrls: mem.allowedUrls,
    mapUrls: mem.mapUrls,
    askedLocation: mem.askedLocation,
    staffNames: [],
    customerNames: [],
    canary: mem.canary,
    fingerprintPeers: 0,
    urlsToChat7d: 0,
    urlsToday: 0,
    hasEstimate: mem.hasEstimate,
    fromOurWarehouse: mem.fromOurWarehouse === true,
    factNameWords: [],
    askedMode: mem.askedMode ?? null,
    hasGloss: mem.hasGloss === true,
    aviaOnly: mem.aviaOnly === true,
    aviaMentioned: mem.aviaMentioned === true,
    quotableHan: mem.quotableHan ?? '',
  };
  const r = checkAgentReply(input);
  return {
    blocks: r.blocks.map((b) => b.code),
    stops: r.warnings.filter((w) => !(EYE_ONLY_WARNINGS as readonly string[]).includes(w.code)).map((w) => w.code),
  };
}

describe('rule 8: the offer after a truck price — passes in six languages, and the promise wordings still block', () => {
  for (const l of AGENT_LOCALES) {
    it(`${l}: quote + «${EXCLUSION_SENTENCE[l]}» + the offer — no block, no stopping warning`, () => {
      expect(judge(l, `${QUOTE[l]} ${EXCLUSION_SENTENCE[l]} ${CUSTOMS_OFFER_SENTENCE[l]}`)).toEqual({ blocks: [], stops: [] });
    });
  }

  it('the offer says «apart» in every language — the word G11 asks of a clause naming customs', () => {
    const apart: Record<AgentLocale, RegExp> = { uz: /alohida/u, uz_cyrl: /алоҳида/u, ru: /отдельно/u, en: /separately/u, fa: /جداگانه/u, zh: /单独/u };
    for (const l of AGENT_LOCALES) expect(CUSTOMS_OFFER_SENTENCE[l]).toMatch(apart[l]);
  });

  it('«Rastamojka bilan hisoblab beraymi?» in the same place blocks `estimate_unhedged` (the plan\'s measurement)', () => {
    expect(judge('uz', `${QUOTE.uz} ${EXCLUSION_SENTENCE.uz} Rastamojka bilan hisoblab beraymi?`).blocks).toContain('estimate_unhedged');
  });

  it('«Rastamojka bilan 390 $» and «rastamojka ham shu narxda — hisoblab beraymi?» still block', () => {
    expect(judge('uz', `${QUOTE.uz} ${EXCLUSION_SENTENCE.uz} Rastamojka bilan 390 $.`).blocks).not.toEqual([]);
    expect(judge('uz', `${QUOTE.uz} ${EXCLUSION_SENTENCE.uz} Rastamojka ham shu narxda — hisoblab beraymi?`).blocks).not.toEqual([]);
  });
});

describe('J1: «ha» to the offer is an answer, wherever the offer stands in our line', () => {
  const ha = (ours: string) => draftWorthy([{ text: 'ha', media: null }], ourLineAsks(ours));

  it('the offer LAST — the line ends in its question mark', () => {
    expect(ourLineAsks(`${QUOTE.uz} ${EXCLUSION_SENTENCE.uz} ${CUSTOMS_OFFER_SENTENCE.uz}`)).toBe(true);
    expect(ha(`${QUOTE.uz} ${EXCLUSION_SENTENCE.uz} ${CUSTOMS_OFFER_SENTENCE.uz}`)).toMatchObject({ worthy: true });
  });

  it('a sentence AFTER the offer («Boj va QQS…») — still an answer: «ha» starts a run', () => {
    for (const l of AGENT_LOCALES) {
      const ours = `${QUOTE[l]} ${CUSTOMS_OFFER_SENTENCE[l]} ${EXCLUSION_SENTENCE[l]}`;
      expect(ourLineAsks(ours), l).toBe(true);
    }
    expect(ha(`${QUOTE.uz} ${CUSTOMS_OFFER_SENTENCE.uz} ${EXCLUSION_SENTENCE.uz}`)).toMatchObject({ worthy: true });
  });

  it('the same fold both sides: case, apostrophes and white space do not hide it', () => {
    const typed = CUSTOMS_OFFER_SENTENCE.uz.replace(/ /gu, '  ').replace('Xohlasangiz', 'xohlasangiz');
    expect(ourLineAsks(`${QUOTE.uz} ${typed} Boj va QQS alohida.`)).toBe(true);
  });

  it('a question mark with an emoji or a space after it is still a question', () => {
    expect(ourLineAsks('Yukingiz qayerdan? 🙂')).toBe(true);
    expect(ourLineAsks('Yukingiz qayerdan?  ')).toBe(true);
    expect(ourLineAsks('Yukingiz qayerdan?👍🏻')).toBe(true);
    expect(ourLineAsks('Ваш груз откуда؟ ✅')).toBe(true);
  });

  it('a statement is no question — «ha» after it stays a closing, as before', () => {
    expect(ourLineAsks(`${QUOTE.uz} ${EXCLUSION_SENTENCE.uz}`)).toBe(false);
    expect(ourLineAsks('Yukingiz keldi. 🙂')).toBe(false);
    expect(ha('Yukingiz keldi.')).toEqual({ worthy: false, reason: 'closing' });
    expect(ourLineAsks(null)).toBe(false);
  });
});

describe('the head: rule 8 carries the offer, rule 11 the «ha», rules 17 and 18 — one copy of each, the same bytes', () => {
  const head = (persona = '') => stableHead({ styleGuide: null, facts: [], priceArmed: false, calcPricing: false, lessons: [], persona, aviaDays: AVIA_DAYS_DEFAULT });

  it('rule 8 carries the offer in every language, interpolated, as the LAST sentence of the reply — and Kashgar', () => {
    const h = head();
    const rule8 = h.slice(h.indexOf('\n8. '), h.indexOf('\n9. '));
    for (const l of AGENT_LOCALES) expect(rule8).toContain(CUSTOMS_OFFER_SENTENCE[l]);
    expect(rule8).toMatch(/ENG OXIRGI jumlasi/u);
    expect(rule8).toContain(KASHGAR_RULE);
    expect(KASHGAR_RULE).toContain(KASHGAR_REFUSAL);
  });

  it('rule 11 carries «ha → podklyuch»; rules 17 and 18 follow rule 16', () => {
    const h = head();
    const rule11 = h.slice(h.indexOf('\n11. '), h.indexOf('\n12. '));
    expect(rule11).toContain(CUSTOMS_YES_RULE);
    expect(CUSTOMS_YES_RULE).toContain('section="podklyuch"');
    expect(h).toContain(`16. Har run compose_reply bilan tugaydi.\n${BOT_ANSWER_RULE}\n${MEDIA_RULE}`);
    expect(BOT_ANSWER_RULE.startsWith('17. ')).toBe(true);
    expect(MEDIA_RULE.startsWith('18. ')).toBe(true);
  });

  it('two renders with one persona are byte-identical (ONE cache write); another persona is another head', () => {
    expect(head('Aziza')).toBe(head('Aziza'));
    expect(head('')).toBe(head(''));
    expect(head('Aziza')).not.toBe(head(''));
  });

  it('the source holds ONE copy of each sentence: policy.ts\'s constant, never retyped in another file of the agent', () => {
    const dir = 'src/modules/wms/agent';
    for (const file of readdirSync(dir).filter((f) => f.endsWith('.ts') && f !== 'policy.ts')) {
      const src = readFileSync(join(dir, file), 'utf8');
      for (const l of AGENT_LOCALES) expect(src.includes(CUSTOMS_OFFER_SENTENCE[l]), `${file} retypes the ${l} offer`).toBe(false);
    }
    // …and the Kashgar sentence lives in prompt.ts alone; the tools import it.
    for (const file of readdirSync(dir).filter((f) => f.endsWith('.ts') && f !== 'prompt.ts')) {
      expect(readFileSync(join(dir, file), 'utf8').includes(KASHGAR_REFUSAL), `${file} retypes the Kashgar sentence`).toBe(false);
    }
  });
});

describe('J24: Kashgar receives no cargo for now — the truck tool and the checklist say so; Horgos and Urumchi as before', () => {
  const measures: MeasureCandidate[] = [
    { ref: 'v1', kind: 'volume', value: 5, messageRef: '#1' },
    { ref: 'w1', kind: 'weight', value: 800, messageRef: '#1' },
  ];
  const env = (ctx: AgentContext): ToolEnv => ({
    ctx,
    day: '2026-11-20',
    aviaUsdPerKg: 17,
    kb: async () => [],
    chinaPlaces: async () => new Set(['Yiwu', 'Guangzhou']),
    priceArmed: true,
    calcArmed: false,
    calcPricing: false,
    aviaDays: AVIA_DAYS_DEFAULT,
  });
  const truck = (line: string) => runTool('yolkira_estimate', { weight_ref: 'w1', volume_ref: 'v1' }, env(chat([line], measures)));
  const checklist = (line: string, section: string) =>
    runTool('calc_checklist', { section, goods: [{ name: 'Kiyim', quantity: null, unit: null, weight_kg: 800 }] }, env(chat([line], measures)));

  it('a Kashgar origin: refused with his words — no price, no job — in every spelling', async () => {
    for (const line of ['Qashqardan 5 kub 800 kg yuk bor, narxi?', 'Из Кашгара 5 кубов 800 кг', 'From Kashgar, 5 cbm 800 kg', '从喀什发5立方800公斤']) {
      const out = await truck(line);
      expect(out, line).toMatchObject({ ok: false, text: KASHGAR_REFUSAL });
      expect(out.estimate).toBeUndefined();
    }
  });

  it('Horgos and Urumchi keep today\'s refusal — «send it to the VED» — never Kashgar\'s words', async () => {
    for (const line of ['Xorgosdan 5 kub 800 kg', 'Urumchidan 5 kub 800 kg']) {
      const out = await truck(line);
      expect(out.ok).toBe(false);
      expect(out.text, line).toContain('hisoblatishga yuborish kerak');
      expect(out.text).not.toContain(KASHGAR_REFUSAL);
    }
  });

  it('Qashqadaryo is a destination, not Kashgar: a Yiwu load to it is priced as ever (no Kashgar refusal)', async () => {
    const out = await truck('Ivudan Qashqadaryoga 5 kub 800 kg');
    expect(out.text).not.toContain(KASHGAR_REFUSAL);
  });

  it('the checklist answers a Kashgar truck job the way it answers the truck minimum: never complete, his words', async () => {
    for (const section of ['yolkira', 'podklyuch']) {
      const out = await checklist('Qashqardan 5 kub 800 kg kiyim, podklyuch kerak', section);
      expect(out, section).toMatchObject({ ok: true, text: KASHGAR_REFUSAL });
      expect(out.checklist?.complete).toBe(false);
    }
  });

  it('…a rastamojka-only job and a Horgos truck job are not Kashgar\'s', async () => {
    expect((await checklist('Qashqardan kiyim, faqat rastamojka', 'rastamojka')).text).not.toContain(KASHGAR_REFUSAL);
    expect((await checklist('Xorgosdan 5 kub 800 kg kiyim', 'podklyuch')).text).not.toContain(KASHGAR_REFUSAL);
  });
});
