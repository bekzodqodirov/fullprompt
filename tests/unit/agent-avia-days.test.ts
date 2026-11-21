import { readdirSync, readFileSync, statSync } from 'node:fs';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { AVIA_DAYS_DEFAULT, type AviaDays } from '@/modules/platform/settings/service';
import { withAviaDaysNow } from '@/modules/wms/agent/avia-days';
import type { AgentContext, ChatMessage } from '@/modules/wms/agent/context';
import { servedText, type KbHit } from '@/modules/wms/agent/kb';
import { AGENT_LIMITS } from '@/modules/wms/agent/limits';
import type { NumberSource } from '@/modules/wms/agent/numbers';
import { checkAgentReply } from '@/modules/wms/agent/policy';
import { stableHead } from '@/modules/wms/agent/prompt';
import { memoryFor, type ComposeReply } from '@/modules/wms/agent/run';
import { SEED_FACTS } from '@/modules/wms/agent/seed-kb';
import { aviaToolSpec, runTool, TOOL_SPECS, toolSpecsFor, type ToolEnv, type ToolOutcome } from '@/modules/wms/agent/tools';
import { agentRules } from '@/modules/wms/agent/web-page';

/**
 * Stage 1a P7 «Avia kunlari» (J2, his 2 b «3-5 kun», and his ⭐ «reys bo‘lsa … kun» dropped): the flight's days are
 * his setting `agent_avia_days`, read by ONE reader (settings `aviaDays`) once per run, and every place that says or
 * vouches for them takes that pair — rule 9 of the head, the avia tool's offer, its words and its day sources, the
 * company rule the policy reads (run `memoryFor`), the page. Nothing else states a flight's day: no constant, no
 * seeded fact. Each case runs on the shipped «3-5» AND on another pair, so a figure that only happens to agree with
 * the default proves nothing.
 */

const OTHER: AviaDays = { min: 4, max: 7 };

const msg = (body: string, n = 1): ChatMessage => ({
  ref: `#${n}`,
  id: `00000000-0000-4000-8000-${String(n).padStart(12, '0')}`,
  tgMessageId: BigInt(n),
  direction: 'in',
  media: null,
  fileName: null,
  sentAt: new Date('2026-11-20T06:00:00Z'),
  autoSent: false,
  editedAt: null,
  body,
});

function ctxWith(body: string, measures: AgentContext['measures'] = []): AgentContext {
  const m = msg(body);
  return {
    managerUserId: 'u',
    peerId: 1n,
    messages: [m],
    history: [m],
    anchor: m,
    burst: [m],
    lastOut: null,
    lastQuote: null,
    identity: { clientId: null, leadId: 'l', strength: 'lead', codes: [], customerName: null, managerName: null, cargoAllowed: false },
    storedLocale: 'uz',
    customerScript: 'latin',
    measures,
    openCalcs: [],
    ruleDecision: null,
  };
}

const compose = (replyText: string): ComposeReply => ({
  replyNeeded: true,
  replyText,
  language: 'uz',
  glossUz: '',
  category: 'faq',
  confidence: 0.9,
  needsOwner: false,
  ownerQuestion: '',
  nextStep: 'wait',
  actions: [],
  usedFactIds: [],
  citedMessageRefs: [],
});

const usage = { inputTokens: 0, outputTokens: 0, cacheReadTokens: 0, cacheWriteTokens: 0 };

/** The seeded knowledge as a run's prompt serves it (kb `hitOf`). */
const SEEDED: KbHit[] = SEED_FACTS.map((f, i) => ({
  id: `00000000-0000-4000-8000-0000000007${String(i).padStart(2, '0')}`,
  ref: `F${i}`,
  answer: servedText(f.question, f.answer),
  phones: [],
  urls: [],
}));

/** The memory a run that was told `days` stores for a reply (its tools' outcomes given). */
function memOf(reply: string, days: AviaDays | null, outcomes: ToolOutcome[] = [], facts: KbHit[] = SEEDED) {
  const ctx = ctxWith('Avia bilan necha kunda keladi?');
  return memoryFor(ctx, { compose: compose(reply), tools: [], outcomes, usage, aviaDays: days }, facts, 'gsr-t');
}

/** The policy's verdict over a reply, on the memory a run that was told `days` stores (no tool called). */
function blocksOf(reply: string, days: AviaDays | null): string[] {
  return blocksBy(reply, memOf(reply, days));
}

