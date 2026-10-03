/**
 * The names the audit trail prints.
 *
 * An audit row records COLUMNS, so the History tab has always shown
 * `nextActionAt` and `boxWeightKg` to a reader who has never seen the schema.
 * This is the translation, and it is a literal map on purpose: the key handed
 * to `t()` is built at runtime, which `tests/unit/i18n-keys.test.ts` cannot
 * see, so the map itself is what `audit-fields.test.ts` anchors against the
 * bundles (the `BRIDGE_LABELS` pattern, DECISIONS #163).
 *
 * A column that is not here prints its own name. That is deliberate: a wrong
 * label on an audit line is worse than a technical one, and this list only has
 * to cover what the seven cards with a History tab actually record.
 */
export const AUDIT_FIELD_LABELS: Record<string, string> = {
  // Who and what it is called
  name: 'name',
  fullName: 'name',
  title: 'title',
  label: 'title',
  company: 'company',
  clientCode: 'clientCode',
  code: 'code',
  username: 'username',
  description: 'description',

  // Contact
  phone: 'phone',
  phones: 'phone',
  locale: 'locale',
  password: 'password',
  messengerNote: 'messengerNote',

  // The funnel
  stageId: 'stage',
  stage: 'stage',
  sourceId: 'source',
  source: 'source',
  ownerId: 'owner',
  salesManagerId: 'owner',
  lostReason: 'lostReason',
  nextActionAt: 'nextAction',
  nextActionNote: 'nextActionNote',

  // Money
  amount: 'amount',
  currency: 'currency',
  // The lead's service quote (round 71) — same words as the deal's numbers.
  quotedAmount: 'amount',
  quotedCurrency: 'currency',
  quotedVolumeM3: 'volumeM3',
  quotedWeightKg: 'weightKg',
  discount: 'discount',
  discountReason: 'discountReason',
  rateToUsd: 'rateToUsd',

  // Cargo
  volumeM3: 'volumeM3',
  totalVolumeM3: 'volumeM3',
  weightKg: 'weightKg',
  totalWeightKg: 'weightKg',
  boxWeightKg: 'boxWeightKg',
  boxCount: 'boxCount',
  boxLengthCm: 'lengthCm',
  boxWidthCm: 'widthCm',
  boxHeightCm: 'heightCm',
  lengthCm: 'lengthCm',
  widthCm: 'widthCm',
  heightCm: 'heightCm',
  productNameRu: 'productNameRu',
  productNameZh: 'productNameZh',
  tnvedCode: 'tnvedCode',
  lines: 'lines',

  // Where and who else
  clientId: 'client',
  client: 'client',
  warehouseId: 'warehouse',
  warehouse: 'warehouse',
  warehouses: 'warehouses',
  // A truck's receiving warehouse, changed on the road (the reroute round).
  destWarehouseId: 'destination',
  typeId: 'type',
  deal: 'deal',
  dealId: 'deal',
  partnerId: 'partner',

  // QR-siz qabul (0112): the lot's marker, and who physically received an
  // office-entered prixod, on which day. `factoryBarcode` is retired (DECISIONS
  // #1224) and nothing writes it now; the label stays because audit rows from
  // 2026-09-28/29 still carry the key and the history tab must name it.
  qrSkipped: 'qrSkipped',
  factoryBarcode: 'factoryBarcode',
  receivedByUserId: 'receivedBy',
  receivedByName: 'receivedBy',
  receivedAt: 'receivedAt',
  // …and what the office's counts and the QR-siz stickers did to a prixod
  // (review ui-4): the lot grown or taken back by a count, the stickers a
  // re-mark took back, and a QR-siz sticker run printed at a warehouse.
  lotGrown: 'lotGrown',
  lotShrunk: 'lotShrunk',
  liveBoxes: 'liveBoxes',
  qrReverted: 'qrReverted',
  qrRevertedCodes: 'qrRevertedCodes',
  qrless: 'qrSkipped',
  count: 'boxCount',
  boxes: 'boxes',
  at: 'warehouse',
  // A manager named on a client that had none (0117): the client's unstamped
  // cargo moved to them — `stampUnattributedCargo`'s one audit line.
  cargoStampedTo: 'cargoStampedTo',
  receipts: 'receipts',
  // Lot tarkibi (0122): the paper composition a VED or logist stated against
  // a document, and the per-line TNVED codes typed on the Bojxona tab.
  lotComposition: 'lotComposition',
  lotCompositionCodes: 'lotCompositionCodes',
  // «Yuk ma'lumoti tekshirildi» (0123): what a person confirmed with the
  // client, and the note they left.
  lotCheck: 'lotCheck',
  lotCheckNote: 'lotCheckNote',

  // Housekeeping
  note: 'note',
  notes: 'note',
  reason: 'reason',
  active: 'active',
  // Whether a person signs in at all (0120) — the conversion's own line.
  loginEnabled: 'loginEnabled',
  status: 'status',
  order: 'order',
  roles: 'roles',
  grants: 'grants',
  dueAt: 'dueAt',
  date: 'date',
};

