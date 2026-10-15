import Link from 'next/link';
import { eq } from 'drizzle-orm';
import { notFound, redirect } from 'next/navigation';
import { getTranslations } from 'next-intl/server';
import { db } from '@/modules/platform/db/client';
import { clients, deals, leadSources, leadStages, leads, users } from '@/modules/platform/db/schema';
import { getActor } from '@/modules/platform/rbac/authorize';
import { kartaCardFor, leadEverPriced, mayOpenCalcCard } from '@/modules/wms/calc/card-door';
import { mayOpenLead } from '@/modules/wms/crm/lead-door';
import { canWriteDeal } from '@/modules/wms/deals/service';
import { mayOpenClientLedger } from '@/modules/wms/finance/scope';
import { canReadTg, leadOwnChatRows, tgViewerFor } from '@/modules/wms/crm/conversations';
import { leadThreadSource } from '@/modules/wms/crm/conversation-row';
import { PageHeader } from '@/components/ui/page';
import { CardCols } from '@/components/card-cols';
import { CardFacts } from '@/components/card-fact';
import { CalcPanel } from '@/components/calc-panel';
import { ClientFeed } from '@/components/client-feed';
import { TelegramThread } from '@/components/telegram-thread';
import { CallsPanel } from '@/components/calls-panel';
import { ThreadSeen } from '@/components/thread-seen';
import { threadReadMarks } from '@/modules/wms/crm/thread';

/**
 * The VED on the seller's LEAD (the owner's 14a 15a 16a, docs/VED-TARIX.md
 * §10): «noaniqliklar bolganda ved hodimi hsoblashdan kartaga otib
 * aniqlashtirib oladi», and «may NOT edit (stage, phone, price)».
 *
 * Its own route and not a relaxed CRM layout: that layout's gate protects
 * every /crm page, and a calculator is not given the funnel. Keyed by the
 * REQUEST (what every calc surface holds); `?lid=` reaches a lead whose
 * request moved to a deal when it was won (`kartaCardFor`).
 *
 * Everything here READS — the lead's facts, the 🧮 panel (with the seller's
 * offer prices, 16a), the lenta, the Telegram thread, the calls — except one
 * thing: a TEXT note on the lenta, posted on the lead itself, which is how
 * the VED asks and the seller answers. No ✏️ form, no stage mover, no win
 * dialog, no tasks form, no reply box, no 📎.
 */
