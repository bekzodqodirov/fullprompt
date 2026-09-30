'use client';

import { useEffect, useRef, useState, useTransition } from 'react';
import Link from 'next/link';
import { Icon } from './icon';
import { isFocusMode, useWorkspacePlacement, type NavLabels, type WsNav } from './nav';
import { toggleStarAction } from '@/modules/platform/nav/actions';

/**
 * The workspace's own pages, in one strip at the top of every page of it
 * (owner, 2026-09-26: «kerakli narsalar tarqoq … bir biriga bog'liq bo'lgan
 * narsalar boshqa yerda yotibti»).
 *
 * Rendered ONCE, by the layout, from the pathname — no page carries its own
 * copy, which is how the accounting and CRM strips drifted from the menu they
 * sat under. The two old strips are gone; their pages' GATES stayed.
 *
 * Absent where it would get in the way: on «Bosh sahifa» (the home IS the
 * overview), on «Boshqaruv» (its hub of buttons is its navigation), in the
 * scan and wizard modes (they own the phone), in a workspace that offers this
 * person a single page (a strip of one tab navigates nowhere — the packer's
 * «Yo'l» and every truck card), and — on a PHONE — everywhere but a
 * workspace's own list pages: a card, a chat thread and the two kanban boards
 * are screens a phone gives entirely to one thing (round 72), and 41 px of
 * navigation above a deal card is 41 px of the deal gone. From `md` up it is
 * drawn on every page of the workspace, and the screens built on a viewport
 * height pay for it through `--ws-strip` (globals.css).
 *
 * The strip is also where a page is counted for «Tez-tez» and where it is
 * starred: a visit is the active TAB's href, never the raw URL, and it is sent
 * from an effect so a hover's prefetch never counts (ChatMarkRead's rule).
 */
export function WorkspaceTabs({
  workspaces,
  starred,
  labels,
}: {
  workspaces: WsNav[];
  starred: string[];
  labels: NavLabels;
}) {
  const { pathname, placement } = useWorkspacePlacement(workspaces);
  const ws = placement ? workspaces.find((one) => one.key === placement.workspace) : undefined;
  const pages = ws ? ws.tabs.length + ws.settings.length : 0;
  const shown = Boolean(ws?.strip) && pages >= 2 && !isFocusMode(pathname);
  // Only a real tab is counted: a workspace's non-tab page (/crm/today) is
  // somewhere the person was sent, not a page they chose.
  const counted = shown && placement?.tab ? placement.href : null;

  useEffect(() => {
    if (!counted) return;
    void fetch('/api/nav/visit', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ href: counted }),
      keepalive: true,
    }).catch(() => {});
  }, [counted]);

  if (!shown || !ws || !placement) return null;

  // A list page is the only place a phone draws the strip; the boards are
  // list pages that own the screen anyway.
  const onPhone = pathname === placement.href && pathname !== '/crm' && pathname !== '/bitimlar';
  const active = placement.tab ? placement.href : null;
  // «This page» only ON the page. Under it — a card under its list, a truck's
  // tab under /batches — the lit tab says `true`, because the card's own tab
  // strip carries `page` there, and a document with two «current page» links
  // tells a screen reader two different things (nav.tsx's rule).
  const litAs: LitAs = pathname === placement.href ? 'page' : 'true';

  return (
    <nav
      data-testid="ws-tabs"
      aria-label={`${ws.label} — ${labels.tabs}`}
      className={`${onPhone ? '' : 'hidden md:block'} relative -mx-4 -mt-4 mb-3 border-b border-line bg-surface-raised`}
    >
      {/* The keys reset each part on a navigation, and each carries its own
          prefix because siblings share ONE key space: unprefixed, the picker
          and the ☆ were the same string always and the ⚙ equalled the ☆ on
          every list page. When a key changes React files the old children in
          one map by key, two equal keys are one entry, and the loser is never
          removed — every click left the previous strip standing in the row
          (the owner's screenshot, 2026-09-30; DECISIONS #1247). */}
      <div className="flex h-11 items-center gap-1 px-2 md:px-3">
        {ws.groups ? (
          <GroupedTabs
            key={`groups:${placement.href}`}
            ws={ws}
            active={active}
            litAs={litAs}
            more={labels.more}
          />
        ) : (
          <TabRow tabs={ws.tabs} active={active} litAs={litAs} more={labels.more} />
        )}
        {placement.tab && (
          <StarButton
            key={`star:${placement.href}`}
            href={placement.href}
            entry={ws.href === placement.href}
            on={starred.includes(placement.href)}
            labels={labels}
          />
        )}
        {ws.settings.length > 0 && (
          <SettingsMenu
            key={`settings:${pathname}`}
            settings={ws.settings}
            active={placement.settings ? placement.href : null}
            litAs={litAs}
            label={labels.settings}
          />
        )}
      </div>
    </nav>
  );
}

