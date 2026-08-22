import Link from 'next/link';
import { redirect } from 'next/navigation';
import { getTranslations } from 'next-intl/server';
import { getActor } from '@/modules/platform/rbac/authorize';
import { Icon } from '@/components/ui/icon';
import { PageHeader } from '@/components/ui/page';
import { openDoors } from './hub-doors';
import { BackupPanel } from './backup-panel';

/**
 * The administration HUB (owner, 2026-07-28): "administrativniyga kirsa
 * to'g'ridan-to'g'ri warehouselarga o'tib ketyapti … undan ko'ra kirganda u
 * yerdan qilish mumkin bo'lgan joylarni buttonlari tursa yaxshi bo'lar edi."
 *
 * Before this, «Boshqaruv» landed on the warehouse list and the other nine
 * sections lived in a strip that scrolls off a phone screen — a person who
 * did not already know they were there never learnt it. One page of big
 * buttons, each shown only to somebody allowed through its door.
 *
 * The doors themselves live in `hub-doors.ts`, because the section layout
 * has to ask the same question to decide whether a way back here is a real
 * link or a link to the page you are already on.
 */
export default async function AdminHubPage() {
  const actor = await getActor();
  if (!actor) redirect('/login');
  const tHome = await getTranslations('home');

  // One namespace-less translator: a door carries its FULL key.
  const t = await getTranslations();
  const tiles = openDoors((code) => actor.permissions.has(code));

  // Somebody with exactly one door gets walked through it instead of being
  // shown a hub of one button.
  if (tiles.length === 0) redirect('/');
  if (tiles.length === 1) redirect(tiles[0]!.href);

  return (
    <div className="mx-auto max-w-lg space-y-4 md:max-w-3xl">
      <PageHeader icon="settings" title={tHome('adminPanel')} />
      <div className="grid grid-cols-2 gap-2.5 md:grid-cols-3">
        {tiles.map((tile) => (
          <Link
            key={tile.href}
            href={tile.href}
            data-testid="admin-tile"
            className="card-tap flex min-h-20 items-center gap-3 !p-4"
          >
            <span className="grid h-10 w-10 shrink-0 place-items-center rounded-xl bg-brand-50 text-brand-700">
              <Icon name={tile.icon} className="h-5 w-5" />
            </span>
            <span className="text-sm font-bold leading-tight [overflow-wrap:anywhere]">
              {t(tile.label as 'nav.audit')}
            </span>
          </Link>
        ))}
      </div>
      {/* Only for whoever can act on it: a red line about backups on the
          screen of somebody with no way to fix it is noise, not information. */}
      {actor.permissions.has('admin.settings.manage') && <BackupPanel />}
    </div>
  );
}
