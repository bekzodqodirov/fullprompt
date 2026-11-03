import { Api } from 'telegram';
import { invoke } from 'telegram/client/users';
import { RPCMessageToError } from 'telegram/errors';
import { LogLevel } from 'telegram/extensions/Logger';
import { describe, expect, it } from 'vitest';
import { FloodRecordingLogger } from '@/modules/wms/crm/telegram-logger';

/**
 * gramjs's own flood sleeps become rows (review ban-2's DEVIATION: the 60 s
 * floodSleepThreshold stays, the line it logs is the signal).
 *
 * The line is never typed by hand here: it is produced by gramjs's REAL
 * `invoke` — the function that sleeps — against a sender that answers with a
 * FLOOD_WAIT built by gramjs itself (`RPCMessageToError`, the house rule from
 * telegram-connect.test.ts). A gramjs upgrade that rewords the line turns
 * this red instead of quietly switching the ledger off.
 */

const seen: { seconds: number; method: string }[] = [];

/** A client shaped like the parts of TelegramClient that `invoke` touches, with no network. */
function fakeClient(logger: FloodRecordingLogger, floodSeconds: number) {
  return {
    _sender: {
      userDisconnected: false,
      addStateToQueue(state: { reject: (e: unknown) => void; request: Api.AnyRequest }) {
        state.reject(
          RPCMessageToError(
            new Api.RpcError({ errorCode: 420, errorMessage: `FLOOD_WAIT_${floodSeconds}` }),
            state.request,
          ),
        );
      },
    },
    _connectedDeferred: { promise: Promise.resolve() },
    // One attempt: gramjs sleeps through the wait, then gives up — the sleep
    // (and its line) is what this test is about.
    _requestRetries: 1,
    floodSleepThreshold: 60,
    _log: logger,
    session: { processEntities() {} },
    _entityCache: { add() {} },
  };
}

describe('FloodRecordingLogger', () => {
  it('records the sleep gramjs logs inside invoke, method and seconds', async () => {
    seen.length = 0;
    const logger = new FloodRecordingLogger((s) => seen.push(s));
    // 0 s so the real sleep inside invoke costs nothing.
    await expect(invoke(fakeClient(logger, 0) as never, new Api.help.GetConfig())).rejects.toThrow();
    expect(seen).toEqual([{ seconds: 0, method: 'help.GetConfig' }]);
  });

  it('sees the line even when the log level would drop it', async () => {
    seen.length = 0;
    const logger = new FloodRecordingLogger((s) => seen.push(s), LogLevel.NONE);
    await expect(invoke(fakeClient(logger, 0) as never, new Api.help.GetConfig())).rejects.toThrow();
    expect(seen).toHaveLength(1);
  });

  it('names the send method the way the flood ledger counts it', () => {
    // `sendFloodsSince` counts 'messages.SendMessage' — the className gramjs
    // puts after «Caused by» for the request the pumps send.
    expect(new Api.messages.SendMessage({ peer: 'me', message: 'x' }).className).toBe('messages.SendMessage');
    expect(new Api.messages.SendMedia({ peer: 'me', media: new Api.InputMediaEmpty(), message: '' }).className).toBe(
      'messages.SendMedia',
    );
  });

  it('ignores every other line, and a throwing callback never breaks the log', () => {
    let calls = 0;
    const logger = new FloodRecordingLogger(() => {
      calls += 1;
      throw new Error('ledger down');
    }, LogLevel.NONE);
    logger.info('Running gramJS version 2.26.22');
    expect(calls).toBe(0);
    expect(() => logger.info('Sleeping for 7s on flood wait (Caused by messages.SendMessage)')).not.toThrow();
    expect(calls).toBe(1);
  });
});
