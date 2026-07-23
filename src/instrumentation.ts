/**
 * Next.js server-boot hook: starts pg-boss workers and the Telegram bot
 * alongside the web server (single-process deployment, spec §3).
 *
 * Resilient by design: a database or network hiccup at boot must NEVER take
 * the web app down — workers retry in the background until they come up.
 */
export async function register() {
  if (process.env.NEXT_RUNTIME !== 'nodejs') return;

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
}
