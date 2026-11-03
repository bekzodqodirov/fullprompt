import { readFileSync } from 'node:fs';
import { strip } from './source-shape';

/**
 * The «Hisoblatish» collector's files — one list for every source-shape fence
 * (docs/SAKKIZ-R3.md K16). The collector used to be one file,
 * staff-handlers.ts; K moved its halves into calc-*.ts, so a fence that reads
 * the collector reads them all, and a ninth file joins every fence at once.
 */
export const CALC_COLLECTOR_FILES = [
  'staff-handlers.ts',
  'calc-store.ts',
  'calc-files.ts',
  'calc-dialog.ts',
  'calc-keyboards.ts',
  'calc-read.ts',
  'calc-intake-sweep.ts',
  'calc-amend.ts',
];

const DIR = 'src/modules/platform/telegram';

/** Each collector file, as written (comments kept), keyed by its name. */
export function collectorFiles(): { file: string; text: string }[] {
  return CALC_COLLECTOR_FILES.map((file) => ({ file, text: readFileSync(`${DIR}/${file}`, 'utf8') }));
}

/** The collector's files concatenated, as written. */
export function collectorSource(): string {
  return collectorFiles()
    .map((f) => f.text)
    .join('\n');
}

/** …with comments stripped (#725), for the fences that read code only. */
export function collectorCode(): string {
  return collectorFiles()
    .map((f) => strip(f.text))
    .join('\n');
}
