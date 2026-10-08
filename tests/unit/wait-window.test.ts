import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { __resetLifecycle, markBoot } from '@/modules/platform/telegram/lifecycle';
import {
  __forgetWaitMemory,
  __waitWriteCount,
  nowSec,
  readWait,
  waitVerdict,
} from '@/modules/platform/telegram/waits';
import {
  noteStaffEntry,
  noteTaskPending,
  peekTaskPendingAny,
  takeStaffEntry,
  takeTaskPending,
  takeTaskPendingFor,
  type PendingTask,
} from '@/modules/platform/telegram/staff-bot';
import { adVisitFor, rememberAdVisit } from '@/modules/platform/telegram/ad-intake';

/**
 * The one-message waits and the moment that answers them (Q5 a, §3.4.3).
 *
 * A wait exists only once its prompt is on the screen; a BACKLOG text dated
 * before that prompt cannot have been written in answer to it, so it does not
 * answer a task wait — the wait stays for the real answer. Everything else
 * answers: a live text, a contact (the person's own number), a press on its
 * own task's prompt. Pure memory here: durable writes are off by default, so
 * not one row reaches the table.
 */
let chat = 7_100_000_000;
const next = () => BigInt((chat += 1));

beforeEach(() => {
  __resetLifecycle();
  __forgetWaitMemory();
});
afterEach(() => __resetLifecycle());

describe('waitVerdict', () => {
  const entry = { armedAt: 1_000, expiresAt: 1_600 };
  it('answers at the prompt’s own second, expires at its expiry, early only when told it applies', () => {
    expect(waitVerdict(entry, 1_000, true)).toBe('answers');
    expect(waitVerdict(entry, 999, true)).toBe('early');
    expect(waitVerdict(entry, 999, false)).toBe('answers');
    expect(waitVerdict(entry, 1_600, false)).toBe('expired');
    expect(waitVerdict(entry, 1_599, true)).toBe('answers');
  });
});

describe('the task wait against the boot line', () => {
  it('a backlog text written before the prompt does not take it, and the wait stays for the real answer', () => {
    const B = nowSec() - 120;
    markBoot(new Date(B * 1000));
    const c = next();
    noteTaskPending(c, 't-1', null, 'result', { armedAt: B + 5 });
    expect(takeTaskPending(c, B - 10)).toBeNull();
    expect(readWait<PendingTask>(c, 'task')).not.toBeNull();
    expect(peekTaskPendingAny(c, B - 10)?.verdict).toBe('early');
    expect(takeTaskPending(c, B + 6)?.taskId).toBe('t-1');
    expect(readWait(c, 'task')).toBeNull();
  });

  it('a LIVE text dated after the boot but before the prompt (the drain) takes it', () => {
    const B = nowSec() - 120;
    markBoot(new Date(B * 1000));
    const c = next();
    noteTaskPending(c, 't-2', null, 'result', { armedAt: B + 5 });
    expect(takeTaskPending(c, B + 2)?.taskId).toBe('t-2');
  });

  it('a press on its own task’s prompt takes it — dated ahead of now, or past its TTL within a day', () => {
    const c1 = next();
    noteTaskPending(c1, 't-3', null, 'result', { armedAt: nowSec() + 3 });
    expect(takeTaskPendingFor(c1, 't-3')?.taskId).toBe('t-3');
    const c2 = next();
    noteTaskPending(c2, 't-4', null, 'result', { armedAt: nowSec() - 3_600 });
    expect(takeTaskPendingFor(c2, 't-4')?.taskId).toBe('t-4');
  });
});

describe('a contact answers its wait by expiry alone', () => {
  it('«Hodim», the advert visit — a contact dated before the prompt still answers', () => {
    const c = next();
    const armedAt = nowSec();
    noteStaffEntry(c, armedAt);
    expect(takeStaffEntry(c, armedAt - 5)).toBe(true);
    rememberAdVisit(Number(c), 'tiktok', armedAt);
    expect(adVisitFor(Number(c), armedAt - 5)).toBe('tiktok');
  });
});

describe('the re-arm of the same target keeps the earliest prompt', () => {
  it('same task and kind: armedAt stays, the expiry moves on', () => {
    const c = next();
    const t0 = nowSec();
    noteTaskPending(c, 't-5', null, 'result', { armedAt: t0 });
    noteTaskPending(c, 't-5', null, 'result', { armedAt: t0 + 30 });
    expect(readWait(c, 'task')).toMatchObject({ armedAt: t0, expiresAt: t0 + 30 + 600 });
  });

  it('another task is a new wait: its own prompt’s time', () => {
    const c = next();
    const t0 = nowSec();
    noteTaskPending(c, 't-6', null, 'result', { armedAt: t0 });
    noteTaskPending(c, 't-7', null, 'result', { armedAt: t0 + 30 });
    expect(readWait(c, 'task')).toMatchObject({ armedAt: t0 + 30 });
  });
});

describe('durable writes are opt-in', () => {
  it('a unit test arms and drops and sends nothing to the table', () => {
    const c = next();
    const before = __waitWriteCount();
    noteTaskPending(c, 't-8');
    takeTaskPending(c);
    expect(__waitWriteCount()).toBe(before);
  });
});
