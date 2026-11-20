'use server';

import { revalidatePath } from 'next/cache';
import { isUuidShaped } from '@/modules/platform/audit/fields';
import { requestMeta } from '@/modules/platform/auth/session';
import { isServerBehind } from '@/modules/platform/db/errors';
import { logger } from '@/modules/platform/logger';
import { getActor, type Actor } from '@/modules/platform/rbac/authorize';
import { mayRunAgent, readAgentConfig } from './config';
import { DesignationError, setDesignations } from './designations';
import { markSample } from './sample';
import { SignalSettingError, setBigCargoSettings, setLivenessMinutes } from './signal-settings';
import { AGENT_PAGE } from './web-door';
import type { AgentActionResult } from './web-actions';

/**
 * The page's doors for stage 1a's «Kim javob beradi» and «Kunlik tekshiruv» (§4.5), in their own file — the AI
 * page's actions file is shared by four packages, and an action of this one there would be a conflict in every
 * merge. The same shape as its doors: the page's own gate first (`mayRunAgent`), then the ONE function that asks
 * its own narrower question (`setDesignations` — `mayGovernAgent`; the sample — the arming rule; the alarm's
 * minutes — `mayTuneAuto`), and a refusal back as a CODE the page turns into words (`labels.ts`).
 */

type Gate = { actor: Actor; ctx: { actorId: string; ip: string | null; userAgent: string | null } };

async function gate(): Promise<Gate | { error: string }> {
  const actor = await getActor();
  if (!actor) return { error: 'forbidden' };
  let config;
  try {
    config = await readAgentConfig();
  } catch (err) {
    if (isServerBehind(err)) return { error: 'not_ready' };
    throw err;
  }
  if (!mayRunAgent(actor, config)) return { error: 'forbidden' };
  const meta = await requestMeta();
  return { actor, ctx: { actorId: actor.id, ...meta } };
}

async function run(work: (g: Gate) => Promise<AgentActionResult | void>): Promise<AgentActionResult> {
  const g = await gate();
  if ('error' in g) return { ok: false, error: g.error };
  try {
    const out = await work(g);
    revalidatePath(AGENT_PAGE);
    return out ?? { ok: true };
  } catch (err) {
    if (isServerBehind(err)) return { ok: false, error: 'not_ready' };
    logger.error({ err }, '[agent] signal web action failed');
    throw err;
  }
}

/** The designation's refusals in the page's codes (`not_ready` / `forbidden` are the page's own). */
const DESIGNATION_ERROR = {
  not_ready: 'not_ready',
  forbidden: 'forbidden',
  unknown_topic: 'designation_unknown_topic',
  too_many: 'designation_too_many',
  not_staff: 'designation_not_staff',
} as const;

/** «Kim javob beradi»: one topic's people, replaced, in the order given (the first is rank 1). */
export async function agentDesignationsAction(topic: string, userIds: string[]): Promise<AgentActionResult> {
  if (typeof topic !== 'string' || !Array.isArray(userIds) || userIds.some((id) => typeof id !== 'string')) {
    return { ok: false, error: 'designation_not_staff' };
  }
  return run(async ({ actor, ctx }) => {
    try {
      await setDesignations(actor, topic, userIds, ctx);
    } catch (err) {
      if (err instanceof DesignationError) return { ok: false, error: DESIGNATION_ERROR[err.code] };
      throw err;
    }
  });
}

/** The big-cargo line and its words — a super_admin's (the service asks). */
export async function agentBigCargoAction(values: { m3: string; words: boolean }): Promise<AgentActionResult> {
  return run(async ({ actor, ctx }) => {
    try {
      await setBigCargoSettings(actor, { m3: typeof values?.m3 === 'string' ? values.m3 : '', words: values?.words === true }, ctx);
    } catch (err) {
      if (err instanceof SignalSettingError) return { ok: false, error: err.code };
      throw err;
    }
  });
}

/** The liveness alarm's minutes — the holder's or a super_admin's (the service asks). */
export async function agentLivenessAction(raw: string): Promise<AgentActionResult> {
  return run(async ({ actor, ctx }) => {
    try {
      await setLivenessMinutes(actor, typeof raw === 'string' ? raw : '', ctx);
    } catch (err) {
      if (err instanceof SignalSettingError) return { ok: false, error: err.code };
      throw err;
    }
  });
}

/** 👍 / 👎 on a sampled reply — 👎 is the card's own 👎 too (the service). */
export async function agentSampleMarkAction(day: string, draftId: string, mark: 'good' | 'bad'): Promise<AgentActionResult> {
  if (typeof day !== 'string' || !/^\d{4}-\d{2}-\d{2}$/u.test(day) || typeof draftId !== 'string' || !isUuidShaped(draftId) || (mark !== 'good' && mark !== 'bad')) {
    return { ok: false, error: 'sample_not_found' };
  }
  return run(async ({ actor }) => {
    const r = await markSample(actor, { day, draftId, mark });
    if (!r.ok) return { ok: false, error: r.code === 'not_ready' ? 'not_ready' : `sample_${r.code}` };
    // A 👎 that disarmed the layer changes the auto panel too.
    if (r.disarmed) revalidatePath('/suhbatlar', 'layout');
  });
}
