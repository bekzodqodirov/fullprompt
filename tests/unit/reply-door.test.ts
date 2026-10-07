import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { describe, expect, it } from 'vitest';
import { buttonsFor, parseCallback } from '@/modules/platform/telegram/staff-bot';
import { isThreadRef, threadOfPayload } from '@/modules/platform/notifications/thread-ref';

/**
 * The reply door's pure half (0127): the «💬 Javob yozish» button and its
 * parse, the bound calc task's «❓ Sotuvchidan so‘rash», and the payload
 * validator every Telegram reply is resolved through.
 */
const UUID = '123e4567-e89b-42d3-a456-426614174000';
const ACT = '223e4567-e89b-42d3-a456-426614174000';
const thread = { kind: 'lead', id: UUID, activityId: ACT };

const src = (rel: string) => readFileSync(resolve(__dirname, '../..', rel), 'utf8');

describe('the jy button', () => {
  it('parses — and carries NO id: the press resolves its own message', () => {
    expect(parseCallback('jy')).toEqual({ kind: 'thread_reply' });
    expect(parseCallback('jy:1')).toBeNull();
    // `mg` stays the cabinet's (zametka-bot.test.ts).
    expect(parseCallback('mg')).toBeNull();
  });

  it('rides on a thread ping that names its thread — never on one sent before 0127', () => {
    for (const type of ['InternalNote', 'MentionedInNote', 'CalcThread']) {
      expect(buttonsFor(type, { thread, text: 'x' }), type).toEqual([[{ text: '💬 Javob yozish', callback_data: 'jy' }]]);
      expect(buttonsFor(type, { text: 'x' }), `${type} old`).toBeNull();
    }
    // A malformed thread is nobody's.
    expect(buttonsFor('InternalNote', { thread: { ...thread, id: 'nope' }, text: 'x' })).toBeNull();
  });

  it('the VED’s bound calc task copy asks the seller instead of offering a task action (E3 a)', () => {
    const payload = { taskId: UUID, origin: 'calc', bound: true, text: 'x' };
    expect(buttonsFor('TaskAssigned', payload)).toEqual([[{ text: '❓ Sotuvchidan so‘rash', callback_data: 'jy' }]]);
    expect(buttonsFor('TaskReminder', payload)).toEqual([[{ text: '❓ Sotuvchidan so‘rash', callback_data: 'jy' }]]);
  });

  it('DERIVED: every callback_data the new files build is one the parser accepts', () => {
    const files = [
      'src/modules/platform/telegram/staff-bot.ts',
      'src/modules/platform/telegram/reply-door.ts',
      'src/modules/platform/telegram/staff-handlers.ts',
    ];
    const literals = files.flatMap((f) =>
      [...src(f).matchAll(/callback_data:\s*'(jy[^']*)'/g)].map((m) => m[1]!),
    );
    expect(literals.length, 're-anchor: no jy buttons found').toBeGreaterThanOrEqual(2);
    for (const data of literals) expect(parseCallback(data), data).not.toBeNull();
  });
});

describe('a ping’s payload.thread, validated', () => {
  it('accepts the shape the announce writes', () => {
    expect(threadOfPayload({ thread, text: 'x' })).toEqual(thread);
    expect(threadOfPayload({ thread: { ...thread, kind: 'calc' } })).toEqual({ ...thread, kind: 'calc' });
  });

  it('refuses a non-uuid id, an unknown kind, and a missing note id — nobody’s thread', () => {
    expect(threadOfPayload({ thread: { ...thread, id: `${UUID}x` } })).toBeNull();
    expect(threadOfPayload({ thread: { ...thread, id: 'aaaaaaaa-aaaaaaaaaaaaaaaaaaaaaaaaaaa' } })).toBeNull();
    expect(threadOfPayload({ thread: { ...thread, kind: 'receipt' } })).toBeNull();
    expect(threadOfPayload({ thread: { kind: 'lead', id: UUID } })).toBeNull();
    expect(threadOfPayload({ text: 'x' })).toBeNull();
    expect(threadOfPayload(null)).toBeNull();
  });

  it('the routes’ body validator is the same rule', () => {
    expect(isThreadRef({ kind: 'deal', id: UUID })).toBe(true);
    expect(isThreadRef({ kind: 'deal', id: 'x' })).toBe(false);
    expect(isThreadRef({ kind: 'batch', id: UUID })).toBe(false);
    expect(isThreadRef('lead')).toBe(false);
  });
});
