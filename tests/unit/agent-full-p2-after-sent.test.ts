import { readFileSync } from 'node:fs';
import { describe, expect, it, vi } from 'vitest';

/** The listener's seam calls pg-boss's sender; it is caught here — this file starts no boss. */
const sent = vi.hoisted(() => ({ calls: [] as unknown[][], fail: false }));
vi.mock('@/modules/platform/jobs/boss', async (original) => ({
  ...(await original<typeof import('@/modules/platform/jobs/boss')>()),
  enqueue: vi.fn(async (...args: unknown[]) => {
    sent.calls.push(args);
    if (sent.fail) throw new Error('Connection terminated');
    return String(args[2] && (args[2] as { id?: string }).id);
  }),
}));
import type { AgentContext, ChatMessage } from '@/modules/wms/agent/context';
import {
  AFTER_SENT_STAGE_KINDS,
  OFFER_WORDS,
  offerLocaleOf,
  quotedBy,
  stageAskOf,
} from '@/modules/wms/agent/after-sent';
import { afterSentLines } from '@/modules/wms/agent/card-io';
import { LEAD_STAGE_NAME_CHARS, LEAD_STAGE_RULE, chatBlock, leadStageWords, runTail, stableHead } from '@/modules/wms/agent/prompt';
import { AFTER_SENT_RETRY_LIMIT, JOB_AGENT_AFTER_SENT } from '@/modules/wms/agent/queues';
import { onAgentReplySent } from '@/modules/wms/agent/settle-hooks';
import { stageOrderRefused, stageSettingKey, STAGE_SETTING_KEYS } from '@/modules/wms/crm/stage-settings';

/**
 * The full AI seller, part 2, package P4 — the pure rules of what a SENT reply settles on the card (SPEC-P2-v2 §2.4,
 * §3.2, §3.4): «quoted» over the stored facts, the kinds' allow-list, the open-VED rule, the locale the stored offer
 * takes, the card's «💳» lines, the lead's stage on the chat block's lead line only — and the source fences that keep
 * the listener's seam thin and the queueing on the `sent` branch alone.
 */

