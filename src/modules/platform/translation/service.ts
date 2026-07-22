import { desc, eq, sql } from 'drizzle-orm';
import { db } from '../db/client';
import { productDictionary } from '../db/schema';
import { logger } from '../logger';

/**
 * zh→ru translation pipeline (spec §8): exact dictionary hit → fuzzy trigram
 * suggestion → pluggable provider API (cached back into the dictionary as
 * unverified). Never throws to the caller — receiving must never block on
 * translation failure.
 */

export interface TranslationHit {
  ru: string | null;
  source: 'dictionary' | 'fuzzy' | 'api' | 'none';
  /** Fuzzy match shows which dictionary entry it came from. */
  matchedZh?: string;
}

interface TranslationProvider {
  translate(zh: string): Promise<string | null>;
}

/** LibreTranslate-compatible API (owner's choice: free/open provider for now). */
class LibreTranslateProvider implements TranslationProvider {
  async translate(zh: string): Promise<string | null> {
    const url = process.env.TRANSLATE_API_URL || 'https://libretranslate.com/translate';
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), 3000);
    try {
      const res = await fetch(url, {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({
          q: zh,
          source: 'zh',
          target: 'ru',
          format: 'text',
          ...(process.env.TRANSLATE_API_KEY ? { api_key: process.env.TRANSLATE_API_KEY } : {}),
        }),
        signal: controller.signal,
      });
      if (!res.ok) return null;
      const data = (await res.json()) as { translatedText?: string };
      return data.translatedText?.trim() || null;
    } catch {
      return null;
    } finally {
      clearTimeout(timer);
    }
  }
}

class NullProvider implements TranslationProvider {
  async translate(): Promise<string | null> {
    return null;
  }
}

function getProvider(): TranslationProvider {
  const name = process.env.TRANSLATE_PROVIDER ?? 'libretranslate';
  switch (name) {
    case 'libretranslate':
      return new LibreTranslateProvider();
    default:
      return new NullProvider();
  }
}

export async function translateZh(zh: string): Promise<TranslationHit> {
  const trimmed = zh.trim();
  if (!trimmed) return { ru: null, source: 'none' };

  // 1. Exact dictionary hit
  const exact = await db.query.productDictionary.findFirst({
    where: eq(productDictionary.zh, trimmed),
  });
  if (exact?.ru) return { ru: exact.ru, source: 'dictionary' };

  // 2. Fuzzy trigram suggestion
  const fuzzy = (await db.execute(sql`
    SELECT zh, ru FROM product_dictionary
    WHERE ru IS NOT NULL AND similarity(zh, ${trimmed}) > 0.4
    ORDER BY similarity(zh, ${trimmed}) DESC LIMIT 1
  `)) as unknown as { zh: string; ru: string }[];
  if (fuzzy[0]) return { ru: fuzzy[0].ru, source: 'fuzzy', matchedZh: fuzzy[0].zh };

  // 3. Provider API — cache the result as unverified
  try {
    const ru = await getProvider().translate(trimmed);
    if (ru) {
      await db
        .insert(productDictionary)
        .values({ zh: trimmed, ru, source: 'api', verified: false })
        .onConflictDoUpdate({
          target: productDictionary.zh,
          set: { ru: sql`COALESCE(${productDictionary.ru}, ${ru})` },
        });
      return { ru, source: 'api' };
    }
  } catch (err) {
    logger.warn({ err }, 'translation provider failed');
  }
  return { ru: null, source: 'none' };
}

/** Autocomplete for the zh input (most-used first). */
export async function suggestProducts(query: string, limit = 8) {
  const q = query.trim();
  if (!q) return [];
  return db
    .select({ zh: productDictionary.zh, ru: productDictionary.ru })
    .from(productDictionary)
    .where(sql`${productDictionary.zh} ILIKE ${'%' + q + '%'} OR ${productDictionary.ru} ILIKE ${'%' + q + '%'}`)
    .orderBy(desc(productDictionary.usageCount))
    .limit(limit);
}
