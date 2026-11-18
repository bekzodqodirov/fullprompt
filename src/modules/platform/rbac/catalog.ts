/**
 * Permission catalog + role matrix (spec §16). This file is the seed source —
 * at runtime everything is read from the role_permissions tables, so admins
 * can adjust grants without code changes.
 */

export const PERMISSION_CODES = [
  // Platform administration
  // Who may reshape the permission system itself. Deliberately separate from
  // admin.users.manage: handing out logins and rewriting what a role can do
  // are different powers, and only the second can quietly create a second
  // owner.
  'platform.roles.manage',
  'admin.users.manage',
  'admin.settings.manage',
  'admin.warehouses.manage',
  'admin.presets.manage',
  'admin.dictionaries.manage',
  'admin.audit.browse',
  // Clients
  'clients.manage',
  'clients.view_own',
  // Receipts (M1+; guarded from day one)
  'receipts.create',
  'receipts.edit',
  'receipts.void',
  'receipts.unclaimed.resolve',
  // Crates (M2+)
  'crates.manage',
  // Load plans (M3+)
  'plans.manage',
  // Scanning modes (M3+)
  'scan.load',
  'scan.unload',
  'scan.issue',
  // Batches (M3+)
  'batches.depart_close',
  'batches.vehicle_info',
  // To SEE the trucks and nothing else (2026-11-18, his «sotuvchilarga …
  // furalarga va skladlarni korishga ruxsat», answers «hammasi sening
  // taklifing»): the board, the trucks list, «Yo'lda» and the map. Every
  // other code that opens them is a power to ACT — load, depart, plan, or
  // the VED's rota and every manager's chats — so a seller could not be
  // let in by a checkbox without being handed one of those. It joins the
  // read door (`wms/batches/read-door.ts`) and nothing else: no action, no
  // document, no notification audience, no money sight. Shipped by
  // migration 0150 as well as the matrix, because the seed skips a role an
  // admin has edited (#170) and a new code a customised super_admin does not
  // hold can be granted by nobody (#179).
  'batches.view',
  // VED (M5+)
  'ved.docs',
  // Costs (M1 capture, M6 engine)
  'costs.enter_batch',
  'costs.enter_receipt',
  'costs.fx.manage',
  // Finance (Phase 2.1): client ledger + batch pricing + debt override
  'finance.manage',
  'finance.view',
  'finance.debt_override',
  // Phase 2.4 management accounting — profit and overheads are owner/accountant
  // only: a sales manager sees client balances, never the company's margin.
  'finance.expenses',
  'finance.reports',
  // CRM (Phase 2.3): leads and the contact history. `crm.leads.view_all` is
  // what separates a sales manager (own leads) from the owner (everyone's);
  // `crm.manage` covers the editable funnel stages and lead sources.
  'crm.leads',
  'crm.leads.view_all',
  'crm.manage',
  // Reports
  'reports.all_warehouses',
  'reports.own_warehouse',
  'reports.own_clients',
] as const;

export type PermissionCode = (typeof PERMISSION_CODES)[number];

export const ROLE_CODES = [
  'super_admin',
  'admin',
  'logist',
  'ved_manager',
  'warehouse_manager',
  'warehouse_operator',
  'sales_manager',
  'accountant',
  'viewer',
] as const;

export type RoleCode = (typeof ROLE_CODES)[number];

export const ROLE_NAMES: Record<RoleCode, string> = {
  super_admin: 'Super admin',
  admin: 'Admin',
  logist: 'Logist',
  ved_manager: 'VED manager',
  warehouse_manager: 'Warehouse manager',
  warehouse_operator: 'Warehouse operator',
  sales_manager: 'Sales manager',
  accountant: 'Accountant',
  viewer: 'Viewer',
};

const ALL = [...PERMISSION_CODES] as PermissionCode[];

/**
 * The SHIPPED roles whose grants apply only within the user's assigned
 * warehouses. Since migration 0049 the runtime truth is the
 * `roles.warehouse_scoped` COLUMN (so a role invented on /admin/roles can be
 * born scoped); this array is what the seed stamps onto these codes when it
 * INSERTS them on a fresh database, and what the tripwire test pins.
 */
export const WAREHOUSE_SCOPED_ROLES: RoleCode[] = ['warehouse_manager', 'warehouse_operator'];

/**
 * Does this set of roles confine the user to their assigned warehouses?
 *
 * ANY warehouse-scoped role scopes the user. This was `.every()` inline in
 * authorize.ts, which meant a second role — `viewer` alongside
 * `warehouse_operator` — made the predicate false and handed one warehouse's
 * operator every warehouse in the company. Permissions UNION across roles
 * (widest wins); scope INTERSECTS (narrowest wins).
 *
 * Exported as a function so the rule has one home and can be tested for real,
 * rather than being restated in a test that would pass if it were reverted.
 */
export function isWarehouseScoped(roleCodes: readonly string[]): boolean {
  return roleCodes.some((code) => (WAREHOUSE_SCOPED_ROLES as readonly string[]).includes(code));
}

export const ROLE_MATRIX: Record<RoleCode, PermissionCode[]> = {
  super_admin: ALL,
  admin: ALL,
  logist: [
    'clients.manage',
    'receipts.create',
    'receipts.edit',
    'receipts.void',
    'receipts.unclaimed.resolve',
    'crates.manage',
    'plans.manage',
    'scan.load',
    'scan.unload',
    'scan.issue',
    'batches.depart_close',
    'batches.vehicle_info',
    'costs.enter_batch',
    'finance.view',
    // No `finance.debt_override` (the owner's 2a, 2026-09-28: «admin va
    // buxgalter hammaga» — the logist was not named). He still reads every
    // client's money (`clients.manage`), so the grant alone would have let
    // him release anybody's cargo on debt; he asks like the counter does.
    // A seed writes only into an EMPTY table, so on a live database this is
    // the owner's untick on /admin/roles, not this line.
    'crm.leads',
    'crm.leads.view_all',
    'reports.all_warehouses',
  ],
  ved_manager: [
    'ved.docs',
    'costs.enter_batch',
    'finance.manage',
    'finance.view',
    'reports.all_warehouses',
  ],
  warehouse_manager: [
    'receipts.create',
    'receipts.edit',
    'receipts.void',
    'receipts.unclaimed.resolve',
    'crates.manage',
    'scan.load',
    'scan.unload',
    'scan.issue',
    'batches.depart_close',
    'batches.vehicle_info',
    'costs.enter_receipt',
    'finance.debt_override',
    'reports.own_warehouse',
  ],
  warehouse_operator: [
    'receipts.create',
    'receipts.edit',
    'crates.manage',
    'scan.load',
    'scan.unload',
    'scan.issue',
    'batches.vehicle_info',
    'costs.enter_receipt',
    'reports.own_warehouse',
  ],
  sales_manager: [
    'clients.view_own',
    'finance.view',
    'finance.debt_override',
    'reports.own_clients',
    // Own leads only — `crm.leads.view_all` stays with the owner/admins.
    'crm.leads',
    // The trucks, the board and the map, read-only (2026-11-18, his 2a 8a):
    // every client's cargo on them (1a), no money anywhere on those screens.
    'batches.view',
  ],
  accountant: [
    'finance.expenses',
    'finance.reports',
    'costs.enter_batch',
    'costs.enter_receipt',
    'costs.fx.manage',
    'finance.manage',
    'finance.view',
    'finance.debt_override',
    'reports.all_warehouses',
  ],
  viewer: ['reports.all_warehouses'],
};
