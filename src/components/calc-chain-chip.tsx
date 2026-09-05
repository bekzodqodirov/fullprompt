import { useTranslations } from 'next-intl';
import type { ChainVersion } from '@/modules/wms/calc/chain';

/**
 * What a sealed version IS today, in one chip — the same words on the
 * registry, the workspace and the card (#513), so «V2 bilan almashtirilgan»
 * never reads differently depending on where the person is standing.
 *
 *   - a child request exists and has no version yet → «qayta hisoblanmoqda»
 *     (the old price still STANDS: an abandoned correction changes nothing);
 *   - a child has sealed → «V{n} bilan almashtirilgan»;
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
  version: Pick<ChainVersion, 'superseded' | 'supersededByNo' | 'recalcOpen'>;
  /** The chain has one link: say nothing about standing. */
  alone?: boolean;
}) {
  const t = useTranslations('calc');
  if (version.recalcOpen) {
    return (
      <span className="chip chip-brand" data-testid="chain-recalc-open">
        {t('chainRecalcOpen')}
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
