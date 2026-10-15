/**
 * «Shu zavoddan, shu mashinada» — what brought a lot to the warehouse it
 * stands in, as one value with one printed form.
 *
 * Until the factory-pickup closing round only a BATCH could be named: the
 * arrival rule (`arrivals.ts`) names a truck for a `batch` movement, and a
 * prixod received off a factory trip (`receipts.pickup_stop_id`, 0100) landed
 * with `cause = 'receipt'`, so every document filed it under «Принято на
 * складе / Received here». The owner's words (docs/ZAVOD-YOPISH.md, item 6):
 * «excelda ham boshqa joyda ham shu mashinada kelgan yuk bolib ko'rinishi
 * kerak shu zavotdan shu mashinada kelgan deb».
 *
 * Pure and free of the database on purpose: the client card's fold
 * (`inventory/client-cargo-fold.ts`) is decided with no database, and the
 * lenta prints a trip from its own row's META — each reads the label from
 * here, so no surface spells «ZR-00012 · factory · plate» by hand.
 */
export type ArrivalSource =
  /** `id` null only where a caller read the code alone (old fixtures, the pure tests). */
  | { kind: 'batch'; id: string | null; code: string }
  | {
      kind: 'pickup';
      /** The TRIP (`pickups.id`) — a block and a link are per truck, never per stop. */
      id: string;
      code: string;
      stopId: string;
      /** The stop's place on the trip — what orders a two-factory block's heading. */
      seq: number;
      factory: string;
      plate: string | null;
    };

/** What a label needs — a full source is one, and so is a lenta row's META. */
export type LabelSource =
  | { kind: 'batch'; code: string }
  | { kind: 'pickup'; code: string; factory: string | null; plate: string | null };

/**
 * The ONE printed form. A batch prints its code, as every surface always
 * has; a factory trip prints its code, the factory and the truck's plate —
 * «ZR-00012 · Yiwu toys · 01A123BC» — because «ZR-00012» alone tells the
 * agent and the office nothing a batch code does not, and the factory is
 * the half of the answer the owner asked for. A plate nobody typed is
 * omitted rather than printed as a dash.
 */
export function arrivalLabel(source: LabelSource): string {
  if (source.kind === 'batch') return source.code;
  return [source.code, source.factory, source.plate]
    .map((part) => part?.trim() ?? '')
    .filter(Boolean)
    .join(' · ');
}

/**
 * The block a lot is filed under — one per TRUCK. A batch by its id, falling
 * back to its code (a row read with no id — the pure tests, an old caller —
 * must not merge two different trucks into `batch:undefined`); a factory
 * trip by the TRIP id, so the cargo of its two stops is one block, as the
 * truck was one truck. '' = came on none.
 */
export function arrivalKey(source: ArrivalSource | undefined | null): string {
  if (!source) return '';
  return source.kind === 'batch' ? `batch:${source.id ?? source.code}` : `pickup:${source.id}`;
}
