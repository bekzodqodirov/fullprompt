import { nameKey } from '../receipts/composition-math';

/**
 * The customs invoice's rows as DATA (the owner's item 6, 2026-11-10;
 * docs/TARKIB-TUZATISH.md §6) — pure, so the sheet the VED downloads and the
 * dialog that asks him «qo'shaymi?» are computed from ONE list by ONE rule
 * (#513), and the arithmetic can be held to its totals without a database.
 *
 * His words: «agar TNVED kod 1 xil bo'lsa, nomi ham 1 xil bo'lsa, qo'shib
 * yuborsin va 1 pozitsiya qilish kerak; agarda TNVED kod bir xil bo'lib nomi
 * farq qilsa — alohida oyna ochilsin … qo'shaymi yo'qmi deb so'rasin va
 * invoice bersin. … A dan keyin … shu TNVED kod qaysi karobkalar, ya'ni qaysi
 * klientni qaysi prixodiligini yozib ket. Agarda 1 prixodda 2-3-4 ta tarkib
 * bo'lsa va ular invoiceda alohida qatorda turgan bo'lsa … qizilda belgilab
 * qo'y — shu karobkani ochganimda 3-4 TNVED koddagi tovardan birini ochishim
 * mumkin.»
 *
 * SOURCE rows are exactly what the builder printed before this module: one
 * per lot with no tarkib, one per printed tarkib line. POSITIONS are what the
 * sheet prints now.
 *
 * Two things a merge never does by itself (the papers judge, §9.4):
 *  · take «шт» off the paper — a tarkib line that counts pieces and a lot
 *    with no tarkib (always «кг») can share a code AND a name; fused, the
 *    count would leave the quantity column with nobody asked (his own 3a of
 *    2026-10-01: «a composed line prints шт»). The UNIT is part of the
 *    automatic key, so such a pair is a group and is asked;
 *  · cross a customs choice — inside one truck some prixods are cleared by
 *    the client's own firm or by another firm (`effectiveCustoms`), and their
 *    places and kilos must stay removable from OUR invoice. Every row carries
 *    its prixod's `scope`; rows merge only inside one.
 *
 * Figures are INTEGERS here — kilos in tenths (every source row is already a
 * tenth), pieces and places whole — so a merged position is a sum and the
 * sheet's SUM(netto), SUM(brutto) and SUM(places) are what they were, by
 * construction, not by a rounding that happens to agree.
 */

export interface InvoiceLot {
  lotId: string;
  /**
   * What the carton's sticker says, as the papers say it: client code (or
   * marking) + «-» + lot letter. NOT unique — the letter counter is per
   * warehouse and cycles — so everything below is keyed by `lotId`, and only
   * the RED decision is taken per label string (the person at the carton has
   * the sticker and nothing else).
   */
  label: string;
  /** The tarkib's line count as this paper reads it (0 = the lot has none). */
  lines: number;
}

export interface InvoiceSourceRow {
  lot: InvoiceLot;
  name: string;
  /** '' = no TNVED code yet: such a row is never merged and never asked. */
  code: string;
  unit: 'шт' | 'кг';
  /** The pieces a «шт» row counts; null on a «кг» row. */
  pieces: number | null;
  /** `'part'` = the line's goods ride inside another line's places. */
  places: number | 'part' | null;
  kgTenths: number;
  /** The estimate note of the row's lot on this paper, or null when exact. */
  estimate: string | null;
  /**
   * WHO clears this row's prixod through customs, as an opaque token: equal
   * tokens = one declaration's cargo. Rows of different scopes are never one
   * position, automatically or by answer.
   */
  scope: string;
}

export interface InvoicePosition {
  name: string;
  code: string;
  unit: 'шт' | 'кг';
  /** Pieces for «шт», kilos for «кг». */
  quantity: number;
  places: number | 'part' | null;
  kgTenths: number;
  /** The lots behind the position, each once, in slot order. */
  lots: InvoiceLot[];
  estimates: { label: string; note: string }[];
  /** Pieces that members stated and a «кг» position cannot carry — said in a note, never lost. */
  piecesDropped: { label: string; pieces: number }[];
  /** Indexes into the source rows. */
  members: number[];
}

