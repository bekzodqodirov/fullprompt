import { redirect } from 'next/navigation';
import { getTranslations } from 'next-intl/server';
import { getActor } from '@/modules/platform/rbac/authorize';
import { mayOpenClientCard } from '@/modules/platform/clients/card-door';
import { AdminBack } from './admin-back';
import { openDoors } from './hub-doors';

/**
 * The admin section.
 *
 * Navigation here is the HUB at /admin and a way back to it — the tab strip
 * this layout used to render duplicated the hub's buttons and scrolled off a
 * phone (owner, 2026-07-28: "tepadagi menyu turibdi, u kerak emas").
 *
 * The entry gate accepts any admin-section permission rather than
 * `admin.warehouses.manage` alone: the accountant holds `costs.fx.manage`,
 * the menu offers them the door, and a single-permission gate would bounce
 * them off their own exchange-rate page. Each page still checks its own
 * permission — this is a cosmetic gate (spec 4.2).
 */
export default async function AdminLayout({ children }: { children: React.ReactNode }) {
  const actor = await getActor();
  if (!actor) redirect('/login');
  const tHome = await getTranslations('home');

  const canManage = actor.permissions.has('admin.warehouses.manage');
  const canAudit = actor.permissions.has('admin.audit.browse');
  const canFx = actor.permissions.has('costs.fx.manage');
  const canRoles = actor.permissions.has('platform.roles.manage');
  const canFields = actor.permissions.has('admin.dictionaries.manage');
  // The job settings that kept their /admin URL when they moved into a
  // workspace's ⚙ (2026-09-26): the truck presets are `plans.manage`, lead
  // routing and the hub's system pages are `admin.settings.manage`. A role the
  // owner invents with only one of those is offered the page by its workspace,
  // so this cosmetic gate must not bounce them before the page's own check.
  const canJobSettings =
    actor.permissions.has('plans.manage') || actor.permissions.has('admin.settings.manage');
  // A client CARD is not an admin screen — it just happens to live under
  // /admin/clients. Without this a sales manager was bounced home from their
  // own call list, the dormant list and "my clients", every one of which
  // links straight here. The card checks its own permission; this gate is
  // cosmetic (spec 4.2) — and it is the card's own door, the one function
  // the card and its «Umumiy» tab ask, so the two cannot drift apart.
  const canClients = mayOpenClientCard(actor);
  if (!canManage && !canAudit && !canFx && !canClients && !canRoles && !canFields && !canJobSettings) {
    redirect('/');
  }

  // The way back to the hub — only for somebody the hub would actually SHOW.
  // Two conditions, and the second is newer: a salesperson passing through to
  // a client card would be bounced (a door that bounces is worse than no
  // door), and somebody with a single administration door is walked straight
  // through the hub by `/admin` itself, so «← Boshqaruv» would be a link back
  // to the page they are standing on. Round 75 created that second case for
  // the logist by taking the client book off the hub; asking the hub's own
  // list is what stops the two answers drifting again.
  const hasHub = openDoors((code) => actor.permissions.has(code), actor.roles).length > 1;

  return (
    <>
      {hasHub && <AdminBack label={tHome('adminPanel')} />}
      {children}
    </>
  );
}
