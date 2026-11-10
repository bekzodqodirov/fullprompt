import { readFileSync } from 'node:fs';
import { afterEach, describe, expect, it, vi } from 'vitest';
import {
  chatOfMessage,
  lastFour,
  LOOKUP_DEADLINE_MS,
  lookupDeadlineMs,
  passedLine,
  sharedWarmer,
  userIdOf,
} from '../../src/modules/wms/crm/listen-trace';

/**
 * A stand-in for a gramjs `Message` built from an `UpdateShortMessage`: no
 * chat object, a bare `PeerUser`, and the two halves of the pinned gramjs
 * (`tl/custom/chatGetter.js`) that matter — `inputChat` is a synchronous
 * read of the entity cache, and `getChat()` with no chat object answers only
 * through what the cache gives it (it never walks dialogs itself).
 */
function shortMessage(userId: bigint, cache: Set<bigint>, opts: { lookupFails?: boolean } = {}) {
  const user = { className: 'User', id: userId, phone: '998901234567' };
  const calls = { getChat: 0 };
  const msg = {
    peerId: { className: 'PeerUser', userId },
    get inputChat() {
      return cache.has(userId) ? { className: 'InputPeerUser', userId } : undefined;
    },
    getChat: async () => {
      calls.getChat += 1;
      if (!cache.has(userId) || opts.lookupFails) return undefined;
      return user;
    },
  };
  return { msg, user, calls };
}

describe('chatOfMessage — the live chat of a short update (2026-10-29)', () => {
  it('a cached chat is used as it is — no warm-up, one lookup', async () => {
    const cache = new Set([5n]);
    const { msg, user, calls } = shortMessage(5n, cache);
    let warms = 0;
    const got = await chatOfMessage(msg, {
      warm: async () => {
        warms += 1;
      },
    });
    expect(got).toEqual({ chat: user, unresolved: false, via: 'direct' });
    expect({ warms, getChat: calls.getChat }).toEqual({ warms: 0, getChat: 1 });
  });

  it('an uncached sender is found after the shared warm-up fills the cache — the line the old code dropped as «not private»', async () => {
    const cache = new Set<bigint>();
    const { msg, user } = shortMessage(9001n, cache);
    // The old path: `getChat()` alone answers nothing for this message.
    expect(await msg.getChat()).toBeUndefined();
    const got = await chatOfMessage(msg, {
      warm: async () => {
        cache.add(9001n);
      },
    });
    expect(got).toEqual({ chat: user, unresolved: false, via: 'dialogs' });
  });

  it('a peer the cache already knew whose lookup failed is NOT escalated — no warm-up, no second lookup, no getEntity', async () => {
    const cache = new Set([7n]);
    const { msg, calls } = shortMessage(7n, cache, { lookupFails: true });
    let warms = 0;
    let asked = 0;
    const got = await chatOfMessage(msg, {
      warm: async () => {
        warms += 1;
      },
      getEntity: async () => {
        asked += 1;
        return { className: 'User' };
      },
    });
    expect(got).toEqual({ chat: undefined, unresolved: true, via: null });
    expect({ warms, asked, getChat: calls.getChat }).toEqual({ warms: 0, asked: 0, getChat: 1 });
  });

  it('not among the newest dialogs either: Telegram is asked by the bare peer, once', async () => {
    const { msg } = shortMessage(9002n, new Set());
    const asked: unknown[] = [];
    const entity = { className: 'User', id: 9002n };
    const got = await chatOfMessage(msg, {
      warm: async () => undefined,
      getEntity: async (peer) => {
        asked.push(peer);
        return entity;
      },
    });
    expect(got).toEqual({ chat: entity, unresolved: false, via: 'entity' });
    expect(asked).toEqual([msg.peerId]);
  });

  it('every way failing — throws included — is an answer, not an exception', async () => {
    const got = await chatOfMessage(
      {
        peerId: { className: 'PeerUser', userId: 8n },
        get inputChat(): unknown {
          throw new Error('cache');
        },
        getChat: async () => {
          throw new Error('boom');
        },
      },
      {
        warm: async () => {
          throw new Error('FLOOD_WAIT_300');
        },
        getEntity: async () => {
          throw new Error('Could not find the input entity');
        },
      },
    );
    expect(got).toEqual({ chat: undefined, unresolved: true, via: null });
  });

  it('a GetUsers that never answers is given up at the deadline — the sender’s queue is not held (L5)', async () => {
    const { msg } = shortMessage(9003n, new Set());
    const started = Date.now();
    const got = await chatOfMessage(msg, {
      warm: async () => undefined,
      getEntity: () => new Promise(() => {}),
      deadlineMs: 25,
    });
    expect(got).toEqual({ chat: undefined, unresolved: true, via: null });
    expect(Date.now() - started).toBeLessThan(2_000);
    // A lookup with no deadline never returns: the test's own limit is the red.
  }, 5_000);

  it('the lookup AFTER the warm-up is bounded too — a cache that now knows the peer, a GetUsers that hangs', async () => {
    const cache = new Set<bigint>();
    const msg = {
      peerId: { className: 'PeerUser', userId: 9004n },
      get inputChat() {
        return cache.has(9004n) ? { className: 'InputPeerUser', userId: 9004n } : undefined;
      },
      // Empty before the warm-up (the cache alone answers), a network call after it.
      getChat: () => (cache.has(9004n) ? new Promise<unknown>(() => {}) : Promise.resolve(undefined)),
    };
    const started = Date.now();
    const got = await chatOfMessage(msg, {
      warm: async () => {
        cache.add(9004n);
      },
      deadlineMs: 25,
    });
    expect(got).toEqual({ chat: undefined, unresolved: true, via: null });
    expect(Date.now() - started).toBeLessThan(2_000);
    // A lookup with no deadline never returns: the test's own limit is the red.
  }, 5_000);

  it('with no deadline given, the default sits PAST gramjs’s own sixty-second flood sleep', () => {
    expect(LOOKUP_DEADLINE_MS).toBe(lookupDeadlineMs(60));
    expect(LOOKUP_DEADLINE_MS).toBeGreaterThan(60_000);
    expect(lookupDeadlineMs(20)).toBeGreaterThan(20_000);
  });

  it('a group or channel without a chat is never warmed for — and is not «unresolved»', async () => {
    let warms = 0;
    const got = await chatOfMessage(
      { peerId: { className: 'PeerChannel', channelId: 3n }, getChat: async () => undefined },
      {
        warm: async () => {
          warms += 1;
        },
      },
    );
    expect(got).toEqual({ chat: undefined, unresolved: false, via: null });
    expect(warms).toBe(0);
  });
});

