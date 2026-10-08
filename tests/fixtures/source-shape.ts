import { readdirSync, readFileSync, statSync } from 'node:fs';
import { join } from 'node:path';

/**
 * Source-shape reading for the bot's redelivery fences (Q5 a). Comments are
 * stripped first (#725: a fence that reads comments as code reads the code's
 * own explanation of the bug as the bug) — block comments, and lines that are
 * only a `//` comment, which is the topshiriq fence's own rule.
 */
export const strip = (s: string) => s.replace(/\/\*[\s\S]*?\*\//g, '').replace(/^\s*\/\/.*$/gm, '');
export const read = (p: string) => strip(readFileSync(p, 'utf8'));

function walk(dir: string): string[] {
  return readdirSync(dir).flatMap((name) => {
    const path = join(dir, name);
    if (statSync(path).isDirectory()) return walk(path);
    return /\.(ts|tsx)$/.test(name) ? [path] : [];
  });
}

/** Every source file under `src/`, comments stripped. */
export function srcFiles(): { path: string; text: string }[] {
  return walk('src').map((path) => ({ path, text: read(path) }));
}

/** The braces-balanced block opening at `open` (a `{`). */
function blockFrom(source: string, open: number): string {
  let braces = 0;
  for (let j = open; j < source.length; j += 1) {
    if (source[j] === '{') braces += 1;
    else if (source[j] === '}') {
      braces -= 1;
      if (braces === 0) return source.slice(open, j + 1);
    }
  }
  return source.slice(open);
}

/**
 * The body of the function declared at `needle`: past the parameter list's
 * closing `)`, past a return type's generics (`Promise<{ … }>`), the first
 * `{` at angle depth 0. Empty when the needle is not found.
 */
export function bodyOf(source: string, needle: string): string {
  const at = source.indexOf(needle);
  if (at < 0) return '';
  let i = source.indexOf('(', at);
  let parens = 0;
  for (; i < source.length; i += 1) {
    if (source[i] === '(') parens += 1;
    else if (source[i] === ')') {
      parens -= 1;
      if (parens === 0) break;
    }
  }
  let angles = 0;
  for (let j = i + 1; j < source.length; j += 1) {
    const ch = source[j]!;
    if (ch === '<') angles += 1;
    else if (ch === '>' && source[j - 1] !== '=') angles -= 1;
    else if (ch === '{' && angles === 0) return blockFrom(source, j);
  }
  return '';
}
