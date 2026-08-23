import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';

/**
 * When a lead is won, everything the calc module pinned to that lead moves.
 *
 * The calc module denormalises the CARD onto its rows — `(entity_type,
 * entity_id)` on `calc_requests` so the queue can be read per card, and the
 * same pair on `calc_offers` so a card can list its own offers in one indexed
 * query. Both are copies of one fact, and a won lead changes that fact.
 *
 * This has now been got wrong twice in a row, one table at a time. Round 110
 * found `rekeyLeadCalcRequests` filtering `openRequests`, so a SEALED request
 * stayed behind and the new deal got the price with none of its lock (#763).
 * The fix moved every request — and left `calc_offers` untouched, so what the
 * seller actually promised the customer vanished from the only card that
 * still existed. Both defects are the same sentence: **fixing a rule in one
 * of the places it is restated is not fixing the rule.**
 *
 * So the set is DERIVED from the schema rather than listed here. A third
 * `calc_*` table carrying the pair turns this red on the day it is added,
 * which is the day somebody can still remember why.
 *
 * Source shape on purpose: the behavioural test lives beside it in
 * `calc-offer.integration.test.ts`, but it can only prove the tables that
 * exist today — and the thing being guarded is the table that does not yet.
 */
const SCHEMA = readFileSync('src/modules/platform/db/schema/wms.ts', 'utf8');
const SERVICE = readFileSync('src/modules/wms/calc/service.ts', 'utf8');

/** Every `calc_*` table declaring BOTH entity columns, read out of the schema. */
function calcTablesCarryingTheCard(): { constName: string; table: string }[] {
  const out: { constName: string; table: string }[] = [];
  const decl = /export const (\w+) = pgTable\(\s*'(calc_\w+)'/g;
  let m: RegExpExecArray | null;
  while ((m = decl.exec(SCHEMA))) {
    const start = m.index + m[0].length;
    const next = SCHEMA.indexOf('\nexport const ', start);
    const body = SCHEMA.slice(start, next > 0 ? next : SCHEMA.length);
    if (body.includes("'entity_type'") && body.includes("'entity_id'")) {
      out.push({ constName: m[1]!, table: m[2]! });
    }
  }
  return out;
}

/** The body of `rekeyLeadCalcRequests`, comments stripped (#725's lesson). */
function rekeyBody(): string {
  const at = SERVICE.indexOf('export async function rekeyLeadCalcRequests');
  expect(at, 'rekeyLeadCalcRequests must exist').toBeGreaterThan(-1);
  const next = SERVICE.indexOf('\nexport ', at + 10);
  const body = SERVICE.slice(at, next > 0 ? next : SERVICE.length);
  // A sentence in a comment must not satisfy a fence about code (#725).
  return body.replace(/\/\*[\s\S]*?\*\//g, '').replace(/\/\/.*$/gm, '');
}

describe('winning a lead moves every calc row that names the card', () => {
  it('the schema really does carry the card in more than one place', () => {
    const tables = calcTablesCarryingTheCard();
    // If this ever drops to one, the whole rule is gone and so is the risk —
    // but then this file should be deleted deliberately, not silently pass.
    expect(tables.map((t) => t.table).sort()).toEqual(['calc_offers', 'calc_requests']);
  });

  it('rekeyLeadCalcRequests updates EVERY one of them', () => {
    const body = rekeyBody();
    for (const { constName, table } of calcTablesCarryingTheCard()) {
      expect(body, `${table} is left on the dead lead`).toContain(`.update(${constName})`);
    }
  });

  it('and re-keys them onto the deal, not merely touches them', () => {
    const body = rekeyBody();
    const sets = body.match(/entityType: 'deal'/g) ?? [];
    expect(sets.length).toBe(calcTablesCarryingTheCard().length);
    expect((body.match(/entityId: dealId/g) ?? []).length).toBe(
      calcTablesCarryingTheCard().length,
    );
  });

  it('moves closed rows too — a sealed request is the one that matters', () => {
    // #763: the filter that hid the sealed request. Its absence is the fix.
    expect(rekeyBody()).not.toContain('openRequests');
  });
});
