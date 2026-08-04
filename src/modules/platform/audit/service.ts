import { auditLog } from '../db/schema';
import type { Db, Tx } from '../db/client';

export type AuditAction =
  | 'create'
  | 'update'
  | 'void'
  | 'delete'
  | 'status_change'
  | 'scan'
  | 'label_print'
  | 'export'
  | 'login'
  | 'logout'
  | 'seed';

export interface AuditContext {
  actorId: string | null;
  ip?: string | null;
  userAgent?: string | null;
  warehouseId?: string | null;
}

/**
 * Compute a changed-fields-only before/after diff. Values compared by JSON
 * identity; undefined fields in `after` are ignored (not part of the update).
 */
export function diffFields(
  before: Record<string, unknown>,
  after: Record<string, unknown>,
): { before: Record<string, unknown>; after: Record<string, unknown> } | null {
  const changedBefore: Record<string, unknown> = {};
  const changedAfter: Record<string, unknown> = {};
  let changed = false;
  for (const key of Object.keys(after)) {
    if (after[key] === undefined) continue;
    if (JSON.stringify(before[key] ?? null) !== JSON.stringify(after[key] ?? null)) {
      changedBefore[key] = before[key] ?? null;
      changedAfter[key] = after[key] ?? null;
      changed = true;
    }
  }
  return changed ? { before: changedBefore, after: changedAfter } : null;
}

export async function writeAudit(
  dbOrTx: Db | Tx,
  ctx: AuditContext,
  entry: {
    entityType: string;
    entityId: string;
    action: AuditAction;
    before?: Record<string, unknown> | null;
    after?: Record<string, unknown> | null;
  },
): Promise<void> {
  await dbOrTx.insert(auditLog).values({
    actorId: ctx.actorId,
    entityType: entry.entityType,
    entityId: entry.entityId,
    action: entry.action,
    before: entry.before ?? null,
    after: entry.after ?? null,
    warehouseId: ctx.warehouseId ?? null,
    ip: ctx.ip ?? null,
    userAgent: ctx.userAgent ?? null,
  });
}
