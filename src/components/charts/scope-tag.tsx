/**
 * What a card's numbers COVER — «Hozir», «12 oy», «Butun kompaniya» — as a
 * small tag in the card's header, so a card that ignores the period or the
 * warehouse picked above it says so instead of looking broken.
 *
 * Always NEUTRAL. `chip-brand` is a red tint in this palette, and on the
 * dashboard colour means urgency: a red-ish tag on every card would say
 * «something is wrong here» a dozen times a screen (judge O21). The tag
 * informs; it never alarms. It never wraps, so it is short by contract.
 */
export function ScopeTag({ label, testid }: { label: string; testid?: string }) {
  return (
    <span className="chip-neutral shrink-0 whitespace-nowrap" data-testid={testid}>
      {label}
    </span>
  );
}
