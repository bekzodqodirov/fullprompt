import type { CalcFacts } from './intake';

/**
 * The facts a staff member typed, read without a model.
 *
 * Two reasons this exists rather than leaning on the AI for everything.
 * First, honesty: a person who wrote «5 kub» stated a fact, and a model that
 * missed it must not be able to erase it — so these values WIN over the
 * model's reading. Second, availability: the intake has to work on a server
 * with no API key at all, or the feature dies the day a key expires.
 *
 * Deliberately narrow. It reads the shapes the office actually types — «250
 * kg», «5 kub», «Yiwu → Toshkent» — and leaves everything else to the model
 * and to the person's own eyes at the review step.
 */

/**
 * «250 kg», «250kg», «250 кг», «vazni 250 kg» → 250.
 *
 * The end of the unit is a NEGATIVE LOOKAHEAD, not `\b`: JavaScript's word
 * boundary is defined on ASCII, so «120кг» ends on a non-word character as
 * far as it is concerned and `\b` never matches — which is exactly how the
 * office writes it. (Caught by the test, not by reading the regex.)
 */
function readNumber(text: string, units: string[]): number | null {
  for (const unit of units) {
    const re = new RegExp(`(\\d+(?:[.,]\\d+)?)\\s*${unit}(?![\\p{L}\\d])`, 'iu');
    const hit = re.exec(text);
    if (hit) {
      const value = Number(hit[1]!.replace(',', '.'));
      if (Number.isFinite(value) && value > 0) return value;
    }
  }
  return null;
}

/**
 * «Yiwu → Toshkent», «Yiwu - Toshkent», «Guangzhou dan Andijon ga».
 * Only the arrow forms are trusted: a hyphen inside a product name would
 * otherwise turn half a packing list into a route.
 */
function readRoute(text: string): { fromCity: string | null; toCity: string | null } {
  const arrow = /([A-Za-zА-Яа-яЎўҚқҒғҲҳ' ]{2,24})\s*(?:→|->|=>)\s*([A-Za-zА-Яа-яЎўҚқҒғҲҳ' ]{2,24})/u.exec(
    text,
  );
  if (arrow) return { fromCity: arrow[1]!.trim(), toCity: arrow[2]!.trim() };

  const uz = /([A-Za-zА-Яа-яЎўҚқҒғҲҳ']{2,24})\s*(?:dan|дан|из)\s+([A-Za-zА-Яа-яЎўҚқҒғҲҳ']{2,24})\s*(?:ga|га|до|в)\b/iu.exec(
    text,
  );
  if (uz) return { fromCity: uz[1]!.trim(), toCity: uz[2]!.trim() };

  return { fromCity: null, toCity: null };
}

export function parseManualFacts(text: string): CalcFacts {
  const route = readRoute(text);
  return {
    fromCity: route.fromCity,
    toCity: route.toCity,
    weightKg: readNumber(text, ['kg', 'кг', 'kilo', 'килограмм']),
    volumeM3: readNumber(text, ['kub', 'куб', 'm3', 'м3', 'м³', 'm³']),
    // A typed product list is not parsed into items: guessing where one name
    // ends and the next begins is exactly the job the model does better, and
    // a wrong split reads as fact on the card.
    goods: [],
  };
}
