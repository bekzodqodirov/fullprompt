import { createServer, type Server } from 'node:http';
import { readFileSync } from 'node:fs';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { realCallModel } from '@/modules/platform/ai/model';

/**
 * A model round of the AI sotuvchi is bounded by the RUN's wall clock (`LOOP_WALL_MS`, run.ts), not by the seam's own
 * deadline twice over. The seam gives one call 60 seconds and the client retries a timeout once, so a round that
 * generated past the deadline — which the 16 000-token ceiling makes possible — cost two requests and two minutes
 * (the U review, flow lens: measured 120.5 s, 2 requests), the run lived ~210 s against its 90-second wall, and every
 * other customer's line waited behind it on the one inbound worker. A request that names its BUDGET is given that
 * much in all: the client's deadline is the smaller of the two and nothing is retried inside it — the sweep retries
 * an errored ask once by design (jobs step 4), and a second request is a second bill for one message.
 *
 * The real SDK against a local server that accepts the request and never answers.
 */

let server: Server;
let hits = 0;
const saved = { url: process.env.ANTHROPIC_BASE_URL, key: process.env.ANTHROPIC_API_KEY };

beforeAll(async () => {
  server = createServer((req) => {
    hits += 1;
    req.resume();
  });
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', () => resolve()));
  const { port } = server.address() as { port: number };
  process.env.ANTHROPIC_BASE_URL = `http://127.0.0.1:${port}`;
  process.env.ANTHROPIC_API_KEY = 'test-key';
});

afterAll(async () => {
  server.closeAllConnections();
  await new Promise<void>((resolve) => server.close(() => resolve()));
  if (saved.url === undefined) delete process.env.ANTHROPIC_BASE_URL;
  else process.env.ANTHROPIC_BASE_URL = saved.url;
  if (saved.key === undefined) delete process.env.ANTHROPIC_API_KEY;
  else process.env.ANTHROPIC_API_KEY = saved.key;
});

describe('a model call that names its budget', () => {
  it('ends inside the budget, after ONE request — the client retries nothing inside it', async () => {
    const before = hits;
    const started = Date.now();
    await expect(
      realCallModel({
        model: 'stand-in',
        system: 's',
        messages: [{ role: 'user', content: [{ type: 'text', text: 'salom' }] }],
        tools: [],
        maxTokens: 16_000,
        budgetMs: 1_500,
      }),
    ).rejects.toThrow();
    const elapsed = Date.now() - started;
    expect(hits - before).toBe(1);
    expect(elapsed).toBeGreaterThanOrEqual(1_400);
    expect(elapsed).toBeLessThan(5_000);
  }, 15_000);
});

describe('the agent’s loop hands each round what is left of its wall', () => {
  const strip = (src: string) => src.replace(/\/\*[\s\S]*?\*\//gu, '').replace(/(^|[^:])\/\/.*$/gmu, '$1');
  const run = strip(readFileSync('src/modules/wms/agent/run.ts', 'utf8'));
  const loop = run.slice(run.indexOf('export async function runLoop'), run.indexOf('async function eligibilityFacts'));

  it('the round is refused once the wall is spent, and otherwise asked with the rest of it as its budget', () => {
    expect(loop.length, 're-anchor: runLoop').toBeGreaterThan(500);
    expect(loop).toMatch(/const elapsed = input\.now\(\)\.getTime\(\) - started;\s*if \(elapsed > LOOP_WALL_MS\) throw new Error\('wall_clock'\);/u);
    expect(loop).toMatch(/budgetMs: Math\.max\(1, LOOP_WALL_MS - elapsed\),/u);
  });
});
