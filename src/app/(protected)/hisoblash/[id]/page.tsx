import Link from 'next/link';
import { notFound, redirect } from 'next/navigation';
import { eq } from 'drizzle-orm';
import { getFormatter, getTranslations } from 'next-intl/server';
import { db } from '@/modules/platform/db/client';
import { attachments, crmActivities } from '@/modules/platform/db/schema';
import { getActor } from '@/modules/platform/rbac/authorize';
import { calcInternalNoteFor, calcRequestDetail, endingOf, type CalcEnding } from '@/modules/wms/calc/service';
import { linkedReceipts } from '@/modules/wms/calc/link';
import { chainLinksOf, chainOf, type ChainLink, type ChainVersion } from '@/modules/wms/calc/chain';
import { calcCardHref } from '@/modules/wms/calc/card-door';
import { FIELD_LABELS, SECTION_LABELS } from '@/modules/wms/calc/labels';
import type { CalcField, CalcSection } from '@/modules/wms/calc/intake';
import { PageHeader, Section } from '@/components/ui/page';
import { LightboxImg } from '@/components/lightbox-img';
import { canSeal, loadWorkspace, offerPricesFor, type OfferPrice } from '@/modules/wms/calc/workspace';
import { sectionParts } from '@/modules/wms/calc/pricing';
import { isServerBehind } from '@/modules/platform/db/errors';
import { logger } from '@/modules/platform/logger';
import { CalcActions } from './calc-actions';
import { CalcWorkspace } from './calc-workspace';
import { calcRegistrySight, internalNoteSight } from '@/modules/wms/calc/control-scope';
import {
  calcSheetsForRequest,
  requestGoodsSheet,
  type CalcGoodsSheet,
  type CalcSheet as CalcSheetData,
} from '@/modules/wms/calc/sheet';
import { CalcGoodsSheetView, CalcSheet } from '@/components/calc-sheet';
import { OfferPriceList } from '@/components/calc-panel';
import { RecalcButton } from './recalc-button';
import { offerSightFor } from '@/modules/wms/calc/upsale-scope';
import { CargoFactsForm } from './cargo-facts';
import { LastQuotes } from './last-quotes';
import { CalcThread } from '@/components/calc-thread';
import { ThreadSeen } from '@/components/thread-seen';
import { ThreadPulse } from '@/components/thread-pulse';
import { calcThreadSummary, threadToken } from '@/modules/wms/crm/thread';
import { mayWriteThread } from '@/modules/wms/crm/thread-door';

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

  // «Kartaga o'tish» — the ONE link rule (card-door.ts): the real card when
  // it admits this reader, the VED's read-only karta when only the calc door
  // does (14a, 15a), never a link the destination bounces.
  const cardHref = calcCardHref(actor, {
    entityType: row.entityType,
    entityId: row.entityId,
    requestId: row.id,
    leadOwnerId: row.leadOwnerId,
  });
  const closed = Boolean(row.completedAt);
  const ending: CalcEnding | null = endingOf(row);
  const canRecalc = actor.permissions.has('admin.settings.manage');
  // The VED's own note (9a) — this page is `ved.docs`'s, so the sight is
  // always granted here; minted anyway, so the reader keeps its fence.
  const noteSight = internalNoteSight(actor);

  let workspace: Awaited<ReturnType<typeof loadWorkspace>> = null;
  // Phase E1: the cargo this quote turned out to be about. On the same catch
  // as the workspace — 0089 is this release's migration (#472).
  let linked: Awaited<ReturnType<typeof linkedReceipts>> = [];
  // The correction chain this request sits in — what «V2» counts.
  let chain: ChainVersion[] = [];
  // The sealed calculation laid out block by block (0119, audit A39) — the
  // same sheet «Partiya moliyasi» shows the accountant. The page's own door is
  // `ved.docs`, so the registry's sight is always granted here; the VED sees
  // any colleague's calculation, as the registry already lets them.
  const sheetSight = calcRegistrySight(actor);
  let sheet: CalcSheetData | null = null;
  // A closed job with no seal — answered, handed back, closed price-less —
  // shows the goods as the VED left them (10a, review ved-correctness-20):
  // its groups, their law and each item's baza had vanished from view.
  let goodsSheet: CalcGoodsSheet | null = null;
  // Both kinds of price in the chain, for a closed page (ved-correctness-7).
  let links: ChainLink[] = [];
  let internalNote: string | null = null;
  // 16a — «Sotuvchi mijozga aytgan narx», from the projection only.
  let prices: OfferPrice[] = [];
  try {
    [workspace, linked, chain, sheet] = await Promise.all([
      loadWorkspace(id),
      linkedReceipts(id),
      chainOf(id),
      sheetSight ? calcSheetsForRequest(id, sheetSight) : Promise.resolve(null),
    ]);
    // The seller's price is read on an open job too — the VED is pricing the
    // card the seller already quoted on (16a).
    if (offerSightFor(actor).seesOfferPrices) {
      prices = await offerPricesFor(row.entityType as 'deal' | 'lead', row.entityId);
    }
    if (closed) {
      [links, internalNote, goodsSheet] = await Promise.all([
        chainLinksOf(id),
        noteSight && ending === 'answered' ? calcInternalNoteFor(id, noteSight) : Promise.resolve(null),
        sheetSight && !sheet ? requestGoodsSheet(id, sheetSight) : Promise.resolve(null),
      ]);
    }
  } catch (err) {
    if (!isServerBehind(err)) throw err;
    logger.error({ err, id }, '[calc] workspace: server behind');
  }
  // «❓ Savol-javob» (E3 a, E5 a): this calculation's Q&A with the seller —
  // its count for the jump chip and the pulse's baseline, on its OWN catch
  // (the tag is 0127's; a database a release behind keeps the page).
  const tth = await getTranslations('threads');
  const threadRef = { kind: 'calc' as const, id: row.id };
  let threadSummary: { count: number; unread: boolean } | null = null;
  let threadBaseline: string | null = null;
  // The page's own door is `ved.docs`, which implies the calc thread's —
  // asked anyway: the box is drawn by the door, never by the page.
  const threadWriter = await mayWriteThread(actor, threadRef);
  try {
    [threadSummary, threadBaseline] = await Promise.all([
      calcThreadSummary(row.id, actor.id),
      threadToken(threadRef),
    ]);
  } catch (err) {
    if (!isServerBehind(err)) throw err;
    logger.error({ err, id }, '[thread] calc page thread: server behind');
  }

  const endingLabel = (e: CalcEnding) =>
    e === 'sealed'
      ? t('endSealed')
      : e === 'answered'
        ? t('endAnswered')
        : e === 'returned'
          ? t('endReturned')
          : e === 'unpriced_lines'
            ? t('endUnpricedLines')
            : t('endUnpricedTask');

  return (
    <div className="mx-auto max-w-6xl space-y-4">
      <PageHeader
        icon="report"
        // Every calc page is a calc card by construction, and this one is
        // `ved.docs`'s: the lead's name is the job's name (§10).
        title={row.label}
        subtitle={`${row.itemCount} ${t('items')} · ${t('requester')}: ${row.requesterName}`}
        back={{ href: '/hisoblash', label: t('queueTitle') }}
        actions={
          cardHref ? (
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
          {closed && ending ? (
            // The ending NAMED (10a): five ways, with who and when.
            <span className="chip chip-neutral" data-testid="calc-closed" data-ending={ending}>
              {endingLabel(ending)} · {row.completedByName ?? '—'} ·{' '}
              {row.completedAt ? format.dateTime(row.completedAt, { dateStyle: 'short', timeStyle: 'short' }) : ''}
            </span>
          ) : row.assigneeId ? (
            <span className="text-xs text-ink-600">
              {t('takenBy')}: {row.assigneeName ?? '—'}
            </span>
          ) : (
            <span className="chip chip-warn">{t('unassigned')}</span>
          )}
          {threadSummary ? (
            <a
              href="#savol"
              className="chip chip-brand ml-auto"
              data-testid="calc-thread-jump"
              data-unread={threadSummary.unread ? '1' : '0'}
            >
              {tth('calcJump', { n: threadSummary.count })}
              {threadSummary.unread ? <span className="ml-1 text-warn">●</span> : null}
            </a>
          ) : null}
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
          {/* …and the door that answers it. Until this round the checklist
              could only ACCUSE: the request's weight, volume and route came
              from the bot's reading and nowhere else, so a photograph the
              model could not read left a job that could never be priced. */}
          {closed ? null : (
            <CargoFactsForm
              id={id}
              hasFreight={
                row.section ? sectionParts(row.section as CalcSection).freight : true
              }
              initial={{
                fromCity: row.fromCity,
                toCity: row.toCity,
                weightKg: row.weightKg,
                volumeM3: row.volumeM3,
              }}
              incomplete={row.missing.length > 0}
            />
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

      {workspace ? (
        <CalcWorkspace
          workspace={workspace}
          canRecalc={canRecalc}
          viewerId={actor.id}
          chain={chain}
          sealedSheet={sheet && sheetSight ? <CalcSheet data={sheet} sight={sheetSight} /> : null}
        />
      ) : null}

      {/* The workspace's own table renders `calc-items` when it is on screen;
          everywhere else (server behind, yolkira, closed) this read-only
          fallback answers under the SAME testid — one element in the DOM
          either way, because getByTestId is strict-mode. */}
      {goodsSheet && sheetSight && (goodsSheet.groups.length > 0 || goodsSheet.ungrouped.length > 0) ? (
        <Section title={`${t('goods')} · ${row.itemCount}`}>
          <div className="card !p-3">
            <CalcGoodsSheetView data={goodsSheet} sight={sheetSight} />
          </div>
        </Section>
      ) : null}

      {/* The chain, BOTH kinds (review ved-correctness-7): seals with their V
          number, answers as «✍️ umumiy narx». The sealed panel above keeps its
          own V-only list; this is the closed page's whole story. */}
      {closed && links.length > 1 ? (
        <section className="card !p-3" data-testid="calc-chain-links">
          <p className="text-2xs font-semibold text-ink-600">{t('chainTitle')}</p>
          <ul className="mt-1 space-y-1">
            {links.map((link) => (
              <li
                key={`${link.kind}:${link.requestId}:${link.at.getTime()}`}
                className="flex flex-wrap items-center gap-2 text-2xs"
                data-testid="calc-chain-link"
                data-current={link.requestId === id ? '1' : undefined}
              >
                {link.kind === 'sealed' ? (
                  <span className="chip chip-neutral">V{link.quoteNo}</span>
                ) : (
                  <span className="chip chip-warn">{t('answerChip')}</span>
                )}
                {link.requestId === id ? (
                  <span className="font-mono font-semibold tabular-nums">
                    {link.amount.toFixed(2)} {link.currency}
                  </span>
                ) : (
                  <Link href={`/hisoblash/${link.requestId}`} className="font-mono font-semibold tabular-nums text-brand-700">
                    {link.amount.toFixed(2)} {link.currency}
                  </Link>
                )}
                <span className="text-ink-500">
                  {format.dateTime(link.at, { dateStyle: 'short' })} · {link.byName ?? '—'}
                </span>
              </li>
            ))}
          </ul>
        </section>
      ) : null}

      {!(workspace && workspace.parts.customs && !workspace.completedAt) && !goodsSheet ? (
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
            <section className="card !p-3 space-y-1" data-testid="calc-answer">
              <p className="text-sm font-semibold" data-testid="calc-ending">
                {ending ? endingLabel(ending) : null}
                <span className="font-normal text-ink-500">
                  {' · '}
                  {row.completedByName ?? '—'}
                  {row.completedAt
                    ? ` · ${format.dateTime(row.completedAt, { dateStyle: 'short', timeStyle: 'short' })}`
                    : ''}
                </span>
              </p>
              {ending === 'returned' ? (
                <p className="text-sm">
                  <span className="text-ink-500">{t('returned')}:</span> {row.returnReason ?? '—'}
                </p>
              ) : ending === 'answered' ? (
                <>
                  <p className="text-sm">
                    <span className="text-ink-500">{t('answered')}:</span>{' '}
                    <span className="num font-semibold" data-testid="calc-answer-amount-shown">
                      {row.answerAmount} {row.answerCurrency ?? ''}
                    </span>
                  </p>
                  {row.answerNote ? (
                    <p className="whitespace-pre-wrap text-sm" data-testid="calc-answer-seller-note">
                      <span className="text-ink-500">{t('sellerNoteShort')}:</span> {row.answerNote}
                    </p>
                  ) : null}
                  {noteSight ? (
                    <p className="whitespace-pre-wrap text-sm" data-testid="calc-answer-internal-note">
                      <span className="text-ink-500">{t('internalNoteShort')}:</span>{' '}
                      {internalNote ?? t('internalNoteOld')}
                    </p>
                  ) : null}
                  {/* 10a: an answered job is corrected the way a sealed one is. */}
                  {canRecalc ? <RecalcButton id={row.id} /> : null}
                </>
              ) : null}
            </section>
          ) : (
            <section className="card !p-3">
              <CalcActions
                id={row.id}
                mine={row.assigneeId === actor.id}
                assigned={Boolean(row.assigneeId)}
                canSeal={workspace ? canSeal(workspace) : false}
              />
            </section>
          )}
          {/* 16a — what the seller told the customer, on the calc page too. */}
          {prices.length > 0 ? (
            <section className="card !p-3 mt-3">
              <OfferPriceList prices={prices} />
            </section>
          ) : null}
          {/* «❓ Savol-javob» — ONLY this calculation's Q&A (E5 a). The VED's
              question goes to the seller's Telegram; the answer lands here,
              from the card's fold or as a reply in Telegram. The hint warns
              him off the floor: every seller on this thread reads what he
              types (law 4/10, #790), and no screen rule can police text. */}
          <section id="savol" className="card !p-3 mt-3 scroll-mt-20 space-y-2" data-testid="calc-thread">
            <h2 className="text-sm font-bold">{tth('calcTitle')}</h2>
            <CalcThread requestId={row.id} viewerId={actor.id} composer={threadWriter} hint={tth('calcHint')} />
          </section>
        </div>
      </div>
      <ThreadSeen refs={[threadRef]} />
      {threadBaseline !== null ? <ThreadPulse kind="calc" id={row.id} initial={threadBaseline} /> : null}
    </div>
  );
}
