import { eq } from 'drizzle-orm';
import { db } from '../../platform/db/client';
import { batches } from '../../platform/db/schema';
import { writeAudit, type AuditContext } from '../../platform/audit/service';
import { isUniqueViolation } from '../../platform/db/errors';
import { getSetting } from '../../platform/settings/service';
import { lockTruckLoading } from '../scanning/count-rules';
import { awaitingUnloadCount } from '../scanning/unload';
import {
  codeShapeProblem,
  loadingCodeProblem,
  normalizeBatchCode,
  roadCodeProblem,
  type CodeShape,
  type RoadCodeProblem,
} from './batch-code';
import { codeEverWorn, codeShadows, isOwnFormerCode, lockBatchCode } from './former-codes';
import { mayRenameBatch, renameDoorOpens, renameStageOf, type RenameDoor } from './rename-door';

export type Batch = typeof batches.$inferSelect;

export type RenameRefusal =
  | 'unauthenticated'
  | 'forbidden'
  | 'not_found'
  | 'rename_closed'
  | 'batch_changed'
  | 'bad_code'
  | RoadCodeProblem
  | 'reason_required'
  | 'code_shape'
  | 'code_shadows'
  | 'code_taken';

/** `detail` names the shape (`code_shape`), the thing shadowed (`code_shadows`) or the stage now (`batch_changed`). */
export class RenameError extends Error {
  constructor(
    public readonly code: RenameRefusal,
    public readonly detail?: string,
  ) {
    super(code);
  }
}

export const RENAME_REASON_MIN = 3;
export const RENAME_REASON_MAX = 300;

/**
 * Rename a truck — before departure, AND on the road until unloading
 * finishes (the owner's 1a / 2a / 3a, 2026-09-30).
 *
 * This REVERSES DECISIONS #122 («after departure the code is locked»). #122
 * was right that the code is already on the invoice, the manifest and what
 * the customs agent received — and he answered it himself: the partner's or
 * the papers' own number sometimes only becomes known on the road, and a
 * system that cannot say it forces a second name that lives in people's
 * heads. So the lock moved from «left» to «finished», and the cost of the
 * change is stated where it is paid: a reason is required on the road, the
 * old name stays findable (⌘K, the archive, the bot, the card), and a name
 * a truck wore ON THE ROAD is never given to another truck. A name changed
 * before departure frees at once, as it always did (`former-codes.ts`).
 *
 * `door` and `seen` are REQUIRED (#790: an optional door fails open, and
 * required made every caller a compile error that named itself). The door is
 * branded (`renameDoorFor`), carries the identity and must be the audit
 * context's actor; `seen` is what the presser's screen showed, and a truck
 * that changed under the open form — departed, renamed by a colleague,
 * finished — is refused `batch_changed` BEFORE any stage-specific rule, so a
 * stale loading form never meets the road's charset and a colleague's rename
 * is never silently overwritten. The one exception is a truck that already
 * wears the name asked for — a double press, or a colleague who typed the
 * same thing: the requested state is true, so it answers `changed: false`.
 *
 * LOCKS, all taken first and always in this order: the target NAME, the
 * truck's LOADING lock, then its ROW. The name first, because a counter walk
 * or another rename may hold it while waiting on something that waits on a
 * truck row — taken after the row it closes a three-party cycle. The loading
 * lock before the row, because departure, «yuklash tugadi», a removal, a
 * cancel and the office count all take it first and read the truck's code
 * inside it: a rename between their read and their commit would leave their
 * events carrying the old name, and taken after the row it would invert
 * departBatch's own order.
 */
