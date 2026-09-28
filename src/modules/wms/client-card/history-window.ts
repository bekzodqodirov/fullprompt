import { HISTORY_DAYS } from '../client-cabinet/service';

/**
 * The «Topshirilgan» list's two windows: the Mini App's 90 days, and a year
 * for the office. `?tarix=` is read as EXACTLY one of them and anything else
 * is the default — a URL parameter is a forged post (#514), and a hand-typed
 * `?tarix=100000` must not become a ten-year read.
 */
export const HISTORY_WINDOWS = [HISTORY_DAYS, 365] as const;

export function readHistoryDays(raw: string | string[] | undefined): number {
  const value = Array.isArray(raw) ? raw[0] : raw;
  const n = Number(value);
  return (HISTORY_WINDOWS as readonly number[]).includes(n) ? n : HISTORY_DAYS;
}
