import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';

/**
 * The photographs reach the model (the owner's third report).
 *
 * «kub kilosi rasimni ichiga yozilgan bo'lsa analiz qilmayabti» — and he was
 * right: the collection stored every photo against the note and sent the
 * MODEL nothing but text, so the numbers his office writes on the packing
 * list were read by nobody. There is no way to prove the round trip here
 * (the container has no Anthropic key and no Telegram), so the wiring is
 * pinned as SOURCE SHAPE — every link in the chain, named, so a refactor
 * that drops one turns this red instead of quietly going back to text-only.
 *
 * Comments are stripped first (#725): a rule that trips on the sentence
 * explaining it is a rule that gets deleted.
 */
const read = (path: string) =>
  readFileSync(path, 'utf8')
    .replace(/\/\*[\s\S]*?\*\//g, '')
    .replace(/^\s*\/\/.*$/gm, '');

const AI = read('src/modules/wms/calc/intake-ai.ts');
const STATE = read('src/modules/platform/telegram/calc-intake.ts');
const BOT = read('src/modules/platform/telegram/staff-handlers.ts');

describe('the analysis actually looks at the photographs', () => {
  it('intake-ai takes images and sends them as image blocks', () => {
    expect(AI).toContain('images?:');
    expect(AI).toMatch(/type: 'image'/);
    expect(AI).toContain("type: 'base64'");
    // The text block travels WITH them — a content array, not a bare string.
    expect(AI).toMatch(/content: \[/);
  });

  it('a collection of photographs alone is still analysed', () => {
    // The old guard returned null on empty text, which refused exactly the
    // case he reported: a forwarded packing-list photo with no caption. The
    // AI-rastamojka round widened it once more, for a collection that is
    // nothing but an invoice PDF — same rule, one more way of having sent
    // something.
    expect(AI).toContain('if (!material && images.length === 0 && !pdf) return null;');
  });

  it('the system prompt tells it where the numbers are', () => {
    expect(AI).toContain('ФОТО');
  });

  it('the collection carries the reduced copies and its own cap', () => {
    expect(STATE).toContain('images:');
    expect(STATE).toContain('MAX_INTAKE_IMAGES');
    // What did not fit is COUNTED, never dropped in silence (law 6).
    expect(STATE).toContain('imagesSkipped');
  });

  it('the bot reduces before it holds, and passes them to the analysis', () => {
    expect(BOT).toContain('reduceForModel');
    expect(BOT).toMatch(/import\('sharp'\)/);
    expect(BOT).toContain('MAX_INTAKE_IMAGES');
    expect(STATE).toContain('images: state.images');
  });
});

describe('one live «Bo‘ldi» control, not one per message', () => {
  it('the prompt is EDITED in place and its id is kept', () => {
    // His second report: eight forwards left eight identical keyboards.
    expect(STATE).toContain('promptMessageId');
    expect(BOT).toContain('editMessageText');
    expect(BOT).toContain('showIntakePrompt');
  });

  it('a refused edit still leaves a control on screen', () => {
    // Too old, deleted, or unchanged — the person must never be left with
    // material collected and no way to say «Bo‘ldi».
    const fn = BOT.slice(BOT.indexOf('async function showIntakePrompt'));
    expect(fn).toContain('catch');
    expect(fn).toContain('ctx.reply(text');
  });
});
