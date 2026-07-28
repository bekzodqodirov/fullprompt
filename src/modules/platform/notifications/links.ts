/**
 * Where a record's card lives — for the deep links Telegram messages carry.
 *
 * Owner: "tasklarni telegramdan jo'natadigan qil, task linklari bilan." A
 * notification that names a task but cannot take you to it is a reminder to
 * go searching; the link is what turns it into a way of working. The same map
 * serves the internal-note messages, which land beside the card they were
 * written on.
 *
 * A map, not routing knowledge scattered through senders: when a card moves,
 * this is the one place the messages learn it from.
 */
const CARD_PATHS: Record<string, string> = {
  client: '/admin/clients',
  lead: '/crm/leads',
  deal: '/bitimlar',
  receipt: '/receipts',
  batch: '/batches',
  crate: '/crates',
  plan: '/plans',
};

export function entityHref(entityType: string | null, entityId: string | null): string | null {
  if (!entityType || !entityId) return null;
  const base = CARD_PATHS[entityType];
  return base ? `${base}/${entityId}` : null;
}

/**
 * Absolute, because it goes into a Telegram message opened on a phone.
 * Falls back to «Mening kunim» — a task with no card still has a screen
 * where it can be acted on.
 */
export function taskLink(entityType: string | null, entityId: string | null): string {
  const appUrl = (process.env.APP_URL ?? '').replace(/\/$/, '');
  return `${appUrl}${entityHref(entityType, entityId) ?? '/bugun'}`;
}

export function cardLink(entityType: string, entityId: string): string | null {
  const appUrl = (process.env.APP_URL ?? '').replace(/\/$/, '');
  const href = entityHref(entityType, entityId);
  return href ? `${appUrl}${href}` : null;
}
