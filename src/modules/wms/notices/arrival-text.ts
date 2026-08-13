import { clientLabels } from '@/modules/platform/telegram/client-labels';
import type { ArrivedSummary } from './arrival';

/**
 * What the customer reads when their cargo lands in Uzbekistan.
 *
 * Written to say exactly what the CHINESE arrival says — «necha karobka necha
 * kg necha kub qaysi tovarlari keldi», the owner's own list — because it is
 * the same question asked at the other end of the road, and a customer who
 * learns to read one message should not have to learn a second shape.
 *
 * What it deliberately does NOT say: the truck. Not its code, not its plate,
 * not its driver. A batch code is the company's throughput published to
 * anyone who buys one carton, and the truck carries twenty other customers
 * whose delivery dates it would leak. The customer is told a PLACE and a
 * QUANTITY, which is all they asked for.
 *
 * Pure — no database, no Telegram — so the wording can be tested in four
 * languages without either.
 */
export function arrivalText(
  summary: ArrivedSummary,
  clientCode: string,
  locale?: string | null,
): string {
  const t = clientLabels(locale);
  const round = (value: number) => String(Math.round(value * 100) / 100);
  const lines = summary.lines.map(
    (line) => `· ${line.letter ?? ''} ${line.name} — ${line.boxCount} ${t.pieces}`,
  );
  return (
    `${t.readyTitle}\n` +
    `${clientCode}\n` +
    `${t.arrivedWarehouse}: ${summary.warehouseCode}\n\n` +
    `${lines.join('\n')}\n\n` +
    `${t.arrivedTotal}: ${summary.boxCount} ${t.pieces} · ${round(summary.weightKg)} ${t.kg} · ` +
    `${round(summary.volumeM3)} ${t.m3}\n\n` +
    `${t.readyNote}\n` +
    t.seeDetails
  );
}
