import { beforeEach, describe, expect, it } from 'vitest';
import { Api, Context } from 'grammy';
import type { Update, UserFromGetMe } from 'grammy/types';
import { __resetPresses, answerPress, isStalePress, pressMiddleware } from '@/modules/platform/telegram/press';

/**
 * A press answered too late (Q5 a): the bot keeps the backlog now, so every
 * press made during a deploy reaches it past Telegram's wait, and the answer
 * is refused. It must never abort the handler — and what the toast would
 * have said is said in the chat, once, unless the handler already spoke.
 *
 * A REAL grammy Context over a real Api whose transformer stands in for
 * Telegram: the refusal arrives as the GrammyError grammy itself builds.
 */
const ME = { id: 7_000_001, is_bot: true, first_name: 'GSR', username: 'gsr_test_bot' } as UserFromGetMe;
const TOO_OLD = 'Bad Request: query is too old and response timeout expired or query ID is invalid';
const ID_INVALID = 'Bad Request: QUERY_ID_INVALID';

type Answer = 'ok' | 'too_old' | 'id_invalid' | 'server';
let seq = 0;

function press(chat: number, message: number, data: string, answer: Answer) {
  const calls: { method: string; payload: Record<string, unknown> }[] = [];
  const api = new Api('7000001:TEST');
  api.config.use(async (_prev, method, payload) => {
    const body = (payload ?? {}) as Record<string, unknown>;
    calls.push({ method, payload: body });
    if (method === 'answerCallbackQuery' && answer !== 'ok') {
      return (
        answer === 'server'
          ? { ok: false, error_code: 500, description: 'Internal Server Error' }
          : { ok: false, error_code: 400, description: answer === 'too_old' ? TOO_OLD : ID_INVALID }
      ) as never;
    }
    if (method === 'sendMessage') {
      return { ok: true, result: { message_id: 1, date: 0, chat: { id: chat, type: 'private' } } } as never;
    }
    return { ok: true, result: true } as never;
  });
  const update = {
    update_id: (seq += 1),
    callback_query: {
      id: `q${seq}`,
      from: { id: chat, is_bot: false, first_name: 'T' },
      chat_instance: 'ci',
      data,
      message: { message_id: message, date: 0, chat: { id: chat, type: 'private' }, text: 'x' },
    },
  } as unknown as Update;
  return { ctx: new Context(update, api, ME), calls };
}

const answers = (calls: { method: string; payload: Record<string, unknown> }[]) =>
  calls.filter((c) => c.method === 'answerCallbackQuery');
const said = (calls: { method: string; payload: Record<string, unknown> }[]) =>
  calls.filter((c) => c.method === 'sendMessage').map((c) => c.payload.text);

beforeEach(() => __resetPresses());

describe('answerPress', () => {
  it('answers, and never throws on a late press — in both of Telegram’s spellings', async () => {
    expect(await answerPress(press(1, 1, 'x', 'ok').ctx)).toBe('answered');
    expect(await answerPress(press(1, 1, 'x', 'too_old').ctx, 'Allaqachon')).toBe('stale');
    expect(await answerPress(press(1, 1, 'x', 'id_invalid').ctx, 'Allaqachon')).toBe('stale');
    expect(await answerPress(press(1, 1, 'x', 'server').ctx)).toBe('failed');
  });

  it('isStalePress reads a plain object as well as a GrammyError', () => {
    expect(isStalePress({ error_code: 400, description: TOO_OLD })).toBe(true);
    expect(isStalePress({ error_code: 400, description: ID_INVALID })).toBe(true);
    expect(isStalePress({ error_code: 400, description: 'Bad Request: message is not modified' })).toBe(false);
    expect(isStalePress({ error_code: 429, description: TOO_OLD })).toBe(false);
    expect(isStalePress(null)).toBe(false);
  });

  it('cuts a long toast by CODE POINTS — never a halved emoji', async () => {
    const { ctx, calls } = press(1, 1, 'x', 'ok');
    await answerPress(ctx, '📦'.repeat(210));
    const text = String(answers(calls)[0]!.payload.text);
    expect(Array.from(text)).toHaveLength(200);
    expect(/[\uD800-\uDBFF](?![\uDC00-\uDFFF])|(?<![\uD800-\uDBFF])[\uDC00-\uDFFF]/.test(text)).toBe(false);
  });
});

describe('pressMiddleware', () => {
  const run = (ctx: Context, handler: (ctx: Context) => Promise<unknown>) =>
    pressMiddleware()(ctx, async () => {
      await handler(ctx);
    });

  it('says a refused toast in the chat when the handler said nothing there', async () => {
    const { ctx, calls } = press(11, 100, 'tk:a', 'too_old');
    await run(ctx, (c) => answerPress(c, 'Allaqachon hal qilingan'));
    expect(said(calls)).toEqual(['Allaqachon hal qilingan']);
  });

  it('does not double a handler that already replied in the same chat', async () => {
    const { ctx, calls } = press(12, 100, 'tk:a', 'too_old');
    await run(ctx, async (c) => {
      await answerPress(c, 'Bu vazifa yopilgan');
      await c.reply('Bu vazifa yopilgan.');
    });
    expect(said(calls)).toEqual(['Bu vazifa yopilgan.']);
  });

  it('never says a progress notice (`say: false`), an answered toast, or a handler that threw', async () => {
    const progress = press(13, 100, 'n:x', 'too_old');
    await run(progress.ctx, (c) => answerPress(c, '📤 Yuborilmoqda…', { say: false }));
    expect(said(progress.calls)).toEqual([]);

    const answered = press(14, 100, 'tk:a', 'ok');
    await run(answered.ctx, (c) => answerPress(c, '👀 Qabul qilindi'));
    expect(said(answered.calls)).toEqual([]);

    const threw = press(15, 100, 'tk:a', 'too_old');
    await expect(
      run(threw.ctx, async (c) => {
        await answerPress(c, 'Allaqachon');
        throw new Error('boom');
      }),
    ).rejects.toThrow('boom');
    expect(said(threw.calls)).toEqual([]);
  });

  it('a repeat of a LATE press on the same message is answered once and not run', async () => {
    let ran = 0;
    const first = press(16, 200, 'mg', 'too_old');
    await run(first.ctx, async (c) => {
      ran += 1;
      await answerPress(c);
    });
    const second = press(16, 200, 'mg', 'ok');
    await run(second.ctx, async () => {
      ran += 1;
    });
    expect(ran).toBe(1);
    expect(answers(second.calls)).toHaveLength(1);
    expect(answers(second.calls)[0]!.payload.text).toBeUndefined();
  });

  it('a repeat of an ANSWERED press runs again — a live toggle is a real second intent', async () => {
    let ran = 0;
    for (let i = 0; i < 2; i += 1) {
      const { ctx } = press(17, 300, 'c:cert', 'ok');
      await run(ctx, async (c) => {
        ran += 1;
        await answerPress(c);
      });
    }
    expect(ran).toBe(2);
  });

  it('two different buttons on one message, both late with one toast: said once', async () => {
    const a = press(18, 400, 'tp:e:x', 'too_old');
    await run(a.ctx, (c) => answerPress(c, 'Bu allaqachon bajarilgan'));
    const b = press(18, 400, 'tp:w:x', 'too_old');
    await run(b.ctx, (c) => answerPress(c, 'Bu allaqachon bajarilgan'));
    expect([...said(a.calls), ...said(b.calls)]).toEqual(['Bu allaqachon bajarilgan']);
  });
});
