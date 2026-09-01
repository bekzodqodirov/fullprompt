'use client';

import { useState, useTransition } from 'react';
import { useRouter } from 'next/navigation';
import { useTranslations } from 'next-intl';
import { sectionParts } from '@/modules/wms/calc/pricing';
import type { Workspace } from '@/modules/wms/calc/workspace';
import {
  deleteExtraAction,
  saveExtraAction,
  sealAction,
  setZoneAction,
  type CalcFormState,
} from '../actions';
import { ItemsTable } from './items-table';

/**
 * The calculation itself — the screen that replaces the Excel.
 *
 * Two things about it are load-bearing rather than cosmetic.
 *
 * A cell whose value could not be worked out shows ⚠ and the reason, NEVER
 * `$0`. A zero here is a claim about a customer's customs bill, and `#533`'s
 * «≈ $0 ⚠» exists for a known zero — this is an unknown one, and the two must
 * not look alike.
 *
 * And the rates ride on a SECOND muted line under each group rather than
 * widening the first (round 88's answer to the same problem on the scanner):
 * at the width this table has, goods · code · baza · measures · customs
 * already truncates, and six more numbers on that row would leave the goods
 * name nothing at all.
 */
export function CalcWorkspace({
  workspace,
  canRecalc,
}: {
  workspace: Workspace;
  canRecalc: boolean;
}) {
  const t = useTranslations('calc');
  const router = useRouter();
  const [pending, startTransition] = useTransition();
  const [error, setError] = useState<string | null>(null);
  // The table's unsaved-draft count. While it is non-zero the SEAL waits —
  // a locked, client-facing price must not be computed from cells the server
  // has never seen (the phase-2 judge's blocker).
  const [dirty, setDirty] = useState(0);

  const id = workspace.requestId;
  const sealed = workspace.sealedVersion;
  const locked = Boolean(workspace.completedAt);

  const settle = (result: CalcFormState) => {
    setError(result.error ?? null);
    if (!result.error) router.refresh();
  };
  const act = (work: () => Promise<CalcFormState>) => startTransition(async () => settle(await work()));

  return (
    <div className="space-y-3" data-testid="calc-workspace">
      {error ? (
        <p className="chip chip-warn" data-testid="calc-ws-error">
          {t.has(`errors.${error}`) ? t(`errors.${error}` as 'errors.not_ready') : error}
        </p>
      ) : null}

      {sealed ? <SealedPanel sealed={sealed} id={id} canRecalc={canRecalc} /> : null}

      {!locked ? (
        <>
          {workspace.parts.customs ? (
            <ItemsTable workspace={workspace} pending={pending} act={act} onDirty={setDirty} />
          ) : null}

          <FreightPanel workspace={workspace} pending={pending} act={act} />
          <ExtrasPanel workspace={workspace} pending={pending} act={act} />
          <TotalsPanel workspace={workspace} />
          <SealPanel workspace={workspace} pending={pending} act={act} dirty={dirty} />
        </>
      ) : null}

    </div>
  );
}

/* -------------------------------------------------------------- freight */

