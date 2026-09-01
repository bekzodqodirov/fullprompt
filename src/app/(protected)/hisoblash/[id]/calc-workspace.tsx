'use client';

import { useState, useTransition } from 'react';
import { useRouter } from 'next/navigation';
import { useTranslations } from 'next-intl';
import { sectionParts } from '@/modules/wms/calc/pricing';
import type { Workspace, WorkspaceGroup, WorkspaceItem } from '@/modules/wms/calc/workspace';
import {
  confirmAllAction,
  confirmGroupAction,
  createGroupAction,
  deleteExtraAction,
  deleteGroupAction,
  moveItemAction,
  proposeAction,
  pullBazasAction,
  saveRatesAction,
  pullRatesAction,
  saveExtraAction,
  sealAction,
  setBazaAction,
  setCertificateAction,
  setRatesAction,
  setZoneAction,
  type CalcFormState,
} from '../actions';

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
          <FreightPanel workspace={workspace} pending={pending} act={act} />

          {workspace.parts.customs ? (
            <GroupsPanel workspace={workspace} pending={pending} act={act} />
          ) : null}

          <ExtrasPanel workspace={workspace} pending={pending} act={act} />
          <TotalsPanel workspace={workspace} />
          <SealPanel workspace={workspace} pending={pending} act={act} />
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

