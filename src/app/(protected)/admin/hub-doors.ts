import type { IconName } from '@/components/ui/icon';

/**
 * The administration hub's doors, in one list.
 *
 * They were a literal array inside the hub page while the LAYOUT decided
 * separately, from its own six booleans, whether to draw a way back to that
 * hub — two answers to one question. Round 75 made the disagreement visible:
 * taking the client book off the hub left the logist with a single door, so
 * `/admin` walks him straight through it (`tiles.length === 1`) while the
 * page he lands on still offered «← Boshqaruv», a link back to itself.
 *
 * One list, asked twice. `label` is a FULL translation key, so the page
 * resolves every door with a single namespace-less `getTranslations()` — the
 * same idiom a `ColumnDef` uses.
 */
export interface HubDoor {
  href: string;
  label: string;
  icon: IconName;
  /** Any one of these is enough. */
  allow: string[];
  /**
   * AND a ROLE, when a permission cannot say it (B9's error list is the super
   * admin's, `mayAnnul`'s shape — admin and super admin hold the same codes).
   * ANDed with `allow`, never instead of it: an ORed role would draw a door
   * for somebody the page bounces (#792), and the /admin menu entry is pinned
   * to the union of `allow` alone (workspaces.test).
   */
  roles?: string[];
}

export const HUB_DOORS: HubDoor[] = [
  { href: '/admin/warehouses', label: 'nav.warehouses', icon: 'crate', allow: ['admin.warehouses.manage'] },
  { href: '/admin/users', label: 'nav.users', icon: 'user', allow: ['admin.warehouses.manage'] },
  // The client book is deliberately NOT a door here (round 75, owner:
  // "adminstrativnoedagi klientini glavniga chiqaz"). It is offered in Sotuv,
  // on the home screen and in both menus; a second door from the
  // administration hub was the app calling the company's client list a
  // settings screen. The route and its gate are untouched.
  {
    href: '/admin/settings',
    label: 'settings.title',
    icon: 'settings',
    allow: ['admin.settings.manage', 'admin.warehouses.manage'],
  },
  { href: '/admin/roles', label: 'roles.title', icon: 'shield', allow: ['platform.roles.manage'] },
  { href: '/admin/fields', label: 'fields.title', icon: 'clipboard', allow: ['admin.dictionaries.manage'] },
  // Phase 8's «Свои списки» editor is off the hub — the owner looked at the
  // feature and said «kerak emas, olib tashla». /admin/entities and /o still
  // answer, and `custom_entities` / `custom_records` are untouched, so
  // whatever anyone put in there is still there if he changes his mind.
  // The cost types, the partner types, the FX rates, the freight tariff, the
  // customs base and the truck presets LEFT the hub in the workspaces round
  // (owner, 2026-09-26, answer 8b: «sozlamalar o'z bo'limida»). Each is now
  // the ⚙ of the job that uses it — Pul, Hisoblash, Yo'l — and a second door
  // here would be the app calling a job's own settings administration again
  // (round 75's complaint about the client book, in five more costumes). The
  // routes, their gates and their /admin URLs are untouched.
  { href: '/admin/driver-app', label: 'settings.driverApp', icon: 'truck', allow: ['admin.settings.manage'] },
  { href: '/admin/calls-app', label: 'settings.callsApp', icon: 'phone', allow: ['admin.settings.manage'] },
  { href: '/admin/rules', label: 'automation.title', icon: 'target', allow: ['admin.settings.manage'] },
  // The price channel (his F, 2026-10-07): which Telegram channel the bot posts
  // every given price into, who it let in, and what it did and did not post.
  { href: '/admin/narx-kanali', label: 'priceChannel.title', icon: 'chat', allow: ['admin.settings.manage'] },
  { href: '/admin/audit', label: 'nav.audit', icon: 'clipboard', allow: ['admin.audit.browse'] },
  // The voided-cargo registry + the owner's cleanup tool. An audit surface,
  // so the audit door: only admin/super_admin hold it, and the tile never
  // teases a role the page bounces (#792's cousin).
  { href: '/admin/anulirovka', label: 'annul.registryTitle', icon: 'alert', allow: ['admin.audit.browse'] },
  { href: '/admin/notifications', label: 'nav.notifications', icon: 'alert', allow: ['admin.audit.browse'] },
  // The server's own errors, found by the digest in a staff screenshot (B9).
  // Messages can carry a client's phone, so it is the super admin's alone —
  // the page asks `mayReadSystemErrors`, the same role this door names.
  {
    href: '/admin/xatolar',
    label: 'kuzatuv.hubLabel',
    icon: 'alert',
    allow: ['admin.audit.browse'],
    roles: ['super_admin'],
  },
  // Lead routing (Savdo's ⚙) and the broadcast to clients (a Savdo tab) moved
  // with the rest — `workspaces.ts` is where they are offered now.
];

/**
 * The doors this person may actually open. `roles` is the person's roles; a
 * caller that passes none is shown no role-gated door — fail closed.
 */
export function openDoors(has: (code: string) => boolean, roles: readonly string[] = []): HubDoor[] {
  return HUB_DOORS.filter(
    (door) => door.allow.some(has) && (!door.roles || door.roles.some((role) => roles.includes(role))),
  );
}
