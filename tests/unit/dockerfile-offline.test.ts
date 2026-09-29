import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';

/**
 * A code-only deploy reaches no package registry (DECISIONS #1228).
 *
 * `pnpm` is not in the node image: corepack downloads it from
 * registry.npmjs.org the first time it runs, into the stage's own
 * /root/.cache. That first run is the deps stage's `pnpm install`, and a
 * stage that does not DESCEND from it has no copy. The build stage started
 * from `base`, so every code change fetched pnpm again — and on 2026-09-29
 * the owner's deploy died on that one fetch (a connect timeout from his
 * server) with every other layer cached. Measured in Docker with the registry
 * blocked: the old graph fails at `RUN … pnpm build` with his exact error,
 * the new one builds.
 *
 * Derived from the files, not a list: the stage that runs `pnpm build`, and
 * every stage a compose service runs `pnpm` in, must have the install stage
 * among its ancestors.
 */

interface Stage {
  name: string;
  from: string;
  body: string;
}

function stages(dockerfile: string): Stage[] {
  const out: Stage[] = [];
  for (const line of dockerfile.split('\n')) {
    const m = /^FROM\s+(\S+)(?:\s+AS\s+(\S+))?/i.exec(line);
    if (m) out.push({ from: m[1]!, name: m[2] ?? m[1]!, body: '' });
    else if (out.length > 0) out.at(-1)!.body += `${line}\n`;
  }
  return out;
}

/** The stage and every stage it is built FROM, nearest first. */
function ancestry(all: Stage[], name: string): string[] {
  const chain: string[] = [];
  let at = all.find((s) => s.name === name);
  while (at && !chain.includes(at.name)) {
    chain.push(at.name);
    const parent = at.from;
    at = all.find((s) => s.name === parent);
  }
  return chain;
}

describe('the image build needs no registry for a code change', () => {
  const all = stages(readFileSync('Dockerfile', 'utf8'));
  const install = all.find((s) => /^RUN pnpm install\b/m.test(s.body));
  const build = all.find((s) => /^RUN .*pnpm build$/m.test(s.body));

  it('finds the install stage and the build stage', () => {
    expect(install?.name).toBeTruthy();
    expect(build?.name).toBeTruthy();
  });

  it('builds on top of the install, where corepack left pnpm', () => {
    expect(ancestry(all, build!.name)).toContain(install!.name);
  });

  it('every compose service that runs pnpm runs it in a stage that has it', () => {
    const compose = readFileSync('docker-compose.yml', 'utf8');
    // One block per two-space-indented service key.
    const blocks = [...compose.matchAll(/\n {2}([a-z][a-z0-9-]*):\n([\s\S]*?)(?=\n {2}\S|$)/g)];
    const pnpmServices = blocks.filter(([, , body]) => /command:[^\n]*\bpnpm\b/.test(body!));
    // The premise: migrate and tg-listen are exactly such services.
    expect(pnpmServices.map(([, name]) => name).sort()).toEqual(
      expect.arrayContaining(['migrate', 'tg-listen']),
    );
    for (const [, name, body] of pnpmServices) {
      const target = /\n\s+target:\s*(\S+)/.exec(body!)?.[1];
      expect(target, `${name} names its stage`).toBeTruthy();
      expect(ancestry(all, target!), `${name} → ${target}`).toContain(install!.name);
    }
  });
});
