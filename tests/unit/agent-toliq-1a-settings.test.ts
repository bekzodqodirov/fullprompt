import { readFileSync } from 'node:fs';
import { createTranslator } from 'next-intl';
import { describe, expect, it } from 'vitest';
import en from '../../messages/en.json';
import ru from '../../messages/ru.json';
import uz from '../../messages/uz.json';
import zh from '../../messages/zh-CN.json';
import {
  AGENT_1A_BOUNDS,
  aviaDaysRange,
  isOwnDoorKey,
  OWN_DOOR_KEYS,
  OWN_DOOR_PAGES,
  personaNameValid,
  SETTING_DEFAULTS,
  SETTING_VALIDATORS,
  type SettingKey,
} from '@/modules/platform/settings/service';
import {
  AUTO_SEND_CATEGORIES,
  AUTO_WAITS,
  autoTicksOf,
  autoTicksOfWaits,
  autoWaitsKey,
  autoWaitsOf,
  type AutoWaits,
} from '@/modules/wms/agent/auto-categories';
import { autoArmedWords, autoMediaWords } from '@/modules/wms/agent/bot-door';

/**
 * Stage 1a's settings (docs/ai-toliq/qurish/STAGE-0-1A.md §3.3, J2, J20): each key has today's default — HIS answers,
 * not a builder's — a shape that refuses what is out of range, an own door (the generic /admin/settings form never
 * writes them), and its words in all four bundles. The kernel lands the key; the package that draws the box writes
 * it — so the shapes here are the one rule the writers will ask.
 */

const BUNDLES = { ru, uz, en, 'zh-CN': zh } as Record<string, unknown>;
type Tree = { [key: string]: string | Tree };
const at = (tree: unknown, path: string) =>
  path.split('.').reduce<unknown>((node, part) => (node && typeof node === 'object' ? (node as Tree)[part] : undefined), tree);

/** Key → its door's page and its default (§3.3's table, J2's avia days). */
const KEYS: Record<string, { page: 'agentAi' | 'taqsimot'; default: unknown }> = {
  agent_persona_name: { page: 'agentAi', default: '' },
  // His ⭐ a of question 82: talk goes at once.
  agent_talk_hold_sec: { page: 'agentAi', default: 0 },
  // His ⭐ a of question 1.
  agent_night_prices: { page: 'agentAi', default: 'table' },
  agent_big_cargo_m3: { page: 'agentAi', default: 20 },
  agent_big_cargo_words: { page: 'agentAi', default: true },
  agent_liveness_minutes: { page: 'agentAi', default: 10 },
  // His 2 b: «3-5 kun».
  agent_avia_days: { page: 'agentAi', default: '3-5' },
  client_ai_contact: { page: 'agentAi', default: false },
  // His ⭐ 1 of question 5: switched on after stage 2.
  lead_assign_ai: { page: 'taqsimot', default: 'off' },
};

const valid = (key: string, raw: string) => SETTING_VALIDATORS[key as SettingKey]!(raw);

describe('stage 1a’s settings keys (§3.3)', () => {
  it('each exists with his default, has a shape, and an own door on its page', () => {
    for (const [key, spec] of Object.entries(KEYS)) {
      expect(SETTING_DEFAULTS[key as SettingKey], key).toEqual(spec.default);
      expect(SETTING_VALIDATORS[key as SettingKey], key).toBeTypeOf('function');
      expect(isOwnDoorKey(key), key).toBe(true);
      expect(OWN_DOOR_KEYS[key as keyof typeof OWN_DOOR_KEYS], key).toBe(spec.page);
      // The default itself passes its own shape — a shape that refused its default would read every server as broken.
      expect(valid(key, String(spec.default)), `${key} default`).toBe(true);
    }
    // J20: the website's choice lives on the roster page it bypasses — a THIRD page value, with its link.
    expect(OWN_DOOR_PAGES.taqsimot).toBe('/admin/taqsimot');
  });

  it('every key is described, and every page’s link is worded, in all four bundles', () => {
    for (const [locale, bundle] of Object.entries(BUNDLES)) {
      for (const key of Object.keys(KEYS)) expect(at(bundle, `settings.descriptions.${key}`), `${locale} ${key}`).toBeTypeOf('string');
      expect(at(bundle, 'settings.ownDoorPage.taqsimot'), locale).toBeTypeOf('string');
    }
  });

  it('the generic page names each key’s refusal in its own words, and those words exist ×4 (J20)', () => {
    const page = readFileSync('src/app/(protected)/admin/settings/page.tsx', 'utf8');
    for (const key of Object.keys(KEYS)) {
      const word = new RegExp(`\\b${key}: '(badValue\\w+)'`, 'u').exec(page)?.[1];
      expect(word, key).toBeTruthy();
      for (const [locale, bundle] of Object.entries(BUNDLES)) expect(at(bundle, `settings.${word}`), `${locale} ${word}`).toBeTypeOf('string');
    }
  });
});

