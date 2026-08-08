import { outboxLabel } from '@/modules/wms/crm/telegram-send';

/**
 * A reply that has not left yet, drawn the SAME way on every surface.
 *
 * Written because it was written three times. The «Suhbatlar» screen asked
 * `outboxLabel` and could therefore say «stuck»; the card panel had its own
 * two-way `status === 'failed' ? ✕ : ◷ navbatda`, so a row the listener had
 * claimed and could not finish reading «navbatda» for hours — which is
 * exactly what round 48 built the third state FOR; and the dock showed
 * nothing at all, so a manager pressed send and watched their words vanish.
 *
 * The owner reported the consequence twice («telegramdan ketyabti lekin
 * bizni sistemada ocheretda turibti»), and both times the queue was fine:
 * what differed was which screen he happened to be reading. One component,
 * one label function, no room left for three answers.
 */
export interface OutboxRow {
  id: string;
  body: string;
  status: string;
  queuedAt: Date;
  attachmentId: string | null;
  /** Telegram's own words about the refusal — shown, never summarised away. */
  lastError?: string | null;
}

export function OutboxBubble({
  row,
  labels,
  action,
  now,
}: {
  row: OutboxRow;
  labels: { queued: string; stuck: string; failed: string };
  /** The ✕ that clears a failed row — only the surfaces that own one pass it. */
  action?: React.ReactNode;
  /** Passed in by the caller so a server render and a test agree on «now». */
  now?: Date;
}) {
  // `queuedAt` stands in for "claimed at": a row is claimed within seconds of
  // being written, so the two differ by far less than the threshold cares
  // about (round 48's note, kept with the code that relies on it).
  const label = outboxLabel(row.status, row.queuedAt, now);
  return (
    <div
      className={`ml-auto max-w-[85%] rounded-xl border border-dashed px-3 py-2 text-sm ${
        label === 'failed'
          ? 'border-bad text-bad'
          : label === 'stuck'
            ? 'border-warn text-warn'
            : 'border-line-strong text-ink-500'
      }`}
      data-testid={`outbox-${label}`}
    >
      <div className="mb-0.5 flex items-start gap-2 text-xs font-semibold">
        <span className="min-w-0 flex-1">
          {label === 'failed'
            ? `✕ ${labels.failed}`
            : label === 'stuck'
              ? `⚠ ${labels.stuck}`
              : `◷ ${labels.queued}`}
        </span>
        {label === 'failed' && action}
      </div>
      <p className="whitespace-pre-wrap break-words">
        {row.attachmentId && '🖼 '}
        {row.body}
      </p>
      {row.lastError && <p className="mt-1 text-xs">{row.lastError}</p>}
    </div>
  );
}
