import { readdirSync, readFileSync, statSync } from 'node:fs';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import en from '../../messages/en.json';
import ru from '../../messages/ru.json';
import uz from '../../messages/uz.json';
import zh from '../../messages/zh-CN.json';
import { auditByAi, AUDIT_FIELD_LABELS, AUDIT_FIELD_REFS, AUDIT_VIA_AI } from '@/modules/platform/audit/fields';
import {
  OPEN_CALC_CAP_PEOPLE,
  OPEN_CALC_CAP_SEAT_DEFAULT,
  OPEN_CALC_LIMIT_BOUNDS,
  openCalcCapOf,
  readOpenCalcLimit,
} from '@/modules/platform/settings/calc-cap';
import {
  calcMarkupRuleValid,
  isOwnDoorKey,
  OWN_DOOR_KEYS,
  OWN_DOOR_PAGES,
  percentHundredths,
  SETTING_DEFAULTS,
  SETTING_VALIDATORS,
  type SettingKey,
} from '@/modules/platform/settings/service';
import { queueRefusal } from '@/modules/platform/telegram/calc-dialog';
import {
  anchorAgeWords,
  anchorMaxAgeMsFor,
  anchorMaxAgeMsForTrigger,
  anchorMaxAgeMsSqlText,
  ownerStartedDraft,
} from '@/modules/wms/agent/anchor-clock';
import { AUTO_SEND_CATEGORIES, LABEL_CATEGORIES, OUTCOME_CATEGORIES, P2_CATEGORIES } from '@/modules/wms/agent/auto-categories';
import { autoArmedWords } from '@/modules/wms/agent/bot-door';
import { noQuestionWhy, NO_DRAFT_WORDS, tooOldWords } from '@/modules/wms/agent/calc-loop';
import { calcQueueWords } from '@/modules/wms/agent/card-io';
import { eligibleForRun, type EligibilityFacts } from '@/modules/wms/agent/eligibility';
import { AGENT_LIMITS } from '@/modules/wms/agent/limits';
import { machineMayTouch } from '@/modules/wms/agent/machine-owner';
import { liveHeadVerdict, type HeadMessage } from '@/modules/wms/agent/send-step';
import { isNudge } from '@/modules/wms/agent/worthy';
import { forwardTarget, machineStageVerdict, type ForwardStage } from '@/modules/wms/crm/forward-stage';

/**
 * The full AI seller, part 2, package P1 — the kernel (SPEC-P2-v2 §0a K1-K5, §1.3, §3.2-§3.3, §4.1-§4.2, §4.4): the
 * migration's shape, the seven kinds, the own-door settings and their shapes, the one anchor clock, the live head's
 * forgiveness for an owner-started reply, the one «may the machine touch this card», the forward rule and the
 * machine's own stage decision, and the one open-calc cap.
 */

