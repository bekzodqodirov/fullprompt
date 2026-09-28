import { cache } from 'react';
import { eq } from 'drizzle-orm';
import { db } from '../../platform/db/client';
import { clients } from '../../platform/db/schema';

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

/**
 * The client a card tab is about, once per request — the tab's title
 * («GS777 · Yuklar», `generateMetadata`) and its body read the same row, and
 * without the memo the title costs a second lookup (the tab's judge, finding
 * 14). Keyed by the id, a primitive (docs/CARD-TABS.md). An id that is not a
 * uuid is «no such client» rather than a 22P02 from postgres.
 */
export const clientHeadOnce = cache(async (id: string) => {
  if (!UUID.test(id)) return undefined;
  return db.query.clients.findFirst({ where: eq(clients.id, id) });
});
