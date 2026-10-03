import Link from 'next/link';

/**
 * «Yuk ma'lumoti tekshirildi» on a row of cargo (docs/YUK-TEKSHIRUV.md §6):
 * ✅ wherever the lot stands, ⚠ / ❓ only where it is askable (a Chinese
 * warehouse, the owner's 4a) — the face is `chipFace` of lot-check-sql.ts,
 * decided by the caller, and null draws nothing.
 *
 * `href` makes it the worklist's door to the lot on the prixod card; `newTab`
 * keeps a half-made plan alive (the plan editor's selection is client state).
 * The classes are literal: Tailwind compiles only what it can see.
 */
export function LotCheckChip({
  face,
  labels,
  href,
  newTab,
}: {
  face: 'checked' | 'stale' | 'none' | null;
  labels: { checked: string; stale: string; none: string };
  href?: string;
  newTab?: boolean;
}) {
  if (face === null) return null;
  const className =
    face === 'checked'
      ? 'chip-good whitespace-nowrap font-sans'
      : face === 'stale'
        ? 'chip-warn whitespace-nowrap font-sans'
        : 'chip-neutral whitespace-nowrap font-sans';
  const text =
    face === 'checked'
      ? `✅ ${labels.checked}`
      : face === 'stale'
        ? `⚠️ ${labels.stale}`
        : `❓ ${labels.none}`;
  if (!href) {
    return (
      <span data-testid="lot-check-chip" data-state={face} className={className}>
        {text}
      </span>
    );
  }
  if (newTab) {
    return (
      <a
        data-testid="lot-check-chip"
        data-state={face}
        className={className}
        href={href}
        target="_blank"
        rel="noopener noreferrer"
      >
        {text}
      </a>
    );
  }
  return (
    <Link data-testid="lot-check-chip" data-state={face} className={className} href={href}>
      {text}
    </Link>
  );
}