function GroupsPanel({
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
  const [newLabel, setNewLabel] = useState('');
  const id = workspace.requestId;
  const unconfirmed = workspace.groups.filter((g) => g.confirmedAt === null).length;

  return (
    <section className="card !p-3" data-testid="calc-groups">
      {/* The certificate flips the whole calculation: without one, BK 300-1's
          additional duty (5-20 % of BQ by the code's advalor band) lands on
          every group that inherits the request's answer — and the flip clears
          those groups' ✅, because the person confirmed different numbers. */}
      <label className="mb-2 flex items-center gap-2 text-sm">
        <input
          type="checkbox"
          checked={workspace.hasCertificate}
          data-testid="calc-certificate"
          disabled={pending}
          onChange={(e) => act(() => setCertificateAction(id, e.target.checked))}
        />
        <span>{t('certificate')}</span>
        {!workspace.hasCertificate ? (
          <span className="chip chip-warn" data-testid="calc-certificate-warn">
            ⚠ {t('certificateMissing')}
          </span>
        ) : null}
      </label>
      <div className="flex flex-wrap items-center justify-between gap-2">
        <h3 className="section-title">{t('groups')}</h3>
        <div className="flex flex-wrap items-center gap-2">
          <button
            type="button"
            className="btn-secondary"
            disabled={pending}
            data-testid="calc-propose"
            onClick={() => act(() => proposeAction(id))}
          >
            ✨ {t('propose')}
          </button>
          <button
            type="button"
            className="btn-secondary"
            disabled={pending}
            data-testid="calc-pull-bazas"
            onClick={() => act(() => pullBazasAction(id))}
          >
            {t('pullBazas')}
          </button>
          {unconfirmed > 0 ? (
            <button
              type="button"
              className="btn-secondary"
              disabled={pending}
              data-testid="calc-confirm-all"
              onClick={() => act(() => confirmAllAction(id))}
            >
              {t('confirmAll')} ({unconfirmed})
            </button>
          ) : null}
        </div>
      </div>

      {/* Three columns, and the measures on the muted line below.
          Measured: with the quantity, the kilos and the cubes on the primary
          row the table needs 40rem, and the main column is 490 px at 1280 —
          so the CUSTOMS figure, the one number the whole screen exists to
          produce, sat off the right edge on the widest screen the company
          owns and could only be reached by scrolling inside the box. */}
      <div className="table-wrap mt-2 overflow-x-auto">
        <table className="w-full min-w-[22rem] text-sm">
          <thead>
            <tr className="border-b border-line text-left text-2xs uppercase text-ink-500">
              <th className="p-2">{t('group')}</th>
              <th className="p-2">TNVED</th>
              <th className="p-2 text-right">{t('customs')}</th>
              <th className="p-2" />
            </tr>
          </thead>
          <tbody>
            {workspace.groups.map((group) => (
              <GroupRows key={group.id} id={id} group={group} pending={pending} act={act} />
            ))}
            {workspace.groups.length === 0 ? (
              <tr>
                <td className="p-2 text-ink-500" colSpan={4}>
                  —
                </td>
              </tr>
            ) : null}
          </tbody>
        </table>
      </div>

      <div className="mt-2 flex flex-wrap items-center gap-2">
        <input
          className="input input-sm max-!w-48"
          placeholder={t('newGroup')}
          aria-label={t('newGroup')}
          data-testid="calc-new-group"
          value={newLabel}
          onChange={(e) => setNewLabel(e.target.value)}
        />
        <button
          type="button"
          className="btn-secondary"
          disabled={pending || !newLabel.trim()}
          data-testid="calc-add-group"
          onClick={() =>
            act(async () => {
              const result = await createGroupAction(id, newLabel);
              if (!result.error) setNewLabel('');
              return result;
            })
          }
        >
          {tc('save')}
        </button>
      </div>

      {workspace.ungrouped.length > 0 ? (
        <div className="mt-3 border-t border-line pt-2" data-testid="calc-ungrouped">
          <p className="text-sm text-warn">
            ⚠ {t('ungrouped')}: {workspace.ungrouped.length}
          </p>
          <ul className="mt-1 space-y-1">
            {workspace.ungrouped.map((item) => (
              <li key={item.seq} className="flex flex-wrap items-center gap-2 text-sm">
                <span className="grow">{item.label}</span>
                <ItemBaza id={id} item={item} pending={pending} act={act} />
                <GroupPicker id={id} item={item} groups={workspace.groups} pending={pending} act={act} />
              </li>
            ))}
          </ul>
        </div>
      ) : null}

      {workspace.reconcile.mismatch ? (
        <p className="mt-2 text-2xs text-warn" data-testid="calc-reconcile">
          ⚠ {t('reconcile', {
            groupKg: workspace.reconcile.groupKg ?? 0,
            groupM3: workspace.reconcile.groupM3 ?? 0,
            kg: workspace.weightKg ?? 0,
            m3: workspace.volumeM3 ?? 0,
          })}
        </p>
      ) : null}
    </section>
  );
}

function GroupRows({
  id,
  group,
  pending,
  act,
}: {
  id: string;
  group: WorkspaceGroup;
  pending: boolean;
  act: (work: () => Promise<CalcFormState>) => void;
}) {
  const t = useTranslations('calc');
  const tc = useTranslations('common');
  const [open, setOpen] = useState(false);
  const [label, setLabel] = useState(group.label);
  const [code, setCode] = useState(group.tnvedCode ?? '');
  const [duty, setDuty] = useState(group.dutyPct === null ? '' : String(group.dutyPct));
  const [vat, setVat] = useState(group.vatPct === null ? '' : String(group.vatPct));
  const [fee, setFee] = useState(group.feeUsd === null ? '' : String(group.feeUsd));
  const [dutyFree, setDutyFree] = useState(group.dutyFree);
  const [vatFree, setVatFree] = useState(group.vatFree);

  const num = (v: string) => (v.trim() === '' ? null : Number(v.replace(',', '.')));

  return (
    <>
      <tr className="border-b border-line/60 align-top" data-testid="calc-group-row">
        <td className="p-2">
          <span className="font-semibold">{group.label}</span>
          {group.aiProposed && group.confirmedAt === null ? (
            <span className="ml-1 chip chip-warn" data-testid="calc-group-ai">
              ✨ {group.aiConfidence ?? '—'}
            </span>
          ) : null}
          {group.confirmedAt ? (
            <span className="ml-1 text-2xs text-good" data-testid="calc-group-ok">
              ✅
            </span>
          ) : null}
          <span className="block text-2xs text-ink-500">
            {group.items.length} {t('items')}
          </span>
        </td>
        <td className="p-2 font-mono tabular-nums">{group.tnvedCode ?? '—'}</td>
        <td className="p-2 text-right font-mono tabular-nums" data-testid="calc-group-customs">
          {group.customs.ok ? (
            `$${group.customs.customsUsd.toFixed(2)}`
          ) : (
            <span className="text-warn">
              ⚠ {refusal(t, group.customs.reason)}
              {group.customs.itemLabel ? `: ${group.customs.itemLabel}` : ''}
            </span>
          )}
        </td>
        <td className="p-2 text-right">
          <button
            type="button"
            className="btn-secondary"
            data-testid="calc-group-edit"
            onClick={() => setOpen((v) => !v)}
          >
            ✏️
          </button>
        </td>
      </tr>

      {/* The rates on their own muted line: six numbers on the row above
          would leave the goods name nothing. */}
      <tr className="border-b border-line/60 text-2xs text-ink-600">
        <td className="px-2 pb-2" colSpan={4}>
          <span className="font-mono tabular-nums">
            {group.quantity ?? '—'} {group.unit ?? ''} · {group.weightKg ?? '—'} kg ·{' '}
            {group.volumeM3 ?? '—'} m³
          </span>{' '}
          ·{' '}
          {group.dutyFree ? t('dutyFree') : `${t('duty')} ${dutyText(group)}`} ·{' '}
          {group.vatFree ? t('vatFree') : `${t('vat')} ${group.vatPct ?? '—'}%`} ·{' '}
          {t('fee')} ${group.feeUsd ?? 0}
          {group.rateSource ? ` · ${t(`source.${group.rateSource}` as 'source.typed')}` : ''}
          {group.customs.ok ? ` · ${t('value')} $${group.customs.valueUsd.toFixed(2)}` : ''}
          {/* The additional duty is money the certificate answer created —
              it must be visible on the group it landed on, or the total is
              bigger than its own lines. */}
          {group.customs.ok && group.customs.addDutyUsd > 0
            ? ` · +${group.customs.addDutyPct}% ($${group.customs.addDutyUsd.toFixed(2)})`
            : ''}
          {group.dictionaryRates && group.rateSource !== 'dictionary' ? (
            <button
              type="button"
              className="ml-2 underline"
              disabled={pending}
              data-testid="calc-pull-rates"
              onClick={() => act(() => pullRatesAction(id, group.id))}
            >
              {t('pullRates')}: {dutyText(group.dictionaryRates)} /{' '}
              {group.dictionaryRates.vatPct}%
            </button>
          ) : null}
          {/* Law 6's other half: a rate the VED typed over (or without) the
              dictionary's answer is REMEMBERED — by a person's press, never
              silently (0086's own comment promised this box; the whole-module
              audit found it was never built). Hidden once the dictionary
              already says the same numbers. */}
          {group.rateSource === 'typed' &&
          group.tnvedCode &&
          group.dutyPct !== null &&
          group.vatPct !== null &&
          (!group.dictionaryRates ||
            group.dictionaryRates.dutyPct !== group.dutyPct ||
            group.dictionaryRates.vatPct !== group.vatPct ||
            group.dictionaryRates.feeUsd !== (group.feeUsd ?? 0)) ? (
            <button
              type="button"
              className="ml-2 underline"
              disabled={pending}
              data-testid="calc-teach-rates"
              onClick={() =>
                act(() =>
                  saveRatesAction({
                    tnvedCode: group.tnvedCode!,
                    dutyPct: group.dutyPct!,
                    vatPct: group.vatPct!,
                    feeUsd: group.feeUsd ?? 0,
                    effectiveDate: new Date().toISOString().slice(0, 10),
                    source: 'correction',
                  }),
                )
              }
            >
              {t('teachRates')}
            </button>
          ) : null}
          {/* Law 7's offered default: how this code's lgota was decided last
              time. A press APPLIES it (clearing any confirm — it is a
              change); silence remains a real answer. Shown only while nobody
              has confirmed and the flags differ. */}
          {group.lgotaLast &&
          group.confirmedAt === null &&
          (group.lgotaLast.dutyFree !== group.dutyFree ||
            group.lgotaLast.vatFree !== group.vatFree) ? (
            <button
              type="button"
              className="ml-2 underline"
              disabled={pending}
              data-testid="calc-lgota-last"
              onClick={() =>
                act(() =>
                  setRatesAction(id, group.id, {
                    label: group.label,
                    tnvedCode: group.tnvedCode ?? '',
                    dutyPct: group.dutyPct,
                    vatPct: group.vatPct,
                    feeUsd: group.feeUsd,
                    dutyFree: group.lgotaLast!.dutyFree,
                    vatFree: group.lgotaLast!.vatFree,
                  }),
                )
              }
            >
              {t('lgotaLast')}
              {group.lgotaLast.dutyFree ? ` · ${t('dutyFree')}` : ''}
              {group.lgotaLast.vatFree ? ` · ${t('vatFree')}` : ''}
            </button>
          ) : null}
          {group.confirmedAt === null ? (
            <button
              type="button"
              className="ml-2 underline text-good"
              disabled={pending}
              data-testid="calc-confirm-group"
              onClick={() => act(() => confirmGroupAction(id, group.id))}
            >
              {t('confirm')}
            </button>
          ) : null}
        </td>
      </tr>

      {open ? (
        <tr className="border-b border-line bg-surface-sunken">
          <td className="p-2" colSpan={4}>
            <div className="flex flex-wrap items-end gap-2" data-testid="calc-group-form">
              <label className="text-2xs">
                <span className="label">{t('group')}</span>
                <input className="input input-sm !w-40" value={label} onChange={(e) => setLabel(e.target.value)} />
              </label>
              <label className="text-2xs">
                <span className="label">TNVED</span>
                <input
                  className="input input-sm !w-32"
                  data-testid="calc-code"
                  value={code}
                  onChange={(e) => setCode(e.target.value)}
                />
              </label>
              <label className="text-2xs">
                <span className="label">{t('duty')} %</span>
                <input
                  className="input input-sm !w-20"
                  data-testid="calc-duty"
                  value={duty}
                  onChange={(e) => setDuty(e.target.value)}
                />
              </label>
              <label className="text-2xs">
                <span className="label">{t('vat')} %</span>
                <input
                  className="input input-sm !w-20"
                  data-testid="calc-vat"
                  value={vat}
                  onChange={(e) => setVat(e.target.value)}
                />
              </label>
              <label className="text-2xs">
                <span className="label">{t('fee')} $</span>
                <input className="input input-sm !w-24" value={fee} onChange={(e) => setFee(e.target.value)} />
              </label>
              <label className="flex items-center gap-1 text-2xs">
                <input type="checkbox" checked={dutyFree} onChange={(e) => setDutyFree(e.target.checked)} />
                {t('dutyFree')}
              </label>
              <label className="flex items-center gap-1 text-2xs">
                <input type="checkbox" checked={vatFree} onChange={(e) => setVatFree(e.target.checked)} />
                {t('vatFree')}
              </label>
              <button
                type="button"
                className="btn-primary"
                disabled={pending}
                data-testid="calc-save-rates"
                onClick={() =>
                  act(async () => {
                    const result = await setRatesAction(id, group.id, {
                      label,
                      tnvedCode: code,
                      dutyPct: num(duty),
                      vatPct: num(vat),
                      feeUsd: num(fee),
                      dutyFree,
                      vatFree,
                    });
                    if (!result.error) setOpen(false);
                    return result;
                  })
                }
              >
                {tc('save')}
              </button>
              <button
                type="button"
                className="btn-secondary"
                disabled={pending}
                data-testid="calc-delete-group"
                onClick={() => act(() => deleteGroupAction(id, group.id))}
              >
                🗑
              </button>
            </div>

            <ul className="mt-2 space-y-1">
              {group.items.map((item) => (
                <li key={item.seq} className="flex flex-wrap items-center gap-2 text-2xs">
                  <span className="grow">{item.label}</span>
                  <ItemBaza id={id} item={item} pending={pending} act={act} />
                </li>
              ))}
            </ul>
          </td>
        </tr>
      ) : null}
    </>
  );
}

/**
 * The baza, per ITEM.
 *
 * One TNVED code holds several products with different bazas, so this box is
 * on the item and not on the group — pricing a whole group at one product's
 * number is nearly half out on a realistic pair.
 */
function ItemBaza({
  id,
  item,
  pending,
  act,
}: {
  id: string;
  item: WorkspaceItem;
  pending: boolean;
  act: (work: () => Promise<CalcFormState>) => void;
}) {
  const t = useTranslations('calc');
  const [value, setValue] = useState(item.bazaUsd === null ? '' : String(item.bazaUsd));
  const [basis, setBasis] = useState<'unit' | 'kg'>(item.bazaBasis ?? 'unit');

  return (
    <span className="flex items-center gap-1">
      {/* Law 5's ⚠ belongs where a stale baza actually prices a job, not
          only on the dictionary screen — the whole-module audit's find. */}
      {item.dictionaryBaza?.stale ? (
        <span className="chip chip-warn" data-testid="calc-baza-stale" title={item.dictionaryBaza.effectiveDate}>
          ⚠ {t('stale')}
        </span>
      ) : null}
      <input
        className="input input-sm !w-20 font-mono tabular-nums"
        aria-label={`${t('baza')} ${item.seq}`}
        data-testid="calc-baza"
        placeholder={item.dictionaryBaza ? String(item.dictionaryBaza.bazaUsd) : t('baza')}
        value={value}
        onChange={(e) => setValue(e.target.value)}
      />
      <select
        className="input input-sm !w-16"
        aria-label={`${t('basis')} ${item.seq}`}
        value={basis}
        onChange={(e) => setBasis(e.target.value as 'unit' | 'kg')}
      >
        <option value="unit">{t('perUnit')}</option>
        <option value="kg">kg</option>
      </select>
      <button
        type="button"
        className="btn-secondary"
        disabled={pending}
        data-testid="calc-save-baza"
        onClick={() =>
          act(() =>
            setBazaAction(id, item.seq, value.trim() === '' ? null : Number(value.replace(',', '.')), basis),
          )
        }
      >
        ✓
      </button>
    </span>
  );
}

function GroupPicker({
  id,
  item,
  groups,
  pending,
  act,
}: {
  id: string;
  item: WorkspaceItem;
  groups: WorkspaceGroup[];
  pending: boolean;
  act: (work: () => Promise<CalcFormState>) => void;
}) {
  const t = useTranslations('calc');
  return (
    <select
      className="input input-sm !w-40"
      aria-label={`${t('group')} ${item.seq}`}
      data-testid="calc-item-group"
      defaultValue={item.groupId ?? ''}
      disabled={pending}
      onChange={(e) => act(() => moveItemAction(id, item.seq, e.target.value))}
    >
      <option value="">— {t('ungrouped')} —</option>
      {groups.map((g) => (
        <option key={g.id} value={g.id}>
          {g.label}
        </option>
      ))}
    </select>
  );
}

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
}: {
  workspace: Workspace;
  pending: boolean;
  act: (work: () => Promise<CalcFormState>) => void;
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
        disabled={pending || workspace.blockers.length > 0}
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

/**
 * The whole law in one cell — a MAX row printed as its percentage alone
 * loses the floor, which on light goods IS the duty.
 */
function dutyText(r: {
  dutyPct: number | null;
  dutyMode: 'advalor' | 'specific' | 'max' | 'plus';
  dutySpecific: number | null;
  dutyUnit: string | null;
}): string {
  const pct = r.dutyPct === null ? '—' : `${r.dutyPct}%`;
  if (r.dutyMode === 'advalor') return pct;
  const spec = `${r.dutySpecific ?? '—'} $/${r.dutyUnit ?? '—'}`;
  if (r.dutyMode === 'specific') return spec;
  if (r.dutyMode === 'max') return `${pct} / min ${spec}`;
  return `${pct} + ${spec}`;
}

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
