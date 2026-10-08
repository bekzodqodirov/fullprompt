import { readdirSync, readFileSync, statSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { describe, expect, it } from 'vitest';
import { THREAD_PING_TYPES } from '@/modules/platform/notifications/thread-ref';
import { CALC_THREAD_ERRORS, UNREACHABLE_REASONS } from '@/modules/wms/crm/thread';
import { readMarkKey } from '@/components/thread-seen';

/**
 * The staff threads' WIRING (0127), source-shape — comments stripped first
 * (#725: a fence must not match the sentence explaining it).
 *
 * Every assertion here is a place where a correct service is reached by the
 * wrong road: a ladder slot that eats a pending result, an action that never
 * asks the door (#531), a reader that names a column the drizzle table does
 * not declare (the half-applied deploy, #472), a callback the approval guard
 * swallows (#939), a media refusal that steals a draft's photo.
 */
const ROOT = resolve(__dirname, '../..');

function stripComments(source: string): string {
  let out = '';
  let quote: string | null = null;
  for (let i = 0; i < source.length; i += 1) {
    const ch = source[i]!;
    const next = source[i + 1];
    if (quote) {
      out += ch;
      if (ch === '\\') {
        out += next ?? '';
        i += 1;
      } else if (ch === quote) {
        quote = null;
      }
      continue;
    }
    if (ch === "'" || ch === '"' || ch === '`') {
      quote = ch;
      out += ch;
    } else if (ch === '/' && next === '/') {
      while (i < source.length && source[i] !== '\n') i += 1;
      out += '\n';
    } else if (ch === '/' && next === '*') {
      i += 2;
      while (i < source.length && !(source[i] === '*' && source[i + 1] === '/')) i += 1;
      i += 1;
    } else {
      out += ch;
    }
  }
  return out;
}

const raw = (rel: string) => readFileSync(join(ROOT, rel), 'utf8');
const src = (rel: string) => stripComments(raw(rel));

/** From `start` to the first `end` after it — the slice a body assertion reads. */
function between(text: string, start: string, end: string): string {
  const from = text.indexOf(start);
  expect(from, `anchor not found: ${start}`).toBeGreaterThanOrEqual(0);
  const to = text.indexOf(end, from + start.length);
  expect(to, `end not found after ${start}: ${end}`).toBeGreaterThan(from);
  return text.slice(from, to);
}

const HANDLERS = src('src/modules/platform/telegram/staff-handlers.ts');

describe('the Telegram ladder', () => {
  it('1. the reply block sits after the live draft and before Door B and the one-text wait', () => {
    const body = between(HANDLERS, "bot.on('message:text'", 'type StaffTailCtx');
    const draft = body.indexOf('const draft = activeDraft(chatId)');
    const reply = body.indexOf('threadReplyFromBot(chatId, {');
    const doorB = body.indexOf('ctx.message.forward_origin');
    const wait = body.indexOf('takeTaskPending(chatId, ctx.message.date)');
    expect(draft).toBeGreaterThan(0);
    expect(reply, 'reply block after the draft').toBeGreaterThan(draft);
    expect(doorB, 'Door B after the reply block').toBeGreaterThan(reply);
    expect(wait, 'the one-text wait after the reply block').toBeGreaterThan(reply);
  });

  it('9. every BotCallback kind is dispatched ABOVE the approval guard — `jy` included', () => {
    const union = between(src('src/modules/platform/telegram/staff-bot.ts'), 'export type BotCallback =', ';\n');
    const kinds = [...union.matchAll(/kind: '([a-z_]+)'/g)].map((m) => m[1]!).filter((k) => k !== 'approval');
    expect(kinds).toContain('thread_reply');
    const dispatch = between(HANDLERS, "bot.on('callback_query:data'", "bot.on('message:contact'");
    const guard = dispatch.indexOf("parsed.kind !== 'approval'");
    expect(guard).toBeGreaterThan(0);
    for (const kind of kinds) {
      const at = dispatch.indexOf(`parsed.kind === '${kind}'`);
      expect(at, `${kind} is dispatched`).toBeGreaterThan(0);
      expect(at, `${kind} above the approval guard`).toBeLessThan(guard);
    }
  });

  it('10. in both media handlers the refusal comes AFTER the draft declined, before the last next()', () => {
    const photo = between(HANDLERS, "bot.on(['message:photo', 'message:document']", "['message:voice'");
    const voice = between(HANDLERS, "['message:voice'", "bot.on('message:text'");
    for (const [name, body] of [
      ['photo', photo],
      ['voice', voice],
    ] as const) {
      const draft = body.indexOf('draftMedia(ctx, chatId)');
      const refuse = body.indexOf('refuseMediaReply(ctx, chatId)');
      const next = body.indexOf('return next()', refuse);
      expect(draft, name).toBeGreaterThan(0);
      expect(refuse, `${name}: refuse after draftMedia`).toBeGreaterThan(draft);
      expect(next, `${name}: next() after the refusal`).toBeGreaterThan(refuse);
    }
  });

  it('11. the one wait’s reader is an exhaustive switch over its kinds', () => {
    const body = between(
      src('src/modules/platform/telegram/task-handlers.ts'),
      'export async function answerPendingText',
      'async function answerReschedule',
    );
    expect(body).toContain('switch (pending.kind)');
    expect(body).toContain("case 'reply':");
    expect(body).toContain('const never: never = pending.kind');
  });
});

describe('the doors', () => {
  it('2. both note actions ask the thread door; the lenta’s action re-types no grant; the contact log is client-only', () => {
    const feed = between(
      src('src/modules/wms/crm/reply-actions.ts'),
      'export async function addFeedNoteAction',
      '\n}\n',
    );
    expect(feed).toContain('mayWriteThread(');
    expect(feed).not.toContain('permissions.has(');
    const log = between(src('src/app/(protected)/crm/actions.ts'), 'export async function addActivityAction', '\n}\n');
    expect(log).toContain('mayWriteThread(');
    const refuse = log.indexOf("if (parsed.data.entityType !== 'client') return { error: 'forbidden' }");
    expect(refuse).toBeGreaterThan(0);
    expect(refuse, 'refused before run()').toBeLessThan(log.indexOf("run('crm.leads'"));
  });

  it('5. the calc action and the three routes ask the door; the routes name the half-applied deploy', () => {
    expect(src('src/app/(protected)/hisoblash/[id]/thread-actions.ts')).toContain('mayWriteThread(who, ref)');
    expect(src('src/app/api/threads/read/route.ts')).toContain('mayReadThread(actor, thread)');
    expect(src('src/app/api/threads/pulse/route.ts')).toContain('mayReadThread(actor, ref)');
    const dock = src('src/app/api/dock/threads/route.ts');
    expect(dock).toContain('myThreads(actor)');
    const myThreads = between(src('src/modules/wms/crm/thread.ts'), 'export async function myThreads', '\n}\n');
    expect(myThreads).toContain('threadDoorsFor(viewer, refs)');
    for (const route of ['read', 'pulse']) {
      expect(src(`src/app/api/threads/${route}/route.ts`), route).toContain('isServerBehind(err)');
    }
    expect(dock).toContain('isServerBehind(err)');
  });

  it('6. the Telegram landing’s door has exactly two exemptions — the mention and the standing', () => {
    const door = between(src('src/modules/wms/crm/thread-reply.ts'), 'const admitted =', 'if (!admitted)');
    expect(door).toContain('await mayWriteThread(actor, input.ref)');
    expect(door).toContain("input.ping === 'MentionedInNote'");
    expect(door).toContain('await threadStanding(actor.id, input.ref)');
    expect(door.match(/\|\|/g)?.length).toBe(2);
  });

  it('8. the lenta asks the door’s own gate and restates no grant', () => {
    const feed = src('src/components/client-feed.tsx');
    expect(feed).toContain('lentaAdmission(');
    expect(feed).not.toContain('permissions.has(');
  });
});

describe('the 0127 columns stay out of every whole-row statement', () => {
  const COLUMNS = /\b(calc_request_id|tg_message_id|tg_chat_id)\b/g;

  it('3. every thread ping carries `extra.thread`', () => {
    const chat = src('src/modules/wms/crm/internal-chat.ts');
    const calls = [...chat.matchAll(/notifyStaffTelegram\(\{/g)];
    expect(calls.length).toBeGreaterThanOrEqual(1);
    for (const call of calls) {
      const body = chat.slice(call.index!, chat.indexOf('});', call.index!));
      expect(body).toMatch(/extra:\s*\{\s*thread:/);
    }
  });

  it('4. the lenta, the announce and the contact rule read them ONLY through to_jsonb', () => {
    for (const rel of [
      'src/modules/wms/crm/feed.ts',
      'src/modules/wms/crm/internal-chat.ts',
      'src/modules/wms/crm/first-contact.ts',
    ]) {
      const text = src(rel);
      for (const m of text.matchAll(COLUMNS)) {
        expect(text.slice(m.index! - 5, m.index!), `${rel}: bare ${m[1]}`).toBe("->> '");
      }
    }
    expect(src('src/modules/wms/crm/first-contact.ts')).toContain("(to_jsonb(ca) ->> 'calc_request_id') IS NULL");
    expect(src('src/modules/wms/crm/feed.ts')).toContain("to_jsonb(a) ->> 'calc_request_id'");
  });

  it('7. the drizzle table does not declare them, and only the thread module names them bare', () => {
    const schema = src('src/modules/platform/db/schema/wms.ts');
    const table = between(schema, 'export const crmActivities = pgTable(', '\n);\n');
    expect(table).not.toMatch(COLUMNS);
    expect(table).not.toMatch(/calcRequestId|tgChatId|tgMessageId/);

    // The three names are not unique to this table — `tg_messages` has its
    // own `tg_message_id`, `receipts` its own `calc_request_id` (0089) — so
    // the walk reads every source file that queries `crm_activities` and
    // demands the json road there, and only the thread module may go bare.
    // The schema file is the table assertion above; the migrations are DDL.
    const allowed = new Set(['src/modules/wms/crm/thread.ts', 'src/modules/wms/crm/thread-reply.ts']);
    const offenders: string[] = [];
    let readers = 0;
    const walk = (dir: string) => {
      for (const name of readdirSync(join(ROOT, dir))) {
        const rel = `${dir}/${name}`;
        if (statSync(join(ROOT, rel)).isDirectory()) {
          walk(rel);
          continue;
        }
        if (!/\.(ts|tsx)$/.test(name) || allowed.has(rel) || rel.startsWith('src/modules/platform/db/schema/')) {
          continue;
        }
        const text = src(rel);
        if (!/crm_activities|crmActivities/.test(text)) continue;
        readers += 1;
        for (const m of text.matchAll(COLUMNS)) {
          if (text.slice(m.index! - 5, m.index!) !== "->> '") offenders.push(`${rel}: ${m[1]}`);
        }
      }
    };
    walk('src');
    expect(readers, 're-anchor: no crm_activities readers found').toBeGreaterThanOrEqual(10);
    expect(offenders).toEqual([]);
  });
});

describe('the dock reads a bounded window through its own index', () => {
  it('12. the ping index lists exactly THREAD_PING_TYPES, the code writes them as literals, both scans are capped', () => {
    const migration = raw('src/modules/platform/db/migrations/0127_staff_threads.sql');
    const index = between(migration, 'CREATE INDEX "notifications_thread_idx"', ';');
    const listed = [...index.slice(index.indexOf('"type" IN')).matchAll(/'([A-Za-z]+)'/g)].map((m) => m[1]);
    expect(listed).toEqual([...THREAD_PING_TYPES]);

    const thread = src('src/modules/wms/crm/thread.ts');
    // A bound parameter list cannot prove a partial index's predicate under a generic plan.
    expect(thread).toMatch(/const THREAD_PING_LIST = sql\.raw\(/);
    const statement = between(thread, 'WITH mine AS (', '), cand AS (');
    expect(statement.match(/LIMIT \$\{DOCK_SCAN_ROWS\}/g)?.length).toBe(2);
    expect(statement).toContain('n.type IN (${THREAD_PING_LIST})');
  });
});

describe('one clock on one card', () => {
  it('13. the lenta and the dock print the office’s time, as the thread (next-intl) does', () => {
    // The fold prints a calc message in Asia/Tashkent; the lenta beside it
    // printed the SERVER's clock — UTC in the container — so the same message
    // read 19:08 in one and 14:08 in the other (found in the round's screenshot).
    expect(src('src/components/client-feed.tsx')).toMatch(/item\.at\.toLocaleString\('ru-RU', \{[^}]*timeZone: OFFICE_TZ/);
    expect(src('src/components/dock.tsx')).toMatch(/new Date\(row\.at\)\.toLocaleString\('ru-RU', \{[^}]*timeZone: OFFICE_TZ/);
  });
});

describe('the read mark follows what is on screen', () => {
  it('14. the mark carries the drawn «as of», and a refresh that brings a newer one marks again', () => {
    const seen = src('src/components/thread-seen.tsx');
    // The effect's key is built from the refs AND their instant — a
    // router.refresh() re-renders with new props and never remounts.
    const ref = { kind: 'calc' as const, id: '0190a1b2-c3d4-7e5f-8a9b-0c1d2e3f4a5b' };
    const before = readMarkKey([{ ...ref, asOf: '2026-10-07T10:00:00.000001Z' }]);
    const after = readMarkKey([{ ...ref, asOf: '2026-10-07T10:00:05.000001Z' }]);
    expect(before).not.toBe(after);
    expect(readMarkKey([{ ...ref, asOf: null }])).toBe('');
    expect(seen).toContain('const key = readMarkKey(refs);');
    expect(seen).toMatch(/useEffect\(\(\) => \{[\s\S]*?\}, \[key\]\)/);
    const fold = src('src/components/thread-fold.tsx');
    expect(fold).toMatch(/markThreadsRead\(\[\{ kind: 'calc', id: requestId, asOf \}\]\)/);
    expect(fold).toContain('}, [open, requestId, asOf]);');
    // The calc page's instant is the pulse's own token, so the pulse's refresh moves it.
    expect(src('src/app/(protected)/hisoblash/[id]/page.tsx')).toContain(
      '<ThreadSeen refs={[{ ...threadRef, asOf: threadBaseline !== null ? asOfOfToken(threadBaseline) : null }]} />',
    );
    // The route never stamps the server's clock for a browser's mark.
    expect(src('src/app/api/threads/read/route.ts')).toContain('markThreadRead(actor.id, thread, ref.asOf)');
  });

  it('15. every screen that draws a thread marks it from the page’s own read — the karta included', () => {
    const pages = [
      'src/app/(protected)/crm/leads/[id]/page.tsx',
      'src/app/(protected)/bitimlar/[id]/page.tsx',
      'src/app/(protected)/admin/clients/[id]/page.tsx',
      'src/app/(protected)/hisoblash/[id]/karta/page.tsx',
    ];
    for (const page of pages) {
      const text = src(page);
      expect(text, page).toContain('<ThreadSeen refs={readMarks} />');
      expect(text, page).toMatch(/const readMarks = await threadReadMarks\(\[/);
    }
    // The karta marks the LEAD (the one thread its reader's door admits).
    expect(between(src('src/app/(protected)/hisoblash/[id]/karta/page.tsx'), 'await threadReadMarks([', ']);')).toContain(
      "kind: 'lead' as const, id: lead.id",
    );
  });

  it('16. a same-page link to a fold opens it: Next fires no hashchange, so the click is caught in the capture phase', () => {
    const open = src('src/components/thread-hash-open.tsx');
    expect(open).toContain("document.addEventListener('click', onClick, true)");
    expect(open).toContain('url.pathname !== window.location.pathname');
  });

  it('17. a dock with fewer than three tabs keeps every word', () => {
    const dock = src('src/components/dock.tsx');
    expect(dock).toContain('const tabCount = 1 + Number(canChat) + Number(canThreads);');
    expect(between(dock, 'const tabWord = (active: boolean) =>', ';')).toMatch(/tabCount < 3\s*\? 'ml-1'/);
  });
});

describe('the VED’s floor warning (Q1 a: the line under the field is the whole guard)', () => {
  /** Every `<CalcThread …>` element in src — each is a box the VED can type the calc thread into. */
  function calcThreadMounts(): Array<{ rel: string; element: string }> {
    const found: Array<{ rel: string; element: string }> = [];
    const walk = (dir: string) => {
      for (const name of readdirSync(join(ROOT, dir))) {
        const rel = `${dir}/${name}`;
        if (statSync(join(ROOT, rel)).isDirectory()) {
          walk(rel);
          continue;
        }
        if (!name.endsWith('.tsx')) continue;
        const text = src(rel);
        for (const m of text.matchAll(/<CalcThread\b(?!Box)[\s\S]*?\/>/g)) found.push({ rel, element: m[0] });
      }
    };
    walk('src');
    return found;
  }

  it('18. the box prints its hint under the input and the send button, and the thread hands it through', () => {
    const box = src('src/components/calc-thread-box.tsx');
    const send = box.indexOf('data-testid="calc-thread-send"');
    expect(send).toBeGreaterThan(0);
    expect(box.indexOf('{hint ? <p', send), 'the hint is drawn after the send button').toBeGreaterThan(send);
    expect(src('src/components/calc-thread.tsx')).toMatch(/<CalcThreadBox\b[^>]*\bhint=\{hint\}/);
  });

  it('19. EVERY web mount of the calc thread carries calcHint for the VED — the calc page and the card fold', () => {
    const mounts = calcThreadMounts();
    expect(mounts.map((m) => m.rel).sort()).toEqual([
      'src/app/(protected)/hisoblash/[id]/page.tsx',
      'src/components/calc-panel.tsx',
    ]);
    for (const { rel, element } of mounts) expect(element, rel).toMatch(/\bhint=\{[^}]*tth\('calcHint'\)/);
    // The card fold is read by the seller too: the warning is the VED's, so
    // it is gated on his permission and nobody else's.
    const panel = mounts.find((m) => m.rel === 'src/components/calc-panel.tsx')!.element;
    expect(panel).toContain("hint={vedDoor ? tth('calcHint') : null}");
    expect(src('src/components/calc-panel.tsx')).toContain("const vedDoor = actor.permissions.has('ved.docs');");
    // The VED reaches that fold on his karta: the panel is mounted there.
    expect(src('src/app/(protected)/hisoblash/[id]/karta/page.tsx')).toContain('<CalcPanel');
  });
});

describe('the words (#163 — anchored on the code, never bundle-vs-bundle)', () => {
  const bundles = ['uz', 'ru', 'en', 'zh-CN'].map((locale) => ({
    locale,
    data: JSON.parse(raw(`messages/${locale}.json`)) as Record<string, Record<string, unknown>>,
  }));
  const has = (data: Record<string, unknown>, path: string) =>
    path.split('.').reduce<unknown>((node, key) => (node as Record<string, unknown> | undefined)?.[key], data) !==
    undefined;

  it('every code the calc action answers and every reason it names has words in all four bundles', () => {
    const thread = src('src/modules/wms/crm/thread.ts');
    const union = between(thread, 'readonly code:', ')');
    const codes = [...union.matchAll(/'([a-z_]+)'/g)].map((m) => m[1]!);
    expect(codes.length).toBeGreaterThanOrEqual(4);
    for (const code of codes) expect(CALC_THREAD_ERRORS, code).toContain(code);
    for (const { locale, data } of bundles) {
      for (const code of CALC_THREAD_ERRORS) expect(has(data, `threads.errors.${code}`), `${locale} ${code}`).toBe(true);
      for (const reason of UNREACHABLE_REASONS) {
        expect(has(data, `threads.unreachable.${reason}`), `${locale} ${reason}`).toBe(true);
      }
    }
  });

  it('every threads.* key a component names exists in all four bundles', () => {
    const files = [
      'src/components/dock.tsx',
      'src/components/calc-panel.tsx',
      'src/components/client-feed.tsx',
      'src/components/calc-thread.tsx',
      'src/components/calc-thread-box.tsx',
      'src/app/(protected)/hisoblash/[id]/page.tsx',
      'src/app/(protected)/profile/page.tsx',
    ];
    const keys = new Set<string>();
    for (const rel of files) {
      const text = src(rel);
      const names = [
        ...text.matchAll(/const (\w+) = (?:await )?(?:useTranslations|getTranslations)\('threads'\)/g),
      ].map((m) => m[1]!);
      expect(names.length, `${rel} binds a threads translator`).toBeGreaterThan(0);
      for (const name of names) {
        for (const m of text.matchAll(new RegExp(`\\b${name}\\('([^']+)'`, 'g'))) keys.add(m[1]!);
      }
    }
    expect(keys.size).toBeGreaterThanOrEqual(15);
    for (const { locale, data } of bundles) {
      for (const key of keys) expect(has(data, `threads.${key}`), `${locale} threads.${key}`).toBe(true);
    }
  });
});
