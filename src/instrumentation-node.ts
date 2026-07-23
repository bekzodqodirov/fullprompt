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

const attempt = (retryMs: number) => {
  start().catch((err) => {
    console.error(`background workers failed to start, retrying in ${retryMs / 1000}s:`, err);
    setTimeout(() => attempt(Math.min(retryMs * 2, 60_000)), retryMs);
  });
};

attempt(5_000);

export {};