/** The domains an audit value can point INTO (round 100, owner's item 4). */
export type AuditRefKind =
  | 'stage'
  | 'user'
  | 'client'
  | 'warehouse'
  | 'source'
  | 'deal'
  | 'partner';

/**
 * Which recorded columns hold a REFERENCE rather than a value.
 *
 * An audit row records what the form posted, and for a picker that is an id —
 * so the History tab printed `stage: 4f2a… → 91bc…` to a reader who was told
 * it is «Aziz changed weight 25 → 28». The tab looks these up and prints the
 * thing's NAME, with the raw id kept in the tooltip.
 *
 * The stored vocabulary is MIXED on purpose: older writers put codes and
 * names in the same columns (`warehouse: 'YW'`), so only a uuid-shaped value
 * is ever looked up and everything else passes through untouched. A uuid the
 * lookup cannot find (a deleted stage, a foreign table's id under a shared
 * key) also passes through — a raw id is honest, a wrong name is not.
 */
export const AUDIT_FIELD_REFS: Record<string, AuditRefKind> = {
  stageId: 'stage',
  stage: 'stage',
  ownerId: 'user',
  salesManagerId: 'user',
  clientId: 'client',
  client: 'client',
  warehouseId: 'warehouse',
  warehouse: 'warehouse',
  destWarehouseId: 'warehouse',
  sourceId: 'source',
  source: 'source',
  deal: 'deal',
  dealId: 'deal',
  partnerId: 'partner',
  receivedByUserId: 'user',
  cargoStampedTo: 'user',
};

/** Only a uuid is looked up; codes and names in the same columns pass through. */
export function isUuidShaped(value: unknown): value is string {
  return (
    typeof value === 'string' &&
    /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(value)
  );
}

/** Every uuid a change list points at, by domain. Pure — the tab's collector. */
export function collectAuditRefs(
  changes: { key: string; before: unknown; after: unknown }[],
): Map<AuditRefKind, Set<string>> {
  const wanted = new Map<AuditRefKind, Set<string>>();
  for (const change of changes) {
    const kind = AUDIT_FIELD_REFS[change.key];
    if (!kind) continue;
    for (const value of [change.before, change.after]) {
      if (!isUuidShaped(value)) continue;
      const set = wanted.get(kind) ?? new Set<string>();
      set.add(value);
      wanted.set(kind, set);
    }
  }
  return wanted;
}

const isScalar = (v: unknown): v is string | number | boolean =>
  typeof v === 'string' || typeof v === 'number' || typeof v === 'boolean';

/**
 * One recorded value as the History tab prints it. A list of plain values is
 * a list; a structured record (a count's growth, a sticker run) reads as its
 * own facts — «add: 3 · codes: …-06, …-07 · reason: …» — with the ids it
 * carries left out: they are for the machine, and a uuid in the middle of a
 * sentence is what the owner called «qandaydur codelar» (review ui-4). Any
 * other shape keeps its JSON, which is honest if not pretty.
 */
export function formatAuditValue(value: unknown): string {
  if (value === null || value === undefined || value === '') return '∅';
  if (Array.isArray(value) && value.every(isScalar)) return value.length ? value.join(', ') : '∅';
  if (typeof value === 'object' && !Array.isArray(value)) {
    const parts = Object.entries(value as Record<string, unknown>)
      .filter(([, v]) => v !== null && v !== undefined && v !== '' && !isUuidShaped(v))
      .map(([k, v]) => `${k}: ${Array.isArray(v) && v.every(isScalar) ? v.join(', ') : isScalar(v) ? String(v) : JSON.stringify(v)}`);
    return parts.length ? parts.join(' · ') : '∅';
  }
  if (typeof value === 'object') return JSON.stringify(value);
  return String(value);
}