function FreightPanel({
  workspace,
  pending,
  act,
}: {
  workspace: Workspace;
  pending: boolean;
  act: (work: () => Promise<CalcFormState>) => void;
}) {
  const t = useTranslations('calc');
  if (!workspace.parts.freight) return null;
  const freight = workspace.freight;

  return (
    <section className="card !p-3" data-testid="calc-freight">
      <h3 className="section-title">{t('freight')}</h3>
      <div className="mt-2 space-y-2">
        <label className="block text-sm">
          <span className="label">{t('zone')}</span>
          <select
            className="input"
            aria-label={t('zone')}
            data-testid="calc-zone"
            defaultValue={workspace.freightZone ?? ''}
            disabled={pending}
            onChange={(e) => act(() => setZoneAction(workspace.requestId, e.target.value))}
          >
            <option value="">— {t('zonePick')} —</option>
            {workspace.zones.map((zone) => (
              <option key={zone} value={zone}>
                {t.has(`zones.${zone}`) ? t(`zones.${zone}` as 'zones.cn') : zone}
              </option>
            ))}
          </select>
          {/* The city OFFERS an answer; the picker demands one. Nothing here
              decides a 36-58 % price difference from free text. */}
          {workspace.freightZone === null && workspace.guessedZone ? (
            <span className="text-2xs text-ink-500" data-testid="calc-zone-hint">
              {workspace.fromCity} →{' '}
              {t.has(`zones.${workspace.guessedZone}`)
                ? t(`zones.${workspace.guessedZone}` as 'zones.cn')
                : workspace.guessedZone}
              ?
            </span>
          ) : null}
        </label>

        <dl className="grid grid-cols-2 gap-x-3 gap-y-1 text-sm">
          <dt className="text-ink-500">{t('density')}</dt>
          <dd className="font-mono tabular-nums" data-testid="calc-density">
            {workspace.density === null ? '—' : `${Math.round(workspace.density)} kg/m³`}
          </dd>
          <dt className="text-ink-500">{t('freightList')}</dt>
          <dd className="font-mono tabular-nums" data-testid="calc-freight-price">
            {freight?.ok ? (
              <>
                {`$${freight.listUsd.toFixed(2)}`}
                {/* Law 8's second half: no minimum charge exists, so a tiny
                    invoice must at least SAY it is tiny. */}
                {freight.small ? (
                  <span className="chip chip-warn ml-1" data-testid="calc-freight-small">
                    ⚠ {t('freightSmall')}
                  </span>
                ) : null}
              </>
            ) : (
              <span className="text-warn">
                ⚠ {freight ? refusal(t, freight.reason) : refusal(t, 'zone_required')}
              </span>
            )}
          </dd>
          {freight?.ok ? (
            <>
              <dt className="text-ink-500">{t('band')}</dt>
              <dd className="font-mono tabular-nums" data-testid="calc-band">
                {freight.band.minDensity}
                {freight.band.maxDensity === null ? '+' : `–${freight.band.maxDensity}`} ·{' '}
                {freight.band.priceUsd} $/{freight.band.perKg ? 'kg' : 'm³'}
              </dd>
            </>
          ) : null}
        </dl>
      </div>
    </section>
  );
}

/* --------------------------------------------------------------- groups */

/* --------------------------------------------------------------- extras */

function ExtrasPanel({
  workspace,
  pending,
  act,
}: {
  workspace: Workspace;
  pending: boolean;
  act: (work: () => Promise<CalcFormState>) => void;
}) {
  const t = useTranslations('calc');
  const tc = useTranslations('common');
  const [label, setLabel] = useState('');
  const [amount, setAmount] = useState('');
  const [costTypeId, setCostTypeId] = useState('');
  const id = workspace.requestId;

  return (
    <section className="card !p-3" data-testid="calc-extras">
      <h3 className="section-title">{t('extras')}</h3>
      <ul className="mt-1 space-y-1">
        {workspace.extras.map((extra) => (
          <li key={extra.id} className="flex items-center gap-2 text-sm">
            <span className="grow">{extra.label}</span>
            <span className="font-mono tabular-nums">${extra.amountUsd.toFixed(2)}</span>
            <button
              type="button"
              className="btn-secondary"
              disabled={pending}
              data-testid="calc-delete-extra"
              onClick={() => act(() => deleteExtraAction(id, extra.id))}
            >
              🗑
            </button>
          </li>
        ))}
        {workspace.extras.length === 0 ? <li className="text-sm text-ink-500">—</li> : null}
      </ul>

      <div className="mt-2 flex flex-wrap items-end gap-2">
        {/* Pointed at the EXISTING cost-type dictionary, so phase E's
            calc-vs-actual compares like with like. */}
        <select
          className="input input-sm !w-40"
          aria-label={t('costType')}
          data-testid="calc-extra-type"
          value={costTypeId}
          onChange={(e) => {
            setCostTypeId(e.target.value);
            const name = workspace.costTypeOptions.find((c) => c.id === e.target.value)?.name;
            if (name && !label.trim()) setLabel(name);
          }}
        >
          <option value="">—</option>
          {workspace.costTypeOptions.map((c) => (
            <option key={c.id} value={c.id}>
              {c.name}
            </option>
          ))}
        </select>
        <input
          className="input input-sm !w-40"
          placeholder={t('extraLabel')}
          aria-label={t('extraLabel')}
          data-testid="calc-extra-label"
          value={label}
          onChange={(e) => setLabel(e.target.value)}
        />
        <input
          className="input input-sm !w-24 font-mono tabular-nums"
          placeholder="$"
          aria-label={t('amount')}
          data-testid="calc-extra-amount"
          value={amount}
          onChange={(e) => setAmount(e.target.value)}
        />
        <button
          type="button"
          className="btn-secondary"
          disabled={pending || !label.trim() || amount.trim() === ''}
          data-testid="calc-add-extra"
          onClick={() =>
            act(async () => {
              const result = await saveExtraAction(id, {
                costTypeId,
                label,
                amountUsd: Number(amount.replace(',', '.')),
                note: '',
              });
              if (!result.error) {
                setLabel('');
                setAmount('');
                setCostTypeId('');
              }
              return result;
            })
          }
        >
          {tc('save')}
        </button>
      </div>
    </section>
  );
}