export default async function CalcKartaPage({
  params,
  searchParams,
}: {
  params: Promise<{ id: string }>;
  searchParams: Promise<{ lid?: string }>;
}) {
  const { id } = await params;
  const { lid } = await searchParams;
  const actor = await getActor();
  if (!actor) redirect('/login');
  const card = await kartaCardFor(id, lid);
  if (!card) notFound();
  if (card.kind === 'deal') {
    // A deal's card is the deal card — the VED holds `canWriteDeal` on
    // purpose, and the deal card draws the lenta for him (§10 «Deal»).
    if (canWriteDeal(actor.permissions)) redirect(`/bitimlar/${card.dealId}`);
    redirect('/');
  }

  const lead = await db.query.leads.findFirst({ where: eq(leads.id, card.leadId) });
  if (!lead) notFound();
  // Whoever the CRM card admits reads the real card (`mayOpenLead`, never
  // `crm.leads` alone — a both-hats person who does not own the lead would
  // be bounced there, review access-money-15).
  if (mayOpenLead(actor, lead)) redirect(`/crm/leads/${lead.id}`);
  if (!(await mayOpenCalcCard(actor, { entityType: 'lead', entityId: lead.id }))) redirect('/');

  const t = await getTranslations('calc');
  const tcrm = await getTranslations('crm');
  const tc = await getTranslations('common');

  const [stage, source, owner, wonDeal, client, everPriced] = await Promise.all([
    db.query.leadStages.findFirst({ where: eq(leadStages.id, lead.stageId), columns: { name: true } }),
    lead.sourceId
      ? db.query.leadSources.findFirst({ where: eq(leadSources.id, lead.sourceId), columns: { name: true } })
      : Promise.resolve(undefined),
    lead.ownerId
      ? db.query.users.findFirst({ where: eq(users.id, lead.ownerId), columns: { fullName: true } })
      : Promise.resolve(undefined),
    card.wonDealId
      ? db.query.deals.findFirst({ where: eq(deals.id, card.wonDealId), columns: { id: true, code: true } })
      : Promise.resolve(undefined),
    // The lead's STORED client — never the phone match: the lenta's client
    // notes and the file branch that opens their photos must answer the same
    // question, and the phone match has no SQL twin (`isCalcCardClient`).
    lead.clientId
      ? db.query.clients.findFirst({ where: eq(clients.id, lead.clientId) })
      : Promise.resolve(undefined),
    leadEverPriced(lead.id),
  ]);
  const clientId = client?.id ?? null;
  const feedMoney = client ? mayOpenClientLedger(actor, client) : false;
  const threadSource = leadThreadSource({
    ownLeadRows: canReadTg(actor) ? await leadOwnChatRows(lead.id, tgViewerFor(actor)) : 0,
    resolvedClientId: clientId,
  });

  // «Sotuvchi narxi» is the OFFERS list on the 🧮 panel (16a, review
  // access-money-9). The lead's own quote column is printed only while no
  // calculation has ever priced this card — after a seal it holds the VED's
  // floor — and under a label that says what it is.
  const guess =
    !everPriced && lead.quotedAmount
      ? [
          `${Number(lead.quotedAmount).toLocaleString('ru-RU')} ${lead.quotedCurrency ?? 'USD'}`,
          lead.quotedVolumeM3 ? `${Number(lead.quotedVolumeM3)} m³` : '',
          lead.quotedWeightKg ? `${Number(lead.quotedWeightKg)} kg` : '',
        ]
          .filter(Boolean)
          .join(' · ')
      : '';
  // The karta is where a calculator READS the lead's thread — and the only
  // place he can — so it marks it read as the CRM card does (the dock's row
  // otherwise stays ● until the window drops it). The LEAD only: the client
  // thread's door (`crm.leads || clients.manage`) does not admit this reader.
  const readMarks = await threadReadMarks([{ kind: 'lead' as const, id: lead.id }]);

  return (
    <div className="mx-auto max-w-lg space-y-3 md:max-w-none" data-testid="calc-karta">
      <PageHeader
        title={<span className="[overflow-wrap:anywhere]">{lead.name}</span>}
        subtitle={t('kartaHint')}
        back={{ href: `/hisoblash/${card.requestId}`, label: t('kartaBack') }}
      />
      {wonDeal && (
        <p className="card !py-2 text-sm" data-testid="karta-won-deal">
          {t('kartaWonDeal')}{' '}
          {canWriteDeal(actor.permissions) ? (
            <Link href={`/bitimlar/${wonDeal.id}`} className="font-mono font-semibold text-brand-700 underline">
              {wonDeal.code}
            </Link>
          ) : (
            <span className="font-mono font-semibold">{wonDeal.code}</span>
          )}
        </p>
      )}
      <CardCols
        main={
          <>
            {/* A note written here is about THIS card, for every reader
                (review access-4) — never the client's thread. */}
            <ClientFeed
              clientId={clientId}
              money={feedMoney}
              leadId={lead.id}
              noteOn={{ entityType: 'lead', entityId: lead.id }}
              limit={60}
              tall
            />
            <ThreadSeen refs={readMarks} />
            <TelegramThread
              clientId={threadSource.kind === 'client' ? threadSource.clientId : null}
              leadId={lead.id}
              readOnly
            />
            <CallsPanel clientId={clientId} lead={{ id: lead.id, phone: lead.phone }} />
          </>
        }
        rail={
          <>
            <div className="card" data-testid="karta-facts">
              <CardFacts
                missingLabel={tc('notFilled')}
                facts={[
                  { label: tcrm('phone'), value: lead.phone ?? '', testId: 'fact-phone', always: true, tel: true },
                  { label: tcrm('company'), value: lead.company ?? '', testId: 'fact-company' },
                  { label: tcrm('note'), value: lead.note ?? '', testId: 'fact-note' },
                  { label: tcrm('stage'), value: stage?.name ?? '', testId: 'fact-stage' },
                  { label: tcrm('source'), value: source?.name ?? '', testId: 'fact-source' },
                  { label: tcrm('owner'), value: owner?.fullName ?? '', testId: 'fact-owner' },
                  {
                    label: tcrm('nextAction'),
                    value: [lead.nextActionAt, lead.nextActionNote].filter(Boolean).join(' · '),
                    testId: 'fact-next',
                  },
                  ...(guess ? [{ label: t('sellerGuess'), value: guess, testId: 'fact-seller-guess' }] : []),
                ]}
              />
            </div>
            {/* The price lives where the request lives: on the deal once the
                lead was won. Read-only either way — no send form, no offer
                form, no PDF (14a, 16a). */}
            <CalcPanel
              entityType={wonDeal ? 'deal' : 'lead'}
              entityId={wonDeal ? wonDeal.id : lead.id}
              revalidate={`/hisoblash/${card.requestId}/karta`}
              clientName={lead.company || lead.name}
              readOnly
            />
          </>
        }
      />
    </div>
  );
}
