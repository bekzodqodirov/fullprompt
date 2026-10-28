/**
 * How a typed answer names its row in the bot's table (docs/SAKKIZ-R3.md
 * §8.2.4, his 1.10 c). K declares the one type the collection's `offers`
 * already carry, so the state's shape is fixed before any package; P3 fills
 * the parser here.
 */

/** What an answer — or an offer's button — is about: a line, a total, or the route. */
export type TableTarget = { line: number } | { totals: 'weightKg' | 'volumeM3' } | { route: true };
