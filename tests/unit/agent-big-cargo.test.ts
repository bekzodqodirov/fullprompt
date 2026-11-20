import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';
import { bigCargoOf, bigCargoText, bigCargoWeek, saysFullTruck, type BigCargo } from '@/modules/wms/agent/big-cargo';
import type { ChatMessage, MeasureCandidate } from '@/modules/wms/agent/context';
import type { ToolOutcome } from '@/modules/wms/agent/tools';

/**
 * The big-cargo signal (stage 1a §4.5, his 3 b «20 kubdan yoki fura desa»): the pure half — the threshold, the words,
 * which figures count, and the text one recipient reads. The claim (once per chat per week), the recipients and the
 * purge are `tests/integration/agent-big-cargo.integration.test.ts`; the words reader's cases of both kinds are the
 * reader corpus's `full_truck`.
 */

const NBSP = ' ';

function line(ref: string, body: string, direction: 'in' | 'out' = 'in'): ChatMessage {
  return { ref, id: ref, tgMessageId: 1n, direction, body, sentAt: new Date('2026-11-17T06:00:00Z'), media: null } as unknown as ChatMessage;
}

const vol = (ref: string, value: number, messageRef: string): MeasureCandidate => ({ ref, kind: 'volume', value, messageRef });
const wt = (ref: string, value: number, messageRef: string): MeasureCandidate => ({ ref, kind: 'weight', value, messageRef });

const ON = { m3: 20, words: true };

describe('bigCargoOf — what makes a load big', () => {
  it('a volume THIS burst states at the line or above is big by size; below it is not', () => {
    const burst = [line('#5', '24 kub 5200 kg Yiwudan')];
    expect(bigCargoOf({ burst, measures: [vol('v1', 24, '#5'), wt('w1', 5200, '#5')] }, [], ON)).toEqual({ m3: 24, kg: 5200, by: 'size' });
    expect(bigCargoOf({ burst, measures: [vol('v1', 20, '#5')] }, [], ON)).toEqual({ m3: 20, kg: null, by: 'size' });
    expect(bigCargoOf({ burst, measures: [vol('v1', 19.9, '#5')] }, [], ON)).toBeNull();
  });

  it('a figure of an EARLIER turn does not re-signal: only the burst’s own lines count', () => {
    const burst = [line('#9', 'salom, narxi qancha?')];
    expect(bigCargoOf({ burst, measures: [vol('v1', 40, '#2')] }, [], ON)).toBeNull();
  });

  it('the volume the run PRICED counts (a yo’lkira estimate’s m3), whatever the lines said', () => {
    const priced = { priced: { tool: 'yolkira_estimate', kg: 6000, m3: 30, zone: 'cn', day: '2026-11-17', total: 1, rate: 1, unit: 'm3' } } as unknown as ToolOutcome;
    expect(bigCargoOf({ burst: [line('#3', 'shu yukka narx')], measures: [] }, [priced], ON)).toEqual({ m3: 30, kg: 6000, by: 'size' });
    // An avia estimate prices by kg (m3 null) — not a volume.
    const avia = { priced: { tool: 'avia_estimate', kg: 800, m3: null, zone: null, day: '2026-11-17', total: 1, rate: 1, unit: 'kg' } } as unknown as ToolOutcome;
    expect(bigCargoOf({ burst: [line('#3', 'avia')], measures: [] }, [avia], ON)).toBeNull();
  });

  it('«fura» alone signals while the words box is on; never with it off; a size of 0 turns the size half off', () => {
    const burst = [line('#4', 'Yiwudan fura kerak')];
    expect(bigCargoOf({ burst, measures: [] }, [], ON)).toEqual({ m3: null, kg: null, by: 'words' });
    expect(bigCargoOf({ burst, measures: [] }, [], { m3: 20, words: false })).toBeNull();
    expect(bigCargoOf({ burst: [line('#4', '50 kub')], measures: [vol('v1', 50, '#4')] }, [], { m3: 0, words: true })).toBeNull();
  });

  it('only the CUSTOMER’s lines are read for the words — our own «fura» is not his', () => {
    const burst = [line('#6', 'Bizda fura ham bor', 'out'), line('#7', 'yaxshi')];
    expect(bigCargoOf({ burst, measures: [] }, [], ON)).toBeNull();
  });
});

