import { readdirSync, readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';
import { ANALYST_MODEL, MODEL_USD_PER_MTOK, STAFF_MODEL, approxMicroUsd, microUsdToUsd } from '@/modules/platform/ai/model';
import { limitOf } from '@/modules/wms/calc/ai-press';
import { SETTING_VALIDATORS, wholeNumberSettingValid } from '@/modules/platform/settings/service';

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
    expect(today.indexOf('if (!sight) return { used, limit, usd: null, usd30: null, unpriced: null };')).toBeGreaterThan(0);
    expect(today.indexOf('sum(cost_usd)')).toBeGreaterThan(today.indexOf('if (!sight) return'));
  });

  it('the dollars are frozen at SETTLE and only summed at read — a model change must not re-price last month', () => {
    const settle = press.slice(press.indexOf('export async function settlePress('), press.indexOf('export interface PressToday'));
    // Priced from the CLEANED counts — the raw usage made the UPDATE itself throw on a bad count.
    expect(settle).toContain('approxMicroUsd([{ model, inputTokens, outputTokens }])');
    expect(settle).not.toContain('approxMicroUsd([result.usage])');
    // …and frozen as MICRO-dollars at six decimals, never through the screen's rounding to the cent.
    expect(settle).toContain('(micro / 1_000_000).toFixed(6)');
    expect(press).not.toContain('microUsdToUsd(');
    expect(settle).toContain('cost_usd = ${');
    const today = press.slice(press.indexOf('export async function pressToday('));
    expect(today).not.toContain('approxMicroUsd(');
    expect(today).not.toContain('MODEL_USD_PER_MTOK');
  });

  it('«behind» is a missing column or table and nothing else — a CHECK that refuses the row is our own fault', () => {
    const reserve = press.slice(press.indexOf('export async function reservePress('), press.indexOf('export type PressOutcome'));
    expect(reserve).toContain("if (isServerBehind(err)) return { ok: false, error: 'server_behind' };");
    expect(press).not.toContain('violatedCheck');
  });
});

describe('the limit’s own box — 0 means «off for the whole company», so a typo must not BECOME 0', () => {
  it('whole digits and nothing else; «0» is a real answer', () => {
    for (const good of ['0', '1', '50', '300', '999999']) expect(wholeNumberSettingValid(good), good).toBe(true);
    for (const bad of ['', ' ', '1 000', '-5', '3.7', '3,7', '1e3', '0x10', 'abc', '1234567', '+5']) expect(wholeNumberSettingValid(bad), bad).toBe(false);
  });

  it('both pressed-AI ceilings carry the validator — and their own sentence, not the date’s', () => {
    expect(SETTING_VALIDATORS.tnved_ai_daily_limit).toBe(wholeNumberSettingValid);
    expect(SETTING_VALIDATORS.tarkib_ai_daily_limit).toBe(wholeNumberSettingValid);
    const page = strip(readFileSync('src/app/(protected)/admin/settings/page.tsx', 'utf8'));
    expect(page).toContain("tnved_ai_daily_limit: 'badValueWhole',");
    expect(page).toContain("tarkib_ai_daily_limit: 'badValueWhole',");
    for (const locale of ['ru', 'uz', 'zh-CN', 'en']) {
      const bundle = JSON.parse(readFileSync(`messages/${locale}.json`, 'utf8')) as { settings: Record<string, string> };
      expect(bundle.settings.badValueWhole, locale).toBeTruthy();
    }
  });

  it('EVERY validated setting refuses in its own words — the date’s sentence is the date’s alone', () => {
    // `badValue` asks for a date: it was drawn under the website-origins list too (a list of web
    // addresses refused with «YYYY-MM-DD yozing»). Derived: a validator added tomorrow is red here
    // until its sentence exists in four languages.
    const page = strip(readFileSync('src/app/(protected)/admin/settings/page.tsx', 'utf8'));
    const map = page.slice(page.indexOf('const BAD_VALUE_TEXT'), page.indexOf('};', page.indexOf('const BAD_VALUE_TEXT')));
    for (const key of Object.keys(SETTING_VALIDATORS)) {
      if (key === 'unpriced_gate_since') continue; // the one that IS a date
      const named = new RegExp(`\\b${key}: '(badValue\\w+)',`).exec(map);
      expect(named, `${key} has a validator and no sentence of its own`).not.toBeNull();
      for (const locale of ['ru', 'uz', 'zh-CN', 'en']) {
        const bundle = JSON.parse(readFileSync(`messages/${locale}.json`, 'utf8')) as { settings: Record<string, string> };
        expect(bundle.settings[named![1]!], `${locale} · ${named![1]}`).toBeTruthy();
      }
    }
  });

  it('«Bugun AI» on the Bojxona tab follows the page’s reading — a refresh replaces what a press answered', () => {
    const editor = strip(readFileSync('src/app/(protected)/batches/[id]/tnved/tnved-editor.tsx', 'utf8'));
    expect(editor).toContain('const [todaySeed, setTodaySeed] = useState(aiToday);');
    expect(editor).toMatch(/if \(todaySeed !== aiToday\) \{\s+setTodaySeed\(aiToday\);\s+setToday\(aiToday\);\s+\}/);
  });

  it('the bill is shown where the limit is CHANGED — the count for the page’s readers, the dollars only through the sight', () => {
    const page = strip(readFileSync('src/app/(protected)/admin/settings/page.tsx', 'utf8'));
    expect(page).toContain('const sight = companyMoneySight(actor);');
    expect(page).toContain('await pressToday(kind, sight).catch(() => null)');
    expect(page).toContain('data-testid={`setting-spent-${key}`}');
  });
});

