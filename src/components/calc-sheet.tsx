import { getTranslations } from 'next-intl/server';
import type { CalcRegistrySight } from '@/modules/wms/calc/control-scope';
import { SECTION_LABELS } from '@/modules/wms/calc/labels';
import type {
  CalcAnswer,
  CalcGoodsItem,
  CalcGoodsSheet,
  CalcSheet as CalcSheetData,
} from '@/modules/wms/calc/sheet';

/**
 * «🧮 Bitim hisobi» drawn — the sealed calculation, block by block (owner's
 * 19). One block per TNVED group, STACKED rather than a table: at 360 px a
 * table of code · baza · duty · VAT · customs is a sideways scroll nobody
 * reads, and every line here wraps on its own.
 *
 * `sight` is REQUIRED and unused at runtime — the proof that the page asked
 * `mayReadCalcRegistry` (`calcRegistrySight`), so a sheet mounted on a
 * seller's screen is a compile error that names itself (law 4).
 *
 * Money is printed as sealed, two decimals, and a figure the snapshot does
 * not have prints «—», never $0.
 */
const usd = (n: number | null) => (n === null ? '—' : `$${n.toFixed(2)}`);
const qty = (n: number | null, unit: string) => (n === null ? null : `${Math.round(n * 1000) / 1000} ${unit}`);
const ddmmyyyy = (d: Date) =>
  d.toLocaleDateString('ru-RU', { timeZone: 'Asia/Tashkent', day: '2-digit', month: '2-digit', year: 'numeric' });