const HOUR = 3_600_000;
const DAY = 24 * HOUR;
const strip = (src: string) => src.replace(/\/\*[\s\S]*?\*\//g, '').replace(/(^|[^:])\/\/.*$/gm, '$1');

describe('0149 — the migration as a shape (§4.1)', () => {
  const journal = JSON.parse(readFileSync('src/modules/platform/db/migrations/meta/_journal.json', 'utf8')) as {
    entries: { idx: number; when: number; tag: string }[];
  };
  const entry = journal.entries.find((e) => e.tag === '0149_agent_full_p2');
  const sql = readFileSync('src/modules/platform/db/migrations/0149_agent_full_p2.sql', 'utf8');

  it('is idx 149 at `when` …128, its own real body — never a reserved placeholder', () => {
    expect(entry).toEqual({ idx: 149, version: '7', when: 1785190000128, tag: '0149_agent_full_p2', breakpoints: true });
    expect(strip(sql).replace(/\s+/gu, ' ').trim()).not.toMatch(/^SELECT 1;?$/u);
    expect(sql.length).toBeGreaterThan(400);
  });

  it('re-makes the kinds CHECK with all seven and adds the machine-offer side table — no column on an existing table', () => {
    const check = /"categories" <@ ARRAY\[([^\]]+)\]::text\[\]/u.exec(sql)?.[1];
    expect(check?.split(',').map((x) => x.trim().replace(/'/gu, ''))).toEqual([...AUTO_SEND_CATEGORIES]);
    expect(sql).toMatch(/CREATE TABLE "agent_offers"/u);
    expect(sql).toMatch(/"offer_id" uuid PRIMARY KEY REFERENCES "calc_offers"\("id"\) ON DELETE CASCADE/u);
    expect(sql).toMatch(/"draft_id" uuid REFERENCES "agent_drafts"\("id"\) ON DELETE SET NULL/u);
    expect(sql).toMatch(/CREATE INDEX "agent_offers_draft_idx"/u);
    // 0138's, 0145's, 0148's rule: whole-row readers behind a TRUE-one-migration-behind probe would 42703.
    expect(strip(sql)).not.toMatch(/ADD COLUMN/iu);
    // The stored row is not changed: both new boxes ship unticked (§7 Q1, Q2 ⭐).
    expect(strip(sql)).not.toMatch(/UPDATE\s+"agent_auto_config"/iu);
  });

  it('the LAST migration that re-makes the kinds CHECK carries every kind the code may store', () => {
    const files = readdirSync('src/modules/platform/db/migrations')
      .filter((f) => f.endsWith('.sql'))
      .sort();
    const last = files.filter((f) => readFileSync(join('src/modules/platform/db/migrations', f), 'utf8').includes('agent_auto_config_categories_check')).at(-1);
    expect(last).toBe('0149_agent_full_p2.sql');
  });
});

describe('the seven kinds and who may name them (§1.1, §4.4)', () => {
  it('AUTO_SEND_CATEGORIES is the seven; calc and calc_price are judged by outcome, never a model label', () => {
    expect([...AUTO_SEND_CATEGORIES]).toEqual(['greeting', 'qualification', 'faq', 'status', 'price', 'calc', 'calc_price']);
    expect([...OUTCOME_CATEGORIES]).toEqual(['calc', 'calc_price']);
    expect([...P2_CATEGORIES]).toEqual(['calc', 'calc_price']);
    expect([...LABEL_CATEGORIES]).toEqual(['greeting', 'qualification', 'faq', 'status', 'price']);
    // The model's own enum never names them either (tools.ts compose_reply).
    const tools = readFileSync('src/modules/wms/agent/tools.ts', 'utf8');
    const cats = /const CATEGORIES = \[([^\]]+)\]/u.exec(tools)?.[1] ?? '';
    expect(cats).not.toMatch(/'calc'|'calc_price'/u);
  });

  it('the page labels both new boxes in all four bundles', () => {
    for (const bundle of [uz, ru, en, zh] as unknown as { agentAi: { category: Record<string, string> } }[]) {
      expect(typeof bundle.agentAi.category.calc).toBe('string');
      expect(typeof bundle.agentAi.category.calc_price).toBe('string');
    }
  });

  it('arming says what goes and what stays from the STORED kinds — never «narx stays yours» once a price box is ticked', () => {
    const FOUR = ['greeting', 'qualification', 'faq', 'status'];
    expect(autoArmedWords({ holdSec: 120, perDay: null, categories: FOUR })).toContain('narx, shikoyat va savolli javoblar har doim sizga qoladi');
    const ved = autoArmedWords({ holdSec: 120, perDay: null, categories: [...FOUR, 'calc_price'] });
    expect(ved).not.toContain('narx, shikoyat');
    expect(ved).toContain('yo‘lkira va avia narxi, shikoyat va savolli javoblar har doim sizga qoladi');
    expect(ved).toContain('VED javobiga ustama qo‘shilgan narx qoidalar ruxsat bersa o‘zi ketadi');
    const both = autoArmedWords({ holdSec: 120, perDay: null, categories: [...FOUR, 'price', 'calc_price', 'calc'] });
    expect(both).toContain('shikoyat va savolli javoblar har doim sizga qoladi');
    expect(both).not.toMatch(/narxi?, shikoyat/u);
    expect(both).toContain('hisoblatish so‘rovi qoidalar ruxsat bersa VEDga o‘zi ketadi');
    expect(autoArmedWords({ holdSec: 120, perDay: null, categories: FOUR })).not.toContain('hisoblatish');
  });
});

describe('settings with a door of their own (K5) and their shapes', () => {
  const KEYS = Object.keys(OWN_DOOR_KEYS) as SettingKey[];

  it('the five own-door keys exist with today’s defaults — everything they steer ships OFF', () => {
    expect(KEYS.sort()).toEqual(
      ['agent_calc_markup_kind', 'agent_calc_markup_value', 'agent_calc_open_limit', 'crm_ai_contacted_stage', 'crm_ai_quoted_stage'].sort(),
    );
    expect(SETTING_DEFAULTS.agent_calc_markup_kind).toBe('percent');
    expect(SETTING_DEFAULTS.agent_calc_markup_value).toBe('');
    expect(SETTING_DEFAULTS.agent_calc_open_limit).toBe(OPEN_CALC_CAP_SEAT_DEFAULT);
    expect(SETTING_DEFAULTS.crm_ai_contacted_stage).toBe('');
    expect(SETTING_DEFAULTS.crm_ai_quoted_stage).toBe('');
    for (const key of KEYS) {
      expect(isOwnDoorKey(key)).toBe(true);
      expect(SETTING_VALIDATORS[key], key).toBeTypeOf('function');
      expect(OWN_DOOR_PAGES[OWN_DOOR_KEYS[key as keyof typeof OWN_DOOR_KEYS]]).toMatch(/^\/(suhbatlar\/ai|crm\/settings)$/u);
    }
    // The seat and the markup's confirmation are no default key at all — /admin/settings never draws them.
    expect('agent_seat_user_id' in SETTING_DEFAULTS).toBe(false);
    expect('agent_calc_markup_confirmed' in SETTING_DEFAULTS).toBe(false);
    expect(isOwnDoorKey('crm_calc_stage')).toBe(false);
  });

  it('the generic form refuses them in words before any write, and the screen draws them read-only with their page', () => {
    const action = strip(readFileSync('src/app/(protected)/admin/settings/actions.ts', 'utf8'));
    const refuse = action.indexOf('isOwnDoorKey(key)');
    expect(refuse, 're-anchor: the own-door refusal').toBeGreaterThan(0);
    expect(refuse).toBeLessThan(action.indexOf('setSetting(key'));
    expect(action).toMatch(/isOwnDoorKey\(key\)\) redirect\(`\/admin\/settings\?own=/u);
    const page = readFileSync('src/app/(protected)/admin/settings/page.tsx', 'utf8');
    expect(page).toMatch(/if \(isOwnDoorKey\(key\)\)/u);
    // Every own-door key has its refusal words, and every page it names has its link words in all four bundles.
    for (const key of KEYS) expect(page).toMatch(new RegExp(`${key}: 'badValue`, 'u'));
    for (const bundle of [uz, ru, en, zh] as unknown as { settings: Record<string, unknown> }[]) {
      for (const k of ['ownDoor', 'ownDoorRefused', 'badValueMarkupKind', 'badValueMarkup', 'badValueOpenLimit', 'badValueStage']) {
        expect(typeof bundle.settings[k], k).toBe('string');
      }
      const pages = bundle.settings.ownDoorPage as Record<string, string>;
      for (const door of Object.keys(OWN_DOOR_PAGES)) expect(typeof pages[door], door).toBe('string');
    }
  });

  it('the markup’s shapes (his §7 Q4 ⭐ a): percent 0.01-100 with ≤ 2 decimals, fixed 1-5000 whole dollars, read from the string', () => {
    const v = SETTING_VALIDATORS.agent_calc_markup_value!;
    const k = SETTING_VALIDATORS.agent_calc_markup_kind!;
    expect(k('percent') && k('fixed')).toBe(true);
    for (const bad of ['', 'Percent', 'pct', 'fixed ']) expect(k(bad), bad).toBe(false);
    for (const ok of ['', '10', '0.01', '0.5', '10.5', '12.25', '100', '150', '5000']) expect(v(ok), ok).toBe(true);
    for (const bad of ['0', '0.00', '-5', '1e2', '10.123', '10,5', ' 10', 'abc', '5001', '01']) expect(v(bad), bad).toBe(false);
    expect(percentHundredths('12.25')).toBe(1225);
    expect(percentHundredths('0.5')).toBe(50);
    expect(percentHundredths('100')).toBe(10_000);
    expect(percentHundredths('100.01')).toBeNull();
    expect(calcMarkupRuleValid('percent', '10.5')).toBe(true);
    expect(calcMarkupRuleValid('percent', '150')).toBe(false);
    expect(calcMarkupRuleValid('fixed', '150')).toBe(true);
    expect(calcMarkupRuleValid('fixed', '10.5')).toBe(false);
    expect(calcMarkupRuleValid('fixed', '5001')).toBe(false);
    expect(calcMarkupRuleValid('percent', '')).toBe(true);
    expect(calcMarkupRuleValid('other', '')).toBe(false);
  });

  it('the open limit is a whole number 1..200 — 0 is refused, never «no cap»', () => {
    const v = SETTING_VALIDATORS.agent_calc_open_limit!;
    for (const ok of ['1', '20', '100', '200']) expect(v(ok), ok).toBe(true);
    for (const bad of ['0', '201', '', '-1', '1.5', 'abc', '1000']) expect(v(bad), bad).toBe(false);
    expect(readOpenCalcLimit(100)).toBe(100);
    expect(readOpenCalcLimit('150')).toBe(150);
    expect(readOpenCalcLimit(0)).toBeNull();
    expect(readOpenCalcLimit(null)).toBeNull();
    expect(OPEN_CALC_LIMIT_BOUNDS).toEqual({ min: 1, max: 200 });
  });

  it('the AI stage keys take a stage id or nothing', () => {
    for (const key of ['crm_ai_contacted_stage', 'crm_ai_quoted_stage'] as const) {
      const v = SETTING_VALIDATORS[key]!;
      expect(v('')).toBe(true);
      expect(v('0e4c8f5a-1b2c-4d3e-8f9a-0b1c2d3e4f5a')).toBe(true);
      for (const bad of ['lead', '123', 'crm_calc_stage', 'x'.repeat(36)]) expect(v(bad), bad).toBe(false);
    }
  });
});

describe('ONE anchor clock (K2)', () => {
  const draft = (kind: string, policy: unknown) => ({ kind, policy });
  const GRID: [string, { kind: string; policy: unknown }, number][] = [
    ['an ordinary reply', draft('reply', {}), DAY],
    ['a hand-back question', draft('hand_back', {}), DAY],
    ['his 💵 with its request', draft('price', { priceRequestId: 'r1' }), 7 * DAY],
    ['a price draft with no request named', draft('price', {}), DAY],
    ['a price draft whose request is not a string', draft('price', { priceRequestId: 5 }), DAY],
    ['the VED-answer reply', draft('reply', { calcAnswer: { requestId: 'r1' } }), 7 * DAY],
    ['a malformed VED mark', draft('reply', { calcAnswer: 'r1' }), DAY],
    ['a VED mark with no request', draft('reply', { calcAnswer: {} }), DAY],
    ['a reply naming a price request but not of kind price', draft('reply', { priceRequestId: 'r1' }), DAY],
    ['a policy that is not an object', draft('reply', null), DAY],
  ];

  it.each(GRID)('%s → its age', (_label, d, ms) => {
    expect(anchorMaxAgeMsFor(d)).toBe(ms);
  });

  it('a run with no draft yet takes its trigger’s clock: only a VED answer gets the week', () => {
    expect(anchorMaxAgeMsForTrigger('calc_answer')).toBe(7 * DAY);
    expect(anchorMaxAgeMsForTrigger('hand_back')).toBe(DAY);
    expect(anchorMaxAgeMsForTrigger('owner_edit')).toBe(DAY);
    expect(anchorMaxAgeMsForTrigger('inbound')).toBe(DAY);
    expect(AGENT_LIMITS.calcAnswerMaxAgeMs).toBe(7 * DAY);
    expect(AGENT_LIMITS.anchorMaxAgeMs).toBe(DAY);
  });

  it('the sweep’s SQL is the same rule — it names exactly the two marks and the two ages (the database agrees: integration)', () => {
    const text = anchorMaxAgeMsSqlText('d');
    expect(text).toContain(`THEN ${7 * DAY} ELSE ${DAY} END`);
    expect(text).toContain(`jsonb_typeof(d.policy -> 'calcAnswer' -> 'requestId') = 'string'`);
    expect(text).toContain(`d.kind = 'price' AND jsonb_typeof(d.policy -> 'priceRequestId') = 'string'`);
    const jobs = strip(readFileSync('src/modules/wms/agent/jobs.ts', 'utf8'));
    expect(jobs).toMatch(/sql\.raw\(anchorMaxAgeMsSqlText\('d'\)\)/u);
    expect(jobs).not.toMatch(/AGENT_LIMITS\.draftTtlMs/u);
  });

  it('a refusal says the age the clock used — «24 soatdan» / «7 kundan», never «24 soat» about a week', () => {
    expect(anchorAgeWords(DAY)).toBe('24 soatdan');
    expect(anchorAgeWords(7 * DAY)).toBe('7 kundan');
    expect(NO_DRAFT_WORDS.too_old).toBe(tooOldWords(DAY));
    expect(noQuestionWhy({ outcome: 'skipped', reason: 'no_fresh_inbound' })).toContain('24 soatdan');
    expect(noQuestionWhy({ outcome: 'skipped', reason: 'no_fresh_inbound' }, 7 * DAY)).toContain('7 kundan');
    expect(noQuestionWhy({ outcome: 'refused', reason: 'too_old' }, 7 * DAY)).toContain('7 kundan');
    expect(noQuestionWhy({ outcome: 'refused', reason: 'human_active' }, 7 * DAY)).toContain("o'zingiz yozayapsiz");
  });

  it('the eligibility rule reads the run’s OWN clock (a REQUIRED fact): a week passes 6 d 23 h and refuses 7 d 1 h', () => {
    const now = new Date('2026-11-12T07:00:00Z');
    const facts = (ageMs: number, anchorMaxAgeMs: number): EligibilityFacts => ({
      now,
      agentOn: true,
      sessionConfirmed: true,
      listenerCurrent: true,
      accountPaused: false,
      privateUser: true,
      hasOwner: true,
      ruleExcluded: false,
      peerIsStaff: false,
      muted: false,
      humanActive: false,
      anchorIsNewest: true,
      anchorSentAt: new Date(now.getTime() - ageMs),
      anchorMaxAgeMs,
      anchorAutoSent: false,
      lastOutAt: null,
      anchorRepeats: false,
    });
    expect(eligibleForRun(facts(7 * DAY - HOUR, 7 * DAY))).toEqual({ ok: true });
    expect(eligibleForRun(facts(7 * DAY + HOUR, 7 * DAY))).toEqual({ ok: false, reason: 'too_old' });
    expect(eligibleForRun(facts(25 * HOUR, DAY))).toEqual({ ok: false, reason: 'too_old' });
    expect(eligibleForRun(facts(25 * HOUR, 7 * DAY))).toEqual({ ok: true });
  });

  it('every place that decides the age asks the clock — none reads the 24 hours by itself', () => {
    const files: Record<string, RegExp> = {
      'src/modules/wms/agent/eligibility.ts': /f\.anchorMaxAgeMs/u,
      'src/modules/wms/agent/send-step.ts': /f\.anchorMaxAgeMs/u,
      'src/modules/wms/agent/decide.ts': /anchorMaxAgeMsFor\(d\)/u,
      'src/modules/wms/agent/run.ts': /anchorMaxAgeMsForTrigger\(input\.trigger\)/u,
      'src/modules/wms/agent/outbox-store.ts': /anchorMaxAgeMsFor\(clocked\)/u,
    };
    for (const [file, asks] of Object.entries(files)) {
      const src = strip(readFileSync(file, 'utf8'));
      expect(src, file).toMatch(asks);
      expect(src, file).not.toMatch(/AGENT_LIMITS\.anchorMaxAgeMs/u);
    }
  });
});

describe('the live head forgives our own send for an OWNER-started reply only (K1)', () => {
  const head = (msgs: [bigint, boolean, string][]): HeadMessage[] => msgs.map(([id, out, text]) => ({ id, out, text, media: false }));
  const LIMIT = AGENT_LIMITS.headMessages;
  /** Customer line 50 (the anchor), then the AI's own «Hisoblatishga yubordim…» as 52. */
  const AFTER_OURS = head([
    [52n, true, 'Hisoblatishga yubordim, javob kelishi bilan aytaman.'],
    [50n, false, 'rastamojka qancha bo‘ladi?'],
  ]);

  it('the judge’s probe: today’s rule cancels the price as «he answered himself»; with our send forgiven it goes', () => {
    expect(liveHeadVerdict(AFTER_OURS, 50n, isNudge, LIMIT, new Set())).toEqual({ ok: false, reason: 'human_replied' });
    expect(liveHeadVerdict(AFTER_OURS, 50n, isNudge, LIMIT, new Set([52n]))).toEqual({ ok: true });
  });

  it('a hand-typed message of his still cancels, and a newer line of the customer’s still supersedes', () => {
    const his = head([
      [53n, true, 'Narx 1200$'],
      [52n, true, 'Hisoblatishga yubordim'],
      [50n, false, 'rastamojka?'],
    ]);
    expect(liveHeadVerdict(his, 50n, isNudge, LIMIT, new Set([52n]))).toEqual({ ok: false, reason: 'human_replied' });
    const asked = head([
      [53n, false, 'yana savol: avia qancha?'],
      [52n, true, 'Hisoblatishga yubordim'],
      [50n, false, 'rastamojka?'],
    ]);
    expect(liveHeadVerdict(asked, 50n, isNudge, LIMIT, new Set([52n]))).toEqual({ ok: false, reason: 'anchor_superseded' });
  });

  it('who is owner-started: his 💵, the hand-back, the VED-answer reply — never an ordinary inbound reply', () => {
    expect(ownerStartedDraft({ kind: 'price', policy: { priceRequestId: 'r' } })).toBe(true);
    expect(ownerStartedDraft({ kind: 'hand_back', policy: {} })).toBe(true);
    expect(ownerStartedDraft({ kind: 'reply', policy: { calcAnswer: { requestId: 'r' } } })).toBe(true);
    expect(ownerStartedDraft({ kind: 'reply', policy: {} })).toBe(false);
    expect(ownerStartedDraft({ kind: 'reply', policy: { calcAnswer: 'x' } })).toBe(false);
    expect(ownerStartedDraft({ kind: null, policy: null })).toBe(false);
  });

  it('the store forgives only for an owner-started row — every other draft’s set is EMPTY (two inbound replies must not both go)', () => {
    const store = strip(readFileSync('src/modules/wms/agent/outbox-store.ts', 'utf8'));
    expect(store).toMatch(/const forgivenOut: ReadonlySet<bigint> = ownerStartedDraft\(clocked\)\s*\?\s*new Set\(\(chat\.own_sent \?\? \[\]\)\.map\(\(id\) => BigInt\(id\)\)\)\s*:\s*new Set<bigint>\(\);/u);
    const step = strip(readFileSync('src/modules/wms/agent/send-step.ts', 'utf8'));
    expect(step).toMatch(/liveHeadVerdict\(head, row\.answersTgMessageId, deps\.isNudge, AGENT_LIMITS\.headMessages, facts\.forgivenOut\)/u);
  });
});

describe('«may the machine touch this card» — one predicate (K3)', () => {
  const ME = 'holder';
  it.each([
    [{ kind: 'lead' as const, ownerId: null }, true],
    [{ kind: 'lead' as const, ownerId: ME }, true],
    [{ kind: 'lead' as const, ownerId: 'colleague' }, false],
    [{ kind: 'deal' as const, ownerId: null, clientSellerId: null }, true],
    [{ kind: 'deal' as const, ownerId: ME, clientSellerId: ME }, true],
    [{ kind: 'deal' as const, ownerId: ME, clientSellerId: 'colleague' }, false],
    [{ kind: 'deal' as const, ownerId: 'colleague', clientSellerId: null }, false],
    [{ kind: 'client' as const, sellerId: null }, true],
    [{ kind: 'client' as const, sellerId: ME }, true],
    [{ kind: 'client' as const, sellerId: 'colleague' }, false],
  ])('%o → %s', (card, may) => {
    expect(machineMayTouch(card, ME)).toBe(may);
  });
});

describe('forward only — `forwardTarget` is `calcStageMove`’s old body, unchanged (§3.2)', () => {
  /** The shipped body of `calcStageMove` after its settings read, kept verbatim as the oracle. */
  function oldCalcStageMove(rows: ForwardStage[], currentStageId: string | null, wanted: string): string | null {
    if (!wanted) return null;
    const target = rows.find((row) => row.id === wanted);
    if (!target || !target.active || target.kind !== 'open') return null;
    if (!currentStageId) return target.id;
    if (currentStageId === target.id) return null;
    const current = rows.find((row) => row.id === currentStageId);
    return current && current.sortOrder < target.sortOrder ? target.id : null;
  }

  it('agrees on a generated grid — leads and deals, closed stages, reordered funnels, a colleague’s card (owner is never read)', () => {
    const kinds = ['open', 'won', 'lost'] as const;
    let checked = 0;
    for (let seed = 0; seed < 400; seed++) {
      let x = seed * 2654435761;
      const rnd = (n: number) => {
        x = (x * 1103515245 + 12345) >>> 0;
        return x % n;
      };
      const stages: ForwardStage[] = Array.from({ length: 2 + rnd(5) }, (_, i) => ({
        id: `s${i}`,
        sortOrder: rnd(4) * 10,
        kind: kinds[rnd(3)]!,
        active: rnd(5) !== 0,
      }));
      const ids = [...stages.map((s) => s.id), 'gone', ''];
      for (const current of [...ids.filter((id) => id !== ''), null]) {
        for (const wanted of ids) {
          expect(forwardTarget(stages, current, wanted), `${seed} ${current}→${wanted}`).toBe(oldCalcStageMove(stages, current, wanted));
          checked++;
        }
      }
    }
    expect(checked).toBeGreaterThan(5000);
  });

  it('the person path asks it (calcStageMove = the setting + forwardTarget)', () => {
    const land = strip(readFileSync('src/modules/wms/calc/intake-land.ts', 'utf8'));
    const body = land.slice(land.indexOf('async function calcStageMove'), land.indexOf('export function landingOwesPass'));
    expect(body).toMatch(/return forwardTarget\(rows, currentStageId, wanted\);/u);
  });
});

describe('the machine’s own decision on a LOCKED lead (§3.2)', () => {
  const S = (id: string, sortOrder: number, kind: string, active = true): ForwardStage => ({ id, sortOrder, kind, active });
  const stages = [S('new', 10, 'open'), S('lost', 15, 'lost'), S('talk', 20, 'open'), S('won', 25, 'won'), S('quoted', 30, 'open'), S('old', 40, 'open', false)];
  const decide = (currentStageId: string, wantedId: string | null, mayTouch = true) => machineStageVerdict({ stages, currentStageId, wantedId, mayTouch });

  it('forward between OPEN stages, for a card it may touch', () => {
    expect(decide('new', 'talk')).toEqual({ move: true, stageId: 'talk' });
    expect(decide('talk', 'quoted')).toEqual({ move: true, stageId: 'quoted' });
  });

  it.each([
    ['nothing configured', 'new', null, true, 'not_configured'],
    ['a target that is closed', 'new', 'won', true, 'target_closed'],
    ['a target that is lost', 'new', 'lost', true, 'target_closed'],
    ['an inactive target', 'new', 'old', true, 'target_closed'],
    ['a target that is gone', 'new', 'gone', true, 'target_closed'],
    // The owner reordered «lost» BEFORE the target: never «moved forward» — the write would revive it (crm 1).
    ['a LOST lead whose stage sits before the target', 'lost', 'talk', true, 'current_closed'],
    ['a WON lead whose stage sits before the target', 'won', 'quoted', true, 'current_closed'],
    ['a colleague’s lead', 'new', 'talk', false, 'not_mine'],
    ['already there', 'talk', 'talk', true, 'not_forward'],
    // Quoted-then-contacted applied out of order: the card is never walked back.
    ['already beyond the target', 'quoted', 'talk', true, 'not_forward'],
  ] as const)('%s → %s', (_label, current, wanted, mine, reason) => {
    expect(decide(current, wanted, mine)).toEqual({ move: false, reason });
  });

  it('no server action reaches the machine mover, and only it passes the stage writer its `machine` option', () => {
    const appFiles = (dir: string): string[] =>
      readdirSync(dir).flatMap((name) => {
        const p = join(dir, name);
        return statSync(p).isDirectory() ? appFiles(p) : /\.tsx?$/u.test(name) ? [p] : [];
      });
    for (const file of appFiles('src/app')) expect(strip(readFileSync(file, 'utf8')), file).not.toMatch(/moveLeadByMachine/u);
    const crm = strip(readFileSync('src/modules/wms/crm/service.ts', 'utf8'));
    const passes = [...crm.matchAll(/writeLeadStageTx\(([^;]*?)\);/gsu)].map((m) => m[1]!);
    expect(passes.length).toBeGreaterThan(1);
    const withMachine = passes.filter((args) => /holderId/u.test(args));
    expect(withMachine).toHaveLength(1);
    expect(withMachine[0]).toMatch(/\{ actorId: null \}, undefined, \{ holderId: opts\.holderId \}/u);
    // The lock is the row alone (#1585), and the decision is on what the lock returned.
    const mover = crm.slice(crm.indexOf('export async function moveLeadByMachine'));
    expect(mover).toMatch(/\.from\(leads\)\s*\.where\(eq\(leads\.id, leadId\)\)\s*\.for\('update'\)/u);
    expect(mover.indexOf("for('update')")).toBeLessThan(mover.indexOf('machineStageVerdict('));
  });
});

describe('the audit names the machine (§3.3)', () => {
  it('`via` and `holder` are labelled, the holder is a person, and a row with no actor and via «ai» reads «AI sotuvchi»', () => {
    expect(AUDIT_FIELD_LABELS.via).toBe('via');
    expect(AUDIT_FIELD_LABELS.holder).toBe('holder');
    expect(AUDIT_FIELD_REFS.holder).toBe('user');
    expect(auditByAi({ actorId: null, after: { stageId: 's', via: AUDIT_VIA_AI } })).toBe(true);
    expect(auditByAi({ actorId: 'u', after: { stageId: 's', via: AUDIT_VIA_AI } })).toBe(false);
    expect(auditByAi({ actorId: null, after: { stageId: 's', via: 'auto' } })).toBe(false);
    expect(auditByAi({ actorId: null, after: null })).toBe(false);
    for (const bundle of [uz, ru, en, zh] as unknown as { audit: { aiSeller: string } }[]) expect(typeof bundle.audit.aiSeller).toBe('string');
    const tab = readFileSync('src/components/history-tab.tsx', 'utf8');
    expect(tab).toMatch(/auditByAi\(\{ actorId: row\.actorId \?\? null, after: row\.after \}\)\) \? t\('aiSeller'\) : t\('system'\)/u);
  });
});

describe('ONE open-calc cap (§1.3)', () => {
  const SEAT = 'aaaaaaaa-0000-0000-0000-000000000001';
  it.each([
    ['the seat while it holds, nothing typed', { userId: SEAT, seat: SEAT, holder: SEAT, limit: OPEN_CALC_CAP_SEAT_DEFAULT }, 100],
    ['the seat while it holds, a number typed', { userId: SEAT, seat: SEAT, holder: SEAT, limit: 150 }, 150],
    ['the seat with an unreadable stored number → the people’s', { userId: SEAT, seat: SEAT, holder: SEAT, limit: 'abc' }, 20],
    ['the seat with 0 stored → the people’s, never «no cap»', { userId: SEAT, seat: SEAT, holder: SEAT, limit: 0 }, 20],
    ['a person', { userId: 'bbbbbbbb-0000-0000-0000-000000000002', seat: SEAT, holder: SEAT, limit: 150 }, 20],
    ['no seat named', { userId: SEAT, seat: null, holder: SEAT, limit: 150 }, 20],
    ['a seat that no longer holds', { userId: SEAT, seat: SEAT, holder: 'cccccccc-0000-0000-0000-000000000003', limit: 150 }, 20],
  ])('%s → %i', (_label, input, cap) => {
    expect(openCalcCapOf(input)).toBe(cap);
  });

  it('the card, the bot and the page print the figure the one function read — never a constant of their own', () => {
    expect(OPEN_CALC_CAP_PEOPLE).toBe(20);
    expect(calcQueueWords('too_many_open', 100)).toContain('100 ta ochiq so‘rov');
    expect(calcQueueWords('too_many_open', null)).not.toMatch(/\d+ ta ochiq/u);
    expect(queueRefusal('too_many_open', 100)).toContain('100 ta ochiq so‘rov');
    expect(queueRefusal('too_many_open', null)).not.toMatch(/\d+ ta ochiq/u);
    const readers: Record<string, RegExp> = {
      'src/modules/wms/calc/service.ts': /await openCalcCapFor\(requestedBy\)/u,
      'src/modules/wms/agent/card-io.ts': /await openCalcCapFor\(d\.managerUserId\)/u,
      'src/modules/wms/agent/web-page.ts': /await openCalcCapFor\(ownerUserId\)/u,
      'src/modules/platform/telegram/staff-handlers.ts': /openCalcCapFor\(staff\.id\)/u,
      'src/modules/platform/telegram/calc-intake-sweep.ts': /openCalcCapFor\(state\.staffId\)/u,
    };
    for (const [file, asks] of Object.entries(readers)) {
      const src = strip(readFileSync(file, 'utf8'));
      expect(src, file).toMatch(asks);
      expect(src, file).not.toMatch(/MAX_OPEN_PER_REQUESTER\s*\?|>=\s*MAX_OPEN_PER_REQUESTER|\b20 ta ochiq/u);
    }
  });
});