describe('a call our own deadline abandoned is told apart from one that never ran', () => {
  const service = strip(readFileSync('src/modules/wms/tnved/service.ts', 'utf8'));
  const actions = strip(readFileSync('src/app/(protected)/batches/[id]/tnved/actions.ts', 'utf8'));

  it('the reader names the SDK’s typed timeout and carries it on its own error', () => {
    expect(service).toContain('const timedOut = err instanceof Anthropic.APIConnectionTimeoutError;');
    expect(service).toContain("throw new TnvedError('ai_failed', usage, timedOut);");
  });

  it('both actions count it: «failed», not «no_answer»', () => {
    expect(actions.match(/outcome = err\.usage \|\| err\.timedOut \? 'failed' : 'no_answer';/g)).toHaveLength(2);
    expect(actions).not.toMatch(/outcome = err\.usage \? 'failed' : 'no_answer'/);
  });

  it('the bill names the model the call was MADE with — the constant, never the provider’s echo', () => {
    expect(service).toContain('usage = { model: ANALYST_MODEL, inputTokens: spent.in, outputTokens: spent.out };');
    expect(service).not.toContain('response.model ?? ANALYST_MODEL');
  });
});

/**
 * The other session's next migration re-makes these two CHECKs for its own
 * kinds (docs/SAKKIZ-R5.md §12). Written from its handoff as it stands, that
 * file would re-make them WITHOUT the pressed kinds — passing on a fresh CI
 * database and turning every press into a refused INSERT on production. A
 * sentence in a handoff is not a fence; this is: whichever migration re-makes
 * a CHECK last must carry every kind the ledger's writers use.
 */
