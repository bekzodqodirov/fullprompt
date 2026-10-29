import { describe, expect, it } from 'vitest';
import { KbError, writeKbFact } from '@/modules/wms/agent/kb';

/**
 * The fix round's money spellings, through the kb writer (money-9): it asks
 * the SAME classifier G1 reads replies with, so a price spelling G1 missed was
 * also a price the owner could approve into the company's knowledge — and a
 * kb figure then backs a reply's figure as a plain source. And the other way:
 * a payment word next to an address no longer makes the street number a price
 * he cannot save. As in agent-kb-money.test.ts, nothing reaches the database:
 * a fact that clears the money check stops at `scope` (client, no client).
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

describe('the spellings the package missed are prices too', () => {
  it.each([
    'Avia kilosiga 17',
    'Kubiga 160',
    'За кило 17',
    'Kubi 160 dollor',
    'Kubi 160 долар',
    'Kilosi 17 USDT',
    'Umumiy summa 480',
    'Доставка стоит 480',
  ])('«%s» is refused as money', async (answer) => {
    expect(await refusal(answer)).toBe('money');
  });

  it.each([
    "To'lov naqd, ombor 3-ko'chada",
    "Ofis soat 9 dan 18 gacha ishlaydi, to'lov ofisda",
    'Рубашки и европаллеты: склад на 3-й линии, 2 этаж',
    'Pulat aka bilan omborda, 15 qatorda uchrashing',
    'Машина стоит на границе, очередь 15',
  ])('«%s» holds no price and is not refused as money', async (answer) => {
    expect(await refusal(answer)).toBe('scope');
  });
});
