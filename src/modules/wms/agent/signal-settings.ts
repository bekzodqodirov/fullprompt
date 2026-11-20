import { writeAudit, type AuditContext } from '../../platform/audit/service';
import { db } from '../../platform/db/client';
import { getSetting, SETTINGS_AUDIT_ID, SETTING_VALIDATORS, setSetting } from '../../platform/settings/service';
import { mayTuneAuto } from './auto-send';
import { mayGovernAgent, readAgentConfig } from './config';

/**
 * The writers of P4's own-door settings (stage 1a §3.3, §5): the big-cargo line and its words, and the minutes the
 * liveness alarm waits. Each refuses a value its key's shape refuses (`SETTING_VALIDATORS`, the one rule its readers
 * also ask), writes the key and ONE audit row under the settings' entity id (a setting's history in one place).
 *
 * Doors, never restated: who names the AI's people and its face — the big-cargo line among them — is
 * `mayGovernAgent` (`setAgentSeat`'s own predicate); the alarm's minutes are tuned like the layer's holds, by its
 * holder or a super_admin (`mayTuneAuto`).
 */

export type SignalSettingRefusal = 'forbidden' | 'bad_big_cargo' | 'bad_liveness';

export class SignalSettingError extends Error {
  constructor(public readonly code: SignalSettingRefusal) {
    super(code);
  }
}

type Actor = { id: string; roles: readonly string[] };

/** «Katta yuk — shuncha kubdan» and «"Fura" so‘zi ham signal bersin» — one save, both keys. */
export async function setBigCargoSettings(actor: Actor, input: { m3: string; words: boolean }, ctx: AuditContext): Promise<{ m3: number; words: boolean }> {
  if (!mayGovernAgent(actor)) throw new SignalSettingError('forbidden');
  const m3 = input.m3.trim();
  if (!SETTING_VALIDATORS.agent_big_cargo_m3!(m3)) throw new SignalSettingError('bad_big_cargo');
  const words = input.words === true;
  const before = { agent_big_cargo_m3: await getSetting('agent_big_cargo_m3'), agent_big_cargo_words: await getSetting('agent_big_cargo_words') };
  await setSetting('agent_big_cargo_m3', Number(m3), actor.id);
  await setSetting('agent_big_cargo_words', words, actor.id);
  await writeAudit(db, ctx, {
    entityType: 'settings',
    entityId: SETTINGS_AUDIT_ID,
    action: 'update',
    before,
    after: { agent_big_cargo_m3: Number(m3), agent_big_cargo_words: words },
  });
  return { m3: Number(m3), words };
}

/** «Mijoz javobsiz qolsa ogohlantirish (daqiqa)»: 0 = off, else 3-120. */
export async function setLivenessMinutes(actor: Actor, raw: string, ctx: AuditContext): Promise<number> {
  const config = await readAgentConfig();
  if (!mayTuneAuto(actor, config?.ownerUserId ?? null)) throw new SignalSettingError('forbidden');
  const value = raw.trim();
  if (!SETTING_VALIDATORS.agent_liveness_minutes!(value)) throw new SignalSettingError('bad_liveness');
  const before = await getSetting('agent_liveness_minutes');
  await setSetting('agent_liveness_minutes', Number(value), actor.id);
  await writeAudit(db, ctx, {
    entityType: 'settings',
    entityId: SETTINGS_AUDIT_ID,
    action: 'update',
    before: { agent_liveness_minutes: before },
    after: { agent_liveness_minutes: Number(value) },
  });
  return Number(value);
}
