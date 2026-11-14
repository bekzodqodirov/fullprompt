import { eq, sql } from 'drizzle-orm';
import { db } from '../../platform/db/client';
import { dealStages, leadStages, settings } from '../../platform/db/schema';
import { writeAudit, type AuditContext } from '../../platform/audit/service';
import { isUuidShaped } from '../../platform/audit/fields';
import { SETTINGS_AUDIT_ID, type SettingKey } from '../../platform/settings/service';
import { CrmError } from './service';

/**
 * The funnel stages the CRM's own settings name (SPEC-P2-v2 §3.1) — a CLOSED map from (board, which) to the key,
 * decided on the server: the screen posts `board` and `which`, never a key (a posted key would let any `crm.manage`
 * holder write ANY setting, hands 13). The «Hisoblatish» stage of both boards (round 83's) and the AI seller's two
 * lead stages («AI birinchi javob berdi», «AI narx aytdi») go through this one door — the generic /admin/settings
 * form refuses the two AI keys (K5's own-door rule) and the old calc-stage action wrote no audit row at all.
 */
export const STAGE_SETTING_KEYS = {
  lead: { calc: 'crm_calc_stage', ai_contacted: 'crm_ai_contacted_stage', ai_quoted: 'crm_ai_quoted_stage' },
  deal: { calc: 'deal_calc_stage' },
} as const satisfies Record<'lead' | 'deal', Partial<Record<'calc' | 'ai_contacted' | 'ai_quoted', SettingKey>>>;

export type StageBoard = keyof typeof STAGE_SETTING_KEYS;
export type StageSettingWhich = 'calc' | 'ai_contacted' | 'ai_quoted';

/** The key a (board, which) pair names — or null: anything off the closed map is refused (`bad_setting`). Pure. */
export function stageSettingKey(board: string, which: string): SettingKey | null {
  if (board !== 'lead' && board !== 'deal') return null;
  const keys = STAGE_SETTING_KEYS[board] as Partial<Record<string, SettingKey>>;
  return Object.prototype.hasOwnProperty.call(keys, which) ? (keys[which] ?? null) : null;
}

/** Why a stage setting was refused — each with its words on the settings screen. */
export type StageSettingRefusal = 'bad_setting' | 'stage_not_open' | 'quoted_not_after_contacted';

/**
 * «AI narx aytdi» stands strictly AFTER «AI birinchi javob berdi» (§3.1): at or before it, the quoted move would be the
 * forward one and the contacted move a step back the mover refuses — a quote would leave the lead where a first reply
 * puts it. Asked of whichever of the two is being set; true = refused. Pure: `null` = the other is not set.
 */
export function stageOrderRefused(which: StageSettingWhich, chosenSort: number, otherSort: number | null): boolean {
  if (otherSort === null) return false;
  if (which === 'ai_quoted') return chosenSort <= otherSort;
  if (which === 'ai_contacted') return otherSort <= chosenSort;
  return false;
}

const LOCK = sql`SELECT pg_advisory_xact_lock(hashtext('crm-stage-settings'))`;

async function rawValue(tx: Parameters<Parameters<typeof db.transaction>[0]>[0], key: string): Promise<string> {
  const [row] = await tx.select({ value: settings.value }).from(settings).where(eq(settings.key, key));
  return typeof row?.value === 'string' ? row.value : '';
}

/**
 * Set one stage setting (§3.1). Empty = «do nothing» (always allowed). A stage must be an ACTIVE, OPEN stage of that
 * board (the screen filters in the browser only) — refused in words otherwise; the two AI stages keep their order.
 * One transaction under one advisory lock, so two presses cannot both pass the order check; the settings and stages
 * are read through it (never `getSetting` on the pool — #714). Audited under the settings' one entity id with the key
 * in before/after; an unchanged value writes nothing.
 */
export async function setStageSetting(input: { board: string; which: string; stageId: string }, ctx: AuditContext): Promise<void> {
  const key = stageSettingKey(input.board, input.which);
  if (!key) throw new CrmError('bad_setting');
  const board = input.board as StageBoard;
  const which = input.which as StageSettingWhich;
  const stageId = input.stageId.trim();
  if (stageId !== '' && !isUuidShaped(stageId)) throw new CrmError('stage_not_open');
  await db.transaction(async (tx) => {
    await tx.execute(LOCK);
    const table = board === 'deal' ? dealStages : leadStages;
    const stages = await tx.select({ id: table.id, kind: table.kind, active: table.active, sortOrder: table.sortOrder }).from(table);
    if (stageId !== '') {
      const chosen = stages.find((s) => s.id === stageId);
      if (!chosen || !chosen.active || chosen.kind !== 'open') throw new CrmError('stage_not_open');
      if (board === 'lead' && (which === 'ai_contacted' || which === 'ai_quoted')) {
        const otherId = await rawValue(tx, which === 'ai_quoted' ? STAGE_SETTING_KEYS.lead.ai_contacted : STAGE_SETTING_KEYS.lead.ai_quoted);
        const other = stages.find((s) => s.id === otherId && s.active && s.kind === 'open') ?? null;
        if (stageOrderRefused(which, chosen.sortOrder, other?.sortOrder ?? null)) throw new CrmError('quoted_not_after_contacted');
      }
    }
    const before = await rawValue(tx, key);
    if (before === stageId) return;
    await tx
      .insert(settings)
      .values({ key, value: stageId, updatedBy: ctx.actorId })
      .onConflictDoUpdate({ target: settings.key, set: { value: stageId, updatedBy: ctx.actorId, updatedAt: new Date() } });
    await writeAudit(tx, ctx, {
      entityType: 'settings',
      entityId: SETTINGS_AUDIT_ID,
      action: 'update',
      before: { [key]: before },
      after: { [key]: stageId },
    });
  });
}