describe('the shapes refuse what is out of range', () => {
  it('the talk hold: a whole number of seconds 0..600', () => {
    for (const ok of ['0', '1', '120', '600']) expect(valid('agent_talk_hold_sec', ok), ok).toBe(true);
    for (const bad of ['', '-1', '601', '1.5', '05', ' 1', 'abc', '1e2']) expect(valid('agent_talk_hold_sec', bad), bad).toBe(false);
    expect(AGENT_1A_BOUNDS.talkHoldMax).toBe(600);
  });

  it('the night: none | table | all', () => {
    for (const ok of ['none', 'table', 'all']) expect(valid('agent_night_prices', ok), ok).toBe(true);
    for (const bad of ['', 'Table', 'off', 'price', 'all ']) expect(valid('agent_night_prices', bad), bad).toBe(false);
  });

  it('the big-cargo line: a whole number of kub 0..200 (0 = no size signal)', () => {
    for (const ok of ['0', '20', '200']) expect(valid('agent_big_cargo_m3', ok), ok).toBe(true);
    for (const bad of ['', '201', '-5', '20.5', '020']) expect(valid('agent_big_cargo_m3', bad), bad).toBe(false);
  });

  it('the liveness minutes: 0 (off), or 3..120 — 1 and 2 are refused (a healthy run would alarm)', () => {
    for (const ok of ['0', '3', '10', '120']) expect(valid('agent_liveness_minutes', ok), ok).toBe(true);
    for (const bad of ['1', '2', '121', '', '-3', '3.5', '03']) expect(valid('agent_liveness_minutes', bad), bad).toBe(false);
  });

  it('the yes / no keys take the two words their writer posts', () => {
    for (const key of ['agent_big_cargo_words', 'client_ai_contact']) {
      expect(valid(key, 'true') && valid(key, 'false'), key).toBe(true);
      for (const bad of ['', 'on', 'yes', '1', 'TRUE']) expect(valid(key, bad), `${key} ${bad}`).toBe(false);
    }
  });

  it('the website’s choice: off | all', () => {
    for (const ok of ['off', 'all']) expect(valid('lead_assign_ai', ok), ok).toBe(true);
    for (const bad of ['', 'on', 'cargo', 'buying', 'ALL']) expect(valid('lead_assign_ai', bad), bad).toBe(false);
  });

  it('the avia days: «N-M» whole days, 1 ≤ N < M ≤ 60 — a range, never one figure (J2)', () => {
    expect(aviaDaysRange('3-5')).toEqual({ min: 3, max: 5 });
    expect(aviaDaysRange('1-60')).toEqual({ min: 1, max: 60 });
    for (const bad of ['', '5', '5-3', '3-3', '0-5', '3-61', '3–5', '3 - 5', '03-5', '3-5 ', 'uch-besh']) {
      expect(aviaDaysRange(bad), bad).toBeNull();
      expect(valid('agent_avia_days', bad), bad).toBe(false);
    }
  });

  it('the persona’s name: letters and single spaces, an Uzbek apostrophe inside a word, at most 40', () => {
    for (const ok of ['', 'Sardor', 'Ra’no', 'G‘ayrat', "Ra'no", 'Дилноза', 'Ali Vali', '阿里']) expect(personaNameValid(ok), ok).toBe(true);
    for (const bad of ['Ali  Vali', ' Ali', 'Ali ', 'Ali1', 'Ali.', '‘Ali', 'Ali‘', 'Ali 🙂', 'A'.repeat(41)]) {
      expect(personaNameValid(bad), bad).toBe(false);
    }
    expect(personaNameValid('A'.repeat(40))).toBe(true);
  });
});

/**
 * J26: every word the stage's packages draw lands in the kernel, in all four bundles — five packages adding keys to
 * the same four files would be five certain cherry-pick conflicts. Anchored on this list, outside the bundles
 * (#163: comparing the bundles to each other cannot see a key missing from all four).
 */
