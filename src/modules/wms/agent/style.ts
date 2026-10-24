import { eq, sql } from 'drizzle-orm';
import { writeAudit, type AuditContext } from '../../platform/audit/service';
import { db } from '../../platform/db/client';
import { agentConfig } from '../../platform/db/schema';
import { AgentConfigError, agentTablesReady, mayRunAgent } from './config';
import { maskForModel } from './kb';

/**
 * His style guide (spec §17.5/§17.12, review leak-1): how he writes, in his
 * own words' SHAPE and never their content.
 *
 * The first design retrieved his old replies to OTHER customers as examples,
 * which carried their names, factories, codes and discounts into a stranger's
 * draft. There is no cross-chat retrieval at all now: `scripts/agent-style.ts`
 * reads his own out rows through `maskForModel` (digits → N, codes, phones and
 * links → […], known names → [ism]), the analyst model writes a short guide
 * from the MASKED text, it lands in `style_guide_proposed`, and only his press
 * here copies it into `style_guide` — the text the drafting prompt reads.
 */

/** The guide's ceiling — it sits in every run's cached head. */
export const STYLE_MAX_CHARS = 1_500;
/** How much masked sample the proposal reads, at most. */
export const STYLE_SAMPLE_CHARS = 24_000;

const CONFIG_AUDIT_ID = '00000000-0000-0000-0000-000000000136';

/**
 * «Uslubni tasdiqlash» — the configured owner or the super_admin role
 * (`mayRunAgent`), audited. Copies the proposal as it stands; there is no
 * second writer of `style_guide`.
 */
export async function approveStyleGuide(
  actor: { id: string; roles: readonly string[] },
  ctx: AuditContext,
): Promise<{ styleGuide: string; approvedAt: Date }> {
  if (!(await agentTablesReady())) throw new AgentConfigError('not_ready');
  return db.transaction(async (tx) => {
    const [row] = await tx.select().from(agentConfig).where(eq(agentConfig.id, 1)).for('update');
    if (!row) throw new AgentConfigError('not_ready');
    if (!mayRunAgent(actor, { ownerUserId: row.ownerUserId })) throw new AgentConfigError('forbidden');
    const proposal = row.styleGuideProposed?.trim() ?? '';
    if (!proposal || [...proposal].length > STYLE_MAX_CHARS) throw new AgentConfigError('bad_value');
    const now = new Date();
    await tx
      .update(agentConfig)
      .set({ styleGuide: proposal, styleApprovedAt: now, styleApprovedBy: actor.id, updatedBy: actor.id, updatedAt: now })
      .where(eq(agentConfig.id, 1));
    await writeAudit(tx, ctx, {
      entityType: 'agent_config',
      entityId: CONFIG_AUDIT_ID,
      action: 'update',
      before: { styleGuide: row.styleGuide ? `${[...row.styleGuide].length} belgi` : null },
      after: { styleGuide: `${[...proposal].length} belgi`, styleApprovedAt: now.toISOString() },
    });
    return { styleGuide: proposal, approvedAt: now };
  });
}

/**
 * The masked sample the model reads: each of his messages masked, empties and
 * repeats dropped (a «Rahmat» typed four hundred times teaches nothing), the
 * NEWEST kept when the sample is over the budget. Pure.
 */
export function maskedSample(
  bodies: readonly string[],
  knownNames: readonly string[],
  budget = STYLE_SAMPLE_CHARS,
): { text: string; used: number } {
  const seen = new Set<string>();
  const kept: string[] = [];
  let total = 0;
  // Newest first in, so the budget keeps the recent end.
  const lowered = knownNames.map((n) => [n, n.toLowerCase()] as const);
  for (let i = bodies.length - 1; i >= 0; i--) {
    const body = bodies[i] ?? '';
    // Only the names this message can contain reach the mask: it builds one
    // pattern per name, and the client book is thousands of them.
    const lower = body.toLowerCase();
    const present = lowered.filter(([, l]) => lower.includes(l)).map(([n]) => n);
    const masked = maskForModel(body, present).replace(/\s+/gu, ' ').trim();
    if (masked === '' || seen.has(masked.toLowerCase())) continue;
    if (total + masked.length + 3 > budget) break;
    seen.add(masked.toLowerCase());
    kept.unshift(masked);
    total += masked.length + 3;
  }
  return { text: kept.map((line) => `— ${line}`).join('\n'), used: kept.length };
}

/** His HUMAN out messages on his account, oldest first — an AI-sent row is never his style. */
export async function humanOutBodies(ownerUserId: string, limit = 1_500): Promise<string[]> {
  const rows = await db.execute<{ body: string }>(sql`
    SELECT m.body FROM tg_messages m
     WHERE m.manager_user_id = ${ownerUserId} AND m.direction = 'out'
       AND m.body IS NOT NULL AND btrim(m.body) <> ''
       AND NOT EXISTS (
         SELECT 1 FROM agent_outbox o
          WHERE o.manager_user_id = m.manager_user_id AND o.tg_message_id = m.tg_message_id)
     ORDER BY m.sent_at DESC
     LIMIT ${limit}`);
  return rows.map((r) => r.body).reverse();
}

/**
 * Every name the mask must hide: the client book and the staff. `parts` adds
 * each word of a name (he writes «Aziz aka», never «Aziz Karimov») — right for
 * the style sample, where over-masking costs nothing; a kb REFUSAL asks whole
 * names only, or «Sklad» in «Sklad Market» would refuse every warehouse fact.
 */
export async function knownNamesForMask(parts = true): Promise<string[]> {
  const rows = await db.execute<{ name: string }>(sql`
    SELECT name FROM clients WHERE name IS NOT NULL AND btrim(name) <> ''
    UNION
    SELECT full_name AS name FROM users WHERE full_name IS NOT NULL AND btrim(full_name) <> ''`);
  const names = new Set<string>();
  for (const r of rows) {
    const whole = r.name.trim();
    names.add(whole);
    if (parts) for (const part of whole.split(/\s+/u)) if ([...part].length >= 3) names.add(part);
  }
  return [...names];
}

/** The proposal, stored for his press. Refused when the 0136 table is absent. */
export async function storeStyleProposal(text: string): Promise<void> {
  if (!(await agentTablesReady())) throw new AgentConfigError('not_ready');
  const clean = text.trim();
  if (!clean || [...clean].length > STYLE_MAX_CHARS) throw new AgentConfigError('bad_value');
  await db
    .update(agentConfig)
    .set({ styleGuideProposed: clean, updatedAt: new Date() })
    .where(eq(agentConfig.id, 1));
}
