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
  // LTL / FTL (0135): the lead's, the deal's and the prixod's mode.
  freightMode: 'freightMode',
  discount: 'discount',
  discountReason: 'discountReason',
  rateToUsd: 'rateToUsd',

  // Cargo
  // The lots a prixod was created with (`confirmReceipt`): printed as
  // «A 化妆品 × 10 📦», see `formatAuditValue`.
  lots: 'lots',
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
  // …and changed BEFORE it left, under its own key so the road reroute's
  // «told» readers never take it for a «keladi» (docs/NARX-VA-RAQAM.md §3.2.8);
  // and a cancelled truck's number given back (§3.2.6) — with the number the
  // release freed, which in the plate case no other key on the row names.
  destBeforeDeparture: 'destBeforeDeparture',
  released: 'released',
  number: 'number',
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
  // The CLIENT's own ✅ / ❌ in Telegram (0144, per lot — `clientConfirm:A`),
  // a dispute a person closed, and the question a person sent from the card.
  clientConfirm: 'clientConfirm',
  // A file a person sent to the prixod through the staff bot (0146, per file
  // — `fileAdded:<message>`).
  fileAdded: 'fileAdded',
  // A removed file's own line on its parent's History (`removedFile`, history.ts).
  fileName: 'fileName',
  clientAsk: 'clientAsk',
  // The VED queue's lines on the CARD (lead or deal): a request opened, taken,
  // released, handed back, answered with a price, re-opened for a correction
  // (docs/VED-TARIX.md). Each value is the request's id — printed raw, which
  // is honest; the taker is a person and is named. The internal note is
  // never among them: it is the request's own audit row, not the card's.
  calcRequested: 'calcRequested',
  calcRequest: 'calcRequest',
  calcTakenBy: 'calcTakenBy',
  calcReleased: 'calcReleased',
  calcReturned: 'calcReturned',
  calcDone: 'calcDone',
  calcRecalc: 'calcRecalc',
  section: 'calcSection',
  items: 'itemCount',
  // The request's m³ was SUMMED from its lines at the INSERT, nobody typed it
  // (docs/SAKKIZ-R2.md §8.2.3) — the one fact of provenance ever recorded.
  volumeFromLines: 'volumeFromLines',
  // Yo'lkira tarifi bo'yicha taqsimlash (0132): how a bill is split, and the
  // tariff column it froze. The column prints its CODE («cn → kashgar») —
  // short lowercase words, honest as they stand. Warehouse history rows of
  // 2026-10-14/15 carry `tariffZone` too (his 2c, retired by his 1a): they
  // still print by this label.
  allocationBasis: 'allocationBasis',
  tariffZone: 'tariffZone',
  tariffFrom: 'tariffFrom',
  // The frozen rows themselves, as one line — so a same-date re-freeze of new
  // prices (zone and date unchanged) is a visible change, not an empty one.
  tariffBands: 'tariffBands',

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
 * A recorded key's label and, for a per-item key, its item: `lotCheck:A` is
 * the `lotCheck` label for lot A (0123). A writer that records one change per
 * ITEM under one entity must carry the item in the key — the History tab nets
 * a run of edits per key, so a shared key collapsed «ticked A, B, C» into one
 * line about C. Only a base the map knows is split, so an unknown key with a
 * colon still prints as itself.
 */
export function auditFieldLabel(key: string): { label: string | null; item: string | null } {
  if (AUDIT_FIELD_LABELS[key]) return { label: AUDIT_FIELD_LABELS[key]!, item: null };
  const at = key.indexOf(':');
  if (at > 0 && AUDIT_FIELD_LABELS[key.slice(0, at)]) {
    const base = key.slice(0, at);
    return { label: AUDIT_FIELD_LABELS[base]!, item: ITEM_NOT_PRINTED.has(base) ? null : key.slice(at + 1) };
  }
  return { label: null, item: null };
}

/**
 * Per-item keys whose item is there for UNIQUENESS only and means nothing to
 * a reader: `fileAdded:<telegram message id>` — the History would print
 * «Fayl qo'shildi · 913742», a code of the kind the owner asked to have out
 * of it (round 100, item 4). The value («invoice.pdf · Telegram») names the
 * file; the key only keeps one file's line from netting into the next.
 */
const ITEM_NOT_PRINTED: ReadonlySet<string> = new Set(['fileAdded']);

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
  // Who took a calculation off the queue — a person, so named.
  calcTakenBy: 'user',
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

/** A lot as `confirmReceipt` records it: a carton count beside a name or a letter. */
const isLotSummary = (v: unknown): v is { letter?: unknown; zh?: unknown; boxes: number; qrSkipped?: unknown } =>
  typeof v === 'object' &&
  v !== null &&
  !Array.isArray(v) &&
  typeof (v as { boxes?: unknown }).boxes === 'number' &&
  (isScalar((v as { zh?: unknown }).zh) || isScalar((v as { letter?: unknown }).letter));

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
  // The lots a prixod was born with — `[{letter, zh, boxes}]`, the one list of
  // records on the busiest card there is. It printed as raw JSON under the
  // untranslated word «lots:» at the foot of every prixod (the owner's
  // «hamma narsa har xil joyda» round, docs/PRIXOD-KARTA.md).
  if (Array.isArray(value) && value.length > 0 && value.every(isLotSummary)) {
    return value
      .map((lot) =>
        [isScalar(lot.letter) ? String(lot.letter) : null, isScalar(lot.zh) ? String(lot.zh) : null, `× ${String(lot.boxes)} 📦`, lot.qrSkipped === true ? '🏷' : null]
          .filter((part): part is string => part !== null && part !== '')
          .join(' '),
      )
      .join(' · ');
  }
  if (typeof value === 'object' && !Array.isArray(value)) {
    const parts = Object.entries(value as Record<string, unknown>)
      .filter(([, v]) => v !== null && v !== undefined && v !== '' && !isUuidShaped(v))
      .map(([k, v]) => `${k}: ${Array.isArray(v) && v.every(isScalar) ? v.join(', ') : isScalar(v) ? String(v) : JSON.stringify(v)}`);
    return parts.length ? parts.join(' · ') : '∅';
  }
  if (typeof value === 'object') return JSON.stringify(value);
  return String(value);
}
