import { readdirSync, readFileSync, statSync } from 'node:fs';
import { join } from 'node:path';
import ts from 'typescript';
import { describe, expect, it } from 'vitest';
import { TELEGRAM_DEVICE } from '@/modules/wms/crm/telegram-device';

/**
 * Every Telegram session this system opens announces ONE device (review
 * ban-12). Left out, gramjs fills the fields from `os.type()` and
 * `os.release()` — a device that renames itself whenever the container
 * lands on another kernel.
 *
 * Derived, not listed: every `new TelegramClient(` in src/ and scripts/ is
 * found by TypeScript's own parser, so a sixth construction added next month
 * is checked the day it is written. Each must spread `TELEGRAM_DEVICE` into
 * its options object.
 */

function sourceFiles(dir: string): string[] {
  const out: string[] = [];
  for (const name of readdirSync(dir)) {
    if (name === 'node_modules' || name.startsWith('.')) continue;
    const path = join(dir, name);
    if (statSync(path).isDirectory()) out.push(...sourceFiles(path));
    else if (/\.(ts|tsx|mts)$/.test(name) && !name.endsWith('.d.ts')) out.push(path);
  }
  return out;
}

interface Construction {
  file: string;
  line: number;
  spreadsDevice: boolean;
}

function constructions(file: string): Construction[] {
  const text = readFileSync(file, 'utf8');
  if (!text.includes('TelegramClient(')) return [];
  const source = ts.createSourceFile(file, text, ts.ScriptTarget.Latest, true);
  const found: Construction[] = [];
  const visit = (node: ts.Node) => {
    if (ts.isNewExpression(node) && ts.isIdentifier(node.expression) && node.expression.text === 'TelegramClient') {
      const options = node.arguments?.[3];
      const spreadsDevice =
        options !== undefined &&
        ts.isObjectLiteralExpression(options) &&
        options.properties.some(
          (p) => ts.isSpreadAssignment(p) && ts.isIdentifier(p.expression) && p.expression.text === 'TELEGRAM_DEVICE',
        );
      found.push({
        file,
        line: source.getLineAndCharacterOfPosition(node.getStart()).line + 1,
        spreadsDevice,
      });
    }
    ts.forEachChild(node, visit);
  };
  visit(source);
  return found;
}

describe('one device name for every Telegram session', () => {
  const all = [...sourceFiles('src'), ...sourceFiles('scripts')].flatMap(constructions);

  it('finds the constructions it is meant to guard', () => {
    // The listener, the «ulash» screen, and the three one-off scripts. Fewer
    // means the walk broke, not that the code got safer.
    const files = new Set(all.map((c) => c.file));
    expect(files).toContain(join('scripts', 'tg-listen.ts'));
    expect(files).toContain(join('src', 'modules', 'wms', 'crm', 'telegram-connect.ts'));
    expect(all.length).toBeGreaterThanOrEqual(5);
  });

  it('every construction spreads TELEGRAM_DEVICE', () => {
    const bare = all.filter((c) => !c.spreadsDevice).map((c) => `${c.file}:${c.line}`);
    expect(bare).toEqual([]);
  });

  it('names a device, a system and a version — never empty, which gramjs would fill from the machine', () => {
    expect(TELEGRAM_DEVICE.deviceModel).toBe('GSR CRM');
    expect(TELEGRAM_DEVICE.systemVersion.trim()).not.toBe('');
    expect(TELEGRAM_DEVICE.appVersion.trim()).not.toBe('');
  });
});
