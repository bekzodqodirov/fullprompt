/**
 * Node-only boot: pg-boss workers + Telegram bot (single-process deployment,
 * spec §3). Resilient by design — a database or network hiccup at boot must
 * never take the web app down; workers retry in the background instead.
 */
const start = async () => {
  const { startBoss } = await import('./modules/platform/jobs/boss');
  await startBoss();
  const { startTelegramBot } = await import('./modules/platform/telegram/bot');
  startTelegramBot();
};

/**
 * The system watching itself (B9), wired once per process and never fatal:
 *  - every Bot API answer tells `recordBotState` when the TOKEN flips between
 *    working and refused — installed here, in the app, so a test or a script
 *    that sends through the same module never writes the company's alarm;
 *  - a note the watchdog left before it killed the last process becomes one
 *    «ilova qayta ishga tushirildi» row on /admin/xatolar.
 */
const watch = async () => {
  const { setBotStateListener } = await import('./modules/platform/telegram/send');
  const { recordBotState } = await import('./modules/platform/diagnostics/signals');
  setBotStateListener(recordBotState);
  const { recordWatchdogRestart } = await import('./modules/platform/diagnostics/errors');
  await recordWatchdogRestart();
};

void watch().catch((err) => console.error('system watch failed to start:', err));

const attempt = (retryMs: number) => {
  start().catch((err) => {
    console.error(`background workers failed to start, retrying in ${retryMs / 1000}s:`, err);
    setTimeout(() => attempt(Math.min(retryMs * 2, 60_000)), retryMs);
  });
};

attempt(5_000);

export {};
