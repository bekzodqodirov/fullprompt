'use client';

import { useEffect, useState } from 'react';
import Link from 'next/link';
import { usePathname } from 'next/navigation';
import { Icon, type IconName } from './icon';
import { isActive } from './nav-active';
import { placementOf } from '@/modules/platform/rbac/workspaces';

export interface NavItem {
  href: string;
  label: string;
  icon: IconName;
}

/** One page of a workspace, as the shell draws it (labels already resolved). */
export interface WsNavTab {
  href: string;
  label: string;
  /** Hisobotlar only: which report group the page sits in. */
  group?: string;
  claims?: string[];
}

/** One workspace, as the shell draws it — only what THIS viewer is offered. */
export interface WsNav {
  key: string;
  label: string;
  icon: IconName;
  /** The workspace's own row goes to its first visible tab. */
  href: string;
  strip: boolean;
  tabs: WsNavTab[];
  settings: WsNavTab[];
  /** Hisobotlar only: the groups, each linking to its first visible page. */
  groups?: { key: string; label: string; href: string }[];
}

/** A «Tez-tez» row. */
export interface FrequentNav {
  href: string;
  label: string;
  icon: IconName;
  /** The workspace it lives in, printed quietly beside it. */
  where: string;
  starred: boolean;
}

export interface NavLabels {
  frequent: string;
  more: string;
  workspaces: string;
  settings: string;
  tabs: string;
  star: string;
  unstar: string;
  starFull: string;
}

/**
 * Screens that own the whole phone while a job is in progress.
 *
 * Receiving, plan building, crate building, issuing and the scan modes each
 * carry their own fixed action bar at the bottom — the tab bar sat on top of
 * it and swallowed the taps. These are modes, not destinations: you finish
 * or you cancel, and every one of them has its own way out, so the tab bar
 * (and the workspace strip) simply step aside.
 */
const FOCUS_ROUTES = ['/receive', '/plans/new', '/crates/new', '/issue', '/inventory'];
const FOCUS_SUFFIXES = ['/load', '/unload'];

export function isFocusMode(pathname: string) {
  return (
    FOCUS_ROUTES.some((route) => pathname === route || pathname.startsWith(`${route}/`)) ||
    FOCUS_SUFFIXES.some((suffix) => pathname.endsWith(suffix))
  );
}

/** Which workspace this page belongs to, for the viewer's own menu. */
export function useWorkspacePlacement(workspaces: WsNav[]) {
  const pathname = usePathname();
  return { pathname, placement: placementOf(pathname, workspaces) };
}

/**
 * The bottom tab bar, and the sheet behind "More".
 *
 * Four destinations are always a thumb away — each job's own four (owner,
 * 2026-09-26, answer 6) — and everything else is one tap behind them: the
 * «Tez-tez» pages first, then the workspaces, then the pages of the workspace
 * this screen belongs to.
 *
 * Phone only: from `md` up the same links live in a sidebar, where there is
 * room to show them all at once.
 */
