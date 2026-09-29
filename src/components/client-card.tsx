import { cache } from 'react';
import Link from 'next/link';
import { redirect } from 'next/navigation';
import { getTranslations } from 'next-intl/server';
import { getActor } from '@/modules/platform/rbac/authorize';
import { clientBookBack } from '@/modules/platform/clients/card-door';
import { clientBalanceUsd } from '@/modules/wms/finance/service';
import { clientTabHref, clientTabsFor, type ClientTab } from '@/modules/wms/client-card/tabs';
import { clientCargoNowOnce } from '@/modules/wms/inventory/client-cargo-now';
import { foldCargoNow } from '@/modules/wms/inventory/client-cargo-fold';
import { tashkentDay } from '@/modules/platform/time/tashkent';
import { BackLink } from './back-link';
import { CopyChip } from './copy-chip';

/**
 * The client's balance, once per request (POSITIVE = the client owes).
 *
 * The ledger page reads it for its balance line and this header reads it for
 * the «Pul» badge; `cache()` makes that one query. Keyed by the id alone — a
 * primitive — because React compares an object argument by identity, and a
 * fresh `{ id }` would miss every time.
 */
export const clientBalanceOnce = cache((clientId: string) => clientBalanceUsd(clientId));

export type { ClientTab };

/** Tailwind compiles only classes it can SEE — a column count built at runtime is none. */
const STRIP_COLS: Record<number, string> = { 2: 'grid-cols-2', 3: 'grid-cols-3' };

/**
 * The «Yuklar» badge — the tab's own Σ (#513), soft: `cache()` memoises a
 * failure, and one bad read must not take the card's every tab down with it
 * (docs/CARD-TABS.md). Nothing is drawn rather than a wrong number.
 */
async function cargoBadge(clientId: string): Promise<number> {
  try {
    const data = await clientCargoNowOnce(clientId);
    return foldCargoNow(data.rows, data.trucks, null, tashkentDay()).total.boxes;
  } catch (err) {
    console.error('[client-card] cargo badge', err);
    return 0;
  }
}

/**
 * One client, two views (the owner's 4a: «Mijozning hisob varag'i mijoz
 * kartasiga «Pul» bo'limi bo'lib kirsinmi? Kim pulni ko'radi, degan ruxsatlar
 * o'zgarmaydi»): the card at `/admin/clients/<id>` is «Umumiy», the ledger at
 * `/finance/<id>` is «Pul». Neither URL moved (Telegram and fifteen money
 * screens link them), so this is a header BOTH pages render around their own
 * body, not a layout — a layout would also have to guess the lit tab.
 *
 * It draws the way back, the page's one h1 (m0/m8/m9zd read it strictly), the
 * copy chip, and the strip. The third tab, «Yuklar» (`/admin/clients/<id>/
 * yuklar`), is where the cargo is now; it asks the card's own door. The strip
 * appears only when this person may open two tabs or more, each asked of the
 * door its page asks: the accountant and the VED open the ledger but never
 * the card, and a seller opens any card they work (and its cargo) but only
 * their own clients' ledgers — one tab is not a choice.
 *
 * Nothing here is sticky or a CardCols — the card's body keeps its own rail —
 * and nothing links to a truck: the ledger's first `/batches/` link is its
 * cargo block's, which m9-client-money reads.
 */
