import { useTranslations } from 'next-intl';
import type { ChainVersion } from '@/modules/wms/calc/chain';

/**
 * What a priced link IS today, in one chip — the same words on the registry,
 * the workspace, the card and the sheet (#513), for a sealed version and a
 * Готово answer alike (review ved-correctness-16), so one state never reads
 * two ways on one screen. The words come from the direct child's ending
 * (`ChildState`, chain.ts):
 *
 *   - open     → «qayta hisoblanmoqda» (a correction is being written — and
 *     the old price no longer stands: the edge supersedes, which is what the
 *     seller's «eski narx endi amal qilmaydi» push says);
 *   - sealed   → «V{n} bilan almashtirilgan»;
 *   - answered → «o'rniga umumiy narx»;
 *   - returned → «tuzatish qaytarildi» (the way on is a NEW request from the
 *     card, `recalc_returned`);
 *   - unpriced → «tuzatish narxsiz yopildi»;
 *   - no child → «amaldagi», printed only when there is a chain to stand
 *     against — a lone V1 wearing «current» is noise.
 *
 * A server component with no state; the registry and the card render it on
 * the server, the workspace inside a client tree — `useTranslations` works
 * in both.
 */
export function ChainStateChip({
  version,
  alone = false,
}: {
  version: Pick<ChainVersion, 'superseded' | 'supersededByNo' | 'recalcOpen' | 'childState'>;
  /** The chain has one link: say nothing about standing. */
  alone?: boolean;
}) {
  const t = useTranslations('calc');
  if (version.recalcOpen || version.childState === 'open') {
    return (
      <span className="chip chip-brand" data-testid="chain-recalc-open">
        {t('chainRecalcOpen')}
      </span>
    );
  }
  if (version.childState === 'answered') {
    return (
      <span className="chip chip-neutral" data-testid="chain-answered">
        {t('chainAnswered')}
      </span>
    );
  }
  if (version.childState === 'returned') {
    return (
      <span className="chip chip-warn" data-testid="chain-returned">
        {t('chainReturned')}
      </span>
    );
  }
  if (version.childState === 'unpriced') {
    return (
      <span className="chip chip-warn" data-testid="chain-unpriced">
        {t('chainUnpriced')}
      </span>
    );
  }
  if (version.superseded) {
    return (
      <span className="chip chip-neutral" data-testid="chain-superseded">
        {version.supersededByNo === null
          ? t('supersededPlain')
          : t('supersededBy', { no: version.supersededByNo })}
      </span>
    );
  }
  if (alone) return null;
  return (
    <span className="chip chip-good" data-testid="chain-current">
      {t('chainCurrent')}
    </span>
  );
}
