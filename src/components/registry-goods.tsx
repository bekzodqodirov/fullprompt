'use client';

import { useState } from 'react';
import { useTranslations } from 'next-intl';
import type { CalcGoodsItem, CalcGoodsSheet, CalcSheet } from '@/modules/wms/calc/sheet';

/**
 * «Tovarlar ▾» on a history row (the owner's 7a): the full goods list, frozen
 * at the price, fetched on the FIRST open and never before — 200 eager sheets
 * would be ~8 000 hidden nodes on a phone (round 68's /stock).
 *
 * The route (`/api/calc/registry/[id]/goods`) holds the door and the
 * projection; this only draws what came back. A SEALED row shows each group
 * as sealed — code, law, value, VAT and its rastamojka — with its items; an
 * ANSWER shows the request's own goods with their bazas and the group's law,
 * and says in words that it carries no per-group sum (it is one typed figure).
 * A figure the record does not hold prints «—», never $0.
 */
type Loaded =
  | { kind: 'sealed'; sheet: CalcSheet }
  | { kind: 'answer'; sheet: CalcGoodsSheet };

const usd = (n: number | null) => (n === null ? '—' : `$${n.toFixed(2)}`);
const qty = (n: number | null, unit: string | null) =>
  n === null ? null : `${Math.round(n * 1000) / 1000}${unit ? ` ${unit}` : ''}`;

export function RegistryGoods({ requestId, summary }: { requestId: string; summary: string }) {
  const t = useTranslations('calc');
  const tc = useTranslations('common');
  const [state, setState] = useState<'idle' | 'loading' | 'failed' | 'done'>('idle');
  const [data, setData] = useState<Loaded | null>(null);

  const load = async () => {
    if (state === 'loading' || state === 'done') return;
    setState('loading');
    try {
      const res = await fetch(`/api/calc/registry/${requestId}/goods`, { cache: 'no-store' });
      if (!res.ok) throw new Error(String(res.status));
      setData((await res.json()) as Loaded);
      setState('done');
    } catch {
      setState('failed');
    }
  };

  return (
    <details
      className="mt-1 text-xs"
      data-testid="registry-goods"
      onToggle={(event) => {
        if ((event.currentTarget as HTMLDetailsElement).open) void load();
      }}
    >
      <summary className="cursor-pointer text-ink-600" data-testid="registry-goods-summary">
        {summary} ▾
      </summary>
      <div className="mt-1 space-y-1" data-testid="registry-goods-body">
        {state === 'loading' ? <p className="text-ink-500">{tc('loading')}</p> : null}
        {state === 'failed' ? (
          <p className="text-warn" role="alert">
            {t('registryGoodsFailed')}
          </p>
        ) : null}
        {data?.kind === 'sealed' ? (
          data.sheet.groups.length === 0 ? (
            <ul className="space-y-0.5">
              {data.sheet.goods.map((g, i) => (
                <li key={i} className="break-words">
                  {g.name}
                  {[qty(g.kg, 'kg'), qty(g.m3, 'm³')]
                    .filter(Boolean)
                    .map((part) => ` · ${part}`)
                    .join('')}
                </li>
              ))}
            </ul>
          ) : (
            data.sheet.groups.map((g, index) => (
              <div key={index} className="rounded border border-line p-2" data-testid="registry-goods-group">
                <p className="break-words">
                  <b>{g.label}</b>
                  {g.code ? <span className="font-mono"> · {g.code}</span> : null}
                </p>
                <p className="text-ink-600">
                  {t('regGoodsDuty')}: {g.dutyText} · {t('regGoodsVat')}:{' '}
                  {g.vatPct === null ? '—' : `${g.vatPct}%`} · {t('regGoodsValue')}:{' '}
                  <span className="font-mono tabular-nums">{usd(g.valueUsd)}</span> · {t('regGoodsCustoms')}:{' '}
                  <span className="font-mono tabular-nums">{usd(g.customsUsd)}</span>
                </p>
                <ul className="space-y-0.5 text-ink-600">
                  {g.items.map((item, i) => (
                    <li key={i} className="break-words">
                      {item.name}
                      {[
                        qty(item.quantity, item.unit),
                        qty(item.kg, 'kg'),
                        item.bazaUsd === null
                          ? `${t('regGoodsBaza')}: —`
                          : `${t('regGoodsBaza')}: $${item.bazaUsd}${item.basis ? `/${item.basis}` : ''}`,
                      ]
                        .filter(Boolean)
                        .map((part) => ` · ${part}`)
                        .join('')}
                    </li>
                  ))}
                </ul>
              </div>
            ))
          )
        ) : null}
        {data?.kind === 'answer' ? (
          <>
            <p className="text-ink-500" data-testid="registry-goods-no-sum">
              {t('registryAnswerNoGroupSum')}
            </p>
            {data.sheet.groups.map((g, index) => (
              <div key={index} className="rounded border border-dashed border-line p-2" data-testid="registry-goods-group">
                <p className="break-words">
                  <b>{g.label}</b>
                  {g.code ? <span className="font-mono"> · {g.code}</span> : null}
                </p>
                <p className="text-ink-600">
                  {t('regGoodsDuty')}: {g.dutyText} · {t('regGoodsVat')}: {g.vatPct === null ? '—' : `${g.vatPct}%`}
                </p>
                <GoodsItems items={g.items} />
              </div>
            ))}
            {data.sheet.ungrouped.length > 0 ? (
              <div className="rounded border border-dashed border-line p-2">
                <p className="text-ink-500">{t('regGoodsUngrouped')}</p>
                <GoodsItems items={data.sheet.ungrouped} />
              </div>
            ) : null}
          </>
        ) : null}
      </div>
    </details>
  );
}

function GoodsItems({ items }: { items: CalcGoodsItem[] }) {
  const t = useTranslations('calc');
  return (
    <ul className="space-y-0.5 text-ink-600">
      {items.map((item, i) => (
        <li key={i} className="break-words">
          {item.name}
          {[
            item.tnvedCode ?? '—',
            qty(item.quantity, item.unit),
            qty(item.kg, 'kg'),
            item.bazaUsd === null
              ? `${t('regGoodsBaza')}: —`
              : `${t('regGoodsBaza')}: $${item.bazaUsd}${item.basis ? `/${item.basis}` : ''}`,
          ]
            .filter(Boolean)
            .map((part) => ` · ${part}`)
            .join('')}
        </li>
      ))}
    </ul>
  );
}
