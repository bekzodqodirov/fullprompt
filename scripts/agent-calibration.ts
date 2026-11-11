import 'dotenv/config';
import { sql } from 'drizzle-orm';
import { db, pgClient } from '../src/modules/platform/db/client';
import { AUTO_PROOF, calibrationCells, categoryVerdicts, type CalibrationDraftRow } from '../src/modules/wms/agent/calibration';

/**
 * «Would the AI have been right if it had sent by itself?» — read-only, over
 * the drafts he has already decided (docs/AI-SOTUVCHI.md §18, DECISIONS #1625):
 *
 *   docker compose run --rm migrate pnpm exec tsx scripts/agent-calibration.ts          # the last 60 days
 *   docker compose run --rm migrate pnpm exec tsx scripts/agent-calibration.ts --days 30
 *
 * Writes nothing. Prints every category × confidence band × «clean» cell —
 * how many he decided and how many left unchanged, the rate and its one-sided
 * 95 % lower bound — and, per category the auto-send design could ever open,
 * whether the clean drafts the model put at ≥ 0.80 are PROVEN today
 * (≥ 50 decided, lower bound ≥ 0.80). Drafts written before 2026-11-10 carry
 * the old, undefined confidence: the table says what was, and is no gate.
 * Not a package.json command on purpose (#1228).
 */

const USAGE = 'usage: pnpm exec tsx scripts/agent-calibration.ts [--days N]';

const pct = (x: number | null) => (x === null ? '   —  ' : `${(x * 100).toFixed(1).padStart(5)}%`);

async function main(): Promise<number> {
  const args = process.argv.slice(2);
  let days = 60;
  for (let i = 0; i < args.length; i++) {
    if (args[i] === '--days' && /^\d{1,4}$/u.test(args[i + 1] ?? '')) days = Number(args[++i]);
    else {
      console.error(USAGE);
      return 2;
    }
  }
  const since = new Date(Date.now() - days * 86_400_000).toISOString();
  // «O'zi yuborish» (0145): a reply the machine pressed is nobody's decision — counted apart, never graded.
  // A database one migration behind has no verdicts to read.
  const [probe] = await db.execute<{ ok: boolean }>(sql`SELECT to_regclass('public.agent_auto_verdicts') IS NOT NULL AS ok`);
  const autoSent = probe?.ok === true
    ? sql`EXISTS (SELECT 1 FROM agent_auto_verdicts v WHERE v.draft_id = d.id AND v.state = 'pressed')`
    : sql`false`;
  const rows = await db.execute<{
    status: string;
    kind: string;
    edited: boolean;
    outbox_status: string | null;
    category: string | null;
    confidence: number | null;
    blocked: boolean;
    needs_owner: boolean;
    warnings: number;
    notes: number;
    money: boolean;
    actions: string[] | null;
    auto_sent: boolean;
  }>(sql`
    SELECT d.status, d.kind, d.final_body IS NOT NULL AS edited, o.status AS outbox_status, d.category,
           d.confidence::float8 AS confidence, d.blocked, d.needs_owner,
           CASE WHEN jsonb_typeof(d.policy->'warnings') = 'array' THEN jsonb_array_length(d.policy->'warnings') ELSE 0 END AS warnings,
           CASE WHEN jsonb_typeof(d.policy->'notes') = 'array' THEN jsonb_array_length(d.policy->'notes') ELSE 0 END AS notes,
           (EXISTS (SELECT 1 FROM jsonb_array_elements(CASE WHEN jsonb_typeof(d.policy->'ledger') = 'array' THEN d.policy->'ledger' ELSE '[]'::jsonb END) e
                     WHERE e->>'kind' = 'money')
            OR coalesce(d.policy->'memory'->>'hasEstimate', 'false') = 'true') AS money,
           (SELECT array_agg(a->>'type') FROM jsonb_array_elements(CASE WHEN jsonb_typeof(d.actions) = 'array' THEN d.actions ELSE '[]'::jsonb END) a) AS actions,
           ${autoSent} AS auto_sent
      FROM agent_drafts d
      LEFT JOIN agent_outbox o ON o.draft_id = d.id
     WHERE d.created_at >= ${since}::timestamptz`);
  const data: CalibrationDraftRow[] = rows.map((r) => ({
    status: r.status,
    kind: r.kind,
    edited: r.edited === true,
    outboxStatus: r.outbox_status,
    category: r.category,
    confidence: r.confidence === null ? null : Number(r.confidence),
    blocked: r.blocked === true,
    needsOwner: r.needs_owner === true,
    warnings: Number(r.warnings),
    notes: Number(r.notes),
    money: r.money === true,
    actions: (r.actions ?? []).filter((a): a is string => typeof a === 'string'),
    autoSent: r.auto_sent === true,
  }));

  console.log(`drafts in the last ${days} days: ${data.length} (sent by «o'zi yuborish», never graded: ${data.filter((r) => r.autoSent).length})\n`);
  console.log('category       confidence  clean  decided  unchanged    rate   lower95');
  for (const c of calibrationCells(data)) {
    console.log(
      `${c.category.padEnd(14)} ${c.band.padEnd(11)} ${(c.clean ? 'yes' : 'no').padEnd(5)} ${String(c.decided).padStart(8)} ${String(c.unchanged).padStart(10)}  ${pct(c.rate)}  ${pct(c.lower)}`,
    );
  }
  console.log(`\nwould auto-send open today? (clean drafts at confidence ≥ 0.80; needs ≥ ${AUTO_PROOF.minDecided} decided and lower95 ≥ ${AUTO_PROOF.minLower * 100}%)`);
  for (const v of categoryVerdicts(data)) {
    const need = v.proven ? 'PROVEN' : v.stillNeeded === null ? 'not at this rate' : `~${v.stillNeeded} more at this rate`;
    console.log(`  ${v.category.padEnd(14)} ${String(v.unchanged).padStart(4)}/${String(v.decided).padEnd(4)} rate ${pct(v.rate)} lower95 ${pct(v.lower)}  → ${need}`);
  }
  return 0;
}

main()
  .then((code) => {
    process.exitCode = code;
  })
  .catch((err: unknown) => {
    console.error(err instanceof Error ? err.message : err);
    process.exitCode = 1;
  })
  .finally(() => void pgClient.end());
