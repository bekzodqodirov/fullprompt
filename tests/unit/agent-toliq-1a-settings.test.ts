import { readFileSync } from 'node:fs';
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