export async function CalcSheet({ data, sight: _sight }: { data: CalcSheetData; sight: CalcRegistrySight }) {
  const t = await getTranslations('calcSheet');
  const tf = await getTranslations('finance');
  const tc = await getTranslations('calc');
  return (
    <div className="space-y-2 text-xs" data-testid="calc-sheet">
      <p className="flex flex-wrap items-center gap-x-2 gap-y-1">
        <b className="font-mono">V{data.quoteNo}</b>
        <span className="chip chip-brand">{tc(SECTION_LABELS[data.section] as 'sections.podklyuch')}</span>
        <span className="text-ink-500">
          {ddmmyyyy(data.sealedAt)} · {t('sealedBy')}: {data.sealedByName ?? '—'}
        </span>
        {data.status === 'recalc_open' ? (
          <span className="chip chip-warn" data-testid="calc-sheet-recalc">
            {tf('calcRecalcOpen')}
          </span>
        ) : data.status === 'superseded' ? (
          // The child's ending in the chain chip's own words (#513): a dead
          // seal says WHAT replaced it, not merely that something did.
          <span className="chip chip-neutral" data-testid="calc-sheet-superseded">
            {data.childState === 'answered'
              ? tc('chainAnswered')
              : data.childState === 'returned'
                ? tc('chainReturned')
                : data.childState === 'unpriced'
                  ? tc('chainUnpriced')
                  : tc('supersededPlain')}
          </span>
        ) : null}
        {data.expired ? <span className="chip chip-warn">{t('expired')}</span> : null}
      </p>

      {data.groups.map((g, index) => (
        <div key={index} className="space-y-1 rounded border border-line p-2" data-testid="calc-sheet-group">
          <p className="break-words">
            <span className="text-ink-500">{t('group')}:</span> <b>{g.label}</b>
            {g.code ? (
              <>
                {' · '}
                <span className="text-ink-500">{t('code')}</span> <span className="font-mono">{g.code}</span>
              </>
            ) : null}
          </p>
          <p className="text-ink-600">
            {t('duty')}: {g.dutyText}
            {' · '}
            {t('vat')}: {g.vatPct === null ? '—' : `${g.vatPct}%`}
            {g.excisePct !== null && g.excisePct > 0 ? ` · ${t('excise')}: ${g.excisePct}%` : ''}
            {g.valueUsd !== null ? ` · ${tc('regGoodsValue')}: ${usd(g.valueUsd)}` : ''}
            {' · '}
            <span className="font-mono tabular-nums">{usd(g.customsUsd)}</span>
          </p>
          {g.items.length > 0 ? (
            <ul className="space-y-0.5 text-ink-600">
              {g.items.map((item, i) => (
                <li key={i} className="break-words">
                  {item.name}
                  {' · '}
                  {t('baza')}: {item.bazaUsd === null ? '—' : `$${item.bazaUsd}`}
                  {item.basis ? `/${item.basis}` : ''}
                  {[
                    qty(item.quantity, item.unit ?? ''),
                    qty(item.kg, 'kg'),
                    qty(item.m3, 'm³'),
                    item.measureUnit && item.measureQty !== null ? `${item.measureQty} ${item.measureUnit}` : null,
                  ]
                    .filter(Boolean)
                    .map((part) => ` · ${part}`)
                    .join('')}
                </li>
              ))}
            </ul>
          ) : null}
        </div>
      ))}

      {/* No groups is the yo'lkira seal's ordinary shape: the goods come from
          the request's own items (#874), never from the snapshot. */}
      {data.groups.length === 0 && data.goods.length > 0 ? (
        <div className="rounded border border-line p-2" data-testid="calc-sheet-goods">
          <p className="text-ink-500">{t('goods')}</p>
          <ul className="space-y-0.5">
            {data.goods.map((g, i) => (
              <li key={i} className="break-words">
                {g.name}
                {[qty(g.kg, 'kg'), qty(g.m3, 'm³')]
                  .filter(Boolean)
                  .map((part) => ` · ${part}`)
                  .join('')}
              </li>
            ))}
          </ul>
        </div>
      ) : null}

      <dl className="grid grid-cols-[auto_1fr] gap-x-3 gap-y-0.5">
        {data.feeUsd !== null ? (
          <>
            <dt className="text-ink-500">{t('fee')}</dt>
            <dd className="font-mono tabular-nums">{usd(data.feeUsd)}</dd>
          </>
        ) : null}
        {data.freight ? (
          <>
            <dt className="text-ink-500">{t('freight')}</dt>
            <dd className="break-words">
              {t('zone')}: {data.freight.zone ?? '—'}
              {data.freight.bandMin !== null ? ` · ${t('band')}: ≥${data.freight.bandMin}` : ''}
              {data.freight.rate !== null
                ? ` · ${t('rate')}: $${data.freight.rate}/${data.freight.perKg ? 'kg' : 'm³'}`
                : ''}
              {' · '}
              {t('listPrice')}: <span className="font-mono tabular-nums">{usd(data.freight.listUsd)}</span>
            </dd>
          </>
        ) : null}
        {data.discountUsd > 0 ? (
          <>
            <dt className="text-warn">{t('discount')}</dt>
            <dd className="font-mono tabular-nums text-warn">−{usd(data.discountUsd)}</dd>
          </>
        ) : null}
        {data.extrasUsd > 0 ? (
          <>
            <dt className="text-ink-500">{t('extras')}</dt>
            <dd className="font-mono tabular-nums">{usd(data.extrasUsd)}</dd>
          </>
        ) : null}
        <dt className="font-semibold">{t('total')}</dt>
        <dd className="font-mono font-semibold tabular-nums" data-testid="calc-sheet-total">
          {usd(data.totalUsd)}
        </dd>
        {data.perM3Usd !== null || data.perKgUsd !== null ? (
          <>
            <dt />
            <dd className="font-mono tabular-nums text-ink-500">
              {[
                data.perM3Usd !== null ? `$${data.perM3Usd.toFixed(2)} ${t('perM3')}` : null,
                data.perKgUsd !== null ? `$${data.perKgUsd.toFixed(4)} ${t('perKg')}` : null,
              ]
                .filter(Boolean)
                .join(' · ')}
            </dd>
          </>
        ) : null}
        <dt className="text-ink-500">{t('validUntil')}</dt>
        <dd>{ddmmyyyy(data.validUntil)}</dd>
      </dl>

      {data.previous.length > 0 ? (
        <ul className="space-y-0.5 border-t border-line pt-1 text-ink-500" data-testid="calc-sheet-previous">
          {data.previous.map((p) => (
            <li key={p.quoteNo}>
              {tf('calcPrevVersion', { n: p.quoteNo })} · {ddmmyyyy(p.sealedAt)} ·{' '}
              <span className="font-mono tabular-nums">{usd(p.totalUsd)}</span>
            </li>
          ))}
        </ul>
      ) : null}
    </div>
  );
}

/**
 * A Готово answer (owner's 27a): a price the VED gave without sealing it,
 * shown in its own currency and marked «muhrlanmagan» — it is a word, not a
 * locked document.
 */