describe('saysFullTruck — the words (the reader corpus holds both kinds; these are the shape rules)', () => {
  it('a negation reaches only its own clause', () => {
    expect(saysFullTruck(['Fura kerak emas'])).toBe(false);
    expect(saysFullTruck(['Bizga fura kerak, LCL emas'])).toBe(true);
  });

  it('a word that only BEGINS like «fura» is not one', () => {
    for (const goods of ['Фурнитура', 'Фураж', 'Furazolidon', 'furafiks']) expect(saysFullTruck([goods]), goods).toBe(false);
  });
});

describe('bigCargoText — what ONE recipient reads', () => {
  const cargo: BigCargo = { m3: 24, kg: 5200, by: 'size' };

  it('kub and kg, and «AI javob tayyorladi» — never «berdi» (the draft may still wait for his ✅, #1106)', () => {
    const text = bigCargoText(cargo, null);
    expect(text).toBe(`🚛 Katta yuk: 24 kub · 5${NBSP}200 kg · AI javob tayyorladi.`);
    expect(text).not.toMatch(/berdi/u);
  });

  it('a recipient the card’s door refuses reads NO name and NO link', () => {
    const text = bigCargoText(cargo, null);
    expect(text.split('\n')).toHaveLength(1);
    expect(text).not.toMatch(/https?:/u);
  });

  it('a recipient the door admits reads the card’s name and its link on the LAST line (the drain’s «↗️ Ochish»)', () => {
    const text = bigCargoText(cargo, { name: 'Lid Alfa', href: 'https://gsrwms.uz/crm/leads/abc' });
    expect(text.split('\n')).toEqual([`🚛 Katta yuk: 24 kub · 5${NBSP}200 kg · AI javob tayyorladi.`, '👤 Lid Alfa', 'https://gsrwms.uz/crm/leads/abc']);
  });

  it('the words alone say what was asked in our words, never the customer’s', () => {
    expect(bigCargoText({ m3: null, kg: null, by: 'words' }, null)).toBe('🚛 Katta yuk: to‘liq mashina (fura) · AI javob tayyorladi.');
  });
});

describe('once per chat per week', () => {
  it('the week is the Tashkent ISO week: Monday to Sunday, by the office’s calendar', () => {
    // Sunday 23:30 Tashkent (18:30 UTC) is still the week that began on Monday the 16th; 00:30 Monday is the next.
    expect(bigCargoWeek(new Date('2026-11-22T18:30:00Z'))).toBe('2026-11-16');
    expect(bigCargoWeek(new Date('2026-11-22T19:30:00Z'))).toBe('2026-11-23');
    expect(bigCargoWeek(new Date('2026-11-17T06:00:00Z'))).toBe('2026-11-16');
  });

  it('the claim’s key names the account, the chat and the week — the source holds it so', () => {
    const src = readFileSync('src/modules/wms/agent/big-cargo.ts', 'utf8');
    expect(src).toMatch(/dedupeKey: `big_cargo:\$\{ctx\.managerUserId\}:\$\{String\(ctx\.peerId\)\}:\$\{bigCargoWeek\(now\)\}`/u);
  });
});

describe('where the run calls it (§4.5) — after the draft is written, in its own catch', () => {
  it('handleInbound calls it only for a WRITTEN draft, after writeDraft, inside a try whose catch only logs', () => {
    const src = readFileSync('src/modules/wms/agent/run.ts', 'utf8');
    const body = src.slice(src.indexOf('export async function handleInbound'), src.indexOf('export async function handleInbound') + 20_000);
    const write = body.indexOf('const written = await writeDraft(');
    const call = body.indexOf('await signalBigCargo(ctx, loop.outcomes, now());');
    expect(write, 're-anchor: writeDraft').toBeGreaterThan(0);
    expect(call, 're-anchor: the signal call').toBeGreaterThan(write);
    const around = body.slice(body.lastIndexOf("if (written.kind === 'written') {", call), body.indexOf('}\n    }', call) + 8);
    expect(around).toMatch(/try \{\s*const \{ signalBigCargo \} = await import\('\.\/big-cargo'\);\s*await signalBigCargo\(ctx, loop\.outcomes, now\(\)\);\s*\} catch \(err\) \{\s*logger\.warn\(/u);
  });
});
