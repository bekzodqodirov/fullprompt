import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';
import { groupsFromList, isTelegramMuted, JOINED_LATER, listFromGroups, MUTE_GROUPS } from '@/modules/platform/notifications/mutes';
import { renderTelegramText } from '@/modules/platform/notifications/service';
import { notificationLabels, approvalVerdictLine } from '@/modules/platform/notifications/labels';
import {
  buttonsFor,
  DAY_BUTTONS,
  dayButtons,
  parseCallback,
} from '@/modules/platform/telegram/staff-bot';
import { telegramDue } from '@/modules/platform/tasks/service';
import { dailyDigestText, DIGEST_UNCLAIMED_SHOWN } from '@/modules/platform/jobs/digest';

/**
 * The staff side of round C, where it is pure: mutes that must not un-mute,
 * the day list's buttons, the Telegram date, the capped texts. Comments are
 * stripped from the sources the fences read (#725).
 */
const read = (p: string) =>
  readFileSync(p, 'utf8')
    .replace(/\/\*[\s\S]*?\*\//g, '')
    .replace(/^\s*\/\/.*$/gm, '');

const uuid = (n: number) => `00000000-0000-4000-8000-${String(n).padStart(12, '0')}`;

describe('a mute group that GROWS does not un-mute anybody (STAFF-11)', () => {
  // Somebody who ticked «tasks» before CalcSealed joined the group has every
  // OTHER member in their stored list, and not CalcSealed itself.
  const before = MUTE_GROUPS.tasks.filter((t) => t !== 'CalcSealed');

  it('the newcomer counts as muted for them', () => {
    expect(before).not.toContain('CalcSealed');
    expect(isTelegramMuted(before, 'CalcSealed')).toBe(true);
    // …and the checkbox reads back ticked, so the next save writes it in.
    expect(groupsFromList(before).groups.tasks).toBe(true);
  });

  it('but only when EVERY other member is there — a partial list is not a tick', () => {
    const partial = before.slice(1);
    expect(isTelegramMuted(partial, 'CalcSealed')).toBe(false);
  });

  it('a group of one is muted only by name (no «every other member» to judge by)', () => {
    expect(MUTE_GROUPS.calls).toHaveLength(1);
    expect(isTelegramMuted([], 'CrmFollowUps')).toBe(false);
    expect(isTelegramMuted(['DailyDigest'], 'CrmFollowUps')).toBe(false);
  });

  it('SEVERAL newcomers at once — the alerts group grew by three (STAFF-MUTE-MULTI)', () => {
    // The footprint a pre-round-C «alerts» tick left: every founding member.
    const alertsBefore = MUTE_GROUPS.alerts.filter((t) => !JOINED_LATER.has(t));
    const newcomers = MUTE_GROUPS.alerts.filter((t) => JOINED_LATER.has(t));
    expect(newcomers.length, 're-anchor: the alerts newcomers moved').toBeGreaterThan(1);
    for (const type of newcomers) expect(isTelegramMuted(alertsBefore, type), type).toBe(true);
    // The box reads back ticked, so the next save of ANY other box keeps the
    // alarms quiet instead of writing them all out of the list.
    const read = groupsFromList(alertsBefore);
    expect(read.groups.alerts).toBe(true);
    const saved = listFromGroups(read.all, read.groups);
    for (const type of MUTE_GROUPS.alerts) expect(isTelegramMuted(saved, type), type).toBe(true);
  });

  it('never mutes a type in no group, and nothing for somebody who muted nothing', () => {
    expect(isTelegramMuted(MUTE_GROUPS.alerts, 'TotallyNewType')).toBe(false);
    expect(isTelegramMuted([], 'CalcSealed')).toBe(false);
  });
});

describe('the day list closes tasks from its own buttons', () => {
  it('tb: parses to the same task_done, marked as a list press', () => {
    expect(parseCallback(`tb:${uuid(1)}`)).toEqual({ kind: 'task_done', taskId: uuid(1), list: true });
    // The single task's own button stays byte-identical (a pinned shape).
    expect(parseCallback(`t:${uuid(1)}`)).toEqual({ kind: 'task_done', taskId: uuid(1) });
    expect(Buffer.byteLength(`tb:${uuid(1)}`)).toBeLessThanOrEqual(64);
  });

  it('refuses junk and the CUSTOMER cabinet\'s own callbacks (contract 1: «mg» is the cabinet\'s)', () => {
    for (const data of ['tb:', 'tb:short', 'mg', 'mg:1', `tbx:${uuid(1)}`]) {
      expect(parseCallback(data), data).toBeNull();
    }
  });

  it('one «✅ <title>» per task, at most eight, never an unparseable id', () => {
    const tasks = Array.from({ length: 12 }, (_, i) => ({ id: uuid(i), title: `Vazifa ${i}` }));
    const rows = dayButtons([{ id: 'not-a-uuid', title: 'x' }, ...tasks])!;
    expect(rows).toHaveLength(DAY_BUTTONS);
    expect(rows[0]).toEqual([{ text: '✅ Vazifa 0', callback_data: `tb:${uuid(0)}` }]);
    for (const row of rows) expect(parseCallback(row[0]!.callback_data)).not.toBeNull();
    expect(dayButtons([])).toBeNull();
  });

  it('a long title is cut to what a button holds', () => {
    const button = dayButtons([{ id: uuid(1), title: 'x'.repeat(200) }])![0]![0];
    expect(button!.text.length).toBeLessThanOrEqual(42);
  });

  it('the 08:00 digest carries the same rows as the «📋 Bugun» reply', () => {
    const tasks = [{ id: uuid(1), title: 'A' }, { id: uuid(2), title: 'B' }];
    expect(buttonsFor('TasksDue', { text: 'x', tasks })).toEqual(dayButtons(tasks));
    // A digest from before round C (no tasks) sends as it always did.
    expect(buttonsFor('TasksDue', { text: 'x' })).toBeNull();
  });

  it('DERIVED: every tb: button the sources build is one the parser accepts', () => {
    const sources = [
      read('src/modules/platform/telegram/staff-bot.ts'),
      read('src/modules/platform/telegram/staff-handlers.ts'),
    ].join('\n');
    const literals = [...sources.matchAll(/callback_data:\s*`(tb:[^`]*)`/g)].map((m) => m[1]!);
    expect(literals.length, 'no tb: buttons found — re-anchor this fence').toBeGreaterThanOrEqual(1);
    for (const raw of literals) {
      const data = raw.replace(/\$\{[^}]+\}/g, uuid(7));
      expect(parseCallback(data), data).not.toBeNull();
    }
  });
});

describe('a deadline in a Telegram message', () => {
  const now = new Date('2026-09-27T06:00:00Z');

  it('an all-day task is its own UTC day, never shifted into the next one', () => {
    // parseDue stores «2026-09-30» as 23:59:59.999Z; +5 h would print the 1st.
    expect(telegramDue(new Date('2026-09-30T23:59:59.999Z'), true, now)).toBe('30.09');
  });

  it('a timed task prints on the Tashkent clock — 02:00 there is the previous UTC day', () => {
    // 21:00Z on the 29th is 02:00 on the 30th in Tashkent.
    expect(telegramDue(new Date('2026-09-29T21:00:00Z'), false, now)).toBe('30.09 02:00');
  });

  it('the year only when it is not this year', () => {
    expect(telegramDue(new Date('2027-01-01T23:59:59.999Z'), true, now)).toBe('01.01.2027');
  });
});

describe('the daily svodka', () => {
  const now = new Date('2026-09-27T04:00:00Z');
  const unclaimed = Array.from({ length: 27 }, (_, i) => ({
    whCode: 'YW',
    number: `R-${i}`,
    marking: i === 0 ? 'GS500' : null,
    receivedAt: new Date('2026-09-10T00:00:00Z'),
    boxCount: 3,
  }));

  it('speaks Uzbek like every other staff message, and says how many it did not list', () => {
    const text = dailyDigestText({
      now,
      agingDays: 7,
      staleDays: 30,
      unclaimed,
      stale: [{ whCode: 'TAS1', boxCount: 12, oldestAt: '2026-08-01T00:00:00Z' }],
    });
    expect(text).toContain('📊 GSR — kunlik hisobot');
    expect(text).toContain('❓ Egasiz yuk (7 kundan eski):');
    expect(text).toContain('• YW R-0 [GS500] — 3 kor., 17 kun');
    expect(text).toContain(`… yana ${27 - DIGEST_UNCLAIMED_SHOWN} ta`);
    expect(text).toContain('• TAS1: 12 kor., eng eskisi — 57 kun');
    expect(text.split('\n').filter((l) => l.startsWith('• YW'))).toHaveLength(DIGEST_UNCLAIMED_SHOWN);
    expect(text, 'no Russian left').not.toMatch(/[А-Яа-яЁё]/);
  });
});

describe('the staff texts that could outgrow a message', () => {
  const codes = Array.from({ length: 45 }, (_, i) => `YW26-${String(i).padStart(6, '0')}`);

  it('a list of box codes stops at thirty and COUNTS the rest, in the reader\'s words', () => {
    for (const type of ['BoxScannedOnLoad', 'UndocumentedTransfer', 'MissingInTransit']) {
      const text = renderTelegramText(type, { batchCode: 'KA-1', batchId: 'b', shortCodes: codes }, 'uz');
      expect(text, type).toContain(codes[29]);
      expect(text, type).not.toContain(codes[30]);
      expect(text, type).toContain('… yana 15 ta');
    }
    const ru = renderTelegramText('MissingInTransit', { batchCode: 'KA-1', batchId: 'b', shortCodes: codes }, 'ru');
    expect(ru).toContain('… и ещё 15');
  });

  it('a stocktake\'s moved and lost lists are capped the same way', () => {
    const text = renderTelegramText(
      'InventoryCompleted',
      { warehouseCode: 'TAS1', scanned: 100, moved: codes, lost: codes.slice(0, 3) },
      'uz',
    );
    expect(text).toContain('… yana 15 ta');
    expect(text).toContain(codes[2]);
  });

  it('a short list reads exactly as before', () => {
    const text = renderTelegramText('MissingInTransit', { batchCode: 'KA-1', batchId: 'b', shortCodes: ['A', 'B'] }, 'uz');
    expect(text).toContain(': A, B\n');
  });

  it('a handover\'s kilos and cubes are in the reader\'s language', () => {
    const text = renderTelegramText(
      'BoxIssued',
      { clientCode: 'GS1', clientName: 'X', boxCount: 2, weightKg: 21, volumeM3: 0.23, warehouseCode: 'TAS1', personName: 'A' },
      'ru',
    );
    expect(text).toContain('21 кг');
    expect(text).toContain('0.23 м³');
  });

  it('the answer to a request opens with the verdict the deciders\' copies are closed with', () => {
    for (const locale of ['uz', 'ru'] as const) {
      const text = renderTelegramText(
        'DebtApprovalDecided',
        { verdict: 'refused', reasons: 'price', clientCode: 'GS1', clientName: 'X', decidedByName: 'Y' },
        locale,
      );
      expect(text.split('\n')[0]).toBe(approvalVerdictLine({ verdict: 'refused', reasons: 'price' }, locale));
      expect(text.split('\n')[0]).toBe(`⛔ ${notificationLabels(locale).priceApprovalNo}`);
    }
  });
});

describe('the buttons that change a message (source shape — the shell needs a Telegram)', () => {
  const handlers = read('src/modules/platform/telegram/staff-handlers.ts');
  const branch = (start: string, end: string) => {
    const at = handlers.indexOf(start);
    expect(at, `re-anchor: ${start}`).toBeGreaterThan(-1);
    return handlers.slice(at, handlers.indexOf(end, at + start.length));
  };

  it('pressing «✅ Bajarildi» changes NOTHING on the message — only the close does', () => {
    const press = branch("if (parsed.kind === 'task_done') {", "if (parsed.kind === 'note')");
    expect(press).toContain('noteTaskPending(');
    expect(press).toContain("kind: parsed.list ? 'list' : 'single'");
    expect(press).not.toMatch(/editText|editMarkup|closeTaskMessage/);
    // …and the close is dispatched off the poller, only once the task closed.
    expect(handlers).toMatch(
      /if \(outcome === 'done' \|\| outcome === 'already_closed'\) \{\s*void closeTaskMessage\(/,
    );
  });

  it('an approval press settles the pressed copy on «decided» AND on «already decided»', () => {
    const press = branch("if (parsed.kind !== 'approval') return;", 'bot.on(');
    expect(press).toContain("(outcome === 'decided' || outcome === 'already_decided')");
    expect(press).toMatch(/void settlePressedApproval\(/);
    // Answered FIRST — the phone's spinner stops before any edit is made.
    expect(press.indexOf('answerCallbackQuery')).toBeLessThan(press.indexOf('settlePressedApproval'));
  });
});

describe('the staff command menu', () => {
  it('offers every command the bot answers, and answers every command it offers', () => {
    const commands = [...read('src/modules/platform/telegram/commands.ts').matchAll(/command: '([a-z]+)'/g)]
      .map((m) => m[1]!)
      .filter((c) => c !== 'start');
    expect(commands).toEqual(expect.arrayContaining(['hodim', 'bugun', 'zametka', 'hisoblatish', 'ai']));
    const handlers = read('src/modules/platform/telegram/staff-handlers.ts');
    const bot = read('src/modules/platform/telegram/bot.ts');
    for (const c of commands) {
      const answered = handlers.includes(`'/${c}'`) || bot.includes(`bot.command('${c}'`);
      expect(answered, `/${c} is offered but nothing answers it`).toBe(true);
    }
  });

  it('a person linked by sharing their NUMBER gets the menu too', () => {
    const handlers = read('src/modules/platform/telegram/staff-handlers.ts');
    const at = handlers.indexOf("bot.on('message:contact'");
    const end = handlers.indexOf("bot.on(['message:photo', 'message:document']", at);
    expect(at).toBeGreaterThan(-1);
    expect(handlers.slice(at, end)).toContain('offerStaffCommands(ctx, ctx.chat.id);');
  });
});

describe('a «today» task due on ANOTHER Tashkent day says which (STAFF-TODAY-TIME-NO-DATE)', () => {
  it('23:40 in Tashkent, due 01:30 tomorrow: the date is printed, not a bare past-looking hour', async () => {
    const { taskLine } = await import('@/modules/platform/tasks/digest');
    const now = new Date('2026-09-27T18:40:00Z'); // 23:40 Tashkent
    const tomorrow = taskLine({ typeIcon: null, title: 'Hisob', dueAt: new Date('2026-09-27T20:30:00Z'), allDay: false }, false, now);
    expect(tomorrow).toContain('· 28.09 01:30');
    // The same day keeps its short form: «today» is already the heading.
    const later = taskLine({ typeIcon: null, title: 'Hisob', dueAt: new Date('2026-09-27T18:55:00Z'), allDay: false }, false, now);
    expect(later).toMatch(/· 23:55$/);
  });
});

describe('one payload no renderer can read fails ITS row, never the run (round C review)', () => {
  it('the per-row render sits inside the send’s try', () => {
    const drain = read('src/modules/platform/notifications/service.ts');
    const at = drain.indexOf('const buttons = buttonsFor(notification.type, payload);');
    expect(at, 're-anchor: the drain’s render moved').toBeGreaterThan(-1);
    const tryAt = drain.lastIndexOf('try {', at);
    const catchAt = drain.indexOf('} catch (err) {', tryAt);
    expect(tryAt).toBeGreaterThan(drain.lastIndexOf('const payload = notification.payload', at));
    expect(catchAt).toBeGreaterThan(at);
    expect(drain.indexOf('composeStaffMessage(notification.type', tryAt)).toBeLessThan(catchAt);
  });
});
