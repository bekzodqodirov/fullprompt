import { and, eq, sql } from 'drizzle-orm';
import { db } from '../db/client';
import { navUsage } from '../db/schema';
import { aiConfigured } from '../ai/model';
import { visibleWorkspaces, type VisibleWorkspace } from '../rbac/workspaces';
import type { Viewer } from '../rbac/nav';

/**
 * «Tez-tez» — the pages a person keeps coming back to (owner, 2026-09-26,
 * answer 2c: both the ones they STAR and the ones the system notices).
 *
 * Every rule about WHICH href may be counted lives in `offeredHrefs`: the
 * browser says «I am on this tab», and the server believes it only for a tab
 * it would itself have drawn for this person. So a hand-posted href can move
 * nothing but the poster's own ordering of pages they were already offered.
 */

/** A star is a promise to keep something in view; eight is a menu, twenty is not. */
export const STAR_LIMIT = 8;
/**
 * The noticed pages under the stars. Three, and only pages opened about three
 * times lately: a block that fills itself with every page touched once moves
 * under the person's hand every day, which is the opposite of a menu. 2.5 and
 * not 3 because three visits a minute apart decay to 2.9999…, so «3» would
 * mean four.
 */
export const AUTO_LIMIT = 3;
export const AUTO_MIN_SCORE = 2.5;
/** A page opened daily last month must not outrank what this week is about. */
const HALF_LIFE_SECONDS = 14 * 86_400;

/**
 * The decayed score, in SQL, so «now» is the database's clock (#156: a JS Date
 * bound into raw sql reaches postgres.js untyped). Written against the TABLE
 * name because it is used inside an ON CONFLICT, where drizzle would render the
 * column bare and postgres would call it ambiguous.
 */
const DECAYED = sql.raw(
  `nav_usage.score * power(0.5, extract(epoch from (now() - nav_usage.last_at)) / ${HALF_LIFE_SECONDS})`,
);

/**
 * The browser-test switch (`NAV_AUTO=off`, set by playwright.config.ts): one
 * worker drives the same demo accounts through two hundred specs, and a menu
 * that rearranges itself from what the PREVIOUS spec opened is state one spec
 * leaves for the next (#154, #183). Stars still work — a spec that sets one
 * takes it off again — and the automatic half is proven in the integration
 * suite with users of its own.
 */
function countsVisits(): boolean {
  return process.env.NAV_AUTO !== 'off';
}

/** The switched-off doors: the AI page exists only once its key does. */
export function hiddenHrefs(): Set<string> {
  return aiConfigured() ? new Set() : new Set(['/ai']);
}

/** The workspaces this person is drawn — the ONE answer the shell and this module share. */
export function workspacesFor(viewer: Viewer): VisibleWorkspace[] {
  return visibleWorkspaces(viewer, hiddenHrefs());
}

/** Every tab and settings page this person is offered anywhere in the menu. */
export function offeredHrefs(workspaces: VisibleWorkspace[]): Set<string> {
  return new Set(workspaces.flatMap((ws) => [...ws.tabs, ...ws.settings].map((tab) => tab.href)));
}

/**
 * The hrefs that are a workspace's own menu row. They are one click away
 * already, so they are never also a «Tez-tez» row — and a duplicate link in
 * the sidebar is exactly what strict page locators refuse.
 */
export function entryHrefs(workspaces: VisibleWorkspace[]): Set<string> {
  return new Set(workspaces.map((ws) => ws.href));
}

/** «I am on this tab.» Refused silently for anything this person is not offered. */
export async function recordVisit(userId: string, viewer: Viewer, href: string): Promise<boolean> {
  if (!countsVisits()) return false;
  if (!offeredHrefs(workspacesFor(viewer)).has(href)) return false;
  await db
    .insert(navUsage)
    .values({ userId, href, score: 1 })
    .onConflictDoUpdate({
      target: [navUsage.userId, navUsage.href],
      set: { score: sql`${DECAYED} + 1`, lastAt: sql`now()` },
    });
  return true;
}

export type StarResult = { ok: true } | { ok: false; error: 'not_offered' | 'entry' | 'full' };

/**
 * Star or unstar a tab. A workspace's own row cannot be starred — it is
 * already in the menu, and the button is not drawn there — and the ninth star
 * is refused rather than silently dropping the oldest.
 */
export async function setStar(
  userId: string,
  viewer: Viewer,
  href: string,
  on: boolean,
): Promise<StarResult> {
  if (on) {
    const workspaces = workspacesFor(viewer);
    if (!offeredHrefs(workspaces).has(href)) return { ok: false, error: 'not_offered' };
    if (entryHrefs(workspaces).has(href)) return { ok: false, error: 'entry' };
    const [row] = await db
      .select({ n: sql<number>`count(*)::int` })
      .from(navUsage)
      .where(and(eq(navUsage.userId, userId), eq(navUsage.starred, true), sql`${navUsage.href} <> ${href}`));
    if ((row?.n ?? 0) >= STAR_LIMIT) return { ok: false, error: 'full' };
    await db
      .insert(navUsage)
      .values({ userId, href, starred: true, starredAt: sql`now()` })
      .onConflictDoUpdate({
        target: [navUsage.userId, navUsage.href],
        // A second press on a star keeps its place in the order.
        set: { starred: true, starredAt: sql`coalesce(nav_usage.starred_at, now())` },
      });
    return { ok: true };
  }
  // Unstarring needs no «offered» check: taking a star OFF a page somebody can
  // no longer open is exactly the cleanup they should be able to do. An
  // UPDATE, never an insert, so a forged href cannot mint a row.
  await db
    .update(navUsage)
    .set({ starred: false, starredAt: null })
    .where(and(eq(navUsage.userId, userId), eq(navUsage.href, href)));
  return { ok: true };
}

export interface FrequentRow {
  href: string;
  starred: boolean;
}

/**
 * The «Tez-tez» block: the stars in the order they were given, then up to
 * three noticed pages in the MENU's own order (workspace, then tab) — chosen
 * by decayed score, but never ordered by it, or the block would shuffle under
 * the person's hand as the counts crossed. Filtered against what the menu
 * offers THIS render, so a page whose permission was taken away yesterday
 * disappears from it today without anybody deleting a row.
 */
export async function frequentFor(userId: string, workspaces: VisibleWorkspace[]): Promise<FrequentRow[]> {
  const menuOrder = workspaces.flatMap((ws) => [...ws.tabs, ...ws.settings].map((tab) => tab.href));
  const offered = new Set(menuOrder);
  const entries = entryHrefs(workspaces);
  const rows = await db
    .select({
      href: navUsage.href,
      starred: navUsage.starred,
      score: sql<number>`${DECAYED}`.mapWith(Number),
    })
    .from(navUsage)
    .where(eq(navUsage.userId, userId))
    .orderBy(sql`${navUsage.starredAt} ASC NULLS LAST`, sql`${DECAYED} DESC`, navUsage.href);

  const usable = rows.filter((row) => offered.has(row.href) && !entries.has(row.href));
  const stars = usable.filter((row) => row.starred).slice(0, STAR_LIMIT);
  const noticed = usable
    .filter((row) => !row.starred && row.score >= AUTO_MIN_SCORE)
    .slice(0, AUTO_LIMIT)
    .sort((a, b) => menuOrder.indexOf(a.href) - menuOrder.indexOf(b.href));
  return [...stars, ...noticed].map((row) => ({ href: row.href, starred: row.starred }));
}
