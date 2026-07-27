import '../globals.css';

/**
 * Pages an OUTSIDER opens: no session, no app shell, no menu.
 *
 * A sibling of `(protected)` rather than a page inside it, because everything
 * under that group assumes an actor and would bounce a driver to a staff login
 * screen — which is precisely the wall this group exists to avoid.
 */
export default function PublicLayout({ children }: { children: React.ReactNode }) {
  return <div className="min-h-dvh bg-surface-100 text-ink-900">{children}</div>;
}
