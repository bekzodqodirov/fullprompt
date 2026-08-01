import { eq } from 'drizzle-orm';
import { db } from '../../platform/db/client';
import {
  batches,
  crates,
  crmActivities,
  customFieldValues,
  handovers,
  receiptLots,
  receipts,
  tgMessages,
  tgOutbox,
} from '../../platform/db/schema';
import { resolveEntity } from '../../platform/entities/service';
import { inScope, type ScopedActor } from '../../platform/rbac/scope';
import { seesAllTg } from '../crm/conversations';

/**
 * Per-record read authorization for GET /api/attachments/[id].
 *
 * The route authenticated but never authorized: any staff session could fetch
 * ANY attachment by uuid — including Telegram chat photos and CRM note files,
 * both private client conversations. Each branch here mirrors the gate of the
 * screen that renders that panel, so the decision never takes away a file the
 * UI legitimately shows. The uploader always reads their own file, matching
 * the existing delete rule (files/service.ts).
 *
 * Lives in wms, not platform/files: it queries receipts, crates, handovers,
 * crm_activities and tg_messages, and platform must never import wms.
 */
export type AttachmentAccessDecision = {
  allow: boolean;
  rule: string;
  /**
   * When set on a deny, the route refuses the bytes instead of only logging.
   * Since round 30 (owner's go-ahead, 2026-07-30) EVERY coded deny enforces —
   * the wrapper below stamps it — with ONE exception: `unmapped`, the legacy
   * free-form entity types from before the upload allowlist. Those are old
   * real files whose branch simply is not written, not private chats, and
   * 404ing them would break history for no security gain; the warn line
   * stays their inventory (#369).
   */
  enforce?: boolean;
};

type ReadActor = ScopedActor & {
  id: string;
  permissions: Set<string>;
  /** Present when the route passes a full Actor; absent in older callers. */
  roles?: readonly string[];
};

/** The owner's supervision view — THE shared rule (`seesAllTg`): super_admin,
 * admin, and VED-grant holders since round 33. A photo URL must widen exactly
 * as far as the screens do, and no further. */
const seesAllTgChats = (actor: ReadActor) => seesAllTg(actor);

type AttachmentRow = { id: string; entityType: string; entityId: string; uploadedBy: string };

export async function decideAttachmentRead(
  actor: ReadActor,
  attachment: AttachmentRow,
): Promise<AttachmentAccessDecision> {
  const decision = await decide(actor, attachment);
  // The round-13 log-only period ended in round 30: months of [attachment-
  // authz] lines and the whole e2e suite exercising the serve path stand
  // behind every coded branch, so a deny is now a refusal, not a diary entry.
  if (!decision.allow && decision.rule !== 'unmapped') {
    return { ...decision, enforce: true };
  }
  return decision;
}