const strip = (src: string) => src.replace(/\/\*[\s\S]*?\*\//g, '').replace(/(^|[^:])\/\/.*$/gm, '$1');
const read = (p: string) => strip(readFileSync(p, 'utf8'));

const draft = (over: Partial<{ kind: string; offerId: string | null; finalBody: string | null; policy: unknown }> = {}) => ({
  kind: 'reply',
  offerId: null,
  finalBody: null,
  policy: {},
  ...over,
});
const mark = { requestId: 'r', section: 'rastamojka', anchor: 'answer', anchorId: 'r', rule: 'percent:10', total: 1359 };
const estimate = { kind: 'yolkira', usd: 900 };

describe('«quoted» — one predicate over what the draft STORED (§3.2 crm 6)', () => {
  it('his 💵, a recorded offer, the machine’s VED price, the machine’s estimate — in that order', () => {
    expect(quotedBy(draft({ kind: 'price' }))).toBe('price');
    // His 💵 is his figure whatever words went: kind first.
    expect(quotedBy(draft({ kind: 'price', finalBody: 'Narx 1500 $' }))).toBe('price');
    expect(quotedBy(draft({ offerId: 'o1' }))).toBe('offer');
    expect(quotedBy(draft({ policy: { memory: { calcPrices: [mark] } } }))).toBe('calc');
    expect(quotedBy(draft({ policy: { memory: { estimates: [estimate] } } }))).toBe('estimate');
    // A reply quoting both is a VED price: it moves even while a VED job is open.
    expect(quotedBy(draft({ policy: { memory: { calcPrices: [mark], estimates: [estimate] } } }))).toBe('calc');
  });

  it('his ✏️ words carry none of the machine’s figures — no quote; an empty or garbage memory is none', () => {
    expect(quotedBy(draft({ finalBody: 'Salom', policy: { memory: { calcPrices: [mark], estimates: [estimate] } } }))).toBeNull();
    expect(quotedBy(draft({ policy: { memory: { calcPrices: [], estimates: [] } } }))).toBeNull();
    expect(quotedBy(draft({ policy: { memory: { calcPrices: 'x', estimates: 7 } } }))).toBeNull();
    expect(quotedBy(draft({ policy: null }))).toBeNull();
    expect(quotedBy(draft())).toBeNull();
  });
});

describe('which stage a sent reply asks for (§3.2)', () => {
  it('the kinds are an ALLOW-list: reply, his 💵 and the hand-back — part 3’s greeting moves nothing until named', () => {
    expect([...AFTER_SENT_STAGE_KINDS]).toEqual(['reply', 'price', 'hand_back']);
    for (const kind of AFTER_SENT_STAGE_KINDS) expect(stageAskOf({ kind, leadId: 'l', quoted: null, openCalc: false }).want).toBe('ai_contacted');
    for (const kind of ['greeting', 'followup', 'broadcast', '']) {
      expect(stageAskOf({ kind, leadId: 'l', quoted: 'calc', openCalc: false })).toEqual({ want: null, reason: 'kind' });
    }
  });

  it('a client chat (no lead on the row) moves nothing — a won lead’s client chat stays where the sale is', () => {
    expect(stageAskOf({ kind: 'reply', leadId: null, quoted: 'calc', openCalc: false })).toEqual({ want: null, reason: 'client_chat' });
  });

  it('a quote asks «AI narx aytdi»; anything else «AI birinchi javob berdi»', () => {
    for (const q of ['price', 'offer', 'calc', 'estimate'] as const) {
      expect(stageAskOf({ kind: 'reply', leadId: 'l', quoted: q, openCalc: false })).toEqual({ want: 'ai_quoted' });
    }
    expect(stageAskOf({ kind: 'hand_back', leadId: 'l', quoted: null, openCalc: true })).toEqual({ want: 'ai_contacted' });
  });

  it('his §7 Q12 ⭐ a: a truck estimate while a VED job is open sits on the job — a VED price, his 💵, an offer still move', () => {
    expect(stageAskOf({ kind: 'reply', leadId: 'l', quoted: 'estimate', openCalc: true })).toEqual({ want: null, reason: 'open_calc' });
    for (const q of ['price', 'offer', 'calc'] as const) {
      expect(stageAskOf({ kind: 'reply', leadId: 'l', quoted: q, openCalc: true })).toEqual({ want: 'ai_quoted' });
    }
  });
});

describe('the stored offer’s locale — recordOffer’s three (§2.4)', () => {
  it('uz and its Cyrillic → uz; ru → ru; en, fa, zh → en; no language → uz', () => {
    expect(['uz', 'uz_cyrl', 'ru', 'en', 'fa', 'zh', null, 'xx'].map(offerLocaleOf)).toEqual(['uz', 'uz', 'ru', 'en', 'en', 'en', 'uz', 'uz']);
  });
});

describe('the card’s «💳» lines (§2.4)', () => {
  const policy = { afterSent: { at: '2026-11-14T08:00:00Z', offer: [OFFER_WORDS.written(1359)], stage: 'moved:ai_quoted' } };

  it('the words: the price as the card prints it, and every «no» says why', () => {
    expect(OFFER_WORDS.written(1359)).toBe('💳 Kartaga yozildi: 1 359 $');
    expect(OFFER_WORDS.written(12_500)).toBe('💳 Kartaga yozildi: 12 500 $');
    expect(OFFER_WORDS.notWritten(OFFER_WORDS.noSeat)).toBe('💳 Kartaga yozilmadi: AI o‘rni belgilanmagan');
    expect(OFFER_WORDS.notWritten(OFFER_WORDS.ownText)).toBe('💳 Kartaga yozilmadi: narxni o‘zingiz yozdingiz — kartaga qo‘lda kiriting');
  });

  it('drawn on an approved card only, and only strings', () => {
    expect(afterSentLines({ status: 'approved', policy })).toEqual(['💳 Kartaga yozildi: 1 359 $']);
    expect(afterSentLines({ status: 'pending', policy })).toEqual([]);
    expect(afterSentLines({ status: 'approved', policy: {} })).toEqual([]);
    expect(afterSentLines({ status: 'approved', policy: { afterSent: { offer: ['ok', 3, '', null] } } })).toEqual(['ok']);
    expect(afterSentLines({ status: 'approved', policy: { afterSent: { offer: 'x' } } })).toEqual([]);
  });
});

function msg(body: string, i: number): ChatMessage {
  return { ref: `#${i}`, id: `m${i}`, tgMessageId: BigInt(i), direction: 'in', body, media: null, fileName: null, sentAt: new Date(Date.UTC(2026, 10, 12, 7, i)), autoSent: false, editedAt: null };
}

function ctx(identity: Partial<AgentContext['identity']>, leadStage: AgentContext['leadStage']): AgentContext {
  const messages = [msg('Salom, narx qancha?', 1)];
  return {
    managerUserId: 'u',
    peerId: 1n,
    messages,
    history: messages,
    anchor: messages[0]!,
    burst: messages,
    lastOut: null,
    lastQuote: null,
    identity: { clientId: null, leadId: 'l', strength: 'lead', codes: [], customerName: 'Aziz', managerName: null, cargoAllowed: false, ...identity } as AgentContext['identity'],
    storedLocale: null,
    customerScript: 'latin',
    measures: [],
    openCalcs: [],
    ruleDecision: null,
    leadStage,
  };
}

describe('the model learns the lead’s stage — on the chat block’s lead line, nowhere else (§3.4)', () => {
  it('a lead chat: « · bosqich: <name> (<kind>)», the name cut to 40 characters, never a lost reason', () => {
    expect(chatBlock(ctx({}, { name: 'Narx aytildi', kind: 'open' }))).toContain('Lid (hali mijoz emas): Aziz · bosqich: Narx aytildi (open)\n');
    expect(leadStageWords({ name: 'Yo‘qotildi', kind: 'lost' })).toBe(' · bosqich: Yo‘qotildi (lost)');
    expect(leadStageWords({ name: 'x', kind: 'weird' })).toBe(' · bosqich: x (open)');
    const long = 'Q'.repeat(LEAD_STAGE_NAME_CHARS + 10);
    expect(leadStageWords({ name: long, kind: 'open' })).toBe(` · bosqich: ${'Q'.repeat(LEAD_STAGE_NAME_CHARS)}… (open)`);
    expect(LEAD_STAGE_NAME_CHARS).toBe(40);
  });

  it('no stage, and a context built before it existed, print today’s lead line byte for byte', () => {
    const before = ctx({}, undefined);
    delete before.leadStage;
    expect(chatBlock(ctx({}, null))).toBe(chatBlock(before));
    expect(chatBlock(before)).toContain('Lid (hali mijoz emas): Aziz\n');
  });

  it('a client chat prints no stage — even handed one (its lead is the won one)', () => {
    const client = ctx({ clientId: 'c', codes: [{ id: 'c', clientCode: 'GS1' }] as AgentContext['identity']['codes'] }, { name: 'Yutildi', kind: 'won' });
    expect(chatBlock(client)).not.toContain('bosqich');
  });

  it('the cached head and the run’s tail never carry it: the head is the same bytes whatever stage a lead is on', () => {
    const head = stableHead({ styleGuide: null, facts: [], priceArmed: false, calcPricing: false, lessons: [], persona: '' });
    expect(head).not.toMatch(/bosqich: /u);
    // One STATIC sentence tells the model what the line is (cache-safe: the same bytes for every chat).
    expect(head).toContain(LEAD_STAGE_RULE);
    expect(head.split(LEAD_STAGE_RULE)).toHaveLength(2);
    expect(LEAD_STAGE_RULE).not.toMatch(/\d/u);
    expect(runTail({ day: '14.11.2026', canary: 'k' })).not.toMatch(/bosqich/u);
    // stableHead takes no chat at all — a lead that moves cannot reach its bytes (source shape).
    const src = read('src/modules/wms/agent/prompt.ts');
    const sig = src.slice(src.indexOf('export function stableHead('), src.indexOf('}): string {', src.indexOf('export function stableHead(')));
    expect(sig).not.toMatch(/leadStage|AgentContext|ctx/u);
  });

  it('read by its own query in loadContext — never in chatIdentity, which the listener’s send step calls every tick', () => {
    const src = read('src/modules/wms/agent/context.ts');
    const identity = src.slice(src.indexOf('export async function chatIdentity('));
    const identityBody = identity.slice(0, identity.indexOf('\nexport '));
    expect(identityBody).not.toMatch(/leadStage|lead_stages/u);
    const load = src.slice(src.indexOf('export async function loadContext('));
    expect(load.slice(0, load.indexOf('\nexport '))).toContain('identity.clientId === null && identity.leadId !== null ? await leadStageOf(');
  });
});

describe('the listener’s seam — the job is queued from the `sent` branch alone (§3.2 crm 5, 9)', () => {
  it('settle-hooks imports ONLY the queue names and pg-boss’s sender statically — never the mover, the offer, the steps', () => {
    const src = read('src/modules/wms/agent/settle-hooks.ts');
    const statics = [...src.matchAll(/^import\s[^;]*?from\s+['"]([^'"]+)['"]/gmu)].map((m) => m[1]);
    expect(statics.sort()).toEqual(['../../platform/jobs/boss', './queues']);
    expect(src).not.toMatch(/crm\/service|moveLeadByMachine|after-sent|recordOffer|calc\/workspace/u);
  });

  it('the seam queues the job by the row’s id — and a sender that fails never throws into the pump (the net asks again)', async () => {
    sent.calls.length = 0;
    sent.fail = false;
    await onAgentReplySent('00000000-0000-4000-8000-0000000000a1');
    expect(sent.calls).toEqual([
      [JOB_AGENT_AFTER_SENT, { outboxId: '00000000-0000-4000-8000-0000000000a1' }, { id: '00000000-0000-4000-8000-0000000000a1', retryLimit: AFTER_SENT_RETRY_LIMIT }],
    ]);
    sent.fail = true;
    await expect(onAgentReplySent('00000000-0000-4000-8000-0000000000a2')).resolves.toBeUndefined();
    sent.fail = false;
  });

  it('the job is enqueued with the outbox row’s id as its own (pg-boss inserts ON CONFLICT DO NOTHING — a replay is one job)', () => {
    const src = read('src/modules/wms/agent/settle-hooks.ts');
    expect(src).toContain('enqueue(JOB_AGENT_AFTER_SENT, { outboxId } satisfies AgentAfterSentJob, { id: outboxId, retryLimit: AFTER_SENT_RETRY_LIMIT })');
    expect(JOB_AGENT_AFTER_SENT).toBe('agent.after_sent');
    expect(AFTER_SENT_RETRY_LIMIT).toBe(3);
  });

  it('outbox-store calls it ONCE, inside `case \'sent\'` — never from settled(), which fires for holds, cancels, unknowns, failures', () => {
    const src = read('src/modules/wms/agent/outbox-store.ts');
    expect(src.split('onAgentReplySent(')).toHaveLength(2);
    const at = src.indexOf('onAgentReplySent(row.id)');
    expect(at).toBeGreaterThan(src.indexOf("case 'sent': {"));
    expect(at).toBeLessThan(src.indexOf("case 'unknown': {"));
    // …after the thread's copy is written, so the outcome's replay re-queues the same job id.
    expect(at).toBeGreaterThan(src.indexOf('await recordSent({'));
    const settledBody = src.slice(src.indexOf('async function settled('), src.indexOf('const LIVE ='));
    expect(settledBody).not.toContain('onAgentReplySent');
  });

  it('the worker retries a database error only: no catch around the job, and the sweep re-queues under the same id', () => {
    const jobs = read('src/modules/wms/agent/jobs.ts');
    const worker = jobs.slice(jobs.indexOf('boss.work<AgentAfterSentJob>(JOB_AGENT_AFTER_SENT'), jobs.indexOf('await boss.createQueue(JOB_AGENT_OWNER_ANSWER)'));
    expect(worker).toContain('await handleAfterSent(job.data)');
    expect(worker).not.toMatch(/catch/u);
    expect(jobs).toContain("enqueue(JOB_AGENT_AFTER_SENT, { outboxId: id } satisfies AgentAfterSentJob, { id, retryLimit: AFTER_SENT_RETRY_LIMIT })");
  });

  it('the job never asks agentRunning — it records a reply that already went (crm 9)', () => {
    expect(read('src/modules/wms/agent/after-sent.ts')).not.toMatch(/agentRunning|readAgentConfig/u);
  });
});

describe('the commission fence is REQUIRED at every consumer (§2.4a)', () => {
  it('upsale-service passes the probe to all four, read before any transaction', () => {
    const src = read('src/modules/wms/calc/upsale-service.ts');
    expect(src.split('payableOffersSql({ machineOffers })')).toHaveLength(5);
    expect(src).not.toContain('payableOffersSql()');
    const pay = src.slice(src.indexOf('export async function payUpsale('));
    expect(pay.indexOf('const machineOffers = await agentFullP2Ready()')).toBeLessThan(pay.indexOf('db.transaction('));
    expect(pay.indexOf('const machineOffers = await agentFullP2Ready()')).toBeGreaterThan(0);
  });

  it('the exclusion sits AFTER the per-request rank — never in `base`, where it would promote an older person’s offer', () => {
    const src = read('src/modules/wms/calc/upsale.ts');
    const at = src.indexOf('NOT EXISTS (SELECT 1 FROM agent_offers ao WHERE ao.offer_id = ranked.id)');
    expect(at).toBeGreaterThan(src.indexOf('AND ranked.rn = 1'));
    expect(src.slice(src.indexOf('base AS ('), src.indexOf('ranked AS ('))).not.toContain('agent_offers');
  });
});

describe('the stage settings’ own door (§3.1)', () => {
  it('a CLOSED map: (board, which) → key, anything else none — a posted key is never written', () => {
    expect(STAGE_SETTING_KEYS).toEqual({
      lead: { calc: 'crm_calc_stage', ai_contacted: 'crm_ai_contacted_stage', ai_quoted: 'crm_ai_quoted_stage' },
      deal: { calc: 'deal_calc_stage' },
    });
    expect(stageSettingKey('lead', 'ai_quoted')).toBe('crm_ai_quoted_stage');
    expect(stageSettingKey('deal', 'calc')).toBe('deal_calc_stage');
    for (const [board, which] of [
      ['deal', 'ai_quoted'],
      ['lead', 'crm_ai_quoted_stage'],
      ['lead', 'agent_calc_markup_value'],
      ['lead', 'toString'],
      ['lead', '__proto__'],
      ['client', 'calc'],
      ['', ''],
    ]) {
      expect(stageSettingKey(board!, which!), `${board}/${which}`).toBeNull();
    }
  });

  it('«AI narx aytdi» strictly after «AI birinchi javob berdi», asked of whichever is set', () => {
    expect(stageOrderRefused('ai_quoted', 30, 20)).toBe(false);
    expect(stageOrderRefused('ai_quoted', 20, 20)).toBe(true);
    expect(stageOrderRefused('ai_quoted', 10, 20)).toBe(true);
    expect(stageOrderRefused('ai_contacted', 10, 20)).toBe(false);
    expect(stageOrderRefused('ai_contacted', 20, 20)).toBe(true);
    expect(stageOrderRefused('ai_contacted', 30, 20)).toBe(true);
    expect(stageOrderRefused('ai_quoted', 10, null)).toBe(false);
    expect(stageOrderRefused('calc', 10, 99)).toBe(false);
  });

  it('the action posts no key: it hands (board, which, stage) to the one setter — the old calc-stage action is gone', () => {
    const src = read('src/app/(protected)/crm/actions.ts');
    const body = src.slice(src.indexOf('export async function setAiStageAction('), src.indexOf('// --- People'));
    expect(body).toContain("run('crm.manage'");
    expect(body).toContain('setStageSetting({ board, which, stageId }, ctx)');
    expect(body).not.toMatch(/setSetting\(/u);
    expect(src).not.toContain('setCalcStageAction');
  });
});
