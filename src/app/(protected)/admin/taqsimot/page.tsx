import { inArray } from 'drizzle-orm';
import { redirect } from 'next/navigation';
import { getTranslations } from 'next-intl/server';
import { db } from '@/modules/platform/db/client';
import { users } from '@/modules/platform/db/schema';
import { getActor } from '@/modules/platform/rbac/authorize';
import { INBOUND_SOURCE_KEYS } from '@/modules/wms/crm/inbound';
import { listRoutes, rotaMembers } from '@/modules/wms/crm/routing';
import { RotaForm } from './rota-form';
import { RouteList } from './route-list';

/**
 * Taqsimot (round 96): who takes inbound leads, and which stream goes to whom.
 *
 * The owner's design in one screen: a per-PERSON participant list («hamma
 * sotuvchi, lekin hamma lead bilan ishlamaydi») above an ordered rule list —
 * read top-down, first match wins, no match falls to the general rotation.
 * Gated like the settings screen, not with a freshly minted permission (#170).
 */
export default async function TaqsimotPage() {
  const actor = await getActor();
  if (!actor) redirect('/login');
  if (!actor.permissions.has('admin.settings.manage')) redirect('/');
  const t = await getTranslations('routing');

  const members = await rotaMembers();
  const routes = await listRoutes();

  // Names for rule members come from their own query, NOT the participant
  // list: a rule may point at somebody who was later deactivated, and «?» in
  // place of their name would hide exactly the row that needs fixing.
  const memberIds = [...new Set(routes.flatMap((route) => route.userIds))];
  const named = memberIds.length
    ? await db
        .select({ id: users.id, fullName: users.fullName, active: users.active })
        .from(users)
        .where(inArray(users.id, memberIds))
    : [];
  const names = new Map(named.map((row) => [row.id, row.active ? row.fullName : `${row.fullName} ⚠`]));

  return (
    <div className="mx-auto max-w-lg space-y-4">
      <h1 className="text-xl font-bold">📣 {t('title')}</h1>
      <p className="text-sm text-ink-500">{t('intro')}</p>
      <RotaForm members={members.map((m) => ({ id: m.id, name: m.fullName, inRota: m.inRota }))} />
      <RouteList
        routes={routes.map((route) => ({
          id: route.id,
          sourceKey: route.sourceKey,
          keyword: route.keyword,
          active: route.active,
          memberNames: route.userIds.map((id) => names.get(id) ?? '—'),
        }))}
        people={members.map((m) => ({ id: m.id, name: m.fullName }))}
        sources={[...INBOUND_SOURCE_KEYS]}
      />
    </div>
  );
}
