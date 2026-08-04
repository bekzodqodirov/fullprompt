/**
 * Which business objects may carry custom fields, and who may fill them in.
 *
 * The owner's requirement was that no business object be hard-coded. Two
 * things were: the list of objects (a CHECK constraint pinning custom fields
 * to leads and clients) and the permission to fill them in. The list now
 * lives here and is synced into `custom_entities`, so the database enforces it
 * without anyone editing SQL; a later phase adds the owner's own entities as
 * rows in that table without touching this file.
 *
 * What CANNOT be moved out of code is the rendering: a custom field on a
 * receipt appears because the receipt page renders the panel. That is why this
 * registry is honest about its scope — it lists the objects whose cards this
 * release actually wires up.
 */

export interface EntitySpec {
  code: string;
  /** Key under the `fields` namespace naming the object on screen. */
  labelKey: string;
  /**
   * Any ONE of these permissions may fill in this object's custom fields.
   *
   * A list rather than a single code because the cards are not uniform: a
   * sales manager holds `crm.leads` and has been filling in client fields
   * since the CRM shipped, while the rest of the client card is
   * `clients.manage`. Narrowing that to one code would quietly take a screen
   * away from the people using it.
   */
  writePermissions: string[];
  /**
   * How this entity is displayed when another field POINTS AT it (type
   * 'lookup'). Absent = it cannot be a lookup target: a lookup to a box or an
   * expense is a row nobody can pick out of a list by eye.
   *
   * Table and column names rather than drizzle objects on purpose — the
   * platform layer never imports the wms layer (ARCHITECTURE §0), and these
   * are read through `sql.identifier` from this fixed allowlist only.
   */
  lookup?: { table: string; label: string; secondary?: string; active?: string };
  sortOrder: number;
}

export const ENTITY_SPECS: EntitySpec[] = [
  {
    code: 'lead',
    labelKey: 'lead',
    writePermissions: ['crm.leads'],
    sortOrder: 10,
  },
  {
    code: 'client',
    labelKey: 'client',
    writePermissions: ['clients.manage', 'crm.leads'],
    lookup: { table: 'clients', label: 'name', secondary: 'client_code', active: 'active' },
    sortOrder: 20,
  },
  {
    // A deal is worked by BOTH sides — the sales manager who quoted it and the
    // VED manager who recalculated it (DEALS.md answer 2) — so the write list
    // carries both codes rather than picking a winner.
    code: 'deal',
    labelKey: 'deal',
    writePermissions: ['crm.leads', 'ved.docs', 'clients.manage'],
    lookup: { table: 'deals', label: 'code', secondary: 'title' },
    sortOrder: 15,
  },
  {
    code: 'receipt',
    labelKey: 'receipt',
    writePermissions: ['receipts.edit'],
    sortOrder: 30,
  },
  {
    code: 'box',
    labelKey: 'box',
    writePermissions: ['receipts.edit'],
    sortOrder: 40,
  },
  {
    code: 'crate',
    labelKey: 'crate',
    writePermissions: ['crates.manage'],
    sortOrder: 50,
  },
  {
    code: 'batch',
    labelKey: 'batch',
    writePermissions: ['plans.manage', 'batches.vehicle_info'],
    sortOrder: 60,
  },
  {
    code: 'plan',
    labelKey: 'plan',
    writePermissions: ['plans.manage'],
    sortOrder: 70,
  },
  {
    code: 'warehouse',
    labelKey: 'warehouse',
    writePermissions: ['admin.warehouses.manage'],
    lookup: { table: 'warehouses', label: 'name', secondary: 'code', active: 'active' },
    sortOrder: 80,
  },
  {
    code: 'user',
    labelKey: 'user',
    writePermissions: ['admin.users.manage'],
    lookup: { table: 'users', label: 'full_name', active: 'active' },
    sortOrder: 90,
  },
  {
    code: 'truck',
    labelKey: 'truck',
    writePermissions: ['plans.manage'],
    lookup: { table: 'truck_presets', label: 'name', active: 'active' },
    sortOrder: 100,
  },
  {
    code: 'expense',
    labelKey: 'expense',
    writePermissions: ['finance.expenses'],
    sortOrder: 110,
  },
];

export const ENTITY_CODES = ENTITY_SPECS.map((spec) => spec.code);

export function entitySpec(code: string): EntitySpec | undefined {
  return ENTITY_SPECS.find((spec) => spec.code === code);
}

/** The entities a lookup field may point at. */
export const LOOKUP_SPECS = ENTITY_SPECS.filter((spec) => spec.lookup);

/**
 * Defining a field is reference-data work, so it reuses the reference-data
 * permission rather than minting a new code.
 *
 * That is not only tidiness. A new permission code reaches an existing role
 * only through the seed, and the seed now SKIPS any role an admin has edited
 * (DECISIONS #170) — so on a database where the owner has already customised
 * `super_admin`, a fresh code would land in the catalogue and never be granted
 * to anybody, leaving the screen unreachable with no way to fix it from the
 * UI (`setRoleGrants` refuses to grant a code the editor does not hold).
 * `admin.dictionaries.manage` shipped in the original matrix, is held by
 * `super_admin` and `admin` on every existing database, and had no screen
 * behind it until now.
 */
export const FIELDS_ADMIN_PERMISSION = 'admin.dictionaries.manage';
