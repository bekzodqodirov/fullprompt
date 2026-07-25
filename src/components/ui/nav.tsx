'use client';

import { useState } from 'react';
import Link from 'next/link';
import { usePathname } from 'next/navigation';
import { Icon, type IconName } from './icon';

export interface NavItem {
  href: string;
  label: string;
  icon: IconName;
}
export interface NavGroup {
  title: string;
  items: NavItem[];
}

/**
 * Screens that own the whole phone while a job is in progress.
 *
 * Receiving, plan building, crate building, issuing and the scan modes each
 * carry their own fixed action bar at the bottom — the tab bar sat on top of
 * it and swallowed the taps. These are modes, not destinations: you finish
 * or you cancel, and every one of them has its own way out, so the tab bar
 * simply steps aside.
 */
const FOCUS_ROUTES = ['/receive', '/plans/new', '/crates/new', '/issue', '/inventory'];
const FOCUS_SUFFIXES = ['/load', '/unload'];

function isFocusMode(pathname: string) {
  return (
    FOCUS_ROUTES.some((route) => pathname === route || pathname.startsWith(`${route}/`)) ||
    FOCUS_SUFFIXES.some((suffix) => pathname.endsWith(suffix))
  );
}

/** `/stock` matches `/stock/abc` but `/` only matches itself. */
function isActive(pathname: string, href: string) {
  if (href === '/') return pathname === '/';
  return pathname === href || pathname.startsWith(`${href}/`);
}

/**
 * The bottom tab bar, and the sheet behind "More".
 *
 * Before this, leaving a screen meant going back to the home tiles and
 * starting again — which is why the app felt like a pile of pages rather than
 * one product. Four destinations are always a thumb away; everything else is
 * one tap behind them, grouped the way the home screen groups it.
 *
 * Phone only: from `md` up the same links live in a sidebar, where there is
 * room to show them all at once.
 */
export function MobileNav({ primary, groups }: { primary: NavItem[]; groups: NavGroup[] }) {
  const pathname = usePathname();
  const [open, setOpen] = useState(false);
  if (isFocusMode(pathname)) return null;

  return (
    <>
      {open && (
        <div className="fixed inset-0 z-40 md:hidden" role="dialog" aria-modal="true">
          <button
            type="button"
            aria-label="close"
            className="absolute inset-0 bg-ink-900/40"
            onClick={() => setOpen(false)}
          />
          <div className="pb-safe absolute inset-x-0 bottom-0 max-h-[80vh] overflow-y-auto rounded-t-2xl bg-surface-raised p-4 shadow-pop">
            <div className="mx-auto mb-3 h-1 w-10 rounded-full bg-line-strong" />
            <div className="space-y-4">
              {groups.map((group) => (
                <div key={group.title} className="space-y-1.5">
                  <p className="section-title">{group.title}</p>
                  <div className="grid grid-cols-2 gap-2">
                    {group.items.map((item) => (
                      <Link
                        key={item.href}
                        href={item.href}
                        onClick={() => setOpen(false)}
                        className={`flex items-center gap-2 rounded-xl border p-3 text-sm font-semibold ${
                          isActive(pathname, item.href)
                            ? 'border-brand-200 bg-brand-50 text-brand-800'
                            : 'border-line bg-surface-raised text-ink-700'
                        }`}
                      >
                        <Icon name={item.icon} className="h-5 w-5" />
                        <span className="truncate">{item.label}</span>
                      </Link>
                    ))}
                  </div>
                </div>
              ))}
            </div>
          </div>
        </div>
      )}

      <nav
        data-testid="tab-bar"
        className="pb-safe fixed inset-x-0 bottom-0 z-30 border-t border-line bg-surface-raised/95 backdrop-blur md:hidden"
      >
        <div className="mx-auto flex max-w-lg items-stretch">
          {primary.map((item) => {
            const active = isActive(pathname, item.href);
            return (
              <Link
                key={item.href}
                href={item.href}
                aria-current={active ? 'page' : undefined}
                className={`flex flex-1 flex-col items-center gap-0.5 px-1 pt-2 text-2xs font-semibold ${
                  active ? 'text-brand-700' : 'text-ink-500'
                }`}
              >
                <Icon name={item.icon} className="h-6 w-6" strokeWidth={active ? 2.1 : 1.75} />
                <span className="max-w-full truncate">{item.label}</span>
              </Link>
            );
          })}
          <button
            type="button"
            onClick={() => setOpen((value) => !value)}
            className={`flex flex-1 flex-col items-center gap-0.5 px-1 pt-2 text-2xs font-semibold ${
              open ? 'text-brand-700' : 'text-ink-500'
            }`}
          >
            <Icon name={open ? 'x' : 'menu'} className="h-6 w-6" />
            <span>•••</span>
          </button>
        </div>
      </nav>
    </>
  );
}

/** The same links as a desktop sidebar, where everything fits at once. */
export function Sidebar({ groups }: { groups: NavGroup[] }) {
  const pathname = usePathname();
  return (
    <nav className="hidden w-56 shrink-0 border-r border-line bg-surface-raised md:block">
      <div className="sticky top-14 space-y-5 p-3">
        {groups.map((group) => (
          <div key={group.title} className="space-y-1">
            <p className="section-title px-2">{group.title}</p>
            {group.items.map((item) => {
              const active = isActive(pathname, item.href);
              return (
                <Link
                  key={item.href}
                  href={item.href}
                  aria-current={active ? 'page' : undefined}
                  className={`flex items-center gap-2.5 rounded-xl px-2.5 py-2 text-sm font-semibold ${
                    active
                      ? 'bg-brand-50 text-brand-800'
                      : 'text-ink-700 hover:bg-surface-sunken'
                  }`}
                >
                  <Icon name={item.icon} className="h-5 w-5" />
                  <span className="truncate">{item.label}</span>
                </Link>
              );
            })}
          </div>
        ))}
      </div>
    </nav>
  );
}
