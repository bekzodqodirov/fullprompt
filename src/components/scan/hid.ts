/**
 * One keystroke of a USB / Bluetooth scanner, as the character it meant.
 *
 * A hand scanner is a keyboard: it presses the KEYS that spell the code and
 * then Enter. The listener used to read `KeyboardEvent.key`, which is what
 * the phone's LAYOUT makes of a key — so on a phone switched to Russian the
 * same scanner typed «НЦ26-000123», and under a Chinese input method every
 * letter arrived as 'Process'. `code` names the physical key and does not
 * care about the layout, which is exactly what a scanner sends.
 *
 * `key` still wins when it is plain ASCII: a person typing on a real keyboard
 * in an ordinary layout gets what they typed, and a scanner on an English
 * layout is unchanged. Our codes are letters, digits and '-' (a crate `CR-…`,
 * a carton `YW26-000123`), so the map covers those and the two separators a
 * retail code may carry; anything else is not part of a code and is dropped.
 */
export function hidChar(key: string, code: string): string | null {
  if (key.length === 1) {
    const c = key.charCodeAt(0);
    if (c >= 0x20 && c <= 0x7e) return key;
  }
  const letter = /^Key([A-Z])$/.exec(code);
  if (letter) return letter[1]!;
  const digit = /^(?:Digit|Numpad)(\d)$/.exec(code);
  if (digit) return digit[1]!;
  switch (code) {
    case 'Minus':
    case 'NumpadSubtract':
      return '-';
    case 'Slash':
    case 'NumpadDivide':
      return '/';
    case 'Period':
    case 'NumpadDecimal':
      return '.';
    default:
      return null;
  }
}
