'use client';

import { useTranslations } from 'next-intl';
import { isBazaBasis, type BazaBasis } from '@/modules/wms/calc/pricing';
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
}: {
  value: BazaBasis | null;
  offered: BazaBasis[];
  label: string;
  testId: string;
  drafted: boolean;
  disabled: boolean;
  onPick: (basis: BazaBasis) => void;
  size: keyof typeof SIZE_CLASS;
}) {
  const t = useTranslations('calc');
  const options = value === null || offered.includes(value) ? offered : [...offered, value];
  return (
    <select
      className={`${SIZE_CLASS[size]}${drafted ? ' border-brand-500' : ''}`}
      aria-label={label}
      data-testid={testId}
      value={value ?? ''}
      disabled={disabled}
      onChange={(e) => {
        if (isBazaBasis(e.target.value)) onPick(e.target.value);
      }}
    >
      {value === null ? <option value="">{t('table.basisAuto')}</option> : null}
      {options.map((b) => (
        <option key={b} value={b}>
          {basisLabel(b, t('perUnit'))}
          {offered.includes(b) ? '' : ' ⚠'}
        </option>
      ))}
    </select>
  );
}