const PAGE_KEYS = [
  'agentAi.section.kimga',
  'agentAi.section.tekshiruv',
  'agentAi.topic.supervisor',
  'agentAi.topic.big_cargo',
  'agentAi.topicHint.supervisor',
  'agentAi.topicHint.big_cargo',
  'agentAi.kimgaHint',
  'agentAi.kimgaUnset',
  'agentAi.kimgaSource.supervisor',
  'agentAi.kimgaSource.alarm',
  'agentAi.kimgaNoPage',
  'agentAi.kimgaHolderReach',
  'agentAi.ownerDisconnected',
  'agentAi.autoTalkHoldLabel',
  'agentAi.autoTalkHoldHint',
  'agentAi.autoPriceHoldLabel',
  'agentAi.autoPriceHoldHint',
  'agentAi.autoNightLabel',
  'agentAi.autoNight.none',
  'agentAi.autoNight.table',
  'agentAi.autoNight.all',
  'agentAi.personaTitle',
  'agentAi.personaHint',
  'agentAi.bigCargoM3Label',
  'agentAi.bigCargoWordsLabel',
  'agentAi.livenessLabel',
  'agentAi.livenessStanding',
  'agentAi.sampleGood',
  'agentAi.sampleBad',
  'agentAi.clientContactLabel',
  'agentAi.aviaDaysLabel',
  'routing.site.aiTitle',
  'routing.site.aiCannot',
  'broadcast.noManager',
  'kuzatuv.homeAiLiveness',
];

