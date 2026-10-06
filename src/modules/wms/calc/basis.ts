import { violatedCheck } from '@/modules/platform/db/errors';
import { BAZA_BASES, type BazaBasis, type MeasureUnit } from './pricing';

/**
 * The two CHECKs 0125 widened with 'm3'. On a half-applied deploy (the app
 * new, the migration not yet run) an m³ save breaks exactly one of these, and
 * that is «the server is behind» — `server_behind` in words, never a white
 * page. Matched by NAME: a 23514 from the pair CHECK on the same table is a
 * real fault and must stay one. (The import's `customs_import_rows_unit_check`
 * is not here: a row it refuses is counted `rejected` by the parse, which is
 * already a sentence.)
 */
export const WIDENED_BASIS_CHECKS = ['calc_items_baza_basis_check', 'calc_bazas_basis_check'] as const;

export function isBehindOnBasisCheck(err: unknown): boolean {
  const name = violatedCheck(err);
  return name !== null && (WIDENED_BASIS_CHECKS as readonly string[]).includes(name);
}

/**
 * Item 3 (phase 4): the CODE's law says the row's default baza basis, so the
 * VED only types the number («edinitsa izmereniya avtomatik» — the owner's
 * own sentence, and his answer 18a). Total over DutyUnit: dona/1000_dona
 * price per piece and default to the per-unit basis; sm³ stays per dona
 * (#868 — nobody VALUES a vehicle by displacement); a pure-advalor code keeps
 * the old default.
 *
 * ONE chain for the select, the save, the LIVE arithmetic and the draft
 * self-clean — split, the screen shows one basis while another is posted or
 * priced (#171, and phase 3's live-equals-saved invariant).
 */
export function defaultBasisFor(group: { dutyUnit?: string | null } | null): BazaBasis {
  const u = group?.dutyUnit;
  return u === 'm2' || u === 'juft' || u === 'litr' ? u : u === 'kg' ? 'kg' : 'unit';
}

/**
 * The bases whose quantity lives on the measure PAIR — the row's one
 * `measure_unit`/`measure_qty`. dona, kg and m³ each have a column of their
 * own (quantity, weight_kg, volume_m3), so they never touch the pair.
 */
const PAIR_BASES: readonly BazaBasis[] = ['m2', 'juft', 'litr'];
/** The law units that live on the pair — sm³ included (a vehicle's duty). */
const PAIR_LAWS: readonly string[] = ['m2', 'juft', 'litr', 'sm3'];

/**
 * What the VED may price a row PER, given the code's law (0125, his 18a/19a).
 *
 * The baza is the row's own question and the duty is the law's, so most codes
 * offer all six. The ONE restriction he was told and accepted: a code whose
 * law counts in juft / litr / m² (or a vehicle's sm³) already owns the row's
 * single measure pair, so its baza may be per dona, kg, m³ or the law's own
 * unit — never ANOTHER pair unit, which would need a second pair to hold two
 * different quantities on one line.
 */
export function basesFor(lawUnit: string | null | undefined): BazaBasis[] {
  if (lawUnit === 'juft' || lawUnit === 'litr' || lawUnit === 'm2') {
    return ['unit', 'kg', 'm3', lawUnit];
  }
  if (lawUnit === 'sm3') return ['unit', 'kg', 'm3'];
  return [...BAZA_BASES];
}

/**
 * Which unit the row's measure pair must hold — the one rule the O'lchov
 * line, the save, the live figure and the server's measure pass all ask.
 *
 * The law's pair unit wins when it has one (the specific duty counts in it,
 * whatever the baza is per). Otherwise the BASIS decides: an m² baza on an
 * advalor code needs an m² count, and the box must exist to hold it — the old
 * rule («the measure follows the law only», #868) dropped that count and left
 * the row refusing «o'lchov yo'q» with no box to fix it.
 */
export function pairUnitFor(
  lawUnit: string | null | undefined,
  basis: BazaBasis | null | undefined,
): MeasureUnit | null {
  if (lawUnit && PAIR_LAWS.includes(lawUnit)) return lawUnit as MeasureUnit;
  if (basis && PAIR_BASES.includes(basis)) return basis as MeasureUnit;
  return null;
}

/**
 * A stored basis the law no longer offers — the one combination the row
 * cannot hold. Never rewritten silently: the save NAMES it (`basisConflict`),
 * the select shows it with ⚠, and the engine refuses `measure_missing` naming
 * the row until a person picks a unit that fits.
 */
export function basisConflicts(
  lawUnit: string | null | undefined,
  basis: BazaBasis | null | undefined,
): boolean {
  return basis !== null && basis !== undefined && !basesFor(lawUnit).includes(basis);
}

/**
 * What the row's unit select SHOWS: the VED's draft, else what is stored,
 * else the law's default (18a). The four browser sites that used to restate
 * this chain by hand — the select, the save, the live engine item and the
 * draft self-clean — each ask this one function now.
 */
export function basisOnScreen(
  draft: BazaBasis | undefined,
  stored: BazaBasis | null,
  group: { dutyUnit?: string | null } | null,
): BazaBasis {
  return draft ?? stored ?? defaultBasisFor(group);
}

/**
 * A basis as a person reads it. `perUnit` is the caller's own word for dona —
 * «шт» / «dona» / «unit» / «件» — because 'unit' is a storage spelling and
 * nobody's word; the rest are symbols every locale writes the same way.
 * Takes a plain string on purpose: sealed sheets read the basis as stored
 * text, and a reader must label an old breakdown without casting it.
 */
export function basisLabel(basis: string, perUnit: string): string {
  if (basis === 'unit') return perUnit;
  if (basis === 'm2') return 'm²';
  if (basis === 'm3') return 'm³';
  return basis;
}

/**
 * Item 1 (phase 4): the block's ONE baza — his own sentence «bitta kod —
 * bitta narx» made a summary line. Null when the members carry different
 * pairs or none: three different bazas have no one number to print.
 */
export function uniformBazaOf(
  items: { bazaUsd: number | null; bazaBasis: BazaBasis | null }[],
): { bazaUsd: number; bazaBasis: BazaBasis } | null {
  if (items.length === 0) return null;
  const first = items[0]!;
  if (first.bazaUsd === null || first.bazaBasis === null) return null;
  for (const it of items) {
    if (it.bazaUsd !== first.bazaUsd || it.bazaBasis !== first.bazaBasis) return null;
  }
  return { bazaUsd: first.bazaUsd, bazaBasis: first.bazaBasis };
}