/**
 * gramjs sleeps a FLOOD_WAIT up to `floodSleepThreshold` (60 s, the listener's
 * own) INSIDE `invoke` and then answers. A known client's `getChat()` is a
 * GetUsers — so the lookup deadline must let that sleep finish, or a line that
 * would have been stored a minute late is passed over for good (the review of
 * L5). Fake timers: the 45 s flood is a timer, not a wait.
 */
describe('chatOfMessage — a flood gramjs sleeps out is waited for, a hang is not', () => {
  afterEach(() => {
    vi.useRealTimers();
  });

  /** A known client's live line whose GetUsers answers after `ms`, or never. */
  function cachedLine(answersAfterMs: number | null) {
    const user = { className: 'User', id: 77n };
    const msg = {
      peerId: { className: 'PeerUser', userId: 77n },
      inputChat: { className: 'InputPeerUser', userId: 77n },
      getChat: () =>
        answersAfterMs === null
          ? new Promise<unknown>(() => {})
          : new Promise<unknown>((resolve) => setTimeout(() => resolve(user), answersAfterMs)),
    };
    return { msg, user };
  }

  async function settle(work: Promise<unknown>, ms: number) {
    let answer: unknown = 'pending';
    void work.then((got) => {
      answer = got;
    });
    await vi.advanceTimersByTimeAsync(ms);
    return answer;
  }

  it('a known client’s GetUsers caught in a 45 s flood sleep still resolves — under the default AND the listener’s deadline', async () => {
    vi.useFakeTimers();
    for (const deadlineMs of [undefined, lookupDeadlineMs(60)]) {
      const { msg, user } = cachedLine(45_000);
      const got = await settle(chatOfMessage(msg, { deadlineMs }), 45_000);
      expect(got).toEqual({ chat: user, unresolved: false, via: 'direct' });
    }
  });

  it('a known client’s GetUsers that never answers is given up — at the deadline and not before', async () => {
    vi.useFakeTimers();
    const { msg } = cachedLine(null);
    const work = chatOfMessage(msg, { deadlineMs: lookupDeadlineMs(60) });
    expect(await settle(work, lookupDeadlineMs(60) - 1)).toBe('pending');
    expect(await settle(work, 1)).toEqual({ chat: undefined, unresolved: true, via: null });
  });

  it('the lookup after the warm-up waits out the same sleep', async () => {
    vi.useFakeTimers();
    const cache = new Set<bigint>();
    const user = { className: 'User', id: 78n };
    const msg = {
      peerId: { className: 'PeerUser', userId: 78n },
      get inputChat() {
        return cache.has(78n) ? { className: 'InputPeerUser', userId: 78n } : undefined;
      },
      getChat: () =>
        cache.has(78n)
          ? new Promise<unknown>((resolve) => setTimeout(() => resolve(user), 45_000))
          : Promise.resolve(undefined),
    };
    const got = await settle(
      chatOfMessage(msg, {
        warm: async () => {
          cache.add(78n);
        },
      }),
      45_000,
    );
    expect(got).toEqual({ chat: user, unresolved: false, via: 'dialogs' });
  });
});

