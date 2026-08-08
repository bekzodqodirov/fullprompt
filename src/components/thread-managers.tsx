import Link from 'next/link';

/**
 * Who has talked with this client, folded — and whose conversation to read.
 *
 * The owner, 2026-08-07: «chatning tepasida ulangan accountlar royxati
 * turibti ularni foldable qilib ber» and «1 ta mijoz bilan 2-3 ta sotuv
 * manageri gaplashadi, shularni qaysi biri qanday gaplashganini tanlaydigan
 * qilib ber». Both halves are about the same row: a flat strip of names ate
 * the top of every conversation, and on the CARDS it was only a strip of
 * names — the selector existed on «Suhbatlar» alone, so the place he actually
 * works could not answer «what did Dilnoza say to this client».
 *
 * Native `<details>`, the fold idiom of this codebase (chat-menu, the rail
 * panels): no JavaScript, no hydration, and it survives a server render with
 * its state stated in the markup. It opens itself when a filter is on, because
 * a closed fold hiding an active filter is how somebody reads a partial
 * conversation and thinks it is the whole one.
 *
 * Selecting is offered only to the supervision view. That is not a UI choice:
 * `conversationFor` honours `managerId` only under `viewer.all` (round 34), so
 * for anybody else the links would be buttons that change nothing. Names
 * themselves stay visible to everyone — who talks to a client is shared
 * knowledge, what was said is not (round 20's line).
 */
export interface ThreadManager {
  id: string;
  name: string;
  messages: number;
}

export function ThreadManagers({
  managers,
  active,
  hrefFor,
  labels,
}: {
  managers: ThreadManager[];
  /** The manager whose thread is being read, or null for everyone's. */
  active: string | null;
  /** Null = «all» — the caller owns the URL shape of its own screen. */
  hrefFor?: (managerId: string | null) => string;
  labels: { who: string; all: string };
}) {
  if (managers.length === 0) return null;
  const activeName = managers.find((m) => m.id === active)?.name;
  const selectable = typeof hrefFor === 'function' && managers.length > 1;

  return (
    <details className="text-sm" open={Boolean(active)} data-testid="thread-managers">
      <summary className="cursor-pointer list-none">
        <span className="text-ink-500">👥 {labels.who}:</span>{' '}
        <span className="font-semibold text-ink-700" data-testid="thread-managers-summary">
          {/* The active filter first, because it is the thing a reader must
              not miss; otherwise a count, which is what the fold is hiding. */}
          {activeName ?? `${managers.length}`}
        </span>
      </summary>
      <div className="mt-1.5 flex flex-wrap gap-1.5">
        {selectable && (
          <Link
            href={hrefFor!(null)}
            data-testid="thread-manager-all"
            className={`rounded-full border px-3 py-1 font-semibold ${
              active ? 'border-line text-ink-700' : 'border-brand-700 bg-brand-700 text-white'
            }`}
          >
            {labels.all}
          </Link>
        )}
        {managers.map((m) =>
          selectable ? (
            <Link
              key={m.id}
              href={hrefFor!(m.id)}
              data-testid="thread-manager"
              className={`rounded-full border px-3 py-1 font-semibold ${
                active === m.id
                  ? 'border-brand-700 bg-brand-700 text-white'
                  : 'border-line text-ink-700'
              }`}
            >
              {m.name} · {m.messages}
            </Link>
          ) : (
            <span
              key={m.id}
              data-testid="thread-manager"
              className="rounded-full border border-line px-3 py-1 text-ink-700"
            >
              {m.name} · {m.messages}
            </span>
          ),
        )}
      </div>
    </details>
  );
}
