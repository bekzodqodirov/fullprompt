import { redirect } from 'next/navigation';
import { getActor } from '@/modules/platform/rbac/authorize';
import './print.css';

/**
 * A screen with no app around it.
 *
 * Everything under `(protected)` gets the header, the sidebar and the tab bar,
 * and every one of them would end up on a sticker. This group is the same
 * login gate with none of the furniture — each page inside still states its
 * own permission, exactly as the admin pages had to learn to (#198).
 *
 * A sibling route group rather than a flag on the protected layout, because
 * `print.css` carries an `@page` rule: it has no selector to scope it, so the
 * only way to keep it off every other screen is to put it where only these
 * pages can load it.
 */
export default async function PrintLayout({ children }: { children: React.ReactNode }) {
  const actor = await getActor();
  if (!actor) redirect('/login');
  return <div className="print-sheet">{children}</div>;
}
