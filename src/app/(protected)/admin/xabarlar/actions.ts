'use server';

import { revalidatePath } from 'next/cache';
import { z } from 'zod';
import { getActor } from '@/modules/platform/rbac/authorize';
import { requestMeta } from '@/modules/platform/auth/session';
import {
  audienceSchema,
  BroadcastError,
  createBroadcast,
  mayBroadcast,
} from '@/modules/platform/broadcast/service';
import { enqueue } from '@/modules/platform/jobs/boss';
import { JOB_BROADCAST } from '@/modules/platform/broadcast/jobs';

export interface BroadcastFormState {
  ok?: boolean;
  total?: number;
  error?: 'forbidden' | 'validation' | BroadcastError['code'];
}

/**
 * Send: freeze the audience into rows and queue the job. The audience comes
 * back from the page as the SAME filters it was drawn from, re-validated
 * here (#514) — the count the person confirmed is recomputed, never trusted.
 */
export async function sendBroadcastAction(input: {
  id: string;
  body: string;
  audience: unknown;
}): Promise<BroadcastFormState> {
  const actor = await getActor();
  if (!actor || !mayBroadcast(actor)) return { error: 'forbidden' };
  const id = z.string().uuid().safeParse(input.id);
  const audience = audienceSchema.safeParse(input.audience);
  if (!id.success || !audience.success || typeof input.body !== 'string') return { error: 'validation' };
  const meta = await requestMeta();
  try {
    const made = await createBroadcast(
      { id: id.data, body: input.body, audience: audience.data },
      { actorId: actor.id, ...meta },
    );
    await enqueue(JOB_BROADCAST, { broadcastId: made.id });
    revalidatePath('/admin/xabarlar');
    return { ok: true, total: made.total };
  } catch (err) {
    if (err instanceof BroadcastError) return { error: err.code };
    throw err;
  }
}