export interface InvoiceMergeGroup {
  /** `<code>.<sig>` — what the address names this group by. */
  key: string;
  code: string;
  /** The customs scope the group stands in (a code may hold one group per scope). */
  scope: string;
  /** The names (and units) this answer is about — a change in them asks again. */
  sig: string;
  /** One entry per position the code holds when nothing asked is merged. */
  names: {
    name: string;
    unit: 'шт' | 'кг';
    quantity: number;
    kgTenths: number;
    labels: string[];
  }[];
  /** What ONE merged position would print. */
  merged: { name: string; unit: 'шт' | 'кг'; quantity: number; kgTenths: number; mixedUnits: boolean };
}

/**
 * The answers a download carries: the groups to merge, each named by its key
 * (`<code>.<sig>` — the signature it was LISTED under), or «all» with the
 * whole list's fingerprint.
 */
export interface InvoiceMergeAnswer {
  all: string | null;
  picks: ReadonlySet<string>;
}

export const NO_MERGE: InvoiceMergeAnswer = { all: null, picks: new Set() };

export interface InvoiceModel {
  positions: InvoicePosition[];
  /** The codes that hold two or more positions (inside one scope) — what the dialog lists. Empty = nothing to ask. */
  groups: InvoiceMergeGroup[];
  /** The whole list's fingerprint ('' when there is no group) — what `merge=all.<fp>` names. */
  fp: string;
  /** Label strings to print red: a lot of several goods whose goods do not all stand in ONE position. */
  redLabels: Set<string>;
}

/**
 * FNV-1a, 32 bits, as 8 hex digits — a STALENESS token, not a secret: it
 * says «these are the names you were shown». Pure and tiny on purpose: this
 * module runs in the browser too (the dialog), where `node:crypto` is not.
 */
export function fnv1a(text: string): string {
  let hash = 0x811c9dc5;
  // UTF-8 bytes, so a Cyrillic or Chinese name hashes the same everywhere.
  for (const byte of new TextEncoder().encode(text)) {
    hash ^= byte;
    hash = Math.imul(hash, 0x01000193);
  }
  return (hash >>> 0).toString(16).padStart(8, '0');
}

/**
 * A group's signature: its scope, its code and its (name, unit) pairs,
 * SORTED — the order rows arrive in must not change it, and a row that turns
 * from «кг» to «шт» (a count typed since the list was shown) must.
 */
export function groupSig(
  scope: string,
  code: string,
  members: readonly { name: string; unit: 'шт' | 'кг' }[],
): string {
  const pairs = [...new Set(members.map((m) => `${nameKey(m.name)}\u0002${m.unit}`))].sort();
  return fnv1a(`${scope}\u0001${code}\u0001${pairs.join('\u0001')}`);
}

/** The names of a merged group: each distinct name ONCE (one name in two units is still one name), in slot order. */
function mergedName(names: readonly string[]): string {
  const seen = new Set<string>();
  const out: string[] = [];
  for (const name of names) {
    const key = nameKey(name);
    if (seen.has(key)) continue;
    seen.add(key);
    out.push(name);
  }
  return out.join(', ');
}

function sumPlaces(places: readonly (number | 'part' | null)[]): number | 'part' | null {
  const numeric = places.filter((p): p is number => typeof p === 'number');
  if (numeric.length > 0) return numeric.reduce((a, b) => a + b, 0);
  return places.includes('part') ? 'part' : null;
}

/** One position out of source rows that already share a scope and a code (the automatic step keys on the name and the unit too). */
function fold(source: readonly InvoiceSourceRow[], members: readonly number[], name: string): InvoicePosition {
  const rows = members.map((i) => source[i]!);
  const first = rows[0]!;
  const kgTenths = rows.reduce((sum, r) => sum + r.kgTenths, 0);
  const allPieces = rows.every((r) => r.unit === 'шт' && r.pieces !== null);
  const lots: InvoiceLot[] = [];
  const estimates: { label: string; note: string }[] = [];
  for (const row of rows) {
    if (!lots.some((lot) => lot.lotId === row.lot.lotId)) lots.push(row.lot);
    if (row.estimate && !estimates.some((e) => e.label === row.lot.label && e.note === row.estimate)) {
      estimates.push({ label: row.lot.label, note: row.estimate });
    }
  }
  return {
    name,
    code: first.code,
    unit: allPieces ? 'шт' : 'кг',
    quantity: allPieces ? rows.reduce((sum, r) => sum + (r.pieces ?? 0), 0) : kgTenths / 10,
    places: sumPlaces(rows.map((r) => r.places)),
    kgTenths,
    lots,
    estimates,
    // A «кг» position cannot carry a count; the ones that were stated are
    // named beside the quantity instead of vanishing (an uncomposed lot is
    // always «кг», so this is the common case, not an edge).
    piecesDropped: allPieces
      ? []
      : rows.filter((r) => r.unit === 'шт' && r.pieces !== null).map((r) => ({ label: r.lot.label, pieces: r.pieces! })),
    members: [...members],
  };
}

