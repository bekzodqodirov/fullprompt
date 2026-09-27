import { describe, expect, it } from 'vitest';
import { hidChar } from '@/components/scan/hid';

/**
 * A USB / Bluetooth scanner is a keyboard that presses the keys spelling the
 * code. What `KeyboardEvent.key` says those keys MEAN depends on the phone's
 * layout; what `code` says they ARE does not. These are the three layouts his
 * phones actually carry: English, Russian, and a Chinese input method.
 */
describe('a hand scanner keystroke', () => {
  it('is read by the physical key when the layout would spell it in Cyrillic', () => {
    // KeyY on a Russian layout is «Н».
    expect(hidChar('Н', 'KeyY')).toBe('Y');
    expect(hidChar('ц', 'KeyW')).toBe('W');
  });

  it('is read by the physical key under a Chinese input method', () => {
    expect(hidChar('Process', 'Digit2')).toBe('2');
    expect(hidChar('Process', 'KeyC')).toBe('C');
    expect(hidChar('Process', 'Numpad7')).toBe('7');
  });

  it('keeps plain ASCII as typed, so a keyboard on an English layout is unchanged', () => {
    expect(hidChar('-', 'Minus')).toBe('-');
    expect(hidChar('y', 'KeyY')).toBe('y');
    expect(hidChar('0', 'Digit0')).toBe('0');
  });

  it('spells the dash of a box code from the key when the layout hides it', () => {
    expect(hidChar('Process', 'Minus')).toBe('-');
    expect(hidChar('Unidentified', 'NumpadSubtract')).toBe('-');
  });

  it('drops keys that are not part of any code', () => {
    expect(hidChar('Shift', 'ShiftLeft')).toBeNull();
    expect(hidChar('Control', 'ControlLeft')).toBeNull();
    expect(hidChar('Tab', 'Tab')).toBeNull();
    expect(hidChar('ё', 'Backquote')).toBeNull();
  });

  it('types YW26-000123 on a Russian layout as YW26-000123', () => {
    const keys: [string, string][] = [
      ['Н', 'KeyY'],
      ['Ц', 'KeyW'],
      ['2', 'Digit2'],
      ['6', 'Digit6'],
      ['-', 'Minus'],
      ['0', 'Digit0'],
      ['0', 'Digit0'],
      ['0', 'Digit0'],
      ['1', 'Digit1'],
      ['2', 'Digit2'],
      ['3', 'Digit3'],
    ];
    expect(keys.map(([k, c]) => hidChar(k, c)).join('')).toBe('YW26-000123');
  });
});
