import Link from 'next/link';
import { eq } from 'drizzle-orm';
import { notFound, redirect } from 'next/navigation';
import { getTranslations } from 'next-intl/server';
import { db } from '@/modules/platform/db/client';
import { leads } from '@/modules/platform/db/schema';
import { getActor } from '@/modules/platform/rbac/authorize';
import { salesManagerOptions } from '@/modules/platform/rbac/queries';
import { getSetting } from '@/modules/platform/settings/service';
import { Panel } from '@/components/panel';
import { activeLostReasonLabels, listSources, listStages } from '@/modules/wms/crm/service';
import { formStages } from '@/modules/wms/crm/stage-law';
import { customFieldsData } from '@/modules/platform/fields/view';
import { convertLeadAction, updateLeadAction } from '../../actions';
import { CustomFieldInputs } from '@/components/custom-fields';
import { LeadForm } from '../lead-form';
import { LeadFacts } from './facts';
import { ConvertForm } from './convert-form';
import { StageMover } from './stage-mover';
import { TasksPanel } from '@/components/tasks-panel';
import { HistoryTab } from '@/components/history-tab';
import { ClientFeed } from '@/components/client-feed';
import { TelegramThread } from '@/components/telegram-thread';
import { TelegramLookback } from '@/components/telegram-lookback';
import { CallsPanel } from '@/components/calls-panel';
import { CardCols } from '@/components/card-cols';
import { conversationClientForLead } from '@/modules/wms/crm/conversations';

