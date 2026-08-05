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