/**
 * Source rows → positions.
 *
 * (1) AUTOMATIC: rows of one customs scope with the same non-empty code, the
 * same name (`nameKey`) AND the same unit are one position, whoever's cargo
 * they are; the first member keeps the slot and the spelling. No code → its
 * own position, always.
 * (2) ASKED: a code that still holds two or more positions inside one scope
 * is a group — other names, or one name in «шт» and in «кг»; it collapses
 * into its first position's slot only when the answer names it with the
 * signature it has NOW (or says «all» with the whole list's fingerprint) —
 * names that changed since the list was shown are never merged blind. A
 * merged group is named with its distinct names, «, »-joined in slot order.
 */
export function invoiceModel(
  source: readonly InvoiceSourceRow[],
  answer: InvoiceMergeAnswer = NO_MERGE,
): InvoiceModel {
  // (1) the automatic step.
  const slots: { scope: string; code: string; name: string; unit: 'шт' | 'кг'; members: number[] }[] = [];
  const slotOf = new Map<string, number>();
  source.forEach((row, i) => {
    const key =
      row.code === '' ? null : `${row.scope}\u0000${row.code}\u0000${nameKey(row.name)}\u0000${row.unit}`;
    const at = key === null ? undefined : slotOf.get(key);
    if (at !== undefined) {
      slots[at]!.members.push(i);
      return;
    }
    if (key !== null) slotOf.set(key, slots.length);
    slots.push({ scope: row.scope, code: row.code, name: row.name, unit: row.unit, members: [i] });
  });

  // (2) the groups, in the order their first position stands — a code inside ONE scope.
  const groupOf = (slot: { scope: string; code: string }) => `${slot.scope}\u0000${slot.code}`;
  const byGroup = new Map<string, number[]>();
  slots.forEach((slot, at) => {
    if (slot.code === '') return;
    byGroup.set(groupOf(slot), [...(byGroup.get(groupOf(slot)) ?? []), at]);
  });
  const groups: InvoiceMergeGroup[] = [];
  const keyOfGroup = new Map<string, string>();
  for (const [id, at] of byGroup) {
    if (at.length < 2) continue;
    const first = slots[at[0]!]!;
    const parts = at.map((i) => fold(source, slots[i]!.members, slots[i]!.name));
    const whole = fold(
      source,
      at.flatMap((i) => slots[i]!.members),
      mergedName(at.map((i) => slots[i]!.name)),
    );
    const sig = groupSig(
      first.scope,
      first.code,
      at.map((i) => slots[i]!),
    );
    const key = `${first.code}.${sig}`;
    keyOfGroup.set(id, key);
    groups.push({
      key,
      code: first.code,
      scope: first.scope,
      sig,
      names: parts.map((p) => ({
        name: p.name,
        unit: p.unit,
        quantity: p.quantity,
        kgTenths: p.kgTenths,
        labels: [...new Set(p.lots.map((lot) => lot.label))],
      })),
      merged: {
        name: whole.name,
        unit: whole.unit,
        quantity: whole.quantity,
        kgTenths: whole.kgTenths,
        mixedUnits: new Set(parts.map((p) => p.unit)).size > 1,
      },
    });
  }
  const fp = groups.length === 0 ? '' : fnv1a(groups.map((g) => g.key).sort().join(','));

  // …and the answers that still hold.
  const mergeAll = answer.all !== null && fp !== '' && answer.all === fp;
  const merged = new Set(
    [...keyOfGroup].filter(([, key]) => mergeAll || answer.picks.has(key)).map(([id]) => id),
  );
  const positions: InvoicePosition[] = [];
  const done = new Set<string>();
  slots.forEach((slot) => {
    const id = groupOf(slot);
    if (slot.code !== '' && merged.has(id)) {
      if (done.has(id)) return;
      done.add(id);
      const at = byGroup.get(id)!;
      positions.push(
        fold(
          source,
          at.flatMap((i) => slots[i]!.members),
          mergedName(at.map((i) => slots[i]!.name)),
        ),
      );
      return;
    }
    positions.push(fold(source, slot.members, slot.name));
  });

  return { positions, groups, fp, redLabels: redLabelsOf(source, positions) };
}

