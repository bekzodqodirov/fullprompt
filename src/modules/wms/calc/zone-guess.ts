/**
 * The freight zone read off the seller's free-text city — a leaf with no
 * imports (docs/SAKKIZ-R2.md K1).
 *
 * It lived in `workspace.ts`, which still answers for it by re-export. It
 * moved because round 2 asks it from three places that must not drag the
 * whole workspace in — the bot's reply, the yolkira tariff answer and the
 * screen's hint — and because a rule with three readers needs one home
 * (#513) that a unit test can import on its own.
 */

/**
 * A pure pre-selection, never a decision.
 *
 * The zone is a 36-58 % difference in the freight price, and `from_city` is
 * free text a seller typed on a phone. So this offers an answer and the
 * picker demands one: the seal refuses `freight_zone_required` no matter what
 * the city says.
 */
export function guessZone(fromCity: string | null): string | null {
  const c = (fromCity ?? '').toLowerCase();
  if (!c) return null;
  if (/qashqar|кашгар|kashgar|喀什/.test(c)) return 'kashgar';
  // AFTER «cn» on purpose: «Yiwu (Horgos orqali)» is Yiwu cargo, and his
  // 21a keeps it on the China price whichever border the truck takes.
  if (/yiwu|иу|义乌|guangzhou|гуанчжоу|广州|yw|gz/.test(c)) return 'cn';
  if (/horgos|khorgos|xorgos|хоргос|коргас|қорғас|霍尔果斯/.test(c)) return 'horgos';
  return null;
}

/**
 * The hint the workspace shows — a guessed zone only when the tariff PRICES
 * it. «horgos» is guessable from a city the day he opens the warehouse and
 * priceable only once he types its rows (answer 22); a hint naming an
 * unpriced zone points at a picker option that does not exist.
 */
export function guessedZoneFor(fromCity: string | null, priced: readonly string[]): string | null {
  const g = guessZone(fromCity);
  return g !== null && priced.includes(g) ? g : null;
}
