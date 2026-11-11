import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';
import { ANALYST_MODEL, MODEL_USD_PER_MTOK, STAFF_MODEL, approxMicroUsd, microUsdToUsd } from '@/modules/platform/ai/model';
import { limitOf } from '@/modules/wms/calc/ai-press';

/**
 * The pressed-AI ledger's pure halves and the shape no behavioural test can
 * see (0144, docs/TARKIB-TAKLIFLAR.md §1.3). The ceiling itself — ten presses
 * at once against three left — is ai-press.integration's.
 */
const strip = (src: string) => src.replace(/\/\*[\s\S]*?\*\//g, '').replace(/(^|[^:])\/\/.*$/gm, '$1');

describe('the limit a person typed', () => {
  it('is a whole number of presses, and anything else is «off» — a cap on a bill fails closed', () => {
    expect(limitOf(300)).toBe(300);
    expect(limitOf('50')).toBe(50);
    expect(limitOf(3.9)).toBe(3);
    for (const typed of [0, -1, Number.NaN, Number.POSITIVE_INFINITY, null, undefined, '', 'ko‘p', {}]) {
      expect(limitOf(typed), String(typed)).toBe(0);
    }
  });
});

describe('≈ dollars from token counts', () => {
  it('both model constants have a list price', () => {
    for (const model of [ANALYST_MODEL, STAFF_MODEL]) {
      expect(MODEL_USD_PER_MTOK[model], model).toBeDefined();
      expect(MODEL_USD_PER_MTOK[model]!.input).toBeGreaterThan(0);
      expect(MODEL_USD_PER_MTOK[model]!.output).toBeGreaterThan(MODEL_USD_PER_MTOK[model]!.input);
    }
  });

  it('dollars per million tokens is micro-dollars per token', () => {
    const price = MODEL_USD_PER_MTOK[ANALYST_MODEL]!;
    const micro = approxMicroUsd([{ model: ANALYST_MODEL, inputTokens: 1200, outputTokens: 340 }]);
    expect(micro).toBe(1200 * price.input + 340 * price.output);
    expect(microUsdToUsd(1_234_567)).toBe(1.23);
    expect(microUsdToUsd(5_000)).toBe(0.01);
    expect(microUsdToUsd(4_999)).toBe(0);
    expect(approxMicroUsd([])).toBe(0);
  });

  it('a model with no price is «unknown», never a guess — unless it spent nothing', () => {
    expect(approxMicroUsd([{ model: 'unpriced', inputTokens: 10, outputTokens: 0 }])).toBeNull();
    expect(
      approxMicroUsd([
        { model: ANALYST_MODEL, inputTokens: 10, outputTokens: 10 },
        { model: 'unpriced', inputTokens: 0, outputTokens: 5 },
      ]),
    ).toBeNull();
    // A row that only RESERVED a press spent no tokens and names no price it needs.
    expect(approxMicroUsd([{ model: 'unpriced', inputTokens: 0, outputTokens: 0 }])).toBe(0);
  });

  it('no model id is written beside the prices: the map is keyed by the constants', () => {
    const src = strip(readFileSync('src/modules/platform/ai/model.ts', 'utf8'));
    const map = src.slice(src.indexOf('export const MODEL_USD_PER_MTOK'), src.indexOf('export interface ModelTokens'));
    expect(map).toContain('[ANALYST_MODEL]:');
    expect(map).toContain('[STAFF_MODEL]:');
    expect(map).not.toMatch(/'[a-z]+-[a-z0-9-]+'/);
  });
});

describe('the ledger’s shape', () => {
  const press = strip(readFileSync('src/modules/wms/calc/ai-press.ts', 'utf8'));

  it('the lock is its OWN statement, before the counting insert — folded into it, ten of ten passed a limit of three', () => {
    const body = press.slice(press.indexOf('export async function reservePress('), press.indexOf('export type PressOutcome'));
    const lock = body.indexOf('await tx.execute(sql`SELECT pg_advisory_xact_lock(');
    const insert = body.indexOf('INSERT INTO ai_calc_passes');
    expect(lock).toBeGreaterThan(0);
    expect(insert).toBeGreaterThan(lock);
    // …and the limit is read on the pool BEFORE the transaction opens (tx-pool).
    expect(body.indexOf('await pressLimit(input.kind)')).toBeLessThan(body.indexOf('db.transaction('));
    expect(body.indexOf('await pressLimit(input.kind)')).toBeGreaterThan(0);
  });

  it('the cap and the number shown count with ONE fragment', () => {
    expect(press.match(/outcome IS DISTINCT FROM 'no_answer'/g)).toHaveLength(1);
    const reserve = press.slice(press.indexOf('export async function reservePress('), press.indexOf('export type PressOutcome'));
    const today = press.slice(press.indexOf('export async function pressToday('));
    expect(reserve).toContain('${pressCountedSql(input.kind)}');
    expect(today).toContain('${pressCountedSql(kind)}');
  });

  it('the dollars are computed only behind the sight', () => {
    const today = press.slice(press.indexOf('export async function pressToday('));
    expect(today).toMatch(/pressToday\(kind: PressKind, sight: CompanyMoneySight \| null\)/);
    expect(today.indexOf('if (!sight) return { used, limit, usd: null, usd30: null };')).toBeGreaterThan(0);
    expect(today.indexOf('approxMicroUsd(')).toBeGreaterThan(today.indexOf('if (!sight) return'));
  });
});

/**
 * #472, in the shape 0144 could have re-made it: a column DECLARED on a
 * drizzle table is named by every insert through that object — and two
 * writers on the busiest paths insert through these two.
 */
describe('0144’s columns on old tables are SQL-only', () => {
  const schema = readFileSync('src/modules/platform/db/schema/wms.ts', 'utf8');
  const platform = readFileSync('src/modules/platform/db/schema/platform.ts', 'utf8');
  const tableBody = (src: string, name: string) => {
    const start = src.indexOf(`pgTable(\n  '${name}',\n  {`);
    expect(start, name).toBeGreaterThan(-1);
    return src.slice(start, src.indexOf('\n  },\n', start));
  };

  it('`ai_calc_passes` declares none of lot_id / batch_id / outcome (recordAiPass inserts through it and swallows its failure)', () => {
    const body = tableBody(schema, 'ai_calc_passes');
    expect(body).not.toMatch(/uuid\('lot_id'\)|uuid\('batch_id'\)|text\('outcome'\)/);
    expect(body).toContain("requestId: uuid('request_id')");
  });

  it('`client_notices` does not declare asked_by (claimReceivedNotice inserts through it inside confirmReceipt’s transaction)', () => {
    const body = tableBody(platform, 'client_notices');
    expect(body).not.toMatch(/asked_by/);
    expect(body).toContain("refId: uuid('ref_id')");
  });

  it('no file but the ledger’s own names the three columns in a statement on that table', () => {
    const ai = readFileSync('src/modules/wms/calc/ai-cost.ts', 'utf8');
    expect(strip(ai)).not.toMatch(/lot_id|batch_id|outcome/);
  });
});