/* --------------------------------------------------------------- totals */

function TotalsPanel({ workspace }: { workspace: Workspace }) {
  const t = useTranslations('calc');
  const totals = workspace.totals;

  return (
    <section className="card !p-3" data-testid="calc-totals">
      <h3 className="section-title">{t('totals')}</h3>
      {totals?.ok ? (
        <dl className="mt-1 grid grid-cols-2 gap-x-3 gap-y-1 text-sm">
          {/* His law 5: rastamojka and yo'lkira are always on their own
              lines, whatever the one number at the bottom says. */}
          {workspace.parts.customs ? (
            <>
              <dt className="text-ink-500">{t('customs')}</dt>
              <dd className="font-mono tabular-nums" data-testid="calc-total-customs">
                ${totals.customsUsd.toFixed(2)}
              </dd>
              {/* The VMQ-55 declaration fee is INSIDE the customs figure —
                  this line is its receipt, so the VED can check the tier. */}
              {workspace.fee?.ok ? (
                <>
                  <dt className="text-ink-500 pl-2">{t('feeLine')}</dt>
                  <dd className="font-mono tabular-nums text-ink-600" data-testid="calc-total-fee">
                    {workspace.fee.overridden
                      ? `$${workspace.fee.feeUsd.toFixed(2)} ✎`
                      : `${workspace.fee.bhmCoefficient} BHM ≈ $${workspace.fee.feeUsd.toFixed(2)}`}
                  </dd>
                </>
              ) : null}
            </>
          ) : null}
          {workspace.parts.freight ? (
            <>
              <dt className="text-ink-500">{t('freight')}</dt>
              <dd className="font-mono tabular-nums" data-testid="calc-total-freight">
                ${totals.freightUsd.toFixed(2)}
              </dd>
            </>
          ) : null}
          <dt className="text-ink-500">{t('extras')}</dt>
          <dd className="font-mono tabular-nums">${totals.extrasUsd.toFixed(2)}</dd>
          <dt className="font-semibold">{t('total')}</dt>
          <dd className="font-mono tabular-nums font-semibold" data-testid="calc-total">
            ${totals.totalUsd.toFixed(2)}
          </dd>
          <dt className="text-ink-500">$/m³</dt>
          <dd className="font-mono tabular-nums" data-testid="calc-per-m3">
            {totals.perM3Usd === null ? '—' : `$${totals.perM3Usd.toFixed(2)}`}
          </dd>
          <dt className="text-ink-500">$/kg</dt>
          <dd className="font-mono tabular-nums">
            {totals.perKgUsd === null ? '—' : `$${totals.perKgUsd.toFixed(4)}`}
          </dd>
        </dl>
      ) : (
        <p className="mt-1 text-sm text-warn" data-testid="calc-total-blocked">
          ⚠ {t('notReady')}
        </p>
      )}
    </section>
  );
}

/* ----------------------------------------------------------------- seal */

