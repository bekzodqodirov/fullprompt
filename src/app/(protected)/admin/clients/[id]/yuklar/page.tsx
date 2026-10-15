import type { Metadata } from 'next';
import { notFound, redirect } from 'next/navigation';
import { getTranslations } from 'next-intl/server';
import { getActor } from '@/modules/platform/rbac/authorize';
import { mayOpenClientCard } from '@/modules/platform/clients/card-door';
import { tashkentDay } from '@/modules/platform/time/tashkent';
import { clientHeadOnce } from '@/modules/wms/client-card/head';
import { readHistoryDays } from '@/modules/wms/client-card/history-window';
import { loadYuklarView } from '@/modules/wms/client-card/yuklar-view';
import { ClientCard } from '@/components/client-card';
import { ClientCargoNow } from '@/components/client-cargo-now';
import { ClientCargoHistory } from '@/components/client-cargo-history';

export async function generateMetadata({ params }: { params: Promise<{ id: string }> }): Promise<Metadata> {
  const actor = await getActor();
  if (!actor || !mayOpenClientCard(actor)) return {};
  const client = await clientHeadOnce((await params).id);
  if (!client) return {};
  const t = await getTranslations('yuklar');
  return { title: `${client.clientCode} · ${t('tab')}` };
}

/**
 * «Yuklar» — the client card's third tab (docs/CARD-TABS.md): where this
 * client's cargo is RIGHT NOW, in the customer's own four steps, and what
 * they have already collected.
 *
 * The door is the card's own, `mayOpenClientCard` — asked BEFORE the lookup,
 * so the URL cannot answer «does this client exist» to somebody refused
 * (CARD-TABS (R)); after it, «not found» is the only other word. No money on
 * this tab and no money read behind it: the shell's «Pul» badge is the
 * shell's, drawn for the ledger's audience alone.
 *
 * Everything drawn — and every door each link was asked — comes from
 * `loadYuklarView`, a module and not this page, so it is proven by calling
 * it as the people who read it (#531).
 */
export default async function ClientCargoTabPage({
  params,
  searchParams,
}: {
  params: Promise<{ id: string }>;
  /** `tarix` = the history window (90 | 365), `toliq=1` = draw every row. */
  searchParams: Promise<{ tarix?: string; toliq?: string }>;
}) {
  const { id } = await params;
  const sp = await searchParams;
  const actor = await getActor();
  if (!actor) redirect('/login');
  if (!mayOpenClientCard(actor)) redirect('/');
  const client = await clientHeadOnce(id);
  if (!client) notFound();

  const days = readHistoryDays(sp.tarix);
  const full = sp.toliq === '1';
  const view = await loadYuklarView(actor, client.id, { days, today: tashkentDay() });

  // A link that changes one parameter carries the other (#514).
  const base = `/admin/clients/${client.id}/yuklar`;
  const href = (patch: { tarix?: number; toliq?: boolean }) => {
    const q = new URLSearchParams();
    const tarix = patch.tarix ?? days;
    const toliq = patch.toliq ?? full;
    if (tarix !== 90) q.set('tarix', String(tarix));
    if (toliq) q.set('toliq', '1');
    const qs = q.toString();
    return `${base}${qs ? `?${qs}` : ''}`;
  };

  return (
    <ClientCard client={client} active="yuklar">
      <div className="space-y-4">
        <ClientCargoNow
          now={view.now}
          trucks={view.trucks}
          road={view.road}
          photos={view.photos}
          photoRows={view.photoRows}
          receiptsOpen={view.receiptsOpen}
          siblings={view.siblings}
          full={full}
          fullHref={href({ toliq: true })}
          checks={view.checks}
          askableWarehouses={view.askableWarehouses}
        />
        <ClientCargoHistory
          rows={view.history.rows}
          capped={view.history.capped}
          cap={view.history.cap}
          days={days}
          hrefs={{ short: `${href({ tarix: 90 })}#topshirilgan`, year: `${href({ tarix: 365 })}#topshirilgan` }}
          actOpen={view.actOpen}
          legTruck={view.legTruck}
        />
      </div>
    </ClientCard>
  );
}
