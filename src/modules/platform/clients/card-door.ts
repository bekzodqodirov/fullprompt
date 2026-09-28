/**
 * The client card's doors — the card itself and the two books a person comes
 * back to it from (docs/CARD-TABS.md, «The client: «Umumiy» and «Pul»»).
 *
 * The card is «Umumiy», one of two tabs; the other is the client's ledger,
 * whose door is money's and lives in `wms/finance/scope.ts` (platform must
 * not import wms). Each tab page asks its own door and the card's strip asks
 * the same two functions, so a drawn tab can never bounce — and a back link
 * drawn from here is admitted by the page it points at, for the same reason
 * (the admin layout's own sentence: a door that bounces is worse than no
 * door).
 */

type Grants = { permissions: { has(code: string): boolean } };

/**
 * «Umumiy» — `/admin/clients/<id>`. The client book's administrator, and a
 * seller reading the card their call list, the funnel and /suhbatlar send
 * them to (their own clients through `clients.view_own`, anyone's they are
 * working through `crm.leads`). The admin layout asks it too, as the client
 * half of its cosmetic gate: the card only happens to live under /admin.
 *
 * Deliberately NOT a money door: what the card prints about money is asked
 * of the ledger's door, per client.
 */
export function mayOpenClientCard(actor: Grants): boolean {
  return (
    actor.permissions.has('clients.manage') ||
    actor.permissions.has('clients.view_own') ||
    actor.permissions.has('crm.leads')
  );
}

/** `/my-clients` — a seller's own book, and everyone's for the book's administrator. */
export function mayOpenMyClients(actor: Grants): boolean {
  return actor.permissions.has('crm.leads') || actor.permissions.has('clients.manage');
}

/**
 * Where «←» on the card goes: the client book for whoever administers it,
 * a seller's own book for a seller, and nowhere for anybody else — a person
 * whose only grant is `clients.view_own` has no list page to go back to, and
 * a link to one they would bounce off is worse than no link.
 */
export function clientBookBack(actor: Grants): '/admin/clients' | '/my-clients' | null {
  if (actor.permissions.has('clients.manage')) return '/admin/clients';
  if (mayOpenMyClients(actor)) return '/my-clients';
  return null;
}