export function MobileNav({
  primary,
  workspaces,
  frequent,
  labels,
}: {
  primary: NavItem[];
  workspaces: WsNav[];
  frequent: FrequentNav[];
  labels: NavLabels;
}) {
  const { pathname, placement } = useWorkspacePlacement(workspaces);
  const [open, setOpen] = useState(false);

  // The sheet lives in the LAYOUT, which survives navigation — so a tap that
  // navigated some way other than the link's own onClick (the admin tab bar,
  // a back gesture) left it standing over the new page until a second tap
  // (owner, 2026-07-28). The route changing IS the close signal.
  useEffect(() => {
    // eslint-disable-next-line react-hooks/set-state-in-effect
    setOpen(false);
  }, [pathname]);

  if (isFocusMode(pathname)) return null;

  // The workspace this page belongs to — its pages open in the sheet.
  const here = placement ? workspaces.find((ws) => ws.key === placement.workspace) : undefined;
  // A page already under the thumb in the tab bar is not repeated above it.
  const onBar = new Set(primary.map((item) => item.href));
  const sheetFrequent = frequent.filter((item) => !onBar.has(item.href));

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
          <div
            data-testid="more-sheet"
            className="pb-safe absolute inset-x-0 bottom-0 max-h-[80vh] overflow-y-auto rounded-t-2xl bg-surface-raised p-4 shadow-pop"
          >
            <div className="mx-auto mb-3 h-1 w-10 rounded-full bg-line-strong" />
            <div className="space-y-4">
              {sheetFrequent.length > 0 && (
                <div className="space-y-1.5">
                  <p className="section-title">{labels.frequent}</p>
                  <div className="grid grid-cols-2 gap-2">
                    {sheetFrequent.map((item) => (
                      <Link
                        key={item.href}
                        href={item.href}
                        onClick={() => setOpen(false)}
                        className="flex min-h-11 items-center gap-2 rounded-xl border border-line bg-surface-raised px-3 py-2 text-sm font-semibold text-ink-700"
                      >
                        <Icon
                          name={item.starred ? 'star' : item.icon}
                          className={`h-5 w-5 shrink-0 ${item.starred ? 'fill-warn text-warn' : ''}`}
                        />
                        <span className="truncate">{item.label}</span>
                      </Link>
                    ))}
                  </div>
                </div>
              )}
              {/* The workspaces as cards (one tap = its first page), and only
                  the one this page belongs to opened into its pages below —
                  every workspace's pages at once was 62 chips on the owner's
                  phone, a list nobody reads (measured, the review of this
                  round). Each card and chip is a thumb's 44 px. */}
              <div className="space-y-1.5">
                <p className="section-title">{labels.workspaces}</p>
                <div className="grid grid-cols-2 gap-2">
                  {workspaces.map((ws) => (
                    <Link
                      key={ws.key}
                      href={ws.href}
                      onClick={() => setOpen(false)}
                      className={`flex min-h-11 items-center gap-2 rounded-xl border px-3 py-2 text-sm font-semibold ${
                        here?.key === ws.key
                          ? 'border-brand-200 bg-brand-50 text-brand-800'
                          : 'border-line bg-surface-raised text-ink-700'
                      }`}
                    >
                      <Icon name={ws.icon} className="h-5 w-5 shrink-0" />
                      <span className="min-w-0 leading-tight [overflow-wrap:anywhere]">{ws.label}</span>
                    </Link>
                  ))}
                </div>
              </div>
              {here && here.tabs.length > 1 && (
                <div className="space-y-1.5" data-testid="more-sheet-pages">
                  <p className="section-title">{here.label}</p>
                  <div className="flex flex-wrap gap-1.5">
                    {[...here.tabs, ...here.settings].map((tab) => (
                      <Link
                        key={tab.href}
                        href={tab.href}
                        onClick={() => setOpen(false)}
                        className={`flex min-h-10 items-center gap-1.5 rounded-lg border px-3 text-sm font-semibold ${
                          placement?.href === tab.href
                            ? 'border-brand-200 bg-brand-50 text-brand-800'
                            : 'border-line text-ink-700'
                        }`}
                      >
                        {/* A setting is marked as one — the ⚙ the strip
                            gathers them under on a list page. */}
                        {here.settings.includes(tab) && <Icon name="settings" className="h-4 w-4 text-ink-400" />}
                        {tab.label}
                      </Link>
                    ))}
                  </div>
                </div>
              )}
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
            data-testid="more-button"
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

/**
 * The desktop menu: «Tez-tez», then the workspaces, then «Boshqaruv» at the
 * foot (the canvas's board 2) — and collapsible to an icon rail (owner,
 * 2026-07-28: "sidemenu collapsable bo'lishi kerak"). The choice is
 * remembered per browser; hovering a collapsed icon still names it via
 * `title`.
 *
 * The workspace a page belongs to is lit with `aria-current="true"`, never
 * `"page"`: the PAGE's own tab in the strip carries that, and a document with
 * two «current page» links tells a screen reader two different things.
 */
export function Sidebar({
  workspaces,
  frequent,
  labels,
}: {
  workspaces: WsNav[];
  frequent: FrequentNav[];
  labels: NavLabels;
}) {
  const { placement } = useWorkspacePlacement(workspaces);
  const [collapsed, setCollapsed] = useState(false);
  // localStorage is read after mount on purpose: the server render cannot
  // know it, and a mismatched first frame is a hydration error.
  useEffect(() => {
    // eslint-disable-next-line react-hooks/set-state-in-effect
    setCollapsed(localStorage.getItem('gsr-sidebar-collapsed') === '1');
  }, []);
  const toggle = () =>
    setCollapsed((value) => {
      localStorage.setItem('gsr-sidebar-collapsed', value ? '0' : '1');
      return !value;
    });

  const main = workspaces.filter((ws) => ws.key !== 'admin');
  const admin = workspaces.find((ws) => ws.key === 'admin');

  const row = (ws: WsNav) => {
    const here = placement?.workspace === ws.key;
    return (
      <Link
        key={ws.key}
        href={ws.href}
        data-testid={`ws-${ws.key}`}
        aria-current={here ? 'true' : undefined}
        title={ws.label}
        className={`flex items-center rounded-xl text-sm ${
          collapsed ? 'justify-center py-2' : 'gap-2.5 px-2.5 py-2'
        } ${
          here
            ? 'bg-brand-50 font-bold text-brand-800'
            : 'font-semibold text-ink-700 hover:bg-surface-sunken'
        }`}
      >
        <Icon name={ws.icon} className="h-5 w-5 shrink-0" />
        {/* Wraps rather than truncates: «Клиенты и продажи» is the name of
            the place, and «Клиенты и прод…» at 224 px is not. */}
        {!collapsed && (
          <span className="min-w-0 leading-tight" data-testid="ws-label">
            {ws.label}
          </span>
        )}
      </Link>
    );
  };

  return (
    <nav
      data-testid="sidebar"
      className={`hidden shrink-0 border-r border-line bg-surface-raised md:block ${
        collapsed ? 'w-14' : 'w-56'
      }`}
    >
      {/* Its OWN scrollbar, not the page's. `sticky` alone pins the block but
          gives it no height, so a menu taller than the screen could only be
          reached by scrolling the whole page — and then the menu went up with
          it and the bottom rows were unreachable (owner). */}
      <div
        className={`sticky top-14 max-h-[calc(100dvh-3.5rem)] space-y-4 overflow-y-auto overscroll-contain ${
          collapsed ? 'p-1.5' : 'p-3'
        }`}
      >
        <button
          type="button"
          onClick={toggle}
          data-testid="sidebar-toggle"
          aria-expanded={!collapsed}
          className={`flex w-full items-center rounded-xl py-1.5 text-ink-500 hover:bg-surface-sunken ${
            collapsed ? 'justify-center' : 'justify-end px-2'
          }`}
        >
          <Icon name={collapsed ? 'chevronRight' : 'chevronLeft'} className="h-5 w-5" />
        </button>

        {frequent.length > 0 && (
          <div className="space-y-0.5" data-testid="frequent">
            {!collapsed && <p className="section-title px-2">{labels.frequent}</p>}
            {frequent.map((item) => (
              <Link
                key={item.href}
                href={item.href}
                title={`${item.label} · ${item.where}`}
                data-testid="frequent-item"
                className={`flex items-center rounded-lg text-sm text-ink-700 hover:bg-surface-sunken ${
                  collapsed ? 'justify-center py-1.5' : 'gap-2 px-2.5 py-1.5'
                } ${placement?.href === item.href ? 'bg-surface-sunken font-semibold' : ''}`}
              >
                <Icon
                  name={item.starred ? 'star' : item.icon}
                  className={`h-4 w-4 shrink-0 ${item.starred ? 'fill-warn text-warn' : 'text-ink-500'}`}
                />
                {!collapsed && (
                  <>
                    <span className="min-w-0 flex-1 truncate">{item.label}</span>
                    <span className="shrink-0 text-2xs text-ink-400">{item.where}</span>
                  </>
                )}
              </Link>
            ))}
          </div>
        )}

        <div className="space-y-0.5" data-testid="ws-list">
          {!collapsed && <p className="section-title px-2">{labels.workspaces}</p>}
          {main.map(row)}
        </div>

        {admin && <div className="border-t border-line pt-3">{row(admin)}</div>}
      </div>
    </nav>
  );
}
