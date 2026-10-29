import type { ReactNode } from 'react';

/**
 * An approved AI sotuvchi reply that has not left yet — drawn in the thread
 * like a queued human reply (`OutboxBubble`), because to the person reading
 * the chat it is the same fact: words he decided on, on their way. It says
 * WHEN («🤖 08:30 da ketadi» — the night rule holds a late ✅ to the morning,
 * his Q14 ⭐), and only its account holder is handed the cancel.
 *
 * Plain markup with no hooks: the thread and the card panel render it on the
 * server and the dock in the browser, from the same component.
 */

/** Tashkent has no daylight saving: UTC+5, the card's own arithmetic (card-io `hhmm`). */
function tashkent(d: Date): Date {
  return new Date(d.getTime() + 5 * 3_600_000);
}

const two = (n: number) => String(n).padStart(2, '0');

/**
 * «08:30» when it leaves today (Tashkent), «22.10 08:30» on another day, and
 * null when it is due within the minute — then it is simply being sent.
 */
export function agentSendAtLabel(at: Date, now: Date = new Date()): string | null {
  if (at.getTime() <= now.getTime() + 60_000) return null;
  const t = tashkent(at);
  const n = tashkent(now);
  const time = `${two(t.getUTCHours())}:${two(t.getUTCMinutes())}`;
  const sameDay = t.getUTCFullYear() === n.getUTCFullYear() && t.getUTCMonth() === n.getUTCMonth() && t.getUTCDate() === n.getUTCDate();
  return sameDay ? time : `${two(t.getUTCDate())}.${two(t.getUTCMonth() + 1)} ${time}`;
}

export function AgentWaitingBubble({
  body,
  text,
  action,
}: {
  body: string;
  /** «🤖 08:30 da ketadi» / «🤖 yuborilmoqda…», composed by the caller in the reader's language. */
  text: string;
  /** The cancel — only for the account holder, only while it may still be taken back. */
  action?: ReactNode;
}) {
  return (
    <div
      className="ml-auto max-w-[85%] rounded-xl border border-dashed border-brand-200 px-3 py-2 text-sm text-ink-700"
      data-testid="agent-waiting"
    >
      {/* `flex-wrap`: the cancel's refusal takes a line of its own (agent-cancel-button, K34). */}
      <div className="mb-0.5 flex flex-wrap items-start gap-x-2 gap-y-0.5 text-xs font-semibold text-brand-700">
        <span className="min-w-0 flex-1">{text}</span>
        {action}
      </div>
      <p className="whitespace-pre-wrap break-words">{body}</p>
    </div>
  );
}
