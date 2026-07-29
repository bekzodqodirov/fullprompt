'use server';

import { revalidatePath } from 'next/cache';
import { z } from 'zod';
import { authorize } from '@/modules/platform/rbac/authorize';
import { requestMeta } from '@/modules/platform/auth/session';
import { enqueue, JOB_PROCESS_EVENTS } from '@/modules/platform/jobs/boss';
import { IssueError, issueBoxes, issueSchema } from '@/modules/wms/issue/service';
import {
  ApprovalError,
  decideIssueApproval,
  requestIssueApproval,
} from '@/modules/wms/issue/approvals';

export async function issueBoxesAction(
  input: unknown,
): Promise<{ ok: boolean; handoverId?: string; error?: string }> {
  const parsed = issueSchema.safeParse(input);
  if (!parsed.success) return { ok: false, error: 'validation' };
  const actor = await authorize('scan.issue', { warehouseId: parsed.data.warehouseId });
  // Ticking "manager allowed" needs the actual permission — otherwise anyone
  // could wave the debt gate through (Phase 2.1, owner's rule).
  if (parsed.data.debtOk && !actor.permissions.has('finance.debt_override')) {
    return { ok: false, error: 'debt_override_forbidden' };
  }
  const meta = await requestMeta();
  try {
    const handover = await issueBoxes(parsed.data, { actorId: actor.id, ...meta });
    await enqueue(JOB_PROCESS_EVENTS, {});
    revalidatePath('/issue');
    return { ok: true, handoverId: handover.id };
  } catch (err) {
    if (err instanceof IssueError) return { ok: false, error: err.code };
    throw err;
  }
}

const requestSchema = z.object({
  clientId: z.string().uuid(),
  warehouseId: z.string().uuid(),
  note: z.string().trim().max(500).optional().or(z.literal('')),
});

/** The operator at the gate asks; the deciders' phones buzz. */
export async function requestIssueApprovalAction(
  input: unknown,
): Promise<{ ok: boolean; error?: string }> {
  const parsed = requestSchema.safeParse(input);
  if (!parsed.success) return { ok: false, error: 'validation' };
  const actor = await authorize('scan.issue', { warehouseId: parsed.data.warehouseId });
  const meta = await requestMeta();
  try {
    await requestIssueApproval(
      { clientId: parsed.data.clientId, warehouseId: parsed.data.warehouseId, note: parsed.data.note || undefined },
      { actorId: actor.id, ...meta },
    );
    await enqueue(JOB_PROCESS_EVENTS, {});
    return { ok: true };
  } catch (err) {
    if (err instanceof ApprovalError) return { ok: false, error: err.code };
    throw err;
  }
}

const decideSchema = z.object({
  approvalId: z.string().uuid(),
  verdict: z.enum(['approved', 'refused']),
  note: z.string().trim().max(500).optional().or(z.literal('')),
});

export async function decideIssueApprovalAction(formData: FormData): Promise<void> {
  const parsed = decideSchema.safeParse({
    approvalId: formData.get('approvalId'),
    verdict: formData.get('verdict'),
    note: formData.get('note'),
  });
  if (!parsed.success) return;
  // The same permission the direct checkbox needs: deciding IS the override.
  const actor = await authorize('finance.view');
  if (!actor.permissions.has('finance.debt_override')) return;
  const meta = await requestMeta();
  try {
    await decideIssueApproval(
      {
        approvalId: parsed.data.approvalId,
        verdict: parsed.data.verdict,
        note: parsed.data.note || undefined,
      },
      { actorId: actor.id, ...meta },
    );
    await enqueue(JOB_PROCESS_EVENTS, {});
  } catch (err) {
    if (err instanceof ApprovalError) return;
    throw err;
  }
  revalidatePath('/approvals');
}
