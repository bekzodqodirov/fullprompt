/**
 * Next.js server-boot hook: starts pg-boss workers alongside the web server
 * (single-process deployment, spec §3 — no separate worker container in v1).
 */
export async function register() {
  if (process.env.NEXT_RUNTIME === 'nodejs') {
    const { startBoss } = await import('./modules/platform/jobs/boss');
    await startBoss();
    const { startTelegramBot } = await import('./modules/platform/telegram/bot');
    startTelegramBot();
  }
}
