import Link from 'next/link';
import { notFound, redirect } from 'next/navigation';
import { eq } from 'drizzle-orm';
import { getFormatter, getTranslations } from 'next-intl/server';
import { db } from '@/modules/platform/db/client';
import { attachments, crmActivities } from '@/modules/platform/db/schema';
import { getActor } from '@/modules/platform/rbac/authorize';
import { calcRequestDetail } from '@/modules/wms/calc/service';
import { linkedReceipts } from '@/modules/wms/calc/link';
import { FIELD_LABELS, SECTION_LABELS } from '@/modules/wms/calc/labels';
import type { CalcField, CalcSection } from '@/modules/wms/calc/intake';
import { PageHeader, Section } from '@/components/ui/page';
import { LightboxImg } from '@/components/lightbox-img';
import { loadWorkspace } from '@/modules/wms/calc/workspace';
import { isServerBehind } from '@/modules/platform/db/errors';
import { logger } from '@/modules/platform/logger';
import { CalcActions } from './calc-actions';
import { CalcWorkspace } from './calc-workspace';
import { LastQuotes } from './last-quotes';

/**
 * One calculation request — the VED person's whole screen.
 *
 * Phase 2 gave the TABLE the page's full width: the two-column CardCols left
 * the working surface ~490 px at 1280 (measured), which is no home for an
 * Excel-shaped grid. The reading order survives the change — facts, then the
 * seller's materials, then the table — so on a phone the VED still reads
 * what was sent before scrolling into the numbers.
 *
 * It CATCHES its own reads: the workspace's columns landed in 0086 and this
 * page already works without them, so on deploy morning — with the app a
 * release ahead of the database — an uncaught read here would take the whole
 * screen down instead of the half that is new (#472-475). The read-only
 * goods table below is that catch's other half: whenever the workspace's own
 * table is not on screen (server behind, a yolkira section, a closed
 * request), `calc-items` still answers from the request row itself.
 */
export default async function CalcRequestPage({ params }: { params: Promise<{ id: string }> }) {
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
  const canRecalc = actor.permissions.has('admin.settings.manage');

  let workspace: Awaited<ReturnType<typeof loadWorkspace>> = null;
  // Phase E1: the cargo this quote turned out to be about. On the same catch
  // as the workspace — 0089 is this release's migration (#472).
  let linked: Awaited<ReturnType<typeof linkedReceipts>> = [];
  try {
    [workspace, linked] = await Promise.all([loadWorkspace(id), linkedReceipts(id)]);
  } catch (err) {
    if (!isServerBehind(err)) throw err;
    logger.error({ err, id }, '[calc] workspace: server behind');
  }

  return (
    <div className="mx-auto max-w-6xl space-y-4">
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

      {/* ---- facts, compact and full-width: same content, same testids ---- */}
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
        <dl className="mt-2 grid grid-cols-2 gap-x-3 gap-y-1 text-sm md:grid-cols-4">
          <dt className="text-ink-500">{t('route')}</dt>
          <dd>
            {row.fromCity ?? '—'} → {row.toCity ?? '—'}
          </dd>
          <dt className="text-ink-500">{t('fields.weightKg')}</dt>
          <dd className="num md:text-left">{row.weightKg ?? '—'}</dd>
          <dt className="text-ink-500">{t('fields.volumeM3')}</dt>
          <dd className="num md:text-left">{row.volumeM3 ?? '—'}</dd>
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

      {/* The seller's materials ARE the input the VED types the table from —
          open on a fresh request, one tap once it has been worked (the
          testid lives on the <details> ROOT: a closed fold's summary is
          still visible, its content is not). */}
      <details
        className="card !p-3"
        data-testid="calc-materials"
        open={Boolean((note?.note || files.length > 0) && !closed && !workspace?.sealedVersion)}
      >
        <summary className="cursor-pointer text-sm font-semibold">
          📎 {t('materials')}
          {files.length > 0 ? ` · ${files.length}` : ''}
        </summary>
        <div className="mt-2">
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
      </details>

      {workspace ? <CalcWorkspace workspace={workspace} canRecalc={canRecalc} /> : null}

      {/* The workspace's own table renders `calc-items` when it is on screen;
          everywhere else (server behind, yolkira, closed) this read-only
          fallback answers under the SAME testid — one element in the DOM
          either way, because getByTestId is strict-mode. */}
      {!(workspace && workspace.parts.customs && !workspace.completedAt) ? (
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
      ) : null}

      {/* What these codes were charged before — read beside the numbers
          being typed, which is where the question is actually asked. */}
      {workspace ? (
        <LastQuotes codes={workspace.groups.map((g) => g.tnvedCode ?? '')} requestId={id} />
      ) : null}

      <div className="grid gap-4 md:grid-cols-2">
        {/* Phase E1: what the quote turned out to be about. The ✓ is the
            whole point — an unconfirmed guess is not measured, so a row
            without one is a row asking somebody to look. */}
        <Section title={t('linkedReceipts')}>
          {linked.length === 0 ? (
            <p className="text-sm text-ink-500" data-testid="calc-linked-none">
              {t('linkNoneOnCard')}
            </p>
          ) : (
            <ul className="space-y-1" data-testid="calc-linked">
              {linked.map((r) => (
                <li key={r.receiptId} className="flex flex-wrap items-baseline gap-2 text-sm">
                  <Link href={`/receipts/${r.receiptId}`} className="font-mono text-brand-700">
                    {r.number ?? '—'}
                  </Link>
                  <span className="text-2xs text-ink-500">
                    {r.volumeM3.toFixed(2)} m³ · {r.weightKg.toFixed(0)} kg
                  </span>
                  {r.linkConfirmed ? (
                    <span className="chip chip-good">✓</span>
                  ) : (
                    <span className="chip chip-warn">?</span>
                  )}
                </li>
              ))}
            </ul>
          )}
        </Section>

        <div>
          {closed ? (
            <section className="card !p-3" data-testid="calc-answer">
              {row.completedVia === 'returned' ? (
                <p className="text-sm">
                  <span className="text-ink-500">{t('returned')}:</span> {row.returnReason ?? '—'}
                </p>
              ) : row.answerAmount ? (
                <>
                  <p className="text-sm">
                    <span className="text-ink-500">{t('answered')}:</span>{' '}
                    <span className="num font-semibold">
                      {row.answerAmount} {row.answerCurrency ?? ''}
                    </span>
                  </p>
                  {row.answerNote ? (
                    <p className="mt-1 whitespace-pre-wrap text-sm">{row.answerNote}</p>
                  ) : null}
                </>
              ) : null}
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
      </div>
    </div>
  );
}
