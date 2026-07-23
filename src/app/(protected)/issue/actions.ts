'use server';

import { revalidatePath } from 'next/cache';
import { authorize } from '@/modules/platform/rbac/authorize';
import { requestMeta } from '@/modules/platform/auth/session';
import { enqueue, JOB_PROCESS_EVENTS } from '@/modules/platform/jobs/boss';
import { IssueError, issueBoxes, issueSchema } from '@/modules/wms/issue/service';

export async function issueBoxesAction(
  input: unknown,
): Promise<{ ok: boolean; handoverId?: string; error?: string }> {
  const parsed = issueSchema.safeParse(input);
  if (!parsed.success) return { ok: false, error: 'validation' };
  const actor = await authorize('scan.issue', { warehouseId: parsed.data.warehouseId });
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
