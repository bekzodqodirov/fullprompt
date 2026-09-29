/** Types for the container's watchdog probe (ops/health-probe.mjs), for its unit test. */
export interface ProbeState {
  serverStart: string | null;
  armed: boolean;
  failures: number;
}

export declare const HEALTH_URL: string;
export declare const ANSWER_MS: number;
export declare const KILL_AFTER: number;
export declare const STATE_FILE: string;
export declare const WATCHDOG_MARK_FILE: string;

export declare function probeVerdict(
  state: ProbeState | null,
  seen: { answered: boolean; pool?: string | null },
  serverStart: string | null,
): { state: ProbeState; healthy: boolean; kill: boolean };

export declare function startTimeFromStat(stat: string): string | null;
export declare function isServerCmdline(cmdline: string): boolean;
export declare function findServer(procDir?: string): { pid: number; start: string } | null;
