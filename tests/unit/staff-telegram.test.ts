import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';
import { FOUNDERS, groupsFromList, isTelegramMuted, listFromGroups, MUTE_GROUPS } from '@/modules/platform/notifications/mutes';
import { renderTelegramText } from '@/modules/platform/notifications/service';
import { notificationLabels, approvalVerdictLine } from '@/modules/platform/notifications/labels';
import {
  buttonsFor,
  DAY_BUTTONS,
  dayButtons,
  parseCallback,
} from '@/modules/platform/telegram/staff-bot';
import { telegramDue } from '@/modules/platform/tasks/service';
import { dailyDigestText, DIGEST_UNCLAIMED_SHOWN } from '@/modules/wms/reports/daily-digest';

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

/*
 * Lists exactly as the profile WROTE them on real days — the group's members
 * that day, read off mutes.ts's git history. Literal on purpose: the first two
 * versions of this rule were tested against a «before» list built from the
 * rule's own constant, so the test could only ever agree with it, and the
 * second one missed `PartnerDebtDue` for every list production actually holds
 * (round C review, second pass).
 */
const ALERTS_TICKED_ON: Record<string, string[]> = {
  '2026-07-24, the group is born': ['BoxScannedOnLoad', 'UndocumentedTransfer', 'MissingInTransit'],
  '2026-08-09, CalcOverdue had left': [
    'BoxScannedOnLoad', 'UndocumentedTransfer', 'MissingInTransit', 'UnquotedCargo', 'DealDeviation',
    'DealDeferralEnded', 'ArrivalDiff', 'DebtApprovalRequested', 'DebtApprovalDecided', 'ClientWaiting',
    'TelegramSessionEnded', 'TruckSilent',
  ],
  '2026-09-26, PR #88 — the code behind production\'s last confirmed deploy': [
    'BoxScannedOnLoad', 'UndocumentedTransfer', 'MissingInTransit', 'UnquotedCargo', 'UnlinkedCargo',
    'DealDeviation', 'DealDeferralEnded', 'ArrivalDiff', 'DebtApprovalRequested', 'DebtApprovalDecided',
    'UnpricedIssued', 'PricedCargoLeft', 'ExpenseRequested', 'ExpenseRequestDecided', 'CalcOverdue',
    'ClientWaiting', 'TelegramSessionEnded', 'TruckSilent', 'CalcBelowFloor', 'BoxFoundHere', 'BoxLost',
    'CompensatedCargoFound', 'ReceiptMeasureCorrected',
  ],
};
const TASKS_TICKED_ON: Record<string, string[]> = {
  '2026-07-26, the group is born': ['TasksDue'],
  '2026-09-26, PR #88': [
    'TasksDue', 'TaskAssigned', 'TaskDone', 'CalcRequested', 'CalcTaken', 'CalcDone', 'CalcReturned', 'CalcPrefilled',
  ],
};

describe('a mute group that GROWS does not un-mute anybody (STAFF-11, STAFF-MUTE-MULTI)', () => {
  for (const [group, snapshots] of [
    ['alerts', ALERTS_TICKED_ON],
    ['tasks', TASKS_TICKED_ON],
  ] as const) {
    for (const [day, stored] of Object.entries(snapshots)) {
      it(`«${group}» ticked on ${day}: every member TODAY is muted, the box reads ticked, a save keeps it`, () => {
        for (const type of MUTE_GROUPS[group]) expect(isTelegramMuted(stored, type), type).toBe(true);
        const read = groupsFromList(stored);
        expect(read.groups[group]).toBe(true);
        // The next save of ANY box writes the whole group back.
        const saved = listFromGroups(read.all, { ...read.groups, calls: !read.groups.calls });
        for (const type of MUTE_GROUPS[group]) expect(isTelegramMuted(saved, type), type).toBe(true);
      });
    }
  }

  it('a list that lacks a founder is not a tick — the rule does not mute on a guess', () => {
    const stored = ALERTS_TICKED_ON['2026-08-09, CalcOverdue had left']!.filter((t) => t !== 'MissingInTransit');
    expect(isTelegramMuted(stored, 'ClientBotMessage')).toBe(false);
    expect(groupsFromList(stored).groups.alerts).toBe(false);
  });

  it('another group\'s tick mutes nothing here', () => {
    for (const type of MUTE_GROUPS.alerts) {
      expect(isTelegramMuted([...MUTE_GROUPS.digest, ...MUTE_GROUPS.operations], type), type).toBe(false);
    }
    // `CrmFollowUps` moved from «digest» to «calls» (2026-09-19): an old
    // «digest» tick holds it, and still means it.
    const oldDigest = ['DailyDigest', 'CrmFollowUps', 'CrmDormant'];
    expect(groupsFromList(oldDigest).groups).toMatchObject({ digest: true, calls: true, alerts: false });
  });

  it('FOUNDERS stay inside their groups, one group each, never empty', () => {
    expect(Object.keys(FOUNDERS).sort()).toEqual(Object.keys(MUTE_GROUPS).sort());
    const seen = new Set<string>();
    for (const [group, founders] of Object.entries(FOUNDERS) as [keyof typeof MUTE_GROUPS, readonly string[]][]) {
      expect(founders.length, group).toBeGreaterThan(0);
      for (const type of founders) {
        expect(MUTE_GROUPS[group] as readonly string[], `${group}: ${type}`).toContain(type);
        expect(seen.has(type), type).toBe(false);
        seen.add(type);
      }
    }
  });

  it('never mutes a type in no group, and nothing for somebody who muted nothing', () => {
    expect(isTelegramMuted(MUTE_GROUPS.alerts, 'TotallyNewType')).toBe(false);
    expect(isTelegramMuted([], 'CalcSealed')).toBe(false);
    expect(isTelegramMuted(null, 'CalcSealed')).toBe(false);
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
  // The rows arrive as `unclaimedReport` and `warehouseFill` answer them (0116):
  // the ages are theirs, the text only prints them.
  const unclaimed = Array.from({ length: 27 }, (_, i) => ({
    whCode: 'YW',
    number: `R-${i}`,
    marking: i === 0 ? 'GS500' : null,
    boxes: 3,
    boxesOnRoad: i === 1 ? 2 : 0,
    days: 17,
  }));

  it('speaks Uzbek like every other staff message, and says how many it did not list', () => {
    const text = dailyDigestText({
      agingDays: 7,
      staleDays: 30,
      unclaimed,
      stale: [{ code: 'TAS1', staleCount: 12, oldestDays: 57 }],
    });
    expect(text).toContain('📊 GSR — kunlik hisobot');
    expect(text).toContain('❓ Egasiz yuk (7 kundan eski):');
    expect(text).toContain('• YW R-0 [GS500] — 3 kor., 17 kun');
    // Unclaimed cargo on a truck stays on the list, and says it is on the road.
    expect(text).toContain("• YW R-1 — 3 kor. (2 yo'lda), 17 kun");
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
