import type { BazaBasis } from './pricing';

/**
 * Item 3 (phase 4): the CODE's law says the row's default baza basis, so the
 * VED only types the number («edinitsa izmereniya avtomatik» — the owner's
 * own sentence). Total over DutyUnit: dona/1000_dona price per piece and
 * default to the per-unit basis; sm³ stays per dona (#868 — nobody VALUES a
 * vehicle by displacement); a pure-advalor code keeps the old default.
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
