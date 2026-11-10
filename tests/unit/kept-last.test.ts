import { afterEach, describe, expect, it, vi } from 'vitest';
import {
  drawKeptLast,
  editGone,
  keepLastSoon,
  keptLastSettled,
  notModified,
  stillLast,
} from '@/modules/platform/telegram/kept-last';

/**
 * «Always the last message» (docs/IKKI-ESHIK.md §1.4, §4.1, §4.2): the ONE
 * prompt, the ONE burst offer and the ONE pause line each stay below what the
 * seller sent. Edit while still last; otherwise send below and delete the old
 * copy, keeping it when the delete fails so its buttons still work.
 */

function fakeCtx(opts: { edit?: () => Promise<unknown>; del?: () => Promise<unknown>; nextId?: number } = {}) {
  let id = opts.nextId ?? 100;
  const sent: string[] = [];
  const edits: number[] = [];
  const deletes: number[] = [];
  return {
    sent,
    edits,
    deletes,
    ctx: {
      reply: async (text: string) => {
        sent.push(text);
        return { message_id: id++ };
      },
      api: {
        editMessageText: async (_chat: string, messageId: number) => {
          edits.push(messageId);
          return opts.edit ? opts.edit() : true;
        },
        deleteMessage: async (_chat: string, messageId: number) => {
          deletes.push(messageId);
          return opts.del ? opts.del() : true;
        },
      },
    },
  };
}

const refused = (description: string) => Object.assign(new Error(description), { description });

describe('stillLast', () => {
  it('no copy yet is never still last', () => expect(stillLast(null, 5)).toBe(false));
  it('nothing newer known → still last', () => expect(stillLast(7, null)).toBe(true));
  it('the copy at or above the newest message → still last', () => {
    expect(stillLast(7, 6)).toBe(true);
    expect(stillLast(7, 7)).toBe(true);
  });
  it('a newer message below it → no longer last', () => expect(stillLast(7, 8)).toBe(false));
});

describe('drawKeptLast', () => {
  it('still last → edited in place, nothing sent', async () => {
    const f = fakeCtx();
    const out = await drawKeptLast(f.ctx, 1n, 50, 49, 'x');
    expect(out).toEqual({ messageId: 50, moved: false, kept: null });
    expect(f.edits).toEqual([50]);
    expect(f.sent).toEqual([]);
  });

  it('«not modified» is success', async () => {
    const f = fakeCtx({ edit: () => Promise.reject(refused('Bad Request: message is not modified')) });
    expect(await drawKeptLast(f.ctx, 1n, 50, 49, 'x')).toEqual({ messageId: 50, moved: false, kept: null });
    expect(f.sent).toEqual([]);
  });

  it('a 429 leaves the old copy standing — no second copy', async () => {
    const f = fakeCtx({ edit: () => Promise.reject(refused('Too Many Requests: retry after 3')) });
    expect(await drawKeptLast(f.ctx, 1n, 50, 49, 'x')).toEqual({ messageId: 50, moved: false, kept: null });
    expect(f.sent).toEqual([]);
  });

  it('the old copy gone → a new one, nothing to delete', async () => {
    const f = fakeCtx({ edit: () => Promise.reject(refused('Bad Request: message to edit not found')) });
    const out = await drawKeptLast(f.ctx, 1n, 50, 49, 'x');
    expect(out).toEqual({ messageId: 100, moved: true, kept: null });
    expect(f.deletes).toEqual([]);
  });

  it('material below it → sent below, the old copy deleted', async () => {
    const f = fakeCtx();
    const out = await drawKeptLast(f.ctx, 1n, 50, 60, 'x');
    expect(out).toEqual({ messageId: 100, moved: true, kept: null });
    expect(f.edits).toEqual([]);
    expect(f.deletes).toEqual([50]);
  });

  it('a delete that fails keeps the old copy for its buttons', async () => {
    const f = fakeCtx({ del: () => Promise.reject(refused("Bad Request: message can't be deleted")) });
    expect(await drawKeptLast(f.ctx, 1n, 50, 60, 'x')).toEqual({ messageId: 100, moved: true, kept: 50 });
  });

  it('no prior copy → sent, nothing deleted', async () => {
    const f = fakeCtx();
    expect(await drawKeptLast(f.ctx, 1n, null, 60, 'x')).toEqual({ messageId: 100, moved: true, kept: null });
    expect(f.deletes).toEqual([]);
  });
});

describe('refusal predicates', () => {
  it('reads Telegram’s description', () => {
    expect(notModified(refused('Bad Request: message is not modified: …'))).toBe(true);
    expect(editGone(refused("Bad Request: message can't be edited"))).toBe(true);
    expect(editGone(refused('Too Many Requests'))).toBe(false);
  });
});

describe('keepLastSoon — an album moves it once', () => {
  afterEach(() => vi.useRealTimers());

  it('ten calls in a burst run the newest draw once', async () => {
    vi.useFakeTimers();
    const ran: number[] = [];
    for (let i = 0; i < 10; i++) keepLastSoon('prompt:1', async () => void ran.push(i));
    expect(ran).toEqual([]);
    await vi.advanceTimersByTimeAsync(1000);
    expect(ran).toEqual([9]);
  });

  it('a call while a draw runs is followed by exactly one more', async () => {
    vi.useFakeTimers();
    const ran: string[] = [];
    let release!: () => void;
    keepLastSoon('prompt:2', () => new Promise<void>((r) => ((release = r), ran.push('a'))));
    await vi.advanceTimersByTimeAsync(1000);
    keepLastSoon('prompt:2', async () => void ran.push('b'));
    keepLastSoon('prompt:2', async () => void ran.push('c'));
    release();
    await vi.runAllTimersAsync();
    await keptLastSettled();
    expect(ran).toEqual(['a', 'c']);
  });

  it('keptLastSettled runs what is owed now', async () => {
    const ran: string[] = [];
    keepLastSoon('prompt:3', async () => void ran.push('x'), 60_000);
    await keptLastSettled();
    expect(ran).toEqual(['x']);
  });

  /**
   * The last draw of a burst is never lost (as-built review DURABILITY-3): a
   * request for the same key made from INSIDE a run, before its first await,
   * re-armed a timer on an entry the run's cleanup then deleted; one made a
   * few microtasks after the run's last await set `again` on an entry about
   * to die. Both drew nothing — the prompt or the offer stayed above what the
   * seller sent. Every depth from 0 to 12 microtasks is asked.
   */
  it('a request for the same key from inside a run — synchronously, or N microtasks after its last await — is drawn', async () => {
    const pause = () => new Promise<void>((r) => setTimeout(r, 15));
    const ran: string[] = [];
    keepLastSoon(
      'prompt:sync',
      async () => {
        ran.push('a');
        keepLastSoon('prompt:sync', async () => void ran.push('b'), 0);
        await Promise.resolve();
      },
      0,
    );
    await keptLastSettled();
    await pause();
    await keptLastSettled();
    expect(ran).toEqual(['a', 'b']);
    for (let depth = 0; depth <= 12; depth++) {
      const key = `prompt:depth${depth}`;
      const seen: string[] = [];
      keepLastSoon(
        key,
        async () => {
          seen.push('a');
          await Promise.resolve();
          let chain = Promise.resolve();
          for (let i = 0; i < depth; i++) chain = chain.then(() => {});
          void chain.then(() => keepLastSoon(key, async () => void seen.push('b'), 0));
        },
        0,
      );
      await keptLastSettled();
      await pause();
      await keptLastSettled();
      expect(seen, `depth ${depth}`).toEqual(['a', 'b']);
    }
  });
});