/**
 * One row. On a phone it scrolls sideways under a finger. From `md` a mouse
 * cannot swipe, and a row clipped with no scrollbar reads as «that is all
 * there is» — measured in ru at 1280 px, Pul's last three pages and Savdo's
 * last one simply were not there — so what does not fit folds into «Yana ▾»
 * at the row's end, with the lit page always kept in view.
 */
type LitAs = 'page' | 'true';

function TabRow({
  tabs,
  active,
  litAs,
  more,
}: {
  tabs: WsNav['tabs'];
  active: string | null;
  litAs: LitAs;
  more: string;
}) {
  const row = useRef<HTMLDivElement>(null);
  // How many tabs fit from `md` up; null = all of them (a phone, or not yet
  // measured). Widths are read ONCE per list of tabs, from a render showing
  // all of them — a tab's width does not change with the window — and a
  // resize only re-divides them. Both are TAGGED with the list they belong
  // to: the layout reuses this row when the person crosses to another
  // workspace, and a count worked out for Sklad's tabs applied to Yo'l's
  // left «Kutilayotgan yuk» clipped off the row's end with no «Yana ▾»
  // (DECISIONS #1248). A count for another list is no count: all are drawn,
  // and that full render is the one the widths are read from.
  const signature = tabs.map((tab) => `${tab.href}:${tab.label}`).join('|');
  const [fitted, setFitted] = useState<{ signature: string; count: number } | null>(null);
  const fit = fitted?.signature === signature ? fitted.count : null;
  const widths = useRef<{ signature: string; list: number[] } | null>(null);

  useEffect(() => {
    const el = row.current;
    if (!el) return;
    const measure = () => {
      // A row that is not drawn — a report group other than the picked one —
      // has no room to divide, and every link in it measures 0 px: read then,
      // its widths said everything fits, and the group picked later showed
      // its tabs clipped off the edge. Nothing is read or decided until the
      // row gets a size; the observer fires when it does.
      if (el.clientWidth === 0) return;
      if (!window.matchMedia('(min-width: 768px)').matches) return setFitted(null);
      if (widths.current?.signature !== signature) {
        const links = el.querySelectorAll<HTMLElement>('[data-ws-tab]');
        widths.current = { signature, list: Array.from(links, (link) => link.offsetWidth + 4) };
      }
      const list = widths.current.list;
      const room = el.clientWidth;
      const total = list.reduce((sum, width) => sum + width, 0);
      if (total <= room) return setFitted(null);
      // Leave room for «Yana ▾» itself.
      let used = 88;
      let count = 0;
      for (const width of list) {
        if (used + width > room) break;
        used += width;
        count += 1;
      }
      const next = Math.max(1, count);
      setFitted((prev) =>
        prev?.signature === signature && prev.count === next ? prev : { signature, count: next },
      );
    };
    measure();
    const observer = new ResizeObserver(measure);
    observer.observe(el);
    return () => observer.disconnect();
  }, [signature]);

  // Bring the lit tab into view on a phone: a narrow screen shows three or
  // four of a workspace's pages, and the one you are on may be the ninth.
  useEffect(() => {
    row.current?.querySelector('[aria-current]')?.scrollIntoView({ block: 'nearest', inline: 'nearest' });
  }, [active]);

  let shown = tabs;
  let folded: WsNav['tabs'] = [];
  if (fit !== null && fit < tabs.length) {
    shown = tabs.slice(0, fit);
    folded = tabs.slice(fit);
    const lit = folded.find((tab) => tab.href === active);
    if (lit) {
      // The page you are on is never inside the fold.
      folded = [shown[shown.length - 1]!, ...folded.filter((tab) => tab !== lit)];
      shown = [...shown.slice(0, -1), lit];
    }
  }

  return (
    <div
      ref={row}
      data-testid="ws-row"
      className="no-scrollbar flex min-w-0 flex-1 items-center gap-1 overflow-x-auto md:overflow-hidden"
    >
      {shown.map((tab) => {
        const lit = tab.href === active;
        return (
          <Link
            key={tab.href}
            href={tab.href}
            data-testid="ws-tab"
            data-ws-tab=""
            aria-current={lit ? litAs : undefined}
            className={`shrink-0 whitespace-nowrap rounded-lg px-2.5 py-1.5 text-sm font-semibold ${
              lit ? 'bg-brand-50 text-brand-800' : 'text-ink-700 hover:bg-surface-sunken'
            }`}
          >
            {tab.label}
          </Link>
        );
      })}
      {folded.length > 0 && (
        <details key={active ?? ''} className="shrink-0" data-testid="ws-more">
          <summary className="flex h-9 cursor-pointer list-none items-center gap-1 rounded-lg px-2.5 text-sm font-semibold text-ink-700 hover:bg-surface-sunken [&::-webkit-details-marker]:hidden">
            {more}
            <Icon name="chevronRight" className="h-4 w-4 rotate-90" />
          </summary>
          <div className="absolute right-2 top-full z-30 mt-1 w-64 space-y-0.5 rounded-xl border border-line bg-surface-raised p-1.5 shadow-pop">
            {folded.map((tab) => (
              <Link
                key={tab.href}
                href={tab.href}
                data-testid="ws-tab"
                className="block rounded-lg px-2.5 py-2 text-sm font-semibold text-ink-700 hover:bg-surface-sunken"
              >
                {tab.label}
              </Link>
            ))}
          </div>
        </details>
      )}
    </div>
  );
}

