import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';

/**
 * What a photo button in this app is allowed to be.
 *
 * Source-shape, and both halves are here for the same reason: no browser test
 * in this suite can see either one. Playwright's `setInputFiles` dispatches
 * `change` unconditionally, so the re-pick silence is green on the bug; and
 * `capture` is a hint to the OS picker, which headless Chromium does not draw
 * at all.
 *
 * THE TWO RULES (round 111, owner: «kamera iconni bossa rasimga olish kamerasi
 * ochilyabti … fildan tanlash yokida rasimga olish qilib ochadigan yoli
 * borku»):
 *
 * 1. No `capture`. It forces the camera and hides the gallery and the file
 *    browser — the photograph of the pallet taken five minutes ago cannot be
 *    used, and the operator must retake it.
 *
 * 2. Every file input clears `value` AFTER its handler. Clearing it empties
 *    `input.files`, so the call must come second; and without it, picking the
 *    SAME file twice fires no `change` event at all, so the retry after a
 *    failed upload does nothing and the screen sits on its own error message.
 *    `capture` hid that for years by handing back a fresh temp file each shot,
 *    which is exactly why rule 1 unmasks it.
 *
 * `accept="image/*"` deliberately STAYS on the photo slots and is not tested
 * for here: those ids feed `lot.photoIds`/`generalPhotoIds`, which the confirm
 * gate counts and `LightboxImg` renders as an <img>. A PDF in one of them
 * would open the button and then draw broken on the receipt, the stock table
 * and the label sheet. The 📎 sibling is the door for documents.
 */

const FILES = {
  'receive-wizard': 'src/app/(protected)/receive/receive-wizard.tsx',
  'expense-request-fold': 'src/app/(protected)/receive/expense-request-fold.tsx',
  'return-to-sender': 'src/app/(protected)/receipts/[id]/return-to-sender.tsx',
};

/** Comments stripped first — a rule must not be satisfied by prose (#725). */
const code = (src: string) =>
  src.replace(/\{\/\*[\s\S]*?\*\/\}/g, '').replace(/\/\*[\s\S]*?\*\//g, '').replace(/\/\/.*$/gm, '');

describe.each(Object.entries(FILES))('%s', (_name, path) => {
  const body = code(readFileSync(path, 'utf8'));

  it('forces no camera', () => {
    expect(body).not.toMatch(/\bcapture\s*=/);
  });

  it('clears value after the handler on every file input', () => {
    // Every <input type="file"> in the file, matched whole so the assertion is
    // about each control rather than about the file's totals.
    const inputs = body.match(/<input[^>]*type="file"[\s\S]*?\/>/g) ?? [];
    expect(inputs.length, 'the file must still have file inputs').toBeGreaterThan(0);
    for (const input of inputs) {
      expect(input, `an input with no reset:\n${input}`).toMatch(/\.value = ''/);
      // ORDER: the handler is called first, the reset second. Reversed, the
      // upload silently sends nothing.
      const call = input.search(/void add\w+\(/);
      const reset = input.search(/\.value = ''/);
      expect(call, `no handler call in:\n${input}`).toBeGreaterThan(-1);
      expect(reset).toBeGreaterThan(call);
    }
  });
});

describe('the compressor names its own refusal', () => {
  const src = readFileSync('src/components/compress-photo.ts', 'utf8');

  it('rejects a non-image with a type the screens can tell from a network failure', () => {
    expect(src).toContain('export class PhotoUnreadable');
    expect(code(src)).toMatch(/if \(!file\.type\.startsWith\('image\/'\)\) throw new PhotoUnreadable\(\)/);
  });

  it('every screen that compresses distinguishes it', () => {
    for (const path of Object.values(FILES)) {
      const body = code(readFileSync(path, 'utf8'));
      if (!body.includes('compressPhoto(')) continue;
      expect(body, `${path} swallows PhotoUnreadable into its generic message`).toContain(
        'instanceof PhotoUnreadable',
      );
    }
  });
});