export async function ClientCard({
  client,
  active,
  children,
}: {
  client: { id: string; clientCode: string; name: string; salesManagerId: string | null };
  active: ClientTab;
  children: React.ReactNode;
}) {
  const actor = await getActor();
  if (!actor) redirect('/login');

  const t = await getTranslations('clientCard');
  const tf = await getTranslations('finance');
  const tq = await getTranslations('quick');
  const tclients = await getTranslations('clients');
  const tcargo = await getTranslations('cargo');
  const ty = await getTranslations('yuklar');

  // Each tab asks the door its own page asks (`clientTabsFor`); the strip is
  // drawn when there is a choice to make — two tabs or more. A seller on a
  // colleague's client has «Umumiy · Yuklar» and no «Pul»; the accountant
  // and the VED have «Pul» alone and no strip.
  const tabs = clientTabsFor(actor, client);
  const strip = tabs.length >= 2;
  const pul = tabs.includes('pul');

  // The way back is drawn on EVERY tab, so switching tabs never moves the
  // strip: the ledger goes back to the ledgers, the card and its cargo to the
  // book this person keeps — the VED's phone has no other way out of a ledger
  // he opened from the pricing page. Each target is a page whose own door is
  // the function that chose it (`/finance` asks `mayReadLedgers`, which every
  // ledger reader passed to be here).
  const book = active !== 'pul' ? clientBookBack(actor) : null;
  const back =
    active === 'pul'
      ? { href: '/finance', label: tf('title') }
      : book === '/admin/clients'
        ? { href: book, label: tclients('title') }
        : book === '/my-clients'
          ? { href: book, label: tcargo('myClients') }
          : null;

  // The badge says what the ledger says, in its words and colours — never a
  // bare signed number, which reads the same for a debt and an advance. Read
  // only when «Pul» is drawn in a strip: a loader never READS what its viewer
  // cannot see (docs/CARD-TABS.md rule 3) — a seller on a colleague's client
  // gets a strip now, «Umumiy · Yuklar», and must not cost a ledger read.
  const balance = strip && pul ? await clientBalanceOnce(client.id) : 0;
  const boxesNow = strip && tabs.includes('yuklar') ? await cargoBadge(client.id) : 0;
  const badge =
    balance > 0.009
      ? { text: `${tf('debtor')} $${balance.toFixed(2)}`, tone: 'text-bad' }
      : balance < -0.009
        ? { text: tf('advanceNow', { amount: (-balance).toFixed(2) }), tone: 'text-good' }
        : null;

  // `flex-wrap`: on a phone each tab is a third of 360 px (~109 px), and
  // «Деньги должник $12 345.67» is wider than that — unwrapped it would run
  // past the screen's edge and mobile Chrome would zoom the whole page out
  // (#400). The badge takes a second line instead.
  const tab = (key: ClientTab, href: string, label: string, extra?: React.ReactNode) => {
    const lit = key === active;
    return (
      <Link
        key={key}
        href={href}
        data-testid={`client-tab-${key}`}
        aria-current={lit ? 'page' : undefined}
        className={`flex min-h-11 min-w-0 flex-wrap items-center justify-center gap-x-2 rounded-lg px-2 py-1 text-center text-sm font-semibold sm:px-3 ${
          lit ? 'bg-surface-raised text-ink-900 shadow-card' : 'text-ink-700 hover:bg-surface-raised/60'
        }`}
      >
        {label}
        {extra}
      </Link>
    );
  };

  return (
    <div className="space-y-3">
      {back && <BackLink href={back.href} label={back.label} />}
      {/* flex-wrap + min-w-0: a long client name and the copy chip must
          coexist on a 360 px screen instead of squeezing each other. */}
      <div className="flex flex-wrap items-center gap-2">
        <h1 className="min-w-0 text-xl font-bold [overflow-wrap:anywhere]">
          <span className="font-mono text-brand-700">{client.clientCode}</span> — {client.name}
        </h1>
        {/* The code goes onto cartons and into Telegram all day — one tap
            beats selecting a mono span by thumb (round 107, item 1). */}
        <CopyChip value={client.clientCode} label={tq('copy')} copiedLabel={tq('copied')} />
      </div>
      {strip && (
        <nav
          aria-label={t('tabs')}
          data-testid="client-tabs"
          className={`grid ${STRIP_COLS[tabs.length] ?? 'grid-cols-3'} gap-1 rounded-xl bg-surface-sunken p-1 md:inline-grid`}
        >
          {tabs.map((key) =>
            key === 'umumiy'
              ? tab(key, clientTabHref(key, client.id), t('overview'))
              : key === 'yuklar'
                ? tab(
                    key,
                    clientTabHref(key, client.id),
                    ty('tab'),
                    boxesNow > 0 && (
                      <span data-testid="client-yuklar-badge" className="text-xs font-semibold tabular-nums text-ink-500">
                        {boxesNow} 📦
                      </span>
                    ),
                  )
                : tab(
                    key,
                    clientTabHref(key, client.id),
                    t('money'),
                    badge && (
                      <span data-testid="client-pul-badge" className={`text-xs font-semibold tabular-nums ${badge.tone}`}>
                        {badge.text}
                      </span>
                    ),
                  ),
          )}
        </nav>
      )}
      {children}
    </div>
  );
}