/** The policy's verdict over a reply, on a stored memory's sources as given. */
function blocksBy(reply: string, mem: { sources: NumberSource[]; hasEstimate: boolean }): string[] {
  return checkAgentReply({
    body: reply,
    language: 'uz',
    customerScript: 'latin',
    numberSources: mem.sources,
    removeWhole: [],
    ownCodes: [],
    bookCodes: new Set(),
    codePrefix: 'GS',
    allowedPhones: [],
    allowedUrls: [],
    mapUrls: [],
    askedLocation: false,
    staffNames: [],
    canary: 'gsr-t',
    fingerprintPeers: 0,
    urlsToChat7d: 0,
    urlsToday: 0,
    hasEstimate: mem.hasEstimate,
    fromOurWarehouse: false,
  }).blocks.map((b) => `${b.code}${b.detail ? `:${b.detail}` : ''}`);
}

const env = (ctx: AgentContext, aviaDays: AviaDays): ToolEnv => ({
  ctx,
  day: '2026-11-20',
  aviaUsdPerKg: 17,
  kb: async () => [],
  chinaPlaces: async () => new Set(['Yiwu']),
  priceArmed: true,
  calcArmed: false,
  calcPricing: false,
  aviaDays,
});

const head = (aviaDays: AviaDays) =>
  stableHead({ styleGuide: null, facts: [], priceArmed: false, calcPricing: false, lessons: [], persona: '', aviaDays });

describe('the shipped days are his 2 b — «3-5» (J2)', () => {
  it('the setting’s default, read by the one shape', () => {
    expect(AVIA_DAYS_DEFAULT).toEqual({ min: 3, max: 5 });
  });
});

describe('rule 9 says the run’s days, and no flight clause', () => {
  it.each([AVIA_DAYS_DEFAULT, OTHER])('%o', (days) => {
    const h = head(days);
    expect(h).toContain(`muddat taxminan ${days.min}-${days.max} kun — va'da emas; avia uchun boshqa muddat aytma.`);
    expect(h).not.toMatch(/reys bo/u);
  });

  it('a range he changes changes the head (one cache write), the same range gives the same bytes', () => {
    expect(head(OTHER)).not.toBe(head(AVIA_DAYS_DEFAULT));
    expect(head({ ...AVIA_DAYS_DEFAULT })).toBe(head(AVIA_DAYS_DEFAULT));
  });
});

describe('the avia tool — its offer, its words, its day sources — says the run’s days', () => {
  it('the offer: TOOL_SPECS holds it at the shipped days; a run is offered its own', () => {
    expect(TOOL_SPECS.find((t) => t.name === 'avia_estimate')).toEqual(aviaToolSpec(AVIA_DAYS_DEFAULT));
    for (const days of [AVIA_DAYS_DEFAULT, OTHER]) {
      for (const calcPricing of [false, true]) {
        const avia = toolSpecsFor({ calcPricing, aviaDays: days }).find((t) => t.name === 'avia_estimate')!;
        expect(avia.description).toContain(`Muddat taxminan ${days.min}-${days.max} kun — va'da emas.`);
        expect(avia.description).not.toMatch(/reys bo/u);
      }
    }
  });

  it.each([AVIA_DAYS_DEFAULT, OTHER])('the quote’s words and sources: %o', async (days) => {
    const ctx = ctxWith('Avia bilan 30 kg', [{ ref: 'w1', kind: 'weight', value: 30, messageRef: '#1' }]);
    const out = await runTool('avia_estimate', { weight_ref: 'w1' }, env(ctx, days));
    expect(out.text).toContain(`Yetib borishi taxminan ${days.min}-${days.max} kun — va'da emas.`);
    expect(out.text).not.toMatch(/reys bo/u);
    expect(out.sources.filter((s) => s.kind === 'duration').map((s) => s.value)).toEqual([days.min, days.max]);
    expect(out.sources.filter((s) => s.kind === 'duration').every((s) => s.mode === 'air' && s.tool === 'avia_estimate')).toBe(true);
  });
});

describe('the company rule vouches for the days the run was told, and nothing else (a «2-5» reply is no longer vouched)', () => {
  it('on the shipped «3-5», with the seeded knowledge served: «3-5» goes; «2-5» and «reys bo‘lsa 2 kun» are unsourced', () => {
    expect(blocksOf('Avia bilan taxminan 3-5 kunda yetib boradi.', AVIA_DAYS_DEFAULT)).toEqual([]);
    expect(blocksOf('Avia bilan taxminan 2-5 kunda yetib boradi.', AVIA_DAYS_DEFAULT)).toContain('number_unsourced:2');
    expect(blocksOf('Avia bilan taxminan 3-5 kunda, reys bo‘lsa 2 kunda yetib boradi.', AVIA_DAYS_DEFAULT)).toContain('number_unsourced:2');
  });

  it('on another pair: his pair goes, the shipped «3-5» does not — the setting decides, not a constant', () => {
    expect(blocksOf('Avia bilan taxminan 4-7 kunda yetib boradi.', OTHER)).toEqual([]);
    expect(blocksOf('Avia bilan taxminan 3-5 kunda yetib boradi.', OTHER)).toContain('number_unsourced:3');
  });

  it('a run that told no days (a tayyor matn) vouches for none', () => {
    expect(blocksOf('Avia bilan taxminan 3-5 kunda yetib boradi.', null)).toContain('number_unsourced:3');
  });

  it('the flight’s minimum stays the company’s rule, whatever the days', () => {
    for (const days of [AVIA_DAYS_DEFAULT, OTHER, null]) {
      expect(blocksOf(`Avia orqali eng kamida ${AGENT_LIMITS.avia.minKg} kg qabul qilamiz.`, days)).toEqual([]);
    }
  });
});