/**
 * RED = «opening a carton with this sticker you may find another good»: a
 * lot whose tarkib has two or more lines that do NOT all stand in one
 * position of this invoice — because they stand in several rows, or because
 * some of them are not on this truck at all (a partial truck: nobody knows
 * which carton is which). A lot of several goods whose rows all merged into
 * one position is one good to customs and stays black.
 *
 * Decided per LABEL STRING over the whole paper: two lots can carry one
 * label, and the same sticker red in one row and black in the next would be
 * a riddle to the person holding the carton.
 */
function redLabelsOf(source: readonly InvoiceSourceRow[], positions: readonly InvoicePosition[]): Set<string> {
  const printed = new Map<string, number>();
  for (const row of source) printed.set(row.lot.lotId, (printed.get(row.lot.lotId) ?? 0) + 1);
  const standsIn = new Map<string, number>();
  for (const position of positions) {
    for (const lot of position.lots) standsIn.set(lot.lotId, (standsIn.get(lot.lotId) ?? 0) + 1);
  }
  const red = new Set<string>();
  for (const row of source) {
    const { lotId, label, lines } = row.lot;
    if (lines >= 2 && ((printed.get(lotId) ?? 0) < lines || (standsIn.get(lotId) ?? 0) >= 2)) red.add(label);
  }
  return red;
}

/** The «Маркировка» cell of a position: its distinct labels in slot order, each flagged red or not. */
export function labelRuns(position: InvoicePosition, redLabels: ReadonlySet<string>): { text: string; red: boolean }[] {
  const seen = new Set<string>();
  const out: { text: string; red: boolean }[] = [];
  for (const lot of position.lots) {
    if (seen.has(lot.label)) continue;
    seen.add(lot.label);
    out.push({ text: lot.label, red: redLabels.has(lot.label) });
  }
  return out;
}

/**
 * The name cell's note of an estimated position. One lot → its note as the
 * old single row printed it. Several lots → EVERY note with its lot in front:
 * «33 из 100 кор.» with no lot named, beside three labels and 22 places,
 * would read as a statement about the whole row.
 */
export function positionEstimateNote(position: Pick<InvoicePosition, 'lots' | 'estimates'>): string | null {
  if (position.estimates.length === 0) return null;
  if (position.lots.length === 1) return position.estimates[0]!.note;
  return position.estimates.map((e) => `${e.label}: ${e.note}`).join('; ');
}

/** The quantity cell's note of a «кг» position that swallowed counted rows: «шт: GS777-A 500; GS812-B 20». */
export function positionPiecesNote(position: Pick<InvoicePosition, 'piecesDropped'>): string | null {
  if (position.piecesDropped.length === 0) return null;
  return `шт: ${position.piecesDropped.map((p) => `${p.label} ${p.pieces}`).join('; ')}`;
}

const PICK = /^(\d{4,10})\.([0-9a-f]{8})$/;
const ALL = /^all\.([0-9a-f]{8})$/;
/** How many `code.sig` pairs one address may carry — the signed download link caps the path at 2048 characters. */
export const MERGE_PICKS_MAX = 90;

/**
 * The `merge` parameter of the invoice's address, read as a forged post:
 * `all.<fp>` or a comma list of `<code>.<sig>` — anything else is dropped,
 * never an error, and never more than `MERGE_PICKS_MAX` pairs.
 */
export function parseMergeParam(raw: string | null | undefined): InvoiceMergeAnswer {
  const picks = new Set<string>();
  let all: string | null = null;
  for (const token of String(raw ?? '').split(',').slice(0, MERGE_PICKS_MAX + 1)) {
    const text = token.trim();
    const whole = ALL.exec(text);
    if (whole) {
      all = whole[1]!;
      continue;
    }
    if (PICK.test(text) && picks.size < MERGE_PICKS_MAX) picks.add(text);
  }
  return { all, picks };
}

/**
 * The query the download carries for the groups a person chose to merge
 * (by group KEY): '' for none, `?merge=all.<fp>` when it is every group (one
 * token, however many), else the keys. More than `MERGE_PICKS_MAX` chosen but
 * not all → null: the address cannot carry them, and the screen says so
 * instead of silently merging fewer.
 */
export function mergeQuery(model: Pick<InvoiceModel, 'groups' | 'fp'>, keys: ReadonlySet<string>): string | null {
  const chosen = model.groups.filter((g) => keys.has(g.key));
  if (chosen.length === 0) return '';
  if (chosen.length === model.groups.length) return `?merge=all.${model.fp}`;
  if (chosen.length > MERGE_PICKS_MAX) return null;
  return `?merge=${chosen.map((g) => g.key).join(',')}`;
}