describe('the stage’s words are in the kernel (J26, J34)', () => {
  it('every page word the packages draw exists in all four bundles', () => {
    for (const [locale, bundle] of Object.entries(BUNDLES)) {
      for (const key of PAGE_KEYS) expect(at(bundle, key), `${locale} ${key}`).toBeTypeOf('string');
    }
  });

  it('the box promised for his answer 82 is named as he was told (J34)', () => {
    expect(at(uz, 'agentAi.autoTalkHoldLabel')).toBe('Oddiy javob kutishi (soniya)');
  });

  it('the confidence floor’s words are gone, and the numbers line no longer says it (J22, J26)', () => {
    for (const [locale, bundle] of Object.entries(BUNDLES)) {
      expect(at(bundle, 'agentAi.autoConfidenceLabel'), locale).toBeUndefined();
      expect(at(bundle, 'agentAi.autoConfidenceHint'), locale).toBeUndefined();
      for (const key of ['agentAi.autoNumbers', 'agentAi.autoNumbersNoCap']) {
        const text = at(bundle, key) as string;
        expect(text, `${locale} ${key}`).not.toContain('{confidence}');
        expect(text, `${locale} ${key}`).toContain('{talk}');
        expect(text, `${locale} ${key}`).toContain('{priceHold}');
      }
    }
    const page = readFileSync('src/app/(protected)/suhbatlar/ai/page.tsx', 'utf8');
    expect(page).not.toMatch(/confidence:\s*Math\.round/u);
    expect(page).toMatch(/t\('autoNumbers', \{\s*talk: talkWords\(t, talkHoldSec\),\s*priceHold: holdWords\(t, c\.holdSec\)/u);
  });

  it('the avia rule on the page says the range alone — no «reys bo‘lsa» clause (J2)', () => {
    for (const [locale, bundle] of Object.entries(BUNDLES)) {
      const text = at(bundle, 'agentAi.ruleAviaMin') as string;
      expect(text.match(/\{min\}/gu)?.length, locale).toBe(1);
      expect(text, locale).toContain('{max}');
    }
  });

  it('the token cap is called a loop guard, never a budget (§4.6)', () => {
    for (const key of ['agentAi.numTokensHint', 'agentAi.todayTokens', 'agentAi.lessonsCost']) {
      expect(at(uz, key) as string, key).not.toMatch(/byudjet/iu);
      expect(at(ru, key) as string, key).not.toMatch(/бюджет/iu);
      expect(at(en, key) as string, key).not.toMatch(/budget/iu);
      expect(at(zh, key) as string, key).not.toMatch(/预算/u);
      expect(at(uz, key) as string, key).toContain('pul chegarasi emas');
    }
  });
});

/**
 * The merged-tree seam review, findings 3 and 5: the page told him two things the code does not do — that a reply to a
 * photo or a file ALWAYS stays his (the tayyor matn to it goes by itself), and that a price waits on its card when no
 * price box is ticked (no price goes by itself at all then). Each page sentence is rendered here, in all four bundles,
 * from the ticked kinds the page passes — what the bot's own words (`autoArmedWords`) say.
 */
describe('the page’s arming words follow the boxes he ticked, and say what the tayyor matn does (findings 3, 5)', () => {
  /** Tokens no bundle could carry by itself — so a rendered hold is ours, never a word of the sentence. */
  const TALK = 'TALKX';
  const HOLD = 'HOLDX';
  const render = (locale: string, waits: AutoWaits) => {
    const t = createTranslator({ locale, messages: BUNDLES[locale] as never, namespace: 'agentAi' as never }) as unknown as (
      key: string,
      values?: Record<string, unknown>,
    ) => string;
    return {
      numbers: t('autoNumbers', { talk: TALK, priceHold: HOLD, waits, perDay: 30, maxChars: 400 }),
      noCap: t('autoNumbersNoCap', { talk: TALK, priceHold: HOLD, waits, maxChars: 400 }),
      confirm: t('autoArmConfirm', { waits }),
    };
  };

  it('one rule for what waits: each ticked box by name — a table price, a VED price, a calculation — or nothing', () => {
    // DELIBERATE EDIT (the independent check of the seam fixes, F3): the two price boxes are two keys now — one key for
    // «a price» let the page say «only a complaint stays yours» with only «VED narxi» ticked, while the table price did.
    expect(autoWaitsOf(['greeting', 'faq'])).toBe('none');
    expect(autoWaitsOf(['price'])).toBe('table');
    expect(autoWaitsOf(['calc_price'])).toBe('ved');
    expect(autoWaitsOf(['price', 'calc_price'])).toBe('prices');
    expect(autoWaitsOf(['calc'])).toBe('calc');
    expect(autoWaitsOf(['price', 'calc'])).toBe('table_calc');
    expect(autoWaitsOf(['calc_price', 'calc'])).toBe('ved_calc');
    expect(autoWaitsOf([...AUTO_SEND_CATEGORIES])).toBe('all');
    // The key and the ticks are one fact read two ways — every key stands for exactly its ticks.
    for (const w of AUTO_WAITS) expect(autoWaitsKey(autoTicksOfWaits(w)), w).toBe(w);
  });

  it('the price hold and ⏸ are said only beside a ticked box — in every bundle', () => {
    for (const locale of Object.keys(BUNDLES)) {
      for (const waits of AUTO_WAITS) {
        const r = render(locale, waits);
        const held = waits !== 'none';
        for (const [name, text] of Object.entries({ numbers: r.numbers, noCap: r.noCap })) {
          expect(text, `${locale} ${name} ${waits}`).toContain(TALK);
          expect(text.includes(HOLD), `${locale} ${name} ${waits}`).toBe(held);
          expect(text.includes('⏸'), `${locale} ${name} ${waits}`).toBe(held);
          expect(text, `${locale} ${name} ${waits}`).not.toMatch(/[{}]/u);
        }
        expect(r.confirm.includes('⏸'), `${locale} confirm ${waits}`).toBe(held);
        expect(r.confirm, `${locale} confirm ${waits}`).not.toMatch(/[{}]/u);
      }
    }
  });

  it('…and in his own words: nothing ticked, the price stays his; a ticked price waits, by name', () => {
    expect(render('uz', 'none').numbers).toContain('narx va shikoyat har doim sizga qoladi');
    expect(render('uz', 'none').numbers).not.toMatch(/narx \S+ kutadi/u);
    // DELIBERATE EDIT (F3): «Narx» alone names the table price, and the VED price it does not send stays his.
    expect(render('uz', 'table').numbers).toContain(`yo‘lkira va avia narxi ${HOLD} kutadi, ⏸ bilan to‘xtatasiz`);
    expect(render('uz', 'table').numbers).toContain('VED narxi va shikoyat har doim sizga qoladi');
    expect(render('uz', 'prices').numbers).toContain(`narx ${HOLD} kutadi, ⏸ bilan to‘xtatasiz`);
    expect(render('uz', 'prices').numbers).not.toContain('narx va shikoyat');
    expect(render('uz', 'calc').numbers).toContain(`hisoblatish ${HOLD} kutadi`);
    expect(render('uz', 'calc').numbers).toContain('narx va shikoyat har doim sizga qoladi');
    expect(render('uz', 'all').numbers).toContain(`narx va hisoblatish ${HOLD} kutadi`);
    expect(render('uz', 'none').confirm).toContain('Narx va shikoyat har doim sizga qoladi.');
    expect(render('uz', 'none').confirm).not.toContain('Narx kartada kutadi');
    expect(render('uz', 'prices').confirm).toContain('Narx kartada kutadi — ⏸ bilan to‘xtatasiz; shikoyat har doim sizga qoladi.');
    expect(render('uz', 'ved').confirm).toContain('VED narxi kartada kutadi — ⏸ bilan to‘xtatasiz; yo‘lkira va avia narxi va shikoyat har doim sizga qoladi.');
  });

  it('the page passes the ticked kinds to all three — never a sentence rendered without them', () => {
    const page = readFileSync('src/app/(protected)/suhbatlar/ai/page.tsx', 'utf8');
    expect(page).toMatch(/const waits = autoWaitsOf\(c\.categories\);/u);
    expect(page).toMatch(/t\('autoNumbersNoCap', \{[^}]*\bwaits\b[^}]*\}\)/u);
    expect(page).toMatch(/t\('autoNumbers', \{[^}]*\bwaits,[^}]*\}\)/u);
    expect(page).toMatch(/<AutoArmButtons [^>]*waits=\{waits\}/u);
    const ui = readFileSync('src/app/(protected)/suhbatlar/ai/agent-ui.tsx', 'utf8');
    expect(ui).toContain("window.confirm(t('autoArmConfirm', { waits }))");
  });

  it('a photo, a file or a voice note: the page and the bot say the same — the AI’s reply stays his, the tayyor matn goes', () => {
    const hint = at(uz, 'agentAi.autoHint') as string;
    // DELIBERATE EDIT (the check of the F1-F3 fixes, R3): the gate keeps the AI's reply to a VOICE note beside his text
    // his as well (`burstMedia` counts every kept file), so the AI's half names it, in all four.
    expect(hint).toContain('rasm, ovoz yoki fayl kelgan xabarga AI yozgan javob sizga qoladi');
    expect(hint).not.toContain('rasm yoki faylli xabarga AI');
    expect(at(ru, 'agentAi.autoHint') as string).toContain('ответ ИИ на сообщение с фото, голосовым или файлом остаётся за вами');
    expect(at(en, 'agentAi.autoHint') as string).toContain('the AI’s reply to a message with a photo, voice note or file stays with you');
    expect(at(zh, 'agentAi.autoHint') as string).toContain('AI 对带图片、语音或文件的消息的回复由您处理');
    expect(hint).toContain('rasm, ovoz yoki faylga «yozib yuboring» degan tayyor matn o‘zi ketadi');
    // The old promise — «a reply to a photo or a file always stays yours» — is gone from all four.
    expect(hint).not.toContain('rasm yoki faylga javob');
    expect(at(ru, 'agentAi.autoHint') as string).not.toContain('ответы на фото или файл');
    expect(at(en, 'agentAi.autoHint') as string).not.toContain('replies to a photo or file');
    expect(at(zh, 'agentAi.autoHint') as string).not.toContain('对图片或文件的回复、');
    expect(at(ru, 'agentAi.autoHint') as string).toContain('готовый текст «напишите текстом» на фото, голосовое или файл уходит сам');
    expect(at(en, 'agentAi.autoHint') as string).toContain('the ready-made «please type it» line to a photo, voice note or file goes by itself');
    expect(at(zh, 'agentAi.autoHint') as string).toContain('对图片、语音或文件回复的「请用文字发送」固定话术会自动发出');
    // The bot's one clause carries both halves, in the hint's own words — whatever he ticked.
    for (const w of AUTO_WAITS) {
      const words = autoMediaWords(autoTicksOfWaits(w));
      expect(words, w).toContain('rasm, ovoz yoki fayl kelgan xabarga AI yozgan javob sizga qoladi');
      expect(words, w).toContain('rasm, ovoz yoki faylga «yozib yuboring» degan tayyor matn esa o‘zi ketadi');
    }
  });
});

