import { and, eq, sql } from 'drizzle-orm';
import { db } from '../db/client';
import { automationFires, automationRules } from '../db/schema';
import { logger } from '../logger';
import { conditionsMatch, conditionsSchema, conditionValues, ruleBoard } from './conditions';
import { ruleRecordSource, toRuleRecord, type RuleRecord } from './record';
import type { ConditionBoard } from './conditions';

/**
 * The rule that fires because nothing happened (round 86).
 *
 * The owner's own words for what phase 7 was missing: «lead 3 kundan beri shu
 * bosqichda turibdi, javob yo'q → eslat». Every other trigger in this system
 * answers an EVENT — somebody moved a card, cargo arrived — and the most
 * expensive thing in a funnel is the opposite: a lead nobody touched, which
 * produces no event at all and so could never be automated.
 *
 * «Sitting still» is `updated_at` older than N days, and that is a deliberate
 * definition rather than the obvious «entered the stage N days ago». Reading
 * when a card entered a stage means reading `audit_log` per card, and the
 * honest question is not «how long in this column» but «how long since anybody
 * did ANYTHING» — an edit, a note, a price. If a seller touched the card
 * yesterday, they have not forgotten it, whatever column it is in.
 */

/**
 * The cards a `lead_stale` / `deal_stale` rule is about, before conditions.
 *
 * Bounded, and the bound is stated: a funnel with ten thousand forgotten leads
 * would otherwise turn one sweep into ten thousand tasks the first time
 * somebody wrote such a rule. What is left over is picked up by the next
 * sweep, so nothing is lost — it arrives more slowly.
 */
export const STALE_PER_SWEEP = 200;

export async function staleCandidates(
  board: ConditionBoard,
  stageId: string,
  days: number,
): Promise<RuleRecord[]> {
  const cutoff = new Date(Date.now() - days * 86_400_000).toISOString();
  const rows = await db.execute<Record<string, unknown>>(sql`
    SELECT * FROM (${ruleRecordSource(board)}) r
    WHERE r.stage_id = ${stageId}::uuid
      AND r.updated_at < ${cutoff}::timestamptz
      -- A converted lead is a client's job now; the deal carries the work and
      -- has its own funnel to go quiet in.
      AND r.client_id IS NULL
    ORDER BY r.updated_at
    LIMIT ${STALE_PER_SWEEP}
  `);
  return rows.map((row) => toRuleRecord(row as Record<string, unknown>));
}

/**
 * Claim a card for a rule, and say whether this caller won it.
 *
 * ONCE per silence, not once per lifetime. A move-triggered rule fires on an
 * EVENT, which happens once; a time trigger fires on a CONDITION that stays
 * true every hour until somebody acts, so without a claim the sweep would open
 * the same task every hour — which is exactly how people learn to ignore the
 * thing meant to save them.
 *
 * But «once ever» is the wrong kind of once: a lead reminded in March, worked
 * on in April and forgotten again in May deserves a second reminder. So the
 * claim is not insert-only — it is re-won when the card has been TOUCHED since
 * the rule last spoke (`fired_at < updated_at`). No hook anywhere else has to
 * remember to clear anything, which is the point: the record's own timestamp
 * is the fact, and every write path already moves it.
 *
 * The unique index does the arbitration, so two overlapping sweeps cannot both
 * act (the event drain's lesson, #599, in the shape this table can carry).
 */
export async function claimStaleFire(
  ruleId: string,
  entityType: string,
  entityId: string,
  touchedAt: Date,
): Promise<boolean> {
  const rows = await db.execute<{ id: string }>(sql`
    INSERT INTO ${automationFires} (rule_id, entity_type, entity_id)
    VALUES (${ruleId}::uuid, ${entityType}, ${entityId}::uuid)
    ON CONFLICT (rule_id, entity_type, entity_id) DO UPDATE
      SET fired_at = now()
      WHERE automation_fires.fired_at < ${touchedAt.toISOString()}::timestamptz
    RETURNING id
  `);
  return rows.length > 0;
}

/**
 * One pass over every active time-triggered rule.
 *
 * Per-rule try/catch, like `runAutomationRules`: one rule pointing at a stage
 * somebody deleted must not stop the others. `act` is the caller's — the
 * engine owns what a rule DOES, this file owns when.
 */
export async function runStaleRules(
  act: (
    rule: typeof automationRules.$inferSelect,
    board: ConditionBoard,
    card: RuleRecord,
  ) => Promise<boolean>,
): Promise<number> {
  const rules = await db
    .select()
    .from(automationRules)
    .where(
      and(
        eq(automationRules.active, true),
        sql`${automationRules.triggerType} IN ('lead_stale', 'deal_stale')`,
      ),
    );

  let fired = 0;
  for (const rule of rules) {
    const board = ruleBoard(rule.triggerType);
    if (!board || !rule.triggerStageId || !rule.staleDays) continue;
    try {
      const conditions = conditionsSchema.parse(rule.conditions ?? []);
      let firedHere = 0;
      for (const card of await staleCandidates(board, rule.triggerStageId, rule.staleDays)) {
        if (!conditionsMatch(conditions, conditionValues(board, card))) continue;
        // Claim FIRST: acting and then recording would open the same task
        // twice if anything after the claim threw. A claim the action then
        // declines (nobody to assign to) stays spent on purpose — retrying it
        // hourly would only repeat the same warning for ever — but it is NOT
        // counted, because a fire count that outruns the tasks it opened is
        // the one number the owner uses to tell a working rule from a typo.
        if (!(await claimStaleFire(rule.id, board, card.id, card.updatedAt))) continue;
        if (await act(rule, board, card)) firedHere += 1;
      }
      if (firedHere > 0) {
        await db
          .update(automationRules)
          .set({
            fireCount: sql`${automationRules.fireCount} + ${firedHere}`,
            lastFiredAt: new Date(),
          })
          .where(eq(automationRules.id, rule.id));
        fired += firedHere;
      }
    } catch (err) {
      logger.error({ err, ruleId: rule.id }, 'stale automation rule failed');
    }
  }
  return fired;
}
