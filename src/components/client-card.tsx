import { cache } from 'react';
import Link from 'next/link';
import { redirect } from 'next/navigation';
import { getTranslations } from 'next-intl/server';
import { getActor } from '@/modules/platform/rbac/authorize';
import { clientBookBack, mayOpenClientCard } from '@/modules/platform/clients/card-door';
import { mayOpenClientLedger } from '@/modules/wms/finance/scope';
import { clientBalanceUsd } from '@/modules/wms/finance/service';
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

export type ClientTab = 'umumiy' | 'pul';

/**
 * One client, two views (the owner's 4a: «Mijozning hisob varag'i mijoz
 * kartasiga «Pul» bo'limi bo'lib kirsinmi? Kim pulni ko'radi, degan ruxsatlar
 * o'zgarmaydi»): the card at `/admin/clients/<id>` is «Umumiy», the ledger at
 * `/finance/<id>` is «Pul». Neither URL moved (Telegram and fifteen money
 * screens link them), so this is a header BOTH pages render around their own
 * body, not a layout — a layout would also have to guess the lit tab.
 *
 * It draws the way back, the page's one h1 (m0/m8/m9zd read it strictly), the
 * copy chip, and the strip. The strip appears only when this person may open
 * BOTH tabs, each asked of the door its page asks: the accountant and the VED
 * open the ledger but never the card, and a seller opens any card they work
 * but only their own clients' ledgers — one tab is not a choice.
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

  const umumiy = mayOpenClientCard(actor);
  const pul = mayOpenClientLedger(actor, client);
  const strip = umumiy && pul;

  // The way back is drawn on BOTH tabs, so switching tabs never moves the
  // strip: the ledger goes back to the ledgers, the card to the book this
  // person keeps — the VED's phone has no other way out of a ledger he
  // opened from the pricing page. Each target is a page whose own door is
  // the function that chose it (`/finance` asks `mayReadLedgers`, which every
  // ledger reader passed to be here).
  const book = active === 'umumiy' ? clientBookBack(actor) : null;
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
  // only when the strip is drawn: nobody else is shown it.
  const balance = strip ? await clientBalanceOnce(client.id) : 0;
  const badge =
    balance > 0.009
      ? { text: `${tf('debtor')} $${balance.toFixed(2)}`, tone: 'text-bad' }
      : balance < -0.009
        ? { text: tf('advanceNow', { amount: (-balance).toFixed(2) }), tone: 'text-good' }
        : null;

  // `flex-wrap`: on a phone each tab is half of 360 px, and «Деньги должник
  // $12 345.67» is wider than that — unwrapped it would run past the screen's
  // edge and mobile Chrome would zoom the whole page out (#400). The badge
  // takes a second line instead.
  const tab = (key: ClientTab, href: string, label: string, extra?: React.ReactNode) => {
    const lit = key === active;
    return (
      <Link
        href={href}
        data-testid={`client-tab-${key}`}
        aria-current={lit ? 'page' : undefined}
        className={`flex min-h-11 min-w-0 flex-wrap items-center justify-center gap-x-2 rounded-lg px-3 py-1 text-center text-sm font-semibold ${
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
          className="grid grid-cols-2 gap-1 rounded-xl bg-surface-sunken p-1 md:inline-grid"
        >
          {tab('umumiy', `/admin/clients/${client.id}`, t('overview'))}
          {tab(
            'pul',
            `/finance/${client.id}`,
            t('money'),
            badge && (
              <span data-testid="client-pul-badge" className={`text-xs font-semibold tabular-nums ${badge.tone}`}>
                {badge.text}
              </span>
            ),
          )}
        </nav>
      )}
      {children}
    </div>
  );
}
