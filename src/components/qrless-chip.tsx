/**
 * «🏷 QR-siz» on a row of cargo (0112, the owner's Q8): these cartons carry
 * no sticker of ours, so no phone will scan them — the office counts them.
 *
 * Counted in the row's OWN scope (this warehouse, this truck, this plan's
 * stock): the plain word when every carton there is QR-siz, «n/total» when a
 * sheet has been stuck on some since, and nothing at all at zero — an empty
 * chip would read as a broken one. The classes are literal: Tailwind compiles
 * only what it can see (the colour is the chip's modifier, never built).
 */
export function QrlessChip({ n, total, label }: { n: number; total: number; label: string }) {
  if (n <= 0) return null;
  return (
    <span data-testid="qrless-chip" className="chip-warn whitespace-nowrap font-sans">
      🏷 {label}
      {n < total ? ` ${n}/${total}` : ''}
    </span>
  );
}
