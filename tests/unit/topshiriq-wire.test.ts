import { readdirSync, readFileSync, statSync } from 'node:fs';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { FOUNDERS, MUTE_GROUPS } from '@/modules/platform/notifications/mutes';
import { TASK_COPY_TYPES, TASK_LIST_TYPE } from '@/modules/platform/notifications/retire-tasks';
import { DELETE_RULES } from '@/modules/platform/files/service';
import { TASK_ERROR_CODES } from '@/modules/platform/tasks/service';
import { buttonsFor, escapesIntake, MEN_BERGAN, TOPSHIRIQ } from '@/modules/platform/telegram/staff-bot';

/**
 * The topshiriq round's rules a grammy shell cannot exercise without a
 * Telegram (docs/TELEGRAM-TOPSHIRIQ.md, the review's binding fixes) — SOURCE
 * SHAPE, and DERIVED wherever the code can name its own members, so the next
 * type, writer or label joins the fence on the day it is added. Comments are
 * stripped first (#725), and every scan asserts it found something before it
 * asserts anything about it (#494).
 */
const strip = (s: string) => s.replace(/\/\*[\s\S]*?\*\//g, '').replace(/^\s*\/\/.*$/gm, '');
const read = (p: string) => strip(readFileSync(p, 'utf8'));

function walk(dir: string): string[] {
  return readdirSync(dir).flatMap((name) => {
    const path = join(dir, name);
    if (statSync(path).isDirectory()) return walk(path);
    return /\.(ts|tsx)$/.test(name) ? [path] : [];
  });
}
const SRC = walk('src').map((path) => ({ path, text: read(path) }));
const SCRIPTS = walk('scripts').map((path) => ({ path, text: read(path) }));

const handlers = read('src/modules/platform/telegram/staff-handlers.ts');
const taskHandlers = read('src/modules/platform/telegram/task-handlers.ts');

describe('the text ladder’s slots, in order (telegram-mechanics-24)', () => {
  it('cabinet < the round’s labels < the note capture < the draft < Door B < the one-text wait < the staff tail', () => {
    const at = (needle: string) => {
      const i = handlers.indexOf(needle);
      expect(i, `re-anchor: ${needle.slice(0, 60)}`).toBeGreaterThan(-1);
      return i;
    };
    const order = [
      at('if (isCabinetText(ctx.message.text)) return next();'),
      at("if (ctx.message.text === TOPSHIRIQ || ctx.message.text === '/topshiriq')"),
      at("if (ctx.message.text === MEN_BERGAN || ctx.message.text === '/berganlarim')"),
      at('const capture = activeCapture(chatId);\n    if (capture) {'),
      at('const draft = activeDraft(chatId);\n    if (draft) {'),
      at('if (ctx.message.forward_origin) {'),
      at('const pendingTask = takeTaskPending(chatId);'),
      at('await answerStaffText(ctx as unknown as StaffTailCtx, chatId, staff.id, ctx.message.text);'),
    ];
    for (let i = 1; i < order.length; i++) expect(order[i - 1]!, `slot ${i}`).toBeLessThan(order[i]!);
  });

  it('Door B asks its own staff question — it sits above the staff fence', () => {
    const door = handlers.slice(handlers.indexOf('if (ctx.message.forward_origin) {'));
    expect(door.slice(0, door.indexOf('}\n    }'))).toContain('const staff = await staffForChat(chatId);');
  });

  it('the round’s labels escape a live collection, by behaviour', () => {
    for (const label of [TOPSHIRIQ, '/topshiriq', MEN_BERGAN, '/berganlarim']) {
      expect(escapesIntake(label), label).toBe(true);
    }
  });

  it('exactly ONE text door takes the wait, and «Natijasiz»’s named second door is used in its branch alone', () => {
    expect(handlers.split('takeTaskPending(chatId)').length - 1).toBe(1);
    const callers = SRC.filter((f) => f.text.includes('takeTaskPendingFor(') && !f.path.endsWith('staff-bot.ts'));
    expect(callers.map((f) => f.path)).toEqual(['src/modules/platform/telegram/task-handlers.ts']);
    const branch = taskHandlers.slice(taskHandlers.indexOf("if (press.kind === 'task_noresult') {"));
    expect(branch.indexOf('takeTaskPendingFor(chatId, press.taskId)')).toBeGreaterThan(-1);
    expect(taskHandlers.split('takeTaskPendingFor(').length - 1).toBe(1);
  });
});

describe('the media handlers sit before the cabinet (telegram-mechanics-19)', () => {
  it('bot.ts registers the staff bot BEFORE the cabinet', () => {
    const bot = read('src/modules/platform/telegram/bot.ts');
    expect(bot.indexOf('registerStaffBot(bot);')).toBeGreaterThan(-1);
    expect(bot.indexOf('registerStaffBot(bot);')).toBeLessThan(bot.indexOf('registerClientCabinet(bot);'));
  });

  it('voice, audio, video, round video, place and sticker have a staff handler that falls through with next()', () => {
    const register = handlers.slice(handlers.indexOf('export function registerStaffBot('));
    const media = register.indexOf("['message:voice', 'message:audio', 'message:video', 'message:video_note', 'message:location', 'message:sticker']");
    expect(media, 're-anchor: the media handler moved').toBeGreaterThan(-1);
    const body = register.slice(media, register.indexOf('bot.on(', media + 10));
    expect(body).toContain('if (await draftMedia(ctx, chatId)) return;');
    expect(body).toContain('return next();');
  });

  it('a photo or a file reaches the draft and Door B only after the intake and the note capture', () => {
    const photos = handlers.slice(handlers.indexOf("bot.on(['message:photo', 'message:document']"));
    expect(photos.indexOf('const state = activeIntake(chatId);')).toBeLessThan(photos.indexOf('activeCapture(chatId)'));
    expect(photos.indexOf('activeCapture(chatId)')).toBeLessThan(photos.indexOf('draftMedia(ctx, chatId)'));
  });

  it('a contact card in a staff chat goes to the draft or Door B before the cabinet’s «send your OWN number»', () => {
    const contact = handlers.slice(handlers.indexOf("bot.on('message:contact'"));
    const first = contact.slice(0, contact.indexOf('const contact = ctx.message.contact;'));
    expect(first).toContain('draftMedia(ctx, chatId)');
    expect(first.indexOf('draftMedia(ctx, chatId)')).toBeLessThan(first.indexOf('return next();'));
  });
});

describe('a task press is decided before anything waits (telegram-mechanics-1)', () => {
  it('the ✅ press loads the task and refuses in words BEFORE it stores the wait', () => {
    const press = handlers.slice(
      handlers.indexOf("if (parsed.kind === 'task_done') {"),
      handlers.indexOf("if (parsed.kind === 'note')"),
    );
    expect(press.indexOf('taskPressCheck(chatId, parsed.taskId')).toBeGreaterThan(-1);
    expect(press.indexOf('taskPressCheck(chatId, parsed.taskId')).toBeLessThan(press.indexOf('noteTaskPending('));
    expect(press.indexOf('activeDraft(chatId)')).toBeLessThan(press.indexOf('noteTaskPending('));
    expect(press).toContain('pressRefusalText(check)');
  });

  it('every new kind is answered ABOVE the approval guard (#939)', () => {
    const guard = handlers.indexOf("if (parsed.kind !== 'approval') return;");
    for (const needle of [
      'await handleTaskPress(ctx, chatId, parsed);',
      'await handleDraftCallback(ctx, chatId, parsed.step);',
      'await pickAssignee(ctx, chatId, parsed.userId);',
      'await handleForwardCallback(ctx, chatId, parsed.step,',
    ]) {
      expect(handlers.indexOf(needle), needle).toBeGreaterThan(-1);
      expect(handlers.indexOf(needle), needle).toBeLessThan(guard);
    }
  });

  it('the typed result answers every code in words — no rethrow into bot.catch', () => {
    const result = handlers.slice(handlers.indexOf('const pendingTask = takeTaskPending(chatId);'));
    expect(result.slice(0, 2000)).toContain("await ctx.reply(outcome === 'done' ? '✅ Vazifa yopildi.' : TASK_ANSWERS[outcome]);");
    const bot = read('src/modules/platform/telegram/staff-bot.ts');
    expect(bot).toContain('export const TASK_ANSWERS: Record<BotTaskResult, string>');
    expect(bot).toContain("if (err instanceof TaskError) return { result: err.code };");
  });
});

describe('the command menu offers the round’s doors and the ladder answers them (telegram-mechanics-23)', () => {
  it('/topshiriq and /berganlarim are offered AND answered', () => {
    const commands = read('src/modules/platform/telegram/commands.ts');
    for (const name of ['topshiriq', 'berganlarim']) {
      expect(commands).toContain(`{ command: '${name}'`);
      expect(handlers).toContain(`ctx.message.text === '/${name}'`);
    }
  });
});

describe('every notification type the code sends is mutable (tests-completeness-11)', () => {
  const grouped = new Set<string>(Object.values(MUTE_GROUPS).flat());
  const consts = new Map<string, string>();
  for (const f of SRC) {
    for (const m of f.text.matchAll(/export const ([A-Z_]+) = '([A-Za-z]+)';/g)) consts.set(m[1]!, m[2]!);
  }
  const sent = new Set<string>();
  for (const f of SRC) {
    for (const m of f.text.matchAll(/notifyStaffTelegram\(\{/g)) {
      const window = f.text.slice(m.index!, m.index! + 800);
      const type = /type:\s*(?:'([A-Za-z]+)'|([A-Z_]+))/.exec(window);
      if (!type) continue;
      sent.add(type[1] ?? consts.get(type[2]!) ?? `?${type[2]}`);
    }
  }

  it('found the senders', () => {
    expect(sent.size, 're-anchor: no notifyStaffTelegram types found').toBeGreaterThanOrEqual(30);
    for (const type of ['TaskAccepted', 'TaskQuestion', 'TaskReminder', 'TaskReassigned']) expect(sent).toContain(type);
  });

  it('every type sent through notifyStaffTelegram is in a mute group', () => {
    const loose = [...sent].filter((type) => !grouped.has(type));
    expect(loose, `unmutable: ${loose.join(', ')}`).toEqual([]);
  });

  it('the round’s seven join «tasks» and none is a founder — a grown group must not un-mute anybody', () => {
    const round = ['TaskAccepted', 'TaskRescheduled', 'TaskQuestion', 'TaskAnswer', 'TaskReminder', 'TaskCancelled', 'TaskReassigned'];
    for (const type of round) {
      expect(MUTE_GROUPS.tasks as readonly string[], type).toContain(type);
      for (const founders of Object.values(FOUNDERS)) expect(founders, type).not.toContain(type);
    }
  });
});

describe('the retired copies are exactly the copies that carry task buttons (telegram-mechanics-6)', () => {
  it('DERIVED: the types buttonsFor draws a task callback for = TASK_COPY_TYPES + the digest', () => {
    const uuid = '01234567-89ab-4def-8123-456789abcdef';
    const payload = { taskId: uuid, origin: 'hand', offerSources: true, tasks: [{ id: uuid, title: 'x' }], text: 'x' };
    const taskPrefix = /^(t|t[a-z]|tp:[a-z]):/;
    const drawing = [...new Set<string>(Object.values(MUTE_GROUPS).flat())].filter((type) =>
      (buttonsFor(type, payload) ?? []).flat().some((b) => 'callback_data' in b && taskPrefix.test(b.callback_data)),
    );
    expect(drawing.sort()).toEqual([...TASK_COPY_TYPES, TASK_LIST_TYPE].sort());
  });
});

describe('retiring runs after the commit, never inside a transaction (telegram-mechanics-7)', () => {
  it('the three transactional callers of cancelTasksFor keep its ids and retire after the transaction', () => {
    for (const path of [
      'src/modules/wms/planning/service.ts',
      'src/modules/wms/scanning/unload.ts',
      'src/modules/wms/receipts/annul.ts',
    ]) {
      const text = read(path);
      const cancel = text.indexOf('cancelTasksFor(tx,');
      const retire = text.indexOf('retireTaskCopiesSoon({ taskIds: cancelledTasks');
      expect(cancel, path).toBeGreaterThan(-1);
      expect(retire, path).toBeGreaterThan(cancel);
      // The bulk closer's answer is kept, not discarded.
      expect(text.slice(cancel - 40, cancel), path).toMatch(/cancelledTasks(\.push\(\.\.\.\(| = )await $/);
      // …and the retire is outside the transaction body: its `});` closes before it.
      expect(text.slice(cancel, retire), path).toMatch(/\n {2}\}\);\n/);
    }
  });

  it('no src writer awaits the slow retire inline — only its void form', () => {
    const inline = SRC.filter(
      (f) => /await retireTaskCopies\(/.test(f.text) && !f.path.endsWith('notifications/retire-tasks.ts'),
    ).map((f) => f.path);
    // The stale-task script awaits it before closing its pool, the one stated exception.
    expect(inline.filter((p) => !p.endsWith('calc/stale-tasks.ts'))).toEqual([]);
  });
});

describe('the bound pre-check sits BEFORE every door’s UPDATE (VED-TARIX §8, ved-correctness-11)', () => {
  const service = read('src/modules/platform/tasks/service.ts');
  const body = (name: string) => {
    const start = service.indexOf(`export async function ${name}(`);
    expect(start, name).toBeGreaterThan(-1);
    return service.slice(start, service.indexOf('\nexport ', start + 10));
  };

  for (const [name, check] of [
    ['completeTask', 'await refuseOpenCalc(before);'],
    ['reassignTask', 'await refuseOpenCalc(before);'],
    ['acceptTask', 'await refuseOpenCalc(before);'],
    ['rescheduleTask', 'await refuseBoundClock(before);'],
    ['updateTask', 'if (dueMoved) await refuseBoundClock(before);'],
  ] as const) {
    it(`${name}: ${check}`, () => {
      const fn = body(name);
      expect(fn.indexOf(check), name).toBeGreaterThan(-1);
      expect(fn.indexOf(check), name).toBeLessThan(fn.indexOf('.update(tasks)'));
    });
  }

  it('the pre-check fails CLOSED — a gate that threw refuses', () => {
    const fn = service.slice(service.indexOf('async function bindingOrRefuse('));
    expect(fn.slice(0, 600)).toContain("throw new TaskError('bound_check_failed');");
  });
});

describe('every writer of a task’s date or holder is a known door (data-migration-9)', () => {
  it('DERIVED: no .update(tasks) or UPDATE tasks moves due_at / assignee_id outside the listed functions', () => {
    const writers: string[] = [];
    for (const f of [...SRC, ...SCRIPTS]) {
      for (const m of f.text.matchAll(/\.update\(tasks\)\s*\.set\(\{([\s\S]*?)\}\)/g)) {
        if (!/\b(assigneeId|dueAt)\b/.test(m[1]!)) continue;
        const before = f.text.slice(0, m.index!);
        const fn = [...before.matchAll(/(?:async )?function (\w+)\(/g)].pop()?.[1] ?? '?';
        writers.push(`${f.path}#${fn}`);
      }
      for (const m of f.text.matchAll(/UPDATE tasks\b[\s\S]{0,400}?SET([\s\S]{0,400}?)WHERE/g)) {
        if (!/\b(assignee_id|due_at)\s*=/.test(m[1]!)) continue;
        const before = f.text.slice(0, m.index!);
        const fn = [...before.matchAll(/(?:async )?function (\w+)\(/g)].pop()?.[1] ?? '?';
        writers.push(`${f.path}#${fn}`);
      }
    }
    expect(writers.sort()).toEqual(
      [
        'src/modules/platform/tasks/service.ts#reassignTask',
        'src/modules/platform/tasks/service.ts#rescheduleTask',
        'src/modules/platform/tasks/service.ts#updateTask',
        // «Olaman»: the queue's own take moves the holder (its door is the queue's gate).
        'src/modules/wms/calc/service.ts#takeCalcRequest',
      ].sort(),
    );
  });
});

describe('every refusal and every audit verb has its words in all four bundles (tests-completeness-7/25)', () => {
  const bundles = ['ru', 'uz', 'zh-CN', 'en'].map((loc) => ({
    loc,
    json: JSON.parse(readFileSync(`messages/${loc}.json`, 'utf8')) as {
      tasks: { errors: Record<string, string> };
      audit: { actions: Record<string, string> };
    },
  }));

  it('every TaskError code — the closed list, and every literal thrown in src is ON it', () => {
    const thrown = new Set<string>();
    for (const f of SRC) {
      for (const m of f.text.matchAll(/new TaskError\(([^)]*)\)/g)) {
        for (const lit of m[1]!.matchAll(/'([a-z_]+)'/g)) thrown.add(lit[1]!);
      }
    }
    expect(thrown.size, 're-anchor').toBeGreaterThanOrEqual(15);
    for (const code of thrown) expect(TASK_ERROR_CODES as readonly string[], code).toContain(code);
    for (const { loc, json } of bundles) {
      for (const code of TASK_ERROR_CODES) expect(json.tasks.errors[code], `${loc} tasks.errors.${code}`).toMatch(/\S/);
    }
  });

  it('every AuditAction member — the history renders the verb at runtime with no t.has', () => {
    const audit = read('src/modules/platform/audit/service.ts');
    const union = /export type AuditAction =([\s\S]*?);/.exec(audit)![1]!;
    const members = [...union.matchAll(/'([a-z_]+)'/g)].map((m) => m[1]!);
    expect(members).toContain('comment');
    expect(members).toContain('share');
    for (const { loc, json } of bundles) {
      for (const action of members) expect(json.audit.actions[action], `${loc} audit.actions.${action}`).toMatch(/\S/);
    }
  });
});

describe('every attachment type written outside the upload route has a read case AND a delete decision (tests-completeness-10, access-money-11)', () => {
  const access = read('src/modules/wms/attachments/access.ts');
  const cases = new Set([...access.matchAll(/case '([a-z_]+)':/g)].map((m) => m[1]!));
  const consts = new Map<string, string>();
  for (const f of [...SRC, ...SCRIPTS]) {
    for (const m of f.text.matchAll(/export const ([A-Z_]+) = '([a-z_]+)';/g)) consts.set(m[1]!, m[2]!);
  }
  // Every value reaching saveAttachment or the bot's saveBotFile wrapper —
  // a literal or a named constant, never only literals (the bot never passes
  // one: it goes through the wrapper and NOTE_ENTITY_TYPE / TASK_ENTITY_TYPE).
  const written = new Set<string>();
  for (const f of [...SRC, ...SCRIPTS]) {
    if (f.path.endsWith('api/files/upload/route.ts')) continue; // ATTACHABLE's own fence
    for (const m of f.text.matchAll(/(?:saveAttachment|saveBotFile)\(\s*(?:ctx,\s*)?\{([\s\S]{0,300}?)\}/g)) {
      const type = /entityType:\s*(?:'([a-z_]+)'|([A-Z_]+))/.exec(m[1]!);
      if (!type) continue;
      written.add(type[1] ?? consts.get(type[2]!) ?? `?${type[2]}`);
    }
  }

  it('found the writers — the four known before this round and the task files', () => {
    for (const type of ['crm_activity', 'staff_note', 'call_log', 'tg_message', 'task']) expect(written).toContain(type);
  });

  it('each one has a `case` in the read gate (an unmapped type is log-only and SERVES the bytes)', () => {
    const missing = [...written].filter((type) => !cases.has(type));
    expect(missing).toEqual([]);
  });

  it('each one has a stated delete rule, and a task file is its author’s alone', () => {
    const missing = [...written].filter((type) => !Object.hasOwn(DELETE_RULES, type));
    expect(missing).toEqual([]);
    expect(DELETE_RULES.task).toBe('task_author');
  });
});

describe('the surfaces that draw a task branch on the calc job (tests-completeness-7)', () => {
  it('the task list, the dock and the bot each know an open calc job', () => {
    expect(read('src/components/task-list.tsx')).toContain('task.calc ? (');
    expect(read('src/components/dock.tsx')).toContain('task.calc ? (');
    expect(read('src/app/api/dock/tasks/route.ts')).toContain("binding?.kind === 'calc' && binding.open");
    expect(read('src/modules/platform/tasks/view.ts')).toContain("binding?.kind === 'calc' && binding.open");
    expect(handlers).toContain("taskPressCheck(chatId, parsed.taskId, 'act')");
  });

  it('no reassign select is drawn on an open calc job', () => {
    expect(read('src/components/task-list.tsx')).toContain('canManage && task.canReassign && people.length > 1');
  });
});
