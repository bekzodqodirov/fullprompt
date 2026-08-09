import type { ReactNode } from 'react';

/**
 * The one muted line a board card carries under its identity and its money.
 *
 * Before this, the lead card spent four different treatments on four facts of
 * the same rank — the source in a grey pill, the owner as bare text, the client
 * code in bold green, the chat as an emoji — and the deal card ran two of them
 * together separated by a single space («DM1786192267 Bekzod (Super admin)»),
 * so nothing said where one fact ended and the next began. The owner's word for
 * the result was «adashadi».
 *
 * The fix is not a new vocabulary but the house one: ONE 11 px muted row joined
 * by « · », which is already how this codebase separates small facts (the
 * archive footer, the deal money line, the batch rows). Chips were measured and
 * refused — at the real card width they wrap on ordinary Russian owner names
 * and cost 7-31 px per card, on a card whose whole complaint was height.
 *
 * A part that is null renders NOTHING — no placeholder, no dash. Both because a
 * row of «—» is height carrying no information (#571's lesson from the card
 * rail), and because m9zh-card-fields proves a switched-off field by asserting
 * the card's text got strictly SHORTER.
 */
export function MetaLine({ parts }: { parts: (ReactNode | null | false)[] }) {
  const shown = parts.filter(Boolean) as ReactNode[];
  if (shown.length === 0) return null;

  return (
    <div className="mt-1 text-[11px] text-ink-500 [overflow-wrap:anywhere]">
      {shown.map((part, i) => (
        // The separator belongs to the part that FOLLOWS it and travels with
        // it, so a wrap can never leave a « · » orphaned at the start of a
        // line — the defect the deal card's money line showed for months.
        <span key={i}>
          {i > 0 && <span className="text-ink-400"> · </span>}
          {part}
        </span>
      ))}
    </div>
  );
}