/** One lead: where it stands, what was said, and the button that ends it. */
export default async function LeadPage({
  params,
  searchParams,
}: {
  params: Promise<{ id: string }>;
  /** `hodim` = whose Telegram conversation to read in the panel (2026-08-07). */
  searchParams: Promise<{ hodim?: string; chodim?: string }>;
}) {
  const { id } = await params;
  const { hodim, chodim } = await searchParams;
  const actor = await getActor();
  if (!actor) redirect('/login');
  if (!actor.permissions.has('crm.leads')) redirect('/');
  const lead = await db.query.leads.findFirst({ where: eq(leads.id, id) });

  if (!lead) notFound();
  // The thread's filter and the calls' filter live on the same URL; a link
  // that changes one must carry the other (#514 — a literal string drops it).
  const cardHref = (patch: { hodim?: string | null; chodim?: string | null }) => {
    const q = new URLSearchParams();
    const h = 'hodim' in patch ? patch.hodim : hodim;
    const c = 'chodim' in patch ? patch.chodim : chodim;
    if (h) q.set('hodim', h);
    if (c) q.set('chodim', c);
    const qs = q.toString();
    return `/crm/leads/${lead.id}${qs ? `?${qs}` : ''}`;
  };
  // A sales manager works their own leads; seeing someone else's would let
  // two people call the same person about the same cargo.
  if (!actor.permissions.has('crm.leads.view_all') && lead.ownerId !== actor.id) redirect('/crm');

  const t = await getTranslations('crm');
  const tc = await getTranslations('common');
  const [sources, stages, managers, custom, codePrefix, lostReasonList] = await Promise.all([
    listSources(),
    listStages(),
    // The lead's current owner too: the same bare <select> that erased
    // client managers erases lead owners the same way.
    salesManagerOptions(lead.ownerId),
    // The lead card is the one form in the app that carries built-in and
    // custom inputs in the SAME FormData, so it renders the inputs itself
    // rather than the standalone panel.
    customFieldsData('lead', id),
    getSetting('client_code_prefix'),
    activeLostReasonLabels(),
  ]);

  const update = updateLeadAction.bind(null, id);
  const convert = convertLeadAction.bind(null, id);
  // The conversation this lead belongs to, when there is one — shared by the
  // lenta and the dock's card marker.
  const dockClientId = await conversationClientForLead(lead);

  return (
    // Wide like the funnel it came from: the amoCRM card shape (owner,
    // 2026-07-28) is timeline on the left, facts in a rail on the right —
    // a max-w-lg column has no room for either.
    <div className="mx-auto max-w-lg space-y-3 md:max-w-none">
      <Link href="/crm" className="text-sm font-semibold text-brand-700">
        ← {t('funnel')}
      </Link>
      <h1 className="text-xl font-bold [overflow-wrap:anywhere]">{lead.name}</h1>
      {/* The dock opens straight into this lead's conversation, if any. */}
      {dockClientId && <span data-dock-client={dockClientId} hidden />}

      <StageMover
        leadId={id}
        currentId={lead.stageId}
        lostReasons={lostReasonList}
        stages={stages.map((stage) => ({
          id: stage.id,
          name: stage.name,
          kind: stage.kind,
          color: stage.color,
        }))}
      />
      {lead.lostReason && (
        <p className="card !py-2 text-sm text-bad">✖ {lead.lostReason}</p>
      )}

      <CardCols
        main={
          /* A lead who is already a client — converted, or an existing
             customer asking about another job — brings their conversation
             with them. A brand new prospect has none, and the panel simply
             does not render. */
          <>
            <ClientFeed clientId={dockClientId} leadId={lead.id} limit={60} tall />
            {/* The chat stands BESIDE the lenta, never inside it (round 21). */}
            <TelegramThread
              clientId={dockClientId}
              // A lead the chat itself opened (round 82) shows that chat here.
              leadId={lead.id}
              hodim={hodim}
              // `who` and not `id`: this page already has an `id` (the lead's).
              hrefFor={(who) => cardHref({ hodim: who })}
            />
            <CallsPanel
              clientId={dockClientId}
              lead={{ id: lead.id, phone: lead.phone }}
              hodim={chodim}
              hrefFor={(who) => cardHref({ chodim: who })}
            />
          </>
        }
        rail={
          <>
      {/* The «Записать контакт» form used to sit here (owner, 2026-07-28:
          "lentaning pastida emas, yon tarafdagi menyuda tursin"). He took it
          off entirely on 2026-08-08 — «crm kartada shu zapis yozish kerak
          emas, lenta bor» — so a lead is written about in ONE place, the
          lenta below. The «keyingi kontakt» date it also carried is not
          lost: the ✏️ form has always held that pair, and it is what
          /crm/today reads. */}
      {/* The facts FIRST — they were invisible until round 61, buried in the
          folded ✏️ form below, so reading a lead's phone number meant opening
          an editor and reading it out of an input. */}
      <LeadFacts
        values={{
          phone: lead.phone ?? '',
          company: lead.company ?? '',
          note: lead.note ?? '',
        }}
        sourceName={sources.find((row) => row.id === lead.sourceId)?.name ?? ''}
        ownerName={managers.find((row) => row.id === lead.ownerId)?.fullName ?? ''}
        quote={
          lead.quotedAmount
            ? [
                `${Number(lead.quotedAmount).toLocaleString('ru-RU')} ${lead.quotedCurrency ?? 'USD'}`,
                lead.quotedVolumeM3 ? `${Number(lead.quotedVolumeM3)} m³` : '',
                lead.quotedWeightKg ? `${Number(lead.quotedWeightKg)} kg` : '',
              ]
                .filter(Boolean)
                .join(' · ')
            : ''
        }
        nextAction={[lead.nextActionAt, lead.nextActionNote].filter(Boolean).join(' · ')}
      />

      {/* Directly under the phone number it is about: «somebody here already
          has a Telegram chat with this number» (round 82). Renders nothing
          when there is no match, which is most cards. */}
      <TelegramLookback phone={lead.phone} leadId={lead.id} clientId={lead.clientId} />

      {lead.clientId ? (
        <div className="flex gap-2">
          <Link
            href={`/admin/clients/${lead.clientId}`}
            className="card block min-w-0 flex-1 text-sm font-semibold text-good"
          >
            ✅ {t('alreadyClient')} →
          </Link>
          {/* The lead is won and coded — the next thing a salesperson does is
              open the JOB (owner: "lead voronkadan bitim voronkaga oson
              o'tilishi kerak"). One tap, client pre-picked. */}
          <Link
            // `lead=` carries the quote: the price agreed on the LEAD is the
            // price the deal opens with, typed once (round 71).
            href={`/bitimlar/new?client=${lead.clientId}&lead=${lead.id}`}
            data-testid="lead-to-deal"
            className="card flex items-center text-sm font-bold text-brand-700"
          >
            🤝 {t('openDeal')}
          </Link>
        </div>
      ) : (
        // Open once the lead reaches a won stage: at that moment minting the
        // client card is the only thing left to do, and hiding it behind a
        // tap is how a won deal sits around without a code for a week.
        <Panel
          title={`🤝 ${t('convert')}`}
          open={stages.find((stage) => stage.id === lead.stageId)?.kind === 'won'}
        >
          <ConvertForm
            action={convert}
            defaultName={lead.company || lead.name}
            codePrefix={String(codePrefix)}
          />
        </Panel>
      )}

      <Panel title={`✏️ ${tc('edit')}`} testId="lead-edit-panel">
        {/* Losing a lead belongs to the board, which asks why. The lead's OWN
            stage stays in the list even when it is lost, or the select would
            fall back to its first option and Save would revive it. */}
        <LeadForm
          action={update}
          sources={sources.map((row) => ({ id: row.id, label: row.name }))}
          stages={formStages(stages, lead.stageId).map((row) => ({ id: row.id, label: row.name }))}
          owners={managers.map((row) => ({ id: row.id, label: row.fullName }))}
          initial={{
            name: lead.name,
            phone: lead.phone ?? '',
            company: lead.company ?? '',
            sourceId: lead.sourceId ?? '',
            stageId: lead.stageId,
            ownerId: lead.ownerId ?? '',
            note: lead.note ?? '',
            quotedAmount: lead.quotedAmount ?? '',
            quotedCurrency: lead.quotedCurrency ?? '',
            quotedVolumeM3: lead.quotedVolumeM3 ?? '',
            quotedWeightKg: lead.quotedWeightKg ?? '',
            nextActionAt: lead.nextActionAt ?? '',
            nextActionNote: lead.nextActionNote ?? '',
          }}
        >
          <CustomFieldInputs {...custom} />
        </LeadForm>
      </Panel>

      <TasksPanel
        entityType="lead"
        entityId={id}
        revalidate={`/crm/leads/${id}`}
      />

      {/* The lead was the one card in the app with no history, and it is the
          one that now records a row per corrected field. Folded, because a
          salesperson opens this card to call somebody, not to audit it. */}
          </>
        }
        tail={
          /* Last on a phone: the audit trail is what you consult, never what
             you came for (owner: «istoriya tarix mobileda eng pastda»). */
          <Panel title={`🕓 ${tc('history')}`} testId="lead-history-panel">
            <HistoryTab entityType="lead" entityId={id} />
          </Panel>
        }
      />
    </div>
  );
}
