import { densityBand, type DensityBand } from '@/modules/wms/receipts/math';

/**
 * The one place a density gets its colour.
 *
 * Three screens (receiving, plan editor, stock) each hand-rolled this map and
 * two of them dressed the LIGHTEST band in the brand colour — which is red,
 * so light cargo wore the danger colour (owner: "yengil yuklar qizil
 * belgilanib qolyabti"). The owner's rule now, everywhere at once: light is
 * good and green; the heavier, the redder. A lookup map because Tailwind
 * cannot see a class assembled at runtime.
 */
export const DENSITY_CLASS: Record<DensityBand, string> = {
  green: 'bg-good/15 text-good',
  yellow: 'bg-warn/15 text-warn',
  red: 'bg-bad/15 text-bad',
  darkred: 'bg-bad text-white',
};

export function DensityBadge({
  density,
  thresholds,
}: {
  density: number | null;
  thresholds: { light: number; medium: number; heavy: number };
}) {
  const band = densityBand(density, thresholds);
  if (band === null || density === null) return null;
  return (
    <span
      data-testid="density-badge"
      className={`rounded px-1.5 py-0.5 font-sans text-xs font-semibold ${DENSITY_CLASS[band]}`}
    >
      {Math.round(density)}
    </span>
  );
}
