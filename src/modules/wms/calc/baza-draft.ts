/**
 * One row's baza PAIR as the grid drafts it — the amount box and the unit
 * select edit one price, so they draft together (a basis is part of the
 * price). Pure, so the rule is a function a test calls (#166), not a pattern
 * restated in a component.
 *
 * The grid used to draft a unit pick as TWO updates: «the amount as it stands»
 * first, then the unit. The first matched the server while no unit was drafted
 * yet, so it cleaned itself away — and the second then found no amount beside
 * it and was cleaned too. A unit changed on its own therefore snapped back on
 * every row, whatever the code: the owner's «edinitsa izmereniyani
 * o'zgartirib bo'lmayabti … ved hodimini o'zi o'zgartira olmayabti»
 * (2026-10-06), latent since VED 2.0 phase 3.
 */
export interface BazaHalves<B extends string = string> {
  bazaValue?: string;
  bazaBasis?: B;
}

/**
 * Apply one edit and answer the halves the draft keeps. `{}` means «no
 * draft»: the pair equals what the server holds (the dirty count must mean
 * «cells the save will send»). `server` is what the row SHOWS — its stored
 * amount as typed, and its stored basis or the law's default (#171).
 */
export function editBazaPair<B extends string>(
  draft: BazaHalves<B>,
  field: keyof BazaHalves<B>,
  raw: string,
  server: { bazaValue: string; bazaBasis: B },
): BazaHalves<B> {
  const next = { ...draft, [field]: raw } as BazaHalves<B>;
  // A unit picked alone carries the amount as it stands, so the save posts a
  // coherent pair and the live figure prices it.
  if (next.bazaValue === undefined) next.bazaValue = server.bazaValue;
  const basis = next.bazaBasis ?? server.bazaBasis;
  if (next.bazaValue === server.bazaValue && basis === server.bazaBasis) return {};
  return next;
}
