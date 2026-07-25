import type { ReactNode } from 'react';

/**
 * A card that opens on demand.
 *
 * Native `<details>` on purpose: it works inside a server component, ships no
 * client JavaScript, and keeps the phone screens short. Several panels (VED
 * papers, the driver pairing code, receipt notes and costs) matter on a
 * minority of jobs, and having them permanently open pushed the work people
 * actually do below the fold.
 */
export function Panel({
  title,
  badge,
  open = false,
  className = '',
  children,
}: {
  title: ReactNode;
  /** Short marker shown next to the title while collapsed (a count, a code). */
  badge?: ReactNode;
  open?: boolean;
  className?: string;
  children: ReactNode;
}) {
  return (
    <details className={`card !p-0 ${className}`} open={open}>
      <summary className="cursor-pointer p-3 text-sm font-bold text-gray-700 marker:text-gray-400">
        {title}
        {badge != null && (
          <span className="ml-2 rounded bg-blue-50 px-1.5 py-0.5 text-xs font-semibold text-blue-800">
            {badge}
          </span>
        )}
      </summary>
      <div className="space-y-2 border-t border-gray-100 p-3">{children}</div>
    </details>
  );
}
