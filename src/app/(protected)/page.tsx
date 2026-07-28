import Link from 'next/link';
import { redirect } from 'next/navigation';
import { getTranslations } from 'next-intl/server';
import { getActor } from '@/modules/platform/rbac/authorize';
import { menuItems, NAV } from '@/modules/platform/rbac/nav';
import { Icon, type IconName } from '@/components/ui/icon';
import { Section } from '@/components/ui/page';
import { myDay } from '@/modules/platform/tasks/service';
import { endOfToday } from '@/modules/platform/tasks/view';
import { warehouseFlowCounts, type WarehouseFlowCounts } from '@/modules/wms/home/flow';

/**
 * Home.
 *
 * Two jobs, in this order: put the one thing this person came to do under
 * their thumb, and let them reach everything else without thinking.
 *
 * For warehouse staff the screen goes further (owner: "har bir hodim
 * qiladigan ishiga qarab layout tuz"): their day is a SEQUENCE — what is
 * coming → receive it → load it → hand it over — so the top of their home is
 * that sequence, each step carrying the live number that says whether it
 * needs them right now. Everyone else keeps the tile layout, generated from
 * the same navigation model as the sidebar and the tab bar, so a new screen
 * appears everywhere at once.
 */

/** The steps of the warehouse day, in the order the day happens. */
const FLOW_HREFS = ['/receive', '/arrivals', '/batches', '/issue'];

export default async function HomePage() {
  const actor = await getActor();
  if (!actor) redirect('/login');
  const t = await getTranslations('home');

  const label = async (namespace: string, key: string) =>
    (await getTranslations(namespace as 'home'))(key as 'receiving');

  // The workflow home is keyed on the same fact as the data scope: any
  // warehouse-scoped role means this person's day IS the warehouse day.
  const flow = actor.warehouseScoped
    ? await warehouseFlowCounts(actor, new Date().toISOString().slice(0, 10))
    : null;

  const viewer = { permissions: actor.permissions, roles: actor.roles };
  const groups: { title: string; items: { href: string; label: string; icon: IconName }[] }[] = [];
  for (const group of NAV) {
    const items = [];
    for (const item of group.items) {
      // The home tile for "home" itself would be a link to this page; the
      // workflow steps are drawn once, above, not repeated as tiles.
      if (item.href === '/' || !menuItems(item, viewer)) continue;
      if (flow && FLOW_HREFS.includes(item.href)) continue;
      items.push({
        href: item.href,
        label: await label(item.namespace, item.labelKey),
        icon: item.icon,
      });
    }
    if (items.length > 0)
      groups.push({ title: t(group.titleKey as 'sectionInfo'), items });
  }

  const [first, ...rest] = groups[0]?.items ?? [];
  const firstGroupTitle = groups[0]?.title;

  // Work somebody gave THIS person, on the screen everyone opens.
  //
  // Load-bearing rather than decorative: warehouse staff no longer carry
  // "my day" in their menu (the owner: they need warehouse work and nothing
  // else), so without this line a task assigned to a packer would exist and
  // never be seen. Hiding a screen must never be able to hide the work.
  const tt = await getTranslations('tasks');
  const day = await myDay(actor.id, endOfToday());
  const due = day.overdue.length + day.today.length;

  return (
    <div className="space-y-6">
      <div>
        <p className="text-xs font-medium text-ink-500">
          {new Date().toLocaleDateString('en-GB')}
        </p>
        {/* Two lines at most: a long full name used to push the first action
            below the fold on a 360 px screen. */}
        <h1 className="line-clamp-2 text-xl leading-tight">
          {t('welcome', { name: actor.fullName })}
        </h1>
      </div>

      {due > 0 && (
        <Link
          href="/bugun"
          data-testid="home-tasks"
          className={`flex items-center gap-3 rounded-2xl border p-3 shadow-card ${
            day.overdue.length > 0
              ? 'border-bad/30 bg-bad/10 text-bad'
              : 'border-warn/30 bg-warn/10 text-warn'
          }`}
        >
          <span className="text-xl">{day.overdue.length > 0 ? '🔴' : '🟡'}</span>
          <span className="min-w-0 flex-1 font-bold">
            {day.overdue.length > 0 ? tt('overdue') : tt('dueToday')} · {due}
          </span>
          <Icon name="chevronRight" className="h-5 w-5 opacity-70" />
        </Link>
      )}

      {flow ? (
        <WarehouseFlow flow={flow} />
      ) : (
        first && (
          <Section title={firstGroupTitle}>
            {/* The primary action gets the width and the colour; the rest of
                the group sits under it at half size. */}
            <Link
              href={first.href}
              className="flex items-center gap-3 rounded-2xl bg-brand-600 p-4 text-white shadow-card transition-transform duration-100 active:scale-[0.99]"
            >
              <span className="grid h-12 w-12 place-items-center rounded-xl bg-surface-raised/15">
                <Icon name={first.icon} className="h-6 w-6" strokeWidth={2} />
              </span>
              <span className="text-lg font-bold">{first.label}</span>
              <Icon name="chevronRight" className="ml-auto h-5 w-5 opacity-70" />
            </Link>
            {rest.length > 0 && (
              <div className="grid grid-cols-2 gap-2.5 sm:grid-cols-3">
                {rest.map((item) => (
                  <Tile key={item.href} {...item} />
                ))}
              </div>
            )}
          </Section>
        )
      )}

      {(flow ? groups : groups.slice(1)).map((group) => (
        <Section key={group.title} title={group.title}>
          <div className="grid grid-cols-2 gap-2.5 sm:grid-cols-3">
            {group.items.map((item) => (
              <Tile key={item.href} {...item} />
            ))}
          </div>
        </Section>
      ))}
    </div>
  );
}

