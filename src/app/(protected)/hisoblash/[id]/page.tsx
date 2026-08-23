import Link from 'next/link';
import { notFound, redirect } from 'next/navigation';
import { eq } from 'drizzle-orm';
import { getFormatter, getTranslations } from 'next-intl/server';
import { db } from '@/modules/platform/db/client';
import { attachments, crmActivities } from '@/modules/platform/db/schema';
import { getActor } from '@/modules/platform/rbac/authorize';
import { calcRequestDetail } from '@/modules/wms/calc/service';
import { FIELD_LABELS, SECTION_LABELS } from '@/modules/wms/calc/labels';
import type { CalcField, CalcSection } from '@/modules/wms/calc/intake';
import { PageHeader, Section } from '@/components/ui/page';
import { LightboxImg } from '@/components/lightbox-img';
import { CalcActions } from './calc-actions';

/**
 * One calculation request — the VED person's whole screen for phase A.
 *
 * The left half of the workspace phase B will finish: the materials exactly
 * as the seller sent them (the owner's law 11), the goods at the grain his
 * invoice came in, the facts and what is still missing. The right half — the
 * TNVED grouping, the baza, the rates and the sealed price — is phase B, and
 * until it exists «Bajarildi» records the figure the VED person worked out.
 */
export default async function CalcRequestPage({
  params,
}: {
  params: Promise<{ id: string }>;
}) {
  const actor = await getActor();
  if (!actor) redirect('/login');
  if (!actor.permissions.has('ved.docs')) redirect('/');
  const { id } = await params;

  const row = await calcRequestDetail(id);
  if (!row) notFound();

  const t = await getTranslations('calc');
  const format = await getFormatter();

  // The materials: the note's own text and its files. Read here rather than
  // through the lenta, because the lenta is the CARD's story and a `ved.docs`
  // holder may not open a lead card at all.
  const note = row.noteId
    ? await db.query.crmActivities.findFirst({ where: eq(crmActivities.id, row.noteId) })
    : null;
  const files = row.noteId
    ? await db
        .select({
          id: attachments.id,
          name: attachments.fileName,
          contentType: attachments.contentType,
        })
        .from(attachments)
        .where(eq(attachments.entityId, row.noteId))
    : [];

  const canOpenCard = row.entityType === 'deal' || actor.permissions.has('crm.leads');
  const cardHref =
    row.entityType === 'deal' ? `/bitimlar/${row.entityId}` : `/crm/leads/${row.entityId}`;
  const closed = Boolean(row.completedAt);

  return (
    <div className="mx-auto max-w-3xl space-y-4">
      <PageHeader
        icon="report"
        title={row.entityType === 'deal' ? row.label : t('title')}
        subtitle={`${row.itemCount} ${t('items')} · ${t('requester')}: ${row.requesterName}`}
        back={{ href: '/hisoblash', label: t('queueTitle') }}
        actions={
          canOpenCard ? (
            <Link href={cardHref} className="btn-secondary" data-testid="calc-card-link">
              {t('openCard')}
            </Link>
          ) : null
        }
      />

      <section className="card !p-3" data-testid="calc-facts">
        <div className="flex flex-wrap items-center gap-2">
          {row.section ? (
            <span className="chip chip-brand">
              {t(SECTION_LABELS[row.section as CalcSection] as 'sections.podklyuch')}
            </span>
          ) : null}
          {row.late && !closed ? <span className="chip chip-warn">{t('late')}</span> : null}
          {closed ? (
            <span className="chip chip-neutral" data-testid="calc-closed">
              {row.completedVia === 'returned' ? t('returned') : t('finish')}
            </span>
          ) : row.assigneeId ? (
            <span className="text-xs text-ink-600">
              {t('takenBy')}: {row.assigneeName ?? '—'}
            </span>
          ) : (
            <span className="chip chip-warn">{t('unassigned')}</span>
          )}
        </div>
        <dl className="mt-2 grid grid-cols-2 gap-x-3 gap-y-1 text-sm">
          <dt className="text-ink-500">{t('route')}</dt>
          <dd>
            {row.fromCity ?? '—'} → {row.toCity ?? '—'}
          </dd>
          <dt className="text-ink-500">{t('fields.weightKg')}</dt>
          <dd className="num">{row.weightKg ?? '—'}</dd>
          <dt className="text-ink-500">{t('fields.volumeM3')}</dt>
          <dd className="num">{row.volumeM3 ?? '—'}</dd>
          <dt className="text-ink-500">{t('askedAt')}</dt>
          <dd>{format.dateTime(row.requestedAt, { dateStyle: 'short', timeStyle: 'short' })}</dd>
          <dt className="text-ink-500">{t('dueBy')}</dt>
          <dd>{format.dateTime(row.dueAt, { dateStyle: 'short', timeStyle: 'short' })}</dd>
        </dl>

        <div className="mt-2 border-t border-line pt-2" data-testid="calc-checklist">
          {row.missing.length === 0 ? (
            <p className="text-sm text-good">✅ {t('complete')}</p>
          ) : (
            <div className="flex flex-wrap items-center gap-1">
              <span className="text-sm text-warn">⚠ {t('missingLabel')}:</span>
              {row.missing.map((field) => (
                <span key={field} className="chip chip-warn">
                  {t(FIELD_LABELS[field as CalcField] as 'fields.goods')}
                </span>
              ))}
            </div>
          )}
        </div>
      </section>

      {/* Everything the seller submitted, unabridged and unsummarised. */}
      <Section title={t('materials')}>
        <div className="card !p-3" data-testid="calc-materials">
          {note?.note ? (
            <p className="whitespace-pre-wrap text-sm">{note.note}</p>
          ) : (
            <p className="text-sm text-ink-500">—</p>
          )}
          {files.length > 0 ? (
            <div className="mt-2 flex flex-wrap gap-2">
              {files.map((file) =>
                file.contentType?.startsWith('image/') ? (
                  <LightboxImg
                    key={file.id}
                    attachmentId={file.id}
                    alt={file.name}
                    testId="calc-photo"
                    className="h-20 w-20 max-w-none rounded object-cover"
                  />
                ) : (
                  <a
                    key={file.id}
                    href={`/api/attachments/${file.id}`}
                    className="chip chip-neutral"
                    target="_blank"
                    rel="noreferrer"
                  >
                    📎 {file.name}
                  </a>
                ),
              )}
            </div>
          ) : null}
        </div>
      </Section>

      <Section title={`${t('goods')} · ${row.itemCount}`}>
        <div className="card !p-0 overflow-x-auto">
          {row.items.length === 0 ? (
            <p className="p-3 text-sm text-ink-500">—</p>
          ) : (
            <table className="w-full text-sm" data-testid="calc-items">
              <thead>
                <tr className="border-b border-line text-left text-2xs uppercase text-ink-500">
                  <th className="p-2">#</th>
                  <th className="p-2">{t('goods')}</th>
                  <th className="p-2">TNVED</th>
                  <th className="p-2">kg</th>
                  <th className="p-2">m³</th>
                </tr>
              </thead>
              <tbody>
                {row.items.map((item) => (
                  <tr key={item.seq} className="border-b border-line/60">
                    <td className="p-2 num text-ink-500">{item.seq}</td>
                    <td className="p-2">
                      {item.name}
                      {item.quantity != null ? (
                        <span className="text-2xs text-ink-500">
                          {' '}
                          · {item.quantity} {item.unit ?? ''}
                        </span>
                      ) : null}
                    </td>
                    <td className="p-2 num">{item.tnvedCode ?? '—'}</td>
                    <td className="p-2 num">{item.weightKg ?? '—'}</td>
                    <td className="p-2 num">{item.volumeM3 ?? '—'}</td>
                  </tr>
                ))}
              </tbody>
            </table>
          )}
        </div>
      </Section>

      {closed ? (
        <section className="card !p-3" data-testid="calc-answer">
          {row.completedVia === 'returned' ? (
            <p className="text-sm">
              <span className="text-ink-500">{t('returned')}:</span> {row.returnReason ?? '—'}
            </p>
          ) : (
            <>
              <p className="text-sm">
                <span className="text-ink-500">{t('answered')}:</span>{' '}
                <span className="num font-semibold">
                  {row.answerAmount ?? '—'} {row.answerCurrency ?? ''}
                </span>
              </p>
              {row.answerNote ? (
                <p className="mt-1 whitespace-pre-wrap text-sm">{row.answerNote}</p>
              ) : null}
            </>
          )}
        </section>
      ) : (
        <section className="card !p-3">
          <CalcActions
            id={row.id}
            mine={row.assigneeId === actor.id}
            assigned={Boolean(row.assigneeId)}
          />
        </section>
      )}
    </div>
  );
}