/** Every combination of the three boxes he ticks, beside the four kinds the writer always stores. */
const TICKABLE = ['price', 'calc_price', 'calc'] as const;
const COMBOS: readonly string[][] = [0, 1, 2, 3, 4, 5, 6, 7].map((bits) => [
  'greeting',
  'qualification',
  'faq',
  'status',
  ...TICKABLE.filter((_, i) => (bits >> i) & 1),
]);
const TALK_NOW = { talkHoldSec: 0, nightPrices: 'table' as const };
const BOT = (categories: readonly string[]) => autoArmedWords({ holdSec: 120, perDay: null, categories: [...categories] }, TALK_NOW);

type Item = 'table' | 'ved' | 'calc' | 'complaint';
const esc = (w: string) => w.replace(/[.*+?^${}()|[\]\\]/gu, '\\$&');

/**
 * A reader of each language's own nouns — what a phrase MEANS, never which key drew it: a table price («Narx», with
 * his avia rate), the VED's price, both prices said as one («narx»), a calculation, a complaint. Longest first, so «VED
 * narxi» is read before «narx»; joining words carry nothing; a word left over fails the reading, so a sentence that
 * grew a reply the reader does not know is red rather than half read.
 */
const NOUNS: Record<string, { words: readonly (readonly [string, readonly Item[]])[]; glue: readonly string[]; han?: boolean }> = {
  uz: {
    words: [
      ['yo‘lkira va avia narxi', ['table']],
      ['hisoblatishga yuborish', ['calc']],
      ['VED narxi', ['ved']],
      ['hisoblatish', ['calc']],
      ['shikoyat', ['complaint']],
      ['narx', ['table', 'ved']],
    ],
    glue: ['va', 'hamda'],
  },
  ru: {
    words: [
      ['цена по таблице', ['table']],
      ['цена ВЭД', ['ved']],
      ['расчёт', ['calc']],
      ['жалобы', ['complaint']],
      ['цена', ['table', 'ved']],
    ],
    glue: ['и'],
  },
  en: {
    words: [
      ['a customs desk price', ['ved']],
      ['customs desk prices', ['ved']],
      ['a table price', ['table']],
      ['table prices', ['table']],
      ['a calculation', ['calc']],
      ['complaints', ['complaint']],
      ['a price', ['table', 'ved']],
      ['prices', ['table', 'ved']],
    ],
    glue: ['and'],
  },
  'zh-CN': {
    words: [
      ['运价表报价', ['table']],
      ['报关部报价', ['ved']],
      ['核算请求', ['calc']],
      ['投诉', ['complaint']],
      ['报价', ['table', 'ved']],
    ],
    glue: ['和'],
    han: true,
  },
};

