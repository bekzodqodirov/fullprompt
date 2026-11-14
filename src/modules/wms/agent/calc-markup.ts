/**
 * The client price the AI states on a VED answer — VED's figure plus his markup, in CODE and never by the model
 * (SPEC-P2-v2 §2.2, law 4). PURE and imports nothing: the settings are read by `calc-price.ts`, which hands the rule
 * in already parsed.
 *
 * INTEGER cents, BigInt (judge money 7): `Math.ceil(1300 × 1.1)` is 1431 in floating point — measured over integer
 * floors 100..20 000 and nine markups, 1 540 prices a dollar off. The floor carries cents (numeric(14,2)), so it is
 * read from its decimal STRING (`centsOf`), never through `Number()`.
 *
 * His answers of 2026-11-14 (§00): an EMPTY markup is a rule of its own — `none`, the VED's figure with nothing added
 * (A1); and the markup goes on the WHOLE VED figure, in every section (A2) — one base, no freight argument.
 *   percent: marked = ⌈base × (10 000 + h) ÷ 10 000⌉ cents, h = the percent in hundredths;
 *   fixed:   marked = base + dollars × 100;
 *   none:    marked = base;
 *   the client price = ⌈marked ÷ 100⌉ whole dollars.
 */

export type MarkupRule = { kind: 'none' } | { kind: 'percent'; hundredths: number } | { kind: 'fixed'; dollars: number };

/** ⌈a ÷ b⌉ for non-negative BigInts. */
export function ceilDiv(a: bigint, b: bigint): bigint {
  if (b <= 0n) throw new Error('ceilDiv: the divisor must be positive');
  if (a < 0n) throw new Error('ceilDiv: the dividend must not be negative');
  return (a + b - 1n) / b;
}

/**
 * A money string as cents — «1234.56» → 123456n, «1300» → 130000n, «0.5» → 50n. Null for anything that is not a
 * plain non-negative decimal with at most two places (a third place is not a figure the columns hold: refused, never
 * rounded).
 */
export function centsOf(text: string): bigint | null {
  const m = /^(\d{1,15})(?:\.(\d{1,2}))?$/u.exec(text.trim());
  if (!m) return null;
  return BigInt(m[1]!) * 100n + BigInt((m[2] ?? '').padEnd(2, '0'));
}

/** The canonical string of a rule — what the confirmed stamp stores and the card compares: `none`, `percent:10.5`, `fixed:150`. */
export function ruleString(rule: MarkupRule): string {
  switch (rule.kind) {
    case 'none':
      return 'none';
    case 'percent': {
      const whole = Math.floor(rule.hundredths / 100);
      const frac = rule.hundredths % 100;
      return `percent:${frac === 0 ? whole : `${whole}.${String(frac).padStart(2, '0').replace(/0$/u, '')}`}`;
    }
    case 'fixed':
      return `fixed:${rule.dollars}`;
  }
}

/** The marked figure in cents and the client price in whole dollars, for a base in cents. */
export function markupPrice(input: { baseCents: bigint; rule: MarkupRule }): { markedCents: bigint; clientDollars: bigint } {
  const { baseCents, rule } = input;
  if (baseCents < 0n) throw new Error('markupPrice: a negative base');
  let marked: bigint;
  switch (rule.kind) {
    case 'none':
      marked = baseCents;
      break;
    case 'percent':
      if (!Number.isInteger(rule.hundredths) || rule.hundredths < 1) throw new Error('markupPrice: a bad percent');
      marked = ceilDiv(baseCents * (10_000n + BigInt(rule.hundredths)), 10_000n);
      break;
    case 'fixed':
      if (!Number.isInteger(rule.dollars) || rule.dollars < 1) throw new Error('markupPrice: a bad fixed sum');
      marked = baseCents + BigInt(rule.dollars) * 100n;
      break;
  }
  return { markedCents: marked, clientDollars: ceilDiv(marked, 100n) };
}

/** Cents as the card prints them: «1 234,56». */
export function centsWords(cents: bigint): string {
  const whole = cents / 100n;
  const frac = cents % 100n;
  return `${groupThousands(whole)},${String(frac).padStart(2, '0')}`;
}

/** Whole dollars as the card prints them: «1 359». */
export function dollarsWords(dollars: bigint): string {
  return groupThousands(dollars);
}

function groupThousands(n: bigint): string {
  return String(n).replace(/\B(?=(\d{3})+(?!\d))/gu, ' ');
}

/** The rule as the holder's card says it: «ustama 10 %», «ustama 150 $», «ustamasiz» (§00 Words). */
export function ruleWords(rule: MarkupRule): string {
  switch (rule.kind) {
    case 'none':
      return 'ustamasiz';
    case 'percent':
      return `ustama ${ruleString(rule).slice('percent:'.length).replace('.', ',')} %`;
    case 'fixed':
      return `ustama ${groupThousands(BigInt(rule.dollars))} $`;
  }
}

/**
 * The HOLDER's card line (judge hands 11): «🧮 VED 1 234,56 $ · ustama 10 % → mijozga 1 359 $». The one place the
 * floor and the rule are printed — never the ledger, the chat block or any prompt part (§2.6).
 */
export function cardLineOf(baseCents: bigint, rule: MarkupRule, sectionWord: string | null): string {
  const { clientDollars } = markupPrice({ baseCents, rule });
  const section = sectionWord ? `${sectionWord}: ` : '';
  return `🧮 ${section}VED ${centsWords(baseCents)} $ · ${ruleWords(rule)} → mijozga ${dollarsWords(clientDollars)} $`;
}

/** The page's worked example (§2.1) on a non-round VED figure, so the rounding shows: «VED 1 234,56 $ → ustama 10 % → 1 358,02 $ → mijozga 1 359 $». */
export const EXAMPLE_BASE_CENTS = 123_456n;

export function workedExample(rule: MarkupRule, baseCents: bigint = EXAMPLE_BASE_CENTS): string {
  const { markedCents, clientDollars } = markupPrice({ baseCents, rule });
  const middle = rule.kind === 'none' ? '' : ` → ${centsWords(markedCents)} $`;
  return `VED ${centsWords(baseCents)} $ → ${ruleWords(rule)}${middle} → mijozga ${dollarsWords(clientDollars)} $`;
}