describe('a draft from before a change is judged by today’s pair at ✅ and at the machine’s press (review N2)', () => {
  // A run told the OLD pair — before the deploy «2-5» (and the flight clause), or before he typed «4-7» — with the avia
  // tool called, so both the company rule's rows and the tool's carry its days, as a stored draft's memory does.
  const OLD: AviaDays = { min: 2, max: 5 };
  const toldOld = async (reply: string) => {
    const ctx = ctxWith('Avia bilan 30 kg', [{ ref: 'w1', kind: 'weight', value: 30, messageRef: '#1' }]);
    const out = await runTool('avia_estimate', { weight_ref: 'w1' }, env(ctx, OLD));
    return memOf(reply, OLD, [out as ToolOutcome]);
  };

  it('its own run’s days vouched for it; brought to today’s «3-5», «2-5» and «reys bo‘lsa 2 kun» are unsourced', async () => {
    for (const reply of ['Avia bilan taxminan 2-5 kunda yetib boradi.', 'Avia bilan taxminan 3-5 kunda, reys bo‘lsa 2 kunda yetib boradi.']) {
      const mem = await toldOld(reply);
      // As stored: the old pair was the run's, and the check at the write let it through.
      expect(blocksBy(reply, mem), reply).not.toContain('number_unsourced:2');
      // As the press reads it now.
      expect(blocksBy(reply, { ...mem, sources: withAviaDaysNow(mem.sources, AVIA_DAYS_DEFAULT) }), reply).toContain('number_unsourced:2');
    }
    const ok = 'Avia bilan taxminan 3-5 kunda yetib boradi.';
    const mem = await toldOld(ok);
    expect(blocksBy(ok, { ...mem, sources: withAviaDaysNow(mem.sources, AVIA_DAYS_DEFAULT) })).toEqual([]);
  });

  it('each row keeps its own shape and place — the company rule’s and the tool’s, with their origin, tool and unit', async () => {
    const mem = await toldOld('x');
    const now = withAviaDaysNow(mem.sources, OTHER);
    expect(now).toHaveLength(mem.sources.length);
    const setting = (s: NumberSource) => s.kind === 'duration' && (s.label === 'avia muddati' || s.label === 'kompaniya qoidasi');
    mem.sources.forEach((s, i) => {
      expect(now[i], String(i)).toEqual(setting(s) ? { ...s, value: s.value === OLD.min ? OTHER.min : OTHER.max } : s);
    });
    // The seeded truck facts' own days («15–25 kun») are a fact's and stay as they were.
    expect(now.filter(setting).map((s) => [s.label, s.origin, s.value])).toEqual([
      ['avia muddati', 'tool', OTHER.min],
      ['avia muddati', 'tool', OTHER.max],
      ['kompaniya qoidasi', 'kb', OTHER.min],
      ['kompaniya qoidasi', 'kb', OTHER.max],
    ]);
  });

  it('on a draft told today’s pair nothing moves; a tayyor matn, which vouched for no day, gains none', () => {
    for (const days of [AVIA_DAYS_DEFAULT, OTHER]) {
      const mem = memOf('x', days);
      expect(withAviaDaysNow(mem.sources, days)).toEqual(mem.sources);
    }
    const none = memOf('x', null);
    expect(withAviaDaysNow(none.sources, AVIA_DAYS_DEFAULT)).toEqual(none.sources);
    expect(blocksBy('Avia bilan taxminan 3-5 kunda yetib boradi.', { ...none, sources: withAviaDaysNow(none.sources, AVIA_DAYS_DEFAULT) })).toContain(
      'number_unsourced:3',
    );
  });

  it('a knowledge fact’s own day count is his words — untouched (a fact that disagrees is a chore on «Bilimlar», J2)', () => {
    const own: KbHit = { id: '00000000-0000-4000-8000-000000000799', ref: 'F99', answer: 'Avia orqali odatda 7 kunda yetib boradi.', phones: [], urls: [] };
    const mem = memOf('x', AVIA_DAYS_DEFAULT, [], [...SEEDED, own]);
    const now = withAviaDaysNow(mem.sources, OTHER);
    expect(now.filter((s) => s.label === 'kompaniya bilimi')).toEqual(mem.sources.filter((s) => s.label === 'kompaniya bilimi'));
    expect(now).toContainEqual(expect.objectContaining({ value: 7, kind: 'duration', label: 'kompaniya bilimi' }));
  });
});