function readItems(locale: string, phrase: string | null): Set<Item> {
  const items = new Set<Item>();
  if (phrase === null) return items;
  const { words, glue, han } = NOUNS[locale]!;
  const bound = (w: string) => new RegExp(han ? esc(w) : `(?<![\\p{L}])${esc(w)}(?![\\p{L}])`, 'giu');
  let rest = phrase;
  for (const [w, its] of words) {
    if (bound(w).test(rest)) {
      for (const i of its) items.add(i);
      rest = rest.replace(bound(w), ' ');
    }
  }
  for (const g of glue) rest = rest.replace(bound(g), ' ');
  expect(rest.trim(), `${locale}: «${phrase}» read whole`).toBe('');
  return items;
}

/**
 * The two halves of each sentence — what waits on its card, what always stays his — as each language writes them. The
 * waiting half's second group is the calculation's night (the check of the F1-F3 fixes, R4: the gate's `nightBars`
 * holds a calculation for the morning under every night setting), said beside it exactly when a calculation waits.
 */
const HALVES: Record<string, { numbers: [RegExp, RegExp]; confirm: [RegExp, RegExp] }> = {
  uz: {
    numbers: [/kechasi ham · (.+?) HOLDX kutadi(?: \(((?:hisoblatish )?kechasi — ertalab)\))?, ⏸ bilan to‘xtatasiz · /u, /· ([^·]+) har doim sizga qoladi$/u],
    confirm: [/\)\. (.+?) kartada kutadi(?: \(((?:hisoblatish )?kechasi — ertalab)\))? — ⏸ bilan to‘xtatasiz; /u, /(?:; |\)\. )([^;)]+) har doim sizga qoladi\.$/u],
  },
  ru: {
    numbers: [/и ночью тоже · (.+?) (?:ждёт|ждут) HOLDX(?: \(((?:расчёт )?ночью — до утра)\))?, остановить — ⏸ · /u, /· ([^·]+) всегда остаются за вами$/u],
    confirm: [/\)\. (.+?) (?:ждёт|ждут) на карточке(?: \(((?:расчёт )?ночью — до утра)\))? — остановить можно ⏸; /u, /(?:; |\)\. )([^;)]+) всегда остаются за вами\.$/u],
  },
  en: {
    numbers: [/at night too · (.+?) (?:waits|wait) HOLDX(?: \(((?:a calculation )?at night, until the morning)\))?, ⏸ stops (?:it|them) · /u, /· ([^·]+) always stay with you$/u],
    confirm: [/\)\. (.+?) (?:waits|wait) on (?:its|their) card(?: \(((?:a calculation )?at night, until the morning)\))? — ⏸ stops (?:it|them); /u, /(?:; |\)\. )([^;)]+) always stay with you\.$/u],
  },
  'zh-CN': {
    numbers: [/夜间也是 · (.+?)等待 HOLDX(?:（((?:核算请求)?夜间等到早上)）)?，可用 ⏸ 停止 · /u, /· ([^·]+)始终由您处理$/u],
    confirm: [/）。(.+?)会在卡片上等待(?:（((?:核算请求)?夜间等到早上)）)? — 可用 ⏸ 停止；/u, /(?:；|）。)([^；）]+)始终由您处理。$/u],
  },
};

