/**
 * What a crate's label says it is, in ONE place (0112, the owner's Q10 d: a
 * pallet is a crate — one CR- QR, one place).
 *
 * The PDF label embeds a SUBSET of the CJK font built from the strings it is
 * told it will draw (`renderer.ts` → `cjkSubsetFor`), and that list used to be
 * the literal 'ЯЩИК КАРКАС'. «ПАЛЛЕТ» has three letters that list does not
 * carry, and a glyph missing from the subset prints as a blank box with no
 * error anywhere (#788's shape). So the subset is built FROM this map, and
 * `tests/unit/crate-kind.test.ts` says so.
 *
 * ZERO imports: the browser's print sheet reads it as well as the PDF.
 */
export const CRATE_KINDS = ['yashik', 'karkas', 'palet'] as const;
export type CrateKind = (typeof CRATE_KINDS)[number];

export const CRATE_KIND_MARKER: Record<CrateKind, string> = {
  yashik: 'ЯЩИК',
  karkas: 'КАРКАС',
  palet: 'ПАЛЛЕТ',
};

/** The label's marker; a kind nobody knows prints as the oldest one. */
export function crateMarker(kind: string): string {
  return (CRATE_KIND_MARKER as Record<string, string>)[kind] ?? CRATE_KIND_MARKER.yashik;
}
