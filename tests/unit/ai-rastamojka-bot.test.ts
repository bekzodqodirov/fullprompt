import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';
import { escapesIntake, parseCallback } from '@/modules/platform/telegram/staff-bot';

/**
 * The «🤖 AI rastamojka» door (the owner's own words, 2026-09-05).
 *
 * A grammy handler cannot be exercised without a Telegram, so what a shell
 * can prove is proven behaviourally (the callback vocabulary) and the rest is
 * SOURCE SHAPE — the rules whose breach leaves every screen rendering and
 * every test green while the seller's collection is silently discarded, the
 * certificate never reaches the request, or the machine quotes freight it was
 * told never to quote.
 *
 * Comments are stripped first (#725).
 */
const read = (p: string) =>
  readFileSync(p, 'utf8')
    .replace(/\/\*[\s\S]*?\*\//g, '')
    .replace(/^\s*\/\/.*$/gm, '');

describe('the callback vocabulary', () => {
  it('carries the AI door, the restart twins, the certificate and the skip', () => {
    for (const step of ['ai', 'go_ai', 'go_rastamojka', 'cert', 'skip']) {
      expect(parseCallback(`c:${step}`), step).toEqual({ kind: 'calc', step });
    }
  });

  it('still refuses anything that is not a step', () => {
    expect(parseCallback('c:drop_table')).toBeNull();
    expect(parseCallback('c:')).toBeNull();
    expect(parseCallback('x:ai')).toBeNull();
  });
});

describe('the rules a shell cannot exercise', () => {
  const handlers = read('src/modules/platform/telegram/staff-handlers.ts');

  it('the AI door fixes the section to rastamojka — the machine never quotes freight', () => {
    // The owner's decision 8. A `startIntake(chatId, 'ai')` would be a
    // section the whole engine does not have, and a podklyuch one would put
    // a freight figure in a reply that promises not to carry one.
    expect(handlers).toContain("startIntake(chatId, opening === 'ai' ? 'rastamojka' : opening");
  });

  it('a live collection is never replaced without asking', () => {
    // The restart question is what stands between «I pressed the wrong
    // button» and twenty forwarded messages gone.
    const at = handlers.indexOf("if (!step.startsWith('go_') && activeIntake(chatId))");
    expect(at, 'the restart guard has moved — re-anchor this fence').toBeGreaterThan(-1);
    // …and it must come BEFORE the state is minted, or it guards nothing.
    expect(at).toBeLessThan(handlers.indexOf('startIntake(chatId, opening'));
  });

  it('the entry labels and the day screen escape the material capture', () => {
    // Both were swallowed: pressing the button again filed its own label as
    // material, and «📋 Bugun» answered with silence mid-collection.
    //
    // Anchored on the PREDICATE's name, not on the expression: the zametkalar
    // round added a third escape, and a fence matching an expression that has
    // to be rewritten every time a button is added tells you nothing about
    // whether the escapes survived. The escapes themselves are asserted
    // behaviourally in tests/unit/zametka-bot.test.ts.
    expect(handlers).toContain('if (intake && !escapesIntake(ctx.message.text))');
    expect(escapesIntake('🧮 Hisoblatish')).toBe(true);
    expect(escapesIntake('🤖 AI rastamojka')).toBe(true);
    expect(escapesIntake('📋 Bugun')).toBe(true);
  });

  it('the certificate answer reaches the request, through the landing', () => {
    expect(read('src/modules/platform/telegram/staff-bot.ts')).toContain(
      'hasCertificate: state.hasCertificate',
    );
    expect(read('src/modules/wms/calc/intake-land.ts')).toContain(
      'hasCertificate: input.hasCertificate ?? true',
    );
    expect(read('src/modules/wms/calc/service.ts')).toContain(
      'hasCertificate: input.hasCertificate ?? true',
    );
  });

  it('a photo sent before the customer is named gets an answer', () => {
    // It used to fall through to the cabinet, which answers a staff chat
    // with nothing at all — the first thing a seller does after pressing the
    // button vanished.
    expect(handlers).toContain("if (state.stage === 'client') {");
    expect(handlers).toContain('Avval mijozni yozing');
  });

  it('the Telegram file download has a deadline', () => {
    // grammy's poller is sequential: a socket that accepts and then stops
    // sending held every customer's cabinet with it.
    expect(handlers).toContain('AbortSignal.timeout(FILE_DOWNLOAD_MS)');
  });

  it('the invoice reader answers a DOCX in words rather than «no goods»', () => {
    // A DOCX is a zip like an xlsx, so the sniff would call it a workbook and
    // the parser would answer nothing at all — silence where the seller is
    // waiting for a figure.
    expect(handlers).toContain('DOCX o‘qilmaydi');
  });
});