describe('sharedWarmer — one GetDialogs for a burst, paced, never hung', () => {
  /** A clock the test moves; `wait` advances it instead of sleeping. */
  function clock() {
    const c = { t: 1_000_000, waited: [] as number[] };
    return {
      c,
      now: () => c.t,
      wait: async (ms: number) => {
        c.waited.push(ms);
        c.t += ms;
      },
    };
  }

  it('callers that arrive together share ONE call', async () => {
    const { now, wait } = clock();
    let fetches = 0;
    let release: () => void = () => {};
    const warm = sharedWarmer(
      () =>
        new Promise<void>((resolve) => {
          fetches += 1;
          release = resolve;
        }),
      { gapMs: 10_000, failGapMs: 120_000, deadlineMs: 30_000, now, wait },
    );
    const burst = [warm(), warm(), warm(), warm()];
    await Promise.resolve();
    release();
    await Promise.all(burst);
    expect(fetches).toBe(1);
  });

  it('a caller inside the gap waits for the NEXT call instead of getting none', async () => {
    const { c, now, wait } = clock();
    let fetches = 0;
    const warm = sharedWarmer(async () => void (fetches += 1), { gapMs: 10_000, failGapMs: 120_000, deadlineMs: 30_000, now, wait });
    await warm();
    c.t += 2_000;
    await warm();
    expect(fetches).toBe(2);
    expect(c.waited).toEqual([8_000]);
  });

  it('a failure holds the next call off for the longer gap — no knocking inside a flood', async () => {
    const { c, now, wait } = clock();
    let fetches = 0;
    const warm = sharedWarmer(
      async () => {
        fetches += 1;
        if (fetches === 1) throw new Error('FLOOD_WAIT_300');
      },
      { gapMs: 10_000, failGapMs: 120_000, deadlineMs: 30_000, now, wait },
    );
    await expect(warm()).rejects.toThrow('FLOOD_WAIT_300');
    await warm();
    expect(fetches).toBe(2);
    expect(c.waited).toEqual([120_000]);
  });

  it('a call that never settles is given up at its deadline', async () => {
    const warm = sharedWarmer(() => new Promise(() => {}), { gapMs: 1, failGapMs: 1, deadlineMs: 20 });
    await expect(warm()).rejects.toThrow('warm-up deadline');
  });
});