describe('the LAST migration that re-makes the ledger’s CHECKs still knows every pressed kind', () => {
  const dir = 'src/modules/platform/db/migrations';
  const files = readdirSync(dir)
    .filter((name) => /^\d{4}_.*\.sql$/.test(name))
    .sort();
  /**
   * A migration's SQL with its `--` comments gone (the statement-breakpoint
   * marker is kept): a comment naming a kind inside the statement must not
   * satisfy a fence about the statement.
   */
  const sqlOf = (name: string) =>
    readFileSync(`${dir}/${name}`, 'utf8')
      .split('\n')
      .filter((line) => !/^\s*--(?!> statement-breakpoint)/.test(line))
      .join('\n');
  /** `ADD CONSTRAINT <name>`, quoted or not — 0119 re-made both CHECKs unquoted. */
  const remakes = (constraint: string) => new RegExp(`ADD\\s+CONSTRAINT\\s+"?${constraint}"?\\b`, 'i');
  const lastWith = (constraint: string) => {
    const hit = [...files].reverse().find((name) => remakes(constraint).test(sqlOf(name)));
    expect(hit, constraint).toBeDefined();
    const text = sqlOf(hit!);
    const at = [...text.matchAll(new RegExp(remakes(constraint).source, 'gi'))].at(-1)!.index!;
    const end = text.indexOf('--> statement-breakpoint', at);
    return { file: hit!, body: text.slice(at, end === -1 ? undefined : end) };
  };

  it('the finder sees a re-make however it is spelled — and is blind to comments', () => {
    // 0119 re-made both CHECKs with the names UNQUOTED: a later migration written in that spelling
    // would have left 0144 as «the last» and this fence green.
    expect(remakes('ai_calc_passes_kind_check').test(sqlOf('0119_price_icons.sql'))).toBe(true);
    expect(remakes('ai_calc_passes_anchor_check').test(sqlOf('0119_price_icons.sql'))).toBe(true);
    expect(sqlOf('0144_tarkib_takliflar.sql')).not.toMatch(/^\s*-- /m);
    expect(sqlOf('0144_tarkib_takliflar.sql')).toContain('--> statement-breakpoint');
  });

  /**
   * What 0144 added to the ledger is 0144's: a later migration that adds it
   * again dies on every database that has 0144 — and since drizzle runs all
   * pending migrations in ONE transaction, nothing of that deploy lands. The
   * other session's draft (docs/SAKKIZ-R5.md) adds `lot_id`, `cost_usd` and
   * the cost CHECK under the same names; a sentence in a handoff is not a
   * fence, this is.
   */
  const reAdds = (sqlText: string): string[] => {
    const found: string[] = [];
    for (const column of ['lot_id', 'batch_id', 'outcome', 'cost_usd']) {
      if (new RegExp(`ALTER\\s+TABLE\\s+"?ai_calc_passes"?\\s+ADD\\s+COLUMN\\s+"?${column}"?\\b`, 'i').test(sqlText)) found.push(`column ${column}`);
    }
    for (const constraint of ['ai_calc_passes_cost_check', 'ai_calc_passes_outcome_check']) {
      const add = remakes(constraint).exec(sqlText);
      if (!add) continue;
      const dropped = new RegExp(`DROP\\s+CONSTRAINT\\s+IF\\s+EXISTS\\s+"?${constraint}"?\\b`, 'i').exec(sqlText);
      if (!dropped || dropped.index > add.index) found.push(`constraint ${constraint}`);
    }
    return found;
  };

  it('no migration after 0144 adds again what 0144 owns on the ledger', () => {
    const later = files.filter((name) => name > '0144_tarkib_takliflar.sql');
    for (const name of later) expect(reAdds(sqlOf(name)), name).toEqual([]);
    // The rule itself, on the draft it exists for (its own `lot_id` line removed, as the handoff first said):
    const draft = [
      'ALTER TABLE "ai_calc_passes" ADD COLUMN "cost_usd" numeric(12,6);',
      '--> statement-breakpoint',
      'ALTER TABLE "ai_calc_passes" ADD CONSTRAINT "ai_calc_passes_cost_check" CHECK ("cost_usd" IS NULL OR "cost_usd" >= 0);',
    ].join('\n');
    expect(reAdds(draft)).toEqual(['column cost_usd', 'constraint ai_calc_passes_cost_check']);
    // …and what such a migration may do instead: no column, and the CHECK dropped first.
    const fine = [
      'ALTER TABLE "ai_calc_passes" DROP CONSTRAINT IF EXISTS "ai_calc_passes_cost_check";',
      '--> statement-breakpoint',
      'ALTER TABLE ai_calc_passes ADD CONSTRAINT ai_calc_passes_cost_check CHECK (cost_usd IS NULL OR cost_usd >= 0);',
    ].join('\n');
    expect(reAdds(fine)).toEqual([]);
    // 0144 itself is the owner: it adds all four, and its price column refuses NaN.
    expect(reAdds(sqlOf('0144_tarkib_takliflar.sql')).sort()).toEqual([
      'column batch_id',
      'column cost_usd',
      'column lot_id',
      'column outcome',
      'constraint ai_calc_passes_cost_check',
      'constraint ai_calc_passes_outcome_check',
    ]);
    expect(sqlOf('0144_tarkib_takliflar.sql')).toContain(`"cost_usd" <> 'NaN'::numeric`);
  });
  const ledger = strip(readFileSync('src/modules/wms/calc/ai-press.ts', 'utf8'));
  const kinds = [...ledger.matchAll(/^\s+(\w+): '(\w+_ai_daily_limit)',$/gm)].map((m) => m[1]!);

  it('finds the pressed kinds in the module itself', () => {
    expect(kinds.sort()).toEqual(['tarkib', 'tnved']);
  });

  it('the kind list', () => {
    const { file, body } = lastWith('ai_calc_passes_kind_check');
    for (const kind of kinds) expect(body, `${file} re-makes the kind CHECK without '${kind}'`).toContain(`'${kind}'`);
    // …and the kinds that were there before it, so it never narrows either.
    for (const kind of ['intake', 'grouping', 'pick', 'invoice', 'similar']) expect(body, `${file} · ${kind}`).toContain(`'${kind}'`);
  });

  it('the anchor: a pressed kind stands on a LOT', () => {
    const { file, body } = lastWith('ai_calc_passes_anchor_check');
    for (const kind of kinds) {
      expect(body, `${file} re-makes the anchor CHECK without a '${kind}' arm`).toMatch(new RegExp(`WHEN '${kind}' THEN "lot_id" IS NOT NULL`));
    }
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
    expect(body).not.toMatch(/uuid\('lot_id'\)|uuid\('batch_id'\)|text\('outcome'\)|numeric\('cost_usd'/);
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
