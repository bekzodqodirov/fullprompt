import { sql, type SQL } from 'drizzle-orm';

/**
 * Round 98's convention, written down once (#683): the marking painted on a
 * carton begins with the client code it belongs to — «GS500MANIKEN-AL» is
 * GS500's — and the code ENDS where a digit would continue it, so GS5 is not
 * GS500X's. Pure, so the door, the candidates and the server's owner check
 * cannot disagree (pinned against `markingOfCodeSql` by a test).
 *
 * Used where a PERSON is looking — the door's «Bu yuk ZR-… reysidan
 * keldimi?», the card's candidates — and in the server's check of an
 * EXPLICIT line choice. Never in the derivation that answers a line with
 * nobody looking (`ownerLinesOf`, the backfill): a prefix there would close a
 * line on a guess.
 */
export function markingOfCode(marking: string | null | undefined, code: string | null | undefined): boolean {
  const m = (marking ?? '').trim().toUpperCase();
  const c = (code ?? '').trim().toUpperCase();
  if (!m || !c || !m.startsWith(c)) return false;
  const next = m.charAt(c.length);
  return next === '' || !/[0-9]/.test(next);
}

/** `markingOfCode` in SQL over two text expressions. */
export function markingOfCodeSql(marking: SQL, code: SQL): SQL {
  return sql`(btrim(coalesce(${marking}, '')) <> '' AND btrim(coalesce(${code}, '')) <> ''
              AND left(upper(btrim(${marking})), length(btrim(${code}))) = upper(btrim(${code}))
              AND substr(upper(btrim(${marking})), length(btrim(${code})) + 1, 1) !~ '[0-9]')`;
}

export interface OwnerSide {
  clientId: string | null;
  clientCode: string | null;
  marking: string | null;
}

const fold = (v: string | null | undefined) => (v ?? '').trim().toLowerCase();

/**
 * May a person be shown this LINE as «yours» for this prixod/owner? The exact
 * owner (same client, or the same marking), or the code-prefix convention in
 * either direction: a client line for cargo received under that client's
 * marking, a marking line for cargo received under the client the marking
 * names.
 */
export function ownerLooselyMatches(line: OwnerSide, owner: OwnerSide): boolean {
  if (line.clientId) {
    if (owner.clientId && owner.clientId === line.clientId) return true;
    return markingOfCode(owner.marking, line.clientCode);
  }
  if (fold(line.marking) && fold(line.marking) === fold(owner.marking)) return true;
  return markingOfCode(line.marking, owner.clientCode);
}
