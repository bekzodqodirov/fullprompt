/**
 * Who may say a job is FTL, and who may take it back (0135, the owner's 2a:
 * «sotuvchi o'z bitimini FTL deb belgilay oladi, FTL'ni LTL'ga esa faqat
 * admin, logist yoki buxgalter qaytaradi»).
 *
 * THE OFFICE = `plans.manage` (the logist; admin and super_admin hold
 * everything) OR `finance.reports` (the accountant) — and UNSCOPED. Not
 * `finance.manage`: the VED holds it and law 4 keeps him out of a seller's
 * money (#790); `finance.reports` is the key that already leaves him out
 * (upsaleScopeFor, calc/control-scope.ts). Not a warehouse-scoped person even
 * if somebody ticks «Rejalar» for a warehouse role one day
 * (tracking/border-queue.ts's rule): deciding a seller's KPI is not a Kashgar
 * operator's power. Permission codes, never role names (#170) — the matrix is
 * his to edit, and a test walks every SEEDED role through this.
 *
 * Everybody else (the seller) may only ever turn a record of HIS OWN into FTL:
 * it takes cargo out of his KPI, so the incentive points the other way, and
 * the office hears about it (`FtlMarked`) because dropping a light lot can
 * also LIFT a month's density band. «Own» is decided by each service on the
 * record it holds: the lead/deal owner before AND after the save, the prixod's
 * seller STAMP (the column the KPI groups by).
 *
 * The branded `FtlDoor` is what the services demand (CountDoor's idiom): it is
 * minted only here, so a service handed a hand-built object refuses at compile
 * time. No project imports — the forms, the services and the tests read it.
 */

export const FTL_OFFICE_PERMISSIONS = ['plans.manage', 'finance.reports'] as const;

export interface FtlActor {
  id: string;
  permissions: { has(code: string): boolean };
  warehouseScoped: boolean;
}

/** The boolean form, for a screen deciding what to draw. */
export function mayRevertFtl(actor: Omit<FtlActor, 'id'>): boolean {
  return !actor.warehouseScoped && FTL_OFFICE_PERMISSIONS.some((code) => actor.permissions.has(code));
}

declare const FTL_DOOR: unique symbol;
export type FtlDoor = {
  readonly [FTL_DOOR]: true;
  readonly actorId: string;
  /** The office: may turn FTL back to LTL, and may mark anybody's record. */
  readonly office: boolean;
};

export function ftlDoorFor(actor: FtlActor): FtlDoor {
  return Object.freeze({ actorId: actor.id, office: mayRevertFtl(actor) }) as unknown as FtlDoor;
}

/**
 * The refusals a door gives, in words every screen prints (four bundles,
 * `ftl.errors.*`). A literal union so a test can read it and demand a sentence
 * for each (#163 — a key in no bundle throws at render).
 */
export type FtlRefusal =
  /** FTL → LTL, or changing who owns an FTL record, by somebody who is not the office. */
  | 'ftl_office_only'
  /** A seller marking a record that is not his. */
  | 'ftl_not_yours'
  /** The prixod's month was already PAID as KPI to its seller (6a) — it is frozen. */
  | 'kpi_paid'
  /** The prixod's seller stamp moved while the press was being decided — press again. */
  | 'stamp_moved'
  | 'not_found'
  /** The 0135 tables are not there yet (#472). */
  | 'server_behind';

export const FTL_REFUSALS: readonly FtlRefusal[] = [
  'ftl_office_only',
  'ftl_not_yours',
  'kpi_paid',
  'stamp_moved',
  'not_found',
  'server_behind',
];

export const isFtlRefusal = (code: unknown): code is FtlRefusal =>
  typeof code === 'string' && (FTL_REFUSALS as readonly string[]).includes(code);

export class FtlError extends Error {
  constructor(
    public readonly code: FtlRefusal,
    /** For `kpi_paid`: the Tashkent month (`YYYY-MM`) and the seller whose KPI froze it. */
    public readonly detail?: { month?: string; sellerName?: string | null },
  ) {
    super(code);
  }
}

/**
 * May `door` move a lead/deal from `before` to `after`? Pure — the services
 * ask it on the values they will WRITE, never on what a form posted.
 * `ownerBefore`/`ownerAfter` are the record's owner on either side of the
 * save (a seller handing an FTL record to a colleague is a mark on the
 * colleague's KPI: office only).
 */
export function leadDealMoveRefusal(
  door: FtlDoor,
  move: { before: boolean; after: boolean; ownerBefore: string | null; ownerAfter: string | null },
): FtlRefusal | null {
  if (door.office) return null;
  if (move.before && !move.after) return 'ftl_office_only';
  if ((move.before || move.after) && move.ownerBefore !== move.ownerAfter) return 'ftl_office_only';
  if (!move.before && move.after) {
    if (move.ownerBefore !== door.actorId || move.ownerAfter !== door.actorId) return 'ftl_not_yours';
  }
  return null;
}