const half = (re: RegExp, text: string): string | null => re.exec(text)?.[1] ?? null;
/** The calculation's night beside what waits — null when the sentence says none. */
const calcNight = (re: RegExp, text: string): string | null => re.exec(text)?.[2] ?? null;
const sorted = (s: Set<Item>) => [...s].sort();

/** What his ticks make wait, and what they leave his — the gate's own classes (`holdSecFor`, the money clause's boxes). */
function expected(categories: readonly string[]): { waits: Item[]; stays: Item[] } {
  const t = autoTicksOf(categories);
  const waits: Item[] = [...(t.table ? (['table'] as const) : []), ...(t.ved ? (['ved'] as const) : []), ...(t.calc ? (['calc'] as const) : [])];
  const stays: Item[] = [...(t.table ? [] : (['table'] as const)), ...(t.ved ? [] : (['ved'] as const)), 'complaint'];
  return { waits: waits.sort(), stays: stays.sort() };
}

/**
 * The independent check of the seam fixes, F3: with only «VED narxi» ticked the page said «narx … kutadi» and «only a
 * complaint stays yours» — and its hint «a price goes only when «Narx» is ticked» — while the bot and the gate sent the
 * VED price and kept the table price his. One key now (`autoWaitsOf`), read by the page's selects and the bot alike;
 * every bundle and the bot are rendered here for every combination of the three boxes, READ by each language's nouns,
 * and held to what the ticks mean: each ticked box waits, each unticked price stays his, a complaint always does.
 */
describe('the page and the bot agree on what waits and what stays his, for every tick (the check’s F3)', () => {
  const render = (locale: string, categories: readonly string[]) => {
    const t = createTranslator({ locale, messages: BUNDLES[locale] as never, namespace: 'agentAi' as never }) as unknown as (
      key: string,
      values?: Record<string, unknown>,
    ) => string;
    const waits = autoWaitsOf(categories);
    return {
      numbers: t('autoNumbers', { talk: 'TALKX', priceHold: 'HOLDX', waits, perDay: 30, maxChars: 400 }),
      noCap: t('autoNumbersNoCap', { talk: 'TALKX', priceHold: 'HOLDX', waits, maxChars: 400 }),
      confirm: t('autoArmConfirm', { waits }),
    };
  };

  it.each(COMBOS.map((c) => [c.slice(4).join('+') || 'nothing', c] as const))('%s ticked — every bundle', (_, categories) => {
    const want = expected(categories);
    for (const locale of Object.keys(BUNDLES)) {
      const r = render(locale, categories);
      const h = HALVES[locale]!;
      const calc = autoTicksOf(categories).calc;
      for (const [name, text] of [['numbers', r.numbers], ['noCap', r.noCap]] as const) {
        expect(sorted(readItems(locale, half(h.numbers[0], text))), `${locale} ${name} waits: ${text}`).toEqual(want.waits);
        expect(sorted(readItems(locale, half(h.numbers[1], text))), `${locale} ${name} stays: ${text}`).toEqual(want.stays);
        expect(calcNight(h.numbers[0], text) !== null, `${locale} ${name} the calculation's night: ${text}`).toBe(calc);
      }
      expect(sorted(readItems(locale, half(h.confirm[0], r.confirm))), `${locale} confirm waits: ${r.confirm}`).toEqual(want.waits);
      expect(sorted(readItems(locale, half(h.confirm[1], r.confirm))), `${locale} confirm stays: ${r.confirm}`).toEqual(want.stays);
      expect(calcNight(h.confirm[0], r.confirm) !== null, `${locale} confirm the calculation's night: ${r.confirm}`).toBe(calc);
    }
  });

  it.each(COMBOS.map((c) => [c.slice(4).join('+') || 'nothing', c] as const))('%s ticked — the bot says the same', (_, categories) => {
    const want = expected(categories);
    const words = BOT(categories);
    const waits = /\)\. (.+?) kartada \d+ daqiqa kutadi, keyin o‘zi ketadi/u.exec(words)?.[1] ?? null;
    const stays = /; ([^;]+) har doim sizga qoladi;/u.exec(words)?.[1] ?? null;
    expect(sorted(readItems('uz', waits)), `bot waits: ${words}`).toEqual(want.waits);
    expect(sorted(readItems('uz', stays)), `bot stays: ${words}`).toEqual(want.stays);
    // …and what may go by itself is exactly what waits: each ticked box's own «o‘zi ketadi», and no other.
    const t = autoTicksOf(categories);
    expect(words.includes('taxminiy yo‘lkira va avia narxi qoidalar ruxsat bersa o‘zi ketadi'), words).toBe(t.table);
    expect(words.includes('VED javobidagi narx'), words).toBe(t.ved);
    expect(words.includes('hisoblatish so‘rovi qoidalar ruxsat bersa VEDga o‘zi ketadi'), words).toBe(t.calc);
  });

  it('the page’s hint names each price by its own box — never «a price goes only under «Narx»» beside a VED price that goes', () => {
    expect(at(uz, 'agentAi.autoHint') as string).toContain('yo‘lkira va avia narxi faqat «Narx», VED narxi faqat «VED narxi» belgilansa o‘zi ketadi');
    expect(at(ru, 'agentAi.autoHint') as string).toContain('цена по таблице уходит сама, только если отмечено «Цена», цена ВЭД — только если отмечено «Цена ВЭД»');
    expect(at(en, 'agentAi.autoHint') as string).toContain('a table price goes by itself only when «Price» is ticked, a customs desk price only when «Customs price» is ticked');
    expect(at(zh, 'agentAi.autoHint') as string).toContain('运价表报价仅在勾选「价格」时自动发送，报关部报价仅在勾选「报关价格」时自动发送');
    expect(at(uz, 'agentAi.autoHint') as string).not.toContain('narx — faqat «Narx» belgilansa');
    // The boxes it names are the page's own labels (`agentAi.category.*`), in every bundle.
    for (const [locale, bundle] of Object.entries(BUNDLES)) {
      const hint = at(bundle, 'agentAi.autoHint') as string;
      for (const box of ['price', 'calc_price'])
        expect(hint, `${locale} ${box}`).toContain(`${String(at(bundle, `agentAi.category.${box}`)).replace(/\s*[(（].*$/u, '')}`);
    }
  });
});

