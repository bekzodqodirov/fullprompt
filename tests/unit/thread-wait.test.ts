import { describe, expect, it } from 'vitest';
import {
  dropTaskPending,
  noteReplyPending,
  noteTaskPending,
  peekTaskPending,
  takeTaskPending,
  takeTaskPendingFor,
} from '@/modules/platform/telegram/staff-bot';

/**
 * The one wait's fifth kind (0127): «💬 Javob yozish» arms a `'reply'` wait
 * in the SAME map every other wait lives in, carrying the message it was
 * pressed on. `pendingOf` rebuilds the entry field by field (the judge's 6) —
 * a field it forgets arrives as nothing, and the wait would have no target.
 */
describe('the reply wait', () => {
  it('carries the pressed message through the one reader', () => {
    const chat = 9_000_000_001n;
    noteReplyPending(chat, 42);
    const taken = takeTaskPending(chat);
    expect(taken).toMatchObject({ kind: 'reply', replyToMessageId: 42, taskId: '', pressed: null });
    expect(takeTaskPending(chat)).toBeNull();
  });

  it('a PEEK never deletes — only the take does', () => {
    const chat = 9_000_000_002n;
    noteReplyPending(chat, 7);
    expect(peekTaskPending(chat)).toMatchObject({ kind: 'reply', replyToMessageId: 7 });
    expect(peekTaskPending(chat)).toMatchObject({ kind: 'reply', replyToMessageId: 7 });
    expect(takeTaskPending(chat)).toMatchObject({ kind: 'reply' });
    expect(peekTaskPending(chat)).toBeNull();
  });

  it('no task uuid is empty, so the named take («✅ Natijasiz») never matches a reply wait', () => {
    const chat = 9_000_000_003n;
    noteReplyPending(chat, 5);
    expect(takeTaskPendingFor(chat, '00000000-0000-4000-8000-000000000001')).toBeNull();
    // …and it did not consume it either.
    expect(peekTaskPending(chat)).toMatchObject({ kind: 'reply' });
    dropTaskPending(chat);
    expect(peekTaskPending(chat)).toBeNull();
  });

  it('pressing it replaces whatever was armed — like «💬 Savol» does', () => {
    const chat = 9_000_000_004n;
    noteTaskPending(chat, '00000000-0000-4000-8000-000000000009', null, 'question');
    noteReplyPending(chat, 11);
    expect(peekTaskPending(chat)).toMatchObject({ kind: 'reply', replyToMessageId: 11 });
    dropTaskPending(chat);
  });
});
