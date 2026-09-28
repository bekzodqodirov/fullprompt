import { readdirSync, readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';
import {
  isServerCmdline,
  KILL_AFTER,
  probeVerdict,
  startTimeFromStat,
  WATCHDOG_MARK_FILE as PROBE_MARK_FILE,
} from '../../ops/health-probe.mjs';
import { mergeDisks, nextDiskLevel, parseDiskDetail, readingFrom, sameDisk } from '@/modules/platform/backup/disk';
import { EXPECTED_MIGRATIONS, ledgerState } from '@/modules/platform/db/ledger';
import {
  __resetErrorBrake,
  digestQuery,
  errorKey,
  mayReadSystemErrors,
  mayWrite,
  pathOnly,
  SAME_KEY_QUIET_MS,
  sessionFromCookie,
  WATCHDOG_MARK_FILE,
  WRITES_PER_MINUTE,
} from '@/modules/platform/diagnostics/errors';
import { poolState } from '@/modules/platform/diagnostics/health';
import { FOUNDERS, isTelegramMuted, MUTE_GROUPS } from '@/modules/platform/notifications/mutes';
import { openDoors } from '@/app/(protected)/admin/hub-doors';
import {
  adminQuietText,
  managerQuietText,
  quietAction,
  QUIET_REALARM_MS,
  type QuietAccount,
} from '@/modules/wms/crm/listener-quiet';
import { QUIET_ALARM_MS } from '@/modules/wms/crm/telegram-live';

/**
 * B9, the system watching itself — every rule here that is pure, pinned on
 * the real function (#166), plus the source fences for the wiring no
 * behavioural test can reach. Comments are stripped before a fence reads a
 * file (#725: a fence that matches the sentence explaining the rule tests
 * nothing).
 */
const read = (p: string) =>
  readFileSync(p, 'utf8')
    .replace(/\/\*[\s\S]*?\*\//g, '')
    .replace(/^\s*\/\/.*$/gm, '');

describe('the watchdog probe (ops/health-probe.mjs)', () => {
  const SERVER = '4711';
  const down = { answered: false };
  const stuck = { answered: true, pool: 'stuck' };

  it('a 503 for MinIO or the database is healthy HERE — a restart fixes neither', () => {
    const v = probeVerdict(null, { answered: true, pool: 'ok' }, SERVER);
    expect(v).toMatchObject({ healthy: true, kill: false, state: { armed: true, failures: 0 } });
    // The database down entirely reads `pool: 'down'` — still no kill.
    const w = probeVerdict(v.state, { answered: true, pool: 'down' }, SERVER);
    expect(w).toMatchObject({ healthy: true, kill: false });
  });

  it('never kills a server that has not answered once (a slow boot)', () => {
    let state = null as ReturnType<typeof probeVerdict>['state'] | null;
    for (let i = 0; i < KILL_AFTER * 3; i += 1) {
      const v = probeVerdict(state, down, SERVER);
      expect(v.kill, `probe ${i + 1}`).toBe(false);
      state = v.state;
    }
  });

  it('kills on the third armed failure — silence or a stuck pool alike', () => {
    const armed = probeVerdict(null, { answered: true, pool: 'ok' }, SERVER).state;
    const one = probeVerdict(armed, down, SERVER);
    const two = probeVerdict(one.state, stuck, SERVER);
    const three = probeVerdict(two.state, down, SERVER);
    expect([one.kill, two.kill, three.kill]).toEqual([false, false, true]);
    // One good answer in between starts the count again.
    const healed = probeVerdict(two.state, { answered: true, pool: 'ok' }, SERVER);
    expect(probeVerdict(healed.state, down, SERVER).kill).toBe(false);
  });

  it('an ARMED state left by the killed process never arms the next one (the judge, finding 3)', () => {
    // /tmp survives a restart: the file still says «armed, two failures» for
    // the process that was killed. The new server has a new start time.
    const stale = { serverStart: 'old-process', armed: true, failures: 2 };
    let state: ReturnType<typeof probeVerdict>['state'] = stale;
    for (let i = 0; i < KILL_AFTER; i += 1) {
      const v = probeVerdict(state, down, SERVER);
      expect(v.kill, `probe ${i + 1} after the restart`).toBe(false);
      state = v.state;
    }
  });

  it('with no server process found, nothing is armed and nothing is killed', () => {
    const armed = { serverStart: null, armed: true, failures: 5 };
    expect(probeVerdict(armed, down, null).kill).toBe(false);
  });

  it('reads field 22 of /proc/<pid>/stat even when the command name holds spaces', () => {
    const fields = Array.from({ length: 50 }, (_, i) => String(i + 3));
    const stat = `123 (node server (x)) ${fields.join(' ')}`;
    expect(startTimeFromStat(stat)).toBe('22');
  });

  it('finds `node server.js` and never itself', () => {
    expect(isServerCmdline('node\0server.js\0')).toBe(true);
    expect(isServerCmdline('node\0/app/server.js\0')).toBe(true);
    expect(isServerCmdline('node\0/app/ops/health-probe.mjs\0')).toBe(false);
    expect(isServerCmdline('node\0scripts/start-standalone.mjs\0')).toBe(false);
  });

  it('leaves its note where the next boot reads it', () => {
    expect(PROBE_MARK_FILE).toBe(WATCHDOG_MARK_FILE);
  });
});

describe('the disk alarm', () => {
  it('rises at 80 and at 90, and says so once per step', () => {
    expect(nextDiskLevel(0, 79)).toEqual({ level: 0, alert: false });
    expect(nextDiskLevel(0, 81)).toEqual({ level: 80, alert: true });
    expect(nextDiskLevel(80, 85)).toEqual({ level: 80, alert: false });
    expect(nextDiskLevel(80, 91)).toEqual({ level: 90, alert: true });
    expect(nextDiskLevel(90, 95)).toEqual({ level: 90, alert: false });
  });

  it('falls only five points below its step, and never out loud', () => {
    // Hovering around a step is the backup night, not a cleanup.
    expect(nextDiskLevel(90, 86)).toEqual({ level: 90, alert: false });
    expect(nextDiskLevel(80, 76)).toEqual({ level: 80, alert: false });
    expect(nextDiskLevel(90, 84)).toEqual({ level: 80, alert: false });
    expect(nextDiskLevel(90, 70)).toEqual({ level: 0, alert: false });
    expect(nextDiskLevel(80, 74)).toEqual({ level: 0, alert: false });
    // …and climbing back past 90 after a real fall is news again.
    expect(nextDiskLevel(80, 91)).toMatchObject({ alert: true });
  });

  it('reads a disk the way df does: used ÷ (used + available)', () => {
    const r = readingFrom({ type: 61267, bsize: 4096, blocks: 1000, bfree: 150, bavail: 100 })!;
    expect(r.usedPct).toBe(Math.round((850 / 950) * 100));
    expect(r.freeBytes).toBe(100 * 4096);
    expect(r.totalBytes).toBe(1000 * 4096);
    expect(readingFrom({ type: 1, bsize: 0, blocks: 0, bfree: 0, bavail: 0 })).toBeNull();
  });

  it('two readings of one filesystem are ONE disk — one line and one alarm (the judge, finding 10)', () => {
    const a = readingFrom({ type: 61267, bsize: 4096, blocks: 1000, bfree: 100, bavail: 50 })!;
    const b = { ...a, freeBytes: a.freeBytes - 4096 };
    expect(sameDisk(a, b)).toBe(true);
    expect(mergeDisks(a, b).map((l) => l.key)).toEqual(['one']);
    const other = readingFrom({ type: 61267, bsize: 4096, blocks: 2000, bfree: 100, bavail: 50 })!;
    expect(mergeDisks(a, other).map((l) => l.key)).toEqual(['db', 'photos']);
    // A disk we could not read stays its own line, printed «noma'lum».
    expect(mergeDisks(a, null)).toEqual([
      { key: 'db', reading: a },
      { key: 'photos', reading: null },
    ]);
  });

  it('parses the stored detail the home row prints, and refuses junk', () => {
    expect(parseDiskDetail('one:82:15032385536')).toEqual({ key: 'one', usedPct: 82, freeBytes: 15032385536 });
    expect(parseDiskDetail('x:82:1')).toBeNull();
    expect(parseDiskDetail(null)).toBeNull();
  });
});

describe('the schema ledger', () => {
  it('expects exactly the migrations this code ships — the journal, which is the *.sql files', () => {
    const files = readdirSync('src/modules/platform/db/migrations').filter((f) => f.endsWith('.sql'));
    expect(EXPECTED_MIGRATIONS).toBe(files.length);
  });

  it('names behind, ahead and ok', () => {
    expect(ledgerState(111, 113)).toBe('behind');
    expect(ledgerState(114, 113)).toBe('ahead');
    expect(ledgerState(113, 113)).toBe('ok');
  });
});

describe('the error recorder, pure halves', () => {
  it('keys a render by its digest (the @E code dropped) and a route by route + message', () => {
    expect(errorKey({ digest: '2832070603', routePath: '/x', message: 'm' })).toBe('2832070603');
    expect(errorKey({ digest: '2832070603@E394', routePath: '/x', message: 'm' })).toBe('2832070603');
    const a = errorKey({ digest: null, routePath: '/api/a', message: 'boom' });
    expect(a).toMatch(/^[0-9a-f]{12}$/);
    expect(errorKey({ digest: null, routePath: '/api/a', message: 'boom' })).toBe(a);
    expect(errorKey({ digest: null, routePath: '/api/b', message: 'boom' })).not.toBe(a);
  });

  it('stores the path WITHOUT its query — a query carries phone numbers', () => {
    expect(pathOnly('/admin/clients?q=+998901234567')).toBe('/admin/clients');
    expect(pathOnly('/x#frag')).toBe('/x');
    expect(pathOnly(null)).toBeNull();
  });

  it('reads the number a person types from a screenshot', () => {
    expect(digestQuery('#2832070603')).toBe('2832070603');
    expect(digestQuery(' 2832070603@E394 ')).toBe('2832070603');
    expect(digestQuery('abc def')).toBeNull();
    expect(digestQuery("'; drop")).toBeNull();
  });

  it('finds the session cookie in a header string or list', () => {
    expect(sessionFromCookie('a=1; gsr_session=tok%2Dx; b=2')).toBe('tok-x');
    expect(sessionFromCookie(['a=1', 'gsr_session=abc'])).toBe('abc');
    expect(sessionFromCookie(undefined)).toBeNull();
  });

  it('writes one key at most once per five seconds, and thirty keys a minute in all', () => {
    __resetErrorBrake();
    const t0 = 10_000_000;
    expect(mayWrite('k1', t0)).toBe(true);
    expect(mayWrite('k1', t0 + SAME_KEY_QUIET_MS - 1)).toBe(false);
    expect(mayWrite('k1', t0 + SAME_KEY_QUIET_MS)).toBe(true);
    __resetErrorBrake();
    let granted = 0;
    for (let i = 0; i < WRITES_PER_MINUTE + 10; i += 1) if (mayWrite(`key-${i}`, t0 + i)) granted += 1;
    expect(granted).toBe(WRITES_PER_MINUTE);
    expect(mayWrite('late', t0 + 61_000)).toBe(true);
    __resetErrorBrake();
  });

  it('is the super admin ROLE, like the annul', () => {
    expect(mayReadSystemErrors({ roles: ['super_admin'] })).toBe(true);
    expect(mayReadSystemErrors({ roles: ['admin'] })).toBe(false);
  });
});

describe('the pool verdict', () => {
  it('stuck only when the pool lost and the side door answered', () => {
    expect(poolState(true, true)).toBe('ok');
    expect(poolState(true, false)).toBe('ok');
    expect(poolState(false, true)).toBe('stuck');
    expect(poolState(false, false)).toBe('down');
  });
});

describe('the quiet-bridge decision', () => {
  const now = new Date('2026-09-28T10:00:00Z');
  const ago = (ms: number) => new Date(now.getTime() - ms);
  const account = (over: Partial<QuietAccount> = {}): QuietAccount => ({
    id: 'a',
    managerUserId: 'u',
    managerName: 'Ali',
    status: 'active',
    lastSeenAt: ago(QUIET_ALARM_MS + 60_000),
    updatedAt: ago(QUIET_ALARM_MS + 60_000),
    hasSession: true,
    quietOpen: false,
    quietNotifiedAt: null,
    ...over,
  });

  it('says «jim» past the threshold and not before', () => {
    expect(quietAction(account(), now)).toBe('alarm');
    expect(quietAction(account({ lastSeenAt: ago(QUIET_ALARM_MS - 60_000) }), now)).toBeNull();
  });

  it('a container stopped and never back is quiet; one that never beat is measured from its connect', () => {
    expect(quietAction(account({ status: 'stopped' }), now)).toBe('alarm');
    expect(quietAction(account({ lastSeenAt: null, updatedAt: ago(QUIET_ALARM_MS + 1) }), now)).toBe('alarm');
    expect(quietAction(account({ lastSeenAt: null, updatedAt: ago(60_000) }), now)).toBeNull();
  });

  it('leaves a signed-out account to its own alarm, and a disconnected one to nobody', () => {
    expect(quietAction(account({ status: 'signed_out' }), now)).toBeNull();
    expect(quietAction(account({ hasSession: false }), now)).toBeNull();
  });

  it('says «qaytdi» only when LIVE — a single beat after the alarm is not a return (the judge, finding 7)', () => {
    expect(quietAction(account({ quietOpen: true, lastSeenAt: ago(10_000) }), now)).toBe('back');
    // Beat five minutes ago, after the alarm, and died again: still quiet.
    expect(
      quietAction(account({ quietOpen: true, quietNotifiedAt: ago(20 * 60_000), lastSeenAt: ago(5 * 60_000) }), now),
    ).toBeNull();
    expect(quietAction(account({ quietOpen: false, lastSeenAt: ago(10_000) }), now)).toBeNull();
  });

  it('waits an hour before saying «jim» again about the same account', () => {
    expect(quietAction(account({ quietNotifiedAt: ago(QUIET_REALARM_MS - 60_000) }), now)).toBeNull();
    expect(quietAction(account({ quietNotifiedAt: ago(QUIET_REALARM_MS + 60_000) }), now)).toBe('alarm');
  });

  it('tells the manager in words and the admins how to fix it', () => {
    expect(managerQuietText(23)).toContain('23 daqiqa');
    expect(managerQuietText(23)).not.toContain('docker');
    const admin = adminQuietText([
      { name: 'Ali', minutes: 23 },
      { name: 'Vali', minutes: 12 },
    ]);
    expect(admin).toContain('• Ali: 23 daqiqa');
    expect(admin).toContain('• Vali: 12 daqiqa');
    expect(admin).toContain('docker compose --profile telegram up -d tg-listen');
    expect(admin).toContain('docker compose --profile telegram logs --tail 50 tg-listen');
  });
});

describe('who hears the system (the judge, finding 8)', () => {
  it('the three system types are a group of their own, born whole', () => {
    expect([...MUTE_GROUPS.system]).toEqual(['TelegramListenerQuiet', 'TelegramListenerBack', 'DiskFilling']);
    expect([...FOUNDERS.system]).toEqual([...MUTE_GROUPS.system]);
    for (const type of MUTE_GROUPS.system) expect(MUTE_GROUPS.alerts as readonly string[]).not.toContain(type);
  });

  it('an admin who muted the price-control alarms still hears the disk', () => {
    const oldAlertsMute = [...MUTE_GROUPS.alerts];
    expect(isTelegramMuted(oldAlertsMute, 'MissingInTransit')).toBe(true);
    expect(isTelegramMuted(oldAlertsMute, 'DiskFilling')).toBe(false);
    expect(isTelegramMuted(oldAlertsMute, 'TelegramListenerQuiet')).toBe(false);
    expect(isTelegramMuted(['all'], 'DiskFilling')).toBe(true);
  });
});

describe('the hub door to the error list', () => {
  const everything = () => true;
  const xatolar = (doors: { href: string }[]) => doors.some((d) => d.href === '/admin/xatolar');

  it('is the super admin\'s — the role ANDed with the permission, never instead of it', () => {
    expect(xatolar(openDoors(everything, ['super_admin']))).toBe(true);
    expect(xatolar(openDoors(everything, ['admin']))).toBe(false);
    expect(xatolar(openDoors(everything))).toBe(false);
    // The role alone opens nothing the page's permission would not.
    expect(xatolar(openDoors((code) => code === 'platform.roles.manage', ['super_admin']))).toBe(false);
  });

  it('is asked with the person\'s roles by both the hub and its layout', () => {
    expect(read('src/app/(protected)/admin/page.tsx')).toMatch(/openDoors\([^;]*actor\.roles\)/);
    expect(read('src/app/(protected)/admin/layout.tsx')).toMatch(/const hasHub =\s*openDoors\([^;]*actor\.roles\)/);
    const page = read('src/app/(protected)/admin/xatolar/page.tsx');
    expect(page).toContain('mayReadSystemErrors(actor)');
  });
});

describe('source fences — the wiring', () => {
  it('onRequestError imports the recorder inside the node-runtime check', () => {
    const src = read('src/instrumentation.ts');
    const hook = src.slice(src.indexOf('export const onRequestError'));
    const check = hook.indexOf("if (process.env.NEXT_RUNTIME === 'nodejs')");
    const imp = hook.indexOf("await import('./modules/platform/diagnostics/errors')");
    expect(check).toBeGreaterThan(-1);
    expect(imp).toBeGreaterThan(check);
  });

  it('the app installs the bot-state listener at boot, and records the watchdog\'s note', () => {
    const boot = read('src/instrumentation-node.ts');
    expect(boot).toContain('setBotStateListener(recordBotState)');
    expect(boot).toContain('await recordWatchdogRestart()');
    // …and every Bot API answer passes through the memo.
    const send = read('src/modules/platform/telegram/send.ts');
    const botCall = send.slice(send.indexOf('export async function botCall'), send.indexOf('/** Telegram could not read'));
    expect(botCall).toContain('noteBotAnswer(res.status');
  });

  it('only signals.ts writes system_signals or names the bot key', () => {
    const offenders: string[] = [];
    const walk = (dir: string) => {
      for (const entry of readdirSync(dir, { withFileTypes: true })) {
        const path = `${dir}/${entry.name}`;
        if (entry.isDirectory()) walk(path);
        else if (/\.(ts|tsx)$/.test(entry.name) && path !== 'src/modules/platform/diagnostics/signals.ts') {
          const src = read(path);
          if (/insert\(systemSignals\)|update\(systemSignals\)|delete\(systemSignals\)|system_signals|'telegram:bot'/.test(src)) {
            offenders.push(path);
          }
        }
      }
    };
    walk('src');
    // The schema declares the table; nothing else may touch it.
    expect(offenders.filter((p) => !p.endsWith('db/schema/platform.ts'))).toEqual([]);
  });

  it('a broadcast never becomes a staff notification (its own recipient rows settle it)', () => {
    const send = read('src/modules/platform/broadcast/send.ts');
    expect(send).not.toMatch(/insert\(notifications\)/);
    expect(send).not.toMatch(/INSERT INTO notifications/i);
  });

  it('the problems list and the home counter are one predicate', () => {
    const page = read('src/app/(protected)/admin/notifications/page.tsx');
    expect(page).toContain('telegramProblemSql(problemSince())');
    expect(page).not.toMatch(/isNotNull\(notifications\.error\)/);
    const service = read('src/modules/platform/notifications/service.ts');
    const counter = service.slice(service.indexOf('export async function notificationProblemCount'));
    expect(counter.slice(0, counter.indexOf('\n}'))).toContain('telegramProblemSql(problemSince(sinceDays))');
  });

  it('every awaited health check is raced — no await the watchdog could wait on for ever', () => {
    const src = read('src/modules/platform/diagnostics/health.ts');
    const body = src.slice(src.indexOf('async function computeDeep'), src.indexOf('const globalForHealth'));
    // One await in the body, and it is the Promise.all of raced checks.
    expect(body.match(/\bawait\b/g)).toEqual(['await']);
    expect(body).toContain('await Promise.all([');
    // The array's top-level elements, split at the commas no bracket encloses.
    const open = body.indexOf('Promise.all([') + 'Promise.all(['.length;
    const checks: string[] = [];
    let depth = 0;
    let start = open;
    for (let i = open; i < body.length; i += 1) {
      const ch = body[i]!;
      if ('([{'.includes(ch)) depth += 1;
      else if (')]}'.includes(ch)) {
        if (depth === 0) {
          checks.push(body.slice(start, i));
          break;
        }
        depth -= 1;
      } else if (ch === ',' && depth === 0) {
        checks.push(body.slice(start, i));
        start = i + 1;
      }
    }
    const elements = checks.map((c) => c.trim()).filter(Boolean);
    expect(elements.length).toBe(5);
    for (const check of elements) expect(check.startsWith('bounded'), check).toBe(true);
  });

  it('the schema banner is drawn for the analyst roles and cannot throw', () => {
    const layout = read('src/app/(protected)/layout.tsx');
    expect(layout).toContain('isAnalyst(actor) && <SchemaBanner />');
    const banner = read('src/components/schema-banner.tsx');
    expect(banner).toMatch(/try \{[\s\S]*schemaLedger\(\)[\s\S]*\} catch/);
    // The command names the REBUILD, or it re-runs the stale image (the judge, finding 6).
    for (const locale of ['uz', 'ru', 'en', 'zh-CN']) {
      const messages = JSON.parse(readFileSync(`messages/${locale}.json`, 'utf8')) as {
        kuzatuv: { schemaBehind: string };
      };
      expect(messages.kuzatuv.schemaBehind, locale).toContain('docker compose build migrate && docker compose run --rm migrate');
    }
  });

  it('the error probe is not in a private folder the router would never serve (the judge, finding 1)', () => {
    const probe = read('src/app/(protected)/sinov-xato/page.tsx');
    expect(probe).toContain("process.env.ERROR_PROBE !== 'on'");
    expect(read('playwright.config.ts')).toContain("ERROR_PROBE: 'on'");
  });
});
