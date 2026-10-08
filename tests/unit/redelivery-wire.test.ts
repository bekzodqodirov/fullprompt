import { describe, expect, it } from 'vitest';
import { PRESS_REPEAT } from '@/modules/platform/telegram/staff-bot';
import { bodyOf, read, srcFiles } from '../fixtures/source-shape';

/**
 * Q5 a's wiring, as SOURCE SHAPE — the rules a grammy shell cannot exercise
 * without a Telegram, DERIVED wherever the code names its own members so the
 * next arm site, door or press kind joins the fence the day it is added.
 * Comments stripped (#725); every needle is asserted found before it is
 * compared (#720: a fence that finds nothing proves nothing).
 */
const SRC = srcFiles();
const T = 'src/modules/platform/telegram';
const BOT = read(`${T}/bot.ts`);
const HANDLERS = read(`${T}/staff-handlers.ts`);
const TASKS = read(`${T}/task-handlers.ts`);
const CABINET = read(`${T}/client-cabinet.ts`);
const STAFF_BOT = read(`${T}/staff-bot.ts`);

const found = (text: string, needle: string, what = needle) => {
  const at = text.indexOf(needle);
  expect(at, `re-anchor: ${what.slice(0, 80)}`).toBeGreaterThan(-1);
  return at;
};

/** The text of a call starting at `open` (its `(`), parens balanced. */
function callAt(text: string, open: number): string {
  let depth = 0;
  for (let i = open; i < text.length; i += 1) {
    if (text[i] === '(') depth += 1;
    else if (text[i] === ')') {
      depth -= 1;
      if (depth === 0) return text.slice(open + 1, i);
    }
  }
  return text.slice(open + 1);
}

/** Top-level arguments of a call's inside. */
function argsOf(inside: string): string[] {
  const out: string[] = [];
  let depth = 0;
  let cur = '';
  for (const ch of inside) {
    if ('([{'.includes(ch)) depth += 1;
    if (')]}'.includes(ch)) depth -= 1;
    if (ch === ',' && depth === 0) {
      out.push(cur.trim());
      cur = '';
    } else cur += ch;
  }
  if (cur.trim()) out.push(cur.trim());
  return out;
}

/** Where the function holding `at` starts — the nearest declaration above it. */
function functionStart(text: string, at: number): number {
  const before = text.slice(0, at);
  const all = [...before.matchAll(/(?:^|\n)\s*(?:export )?(?:async )?function \w+/g)];
  return all.length ? all[all.length - 1]!.index! : 0;
}

