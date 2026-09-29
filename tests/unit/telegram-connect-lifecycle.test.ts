import { afterEach, beforeAll, describe, expect, it, vi } from 'vitest';

/**
 * The connect module's gramjs glue with gramjs replaced — what happens to the
 * CLIENTS. A client is a live connection to Telegram with an update loop of
 * its own, and one that nobody closes lives until the app restarts; the
 * decisions themselves are proved in telegram-connect.test.ts.
 */

interface Behaviour {
  connect?: () => Promise<boolean>;
  sendCode?: () => Promise<unknown>;
  invoke?: (request: unknown) => Promise<unknown>;
}

const h = vi.hoisted(() => {
  const made: Array<{
    behaviour: Behaviour;
    destroyed: boolean;
    invoked: unknown[];
  }> = [];
  const state: { next: Behaviour } = { next: {} };
  class FakeClient {
    behaviour: Behaviour = state.next;
    destroyed = false;
    invoked: unknown[] = [];
    session = { save: () => 'session' };
    constructor() {
      made.push(this);
    }
    connect() {
      return this.behaviour.connect?.() ?? Promise.resolve(true);
    }
    sendCode() {
      return this.behaviour.sendCode?.() ?? Promise.resolve({ phoneCodeHash: 'hash' });
    }
    invoke(request: unknown) {
      this.invoked.push(request);
      return this.behaviour.invoke?.(request) ?? Promise.resolve({ className: 'auth.Authorization' });
    }
    async disconnect() {}
    async destroy() {
      this.destroyed = true;
    }
  }
  class LogOut {}
  return { made, state, FakeClient, LogOut };
});

vi.mock('telegram', () => ({
  TelegramClient: h.FakeClient,
  Api: {
    auth: {
      SignIn: class {
        constructor(readonly args: unknown) {}
      },
      LogOut: h.LogOut,
    },
    account: { GetPassword: class {} },
  },
}));
vi.mock('telegram/sessions', () => ({ StringSession: class {} }));
vi.mock('@/modules/wms/crm/telegram-session', () => ({ sessionKey: () => Buffer.alloc(32) }));
vi.mock('@/modules/wms/crm/telegram-accounts', () => ({
  phoneHolder: vi.fn(async () => null),
  saveAccount: vi.fn(async () => {}),
}));

const PHONE = '+998901234567';

beforeAll(() => {
  process.env.TELEGRAM_API_ID = '1';
  process.env.TELEGRAM_API_HASH = 'hash';
});
// A test that fails before its own reset line must not hand its broken
// Telegram to every test after it.
afterEach(() => {
  h.state.next = {};
});

async function connect() {
  return import('@/modules/wms/crm/telegram-connect');
}
async function accounts() {
  const m = await import('@/modules/wms/crm/telegram-accounts');
  return { phoneHolder: vi.mocked(m.phoneHolder), saveAccount: vi.mocked(m.saveAccount) };
}

describe('a begin that fails closes the client it opened', () => {
  it('when Telegram refuses to send the code', async () => {
    const { beginTgLogin } = await connect();
    h.state.next = { sendCode: () => Promise.reject(new Error('400: PHONE_NUMBER_INVALID')) };
    expect(await beginTgLogin('u-refused', PHONE)).toEqual({
      ok: false,
      error: 'phone_invalid',
      next: 'phone',
    });
    expect(h.made.at(-1)?.destroyed).toBe(true);
  });

  it('when the connection never opens', async () => {
    const { beginTgLogin } = await connect();
    h.state.next = { connect: () => Promise.resolve(false) };
    expect(await beginTgLogin('u-offline', PHONE)).toMatchObject({ ok: false, error: 'failed' });
    expect(h.made.at(-1)?.destroyed).toBe(true);
  });
});

describe('two tabs of one person', () => {
  it('a press that ends in one tab leaves the login the other tab just started', async () => {
    const { beginTgLogin, completeTgLogin } = await connect();
    await beginTgLogin('u-tabs', PHONE);
    const first = h.made.at(-1)!;
    let fail: ((err: Error) => void) | undefined;
    first.behaviour = {
      invoke: () =>
        new Promise((_resolve, reject) => {
          fail = reject;
        }),
    };
    const pressInTabA = completeTgLogin('u-tabs', '12345');
    await vi.waitFor(() => expect(fail).toBeDefined());

    await beginTgLogin('u-tabs', PHONE); // tab B asks for a new code
    const second = h.made.at(-1)!;
    fail!(new Error('socket closed'));

    expect(await pressInTabA).toMatchObject({ ok: false, error: 'failed', next: 'phone' });
    // The first version dropped «whatever was under the user»: tab B's
    // fresh login, with its code already on the phone.
    expect(second.destroyed).toBe(false);
    expect(await completeTgLogin('u-tabs', '12345')).toEqual({ ok: true, step: 'connected' });
    expect(second.destroyed).toBe(true); // handed to the listener, closed here
  });
});

describe('a login nobody came back to', () => {
  it('is closed by the next begin once its code has expired', async () => {
    const { beginTgLogin, completeTgLogin, PENDING_TTL_MS } = await connect();
    await beginTgLogin('u-gone', PHONE);
    const abandoned = h.made.at(-1)!;
    const later = Date.now() + PENDING_TTL_MS + 1000;
    const clock = vi.spyOn(Date, 'now').mockReturnValue(later);
    try {
      await beginTgLogin('u-somebody-else', PHONE);
      await vi.waitFor(() => expect(abandoned.destroyed).toBe(true));
      expect(await completeTgLogin('u-gone', '12345')).toMatchObject({ error: 'expired' });
    } finally {
      clock.mockRestore();
    }
  });
});

describe('the database, around the Telegram calls', () => {
  it('a failure before the code is sent is a sentence, not the error page', async () => {
    const { beginTgLogin } = await connect();
    const { phoneHolder } = await accounts();
    phoneHolder.mockRejectedValueOnce(new Error('connection terminated'));
    const made = h.made.length;
    expect(await beginTgLogin('u-db', PHONE)).toEqual({ ok: false, error: 'failed', next: 'phone' });
    expect(h.made.length).toBe(made); // and Telegram was never asked
  });

  it('a number taken while the code was typed: the new session is logged out and the holder named', async () => {
    const { beginTgLogin, completeTgLogin } = await connect();
    const { phoneHolder, saveAccount } = await accounts();
    await beginTgLogin('u-race', PHONE);
    const client = h.made.at(-1)!;
    saveAccount.mockRejectedValueOnce(Object.assign(new Error('duplicate key'), { code: '23505' }));
    phoneHolder.mockResolvedValueOnce({ name: 'Ali' });
    expect(await completeTgLogin('u-race', '12345')).toEqual({
      ok: false,
      error: 'phone_taken',
      next: 'phone',
      holder: 'Ali',
    });
    expect(client.invoked.some((r) => r instanceof h.LogOut)).toBe(true);
    expect(client.destroyed).toBe(true);
  });

  it('…and without a holder to name, it is «try again», never a sentence about nobody', async () => {
    const { beginTgLogin, completeTgLogin } = await connect();
    const { phoneHolder, saveAccount } = await accounts();
    await beginTgLogin('u-race-gone', PHONE);
    saveAccount.mockRejectedValueOnce(Object.assign(new Error('duplicate key'), { code: '23505' }));
    phoneHolder.mockResolvedValueOnce(null);
    expect(await completeTgLogin('u-race-gone', '12345')).toEqual({
      ok: false,
      error: 'failed',
      next: 'phone',
    });
  });
});