describe('passedLine — why the AI did not see a line, never who', () => {
  it('each kept-out reason the owner can act on has its own words', () => {
    expect(passedLine({ reason: 'no_phone', phone: null })).toContain('raqami yashirin');
    expect(passedLine({ reason: 'not_a_client', phone: '+998 90 123 45 67' })).toContain('…4567 raqami mijozlar ro‘yxatida yo‘q');
    expect(passedLine({ reason: 'excluded', phone: null })).toContain('«olinmasin»');
    expect(passedLine({ reason: 'unresolved', phone: null })).toContain('aniqlab bermadi');
    // A chat a person's ↩ holds on the tray: where to answer it, in his words.
    expect(passedLine({ reason: 'held', phone: '998901234567' })).toContain('«Qaysi chatlar»da javobingizni kutyapti (↩)');
    expect(passedLine({ reason: 'held', phone: '998901234567' })).not.toMatch(/\d{3}/);
  });

  it('only the stranger the tray already lists is shown by a number — and by four digits', () => {
    for (const reason of ['no_phone', 'excluded', 'unresolved', 'is_bot', 'empty']) {
      const line = passedLine({ reason, phone: '998901234567' })!;
      expect(line).not.toMatch(/\d{3}/);
    }
    const stranger = passedLine({ reason: 'not_a_client', phone: '998901234567' })!;
    expect(stranger).not.toContain('998901234567');
    expect(lastFour('12')).toBe('••12');
    expect(lastFour(null)).toBe('????');
  });

  it('Saved Messages, Telegram itself and real groups print nothing', () => {
    for (const reason of ['self', 'service', 'not_private']) {
      expect(passedLine({ reason, phone: null })).toBeNull();
    }
  });

  it('userIdOf reads a bare PeerUser and nothing else', () => {
    expect(userIdOf({ className: 'PeerUser', userId: 42n })).toBe(42n);
    expect(userIdOf({ className: 'PeerChannel', channelId: 1n })).toBe(0n);
    expect(userIdOf(undefined)).toBe(0n);
  });
});

describe('the listener asks through it (source shape)', () => {
  const src = readFileSync('scripts/tg-listen.ts', 'utf8').replace(/\/\*[\s\S]*?\*\/|\/\/.*$/gm, '');
  const live = src.slice(src.indexOf('client.addEventHandler(async (event: { message?: unknown })'), src.indexOf('new NewMessage({})'));

  it('the live NewMessage handler resolves a private line INSIDE its sender’s queue, through chatOfMessage', () => {
    const queued = live.indexOf('await serialised(bareUser.toString(), async () => {');
    const resolve = live.search(
      /await chatOfMessage\(msg, \{\s*warm: warmDialogs,\s*getEntity: \(p\) => client\.getEntity\(p as never\),\s*deadlineMs: lookupDeadlineMs\(client\.floodSleepThreshold\),\s*\}\)/,
    );
    expect(queued).toBeGreaterThan(-1);
    expect(resolve).toBeGreaterThan(queued);
    expect(live).not.toContain('listenPeer(await msg.getChat?.())');
  });

  it('an unresolved line from Telegram’s own account still reaches the notice check (K33)', () => {
    const unresolved = live.slice(live.indexOf('if (!resolved.unresolved)'));
    expect(unresolved.indexOf('isTelegramServiceNotice(bare, msg.out === true)')).toBeGreaterThan(-1);
    expect(unresolved.indexOf('isTelegramServiceNotice(bare, msg.out === true)')).toBeLessThan(unresolved.indexOf("passedLine({ reason: 'unresolved'"));
  });

  it('every passedLine is behind the agent-account gate — exactly three call sites, all gated', () => {
    // The third: a work number's hidden-number line the door refused under a person's ↩ (the second 2026-10-29 review).
    const sites = [...src.matchAll(/passedLine\(\{/g)].map((m) => m.index!);
    expect(sites).toHaveLength(3);
    for (const at of sites) {
      expect(src.slice(Math.max(0, at - 260), at)).toMatch(/msg\.out !== true && \(await agentHere\(\)\.catch\(\(\) => false\)\)/);
    }
  });

  it('catch-up warms the entity cache through the shared warmer before it walks', () => {
    const catchUp = src.slice(src.indexOf('const catchUp = async'), src.indexOf('const runCatchUp'));
    expect(catchUp.indexOf('await warmDialogs()')).toBeGreaterThan(-1);
    expect(catchUp.indexOf('await warmDialogs()')).toBeLessThan(catchUp.indexOf('client.iterMessages('));
    expect(src).toContain('const warmDialogs = sharedWarmer(() => client.getDialogs({ limit: CATCHUP_WARM_DIALOGS })');
  });
});
