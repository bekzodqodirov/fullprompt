import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';
import { SAMPLE_DAILY_DAYS, SAMPLE_DRAW_MINUTES, SAMPLE_SIZE, sampleDue, sampleLineText, sampleSpan } from '@/modules/wms/agent/sample';

/**
 * «Kunlik tekshiruv» (stage 1a §4.5, his 9 a): the cadence, the span, the line. The draw (pressed and sent only,
 * money first, then the lowest confidence, once per day), the marks and the door are
 * `tests/integration/agent-sample.integration.test.ts`.
 */

describe('the cadence — daily for the first month, then Fridays (his 9 a; derived, no setting)', () => {
  it('no sample ever drawn: today', () => {
    expect(sampleDue('2026-11-24', null)).toBe('daily');
  });

  it('daily while the first sample is under 30 days old — Tuesdays included', () => {
    expect(sampleDue('2026-11-24', '2026-11-20')).toBe('daily');
    expect(sampleDue('2026-12-19', '2026-11-20')).toBe('daily'); // day 29
  });

  it('from day 30: Fridays only — a Tuesday of week six is none, its Friday is the week’s', () => {
    expect(sampleDue('2026-12-29', '2026-11-20')).toBeNull(); // a Tuesday, day 39
    expect(sampleDue('2026-12-20', '2026-11-20')).toBeNull(); // day 30, a Sunday
    expect(sampleDue('2027-01-01', '2026-11-20')).toBe('weekly'); // a Friday
  });

  it('a month is the plan’s, and ten the most a sample holds', () => {
    expect(SAMPLE_DAILY_DAYS).toBe(30);
    expect(SAMPLE_SIZE).toBe(10);
  });

  it('draw to draw: a daily sample is the 24 hours before its 20:10, a weekly one the seven days — no evening hour is left out (the P4 review’s 4)', () => {
    expect(sampleSpan('2026-11-24', 'daily')).toEqual({ from: new Date('2026-11-23T15:10:00Z'), to: new Date('2026-11-24T15:10:00Z') });
    expect(sampleSpan('2027-01-01', 'weekly')).toEqual({ from: new Date('2026-12-25T15:10:00Z'), to: new Date('2027-01-01T15:10:00Z') });
    // Consecutive spans meet: yesterday's end is today's start, and a Friday's end the next Friday's start.
    expect(sampleSpan('2026-11-25', 'daily').from).toEqual(sampleSpan('2026-11-24', 'daily').to);
    expect(sampleSpan('2027-01-08', 'weekly').from).toEqual(sampleSpan('2027-01-01', 'weekly').to);
  });

  it('the span’s minute is the schedule’s: 20:10 Tashkent = 15:10 UTC, as `registerAgentWorkers` schedules the job', () => {
    expect(SAMPLE_DRAW_MINUTES).toBe(20 * 60 + 10);
    const src = readFileSync('src/modules/wms/agent/jobs.ts', 'utf8');
    const utc = SAMPLE_DRAW_MINUTES - 5 * 60; // Tashkent is UTC+5 all year (no summer time)
    expect(src).toContain(`await boss.schedule(JOB_AGENT_SAMPLE, '${utc % 60} ${Math.floor(utc / 60)} * * *');`);
  });
});

describe('the line — a count, how long it takes, the tab', () => {
  it('ten replies are five minutes; the tab’s link last only for whom the page admits', () => {
    process.env.APP_URL = 'https://gsrwms.uz';
    const withPage = sampleLineText(10, 'daily', true).split('\n');
    expect(withPage[0]).toMatch(/^🔎 Bugungi tekshiruv: 10 ta javob — 5 daqiqa\./u);
    expect(withPage.at(-1)).toBe('https://gsrwms.uz/suhbatlar/ai?bolim=tekshiruv');
    expect(sampleLineText(10, 'daily', false)).not.toMatch(/https?:/u);
    expect(sampleLineText(3, 'weekly', false)).toMatch(/^🔎 Haftalik tekshiruv: 3 ta javob — 2 daqiqa\./u);
    expect(sampleLineText(1, 'daily', false)).toMatch(/— 1 daqiqa/u);
  });
});

describe('the 👎 button asks first, as the card’s own does (the P4 review’s 3)', () => {
  it('a second 👎 in seven days switches «o‘zi yuborish» off — the confirm that says so comes before the press', () => {
    const src = readFileSync('src/app/(protected)/suhbatlar/ai/signal-ui.tsx', 'utf8');
    const buttons = src.slice(src.indexOf('export function SampleMarkButtons'));
    const confirm = buttons.indexOf("if (!window.confirm(t('autoBadConfirm'))) return;");
    expect(confirm, 're-anchor: the confirm').toBeGreaterThan(0);
    expect(confirm).toBeLessThan(buttons.indexOf("agentSampleMarkAction(day, draftId, 'bad')"));
    expect(buttons.indexOf("agentSampleMarkAction(day, draftId, 'bad')")).toBeLessThan(buttons.indexOf('data-testid="agent-sample-bad"'));
  });
});

describe('the door (§5): the arming rule, asked — never restated', () => {
  it('markSample asks `mayArmAuto` of the reply’s own holder before anything is written, and 👎 goes through the card’s 👎', () => {
    const src = readFileSync('src/modules/wms/agent/sample.ts', 'utf8');
    const mark = src.slice(src.indexOf('export async function markSample'), src.indexOf('/** One sampled reply as the page draws it.'));
    const door = mark.indexOf('await mayArmAuto(actor, row.managerUserId)');
    expect(door, 're-anchor: the door').toBeGreaterThan(0);
    expect(door).toBeLessThan(mark.indexOf('.update(agentSamples)'));
    expect(mark.indexOf('await autoFeedback(')).toBeGreaterThan(door);
    expect(mark.indexOf('await autoFeedback(')).toBeLessThan(mark.indexOf('.update(agentSamples)'));
    expect(mark).not.toMatch(/roles\.includes/u);
  });
});