/**
 * Hisobotlar (answer 7a): the GROUPS are buttons that switch the row in place
 * — choosing «Moliya» is not a request to load whichever money report happens
 * to be first, and must not count as a visit to it. Every group's pages are
 * in the DOM (hidden but one), so nothing about which reports exist depends
 * on a click.
 */
function GroupedTabs({
  ws,
  active,
  litAs,
  more,
}: {
  ws: WsNav;
  active: string | null;
  litAs: LitAs;
  more: string;
}) {
  const groups = ws.groups ?? [];
  const current = ws.tabs.find((tab) => tab.href === active)?.group ?? groups[0]?.key;
  const [shown, setShown] = useState(current);
  if (groups.length < 2) return <TabRow tabs={ws.tabs} active={active} litAs={litAs} more={more} />;
  return (
    <div className="flex min-w-0 flex-1 items-center gap-2">
      <select
        data-testid="ws-group"
        aria-label={ws.label}
        value={shown}
        onChange={(event) => setShown(event.target.value)}
        className="h-8 shrink-0 rounded-lg border border-line bg-surface-sunken px-2 text-xs font-bold text-ink-700"
      >
        {groups.map((group) => (
          <option key={group.key} value={group.key}>
            {group.label}
          </option>
        ))}
      </select>
      {groups.map((group) => (
        <div key={group.key} className={group.key === shown ? 'flex min-w-0 flex-1' : 'hidden'}>
          <TabRow tabs={ws.tabs.filter((tab) => tab.group === group.key)} active={active} litAs={litAs} more={more} />
        </div>
      ))}
    </div>
  );
}

/**
 * ☆ — keep THIS page in «Tez-tez». Not drawn on a workspace's first page: that
 * one is the workspace's own menu row already, one click from anywhere.
 */
function StarButton({
  href,
  entry,
  on,
  labels,
}: {
  href: string;
  entry: boolean;
  on: boolean;
  labels: NavLabels;
}) {
  const [pending, start] = useTransition();
  const [full, setFull] = useState(false);
  if (entry) return null;
  return (
    <button
      type="button"
      data-testid="ws-star"
      aria-pressed={on}
      aria-label={full ? labels.starFull : on ? labels.unstar : labels.star}
      title={full ? labels.starFull : on ? labels.unstar : labels.star}
      disabled={pending}
      onClick={() =>
        start(async () => {
          const result = await toggleStarAction(href, !on);
          setFull(!result.ok && result.error === 'full');
        })
      }
      className={`grid h-9 w-9 shrink-0 place-items-center rounded-lg hover:bg-surface-sunken ${
        full ? 'text-bad' : on ? 'text-warn' : 'text-ink-400'
      }`}
    >
      <Icon name="star" className={`h-5 w-5 ${on ? 'fill-warn' : ''}`} />
    </button>
  );
}

/**
 * ⚙ — the workspace's own settings (answer 8b). A native `<details>` keyed on
 * the pathname by its parent, so a navigation closes it; anchored to the ROW
 * (`relative` on the nav), never to its own button, or it would open off a
 * 360 px screen (#471).
 */
function SettingsMenu({
  settings,
  active,
  litAs,
  label,
}: {
  settings: WsNav['settings'];
  active: string | null;
  litAs: LitAs;
  label: string;
}) {
  return (
    <details className="shrink-0" data-testid="ws-settings">
      <summary
        aria-label={label}
        title={label}
        className={`grid h-9 w-9 cursor-pointer list-none place-items-center rounded-lg hover:bg-surface-sunken [&::-webkit-details-marker]:hidden ${
          active ? 'text-brand-700' : 'text-ink-500'
        }`}
      >
        <Icon name="settings" className="h-5 w-5" />
      </summary>
      <div className="absolute right-2 top-full z-30 mt-1 w-64 max-w-[calc(100vw-2rem)] space-y-0.5 rounded-xl border border-line bg-surface-raised p-1.5 shadow-pop">
        <p className="section-title px-2 pb-1 pt-1">{label}</p>
        {settings.map((item) => (
          <Link
            key={item.href}
            href={item.href}
            data-testid="ws-setting"
            aria-current={item.href === active ? litAs : undefined}
            className={`block rounded-lg px-2.5 py-2 text-sm font-semibold ${
              item.href === active ? 'bg-brand-50 text-brand-800' : 'text-ink-700 hover:bg-surface-sunken'
            }`}
          >
            {item.label}
          </Link>
        ))}
      </div>
    </details>
  );
}
