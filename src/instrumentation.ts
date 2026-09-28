import type { Instrumentation } from 'next';

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

/**
 * Every server error Next reports — a render, an action, a route handler —
 * becomes one counted row on /admin/xatolar (B9), so the digest in a staff
 * screenshot can be looked up. Same rule as `register`: the node-only import
 * sits inside the positive check. Not awaited past the import: the response
 * must never wait on the record of its own failure, and the recorder answers
 * rather than throws.
 */
export const onRequestError: Instrumentation.onRequestError = async (error, request, context) => {
  if (process.env.NEXT_RUNTIME === 'nodejs') {
    const { recordRequestError } = await import('./modules/platform/diagnostics/errors');
    void recordRequestError(error, request, context);
  }
};
