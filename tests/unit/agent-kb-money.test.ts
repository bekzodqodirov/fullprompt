import { describe, expect, it } from 'vitest';
import { KbError, writeKbFact } from '@/modules/wms/agent/kb';

/**
 * The kb writer refuses a price (money-9) through the SAME classifier G1
 * reads replies with — so every money spelling the review found passing G1
 * (P1) was also a price that could be written into the company's knowledge
 * and then read in every chat. The refusal happens before any write: nothing
 * here reaches the database. The control facts are scoped `client` with no
 * client, so a fact that clears the money check stops at `scope` instead of
 * being written — the code says which check stopped it.
 */

const ctx = { actorId: null };

async function refusal(answer: string): Promise<string | null> {
  try {
    await writeKbFact({ scope: 'client', clientId: null, question: null, answer }, ctx);
    return null;
  } catch (err) {
    if (err instanceof KbError) return err.code;
    throw err;
  }
}

describe('a price never becomes a fact', () => {
  it.each([
    'Kubi 160 AQSH dollari',
    'Kubi 160 US dollars',
    'Куби 160 АҚШ доллари',
    'Куб — 160 долларов США',
    'Narx (dollarda): 160',
    'Kilosi USD17',
    'Yetkazish 1,5 mln so‘m',
    '1 kub 160 евро',
    '⁴⁸⁰ $',
  ])('«%s» is refused as money', async (answer) => {
    expect(await refusal(answer)).toBe('money');
  });

  it.each(['Ombor 3-ko‘chada, 15-uyda', 'Yuk 15-25 kunda yetib boradi', 'Eng kamida 1 kub yoki 100 kg'])(
    '«%s» names no money and is not refused as money',
    async (answer) => {
      expect(await refusal(answer)).toBe('scope');
    },
  );
});
