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
  typeId: 'type',
  deal: 'deal',
  dealId: 'deal',
  partnerId: 'partner',

  // Housekeeping
  note: 'note',
  notes: 'note',
  reason: 'reason',
  active: 'active',
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
  sourceId: 'source',
  source: 'source',
  deal: 'deal',
  dealId: 'deal',
  partnerId: 'partner',
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
