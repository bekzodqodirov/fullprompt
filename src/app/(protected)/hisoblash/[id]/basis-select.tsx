'use client';

import { useTranslations } from 'next-intl';
import { isBazaBasis, type BazaBasis, type MeasureUnit } from '@/modules/wms/calc/pricing';
import type { UnitWords } from '@/modules/wms/calc/units';
import { basisLabel } from '@/modules/wms/calc/basis';

/**
 * The row's unit select — ONE component for the saved rows, the ghost rows
 * and, since the phone round (his 21b), the phone sheet: the same «avto», the
 * same offered list (`basesFor` via `screenRowOf`), the same ⚠ on a stored
 * unit the law no longer offers.
 *
 * `value` null renders «avto»: an untouched choice the server decides. A
 * stored value the law no longer offers ALWAYS renders as an option, marked
 * ⚠ — a select that cannot render the stored value silently rewrites it on
 * the next submit (#171), and a conflict must be SEEN to be fixed.
 *
 * Measured in a browser at 1280 and 768: the widest word any locale puts in
 * the grid's cell is ru «авто» at 34px of text, and the old 48px box left
 * 26px — a 56px one still cut the last letter off. 64px leaves 42px for the
 * text beside the arrow. The phone's field is the ordinary 16 px `.input`
 * (iPhone Safari zooms the page on focus of anything smaller). The classes are
 * a LITERAL map because Tailwind compiles only the classes it can see.
 */
const SIZE_CLASS = {
  cell: 'input-cell !w-16 !px-0.5',
  field: 'input',
} as const;

export function BasisSelect({
  value,
  offered,
  label,
  testId,
  drafted,
  disabled,
  onPick,
  size,
  autoUnit,
}: {
  value: BazaBasis | null;
  offered: BazaBasis[];
  label: string;
  testId: string;
  drafted: boolean;
  disabled: boolean;
  onPick: (basis: BazaBasis) => void;
  size: keyof typeof SIZE_CLASS;
  /** What «avto» resolves to right now, when the law is known — printed
   * beside the word, so the unit a price is typed against is ON the screen
   * (2026-10-09, judge MR-17) and is the unit the save posts as shown. */
  autoUnit?: BazaBasis | null;
}) {
  const t = useTranslations('calc');
  const options = value === null || offered.includes(value) ? offered : [...offered, value];
  // A stored unit the code's law cannot hold (`basisConflicts`, P3.7): the
  // box itself says so — the engine refuses the row until a fitting unit is
  // picked, and «o'lchov yo'q» beside a filled box sent the VED looking for
  // a missing number. `!`: the cell's own border colour wins otherwise.
  const conflict = value !== null && !offered.includes(value);
  return (
    <select
      className={`${SIZE_CLASS[size]}${conflict ? ' !border-warn' : drafted ? ' border-brand-500' : ''}`}
      title={conflict ? t('grid.pickUnit') : undefined}
      data-conflict={conflict ? '1' : undefined}
      aria-label={label}
      data-testid={testId}
      value={value ?? ''}
      disabled={disabled}
      onChange={(e) => {
        if (isBazaBasis(e.target.value)) onPick(e.target.value);
      }}
    >
      {value === null ? (
        <option value="">
          {t('table.basisAuto')}
          {autoUnit ? ` · ${basisLabel(autoUnit, t('perUnit'))}` : ''}
        </option>
      ) : null}
      {options.map((b) => (
        <option key={b} value={b}>
          {basisLabel(b, t('perUnit'))}
          {offered.includes(b) ? '' : ' ⚠'}
        </option>
      ))}
    </select>
  );
}

const MEASURE_UNITS: readonly MeasureUnit[] = ['m2', 'juft', 'litr', 'sm3'];
const isMeasureUnit = (v: string): v is MeasureUnit => (MEASURE_UNITS as readonly string[]).includes(v);

/**
 * What a new row's O'lchov amount is IN, while the code's law names no unit
 * (P3.5, UX12): «120» in the box means nothing until somebody says m², and a
 * number whose unit is unknown is dropped by the save. Only the MEASURE's
 * unit is posted — the baza stays «avto», which then reads the stated pair.
 */
export function MeasureUnitSelect({
  value,
  label,
  testId,
  units,
  size,
  onPick,
}: {
  value: MeasureUnit | null;
  label: string;
  testId: string;
  units: UnitWords;
  size: keyof typeof SIZE_CLASS;
  onPick: (unit: MeasureUnit | null) => void;
}) {
  return (
    <select
      className={SIZE_CLASS[size]}
      aria-label={label}
      data-testid={testId}
      value={value ?? ''}
      onChange={(e) => onPick(isMeasureUnit(e.target.value) ? e.target.value : null)}
    >
      <option value="">—</option>
      {MEASURE_UNITS.map((u) => (
        <option key={u} value={u}>
          {units[u]}
        </option>
      ))}
    </select>
  );
}