async function decide(
  actor: ReadActor,
  attachment: AttachmentRow,
): Promise<AttachmentAccessDecision> {
  if (attachment.uploadedBy === actor.id) return { allow: true, rule: 'uploader' };
  const has = (...codes: string[]) => codes.some((code) => actor.permissions.has(code));

  switch (attachment.entityType) {
    // Receipt cards add NO permission beyond login (receipts/[id]/page.tsx) —
    // ved_manager reads lot photos through the TNVED editor and the stock
    // screen — so the only line here is the warehouse scope.
    case 'receipt': {
      const row = await db.query.receipts.findFirst({
        where: eq(receipts.id, attachment.entityId),
        columns: { warehouseId: true },
      });
      if (!row) return { allow: false, rule: 'orphan' };
      return inScope(actor, row.warehouseId)
        ? { allow: true, rule: 'receipt-in-scope' }
        : { allow: false, rule: 'out-of-scope' };
    }
    case 'receipt_lot': {
      const [row] = await db
        .select({ warehouseId: receipts.warehouseId })
        .from(receiptLots)
        .innerJoin(receipts, eq(receiptLots.receiptId, receipts.id))
        .where(eq(receiptLots.id, attachment.entityId));
      if (!row) return { allow: false, rule: 'orphan' };
      return inScope(actor, row.warehouseId)
        ? { allow: true, rule: 'receipt-in-scope' }
        : { allow: false, rule: 'out-of-scope' };
    }
    case 'crate': {
      const row = await db.query.crates.findFirst({
        where: eq(crates.id, attachment.entityId),
        columns: { warehouseId: true },
      });
      if (!row) return { allow: false, rule: 'orphan' };
      if (!has('crates.manage')) return { allow: false, rule: 'crate-no-permission' };
      return inScope(actor, row.warehouseId)
        ? { allow: true, rule: 'crate-in-scope' }
        : { allow: false, rule: 'out-of-scope' };
    }
    case 'handover': {
      const row = await db.query.handovers.findFirst({
        where: eq(handovers.id, attachment.entityId),
        columns: { warehouseId: true },
      });
      if (!row) return { allow: false, rule: 'orphan' };
      if (!has('scan.issue', 'receipts.unclaimed.resolve'))
        return { allow: false, rule: 'handover-no-permission' };
      return inScope(actor, row.warehouseId)
        ? { allow: true, rule: 'handover-in-scope' }
        : { allow: false, rule: 'out-of-scope' };
    }
    // Lenta note files. The deal card is deliberately open to ved.docs
    // (#299-301), so a note on a deal admits the customs manager too.
    case 'crm_activity': {
      const row = await db.query.crmActivities.findFirst({
        where: eq(crmActivities.id, attachment.entityId),
        columns: { entityType: true },
      });
      if (!row) return { allow: false, rule: 'orphan' };
      const allowed =
        row.entityType === 'deal'
          ? has('crm.leads', 'clients.manage', 'ved.docs')
          : has('crm.leads', 'clients.manage');
      return allowed
        ? { allow: true, rule: 'crm-activity' }
        : { allow: false, rule: 'crm-no-permission' };
    }
    // A photo QUEUED to go out — the audience is the account it leaves from.
    // A pre-bound upload not yet queued has no row and falls to the uploader
    // rule above; once sent, the sender re-binds it to 'tg_message'.
    case 'tg_outbox': {
      const row = await db.query.tgOutbox.findFirst({
        where: eq(tgOutbox.id, attachment.entityId),
        columns: { managerUserId: true, queuedBy: true },
      });
      if (!row) return { allow: false, rule: 'orphan', enforce: true };
      // The supervision view holds neither CRM grant (a vedchi's whole point
      // is reading the calc chat without owning the funnel) — it passes here
      // and is checked as the account line below, same as the screens.
      if (!has('crm.leads', 'clients.manage') && !seesAllTgChats(actor))
        return { allow: false, rule: 'tg-no-permission', enforce: true };
      return row.managerUserId === actor.id || row.queuedBy === actor.id || seesAllTgChats(actor)
        ? { allow: true, rule: 'tg-own-outbox' }
        : { allow: false, rule: 'tg-not-own-account', enforce: true };
    }
    // Telegram chat photos — the thread's own rule (owner, 2026-07-29): a
    // conversation lives on ONE manager's personal account, and only that
    // manager reads it. Permission alone stopped being enough the day the
    // screens were scoped — a photo URL must not out-read the screen it came
    // from. These two branches ENFORCE (the rest of the file stays log-only
    // until the owner flips it, #369).
    case 'tg_message': {
      const row = await db.query.tgMessages.findFirst({
        where: eq(tgMessages.id, attachment.entityId),
        columns: { managerUserId: true },
      });
      if (!row) return { allow: false, rule: 'orphan', enforce: true };
      if (!has('crm.leads', 'clients.manage') && !seesAllTgChats(actor))
        return { allow: false, rule: 'tg-no-permission', enforce: true };
      return row.managerUserId === actor.id || seesAllTgChats(actor)
        ? { allow: true, rule: 'tg-own-thread' }
        : { allow: false, rule: 'tg-not-own-account', enforce: true };
    }
    // entity_id is a file-GROUP uuid stored in custom_field_values.value_ref
    // (#180); the record it hangs on decides who may read it. A group with no
    // value row yet is a pre-save upload — only its uploader has any claim.
    case 'custom_field': {
      const [row] = await db
        .select({ entityType: customFieldValues.entityType })
        .from(customFieldValues)
        .where(eq(customFieldValues.valueRef, attachment.entityId))
        .limit(1);
      if (!row) return { allow: false, rule: 'custom_field-unbound' };
      const spec = await resolveEntity(row.entityType);
      if (!spec) return { allow: false, rule: 'custom_field-unknown-entity' };
      // An owner-born object with an "everyone" write list reads for
      // everyone too — the file is part of a record any staff may edit.
      return spec.writePermissions.length === 0 || has(...spec.writePermissions)
        ? { allow: true, rule: 'custom-field' }
        : { allow: false, rule: 'custom_field-no-permission' };
    }
    // The papers that ride with a truck. The batch card itself asks only for
    // a login and the warehouse fence, so the files ask exactly that too — a
    // declaration is not more secret than the manifest it belongs to.
    case 'batch': {
      const row = await db.query.batches.findFirst({
        where: eq(batches.id, attachment.entityId),
        columns: { originWarehouseId: true, destWarehouseId: true },
      });
      if (!row) return { allow: false, rule: 'orphan' };
      // Both ends, like the bot lookup (#411): a truck between two countries
      // belongs to nobody's floor and both ends legitimately care.
      return inScope(actor, row.originWarehouseId) || inScope(actor, row.destWarehouseId)
        ? { allow: true, rule: 'batch-scope' }
        : { allow: false, rule: 'batch-out-of-scope' };
    }
    // The proof behind a three-cornered settlement: a bank receipt naming a
    // client and a sum. Money eyes only — and an entry not yet saved has no
    // row, so only its uploader (matched above) has any claim on it.
    case 'partner_transaction': {
      return has('finance.view', 'finance.manage')
        ? { allow: true, rule: 'partner-tx-finance' }
        : { allow: false, rule: 'partner-tx-no-permission' };
    }
    // entityType was free-form before the upload allowlist, so production may
    // hold strings no code writes today — in log-only mode this branch IS the
    // inventory of them.
    default:
      return { allow: false, rule: 'unmapped' };
  }
}
