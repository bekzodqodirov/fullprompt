import { readdirSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { AGENT_MAX_TOKENS } from '@/modules/wms/agent/run';

/**
 * The AI sotuvchi's model rounds leave room for THINKING (2026-11-18 on his server: 4 of 10 runs ended `max_tokens`
 * at a ceiling of 1 500 — the model thinks adaptively by default, those tokens count inside `max_tokens`, and the
 * round ran out before `compose_reply`, so the customer got nothing). One named ceiling (`AGENT_MAX_TOKENS`,
 * run.ts), at least 8 000, and every agent model call passes it — a literal number anywhere is a second ceiling
 * nobody raised with this one.
 */

const AGENT_DIR = 'src/modules/wms/agent';

/** Comments out — a sentence about «maxTokens: 1 500» is history, not a call. */
const strip = (src: string) => src.replace(/\/\*[\s\S]*?\*\//gu, '').replace(/(^|[^:])\/\/.*$/gmu, '$1');

const sources = readdirSync(AGENT_DIR)
  .filter((f) => f.endsWith('.ts'))
  .map((f) => ({ file: f, src: strip(readFileSync(join(AGENT_DIR, f), 'utf8')) }));

describe('the agent’s model calls leave room for thinking', () => {
  it('the ceiling is at least 8 000 tokens', () => {
    expect(AGENT_MAX_TOKENS).toBeGreaterThanOrEqual(8_000);
  });

  it('every agent model call passes the one ceiling — no literal anywhere in the module', () => {
    const calls = sources.flatMap(({ file, src }) => [...src.matchAll(/\bmax_?tokens\s*:\s*([^,\n}]+)/giu)].map((m) => ({ file, value: m[1]!.trim() })));
    expect(calls.length, 're-anchor: the loop’s call').toBeGreaterThan(0);
    for (const call of calls) expect(call.value, call.file).toBe('AGENT_MAX_TOKENS');
  });

  it('the seam sends the ceiling as given — nothing clamps it on the way out', () => {
    const model = strip(readFileSync('src/modules/platform/ai/model.ts', 'utf8'));
    expect(model).toMatch(/max_tokens: req\.maxTokens,/u);
  });
});
