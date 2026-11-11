import { splitLabelCount } from '@/modules/platform/text/label-count';

/**
 * A lot's goods in a list cell: the Chinese name and, muted in brackets, the
 * Russian name the lists show — a tarkib's «first +N» while one stands
 * (`wms/receipts/lot-name.ts`; the owner's items 3-4, 2026-11-10).
 *
 * These cells are narrow and `truncate` cuts the END of a line — so on a long
 * first name the «+2» he asked to see was the first thing to go, on exactly
 * the stock and plan screens. Here the name gives way and the count never
 * does: «键盘 (Клавиатура проводн… +2)». A name with no count is the cell it
 * always was.
 *
 * Plain markup with no hook, so server and client screens both draw it. The
 * parent keeps its own width (`max-w-…`); a parent that was `block truncate`
 * drops `truncate` — this is the element that shortens now.
 */
export function LotGoodsName({ zh, ru, className }: { zh: string; ru?: string | null; className?: string }) {
  const { name, count } = splitLabelCount(ru ?? '');
  if (count === null) {
    return (
      <span className={`block truncate ${className ?? ''}`}>
        {zh}
        {ru && <span className="text-ink-500"> ({ru})</span>}
      </span>
    );
  }
  return (
    <span className={`flex min-w-0 ${className ?? ''}`}>
      <span className="min-w-0 truncate">
        {zh}
        <span className="text-ink-500"> ({name}</span>
      </span>
      <span className="shrink-0 whitespace-pre text-ink-500" data-testid="lot-name-count">
        {' '}
        {count})
      </span>
    </span>
  );
}

/**
 * The same rule for a cell that prints ONE name (the Russian one, else the
 * Chinese): «Клавиатура проводн… +2».
 */
export function LotNameText({ text, className }: { text: string; className?: string }) {
  const { name, count } = splitLabelCount(text);
  if (count === null) return <span className={`block truncate ${className ?? ''}`}>{text}</span>;
  return (
    <span className={`flex min-w-0 ${className ?? ''}`}>
      <span className="min-w-0 truncate">{name}</span>
      <span className="shrink-0 whitespace-pre" data-testid="lot-name-count">
        {' '}
        {count}
      </span>
    </span>
  );
}
