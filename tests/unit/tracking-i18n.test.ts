import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';
import en from '../../messages/en.json';
import ru from '../../messages/ru.json';
import uz from '../../messages/uz.json';
import zh from '../../messages/zh-CN.json';
import { KNOWN_TARIFF_ZONES } from '@/modules/wms/calc/tariff-seed';
import { BORDER_POST_KEYS, CHECKPOINT_LABEL, routeFor, WAREHOUSE_POINTS } from '@/modules/wms/tracking/map-data';

/**
 * Every key the Horgos round builds at RUNTIME (`seg_${segKey}`, a pin's
 * label, a zone name, a refusal code), in all four bundles. `i18n-keys.test`
 * sees only literal `t('…')` calls, and comparing bundles to each other
 * cannot catch a key missing from all four (#163) — so each list here is
 * DERIVED from the code that asks for the key: every leg of every route the
 * map can draw, every pin, every zone, and the refusal unions read out of the
 * services' own source.
 */
const BUNDLES = { ru, uz, 'zh-CN': zh, en } as Record<string, Record<string, unknown>>;

function has(bundle: Record<string, unknown>, path: string): boolean {
  let node: unknown = bundle;
  for (const part of path.split('.')) {
    if (typeof node !== 'object' || node === null || !(part in node)) return false;
    node = (node as Record<string, unknown>)[part];
  }
  return typeof node === 'string' && node.length > 0;
}

function missing(paths: string[]): string[] {
  const out: string[] = [];
  for (const [locale, bundle] of Object.entries(BUNDLES)) {
    for (const path of paths) if (!has(bundle, path)) out.push(`${locale}: ${path}`);
  }
  return out;
}

/** The members of an exported string-literal union, read from the source. */
function unionOf(file: string, typeName: string): string[] {
  const src = readFileSync(file, 'utf8');
  const at = src.indexOf(`export type ${typeName} =`);
  expect(at, `${typeName} in ${file}`).toBeGreaterThan(-1);
  const body = src.slice(at, src.indexOf(';', at));
  const members = [...body.matchAll(/'([a-z_]+)'/g)].map((m) => m[1]!);
  expect(members.length, `${typeName} has no members — re-anchor this fence`).toBeGreaterThan(2);
  return members;
}

describe('the tracking words the code asks for at runtime', () => {
  it('every leg of every route the map can draw has its «📍» sentence', () => {
    const codes = Object.keys(WAREHOUSE_POINTS);
    const keys = new Set<string>();
    for (const o of codes) {
      for (const d of codes) {
        if (o === d) continue;
        for (const seg of routeFor(o, d)?.segments ?? []) keys.add(`map.seg_${seg.key}`);
      }
    }
    // The Horgos road's own two legs are among them — a parse that found
    // nothing new would pass for the wrong reason.
    expect([...keys]).toEqual(expect.arrayContaining(['map.seg_kz', 'map.seg_uz_queue']));
    expect(missing([...keys])).toEqual([]);
  });

  it('every pin has its label', () => {
    expect(missing(Object.values(CHECKPOINT_LABEL).map((l) => `batches.${l.label}`))).toEqual([]);
  });

  it('every zone the app can name has its name', () => {
    expect(missing(KNOWN_TARIFF_ZONES.map((z) => `calc.zones.${z}`))).toEqual([]);
  });

  it('every border post has its name on the panel', () => {
    expect(missing(BORDER_POST_KEYS.map((p) => `trucks.queue.post.${p}`))).toEqual([]);
  });

  it('every refusal the queue and the pin services can answer is a sentence', () => {
    const queue = unionOf('src/modules/wms/tracking/border-queue.ts', 'BorderQueueErrorCode');
    const pins = unionOf('src/modules/wms/tracking/checkpoint.ts', 'CheckpointErrorCode');
    expect(
      missing([
        ...[...queue, 'server_behind'].map((c) => `trucks.queue.errors.${c}`),
        ...pins.map((c) => `batches.checkpointErrors.${c}`),
      ]),
    ).toEqual([]);
  });
});
