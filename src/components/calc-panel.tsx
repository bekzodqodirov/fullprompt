import Link from 'next/link';
import { getFormatter, getTranslations } from 'next-intl/server';
import { getActor } from '@/modules/platform/rbac/authorize';
import { canWriteDeal } from '@/modules/wms/deals/service';
import { lastCalcAnswerFor, openCalcFor } from '@/modules/wms/calc/service';
import { SECTION_LABELS } from '@/modules/wms/calc/labels';
import type { CalcSection } from '@/modules/wms/calc/intake';
import { isServerBehind } from '@/modules/platform/db/errors';
import { logger } from '@/modules/platform/logger';
import { Panel } from './panel';
import { CalcSendForm } from './calc-send-form';

/**
 * «Hisoblatishga yuborish» on a lead or deal card, and what came back.
 *
 * Gates itself like every panel that can appear on any card (#299): the deal
 * card is open to the customs manager, so the permission travels with the
 * panel, not with the page.
 *
 * It also CATCHES: this panel renders inside two screens that already work,
 * and its columns landed in migration 0085 — on deploy morning, with the app
 * a release ahead of the database, an uncaught read here would take the deal
 * card down with it (#472-475).
 */
export async function CalcPanel({
  entityType,
  entityId,
  revalidate,
}: {
  entityType: 'deal' | 'lead';
  entityId: string;
  revalidate: string;
}) {
  const actor = await getActor();
  if (!actor || !canWriteDeal(actor.permissions)) return null;
  if (entityType === 'lead' && !actor.permissions.has('crm.leads')) return null;

  let open: Awaited<ReturnType<typeof openCalcFor>> = [];
  let last: Awaited<ReturnType<typeof lastCalcAnswerFor>> = null;
  try {
    [open, last] = await Promise.all([
      openCalcFor(entityType, entityId),
      lastCalcAnswerFor(entityType, entityId),
    ]);
  } catch (err) {
    if (!isServerBehind(err)) throw err;
    logger.error({ err, entityType, entityId }, '[calc] panel: server behind');
    return null;
  }

  const t = await getTranslations('calc');
  const format = await getFormatter();

  return (
    <Panel
      title={`🧮 ${t('panelTitle')}`}
      badge={open.length || undefined}
      testId="calc-panel"
      open={open.length > 0}
    >
      {open.length > 0 ? (
        <ul className="space-y-1" data-testid="calc-open">
          {open.map((row) => (
            <li key={row.id} className="flex flex-wrap items-center gap-2 text-sm">
              {/* The VED person reads the request from the card too — and the
                  seller, who may not, sees the same line without a door. */}
              {actor.permissions.has('ved.docs') ? (
                <Link
                  href={`/hisoblash/${row.id}`}
                  data-testid="calc-open-link"
                  className="font-semibold text-brand-700"
                >
                  #
                </Link>
              ) : null}
              {row.section ? (
                <span className="chip chip-brand">
                  {t(SECTION_LABELS[row.section as CalcSection] as 'sections.podklyuch')}
                </span>
              ) : null}
              <span className="text-ink-600">
                {row.assigneeId ? `${t('takenBy')}: ${row.assigneeName ?? '—'}` : t('unassigned')}
              </span>
              {row.late ? <span className="chip chip-warn">{t('late')}</span> : null}
              <span className="text-2xs text-ink-500">
                {t('dueBy')}: {format.dateTime(row.dueAt, { hour: '2-digit', minute: '2-digit' })}
              </span>
            </li>
          ))}
        </ul>
      ) : null}

      {last ? (
        <p className="border-t border-line pt-2 text-sm" data-testid="calc-last-answer">
          <span className="text-ink-500">{t('answered')}:</span>{' '}
          <span className="num font-semibold">
            {last.amount ?? '—'} {last.currency ?? ''}
          </span>{' '}
          <span className="text-2xs text-ink-500">
            {format.dateTime(last.at, { dateStyle: 'short' })}
          </span>
          {last.note ? <span className="block text-xs text-ink-600">{last.note}</span> : null}
        </p>
      ) : null}

      {/* The phone path is the BOT: the seller's material lives in Telegram,
          and a browser form cannot reach it — forwarding three photos to the
          bot is six taps, saving them out and re-uploading them is thirty.
          The form below is for the desk, so on a phone this panel is a status
          banner with a door to the bot instead. */}
      <div className="border-t border-line pt-2">
        <p className="text-2xs text-ink-500 sm:hidden">{t('sendOnPhone')}</p>
        <div className="hidden sm:block">
          <CalcSendForm entityType={entityType} entityId={entityId} revalidate={revalidate} />
        </div>
      </div>

      {actor.permissions.has('ved.docs') ? (
        <Link href="/hisoblash" className="text-2xs text-brand-700">
          {t('queueTitle')} →
        </Link>
      ) : null}
    </Panel>
  );
}
