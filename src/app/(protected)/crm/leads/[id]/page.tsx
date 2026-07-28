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
import { listSources, listStages } from '@/modules/wms/crm/service';
import { customFieldsData } from '@/modules/platform/fields/view';
import { convertLeadAction, updateLeadAction } from '../../actions';
import { ActivityForm } from '../../activity-form';
import { CustomFieldInputs } from '@/components/custom-fields';
import { LeadForm } from '../lead-form';
import { ConvertForm } from './convert-form';
import { StageMover } from './stage-mover';
import { TasksPanel } from '@/components/tasks-panel';
import { ClientFeed } from '@/components/client-feed';
import { conversationClientForLead } from '@/modules/wms/crm/conversations';

/** One lead: where it stands, what was said, and the button that ends it. */
export default async function LeadPage({ params }: { params: Promise<{ id: string }> }) {
  const { id } = await params;
  const actor = await getActor();
  if (!actor) redirect('/login');
  if (!actor.permissions.has('crm.leads')) redirect('/');
  const lead = await db.query.leads.findFirst({ where: eq(leads.id, id) });
  if (!lead) notFound();
  // A sales manager works their own leads; seeing someone else's would let
  // two people call the same person about the same cargo.
  if (!actor.permissions.has('crm.leads.view_all') && lead.ownerId !== actor.id) redirect('/crm');

  const t = await getTranslations('crm');
  const tc = await getTranslations('common');
  const [sources, stages, managers, custom, codePrefix] = await Promise.all([
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
  ]);

  const today = new Date().toISOString().slice(0, 10);
  const update = updateLeadAction.bind(null, id);
  const convert = convertLeadAction.bind(null, id);

  return (
    <div className="mx-auto max-w-lg space-y-3">
      <Link href="/crm" className="text-sm font-semibold text-brand-700">
        ← {t('funnel')}
      </Link>
      <h1 className="text-xl font-bold [overflow-wrap:anywhere]">{lead.name}</h1>

      <StageMover
        leadId={id}
        currentId={lead.stageId}
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
            href={`/bitimlar/new?client=${lead.clientId}`}
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

      {/* A lead who is already a client — converted, or an existing customer
          asking about another job — brings their conversation with them. A
          brand new prospect has none, and the panel simply does not render. */}
      <ClientFeed clientId={await conversationClientForLead(lead)} leadId={lead.id} limit={40} />

      {/* The activity FORM stays — its kind and «keyingi qadam» date are what
          feed /crm/today, and the lenta's quick note box has neither. The LIST
          it used to sit above is gone: those same activities now render on the
          lenta, and two copies of every note on one card is how the owner's
          "qachon nima bo'lgani 1 joyda" turns back into two places. Caught by
          the funnel e2e, whose strict locator found the note twice. */}
      <ActivityForm entityType="lead" entityId={id} today={today} />

      <Panel title={`✏️ ${tc('edit')}`}>
        <LeadForm
          action={update}
          sources={sources.map((row) => ({ id: row.id, label: row.name }))}
          stages={stages.map((row) => ({ id: row.id, label: row.name }))}
          owners={managers.map((row) => ({ id: row.id, label: row.fullName }))}
          initial={{
            name: lead.name,
            phone: lead.phone ?? '',
            company: lead.company ?? '',
            sourceId: lead.sourceId ?? '',
            stageId: lead.stageId,
            ownerId: lead.ownerId ?? '',
            note: lead.note ?? '',
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
    </div>
  );
}
