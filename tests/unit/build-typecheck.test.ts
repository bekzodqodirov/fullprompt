import { readFileSync } from 'node:fs';
import { relative } from 'node:path';
import ts from 'typescript';
import { describe, expect, it } from 'vitest';

/**
 * The production build type-checks the app, and has the heap to do it
 * (DECISIONS #1223).
 *
 * The 0113-0116 deploy died inside `next build`: its type check built ONE
 * program over every `.ts` in the repo — the tests included, 4,193 files —
 * and ran out of V8's ~2 GB default heap on the owner's server. Measured here:
 * that program runs out at an 1,800 MB cap, while the app's own program
 * finishes under 1,500 MB. The tests lose nothing: `pnpm typecheck` types them
 * against the root tsconfig, and CI runs it before it builds.
 *
 * The programs are asked of TypeScript itself (the files its config parser
 * would feed the checker), not read off the JSON by hand.
 */

function programFiles(configPath: string): string[] {
  const parsed = ts.getParsedCommandLineOfConfigFile(configPath, undefined, {
    ...ts.sys,
    onUnRecoverableConfigFileDiagnostic: (d) => {
      throw new Error(ts.flattenDiagnosticMessageText(d.messageText, '\n'));
    },
  });
  if (!parsed) throw new Error(`${configPath} did not parse`);
  return parsed.fileNames.map((f) => relative(process.cwd(), f));
}

describe('the production build type-checks the app', () => {
  const root = programFiles('tsconfig.json');
  const build = programFiles('tsconfig.build.json');
  const isTest = (f: string) => f.startsWith('tests/');
  const isApp = (f: string) => f.startsWith('src/');

  it('is pointed at the build tsconfig', () => {
    expect(readFileSync('next.config.ts', 'utf8')).toMatch(
      /typescript:\s*\{\s*tsconfigPath:\s*'tsconfig\.build\.json'\s*\}/,
    );
  });

  it('the root program — `pnpm typecheck` — still carries the tests', () => {
    // The premise: were the tests out of this one too, nothing would type them.
    expect(root.filter(isTest).length).toBeGreaterThan(100);
  });

  it('the build program carries every app file and no test', () => {
    expect(build.filter(isTest)).toEqual([]);
    expect(build.filter(isApp).sort()).toEqual(root.filter(isApp).sort());
  });

  it('takes its compiler options from the root tsconfig alone', () => {
    const own = JSON.parse(readFileSync('tsconfig.build.json', 'utf8')) as Record<string, unknown>;
    expect(own.extends).toBe('./tsconfig.json');
    expect(own).not.toHaveProperty('compilerOptions');
  });
});

describe('the image build has the heap for it', () => {
  const dockerfile = readFileSync('Dockerfile', 'utf8');

  it('above V8`s ~2 GB default, on the build command alone', () => {
    const run = /^RUN (.*)pnpm build$/m.exec(dockerfile)?.[1] ?? '';
    expect(Number(/--max-old-space-size=(\d+)/.exec(run)?.[1] ?? 0)).toBeGreaterThanOrEqual(3072);
    // `migrate` and `tg-listen` run the build stage's image; an ENV would
    // hand the compiler's heap to them as well.
    expect(dockerfile).not.toMatch(/^ENV [^\n]*max-old-space-size/m);
  });
});
