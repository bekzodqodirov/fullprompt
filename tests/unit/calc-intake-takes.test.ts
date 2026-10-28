import { afterEach, describe, expect, it } from 'vitest';
import {
  endIntake,
  HOLD_MS,
  intakeHolds,
  intakeTakes,
  ownsPress,
  startIntake,
} from '@/modules/platform/telegram/calc-store';
import type { IntakeState } from '@/modules/platform/telegram/calc-intake';
import { __resetLifecycle, markBoot } from '@/modules/platform/telegram/lifecycle';

/**
 * `intakeTakes` — does a message belong to the collection, and was it applied
 * already (docs/SAKKIZ-R3.md §6.2.8, his Q5 a). Pure: one verdict the text,
 * file and voice doors share. Every case below is a state handed in whole;
 * nothing is stored (durable is off in this file).
 */

const chats: bigint[] = [];
let seq = 0;
function collection(patch: Partial<IntakeState> = {}): IntakeState {
  seq += 1;
  const chat = BigInt(-7_500_000_000) - BigInt(seq);
  chats.push(chat);
  return { ...startIntake(chat, 'rastamojka', { staffId: 'staff-takes' }), ...patch };
}
afterEach(() => {
  for (const chat of chats.splice(0)) endIntake(chat);
  __resetLifecycle();
});

const sec = (ms: number) => Math.floor(ms / 1000);

describe('a hydrated collection takes the backlog written after it opened (Q5 a)', () => {
  it('opened at T0, booted at T1: a message at T0+5 is taken, one at T0−5 is not', () => {
    const t0 = Date.now() - 20 * 60_000;
    markBoot(new Date(t0 + 10 * 60_000));
    const state = collection({ openedAt: t0, touchedAt: t0 });
    expect(intakeTakes(state, { date: sec(t0) + 5, messageId: 101, replyTo: null })).toBe('take');
    expect(intakeTakes(state, { date: sec(t0) - 5, messageId: 102, replyTo: null })).toBe('pass');
  });

  it('a collection a late press opened after boot takes no backlog message (I20b)', () => {
    const boot = Date.now() - 60_000;
    markBoot(new Date(boot));
    const state = collection();
    expect(intakeTakes(state, { date: sec(boot) - 30, messageId: 103, replyTo: null })).toBe('pass');
    expect(intakeTakes(state, { date: sec(Date.now()), messageId: 104, replyTo: null })).toBe('take');
  });
});

describe('a message applied before is «seen» (durability-1, regression-6)', () => {
  it('at or below `takenUpTo` → seen, dropped in silence; above it → taken', () => {
    const state = collection({ takenUpTo: 500 });
    const now = sec(Date.now());
    expect(intakeTakes(state, { date: now, messageId: 500, replyTo: null })).toBe('seen');
    expect(intakeTakes(state, { date: now, messageId: 499, replyTo: null })).toBe('seen');
    expect(intakeTakes(state, { date: now, messageId: 501, replyTo: null })).toBe('take');
  });
});

describe('parking: waits 24 hours, holds the chat 30 minutes (regression-1)', () => {
  it('touched at T: a message at T + 31 min is not taken; a reply to its table at T + 3 h is', () => {
    const t = Date.now() - 4 * 3_600_000;
    const state = collection({ touchedAt: t, ownMessageIds: [9001] });
    expect(intakeTakes(state, { date: sec(t + 31 * 60_000), messageId: 201, replyTo: null })).toBe('pass');
    expect(intakeTakes(state, { date: sec(t + 3 * 3_600_000), messageId: 202, replyTo: 9001 })).toBe('take');
    // A reply to some other bot message does not resume it.
    expect(intakeTakes(state, { date: sec(t + 3 * 3_600_000), messageId: 203, replyTo: 4242 })).toBe('pass');
  });

  it('holds just under 30 minutes, parks at 30', () => {
    const t = Date.now();
    const state = collection({ touchedAt: t });
    expect(intakeHolds(state, t + HOLD_MS - 1)).toBe(true);
    expect(intakeHolds(state, t + HOLD_MS)).toBe(false);
    expect(intakeTakes(state, { date: sec(t + 29 * 60_000), messageId: 301, replyTo: null })).toBe('take');
  });

  it('a backlog message is judged at the date it was WRITTEN: holding then, it is taken', () => {
    const t = Date.now() - 2 * 3_600_000;
    markBoot(new Date(t - 3_600_000));
    // Opened before boot (hydrated), touched at t, the message written at t + 10 min.
    const state = collection({ openedAt: t - 2 * 3_600_000, touchedAt: t });
    markBoot(new Date());
    expect(intakeTakes(state, { date: sec(t + 10 * 60_000), messageId: 401, replyTo: null })).toBe('take');
    expect(intakeTakes(state, { date: sec(t + 40 * 60_000), messageId: 402, replyTo: null })).toBe('pass');
  });
});

describe('a press acts only on its own collection (durability-2, §6.2.9)', () => {
  it('the opening message and its own messages own a press; another collection’s message does not', () => {
    const state = collection({ openedBy: 70, ownMessageIds: [71, 75] });
    expect(ownsPress(state, 70)).toBe(true);
    expect(ownsPress(state, 75)).toBe(true);
    expect(ownsPress(state, 60)).toBe(false);
    expect(ownsPress(state, 80)).toBe(false);
  });

  it('a press that names no message cannot be judged and acts on what is live (a test’s stand-in ctx)', () => {
    expect(ownsPress(collection({ openedBy: 1 }), null)).toBe(true);
  });
});
