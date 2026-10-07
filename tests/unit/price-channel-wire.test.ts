import { readdirSync, readFileSync, statSync } from 'node:fs';
import { join, relative, resolve } from 'node:path';
import { describe, expect, it } from 'vitest';

/**
 * The price channel's WIRING (his F, 2026-10-07) — source-shape on purpose:
 * each of these hooks WORKS wherever it sits, and what makes it right is its
 * POSITION (the seal's claim before an uncaught audit, the answer's before the
 * label read, the bot's channel handlers before /start) or its single home
 * (the eligibility fragment, the one writer of `connected_at`). Comments are
 * stripped first (#725: a sentence explaining the rule is not the rule).
 */
const ROOT = resolve(__dirname, '../..');
const strip = (s: string) => s.replace(/\/\*[\s\S]*?\*\//g, '').replace(/(^|[^:])\/\/.*$/gm, '$1');
const read = (rel: string) => strip(readFileSync(join(ROOT, rel), 'utf8'));

/** One top-level function's body: from its declaration to the next top-level declaration. */
function body(src: string, head: string): string {
  const start = src.indexOf(head);
  expect(start, `${head} not found`).toBeGreaterThan(-1);
  const rest = src.slice(start + head.length);
  const next = rest.search(/\n(export |async function |function |const |let |type |interface )/);
  return head + (next === -1 ? rest : rest.slice(0, next));
}

describe('the price hooks', () => {
  const workspace = read('src/modules/wms/calc/workspace.ts');
  const service = read('src/modules/wms/calc/service.ts');

  it('sealCalc claims the row FIRST after the commit, in its own catch, with the version id returned', () => {
    const seal = body(workspace, 'export async function sealCalc(');
    expect(seal).toContain('.returning({ id: calcVersions.id })');
    const txStart = seal.indexOf('const result = await db.transaction(');
    const queue = seal.indexOf('queuePriceChannelPost(');
    const retire = seal.indexOf('retireTaskCopiesSoon({ taskIds: [result.taskId]');
    const audit = seal.indexOf('writeAudit(', txStart);
    expect(txStart).toBeGreaterThan(-1);
    expect(queue).toBeGreaterThan(txStart);
    expect(queue).toBeLessThan(retire);
    expect(queue).toBeLessThan(audit);
    expect(seal.slice(queue, retire)).toContain('.catch(');
  });

  it('finishCalcRequest claims the answer right after the job closed, before the label read', () => {
    const finish = body(service, 'export async function finishCalcRequest(');
    const closed = finish.indexOf("'already_closed'", finish.indexOf('await endRequest('));
    const queue = finish.indexOf("queuePriceChannelPost({ kind: 'answer'");
    const label = finish.indexOf('requestLabel(');
    expect(queue).toBeGreaterThan(closed);
    expect(queue).toBeLessThan(label);
  });

  it('the shared ending and the recalc both kick the drain', () => {
    expect(body(service, 'async function endRequest(')).toContain('kickPriceChannel()');
    expect(body(workspace, 'export async function recalcFromSealed(')).toContain('kickPriceChannel()');
  });

  it('a deactivation kicks the member sweep, after the transaction', () => {
    const toggle = body(read('src/modules/platform/users/service.ts'), 'export async function toggleUserActive(');
    // After the transaction's END, not its start: a kick inside the callback
    // lets the sweep race the uncommitted deactivation. No line inside the
    // callback closes with «});», so the first one after the opening is its close.
    const txStart = toggle.indexOf('db.transaction(');
    const txEnd = toggle.indexOf('});', txStart);
    expect(txStart).toBeGreaterThan(-1);
    expect(txEnd).toBeGreaterThan(txStart);
    expect(toggle.indexOf('kickPriceChannelMembers()')).toBeGreaterThan(txEnd);
  });
});

describe('the drain', () => {
  const send = read('src/modules/wms/calc/channel-send.ts');

  it('casts the net before its first claim', () => {
    const drain = body(send, 'export async function drainPriceChannel(');
    expect(drain.indexOf('queueMissedPrices(')).toBeGreaterThan(-1);
    expect(drain.indexOf('queueMissedPrices(')).toBeLessThan(drain.indexOf('claimNext('));
  });

  it('protects every send and has ONE path (the album), never sendPhoto directly', () => {
    const sends = (send.match(/\bsendText\(|\bsendAlbum\(/g) ?? []).length;
    const protectedCount = (send.match(/protectContent: true/g) ?? []).length;
    expect(sends).toBeGreaterThan(0);
    expect(protectedCount).toBeGreaterThanOrEqual(sends);
    expect(send).not.toMatch(/\bsendPhoto\(/);
  });
});

describe('the bot', () => {
  const bot = read('src/modules/platform/telegram/bot.ts');
  const handlers = read('src/modules/platform/telegram/price-channel-handlers.ts');

  it('registers the channel handlers before /start (and so before the staff bot)', () => {
    const reg = bot.indexOf('registerPriceChannel(bot)');
    expect(reg).toBeGreaterThan(-1);
    expect(reg).toBeLessThan(bot.indexOf("bot.command('start'"));
    expect(reg).toBeLessThan(bot.indexOf('registerStaffBot(bot)'));
  });

  it('asks Telegram for chat_member and keeps dropping pending updates', () => {
    expect(bot).toContain("allowed_updates: [...API_CONSTANTS.DEFAULT_UPDATE_TYPES, 'chat_member']");
    expect(bot).toContain('drop_pending_updates: true');
  });

  it('listens for the four updates, and the channel post handler swallows', () => {
    for (const u of ["'channel_post'", "'my_chat_member'", "'chat_join_request'", "'chat_member'"]) {
      expect(handlers).toContain(u);
    }
    const swallow = handlers.slice(handlers.indexOf("bot.on(['channel_post'"), handlers.indexOf("bot.on('my_chat_member'"));
    expect(swallow).not.toContain('next(');
  });
});

describe('membership has ONE rule', () => {
  const pc = read('src/modules/platform/telegram/price-channel.ts');

  it('the admission and the sweep both read channelEligibleSql', () => {
    expect(body(pc, 'export async function eligibleForChannel(')).toContain('channelEligibleSql(');
    expect(body(pc, 'export async function sweepPriceChannelMembers(')).toContain('channelEligibleSql(');
  });

  it('never restates the staff link and never reads .active', () => {
    expect(pc).not.toContain('staffForChat(');
    expect(pc).not.toMatch(/\.active\b/);
    expect(pc).toContain('canLogInSql(');
  });
});

describe('the earlier calculation (F10 a)', () => {
  it('opens in a NEW tab — the items table’s drafts survive', () => {
    const lq = readFileSync(join(ROOT, 'src/app/(protected)/hisoblash/[id]/last-quotes.tsx'), 'utf8');
    const open = lq.slice(lq.lastIndexOf('<a', lq.indexOf('data-testid="last-quote-open"')), lq.indexOf('data-testid="last-quote-open"'));
    expect(open).toContain('href={`/hisoblash/${q.requestId}`}');
    expect(open).toContain('target="_blank"');
  });
});

describe('one writer of connected_at', () => {
  it('nothing under src writes it but price-channel.ts', () => {
    const offenders: string[] = [];
    const walk = (dir: string) => {
      for (const name of readdirSync(dir)) {
        const path = join(dir, name);
        if (statSync(path).isDirectory()) walk(path);
        else if (/\.(ts|tsx)$/.test(name)) {
          const rel = relative(ROOT, path);
          if (rel === 'src/modules/platform/telegram/price-channel.ts') continue;
          if (rel.startsWith('src/modules/platform/db/schema/')) continue;
          const src = strip(readFileSync(path, 'utf8'));
          if (/connectedAt\s*:/.test(src) || /connected_at\s*=/.test(src)) offenders.push(rel);
        }
      }
    };
    walk(join(ROOT, 'src'));
    expect(offenders).toEqual([]);
    expect(read('src/modules/platform/telegram/price-channel.ts')).toMatch(/connectedAt: new Date\(\)/);
  });
});
