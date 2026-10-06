import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';
import {
  assigneeButtons,
  buttonsFor,
  dayButtons,
  DRAFT_STEPS,
  dueKeyboard,
  forwardKeyboard,
  givenButtons,
  givenListText,
  parseCallback,
  peopleKeyboard,
  postponeKeyboard,
  TASK_ANSWERS,
  type BotButton,
} from '@/modules/platform/telegram/staff-bot';
import {
  ASSIGNED_NOTE_CAP,
  assignedNoteLine,
  cutOnWord,
  NOTE_MORE,
  TASK_ERROR_CODES,
  taskButtonPayload,
} from '@/modules/platform/tasks/service';
import { withoutButton } from '@/modules/platform/notifications/staff-html';
import { reachLine } from '@/modules/platform/notifications/staff';
import { emptyDayText, undatedLine } from '@/modules/platform/tasks/digest';

/**
 * The topshiriq round's buttons where they are pure (docs/TELEGRAM-TOPSHIRIQ.md
 * §4, §7): the closed callback vocabularies, the per-origin button table, the
 * payload contract, the day list's calc rows, the one-button remover, and the
 * words every refusal is answered with. Comments are stripped from the
 * sources the derived fence reads (#725).
 */
const read = (p: string) =>
  readFileSync(p, 'utf8')
    .replace(/\/\*[\s\S]*?\*\//g, '')
    .replace(/^\s*\/\/.*$/gm, '');

const UUID = '01234567-89ab-4def-8123-456789abcdef';
const dataOf = (b: BotButton) => ('callback_data' in b ? b.callback_data : '');
const flat = (rows: BotButton[][] | null) => (rows ?? []).flat().map((b) => b.text);

describe('the closed callback vocabularies (telegram-mechanics-25)', () => {
  it('every uuid-bearing task kind parses to itself', () => {
    expect(parseCallback(`tk:${UUID}`)).toEqual({ kind: 'task_accept', taskId: UUID });
    expect(parseCallback(`tw:${UUID}`)).toEqual({ kind: 'task_wait', taskId: UUID });
    expect(parseCallback(`tq:${UUID}`)).toEqual({ kind: 'task_question', taskId: UUID });
    expect(parseCallback(`tr:${UUID}`)).toEqual({ kind: 'task_reply', taskId: UUID });
    expect(parseCallback(`tn:${UUID}`)).toEqual({ kind: 'task_noresult', taskId: UUID });
    expect(parseCallback(`te:${UUID}`)).toEqual({ kind: 'task_remind', taskId: UUID });
    expect(parseCallback(`tc:${UUID}`)).toEqual({ kind: 'task_cancel', taskId: UUID });
    expect(parseCallback(`tf:${UUID}`)).toEqual({ kind: 'task_sources', taskId: UUID });
    for (const to of ['e', 'i', 'w', 's'] as const) {
      expect(parseCallback(`tp:${to}:${UUID}`)).toEqual({ kind: 'task_postpone', to, taskId: UUID });
    }
    // The old ✅ is byte-identical — every delivered message still parses.
    expect(parseCallback(`t:${UUID}`)).toEqual({ kind: 'task_done', taskId: UUID });
    expect(parseCallback(`tb:${UUID}`)).toEqual({ kind: 'task_done', taskId: UUID, list: true });
  });

  it('the draft and Door B buttons are a closed list, checked after the regex', () => {
    for (const step of DRAFT_STEPS) expect(parseCallback(`d:${step}`)).toEqual({ kind: 'draft', step });
    expect(parseCallback(`dk:${UUID}`)).toEqual({ kind: 'draft_pick', userId: UUID });
    expect(parseCallback('fb:task')).toEqual({ kind: 'forward', step: 'task' });
    expect(parseCallback('fb:search')).toEqual({ kind: 'forward', step: 'search' });
  });

  it('refuses look-alikes — an unanchored prefix swallows its neighbours', () => {
    for (const junk of [
      `tx:${UUID}`,
      `tk:${UUID}:1`,
      'tk:short',
      `tp:x:${UUID}`,
      `tp:e:short`,
      'd:due_x',
      'd:drop_table',
      'dk:short',
      'fb:delete',
      `tkk:${UUID}`,
      // The cabinet's own: never the staff parser's.
      'mg',
    ]) {
      expect(parseCallback(junk), junk).toBeNull();
    }
  });

  it('every one fits Telegram’s 64 bytes', () => {
    for (const data of [`tp:e:${UUID}`, `tk:${UUID}`, `dk:${UUID}`, 'd:cancel', 'fb:search']) {
      expect(Buffer.byteLength(data)).toBeLessThanOrEqual(64);
    }
  });

  it('DERIVED: every callback_data the staff keyboards build is one the parser accepts (#939)', () => {
    // ONE fence over every staff source: a hole is filled with each value a
    // real button could carry, and the literal passes when one of them parses.
    const sources = [
      'src/modules/platform/telegram/staff-bot.ts',
      'src/modules/platform/telegram/staff-handlers.ts',
      'src/modules/platform/telegram/task-handlers.ts',
    ].map(read);
    const literals = sources.flatMap((s) =>
      [...s.matchAll(/callback_data:\s*(['`])((?:[a-z]{1,3}):[^'`]*)\1/g)].map((m) => m[2]!),
    );
    expect(literals.length, 're-anchor: no callback literals found').toBeGreaterThanOrEqual(30);
    const candidates = [UUID, 'a1b2c3d4', '1', 'yolkira', 'zone_cn', 'cancel', 'e'];
    const fills = (raw: string): string[] => {
      const hole = /\$\{[^}]+\}/.exec(raw);
      if (!hole) return [raw];
      return candidates.flatMap((c) => fills(raw.replace(hole[0], c)));
    };
    const unparsed = literals.filter((raw) => !fills(raw).some((data) => parseCallback(data) !== null));
    expect(unparsed, `buttons nobody would answer: ${unparsed.join(', ')}`).toEqual([]);
    // …and the round's own kinds are among them, so the fence is not vacuous.
    for (const prefix of ['tk:', 'tw:', 'tq:', 'tr:', 'tn:', 'te:', 'tc:', 'tf:', 'tp:', 'd:', 'dk:', 'fb:']) {
      expect(literals.some((l) => l.startsWith(prefix)), prefix).toBe(true);
    }
  });

  it('the keyboards the bot builds by function parse too', () => {
    const rows = [
      ...dueKeyboard(),
      ...forwardKeyboard(),
      ...postponeKeyboard(UUID),
      ...peopleKeyboard([{ id: UUID, name: 'Siroj', recent: true, noChat: false }]),
      ...(givenButtons([{ id: UUID, title: 'x', assigneeName: 'A', dueAt: null, allDay: true, accepted: false }]) ?? []),
    ];
    for (const button of rows.flat()) expect(parseCallback(dataOf(button)), button.text).not.toBeNull();
  });
});

describe('the assignee’s buttons, by where the task came from (spec §2, mechanics-20/21)', () => {
  const p = (extra: Record<string, unknown>) => ({ taskId: UUID, text: 'x', ...extra });

  it('a hand task — and a payload from before the round, with no origin — gets all four', () => {
    for (const payload of [p({ origin: 'hand' }), p({})]) {
      expect(flat(buttonsFor('TaskAssigned', payload))).toEqual([
        '👀 Qabul qildim',
        '✅ Bajarildi',
        '⏰ Muddatni surish',
        '💬 Savol',
      ]);
    }
  });

  it('👀 is gone once accepted, and ⏰ on a repeating task (it would move the series)', () => {
    expect(flat(buttonsFor('TaskAssigned', p({ origin: 'hand', accepted: true })))).not.toContain('👀 Qabul qildim');
    expect(flat(buttonsFor('TaskAssigned', p({ origin: 'hand', repeats: true })))).not.toContain('⏰ Muddatni surish');
  });

  it('a calc job bound to its request carries NO callback — its one button is the lifted link', () => {
    expect(buttonsFor('TaskAssigned', p({ origin: 'calc', bound: true }))).toBeNull();
    // A release ghost, or a job whose request has closed, closes normally.
    expect(flat(buttonsFor('TaskAssigned', p({ origin: 'calc', bound: false })))).toEqual(['✅ Bajarildi']);
  });

  it('a promise call has no ⏰ (its date IS the client’s promise); a hand-back none either', () => {
    expect(flat(buttonsFor('TaskAssigned', p({ origin: 'promise' })))).toEqual(['👀 Qabul qildim', '✅ Bajarildi', '💬 Savol']);
    expect(flat(buttonsFor('TaskAssigned', p({ origin: 'calc_return' })))).toEqual([
      '👀 Qabul qildim',
      '✅ Bajarildi',
      '💬 Savol',
    ]);
  });

  it('an automation task: ✅ and ⏰ only — no 👀 and no 💬 to a rule’s author', () => {
    expect(flat(buttonsFor('TaskAssigned', p({ origin: 'automation' })))).toEqual(['✅ Bajarildi', '⏰ Muddatni surish']);
  });

  it('a reminder and an answer carry the same buttons as the assignment', () => {
    for (const type of ['TaskReminder', 'TaskAnswer']) {
      expect(buttonsFor(type, p({ origin: 'hand' }))).toEqual(buttonsFor('TaskAssigned', p({ origin: 'hand' })));
    }
  });

  it('the author’s question copy answers; a reassign offers the sources only when there are some', () => {
    expect(buttonsFor('TaskQuestion', p({}))).toEqual([[{ text: '💬 Javob berish', callback_data: `tr:${UUID}` }]]);
    expect(buttonsFor('TaskReassigned', p({ offerSources: true }))).toEqual([
      [{ text: '📤 Manbani yangi odamga yuborish', callback_data: `tf:${UUID}` }],
    ]);
    expect(buttonsFor('TaskReassigned', p({ offerSources: false }))).toBeNull();
    expect(buttonsFor('TaskAccepted', p({}))).toBeNull();
  });

  it('an unparseable id draws nothing rather than a button nobody answers', () => {
    expect(buttonsFor('TaskAssigned', { taskId: 'not-a-uuid', text: 'x' })).toBeNull();
    expect(assigneeButtons(UUID, {})![0]!.map(dataOf)).toEqual([`tk:${UUID}`, `t:${UUID}`]);
  });
});

describe('the payload contract (telegram-mechanics-21)', () => {
  const task = { id: UUID, origin: 'hand', boundId: null, acceptedAt: null, repeatUnit: null };

  it('says origin, bound, accepted and repeats — what buttonsFor cannot ask the row', () => {
    expect(taskButtonPayload(task)).toEqual({ taskId: UUID, origin: 'hand', bound: false, accepted: false, repeats: false });
    expect(taskButtonPayload({ ...task, acceptedAt: new Date(), repeatUnit: 'week' })).toMatchObject({
      accepted: true,
      repeats: true,
    });
    expect(taskButtonPayload({ ...task, origin: 'calc', boundId: UUID })).toMatchObject({ origin: 'calc', bound: true });
  });

  it('a pointed pre-0124 row reads as its POINTER’s kind (data-migration-3)', () => {
    expect(
      taskButtonPayload({ ...task, origin: null }, { kind: 'calc', recordId: UUID, open: true }),
    ).toMatchObject({ origin: 'calc', bound: true });
    // A closed request's task keeps the ordinary ✅.
    expect(
      taskButtonPayload({ ...task, origin: 'calc', boundId: UUID }, { kind: 'calc', recordId: UUID, open: false }),
    ).toMatchObject({ bound: false });
  });
});

describe('the day list (telegram-mechanics-3)', () => {
  const tasks = [
    { id: UUID, title: 'Hisoblash: Ali (3)', calc: '11111111-2222-4333-8444-555555555555' },
    { id: '00000000-0000-4000-8000-000000000002', title: 'Qo‘ng‘iroq' },
  ];

  it('an open calc job is a URL row to its screen, never a «✅»', () => {
    const rows = dayButtons(tasks, 'https://gsrwms.uz')!;
    expect(rows[0]).toEqual([
      { text: '🧮 Hisoblash: Ali (3)', url: 'https://gsrwms.uz/hisoblash/11111111-2222-4333-8444-555555555555' },
    ]);
    expect(rows[1]).toEqual([{ text: '✅ Qo‘ng‘iroq', callback_data: 'tb:00000000-0000-4000-8000-000000000002' }]);
  });

  it('with no https origin the calc row is skipped — a refused button takes the message with it', () => {
    expect(dayButtons(tasks, 'http://localhost:3000')).toEqual([
      [{ text: '✅ Qo‘ng‘iroq', callback_data: 'tb:00000000-0000-4000-8000-000000000002' }],
    ]);
  });

  it('«+ N ta muddatsiz» keeps undated work from vanishing off the message (spec §7)', () => {
    expect(undatedLine(0)).toBe('');
    expect(undatedLine(3)).toBe('\n\n+ 3 ta muddatsiz');
    expect(emptyDayText(2)).toBe('✅ Bugunga ochiq vazifa yo‘q.\n\n+ 2 ta muddatsiz');
    expect(emptyDayText(0)).toBe('✅ Bugunga ochiq vazifa yo‘q.');
  });
});

describe('one button out, its row neighbour kept (telegram-mechanics-4)', () => {
  it('👀 goes and ✅, ⏰, 💬 stay', () => {
    const markup = { inline_keyboard: buttonsFor('TaskAssigned', { taskId: UUID, origin: 'hand' }) };
    const left = withoutButton(markup, `tk:${UUID}`);
    expect(left.flat().map((b) => b.text)).toEqual(['✅ Bajarildi', '⏰ Muddatni surish', '💬 Savol']);
  });

  it('a row it empties goes with it; a URL row is never touched', () => {
    const markup = {
      inline_keyboard: [[{ text: '💬 Javob berish', callback_data: `tr:${UUID}` }], [{ text: '↗️', url: 'https://x' }]],
    };
    expect(withoutButton(markup, `tr:${UUID}`)).toEqual([[{ text: '↗️', url: 'https://x' }]]);
  });
});

describe('every refusal is a sentence (telegram-mechanics-1, tests-completeness-6)', () => {
  it('the bot has words for every code the task service can throw, and for its own two', () => {
    for (const code of [...TASK_ERROR_CODES, 'done', 'not_linked'] as const) {
      expect(TASK_ANSWERS[code], code).toMatch(/\S/);
    }
  });

  it('the reachability line names the person and the reason, and says nothing when they will hear', () => {
    expect(reachLine('Siroj', 'no_chat')).toBe('⚠ Siroj Telegramga ulanmagan — topshiriqni faqat saytda ko‘radi');
    expect(reachLine('Siroj', 'muted')).toBe('⚠ Siroj topshiriq xabarlarini o‘chirgan — faqat saytda ko‘radi');
    expect(reachLine('Siroj', 'ok')).toBeNull();
  });
});

describe('the assignment’s note (spec §4)', () => {
  it('is a hand task’s words, capped with «… saytda»', () => {
    expect(assignedNoteLine('GS777 ni tekshir', 'hand')).toBe('\n📝 GS777 ni tekshir');
    expect(assignedNoteLine('pre-0124', null)).toBe('\n📝 pre-0124');
    const long = assignedNoteLine('so‘z '.repeat(400), 'hand');
    expect(long.endsWith(NOTE_MORE)).toBe(true);
    expect(Array.from(long).length).toBeLessThanOrEqual(ASSIGNED_NOTE_CAP + NOTE_MORE.length + 5);
  });

  it('never for a hand-back (CalcReturned printed its reason) nor any machine task', () => {
    for (const origin of ['calc_return', 'calc', 'promise', 'automation']) {
      expect(assignedNoteLine('sabab', origin), origin).toBe('');
    }
    expect(assignedNoteLine('   ', 'hand')).toBe('');
  });

  it('cuts on a word and never through an emoji', () => {
    expect(cutOnWord('birinchi ikkinchi uchinchi', 20)).toBe('birinchi ikkinchi');
    // A word that would cost more than half the room is cut where it stands.
    expect(cutOnWord('bir ikkinchiuchinchi', 10)).toBe('bir ikkinc');
    expect(Array.from(cutOnWord('😀'.repeat(10), 5))).toHaveLength(5);
  });
});

describe('«📤 Men bergan» (his 5a)', () => {
  const now = new Date('2026-10-06T06:00:00Z');
  it('marks late, accepted and not yet seen, and counts what it did not list', () => {
    const text = givenListText(
      {
        total: 23,
        rows: [
          { id: UUID, title: 'Kech', assigneeName: 'Ali', dueAt: new Date('2026-10-05T23:59:59.999Z'), allDay: true, accepted: true },
          { id: UUID, title: 'Ko‘rdi', assigneeName: 'Vali', dueAt: null, allDay: true, accepted: true },
          { id: UUID, title: 'Kutmoqda', assigneeName: 'Siroj', dueAt: null, allDay: true, accepted: false },
        ],
      },
      now,
    );
    expect(text).toContain('🔴 Ali · 05.10 · Kech');
    expect(text).toContain('👀 Vali · muddatsiz · Ko‘rdi');
    expect(text).toContain('⏳ Siroj · muddatsiz · Kutmoqda');
    expect(text).toContain('… va yana 20 ta');
    expect(givenListText({ total: 0, rows: [] }, now)).toBe('📤 Siz bergan ochiq vazifa yo‘q.');
  });
});
