import '../globals.css';

/**
 * Pages an OUTSIDER opens: no session, no app shell, no menu.
 *
 * A sibling of `(protected)` rather than a page inside it, because everything
 * under that group assumes an actor and would bounce a driver to a staff login
 * screen — which is precisely the wall this group exists to avoid.
 */
export default function PublicLayout({ children }: { children: React.ReactNode }) {
  // Plain `bg-surface`. This asked for a `surface-100`, which the theme does
  // not define — the scale is DEFAULT / raised / sunken — so the class compiled
  // to nothing and the page had been taking the body's colour by accident.
  return <div className="min-h-dvh bg-surface text-ink-900">{children}</div>;
}