function SealPanel({
  workspace,
  pending,
  act,
  dirty,
}: {
  workspace: Workspace;
  pending: boolean;
  act: (work: () => Promise<CalcFormState>) => void;
  /** Unsaved table drafts. A seal over them locks a price computed from
   * cells the server has never seen — «Avval saqlang» instead. */
  dirty: number;
}) {
  const t = useTranslations('calc');
  const [discount, setDiscount] = useState('');
  const [discountReason, setDiscountReason] = useState('');
  const [override, setOverride] = useState('');
  const [overrideReason, setOverrideReason] = useState('');
  const id = workspace.requestId;

  return (
    <section className="card !p-3" data-testid="calc-seal">
      <h3 className="section-title">{t('seal')}</h3>

      {workspace.blockers.length > 0 ? (
        <ul className="mt-1 space-y-0.5 text-2xs text-warn" data-testid="calc-blockers">
          {workspace.blockers.map((b, i) => (
            <li key={i}>⚠ {blockerText(t, b)}</li>
          ))}
        </ul>
      ) : null}

      <details className="mt-2">
        <summary className="cursor-pointer text-2xs text-ink-600">{t('concessions')}</summary>
        <div className="mt-2 space-y-2">
          {/* Two different things, deliberately two different boxes: a band
              override is a statement about the CARGO, a discount is a
              concession to this CLIENT — and only the second one costs the
              seller the right to upsell (phase D). */}
          <div className="flex flex-wrap items-end gap-2">
            <label className="text-2xs">
              <span className="label">{t('bandOverride')} kg/m³</span>
              <input
                className="input input-sm !w-24 font-mono tabular-nums"
                data-testid="calc-band-override"
                value={override}
                onChange={(e) => setOverride(e.target.value)}
              />
            </label>
            <label className="grow text-2xs">
              <span className="label">{t('reason')}</span>
              <input
                className="input input-sm"
                data-testid="calc-band-reason"
                value={overrideReason}
                onChange={(e) => setOverrideReason(e.target.value)}
              />
            </label>
          </div>
          <div className="flex flex-wrap items-end gap-2">
            <label className="text-2xs">
              <span className="label">{t('discount')} $</span>
              <input
                className="input input-sm !w-24 font-mono tabular-nums"
                data-testid="calc-discount"
                value={discount}
                onChange={(e) => setDiscount(e.target.value)}
              />
            </label>
            <label className="grow text-2xs">
              <span className="label">{t('reason')}</span>
              <input
                className="input input-sm"
                data-testid="calc-discount-reason"
                value={discountReason}
                onChange={(e) => setDiscountReason(e.target.value)}
              />
            </label>
          </div>
          <p className="text-2xs text-ink-500">{t('concessionNotice')}</p>
        </div>
      </details>

      <button
        type="button"
        className="btn-primary mt-2"
        disabled={pending || dirty > 0 || workspace.blockers.length > 0}
        data-testid="calc-do-seal"
        onClick={() =>
          act(() =>
            sealAction(id, {
              discountUsd: discount.trim() === '' ? 0 : Number(discount.replace(',', '.')),
              discountReason,
              bandOverrideMin: override.trim() === '' ? null : Number(override.replace(',', '.')),
              bandOverrideReason: overrideReason,
            }),
          )
        }
      >
        🔒 {t('seal')}
      </button>
      {dirty > 0 ? (
        <p className="mt-1 text-2xs text-warn" data-testid="calc-seal-unsaved">
          {t('table.saveFirst', { count: dirty })}
        </p>
      ) : null}
    </section>
  );
}

