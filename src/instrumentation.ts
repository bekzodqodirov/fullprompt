/**
 * Next.js server-boot hook. The import MUST sit directly inside the positive
 * NEXT_RUNTIME check — that is the pattern webpack's define-plugin can
 * dead-code-eliminate when compiling the edge variant of this file (edge has
 * no Node builtins, so tracing the worker graph there breaks the dev server).
 */
export async function register() {
  if (process.env.NEXT_RUNTIME === 'nodejs') {
    await import('./instrumentation-node');
  }
}