describe('(1) a wait is armed only AFTER its prompt is out, at the prompt’s own date', () => {
  it('every arm call in src carries the date of a `const X = await ctx.reply(` before it, in its function', () => {
    let arms = 0;
    for (const f of SRC) {
      for (const m of f.text.matchAll(/\b(noteTaskPending|noteReplyPending|noteStaffEntry|rememberAdVisit)\(/g)) {
        if (/function\s+$/.test(f.text.slice(Math.max(0, m.index! - 12), m.index!))) continue;
        arms += 1;
        const inside = callAt(f.text, m.index! + m[1]!.length);
        const date = /armedAt:\s*(\w+)\.date\b/.exec(inside) ?? /,\s*(\w+)\.date\s*$/.exec(inside);
        expect(date, `${f.path}: ${m[1]}(${inside.slice(0, 60)}…) arms with no prompt date`).not.toBeNull();
        const scope = f.text.slice(functionStart(f.text, m.index!), m.index!);
        expect(scope, `${f.path}: ${date![1]} is not the prompt sent before ${m[1]}`).toContain(
          `const ${date![1]} = await ctx.reply(`,
        );
      }
    }
    expect(arms, 're-anchor: the six arm sites').toBeGreaterThanOrEqual(6);
  });
});

describe('(2) a key exists only once 0130 does', () => {
  it('every `onceKey.` outside once.ts is the body of `readyKey(() => onceKey.`', () => {
    let keys = 0;
    for (const f of SRC) {
      if (f.path.replace(/\\/g, '/').endsWith(`${T}/once.ts`)) continue;
      for (const m of f.text.matchAll(/onceKey\./g)) {
        keys += 1;
        expect(f.text.slice(m.index! - 'readyKey(() => '.length, m.index!), f.path).toBe('readyKey(() => ');
      }
    }
    expect(keys, 're-anchor: no onceKey use outside once.ts').toBeGreaterThan(0);
  });

  it('every call of the four keyed doors passes a key minted through readyKey/messageKey/pressKey', () => {
    const doors: [string, number][] = [
      ['askFromBot', 3],
      ['answerFromBot', 3],
      ['rescheduleTaskFromBot', 3],
      ['sourcesFromBot', 2],
    ];
    let calls = 0;
    for (const f of SRC) {
      for (const [door, index] of doors) {
        for (const m of f.text.matchAll(new RegExp(`\\b${door}\\(`, 'g'))) {
          if (/function\s+$/.test(f.text.slice(Math.max(0, m.index! - 12), m.index!))) continue;
          calls += 1;
          const arg = argsOf(callAt(f.text, m.index! + door.length))[index] ?? '';
          const bound = /^\w+$/.test(arg)
            ? new RegExp(`const ${arg} = (?:[^;]*\\? )?await (?:readyKey|messageKey|pressKey)\\(`).test(f.text)
            : false;
          expect(/(?:readyKey|messageKey|pressKey)\(/.test(arg) || bound, `${f.path}: ${door}(… ${arg})`).toBe(true);
        }
      }
    }
    expect(calls, 're-anchor: the door calls').toBeGreaterThanOrEqual(6);
  });

  it('each door forwards its key into its service', () => {
    expect(bodyOf(STAFF_BOT, 'export async function askFromBot(')).toContain('askAboutTask(taskId, text, ctx, { once');
    expect(bodyOf(STAFF_BOT, 'export async function answerFromBot(')).toContain('answerAboutTask(taskId, text, ctx, { once');
    expect(bodyOf(STAFF_BOT, 'export async function rescheduleTaskFromBot(')).toContain('rescheduleTask(taskId, due, ctx, { once })');
    expect(bodyOf(STAFF_BOT, 'export async function sourcesFromBot(')).toContain('forwardSourcesAgain(taskId, ctx, { once })');
  });
});

describe('(3) the staff tail', () => {
  const tail = bodyOf(HANDLERS, 'async function answerStaffText(');
  it('asks «already answered?» FIRST, and the backlog sentence sits after the notes and before the AI', () => {
    expect(tail.length, 're-anchor: answerStaffText').toBeGreaterThan(0);
    expect(tail.slice(1).trim().startsWith('if (opts.backlog && opts.messageId !== null && (await handledAlready(')).toBe(true);
    const notes = found(tail, 'answerFromNotes(');
    const backlog = found(tail, 'if (opts.backlog) {');
    const ai = found(tail, 'aiConfigured()');
    expect(notes).toBeLessThan(backlog);
    expect(backlog).toBeLessThan(ai);
  });
});

describe('(4) the customer’s message is counted on the clock it was WRITTEN', () => {
  it('all three callers of forwardClientMessage pass `now: new Date(<message>.date * 1000)`', () => {
    const calls = [...CABINET.matchAll(/await forwardClientMessage\(\{/g)];
    expect(calls.length, 're-anchor: the three callers').toBe(3);
    for (const m of calls) {
      const inside = callAt(CABINET, m.index! + 'await forwardClientMessage'.length);
      expect(inside).toMatch(/now: new Date\([\w.]+\.date \* 1000\)/);
    }
  });
});

describe('(5) the lifecycle guard is the first registration of any kind', () => {
  it('registerBotHandlers opens with bot.use(stoppingGuard())', () => {
    const body = bodyOf(BOT, 'export function registerBotHandlers(');
    expect(body.length, 're-anchor: registerBotHandlers').toBeGreaterThan(0);
    const first = /bot\.(?:use|on|command|callbackQuery|hears|filter|chatType)\(|register\w+\(bot\)/.exec(body);
    expect(first?.index, 'nothing registered').toBeDefined();
    expect(body.slice(first!.index)).toMatch(/^bot\.use\(stoppingGuard\(\)\)/);
  });
});

describe('(6) the start', () => {
  const start = bodyOf(BOT, 'export function startTelegramBot(');
  it('boot, retry, handlers, shutdown, durable waits, hydration — in that order', () => {
    const order = [
      'markBoot();',
      'bot.api.config.use(briefRetry);',
      'registerBotHandlers(bot);',
      'installBotShutdown(',
      'setDurableWaits(true);',
      'void hydrateWaits()',
    ].map((needle) => found(start, needle));
    for (let i = 1; i < order.length; i += 1) expect(order[i - 1]!, `step ${i}`).toBeLessThan(order[i]!);
  });

  it('the first getUpdates waits for the restored waits', () => {
    const hydrate = start.slice(found(start, 'void hydrateWaits()'));
    expect(hydrate.slice(0, hydrate.indexOf(';'))).toMatch(/\.finally\(\(\) => startPolling\(/);
  });

  it('nothing restarts the poll after the signal: before .start(, in the retry timer, first in .catch(', () => {
    const polling = start.slice(found(start, 'const startPolling = (retryMs: number) => {'));
    const isStop = found(polling, 'if (isStopping()) return;');
    expect(isStop).toBeLessThan(found(polling, '.start({'));
    const caught = polling.slice(found(polling, '.catch((err: unknown) => {'));
    expect(caught.slice(0, 200).replace(/\s+/g, ' ')).toMatch(/^\.catch\(\(err: unknown\) => \{ (?:\/\/[^\n]*)?if \(isStopping\(\)\) return;/);
    const timer = polling.slice(found(polling, 'setTimeout(() => {'));
    expect(timer.slice(0, 80)).toContain('if (isStopping()) return;');
  });
});

describe('(7) the join decline is said BEFORE the decline, inside Telegram’s five minutes', () => {
  it('JOIN_TELL_WINDOW_S < text: DECLINED < declineChatJoinRequest', () => {
    const join = bodyOf(read(`${T}/price-channel.ts`), 'export async function answerJoinRequest(');
    const window = found(join, 'JOIN_TELL_WINDOW_S');
    const said = found(join, 'text: DECLINED');
    const decline = found(join, "'declineChatJoinRequest'");
    expect(window).toBeLessThan(said);
    expect(said).toBeLessThan(decline);
  });
});

describe('(8) no collector this process opened takes a backlog message', () => {
  const text = HANDLERS.slice(found(HANDLERS, "bot.on('message:text'"), HANDLERS.indexOf('type StaffTailCtx'));
  it('the text ladder declares `late` before the first collector and every collector asks it', () => {
    expect(found(text, 'const late = isBacklog(ctx.message.date);')).toBeLessThan(found(text, 'activeIntake('));
    found(text, 'if (intake && !escapesIntake(ctx.message.text) && !late) {');
    found(text, 'if (capture && !late) {');
    found(text, 'if (draft && !late) {');
  });
  it('the photo/document and voice handlers carry it', () => {
    const photos = HANDLERS.slice(found(HANDLERS, "bot.on(['message:photo', 'message:document']"));
    expect(photos.slice(0, 600)).toContain('const late = isBacklog(ctx.message.date);');
    expect(photos.slice(0, 900)).toContain('if (!state || late) {');
    expect(photos.slice(0, 1400)).toContain('if (!capture || late) {');
    const voice = HANDLERS.slice(found(HANDLERS, "['message:voice', 'message:audio'"));
    expect(voice.slice(0, 500)).toContain('if (!late && (activeIntake(chatId) || activeCapture(chatId))) return next();');
  });
  it('a backlog forward is the sentence before any «📌» offer — in the ladder and in draftMedia', () => {
    const doorB = text.slice(found(text, 'if (ctx.message.forward_origin) {'));
    expect(found(doorB, 'if (late) {\n          await tellBacklogOnce(')).toBeLessThan(found(doorB, 'offerForwardTask('));
    const media = bodyOf(TASKS, 'export async function draftMedia(');
    expect(found(media, 'if (late) {\n      await tellBacklogOnce(')).toBeLessThan(found(media, 'offerForwardTask('));
  });
});

describe('(9) a consumed wait’s DELETE reaches the table before the effect', () => {
  const between = (text: string, take: string, flush: string, effect: string) => {
    const t = found(text, take);
    const f = text.indexOf(flush, t);
    expect(f, `no flush after ${take}`).toBeGreaterThan(t);
    expect(f, `the flush after ${take} comes after ${effect}`).toBeLessThan(found(text, effect));
  };
  it('the text ladder’s wait, the staff contact, the cabinet contact, «✅ Natijasiz»', () => {
    between(HANDLERS, 'takeTaskPending(chatId, ctx.message.date)', 'await flushWaitWrites()', 'answerPendingText(ctx, chatId, pendingTask');
    between(HANDLERS, 'takeTaskPending(chatId, ctx.message.date)', 'await flushWaitWrites()', 'completeTaskFromBot(chatId, pendingTask.taskId');
    between(HANDLERS, 'takeStaffEntry(chatId, ctx.message.date)', 'await flushWaitWrites()', 'linkStaffChat(staff.id, chatId)');
    between(CABINET, 'dropPendingLink(chatId);', 'await flushWaitWrites()', 'completeClientLink(pending.linkId');
    between(TASKS, 'takeTaskPendingFor(chatId, press.taskId)', 'await flushWaitWrites()', "completeTaskFromBot(chatId, press.taskId, ''");
  });
});

describe('(10) every press kind whose repeat is «keyed» carries its key', () => {
  it('the branch of each keyed kind contains `pressKey(ctx, `', () => {
    const keyed = Object.entries(PRESS_REPEAT).filter(([, v]) => v === 'keyed').map(([k]) => k);
    expect(keyed.length, 're-anchor: no keyed press').toBeGreaterThan(0);
    for (const kind of keyed) {
      const branches = [HANDLERS, TASKS].flatMap((text) =>
        [...text.matchAll(new RegExp(`kind === '${kind}'\\) \\{`, 'g'))].map((m) => {
          const rest = text.slice(m.index! + 1);
          const end = rest.indexOf("kind === '");
          return end > -1 ? rest.slice(0, end) : rest;
        }),
      );
      expect(branches.length, `re-anchor: no branch for ${kind}`).toBeGreaterThan(0);
      expect(branches.some((b) => b.includes('pressKey(ctx, ')), `${kind} carries no pressKey`).toBe(true);
    }
  });
});

describe('(11) the two tables have three writers and one readiness probe', () => {
  it('telegram_once / telegram_chat_waits are named only in once.ts, waits.ts, redelivery-ready.ts and the schema', () => {
    const allowed = ['once.ts', 'waits.ts', 'redelivery-ready.ts'].map((f) => `${T}/${f}`).concat('src/modules/platform/db/schema/platform.ts');
    const naming = SRC.filter((f) => /telegram_once|telegram_chat_waits/.test(f.text)).map((f) => f.path.replace(/\\/g, '/'));
    expect(naming.length).toBeGreaterThan(0);
    expect(naming.filter((p) => !allowed.includes(p))).toEqual([]);
    for (const f of ['once.ts', 'waits.ts']) expect(read(`${T}/${f}`), f).toContain("import { redeliveryReady } from './redelivery-ready';");
  });
});