function SealedPanel({
  sealed,
  id,
  canRecalc,
}: {
  sealed: NonNullable<Workspace['sealedVersion']>;
  id: string;
  canRecalc: boolean;
}) {
  const t = useTranslations('calc');
  const router = useRouter();
  const [pending, startTransition] = useTransition();
  // The sealed version carries its own section, so the panel reads what the
  // quote WAS, never what the request happens to say now.
  const parts = sectionParts(sealed.section);

  return (
    <section className="card !p-3" data-testid="calc-sealed">
      <div className="flex flex-wrap items-center gap-2">
        <span className="chip chip-neutral">v{sealed.versionNo}</span>
        {/* Expiry is decided when the price is READ, so nothing has to run
            overnight for a quote to go stale. */}
        {sealed.expired ? (
          <span className="chip chip-warn" data-testid="calc-expired">
            {t('expired')}
          </span>
        ) : null}
      </div>
      <p className="mt-1 font-mono tabular-nums text-lg font-semibold" data-testid="calc-sealed-total">
        ${sealed.totalUsd.toFixed(2)}
      </p>
      <dl className="mt-1 grid grid-cols-2 gap-x-3 gap-y-1 text-2xs">
        {/* A rastamojka quote has no freight line — it does not have a freight
            line that happens to be zero. Printing «Yo'lkira $0.00» on the
            sealed sheet says the road was free, which is a different claim
            and the one the client would read. */}
        {parts.customs ? (
          <>
            <dt className="text-ink-500">{t('customs')}</dt>
            <dd className="font-mono tabular-nums">${sealed.customsUsd.toFixed(2)}</dd>
          </>
        ) : null}
        {parts.freight ? (
          <>
            <dt className="text-ink-500">{t('freight')}</dt>
            <dd className="font-mono tabular-nums">${sealed.freightUsd.toFixed(2)}</dd>
          </>
        ) : null}
        <dt className="text-ink-500">{t('extras')}</dt>
        <dd className="font-mono tabular-nums">${sealed.extrasUsd.toFixed(2)}</dd>
        {sealed.discountUsd > 0 ? (
          <>
            <dt className="text-warn">{t('discount')}</dt>
            <dd className="font-mono tabular-nums text-warn" data-testid="calc-sealed-discount">
              −${sealed.discountUsd.toFixed(2)} · {sealed.discountReason ?? '—'}
            </dd>
          </>
        ) : null}
        {sealed.bandOverrideMin !== null ? (
          <>
            <dt className="text-warn">{t('bandOverride')}</dt>
            <dd className="text-warn">
              {sealed.bandOverrideMin} kg/m³ · {sealed.bandOverrideReason ?? '—'}
            </dd>
          </>
        ) : null}
        <dt className="text-ink-500">$/m³</dt>
        <dd className="font-mono tabular-nums">
          {sealed.perM3Usd === null ? '—' : `$${sealed.perM3Usd.toFixed(2)}`}
        </dd>
        <dt className="text-ink-500">{t('validUntil')}</dt>
        <dd>{sealed.validUntil.toLocaleDateString('ru-RU')}</dd>
      </dl>

      {canRecalc ? (
        <button
          type="button"
          className="btn-secondary mt-2"
          disabled={pending}
          data-testid="calc-recalc"
          onClick={() =>
            startTransition(async () => {
              const result = await recalcActionClient(id);
              if (result.newId) router.push(`/hisoblash/${result.newId}`);
            })
          }
        >
          {t('recalc')}
        </button>
      ) : null}
    </section>
  );
}

/** A thin wrapper so the panel can stay a component and the action a module. */
async function recalcActionClient(id: string) {
  const { recalcAction } = await import('../actions');
  return recalcAction(id);
}

/* ---------------------------------------------------------------- words */

type T = ReturnType<typeof useTranslations<'calc'>>;

function refusal(t: T, reason: string): string {
  return t.has(`refusals.${reason}`) ? t(`refusals.${reason}` as 'refusals.band_missing') : reason;
}

function blockerText(t: T, b: Workspace['blockers'][number]): string {
  switch (b.kind) {
    case 'customs':
      return `${b.groupLabel}: ${refusal(t, b.reason)}${b.itemLabel ? ` (${b.itemLabel})` : ''}`;
    case 'freight':
      return `${t('freight')}: ${refusal(t, b.reason)}`;
    case 'fee':
      // The reason's own text names the fee — no prefix needed.
      return refusal(t, b.reason);
    case 'totals':
      return refusal(t, b.reason);
    case 'ungrouped_items':
      return `${t('ungrouped')}: ${b.count}`;
    case 'groups_unconfirmed':
      return `${t('unconfirmed')}: ${b.count}`;
    default:
      return t.has(`blockers.${b.kind}`) ? t(`blockers.${b.kind}` as 'blockers.no_groups') : b.kind;
  }
}
