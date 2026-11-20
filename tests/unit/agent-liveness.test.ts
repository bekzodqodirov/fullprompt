import { readFileSync } from 'node:fs';
import ts from 'typescript';
import { describe, expect, it } from 'vitest';
import { INTERRUPTED_RUN_MS } from '@/modules/wms/agent/jobs';
import {
  INELIGIBLE_LIVENESS,
  LIVENESS_CLEARED_TEXT,
  RUN_OUTCOMES,
  livenessAlarmText,
  livenessDetailOf,
  livenessDetailText,
  livenessOf,
} from '@/modules/wms/agent/liveness';
import type { Ineligible } from '@/modules/wms/agent/eligibility';

/**
 * «AI sotuvchi javob bermayapti» (stage 1a §4.5, R9): the verdict over an anchor's newest run, every stored outcome
 * and every refusal judged, and the words. The sweep — working hours, by anchor, once per fault, taken back once — is
 * `tests/integration/agent-liveness.integration.test.ts`.
 */

const NOW = new Date('2026-11-17T07:00:00Z');
const run = (outcome: string, error: string | null = null, ageMs = 60_000) => ({ outcome, error, createdAt: new Date(NOW.getTime() - ageMs) });

/** The members of `Ineligible` as eligibility.ts declares them — read with TypeScript's parser, never restated. */
function ineligibleMembers(): string[] {
  const path = 'src/modules/wms/agent/eligibility.ts';
  const source = ts.createSourceFile(path, readFileSync(path, 'utf8'), ts.ScriptTarget.Latest, true, ts.ScriptKind.TS);
  const out: string[] = [];
  source.forEachChild((n) => {
    if (ts.isTypeAliasDeclaration(n) && n.name.text === 'Ineligible' && ts.isUnionTypeNode(n.type)) {
      for (const t of n.type.types) if (ts.isLiteralTypeNode(t) && ts.isStringLiteral(t.literal)) out.push(t.literal.text);
    }
  });
  return out;
}