/**
 * The warehouse day, drawn as the day: receive is the big button — it is
 * 90 % of the work — and under it the remaining steps in the order they
 * happen, each with the number that says whether it needs attention now.
 * A row that reads «Yuklash · 2» is an instruction; a bare tile is a door.
 */
async function WarehouseFlow({ flow }: { flow: WarehouseFlowCounts }) {
  const t = await getTranslations('home');
  const ta = await getTranslations('arrivals');

  const incoming = flow.trucksIncoming + flow.expectedWaiting;
  const arrivalsSub = [
    flow.trucksIncoming > 0 && `🚛 ${t('flowTrucks', { n: flow.trucksIncoming })}`,
    flow.expectedWaiting > 0 && `📦 ${t('flowExpected', { n: flow.expectedWaiting })}`,
  ]
    .filter(Boolean)
    .join(' · ');

  return (
    <Section title={t('flowTitle')}>
      <Link
        href="/receive"
        data-testid="flow-receive"
        className="flex items-center gap-3 rounded-2xl bg-brand-600 p-4 text-white shadow-card transition-transform duration-100 active:scale-[0.99]"
      >
        <span className="grid h-12 w-12 place-items-center rounded-xl bg-surface-raised/15">
          <Icon name="inbox" className="h-6 w-6" strokeWidth={2} />
        </span>
        <span className="text-lg font-bold">{t('receiving')}</span>
        <Icon name="chevronRight" className="ml-auto h-5 w-5 opacity-70" />
      </Link>

      <div className="space-y-2">
        <FlowRow
          href="/arrivals"
          icon="inbox"
          testid="flow-arrivals"
          label={ta('title')}
          count={incoming}
          warn={flow.expectedLate > 0}
          sub={
            arrivalsSub || flow.expectedLate > 0 ? (
              <>
                {arrivalsSub}
                {flow.expectedLate > 0 && (
                  <span className="text-warn">
                    {arrivalsSub && ' · '}⚠ {t('flowLate', { n: flow.expectedLate })}
                  </span>
                )}
              </>
            ) : null
          }
        />
        <FlowRow
          href="/batches"
          icon="truck"
          testid="flow-batches"
          label={t('loading')}
          count={flow.loadingBatches}
          sub={flow.loadingBatches > 0 ? t('flowLoading', { n: flow.loadingBatches }) : null}
        />
        <FlowRow
          href="/issue"
          icon="handshake"
          testid="flow-issue"
          label={t('handover')}
          count={flow.readyBoxes}
          sub={flow.readyBoxes > 0 ? t('flowReady', { n: flow.readyBoxes }) : null}
        />
      </div>
    </Section>
  );
}

function FlowRow({
  href,
  icon,
  label,
  sub,
  count,
  warn = false,
  testid,
}: {
  href: string;
  icon: IconName;
  label: string;
  sub: React.ReactNode;
  count: number;
  warn?: boolean;
  testid: string;
}) {
  return (
    <Link href={href} data-testid={testid} className="card-tap flex items-center gap-3 !p-3">
      <span className="grid h-11 w-11 shrink-0 place-items-center rounded-xl bg-brand-50 text-brand-700">
        <Icon name={icon} className="h-6 w-6" />
      </span>
      <span className="min-w-0 flex-1">
        <span className="block font-bold leading-tight">{label}</span>
        {sub && <span className="block text-xs text-ink-500">{sub}</span>}
      </span>
      {/* The number only when there IS one: a zero pill on every quiet row
          teaches the eye to skip the pills entirely. */}
      {count > 0 && (
        <span
          data-testid={`${testid}-count`}
          className={`num rounded-full px-2.5 py-0.5 text-sm font-extrabold ${
            warn ? 'bg-warn/10 text-warn' : 'bg-brand-50 text-brand-700'
          }`}
        >
          {count}
        </span>
      )}
      <Icon name="chevronRight" className="h-5 w-5 shrink-0 text-ink-500 opacity-60" />
    </Link>
  );
}

/**
 * Icon left, label right.
 *
 * A stacked tile centred the text, and Russian/Uzbek screen names are long —
 * "Инвентаризация" broke across three ragged lines. Reading left to right
 * also matches the sidebar and the sheet, so the same screen looks the same
 * wherever it is offered.
 */
function Tile({ href, label, icon }: { href: string; label: string; icon: IconName }) {
  return (
    <Link href={href} className="card-tap flex min-h-16 items-center gap-2.5 !p-3">
      <span className="grid h-9 w-9 shrink-0 place-items-center rounded-lg bg-brand-50 text-brand-700">
        <Icon name={icon} className="h-5 w-5" />
      </span>
      <span className="text-sm font-bold leading-tight [overflow-wrap:anywhere]">{label}</span>
    </Link>
  );
}
