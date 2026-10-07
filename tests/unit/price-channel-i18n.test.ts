import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';
import {
  FAIL_REASONS,
  POST_KINDS,
  POST_STATUSES,
  SKIP_REASONS,
} from '@/modules/wms/calc/channel-post';
import {
  CHANNEL_RIGHTS,
  PAUSE_REASONS,
  REMOVE_REASONS,
  VET_VERDICTS,
} from '@/modules/platform/telegram/price-channel-rules';
import { CHANNEL_ERRORS } from '@/app/(protected)/admin/narx-kanali/errors';

/**
 * The panel builds its keys at RUNTIME (`status.${p.status}`), which
 * i18n-keys.test.ts cannot see (it reads literal keys only). A missing key
 * throws at render in every locale (CLAUDE.md), so each dynamic group is
 * anchored here on the exported tuple it is built from (#163: the source of
 * truth sits outside the bundles — comparing bundles to each other cannot
 * catch a key missing from all four).
 */
const LOCALES = ['uz', 'ru', 'en', 'zh-CN'] as const;
const bundles = Object.fromEntries(
  LOCALES.map((l) => [l, JSON.parse(readFileSync(`messages/${l}.json`, 'utf8')) as Record<string, unknown>]),
);

function at(bundle: Record<string, unknown>, path: string): unknown {
  return path.split('.').reduce<unknown>((node, key) => (node as Record<string, unknown> | undefined)?.[key], bundle);
}

const GROUPS: [string, readonly string[]][] = [
  ['status', POST_STATUSES],
  ['skip', SKIP_REASONS],
  ['fail', FAIL_REASONS],
  ['kind', POST_KINDS],
  ['right', CHANNEL_RIGHTS],
  ['removed', REMOVE_REASONS],
  ['vet', VET_VERDICTS],
  ['paused', PAUSE_REASONS],
  ['error', CHANNEL_ERRORS],
];

describe('every runtime key of the price channel panel exists in all four bundles', () => {
  for (const locale of LOCALES) {
    it(locale, () => {
      const bundle = bundles[locale]!;
      expect(typeof at(bundle, 'priceChannel.title'), 'priceChannel.title').toBe('string');
      for (const [group, members] of GROUPS) {
        for (const m of members) {
          const key = `priceChannel.${group}.${m}`;
          const value = at(bundle, key);
          expect(typeof value === 'string' && value.trim() !== '', `${locale}: ${key}`).toBe(true);
        }
      }
    });
  }
});

describe('the 0128 CHECK lists are the tuples', () => {
  const sqlFile = readFileSync('src/modules/platform/db/migrations/0128_price_channel.sql', 'utf8');
  const listAfter = (column: string) => {
    const m = new RegExp(`"${column}" IN \\(([^)]*)\\)`).exec(sqlFile);
    return (m?.[1] ?? '').split(',').map((s) => s.trim().replace(/'/g, ''));
  };
  it('skip_reason', () => expect(listAfter('skip_reason')).toEqual([...SKIP_REASONS]));
  it('remove_reason', () => expect(listAfter('remove_reason')).toEqual([...REMOVE_REASONS]));
  it('the post status', () => {
    const m = /price_channel_posts_status_check"\s*CHECK \("status" IN \(([^)]*)\)/.exec(sqlFile);
    expect((m?.[1] ?? '').split(',').map((s) => s.trim().replace(/'/g, ''))).toEqual([...POST_STATUSES]);
  });
});

describe('status chips are a literal class map', () => {
  it('no class is built from a value', () => {
    for (const file of [
      'src/app/(protected)/admin/narx-kanali/page.tsx',
      'src/app/(protected)/admin/narx-kanali/channel-panel.tsx',
    ]) {
      const src = readFileSync(file, 'utf8');
      expect(src).not.toMatch(/`chip-\$\{|`bg-\$\{|`text-\$\{/);
    }
    expect(readFileSync('src/app/(protected)/admin/narx-kanali/page.tsx', 'utf8')).toContain(
      'const STATUS_CHIP: Record<PostStatus, string>',
    );
  });
});