export async function CalcAnswers({ answers, sight: _sight }: { answers: CalcAnswer[]; sight: CalcRegistrySight }) {
  if (answers.length === 0) return null;
  const tf = await getTranslations('finance');
  const tc = await getTranslations('calc');
  return (
    <ul className="space-y-1 text-xs" data-testid="calc-answers">
      {answers.map((a) => (
        <li key={a.requestId} className="break-words rounded border border-dashed border-line p-2" data-testid="calc-answer">
          <span className="chip chip-warn">{tf('calcUnsealed')}</span>{' '}
          {a.section ? <span className="chip chip-brand">{tc(SECTION_LABELS[a.section] as 'sections.podklyuch')}</span> : null}{' '}
          {/* A correction off this answer, in the chain chip's words: the
              seller's push said «eski narx endi amal qilmaydi» at the press,
              and the sheet must not print the answer as if it stood. */}
          {a.childState === 'open' ? (
            <span className="chip chip-warn" data-testid="calc-answer-recalc">{tf('calcRecalcOpen')}</span>
          ) : a.childState === 'answered' ? (
            <span className="chip chip-neutral">{tc('chainAnswered')}</span>
          ) : a.childState === 'returned' ? (
            <span className="chip chip-warn">{tc('chainReturned')}</span>
          ) : a.childState === 'unpriced' ? (
            <span className="chip chip-warn">{tc('chainUnpriced')}</span>
          ) : null}{' '}
          <b className="font-mono tabular-nums">
            {a.amount.toFixed(2)} {a.currency ?? ''}
          </b>
          <span className="text-ink-500">
            {' · '}
            {ddmmyyyy(a.completedAt)} · {a.byName ?? '—'}
          </span>
          {a.note ? <p className="mt-0.5 whitespace-pre-wrap text-ink-600">{a.note}</p> : null}
        </li>
      ))}
    </ul>
  );
}

/**
 * The goods of a closed job that has no sealed snapshot — a Готово answer or
 * a hand-back (10a's closed page) — frozen as the VED left them: each group's
 * code and law, each item's own baza. NO per-group rastamojka (review
 * ved-correctness-14): that would be a draft figure nobody sealed or gave,
 * and the sheet says so in words.
 */
export async function CalcGoodsSheetView({
  data,
  sight: _sight,
}: {
  data: CalcGoodsSheet;
  sight: CalcRegistrySight;
}) {
  const t = await getTranslations('calcSheet');
  const tc = await getTranslations('calc');
  const line = (item: CalcGoodsItem) =>
    [
      item.tnvedCode ?? '—',
      qty(item.quantity, item.unit ?? ''),
      qty(item.kg, 'kg'),
      qty(item.m3, 'm³'),
      item.measureUnit && item.measureQty !== null ? `${item.measureQty} ${item.measureUnit}` : null,
      `${t('baza')}: ${item.bazaUsd === null ? '—' : `$${item.bazaUsd}`}${item.basis ? `/${item.basis}` : ''}`,
    ]
      .filter(Boolean)
      .map((part) => ` · ${part}`)
      .join('');
  return (
    <div className="space-y-2 text-xs" data-testid="calc-goods-sheet">
      <p className="text-ink-500">{tc('registryAnswerNoGroupSum')}</p>
      {data.groups.map((g, index) => (
        <div key={index} className="space-y-1 rounded border border-dashed border-line p-2" data-testid="calc-goods-group">
          <p className="break-words">
            <span className="text-ink-500">{t('group')}:</span> <b>{g.label}</b>
            {g.code ? (
              <>
                {' · '}
                <span className="text-ink-500">{t('code')}</span> <span className="font-mono">{g.code}</span>
              </>
            ) : null}
          </p>
          <p className="text-ink-600">
            {t('duty')}: {g.dutyText} · {t('vat')}: {g.vatPct === null ? '—' : `${g.vatPct}%`}
          </p>
          <ul className="space-y-0.5 text-ink-600">
            {g.items.map((item, i) => (
              <li key={i} className="break-words">
                {item.name}
                {line(item)}
              </li>
            ))}
          </ul>
        </div>
      ))}
      {data.ungrouped.length > 0 ? (
        <div className="space-y-1 rounded border border-dashed border-line p-2" data-testid="calc-goods-ungrouped">
          <p className="text-ink-500">{tc('regGoodsUngrouped')}</p>
          <ul className="space-y-0.5 text-ink-600">
            {data.ungrouped.map((item, i) => (
              <li key={i} className="break-words">
                {item.name}
                {line(item)}
              </li>
            ))}
          </ul>
        </div>
      ) : null}
    </div>
  );
}
