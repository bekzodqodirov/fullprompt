import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';

/**
 * «Keyingi yo'l» (owner, 2026-09-30, answers 1a/2a/5a): the truck that may
 * carry a carton's PRICE carries its whole road. «May carry the price» is the
 * handover gate's clause 3 — so the gate and the tannarx must ask ONE rule
 * (#513), or a truck the gate calls «narx boshqa mashinada» could keep a
 * road the tannarx moved away, or the reverse.
 *
 * Source-shape on purpose: the walk-in half of the rule changes no money for
 * cargo that never crosses a border (measured: stripping `receivedInUzSql`
 * from `bearsPriceSql` left every integration test green), so a behaviour
 * test cannot hold the two readers together — this does.
 */
const strip = (source: string) =>
  source.replace(/\/\*[\s\S]*?\*\//g, '').replace(/(^|[^:])\/\/.*$/gm, '$1');
const read = (path: string) => strip(readFileSync(path, 'utf8'));

describe('one «bears the price» rule for the gate and the tannarx', () => {
  const internal = read('src/modules/wms/batches/internal.ts');
  const unpriced = read('src/modules/wms/finance/unpriced.ts');
  const costing = read('src/modules/wms/costing/service.ts');

  it('bearsPriceSql is built from the two halves the gate uses', () => {
    const body = internal.slice(internal.indexOf('export function bearsPriceSql'));
    expect(body).toContain('crossesBorderSql(origin, dest)');
    expect(body).toContain('receivedInUzSql(receiptWarehouse)');
    expect(body).toContain('NOT ${internalLegSql(origin, dest)}');
  });

  it('the gate’s clause 3 asks those halves and restates neither', () => {
    expect(unpriced).toContain('${crossesBorderSql(');
    expect(unpriced).toContain('${receivedInUzSql(');
    expect(unpriced).not.toContain('sameCountryLegSql(');
    // The prixod's own country is asked only through receivedInUzSql.
    expect(unpriced).not.toContain('rw.country');
  });

  it('the tannarx fence decides the carrier with bearsPriceSql', () => {
    const ctes = costing.slice(costing.indexOf('function carriageCtesSql'));
    expect(ctes).toContain("${bearsPriceSql('ro', 'rd', 'rw')} AS bears");
    // The move is dropped on the giving truck in the same fence that adds it.
    const fence = costing.slice(costing.indexOf('function landedAllocationsSql'), costing.indexOf('function carriageCtesSql'));
    expect(fence).toContain('AND gb.box_id IS NULL');
    expect(fence).toContain('cr.upto IS NOT NULL AND eb.departed_at > c.at AND eb.departed_at <= cr.upto');
  });
});
