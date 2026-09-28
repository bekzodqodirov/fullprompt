/**
 * The app container's healthcheck AND its watchdog (B9).
 *
 * #714 measured the freeze this exists for: ten transactions each waiting for
 * an eleventh pool connection, every page of the app stopped with them, and
 * nothing to recover it but a person restarting the container. Postgres's
 * `idle_in_transaction_session_timeout` (docker-compose.yml) now breaks that
 * knot from the database's side; this is the other side, for whatever the
 * next freeze turns out to be.
 *
 * Docker does NOT restart an unhealthy container — `unhealthy` is a word in
 * `docker ps` and nothing more — so the probe acts itself: after
 * `KILL_AFTER` failures in a row it SIGKILLs the Next server, tini (the
 * compose `init: true`) exits with it, and `restart: unless-stopped` brings
 * the app back. Without `init: true` node would be PID 1, which a process in
 * its own namespace cannot kill, and a hung event loop never runs its own
 * SIGTERM handler.
 *
 * What counts as a failure is the whole design:
 *  - HEALTHY = any HTTP answer inside `ANSWER_MS` whose `pool` is not
 *    `stuck`. A 503 because MinIO or postgres is down is healthy HERE: a
 *    restart cannot fix either, and killing on it would turn an outage into a
 *    restart loop;
 *  - the probe ARMS only after the server's first healthy answer, so a slow
 *    boot is never killed (compose's `start_period` only changes what Docker
 *    reports — it does not stop this script);
 *  - the armed state and the streak live in a file (every healthcheck is a
 *    fresh node process), KEYED ON THE SERVER PROCESS'S START TIME. `/tmp`
 *    survives a restart, so a state file left armed by the process that was
 *    just killed would otherwise arm the NEXT process before its first answer
 *    and kill its slow boot — the package judge's third finding.
 *
 * Before it kills, it leaves a note at `WATCHDOG_MARK_FILE`; the next boot
 * records «ilova qayta ishga tushirildi» on /admin/xatolar and removes it.
 *
 * Node builtins only: the runner image is `node:22-slim`, with no curl.
 */
import { readdirSync, readFileSync, writeFileSync } from 'node:fs';
import { pathToFileURL } from 'node:url';

export const HEALTH_URL = 'http://127.0.0.1:3000/api/health';
/** The server must answer inside this — the health route's own checks cap at 3 s. */
export const ANSWER_MS = 10_000;
/** Consecutive armed failures before the kill (×30 s interval = 90 s). */
export const KILL_AFTER = 3;
export const STATE_FILE = '/tmp/gsr-health-probe.json';
/** Read by `recordWatchdogRestart` (platform/diagnostics/errors.ts). */
export const WATCHDOG_MARK_FILE = '/tmp/gsr-watchdog';

/**
 * The decision, pure. `state` is what the last probe left (or null),
 * `seen` what this one observed, `serverStart` the running server's start
 * time (or null when no server process was found — nothing to kill, and no
 * reason to believe an old armed state).
 *
 * @param {{ serverStart: string | null, armed: boolean, failures: number } | null} state
 * @param {{ answered: boolean, pool?: string | null }} seen
 * @param {string | null} serverStart
 * @returns {{ state: { serverStart: string | null, armed: boolean, failures: number }, healthy: boolean, kill: boolean }}
 */
export function probeVerdict(state, seen, serverStart) {
  const current =
    state && serverStart !== null && state.serverStart === serverStart
      ? state
      : { serverStart, armed: false, failures: 0 };
  const healthy = seen.answered === true && seen.pool !== 'stuck';
  if (healthy) return { state: { serverStart, armed: true, failures: 0 }, healthy: true, kill: false };
  if (!current.armed || serverStart === null) {
    return { state: { ...current, failures: 0 }, healthy: false, kill: false };
  }
  const failures = current.failures + 1;
  return { state: { ...current, failures }, healthy: false, kill: failures >= KILL_AFTER };
}

/**
 * `/proc/<pid>/stat` field 22 — the process's start time in clock ticks since
 * boot. The command name (field 2) may hold spaces, so the fields are counted
 * after its closing parenthesis, where field 3 begins.
 *
 * @param {string} stat
 * @returns {string | null}
 */
export function startTimeFromStat(stat) {
  const close = stat.lastIndexOf(')');
  if (close === -1) return null;
  const fields = stat.slice(close + 1).trim().split(/\s+/);
  return fields[22 - 3] ?? null;
}

/**
 * The Next server — `node server.js` — and never this probe, whose own command
 * line names this file.
 *
 * @param {string} cmdline NUL-separated, as /proc gives it
 */
export function isServerCmdline(cmdline) {
  const args = cmdline.split('\0').filter(Boolean);
  return args.some((arg) => arg === 'server.js' || arg.endsWith('/server.js')) && !cmdline.includes('health-probe');
}

function findServer() {
  for (const entry of readdirSync('/proc')) {
    if (!/^\d+$/.test(entry)) continue;
    try {
      if (!isServerCmdline(readFileSync(`/proc/${entry}/cmdline`, 'utf8'))) continue;
      const start = startTimeFromStat(readFileSync(`/proc/${entry}/stat`, 'utf8'));
      if (start) return { pid: Number(entry), start };
    } catch {
      // A process that ended while we looked — not ours to worry about.
    }
  }
  return null;
}

async function observe() {
  try {
    const res = await fetch(HEALTH_URL, { signal: AbortSignal.timeout(ANSWER_MS) });
    let pool = null;
    try {
      pool = (await res.json())?.pool ?? null;
    } catch {
      pool = null;
    }
    return { answered: true, pool };
  } catch {
    return { answered: false, pool: null };
  }
}

function readState() {
  try {
    return JSON.parse(readFileSync(STATE_FILE, 'utf8'));
  } catch {
    return null;
  }
}

async function main() {
  const server = findServer();
  const seen = await observe();
  const verdict = probeVerdict(readState(), seen, server?.start ?? null);
  try {
    writeFileSync(STATE_FILE, JSON.stringify(verdict.state));
  } catch {
    // A read-only /tmp must not turn a healthy answer into an unhealthy one.
  }
  if (verdict.kill && server) {
    const reason = seen.answered ? 'pool stuck' : "server javob bermadi";
    try {
      writeFileSync(
        WATCHDOG_MARK_FILE,
        JSON.stringify({ at: new Date().toISOString(), reason, failures: verdict.state.failures }),
      );
    } catch {
      // The note is a courtesy; the restart is the point.
    }
    console.error(`[watchdog] ${reason} ×${verdict.state.failures} — killing pid ${server.pid}`);
    process.kill(server.pid, 'SIGKILL');
  }
  process.exit(verdict.healthy ? 0 : 1);
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  void main();
}