describe('the page says the setting’s pair', () => {
  it.each([AVIA_DAYS_DEFAULT, OTHER])('%o', (days) => {
    expect(agentRules({ aviaUsdPerKg: 17, aviaRateSetAt: null }, days).avia).toMatchObject({ minKg: 1, daysMin: days.min, daysMax: days.max });
  });
});

/** Every .ts/.tsx file under a directory. */
function filesUnder(dir: string): string[] {
  return readdirSync(dir).flatMap((name) => {
    const path = join(dir, name);
    return statSync(path).isDirectory() ? filesUnder(path) : /\.tsx?$/u.test(name) ? [path] : [];
  });
}

/** A file's code without its comments (#725: a fence must not match the sentence that explains it). */
const strip = (text: string) => text.replace(/\/\*[\s\S]*?\*\//gu, '').replace(/(^|[^:'"`])\/\/.*$/gmu, '$1');

describe('ONE reader, nothing else states a flight’s day (fences)', () => {
  const src = [...filesUnder('src'), 'scripts/tg-listen.ts'].map((path) => ({ path, text: strip(readFileSync(path, 'utf8')) }));

  it('no constant carries the days any more — AGENT_LIMITS.avia is the minimum alone', () => {
    expect(Object.keys(AGENT_LIMITS.avia)).toEqual(['minKg']);
    for (const f of src) expect(f.text, f.path).not.toMatch(/AGENT_LIMITS\.avia\.days/u);
  });

  it('the setting is read by `aviaDays` alone; the rest only name it (its default, shape, door, refusal words, writer)', () => {
    // The writer reads the stored value for its audit row's «before» — and nothing it says to anyone.
    const readers = src.filter((f) => /getSetting\(\s*'agent_avia_days'\s*\)/u.test(f.text)).map((f) => f.path).sort();
    expect(readers).toEqual(['src/modules/platform/settings/service.ts', 'src/modules/wms/agent/config.ts']);
    const config = strip(readFileSync('src/modules/wms/agent/config.ts', 'utf8'));
    const writer = config.slice(config.indexOf('export async function setAviaDays('));
    expect(writer.slice(0, writer.indexOf('\n}\n'))).toContain("const before = await getSetting('agent_avia_days');");
    expect(config.match(/getSetting\('agent_avia_days'\)/gu)).toHaveLength(1);
    const service = strip(readFileSync('src/modules/platform/settings/service.ts', 'utf8'));
    const fn = service.slice(service.indexOf('export async function aviaDays('));
    expect(fn.slice(0, fn.indexOf('\n}\n'))).toContain("getSetting('agent_avia_days')");
    expect(service.match(/getSetting\('agent_avia_days'\)/gu)).toHaveLength(1);
  });

  it('`aviaDays()` is called where a run or the page reads it — never by the listener’s send step, which states no day', () => {
    const callers = src
      .filter((f) => /(?<![\w.])aviaDays\(\)/u.test(f.text) && !f.path.endsWith('settings/service.ts'))
      .map((f) => f.path)
      .sort();
    // …and the policy, which reads it again at every check (review N2): the press judges by today's pair.
    expect(callers).toEqual(['src/app/(protected)/suhbatlar/ai/page.tsx', 'src/modules/wms/agent/policy-input.ts', 'src/modules/wms/agent/run.ts']);
    const run = strip(readFileSync('src/modules/wms/agent/run.ts', 'utf8'));
    // Both run paths, once each, beside the persona — never inside the loop's rounds.
    expect(run.match(/aviaDays: await aviaDays\(\)/gu)).toHaveLength(2);
    const loop = run.slice(run.indexOf('export async function runLoop'), run.indexOf('async function eligibilityFacts'));
    expect(loop).not.toMatch(/await aviaDays\(/u);
  });

  it('the policy reads the setting with the world it reads now, and judges the stored sources by it', () => {
    const input = strip(readFileSync('src/modules/wms/agent/policy-input.ts', 'utf8'));
    const fn = input.slice(input.indexOf('export async function policyFor('), input.indexOf('export async function ownerPolicyFor('));
    expect(fn.match(/aviaDays\(\)/gu)).toHaveLength(1);
    expect(fn).toMatch(/const \[[^\]]*, days\] = await Promise\.all\(\[[\s\S]*aviaDays\(\),\s*\]\);/u);
    expect(fn).toContain('numberSources: withAviaDaysNow(input.memory.sources, days),');
  });
});
