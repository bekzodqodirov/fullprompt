import { dayIn } from '@/modules/platform/time/tashkent';

/**
 * The day a warehouse spent the money it reported (audit A29), in THAT
 * warehouse's own clock.
 *
 * A rasxod xabari has no date field — its only clock is when it was sent —
 * and «Kiritish» used to open the form on the ACCOUNTANT's today. So money
 * spent on 29 August and entered on 3 September landed in September's P&L
 * and cash flow at September's rate, and the queue that exists precisely
 * because entry is deferred moved every month-end backlog into the wrong
 * month. A report sent at 07:00 in Kashgar is 01:00 UTC the same day, and at
 * 00:30 in Yiwu is 16:30 UTC the day BEFORE — so the zone is the warehouse's,
 * never the server's, and deliberately not the office's either (R5 moved every
 * other «today» to Tashkent; this one stays the warehouse's). The zoned-day
 * arithmetic lives beside «Tashkent today» so there is one definition of «the
 * day an instant falls on»; an unknown zone name falls back to the UTC day
 * there rather than white-paging the expense book. The page and a unit test
 * both call it, and it stays free of server-only imports.
 */
export function spendDateOf(sentAt: Date, timeZone: string): string {
  return dayIn(sentAt, timeZone);
}
