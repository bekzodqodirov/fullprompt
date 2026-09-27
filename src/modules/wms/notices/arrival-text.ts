import { b, h } from '@/modules/platform/telegram/format';
import { clientLabels } from '@/modules/platform/telegram/client-labels';
import { milestoneOf } from '../client-cabinet/stages';
import type { ArrivedSummary } from './arrival';
import { headerLine, joinBlocks, lotLines, stepLine, totalLine } from './client-text';

/**
 * What the customer reads when their cargo lands in Uzbekistan.
 *
 * Written to say exactly what the CHINESE arrival says — «necha karobka necha
 * kg necha kub qaysi tovarlari keldi», the owner's own list — because it is
 * the same question asked at the other end of the road, and a customer who
 * learns to read one message should not have to learn a second shape. Since
 * round C both are drawn by `client-text.ts`'s pieces, in HTML.
 *
 * What it deliberately does NOT say: the truck. Not its code, not its plate,
 * not its driver. A batch code is the company's throughput published to
 * anyone who buys one carton, and the truck carries twenty other customers
 * whose delivery dates it would leak. The customer is told a PLACE — by its
 * NAME now, «Toshkent 1» and not «TAS1», with its address when the office has
 * typed one — and a QUANTITY, which is all they asked for.
 *
 * Pure — no database, no Telegram — so the wording can be tested in every
 * language without either.
 */
export function arrivalText(
  summary: ArrivedSummary,
  clientCode: string,
  locale?: string | null,
  opts: {
    /** Customs are behind this cargo (see `arrivalCleared`). */
    cleared?: boolean;
    /** The day it landed; absent prints no date. */
    date?: Date | null;
  } = {},
): string {
  const t = clientLabels(locale);
  const place = summary.warehouseName?.trim() || summary.warehouseCode;
  const address = summary.warehouseAddress?.trim();
  return joinBlocks(
    [
      b(h(t.readyTitle)),
      headerLine(clientCode, place, opts.date ?? null),
      address ? `📍 ${h(address)}` : '',
    ],
    lotLines(summary.lines, locale),
    totalLine(summary.boxCount, { weightKg: summary.weightKg, volumeM3: summary.volumeM3 }, locale),
    [
      /*
       * «Olib ketishga tayyor» — the step this notice is only ever claimed
       * for (the unload claims it for `ready_for_pickup` boxes alone), and
       * the word the Mini App shows for the same cartons. The push used to
       * say «after clearance» while the cabinet said «ready ✅» about the
       * same boxes (judge STATE-1): one rule on both surfaces now.
       */
      stepLine(milestoneOf('ready'), locale),
      h(opts.cleared ? t.pushReadyCleared : t.readyNote),
    ],
  );
}

/**
 * Are customs behind this cargo? Either somebody pressed «rastamojka tugadi»
 * on the truck, or the truck never crossed a border at all: a leg that
 * STARTED in Uzbekistan carries cargo that was cleared when it entered the
 * country (judge CX-3), and «we will agree after the paperwork» would send
 * the customer waiting for paperwork that is done.
 */
export function arrivalCleared(customsClearedAt: Date | null | undefined, originCountry: string | null | undefined): boolean {
  return Boolean(customsClearedAt) || originCountry === 'UZ';
}
