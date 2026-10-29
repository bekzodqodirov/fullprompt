import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import en from '../../messages/en.json';
import ru from '../../messages/ru.json';
import uz from '../../messages/uz.json';
import zh from '../../messages/zh-CN.json';
import {
  AGENT_SECTIONS,
  CATEGORY_KEYS,
  ERROR_KEYS,
  PAUSE_KIND_KEYS,
  SCOPE_KEYS,
  SECTION_KEYS,
  SOURCE_KEYS,
  categoryKey,
  errorKey,
  sectionOf,
  sourceKey,
} from '@/app/(protected)/suhbatlar/ai/labels';

/**
 * `/suhbatlar/ai` builds labels from VALUES at render time — a refusal code,
 * a draft category, a pause kind, a kb scope and source. A key built at
 * runtime is invisible to `i18n-keys.test.ts`, and a missing one throws in
 * every locale (#163, review build-13 (2)). The maps in `labels.ts` are the
 * source of truth outside the bundles: the compiler makes each complete over
 * its union, this makes each value exist in all four bundles, and the three
 * maps that restate a 0138 CHECK are compared with the schema's own text.
 */

type Tree = { [key: string]: string | Tree };
const BUNDLES: Record<string, Tree> = { ru, uz, 'zh-CN': zh, en };

function lookup(tree: Tree, path: string): unknown {
  return path.split('.').reduce<unknown>((node, key) => (node as Tree | undefined)?.[key], tree);
}

const MAPS: Record<string, Record<string, string>> = {
  ERROR_KEYS,
  SECTION_KEYS,
  PAUSE_KIND_KEYS,
  CATEGORY_KEYS,
  SCOPE_KEYS,
  SOURCE_KEYS,
};

describe('the AI sotuvchi page’s runtime labels', () => {
  for (const [locale, bundle] of Object.entries(BUNDLES)) {
    it(`${locale} holds every value of every map under agentAi`, () => {
      const missing: string[] = [];
      for (const [name, map] of Object.entries(MAPS)) {
        for (const key of Object.values(map)) {
          if (typeof lookup(bundle, `agentAi.${key}`) !== 'string') missing.push(`${name}: agentAi.${key}`);
        }
      }
      expect(missing).toEqual([]);
    });
  }

  it('falls back to a key that exists, never to the raw value', () => {
    expect(errorKey('no_such_code')).toBe(ERROR_KEYS.unknown);
    expect(errorKey(undefined)).toBe(ERROR_KEYS.unknown);
    expect(errorKey('stale_card')).toBe('errors.stale_card');
    expect(categoryKey('weird')).toBe(CATEGORY_KEYS.other);
    expect(sourceKey('weird')).toBe(SOURCE_KEYS.manual);
    expect(sectionOf('nope')).toBe('kutilmoqda');
    expect(sectionOf('bilimlar')).toBe('bilimlar');
    expect(AGENT_SECTIONS.every((s) => SECTION_KEYS[s] !== undefined)).toBe(true);
  });

  it('names every value the 0138 CHECKs admit — category, kb scope, kb source, pause kind', () => {
    const schema = readFileSync(join(__dirname, '../../src/modules/platform/db/schema/agent.ts'), 'utf8');
    const listOf = (check: string) => {
      const at = schema.indexOf(`'${check}'`);
      expect(at, check).toBeGreaterThan(0);
      const tail = schema.slice(at, schema.indexOf('`', schema.indexOf('`', at) + 1));
      return [...tail.matchAll(/'([a-z_]+)'/gu)].map((m) => m[1]!).filter((v) => v !== check);
    };
    expect(Object.keys(CATEGORY_KEYS).sort()).toEqual(listOf('agent_drafts_category_check').sort());
    expect(Object.keys(SCOPE_KEYS).sort()).toEqual(listOf('kb_facts_scope_check').sort());
    expect(Object.keys(SOURCE_KEYS).sort()).toEqual(listOf('kb_facts_source_check').sort());
    expect(Object.keys(PAUSE_KIND_KEYS).sort()).toEqual(listOf('tg_account_guard_kind_check').sort());
  });
});
