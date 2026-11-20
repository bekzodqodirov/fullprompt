import { asc, inArray } from 'drizzle-orm';
import { db } from '../../platform/db/client';
import { users } from '../../platform/db/schema';
import { reachOf } from '../../platform/notifications/staff';
import { canLogInSql } from '../../platform/users/login';
import { mayTuneAuto } from './auto-send';
import { readBigCargoSettings, type BigCargoSettings } from './big-cargo';
import { agentToliq1aReady, mayGovernAgent, type AgentConfig } from './config';
import { AGENT_TOPIC_KEYS, DESIGNATION_MAX, designatedRows, designation, type AgentTopic, type DesignationSource } from './designations';
import { readLivenessMinutes } from './liveness';
import { agentPageReaders } from './signals';

/**
 * What «Kim javob beradi» draws (stage 1a §3.2, §4.5): per topic, the people STORED for it (`designatedRows` — what
 * the table holds, so an empty topic can say «belgilanmagan»), each with what the bot can do for them today (`reachOf`
 * — a designated person with no linked staff chat is the silent failure this table exists to end) and whether the AI
 * page opens for them (J17: the deputy is told counts, never sent to a door that bounces); an empty topic says who
 * hears it NOW, by name and by where the answer came from (`designation`, J18). The holder's own Telegram (J28): the
 * cards go there, and a holder nobody reads leaves every price waiting.
 */

export interface KimgaPerson {
  id: string;
  name: string;
  /** No linked staff chat — the bot cannot reach this person. */
  unreachable: boolean;
  /** The AI page does not open for this person (`mayRunAgent`). */
  noPage: boolean;
}

export interface KimgaTopic {
  topic: AgentTopic;
  stored: KimgaPerson[];
  /** Who is told now when nobody is stored, and from where — null when the topic has its own people. */
  fallback: { names: string[]; source: DesignationSource } | null;
}

export interface KimgaPanel {
  ready: boolean;
  topics: KimgaTopic[];
  /** Colleagues who can log in, by name — the picker's list. */
  candidates: { id: string; name: string }[];
  /** Who may change the lists and the big-cargo line (`mayGovernAgent`). */
  editable: boolean;
  /** The AI account's own Telegram: true = linked, false = not, null = no account named. */
  holderReachable: boolean | null;
  bigCargo: BigCargoSettings;
  livenessMinutes: number;
  /** Who may change the alarm's minutes (`mayTuneAuto`). */
  livenessEditable: boolean;
  max: number;
}

async function namesOf(ids: readonly string[]): Promise<Map<string, string>> {
  if (ids.length === 0) return new Map();
  const rows = await db.select({ id: users.id, name: users.fullName }).from(users).where(inArray(users.id, [...ids]));
  return new Map(rows.map((r) => [r.id, r.name]));
}

export async function kimgaPanel(viewer: { id: string; roles: readonly string[] }, config: Pick<AgentConfig, 'ownerUserId'> | null): Promise<KimgaPanel> {
  const [bigCargo, livenessMinutes] = await Promise.all([readBigCargoSettings(), readLivenessMinutes()]);
  const base = {
    candidates: [] as { id: string; name: string }[],
    editable: mayGovernAgent(viewer),
    holderReachable: null as boolean | null,
    bigCargo,
    livenessMinutes,
    livenessEditable: mayTuneAuto(viewer, config?.ownerUserId ?? null),
    max: DESIGNATION_MAX,
  };
  if (!(await agentToliq1aReady())) return { ready: false, topics: [], ...base };
  const stored = new Map<AgentTopic, string[]>();
  for (const topic of AGENT_TOPIC_KEYS) stored.set(topic, (await designatedRows(topic, db)).map((r) => r.userId));
  const fallbacks = new Map<AgentTopic, { userIds: string[]; source: DesignationSource }>();
  for (const topic of AGENT_TOPIC_KEYS) if (stored.get(topic)!.length === 0) fallbacks.set(topic, await designation(topic));
  const everybody = [...new Set([...[...stored.values()].flat(), ...[...fallbacks.values()].flatMap((f) => f.userIds)])];
  const holderId = config?.ownerUserId ?? null;
  const [names, reach, readers, candidates, holderReach] = await Promise.all([
    namesOf(everybody),
    reachOf([...new Set([...stored.values()].flat())], 'AgentSignal'),
    agentPageReaders([...new Set([...stored.values()].flat())], config),
    db.select({ id: users.id, name: users.fullName }).from(users).where(canLogInSql()).orderBy(asc(users.fullName), asc(users.id)),
    holderId ? reachOf([holderId], 'AgentDraft') : Promise.resolve(null),
  ]);
  const topics = AGENT_TOPIC_KEYS.map((topic): KimgaTopic => {
    const fb = fallbacks.get(topic);
    return {
      topic,
      stored: stored.get(topic)!.map((id) => ({
        id,
        name: names.get(id) ?? '—',
        unreachable: reach.get(id) === 'no_chat',
        noPage: !readers.has(id),
      })),
      fallback: fb ? { names: fb.userIds.map((id) => names.get(id) ?? '—'), source: fb.source } : null,
    };
  });
  return {
    ready: true,
    topics,
    ...base,
    candidates,
    holderReachable: holderReach && holderId ? holderReach.get(holderId) !== 'no_chat' : null,
  };
}
