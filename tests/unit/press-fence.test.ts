import { describe, expect, it } from 'vitest';
import { srcFiles } from '../fixtures/source-shape';

/**
 * `answerPress` is the ONLY caller of answerCallbackQuery (Q5 a) — DERIVED
 * over all of `src/`: a late press must be a logged no-op, and a bare
 * `ctx.answerCallbackQuery()` throws «query is too old» into bot.catch and
 * aborts whatever the handler was about to do. A type member
 * `answerCallbackQuery:` is a declaration, not a call.
 */
const SRC = srcFiles();

describe('the one answer to a press', () => {
  it('every answerCallbackQuery CALL in src is the one inside press.ts', () => {
    const calls = SRC.flatMap((f) =>
      [...f.text.matchAll(/\.answerCallbackQuery\(/g)].map(() => f.path.replace(/\\/g, '/')),
    );
    expect(calls).toEqual(['src/modules/platform/telegram/press.ts']);
  });

  it('the scan finds the wrapper where the presses are (#720)', () => {
    for (const file of ['staff-handlers.ts', 'task-handlers.ts', 'client-cabinet.ts']) {
      const f = SRC.find((s) => s.path.endsWith(`telegram/${file}`));
      expect(f, `re-anchor: ${file}`).toBeDefined();
      expect([...f!.text.matchAll(/answerPress\(/g)].length, file).toBeGreaterThan(0);
    }
  });

  it('`say: false` marks exactly the two progress notices (the zametka send, the cabinet 📷)', () => {
    const sites = SRC.flatMap((f) =>
      [...f.text.matchAll(/answerPress\(ctx, [^\n]*?\{ say: false \}\)/g)].map((m) => `${f.path}: ${m[0]}`),
    );
    expect(sites).toHaveLength(2);
    expect(sites.some((s) => s.includes('staff-handlers.ts') && s.includes('📤 Yuborilmoqda…'))).toBe(true);
    expect(sites.some((s) => s.includes('client-cabinet.ts') && s.includes('photoSending'))).toBe(true);
  });
});
