/**
 * The warehouse form's tariff-column field, read ONE way (docs/
 * YOLKIRA-TAQSIMOT.md §2.5). Pure, zero imports — the `coordField` idiom of
 * the same actions file — so the three answers are pinned with literals.
 *
 * «Absent» and «empty» are different answers and the difference is money: a
 * post that does not carry the field (a page rendered before 0132, or one
 * migration behind, where the select is not drawn) must LEAVE the mapping
 * alone, while «— tanlanmagan» deletes it. Reading absent as '' would clear
 * every warehouse's column on the first unrelated save (#171).
 */

/** What the tariff writer itself stores: trimmed and lowercased (`saveTariffBand`). */
export function normaliseZone(raw: string): string {
  return raw.trim().toLowerCase();
}

/** undefined = leave the mapping alone · null = delete it · string = this column. */
export function readTariffZoneField(fd: FormData): undefined | null | string {
  if (!fd.has('tariffZone')) return undefined;
  const raw = fd.get('tariffZone');
  if (typeof raw !== 'string') return undefined;
  const zone = normaliseZone(raw);
  return zone === '' ? null : zone;
}
