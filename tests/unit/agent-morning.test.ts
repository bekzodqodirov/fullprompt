import { readdirSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import ts from 'typescript';
import { describe, expect, it } from 'vitest';
import { AUTO_REFUSALS, COMING_REFUSALS, RETIRED_REFUSALS, refusalWordOf } from '@/modules/wms/agent/auto-gate';
import {
  MORNING_REASON_ORDER,
  morningEmpty,
  morningLine,
  morningReasonOf,
  morningWordOf,
  noDraftWordOf,
  type MorningDraftRow,
  type MorningFacts,
} from '@/modules/wms/agent/morning';
import { CAP_WORDS, capWordOf } from '@/modules/wms/agent/today';

/**
 * The morning line (stage 1a §4.5): its pure half — the ONE reason each held reply is counted under, the words, the
 * sums, the caps by name and the token cap as the loop guard it is (§4.6). The database half (the day's drafts, runs,
 * waiting customers and samples, and who receives it) is `tests/integration/agent-morning.integration.test.ts`.
 */

const refused = (...reasons: string[]): MorningDraftRow => ({ verdict: { eligible: false, reasons, state: null, outcome: null }, outbox: null });

describe('morningReasonOf — ONE reason a reply is counted under', () => {
  it('a reply the machine pressed and the customer got went; pressed and not sent did not', () => {
    expect(morningReasonOf({ verdict: { eligible: true, reasons: [], state: 'pressed', outcome: null }, outbox: 'sent' })).toBe('went');
    expect(morningReasonOf({ verdict: { eligible: true, reasons: [], state: 'pressed', outcome: null }, outbox: 'cancelled' })).toBe('not_sent');
  });

  it('several refusals: the FIRST in the gate’s own order, whatever order the row stored them in', () => {
    expect(morningReasonOf(refused('night', 'media', 'needs_owner'))).toBe('needs_owner');
    expect(morningReasonOf(refused('language', 'money'))).toBe('money');
    // The stage's new codes come after the gate's, and a code no build knows after every known one.
    expect(morningReasonOf(refused('zz_new', 'loop'))).toBe('loop');
    expect(morningReasonOf(refused('zz_new'))).toBe('zz_new');
  });

  it('the order is the gate’s own list, then the coming codes, then the retired ones — never restated', () => {
    expect(MORNING_REASON_ORDER.slice(0, AUTO_REFUSALS.length)).toEqual([...AUTO_REFUSALS]);
    for (const code of [...COMING_REFUSALS, ...RETIRED_REFUSALS]) expect(MORNING_REASON_ORDER).toContain(code);
    expect(new Set(MORNING_REASON_ORDER).size).toBe(MORNING_REASON_ORDER.length);
  });

  it('a refusal at the press reads its own codes; the morning’s own states for the rest', () => {
    expect(morningReasonOf({ verdict: { eligible: true, reasons: [], state: 'refused', outcome: 'auto_warning:questions' }, outbox: null })).toBe('auto_warning');
    expect(morningReasonOf({ verdict: { eligible: true, reasons: ['media', 'night'], state: 'refused', outcome: 'media,night' }, outbox: null })).toBe('media');
    expect(morningReasonOf({ verdict: { eligible: true, reasons: [], state: 'stopped', outcome: 'pause' }, outbox: null })).toBe('stopped_pause');
    expect(morningReasonOf({ verdict: { eligible: true, reasons: [], state: 'stopped', outcome: 'owner_send' }, outbox: null })).toBe('stopped_owner');
    expect(morningReasonOf({ verdict: { eligible: true, reasons: [], state: 'stopped', outcome: 'disarmed' }, outbox: null })).toBe('stopped_disarmed');
    expect(morningReasonOf({ verdict: { eligible: true, reasons: [], state: 'gone', outcome: 'superseded' }, outbox: null })).toBe('gone');
    expect(morningReasonOf({ verdict: { eligible: true, reasons: [], state: 'waiting', outcome: null }, outbox: null })).toBe('waiting');
    expect(morningReasonOf({ verdict: null, outbox: null })).toBe('no_verdict');
  });

  it('every code a reason can be has words — never a code, never empty', () => {
    for (const code of [...MORNING_REASON_ORDER, 'not_sent', 'stopped_owner', 'stopped_pause', 'stopped_disarmed', 'gone', 'waiting', 'no_verdict', 'zz_new']) {
      const word = morningWordOf(code);
      expect(word, code).not.toBe('');
      expect(word, code).not.toBe(code);
      expect(word, code).not.toMatch(/_/u);
    }
  });

  it('the loop is «suhbat aylanib qoldi» in the morning line too — the card’s and the notice’s one word (J33)', () => {
    expect(morningWordOf('loop')).toBe('suhbat aylanib qoldi');
    expect(noDraftWordOf('loop')).toBe('suhbat aylanib qoldi');
    expect(refusalWordOf('loop')).toBe('suhbat aylanib qoldi');
  });
});

function facts(over: Partial<MorningFacts> = {}): MorningFacts {
  return {
    day: '2026-11-19',
    drafts: 14,
    went: 11,
    waited: [
      { code: 'media', n: 2 },
      { code: 'needs_owner', n: 1 },
    ],
    notDrafted: [],
    caps: [],
    unanswered: 0,
    unmarkedSamples: 10,
    ...over,
  };
}

describe('morningLine — counts only, and they add up', () => {
  it('the plan’s shape: «N javobdan M tasi o‘zi ketdi. K tasi tasdiq kutdi: …» — never «sizni kutdi» (J17)', () => {
    const text = morningLine(facts(), false);
    expect(text.split('\n')[0]).toBe(
      '🌅 AI sotuvchi, kecha (19.11): 14 javobdan 11 tasi o‘zi ketdi. 3 tasi tasdiq kutdi: 2 — rasm, ovoz yoki fayl, 1 — AI savol berdi.',
    );
    expect(text).not.toMatch(/sizni kutdi/u);
    expect(text).toContain('Javobsiz: 0.');
    expect(text).toContain('Belgilanmagan tekshiruv: 10 ta.');
  });

  it('the held replies it names add up to the drafts that did not go', () => {
    const f = facts();
    const said = /(\d+) tasi tasdiq kutdi/u.exec(morningLine(f, false));
    expect(Number(said?.[1])).toBe(f.drafts - f.went);
    expect(f.waited.reduce((s, g) => s + g.n, 0)).toBe(f.drafts - f.went);
  });

  it('every cap the day tripped by name, `chat_runs` counted, the token cap as a loop guard — no «byudjet» (§4.6)', () => {
    const text = morningLine(
      facts({
        caps: [
          { code: 'chat_runs', n: 3 },
          { code: 'daily_token_cap', n: 2 },
        ],
      }),
      false,
    );
    expect(text).toContain('⛔ Chegara tugadi: bitta mijoz uchun kunlik chegara — 3 ta xabar, bugungi tokenlar chegarasi (xato halqasidan himoya, pul chegarasi emas) — 2 ta xabar.');
    expect(text).not.toMatch(/byudjet/iu);
  });

  it('the lines it wrote no reply to, by why', () => {
    const text = morningLine(facts({ notDrafted: [{ code: 'human_active', n: 2 }, { code: 'media_only', n: 1 }] }), false);
    expect(text).toContain("Javob yozilmagan xabarlar: 3 (2 — bu chatda o'zingiz yozayapsiz, 1 — faqat rasm yoki fayl).");
  });

  it('the page’s link last, and only for a recipient the page admits (J17)', () => {
    process.env.APP_URL = 'https://gsrwms.uz';
    const lines = morningLine(facts(), true).split('\n');
    expect(lines.at(-1)).toBe('https://gsrwms.uz/suhbatlar/ai');
    expect(morningLine(facts(), false)).not.toMatch(/https?:/u);
  });

  it('a day with nothing is no line; a day with no drafts but a waiting customer is one', () => {
    expect(morningEmpty(facts({ drafts: 0, went: 0, waited: [], unmarkedSamples: 0 }))).toBe(true);
    expect(morningEmpty(facts({ drafts: 0, went: 0, waited: [], unmarkedSamples: 0, unanswered: 1 }))).toBe(false);
    expect(morningLine(facts({ drafts: 0, went: 0, waited: [], unanswered: 1 }), false).split('\n')[0]).toBe('🌅 AI sotuvchi, kecha (19.11): javob yozilmadi.');
  });
});

describe('the token cap is a loop guard, never a budget (§4.6 — his 10 c, J21)', () => {
  it('the cap’s words say so, and a cap no build knows says it in words', () => {
    expect(CAP_WORDS.daily_token_cap).toContain('pul chegarasi emas');
    expect(CAP_WORDS.daily_token_cap).toContain('xato halqasidan himoya');
    expect(capWordOf('zz')).toBe('bugungi AI chegarasi');
  });

  it('no string under agent/ calls anything a «byudjet» — the cap notice asks the cap’s words', () => {
    const dir = 'src/modules/wms/agent';
    const offenders: string[] = [];
    for (const f of readdirSync(dir).filter((x) => x.endsWith('.ts'))) {
      const source = ts.createSourceFile(f, readFileSync(join(dir, f), 'utf8'), ts.ScriptTarget.Latest, true, ts.ScriptKind.TS);
      const visit = (n: ts.Node): void => {
        if ((ts.isStringLiteral(n) || ts.isNoSubstitutionTemplateLiteral(n) || ts.isTemplateHead(n) || ts.isTemplateMiddle(n) || ts.isTemplateTail(n)) && /byudjet/iu.test(n.text)) {
          offenders.push(`${f}: «${n.text}»`);
        }
        ts.forEachChild(n, visit);
      };
      visit(source);
    }
    expect(offenders).toEqual([]);
    const drafts = readFileSync(join(dir, 'drafts.ts'), 'utf8');
    const notice = drafts.slice(drafts.indexOf('export async function notifyCapReached'), drafts.indexOf('export async function notifyCapReached') + 900);
    expect(notice).toContain('capWordOf(reason)');
  });
});