/**
 * The independent check of the seam fixes, F2: the words said the AI's reply to a burst with a photo or a file always
 * stays his — but the gate never asks a calculation sent to the VED that (the invoice IS the job's material, pinned in
 * agent-auto-gate.test.ts), and asks a VED price only over the files newer than the job's landing (agent-full-p2-price).
 * The bot (which knows his ticks) names those two only when they may go; the page (one hint for every tick) states the
 * exception as a rule.
 */
describe('a photo or a file: the exceptions are named, and only where they are true (the check’s F2)', () => {
  it.each(COMBOS.map((c) => [c.slice(4).join('+') || 'nothing', c] as const))('%s ticked — the bot', (_, categories) => {
    const t = autoTicksOf(categories);
    const words = BOT(categories);
    expect(words).toContain(autoMediaWords(t));
    const except = /AI yozgan javob sizga qoladi \(([^)]+?) bundan mustasno — so‘rov bilan VEDga ketgan fayl (?:uni|ularni) to‘xtatmaydi\)/u.exec(words)?.[1] ?? null;
    expect(sorted(readItems('uz', except)), words).toEqual([...(t.calc ? ['calc'] : []), ...(t.ved ? ['ved'] : [])].sort());
    // Nothing that may not go is ever named as going.
    if (!t.calc && !t.ved) expect(words).not.toContain('bundan mustasno');
  });

  it('the page’s hint states it as a rule, in all four bundles', () => {
    expect(at(uz, 'agentAi.autoHint') as string).toContain(
      'rasm, ovoz yoki fayl kelgan xabarga AI yozgan javob sizga qoladi — hisoblatishga yuborish va VED narxi bundan mustasno: so‘rov bilan VEDga ketgan fayl ularni to‘xtatmaydi, ular belgilansa o‘zi ketadi',
    );
    expect(at(ru, 'agentAi.autoHint') as string).toContain(
      'ответ ИИ на сообщение с фото, голосовым или файлом остаётся за вами — кроме отправки на расчёт и цены ВЭД: файл, ушедший в ВЭД вместе с запросом, их не останавливает, и если они отмечены, уходят сами',
    );
    expect(at(en, 'agentAi.autoHint') as string).toContain(
      'the AI’s reply to a message with a photo, voice note or file stays with you — except a calculation sent to the customs desk and a customs desk price: a file that went to the customs desk with the request does not stop them, and when ticked they go by themselves',
    );
    expect(at(zh, 'agentAi.autoHint') as string).toContain(
      'AI 对带图片、语音或文件的消息的回复由您处理 — 发送核算请求和报关部报价除外：随请求一起发给报关部的文件不会拦下它们，勾选后会自动发出',
    );
  });
});

describe('the confidence floor’s orphan words are gone (J26)', () => {
  it('no bundle keeps `agentAi.errors.auto_bad_confidence` — nothing names it any more', () => {
    for (const [locale, bundle] of Object.entries(BUNDLES)) expect(at(bundle, 'agentAi.errors.auto_bad_confidence'), locale).toBeUndefined();
  });
});
