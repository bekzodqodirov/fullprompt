/**
 * Which menu row is lit, and which pages are not the section their URL says
 * they are in.
 *
 * Both facts live here because they are the same fact, and because two
 * components used to answer the second one differently: the tab bar and the
 * sidebar highlighted by URL prefix, while `AdminBack` decided by exact
 * match. On /admin/clients that meant «Mijozlar» AND «Boshqaruv» were both
 * lit and the page wore an «← Boshqaruv» link — the app telling the owner
 * three times that his client book is an administration screen, which is
 * exactly what he asked us to stop doing (round 75: "adminstrativnoedagi
 * klientini glavniga chiqaz").
 */

/**
 * Pages that live under /admin for historical reasons and are NOT part of
 * the administration section.
 *
 * The client book is a SALES screen: it is opened from the Sotuv tiles, a
 * client card is linked from every lead, deal, task and Telegram message,
 * and `admin/layout.tsx` has carried a special case since a sales manager
 * was first bounced off their own call list. This list says the same thing
 * to the navigation.
 *
 * It is deliberately about CHROME only. The route is unchanged and so is
 * every permission — a URL is not access, and moving this one would break
 * client links already sitting in staff Telegram history.
 */
export const NOT_ADMIN_SECTION = ['/admin/clients'];

/** Is `pathname` inside one of the sections that only pretends to be admin? */
function inBorrowedSection(pathname: string): string | null {
  return (
    NOT_ADMIN_SECTION.find(
      (route) => pathname === route || pathname.startsWith(`${route}/`),
    ) ?? null
  );
}

/**
 * Pages that are a menu row of their OWN although their URL sits under
 * another row's: /accounting/expenses has had its own door beside
 * «Boshqaruv hisobi» since 2026-09-26, and lighting both rows for one page
 * reads as two places to go.
 */
const OWN_ROW_PAGES = ['/accounting/expenses'];

/**
 * Should the menu row for `href` be highlighted on `pathname`?
 *
 * `/stock` matches `/stock/abc` but `/` only matches itself — and a section
 * that merely CONTAINS a borrowed page does not light up for it, so
 * /admin/clients lights «Mijozlar» alone while /admin/warehouses still
 * lights «Boshqaruv».
 */
export function isActive(pathname: string, href: string): boolean {
  if (href === '/') return pathname === '/';
  const borrowed = inBorrowedSection(pathname);
  if (borrowed && href.length < borrowed.length && borrowed.startsWith(`${href}/`)) {
    return false;
  }
  const own = OWN_ROW_PAGES.find((route) => pathname === route || pathname.startsWith(`${route}/`));
  if (own && href !== own && own.startsWith(`${href}/`)) return false;
  return pathname === href || pathname.startsWith(`${href}/`);
}

/** Does this page belong to the administration section at all? */
export function isAdminSectionPage(pathname: string): boolean {
  return pathname.startsWith('/admin') && inBorrowedSection(pathname) === null;
}