export async function renameBatch(
  input: {
    batchId: string;
    code: string;
    reason?: string | null;
    seen: { code: string; stage: 'loading' | 'road' };
  },
  door: RenameDoor | null,
  ctx: AuditContext,
): Promise<{ batch: Batch; from: string; stage: 'loading' | 'road'; changed: boolean }> {
  if (!ctx.actorId) throw new RenameError('unauthenticated');
  // No door, or a door minted for somebody else, opens nothing.
  if (!door || door.id !== ctx.actorId) throw new RenameError('forbidden');

  const code = normalizeBatchCode(input.code);
  const why = (input.reason ?? '').trim().replace(/\s+/g, ' ');

  // On the POOL, before the transaction (#714 — nothing pooled inside it).
  const [shadow, prefix] = await Promise.all([codeShadows(code), getSetting('client_code_prefix')]);

  try {
    return await db.transaction(async (tx) => {
      // The name, then the truck's loading lock, then the row (see above).
      await lockBatchCode(tx, code);
      await lockTruckLoading(tx, input.batchId);
      // FOR UPDATE, not NO KEY: `code` sits under a unique index, so the
      // UPDATE needs this lock anyway — taking it first avoids an upgrade
      // against finishUnload's and departBatch's own row locks.
      const [batch] = await tx.select().from(batches).where(eq(batches.id, input.batchId)).for('update');
      if (!batch) throw new RenameError('not_found');
      // The door FIRST, so a refused caller learns nothing about the truck.
      if (!renameDoorOpens(door, batch)) throw new RenameError('forbidden');

      // Under the row lock an in-flight landing still counts as aboard — its
      // scan_events insert waits on this lock, so the two serialise.
      const aboard = ['in_transit', 'arrived'].includes(batch.status)
        ? await awaitingUnloadCount(tx, batch.id)
        : 0;
      const stage = renameStageOf(batch.status, aboard);
      if (stage === 'closed') throw new RenameError('rename_closed');
      if (!mayRenameBatch(door, batch, stage)) throw new RenameError('forbidden');

      // Already so — its own name saved again, a double press, or a colleague
      // who typed the very same name: nothing to do, no audit row (#502).
      if (code === batch.code && stage === input.seen.stage) {
        return { batch, from: batch.code, stage, changed: false };
      }

      // The compare-and-set: what the presser SAW (count-accept's shape).
      if (stage !== input.seen.stage || batch.code !== input.seen.code) {
        throw new RenameError('batch_changed', stage);
      }

      if (stage === 'loading') {
        const problem = loadingCodeProblem(code);
        if (problem) throw new RenameError(problem);
        // A reason posted from a stale road form is simply ignored here.
      } else {
        // The truck's OWN former names are exempt from the road charset only
        // — a free pre-departure name («GSR KASHGAR 1») may come back.
        const problem = roadCodeProblem(code);
        if (problem && !(await isOwnFormerCode(tx, batch.id, code))) throw new RenameError(problem);
        if (why.length < RENAME_REASON_MIN || why.length > RENAME_REASON_MAX) {
          throw new RenameError('reason_required');
        }
      }

      // Both stages, own former names NOT exempt: what the name would be
      // mistaken for in the bot and ⌘K is a property of the name.
      const shape: CodeShape | null = codeShapeProblem(code, prefix);
      if (shape) throw new RenameError('code_shape', shape);
      if (shadow) throw new RenameError('code_shadows', shadow);

      // «Ever worn» from the committed truth — the name's lock is ours since
      // the first statement, so no rename to it and no counter walk reaching
      // it can land between this read and our write.
      if (await codeEverWorn(tx, code, batch.id)) throw new RenameError('code_taken');

      const [updated] = await tx
        .update(batches)
        .set({ code })
        .where(eq(batches.id, batch.id))
        .returning();
      await writeAudit(tx, { ...ctx, warehouseId: batch.originWarehouseId }, {
        entityType: 'batch',
        entityId: batch.id,
        action: 'update',
        before: { code: batch.code },
        after: stage === 'road' ? { code, reason: why } : { code },
      });
      return { batch: updated!, from: batch.code, stage, changed: true };
    });
  } catch (err) {
    // The last arbiter for a writer that bypasses the lock (raw SQL, a
    // future creator): a same-name race is a sentence, never a white page.
    if (isUniqueViolation(err)) throw new RenameError('code_taken');
    throw err;
  }
}
