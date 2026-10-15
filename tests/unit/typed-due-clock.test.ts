import { describe, expect, it } from 'vitest';
import { parseTypedDue } from '@/modules/platform/telegram/task-draft';
import { bodyOf, read } from '../fixtures/source-shape';

/**
 * A typed answer is read on the day it was WRITTEN (Q5 a, §3.8, judges
 * Q5H-6/W9). «15:00» typed at 14:58 into a durable ⏰ wait and handled at
 * 15:02 after a deploy must be TODAY 15:00, as written — read on the
 * processing clock it is «ertaga 15:00», a day late, and «06.10» typed at
 * 23:58 on the 6th would become next year.
 */
const TASKS = read('src/modules/platform/telegram/task-handlers.ts');

describe('the premise: the same words mean different days on different clocks', () => {
  it('«15:00» at 14:58 Tashkent is today; at 15:02 it is tomorrow', () => {
    expect(parseTypedDue('15:00', new Date('2026-10-07T09:58:00Z'))?.dueAt).toBe('2026-10-07T15:00');
    expect(parseTypedDue('15:00', new Date('2026-10-07T10:02:00Z'))?.dueAt).toBe('2026-10-08T15:00');
  });
});

describe('both typed-date readers use the message’s own clock', () => {
  for (const [name, needle] of [
    ['answerReschedule', 'async function answerReschedule('],
    ['draftText', 'export async function draftText('],
  ] as const) {
    it(name, () => {
      const body = bodyOf(TASKS, needle);
      expect(body.length, `re-anchor: ${name}`).toBeGreaterThan(0);
      expect(body).toContain('new Date(ctx.message.date * 1000)');
      expect(body).toContain('parseTypedDue(text, writtenAt)');
      expect(body).toContain('typedDuePast(text, writtenAt)');
      expect(body).not.toMatch(/parseTypedDue\(text\)|typedDuePast\(text\)/);
    });
  }
});
