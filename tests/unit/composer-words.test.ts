import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';

/**
 * What the two composers — the card's (`telegram-reply.tsx`) and the dock's —
 * say when the ACCOUNT holds a reply (send review): Telegram's restriction
 * names the button that clears it, and Telegram's send wait — persisted
 * uncapped, so it can be hours — is said with its end, never as «Bir daqiqa
 * kuting».
 *
 * The bundles carried `crm.replyAccountPaused` TWICE in one object (two
 * packages each added it, the merge kept both): JSON keeps the LAST, so the
 * screen read the shorter words that never named «Tekshirdim», and nothing
 * could see it — `JSON.parse` and every bundle test only ever meet the
 * survivor. The scanner below reads the text itself.
 */

const LOCALES = ['ru', 'uz', 'zh-CN', 'en'] as const;
const raw = (locale: string) => readFileSync(`messages/${locale}.json`, 'utf8');
const crm = (locale: string) => (JSON.parse(raw(locale)) as { crm: Record<string, string> }).crm;
const strip = (src: string) => src.replace(/\/\*[\s\S]*?\*\//g, '').replace(/(^|[^:])\/\/.*$/gm, '$1');

/** Every key written twice in one object of a JSON text, as a dotted path. */
function duplicateKeys(text: string): string[] {
  type Frame = { array: boolean; keys: Set<string>; path: string; expectKey: boolean; lastKey: string };
  const out: string[] = [];
  const stack: Frame[] = [];
  const top = () => stack[stack.length - 1];
  for (let i = 0; i < text.length; i += 1) {
    const ch = text[i]!;
    if (ch === '"') {
      let j = i + 1;
      while (text[j] !== '"') j += text[j] === '\\' ? 2 : 1;
      const frame = top();
      if (frame && !frame.array && frame.expectKey) {
        const key = JSON.parse(text.slice(i, j + 1)) as string;
        if (frame.keys.has(key)) out.push(`${frame.path}${key}`);
        frame.keys.add(key);
        frame.lastKey = key;
        frame.expectKey = false;
      }
      i = j;
    } else if (ch === '{' || ch === '[') {
      const parent = top();
      const path = parent ? `${parent.path}${parent.array ? '[]' : parent.lastKey}.` : '';
      stack.push({ array: ch === '[', keys: new Set(), path, expectKey: ch === '{', lastKey: '' });
    } else if (ch === '}' || ch === ']') {
      stack.pop();
    } else if (ch === ',') {
      const frame = top();
      if (frame && !frame.array) frame.expectKey = true;
    }
  }
  return out;
}

describe('the bundles hold each key once — a JSON duplicate is silently the last', () => {
  it('the scanner sees a duplicate, nested or not, and nothing else', () => {
    expect(duplicateKeys('{"a":{"b":"1","c":"x,y","b":"2"},"d":["e","f"],"g":"\\"h"}')).toEqual(['a.b']);
    expect(duplicateKeys('{"a":"1","b":{"a":"2"}}')).toEqual([]);
  });

  for (const locale of LOCALES) {
    it(`${locale}`, () => {
      expect(duplicateKeys(raw(locale))).toEqual([]);
    });
  }
});

describe('the composers say why the ACCOUNT holds a reply (send review)', () => {
  for (const locale of LOCALES) {
    it(`${locale}: the restriction names the bridge panel’s own button; the wait has its end`, () => {
      const words = crm(locale);
      // The button the words send him to, by its own label — not a paraphrase.
      expect(words.replyAccountPaused).toContain(words.pauseClear);
      expect(words.replyFloodWait).toContain('{when}');
      expect(words.replyFloodWaitUnknown).toBeTruthy();
      // An uncapped Telegram wait is never «a minute».
      expect(words.replyFloodWait).not.toBe(words.replyRateLimited);
      expect(words.replyFloodWaitUnknown).not.toBe(words.replyRateLimited);
    });
  }

  it('both composers map the hold through those words — the card from its SendContext, the dock from the route', () => {
    const card = strip(readFileSync('src/components/telegram-reply.tsx', 'utf8'));
    const dock = strip(readFileSync('src/components/dock.tsx', 'utf8'));
    const route = strip(readFileSync('src/app/api/dock/thread/route.ts', 'utf8'));
    for (const [name, src] of [
      ['telegram-reply', card],
      ['dock', dock],
    ] as const) {
      expect(src, name).toMatch(/account_paused: t\('replyAccountPaused'\)/u);
      expect(src, name).toMatch(/flood_wait: floodWords/u);
      expect(src, name).toMatch(/t\('replyFloodWait', \{ when: floodWhen \}\)/u);
      expect(src, name).not.toMatch(/flood_wait: t\('replyRateLimited'\)/u);
    }
    expect(card).toMatch(/agentSendAtLabel\(context\.floodWaitUntil\)/u);
    expect(dock).toMatch(/thread\?\.floodUntil/u);
    expect(route).toMatch(/floodUntil = context\.floodWaitUntil\?\.toISOString\(\)/u);
    expect(route).toMatch(/\n\s+floodUntil,\n/u);
  });
});
