import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';
import { chatOfMessage, lastFour, passedLine, userIdOf } from '../../src/modules/wms/crm/listen-trace';

/**
 * A stand-in for a gramjs `Message` built from an `UpdateShortMessage`: no
 * chat object, a bare `PeerUser`. `getChat()` behaves as the pinned gramjs
 * does (`tl/custom/chatGetter.js`): with no `_chat` it never calls
 * `getInputChat()` itself, and answers from what `getInputChat()` found if
 * somebody else called it first.
 */
function shortMessage(opts: { inDialogs: boolean; userId?: number }) {
  const user = { className: 'User', id: BigInt(opts.userId ?? 9001), phone: '998901234567' };
  const state: { chat: unknown; walks: number } = { chat: undefined, walks: 0 };
  return {
    state,
    msg: {
      peerId: { className: 'PeerUser', userId: BigInt(opts.userId ?? 9001) },
      getChat: async () => state.chat,
      getInputChat: async () => {
        state.walks += 1;
        if (opts.inDialogs) state.chat = user;
        return opts.inDialogs ? { className: 'InputPeerUser' } : undefined;
      },
    },
    user,
  };
}

describe('chatOfMessage — the live chat of a short update (2026-10-29)', () => {
  it('a cached chat is used as it is, without a dialog walk', async () => {
    const chat = { className: 'User', id: 5n };
    let walks = 0;
    const got = await chatOfMessage({
      peerId: { className: 'PeerUser', userId: 5n },
      getChat: async () => chat,
      getInputChat: async () => {
        walks += 1;
        return undefined;
      },
    });
    expect(got).toEqual({ chat, unresolved: false, via: 'direct' });
    expect(walks).toBe(0);
  });

  it('a bare user peer is found by the dialog walk gramjs short-circuits — the line the old code dropped as «not private»', async () => {
    const { msg, state, user } = shortMessage({ inDialogs: true });
    // The old path: `getChat()` alone answers nothing for this message.
    expect(await msg.getChat()).toBeUndefined();
    const got = await chatOfMessage(msg);
    expect(got.chat).toBe(user);
    expect(got.via).toBe('dialogs');
    expect(got.unresolved).toBe(false);
    expect(state.walks).toBe(1);
  });

  it('the shared warm-up runs before gramjs is asked again, so a warmed cache is read instead of walked', async () => {
    const user = { className: 'User', id: 77n };
    const cache = new Set<bigint>();
    const state: { chat: unknown; walks: number; warms: number } = { chat: undefined, walks: 0, warms: 0 };
    const msg = {
      peerId: { className: 'PeerUser', userId: 77n },
      getChat: async () => state.chat,
      // gramjs: a cached peer sets the chat with no walk; only a miss walks.
      getInputChat: async () => {
        if (cache.has(77n)) state.chat = user;
        else state.walks += 1;
        return undefined;
      },
    };
    const got = await chatOfMessage(msg, {
      warm: async () => {
        state.warms += 1;
        cache.add(77n);
      },
    });
    expect(got.chat).toBe(user);
    expect(state).toMatchObject({ warms: 1, walks: 0 });
  });

  it('when the walk does not find it, Telegram is asked by the peer itself', async () => {
    const { msg } = shortMessage({ inDialogs: false });
    const asked: unknown[] = [];
    const entity = { className: 'User', id: 9001n };
    const got = await chatOfMessage(msg, {
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
        peerId: { className: 'PeerUser', userId: 7n },
        getChat: async () => {
          throw new Error('boom');
        },
        getInputChat: async () => {
          throw new Error('flood');
        },
      },
      {
        warm: async () => {
          throw new Error('FLOOD_WAIT_3');
        },
        getEntity: async () => {
          throw new Error('Could not find the input entity');
        },
      },
    );
    expect(got).toEqual({ chat: undefined, unresolved: true, via: null });
  });

  it('a group or channel without a chat is never walked for — and is not «unresolved»', async () => {
    let walks = 0;
    const got = await chatOfMessage({
      peerId: { className: 'PeerChannel', channelId: 3n },
      getChat: async () => undefined,
      getInputChat: async () => {
        walks += 1;
        return undefined;
      },
    });
    expect(got).toEqual({ chat: undefined, unresolved: false, via: null });
    expect(walks).toBe(0);
  });
});

describe('passedLine — why the AI did not see a line, never a word of it', () => {
  it('each kept-out reason the owner can act on has its own words', () => {
    const peerId = 6778739394n;
    expect(passedLine({ reason: 'no_phone', peerId, phone: null })).toContain('raqami yashirin');
    expect(passedLine({ reason: 'not_a_client', peerId, phone: '+998 90 123 45 67' })).toContain('…4567 raqami mijozlar ro‘yxatida yo‘q');
    expect(passedLine({ reason: 'excluded', peerId, phone: null })).toContain('«olinmasin»');
    expect(passedLine({ reason: 'unresolved', peerId, phone: null })).toContain('aniqlab bermadi');
    for (const reason of ['no_phone', 'not_a_client', 'excluded', 'unresolved', 'is_bot', 'empty']) {
      expect(passedLine({ reason, peerId, phone: '998901234567' })).toContain('#…9394');
    }
  });

  it('Saved Messages, Telegram itself and real groups print nothing', () => {
    for (const reason of ['self', 'service', 'not_private']) {
      expect(passedLine({ reason, peerId: 1n, phone: null })).toBeNull();
    }
  });

  it('the line carries the last four digits only — never the whole number or the whole id', () => {
    const line = passedLine({ reason: 'not_a_client', peerId: 6778739394n, phone: '998901234567' })!;
    expect(line).not.toContain('998901234567');
    expect(line).not.toContain('6778739394');
    expect(lastFour('12')).toBe('••12');
    expect(lastFour(null)).toBe('????');
  });

  it('userIdOf reads a bare PeerUser and nothing else', () => {
    expect(userIdOf({ className: 'PeerUser', userId: 42n })).toBe(42n);
    expect(userIdOf({ className: 'PeerChannel', channelId: 1n })).toBe(0n);
    expect(userIdOf(undefined)).toBe(0n);
  });
});

describe('the listener asks through it (source shape)', () => {
  const src = readFileSync('scripts/tg-listen.ts', 'utf8').replace(/\/\*[\s\S]*?\*\/|\/\/.*$/gm, '');

  it('the live NewMessage handler resolves its chat through chatOfMessage, not a bare getChat()', () => {
    const live = src.slice(src.indexOf('client.addEventHandler(async (event: { message?: unknown })'), src.indexOf('new NewMessage({})'));
    expect(live).toContain('await chatOfMessage(msg, { warm: warmDialogs, getEntity: (p) => client.getEntity(p as never) })');
    expect(live).not.toContain('listenPeer(await msg.getChat?.())');
  });

  it('a passed-over inbound live line is named, on the agent account only', () => {
    expect(src).toMatch(/origin === 'live' && msg\.out !== true && \(await agentHere\(\)\.catch\(\(\) => false\)\)[\s\S]{0,200}passedLine\(/);
  });

  it('catch-up warms the entity cache with one dialogs page before it walks', () => {
    const catchUp = src.slice(src.indexOf('const catchUp = async'), src.indexOf('const runCatchUp'));
    expect(catchUp.indexOf('await warmDialogs()')).toBeGreaterThan(-1);
    expect(catchUp.indexOf('await warmDialogs()')).toBeLessThan(catchUp.indexOf('client.iterMessages('));
    expect(src).toContain('warming ??= client.getDialogs({ limit: CATCHUP_WARM_DIALOGS })');
  });
});