describe('livenessOf — was the line answered, or will it be?', () => {
  it('no run at all: unanswered (the worker or the queue is dead)', () => {
    expect(livenessOf(null, NOW)).toBe('unanswered');
  });

  it('a draft (gone or waiting on his card), no reply needed, a notice to him, a stand-down: answered', () => {
    for (const outcome of ['draft', 'no_reply', 'notice', 'stood_down']) expect(livenessOf(run(outcome), NOW), outcome).toBe('answered');
  });

  it('a cap, an error: unanswered', () => {
    expect(livenessOf(run('capped', 'daily_token_cap'), NOW)).toBe('unanswered');
    expect(livenessOf(run('error', 'boom'), NOW)).toBe('unanswered');
  });

  it('a run reserved longer than any run lives died with its process; a young one is still running', () => {
    expect(livenessOf(run('reserved', null, INTERRUPTED_RUN_MS + 1_000), NOW)).toBe('unanswered');
    expect(livenessOf(run('reserved', null, 30_000), NOW)).toBe('answered');
  });

  it('a refusal by EVERY member of `Ineligible`: the three faults unanswered, the rest by design', () => {
    const members = ineligibleMembers();
    expect(members.length, 're-anchor: the union').toBeGreaterThan(10);
    expect(Object.keys(INELIGIBLE_LIVENESS).sort()).toEqual([...members].sort());
    const faults = members.filter((m) => livenessOf(run('refused', m), NOW) === 'unanswered').sort();
    expect(faults).toEqual(['account_paused', 'listener_behind', 'session_not_confirmed']);
  });

  it('a `draftWorthy` reason shares the column and is by design; an outcome no build knows errs toward telling', () => {
    for (const why of ['media_only', 'closing', 'empty', 'voice_only']) expect(livenessOf(run('refused', why), NOW), why).toBe('answered');
    expect(livenessOf(run('zz_new'), NOW)).toBe('unanswered');
  });

  it('every outcome the 0138 CHECK admits is one `livenessOf` judges', () => {
    const schema = readFileSync('src/modules/platform/db/schema/agent.ts', 'utf8');
    const at = schema.indexOf("'agent_runs_outcome_check'");
    expect(at, 're-anchor: the CHECK').toBeGreaterThan(0);
    const check = schema.slice(at, schema.indexOf('`', schema.indexOf('`', at) + 1));
    const listed = [...check.matchAll(/'([a-z_]+)'/gu)].map((m) => m[1]!).filter((v) => v !== 'agent_runs_outcome_check');
    expect([...RUN_OUTCOMES].sort()).toEqual(listed.sort());
  });

  // The type is the compile-time half: a member P2 adds does not compile until somebody classifies it.
  it('the map is a Record over the union, never a Partial', () => {
    const src = readFileSync('src/modules/wms/agent/liveness.ts', 'utf8');
    expect(src).toMatch(/export const INELIGIBLE_LIVENESS: Record<Ineligible, 'by_design' \| 'fault'> = \{/u);
    const typed: Record<Ineligible, 'by_design' | 'fault'> = INELIGIBLE_LIVENESS;
    expect(typed).toBe(INELIGIBLE_LIVENESS);
  });
});

describe('the words — counts only, no customer in them (leak-13)', () => {
  const detail = { n: 3, oldest: new Date(NOW.getTime() - 12 * 60_000) };

  it('the alarm names how many and since how long; «AI sahifasini oching» and the link only for a page reader (J17)', () => {
    process.env.APP_URL = 'https://gsrwms.uz';
    expect(livenessAlarmText(detail, NOW, false)).toBe('⚠️ AI sotuvchi javob bermayapti: 3 ta mijoz 12 daqiqadan beri kutyapti.');
    expect(livenessAlarmText(detail, NOW, true).split('\n')).toEqual([
      '⚠️ AI sotuvchi javob bermayapti: 3 ta mijoz 12 daqiqadan beri kutyapti.',
      'AI sahifasini oching.',
      'https://gsrwms.uz/suhbatlar/ai',
    ]);
  });

  it('the clearing line claims nothing nobody knows — no customer is waiting, never «the AI answers again» (#1106)', () => {
    expect(LIVENESS_CLEARED_TEXT).toMatch(/qolmadi/u);
    expect(LIVENESS_CLEARED_TEXT).not.toMatch(/javob beryapti\./u);
  });

  it('the state row’s detail is read back as written; a detail no build wrote is null', () => {
    expect(livenessDetailOf(livenessDetailText(detail))).toEqual(detail);
    expect(livenessDetailOf('3 ta')).toBeNull();
    expect(livenessDetailOf(null)).toBeNull();
  });
});

describe('where the sweep calls it — step 3b, in its own catch, inside the running branch (§4.5)', () => {
  it('after the deploy-gap pass, before the errored-run retry, inside `agentRunning && aiConfigured`', () => {
    const src = readFileSync('src/modules/wms/agent/jobs.ts', 'utf8');
    const sweep = src.slice(src.indexOf('export async function agentSweep'));
    const branch = sweep.indexOf('if (agentRunning(config) && aiConfigured()) {');
    const gap = sweep.indexOf('// 3. The deploy gap');
    const step = sweep.indexOf('await sweepUnanswered(config, now);');
    const retry = sweep.indexOf('// 4. An errored ASK');
    expect(branch, 're-anchor').toBeGreaterThan(0);
    expect(gap).toBeGreaterThan(branch);
    expect(step).toBeGreaterThan(gap);
    expect(step).toBeLessThan(retry);
    const around = sweep.slice(sweep.lastIndexOf('try {', step), sweep.indexOf('}', sweep.indexOf('catch (err)', step)) + 1);
    expect(around).toMatch(/try \{\s*const \{ sweepUnanswered \} = await import\('\.\/liveness'\);\s*unanswered = await sweepUnanswered\(config, now\);\s*\} catch \(err\) \{\s*logger\.error\(/u);
  });

  it('nothing but the signals module writes the state table: the alarm asks its writer pair', () => {
    const src = readFileSync('src/modules/wms/agent/liveness.ts', 'utf8');
    expect(src).toMatch(/import \{ clearSignal, raiseSignal, signalStanding \} from '\.\.\/\.\.\/platform\/diagnostics\/signals';/u);
  });
});
