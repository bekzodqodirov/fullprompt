'use client';

import Link from 'next/link';
import { usePathname } from 'next/navigation';
import { Icon, type IconName } from './icon';

export interface SubNavItem {
  href: string;
  label: string;
  icon: IconName;
  /** Match this href exactly instead of by prefix (section roots). */
  exact?: boolean;
}

/**
 * The tab strip inside a section (accounting, CRM, admin).
 *
 * Was a row of emoji links with no state at all, so you could never tell
 * which page of a section you were on. Now the current tab is filled, the
 * strip scrolls without dragging the page sideways, and the active tab is
 * scrolled into view on arrival — on a 360 px screen the tab you are on is
 * often the fifth one.
 */
export function SubNav({ items }: { items: SubNavItem[] }) {
  const pathname = usePathname();
  const active = (item: SubNavItem) =>
    item.exact ? pathname === item.href : pathname === item.href || pathname.startsWith(`${item.href}/`);

  return (
    <nav data-testid="sub-nav" className="-mx-4 mb-4 overflow-x-auto px-4 md:mx-0 md:px-0">
      <div className="flex w-max gap-1.5 pb-1">
        {items.map((item) => {
          const on = active(item);
          return (
            <Link
              key={item.href}
              href={item.href}
              aria-current={on ? 'page' : undefined}
              ref={(node) => {
                if (on && node) node.scrollIntoView({ block: 'nearest', inline: 'nearest' });
              }}
              className={`inline-flex items-center gap-1.5 whitespace-nowrap rounded-xl px-3 py-2 text-sm font-semibold transition-colors ${
                on
                  ? 'bg-brand-600 text-white shadow-card'
                  : 'bg-surface-raised text-ink-700 ring-1 ring-line hover:bg-surface-sunken'
              }`}
            >
              <Icon name={item.icon} className="h-4 w-4" />
              {item.label}
            </Link>
          );
        })}
      </div>
    </nav>
  );
}
