import { logger } from '../../platform/logger';
import { mayRunAgent, readAgentConfig, type AgentConfig } from './config';

/**
 * The AI sotuvchi's page and its menu tab (spec §17.12, review build-13 and
 * fit-11): ONE route, opened by `mayRunAgent` — the configured owner, or the
 * super_admin ROLE. That is a fact in `agent_config`, not a grant, so the
 * pure menu module cannot know it; the shell asks here and hands the answer
 * in as `viewer.doors` (rbac/nav.ts), and the tab is drawn only then.
 */

export const AGENT_PAGE = '/suhbatlar/ai';

/** The doors this viewer's AI-sotuvchi facts open — pure, for the tests and the shell alike. */
export function agentDoorsFor(
  actor: { id: string; roles: readonly string[] },
  config: Pick<AgentConfig, 'ownerUserId'> | null,
): Set<string> {
  return mayRunAgent(actor, config) ? new Set([AGENT_PAGE]) : new Set();
}

/**
 * The same answer, reading the config when it matters. A super_admin needs no
 * read (the role alone opens it); anybody else costs one primary-key read.
 * Fenced: the layout is every page, and a database one migration behind —
 * or a blip — must cost the menu one tab, never the whole app (#472).
 */
export async function agentNavDoors(actor: { id: string; roles: readonly string[] }): Promise<Set<string>> {
  if (actor.roles.includes('super_admin')) return agentDoorsFor(actor, null);
  try {
    return agentDoorsFor(actor, await readAgentConfig());
  } catch (err) {
    logger.warn({ err }, '[agent] menu door not read');
    return new Set();
  }
}
