import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';
import { bodyOf, read, srcFiles } from '../fixtures/source-shape';

/**
 * The bot door on the request (0140, docs/IKKI-ESHIK.md §0) — its WIRING,
 * source-shape, comments stripped (#725).
 *
 * Each assertion is a place where a correct module is reached by the wrong
 * road: a column declared on the drizzle table (every calc INSERT and
 * whole-row select then names it, and one migration behind they all answer
 * 42703 — §0.4, #472), a statement that names the column outside its one
 * module, a door that reaches the request through no caller, a pass that
 * reads the door off its job payload instead of the row (§0.3).
 */
const SCHEMA = read('src/modules/platform/db/schema/wms.ts');

describe('the column is SQL-only, through one module', () => {
  it('the drizzle table does not declare it', () => {
    const table = SCHEMA.slice(SCHEMA.indexOf("export const calcRequests = pgTable("));
    const body = table.slice(0, table.indexOf('\n);'));
    expect(body).toContain("aiPassJob: uuid('ai_pass_job')");
    expect(body).not.toContain('intake_door');
    expect(body).not.toMatch(/\bintakeDoor\b/);
  });

  it('no code outside wms/calc/intake-door.ts names the column', () => {
    const naming = srcFiles()
      .filter((f) => f.path !== 'src/modules/wms/calc/intake-door.ts')
      .filter((f) => f.text.includes('intake_door'))
      .map((f) => f.path);
    expect(naming).toEqual([]);
  });

  it('the writer is guarded by the probe, and the reader goes through to_jsonb', () => {
    const door = read('src/modules/wms/calc/intake-door.ts');
    expect(bodyOf(door, 'export async function writableIntakeDoor(')).toContain('await intakeDoorReady()');
    expect(bodyOf(door, 'export function intakeDoorSql(')).toContain("to_jsonb(${row}) ->> 'intake_door'");
    expect(bodyOf(door, 'export async function intakeDoorReady(')).toContain('information_schema.columns');
  });

  it('openCalcRequest asks the probe BEFORE its transaction and stamps inside it', () => {
    const service = read('src/modules/wms/calc/service.ts');
    const open = bodyOf(service, 'export async function openCalcRequest(');
    const probe = open.indexOf('await writableIntakeDoor(input.intakeDoor)');
    const tx = open.indexOf('db.transaction(async (tx)');
    const stamp = open.indexOf('if (door) await stampIntakeDoorInTx(tx, id, door)');
    expect(probe, 'the probe').toBeGreaterThan(0);
    expect(tx, 'the probe is pooled: before the transaction (#714)').toBeGreaterThan(probe);
    expect(stamp, 'the stamp is inside it').toBeGreaterThan(tx);
  });
});

describe('every door reaches the request', () => {
  it('the bot lands its collection’s door; the agent, the thread and the card name none', () => {
    const bot = read('src/modules/platform/telegram/staff-bot.ts');
    // The collection's ONE door (`collectionDoor`) — a seeded one's `seedDoor`
    // (as-built review DOORS-3), never a second read of the source.
    expect(bodyOf(bot, 'export async function landCollectedIntake(')).toContain('intakeDoor: collectionDoor(state)');
    const land = read('src/modules/wms/calc/intake-land.ts');
    expect(bodyOf(land, 'export async function landIntake(')).toContain('intakeDoor: input.intakeDoor');
    // The agent on BOTH its paths: `landIntake` and the re-queue's own open.
    const agent = read('src/modules/wms/agent/decide.ts');
    expect(agent.match(/intakeDoor: null,/g)?.length).toBe(2);
    expect(bodyOf(agent, 'async function requeueLanded(')).toContain('intakeDoor: null');
    expect(read('src/modules/wms/calc/from-thread.ts')).toContain('intakeDoor: null');
    expect(read('src/app/(protected)/hisoblash/actions.ts')).toContain('intakeDoor: null');
  });

  it('a correction copies its parent’s door, read under the parent’s lock', () => {
    const ws = read('src/modules/wms/calc/workspace.ts');
    const recalc = bodyOf(ws, 'export async function recalcFromSealed(');
    const locked = recalc.indexOf('FOR UPDATE`');
    const read_ = recalc.indexOf("intakeDoorSql(sql.raw('calc_requests'))");
    const stamp = recalc.indexOf('stampIntakeDoorInTx(tx, fresh!.id, door)');
    expect(read_, 'the door is read in the locked SELECT').toBeGreaterThan(0);
    expect(read_).toBeLessThan(locked);
    expect(stamp, 'and stamped on the new row').toBeGreaterThan(locked);
  });
});

describe('the pass reads the door from the ROW', () => {
  it('the standing’s own read hands it back, and `direct` is decided after it', () => {
    const jobs = read('src/modules/wms/calc/jobs.ts');
    const run = bodyOf(jobs, 'async function runPrefillJob(');
    const standing = run.indexOf('prefillStanding(requestId, data.rev ?? null, seen)');
    const decided = run.indexOf('direct = directPass(pass, seen.door)');
    expect(standing).toBeGreaterThan(0);
    expect(decided, 'decided from what the read saw').toBeGreaterThan(standing);
    // Never from the job: a job queued before 0140 carries none.
    expect(run).not.toMatch(/data\.(intakeDoor|door)\b/);
    const prefill = read('src/modules/wms/calc/prefill.ts');
    expect(bodyOf(prefill, 'export async function prefillStanding(')).toContain('intakeDoorSql(calcRequests)');
  });

  it('the add and seeded doors open their collection from the request’s door', () => {
    const amend = read('src/modules/platform/telegram/calc-amend.ts');
    expect(bodyOf(amend, 'async function openAdd(')).toContain('ai: collectionAiOf(stored.door, true)');
    expect(bodyOf(amend, 'async function openSeeded(')).toContain(
      'ai: collectionAiOf(stored.door, sectionParts(stored.base.section).customs)',
    );
  });

  it('the hydrate brings an older row forward through one function', () => {
    const store = readFileSync('src/modules/platform/telegram/calc-store.ts', 'utf8');
    expect(store).toContain('const state = { ...migrateIntakeState(row.state), expires:');
  });
});
