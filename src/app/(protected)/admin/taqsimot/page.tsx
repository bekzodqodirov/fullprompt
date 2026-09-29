import { inArray } from 'drizzle-orm';
import { redirect } from 'next/navigation';
import { getTranslations } from 'next-intl/server';
import { db } from '@/modules/platform/db/client';
import { users } from '@/modules/platform/db/schema';
import { canLogInSql } from '@/modules/platform/users/login';
import { listFields } from '@/modules/platform/fields/service';
import { getActor } from '@/modules/platform/rbac/authorize';
import { MAPPABLE_FIELD_TYPES, listFieldMap, seenKeys } from '@/modules/wms/crm/field-map';
import { INBOUND_SOURCE_KEYS } from '@/modules/wms/crm/inbound';
import { listRoutes, rotaMembers } from '@/modules/wms/crm/routing';
import { getSetting } from '@/modules/platform/settings/service';
import { parseOrigins } from '@/modules/platform/http/origins';
import { recentOffers, sitePanel } from '@/modules/wms/crm/site-assign';
import { gateCounters } from '@/modules/wms/crm/site-assign-gate';
import { LEAD_TEAMS } from '@/modules/wms/crm/site-assign-rules';
import { FieldMapPanel } from './field-map-panel';
import { RotaForm } from './rota-form';
import { RouteList } from './route-list';
import { SitePanel, type SitePersonView, type SiteStatus } from './site-panel';

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
  const mappings = await listFieldMap();
  const seen = await seenKeys();
  const leadFields = (await listFields('lead')).filter((f) =>
    MAPPABLE_FIELD_TYPES.has(f.type),
  );

  // Names for rule members come from their own query, NOT the participant
  // list: a rule may point at somebody who was later deactivated, and «?» in
  // place of their name would hide exactly the row that needs fixing.
  const memberIds = [...new Set(routes.flatMap((route) => route.userIds))];
  const named = memberIds.length
    ? await db
        .select({ id: users.id, fullName: users.fullName, live: canLogInSql() })
        .from(users)
        .where(inArray(users.id, memberIds))
    : [];
  // ⚠ = not a colleague now (`canLogIn`): a leaver, or a person who never
  // signs in — neither takes a lead, and both rows need fixing.
  const names = new Map(named.map((row) => [row.id, row.live ? row.fullName : `${row.fullName} ⚠`]));

  // The website panel (round 113) — the SAME roster and pick the route runs,
  // so «keyingi» here is the answer the next visitor gets.
  const [site, offers, originsRaw] = await Promise.all([
    sitePanel(),
    recentOffers(20),
    getSetting('lead_assign_origins'),
  ]);
  const people: SitePersonView[] = site.people.map((person) => {
    const reach = person.reach;
    const status: SiteStatus = reach.ok
      ? reach.source === 'typed'
        ? 'typed'
        : reach.capturable
          ? 'verified'
          : 'blind'
      : reach.reason === 'username_stale'
        ? 'stale'
        : 'none';
    return {
      id: person.userId,
      name: person.name,
      teams: person.teams,
      typedUsername: person.typedUsername ?? '',
      units: person.units,
      status,
      handle: reach.ok ? reach.username : null,
      outdated: person.listenerOutdated,
      featured: person.teams.length > 0 || person.bridge !== null,
    };
  });
  // The website's own list is its degraded path: it should hold the same
  // reachable people, or a slow minute sends visitors where nothing listens.
  const fallback = [
    ...new Set(LEAD_TEAMS.flatMap((team) => site.next[team].ranked.map((c) => c.username))),
  ];
  const gate = gateCounters();
  const refused =
    gate.counts.origin + gate.counts.rate + gate.counts.busy + gate.counts.invalid +
    gate.counts.deadline + gate.counts.error;
  const clock = new Intl.DateTimeFormat('ru-RU', {
    timeZone: 'Asia/Tashkent',
    day: '2-digit',
    month: '2-digit',
    hour: '2-digit',
    minute: '2-digit',
  });

  return (
    <div className="mx-auto max-w-lg space-y-4">
      <h1 className="text-xl font-bold">📣 {t('title')}</h1>
      <p className="text-sm text-ink-500">{t('intro')}</p>
      <SitePanel
        people={people}
        next={LEAD_TEAMS.map((team) => {
          const pick = site.next[team];
          return {
            team,
            username: pick.chosen?.username ?? null,
            name: pick.chosen?.name ?? null,
            units: pick.chosen?.units ?? null,
            widened: pick.widened,
          };
        })}
        offers={offers.map((offer) => ({
          id: offer.id,
          at: clock.format(offer.createdAt),
          team: offer.team,
          topic: offer.topic,
          username: offer.username,
          offeredName: offer.offeredName,
          tookName: offer.tookName,
          state: offer.leadId
            ? 'lead'
            : offer.clientId
              ? 'client'
              : offer.capturable
                ? 'waiting'
                : 'blind',
          leadId: offer.leadId,
          leadName: offer.leadName,
          clientId: offer.clientId,
          clientCode: offer.clientCode,
        }))}
        contract={{
          url: `${(process.env.APP_URL ?? '').replace(/\/$/, '')}/api/lead/assign`,
          origins: parseOrigins(originsRaw),
          fallback,
        }}
        counters={{ answered: gate.counts.answered, nobody: gate.counts.nobody, refused }}
      />
      <RotaForm members={members.map((m) => ({ id: m.id, name: m.fullName, inRota: m.inRota }))} />
      <RouteList
        routes={routes.map((route) => ({
          id: route.id,
          sourceKey: route.sourceKey,
          keyword: route.keyword,
          minM3: route.minM3,
          maxM3: route.maxM3,
          active: route.active,
          memberNames: route.userIds.map((id) => names.get(id) ?? '—'),
        }))}
        people={members.map((m) => ({ id: m.id, name: m.fullName }))}
        sources={[...INBOUND_SOURCE_KEYS]}
      />
      <FieldMapPanel
        mappings={mappings.map((row) => {
          const field = leadFields.find((f) => f.id === row.fieldId);
          const recent = seen.find((s) => s.key === row.key);
          return {
            key: row.key,
            target: row.target,
            fieldLabel: field?.label ?? null,
            // A mapped key nothing has sent lately is the decay hint: an
            // agency's form edit quietly retires keys, and nothing else says so.
            recentCount: recent?.n ?? 0,
          };
        })}
        unmapped={seen
          .filter((s) => !mappings.some((row) => row.key === s.key))
          .map((s) => ({ key: s.key, n: s.n, sample: s.sample.slice(0, 60) }))}
        fields={leadFields.map((f) => ({ id: f.id, label: f.label }))}
      />
    </div>
  );
}
