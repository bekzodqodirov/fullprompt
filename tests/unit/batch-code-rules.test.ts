import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';
import { codeCandidates, isCodeCandidate } from '@/modules/platform/ai/route-text';
import { parseQuery } from '@/modules/wms/search/query';
import {
  codeShapeProblem,
  hasCyrillic,
  loadingCodeProblem,
  normalizeBatchCode,
  roadCodeProblem,
} from '@/modules/wms/batches/batch-code';

/**
 * What a truck may be called (the owner's 1a). The road rule is anchored on
 * the STAFF BOT, not on a pattern written here: a name the bot would not
 * recognise as a code is exactly the name nobody finds by typing it.
 */

describe('normalizeBatchCode', () => {
  it('trims, collapses inner spaces and uppercases — the stored spelling', () => {
    const table: [string, string][] = [
      ['  ka-77 ', 'KA-77'],
      ['gsr   kashgar\t1', 'GSR KASHGAR 1'],
      ['01a777ba', '01A777BA'],
      ['', ''],
    ];
    for (const [raw, out] of table) expect(normalizeBatchCode(raw), raw).toBe(out);
  });

  it('the loading rule stays today’s: 2–40, anything goes', () => {
    expect(loadingCodeProblem('X')).toBe('bad_code');
    expect(loadingCodeProblem('GSR KASHGAR 1')).toBeNull();
    expect(loadingCodeProblem('A'.repeat(40))).toBeNull();
    expect(loadingCodeProblem('A'.repeat(41))).toBe('bad_code');
  });
});

describe('roadCodeProblem', () => {
  it('accepts what the bot recognises — no letter-first clause, so a plate works', () => {
    for (const ok of ['KA-77', 'TAS-2026-014', '01A777BA', 'KA--7', '-KA7']) {
      expect(roadCodeProblem(ok), ok).toBeNull();
    }
  });

  it('names the cause, a Cyrillic look-alike first', () => {
    expect(roadCodeProblem('КА-77')).toBe('code_cyrillic');
    expect(hasCyrillic('КА-77')).toBe(true);
    expect(hasCyrillic('KA-77')).toBe(false);
    expect(roadCodeProblem('KA 77')).toBe('code_chars');
    expect(roadCodeProblem('K7')).toBe('code_length');
    expect(roadCodeProblem(`K${'7'.repeat(20)}`)).toBe('code_length');
    expect(roadCodeProblem('777-1')).toBe('code_needs_letter');
    expect(roadCodeProblem('KASHGAR')).toBe('code_needs_digit');
  });

  it('PROPERTY: accepted exactly when the bot says it is a code, and then the bot finds it', () => {
    // A seeded generator (mulberry32) so a failure reproduces.
    let seed = 0x5eed_1a;
    const rand = () => {
      seed |= 0;
      seed = (seed + 0x6d2b79f5) | 0;
      let t = Math.imul(seed ^ (seed >>> 15), 1 | seed);
      t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
      return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
    };
    const alphabet = [
      ...'ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789 -.',
      ...'АБВГДЕКМНОРСТХабвгдекмнорстх',
    ];
    let accepted = 0;
    for (let i = 0; i < 5000; i += 1) {
      const len = 1 + Math.floor(rand() * 24);
      let s = '';
      for (let j = 0; j < len; j += 1) s += alphabet[Math.floor(rand() * alphabet.length)];
      const ok = roadCodeProblem(s) === null;
      expect(ok, JSON.stringify(s)).toBe(isCodeCandidate(s));
      if (ok) {
        accepted += 1;
        expect(codeCandidates(`${s} qayerda`), JSON.stringify(s)).toContain(s.toUpperCase());
      }
    }
    // The property is about both halves; make sure the generator reaches the accept side.
    expect(accepted).toBeGreaterThan(100);
  });
});

describe('codeShapeProblem', () => {
  it('refuses what the bot or ⌘K would answer as something else', () => {
    expect(codeShapeProblem('GS777-A', null)).toBe('lot');
    // Anchored on ⌘K's own reading, not on a regex restated here.
    expect(parseQuery('YW105').clientCode).toBe(true);
    expect(codeShapeProblem('YW105', null)).toBe('client');
    expect(codeShapeProblem('A1B460', 'A1B')).toBe('client');
    expect(codeShapeProblem('A1B460', 'GS')).toBeNull();
    expect(codeShapeProblem('YW26-000123', null)).toBe('box');
    expect(codeShapeProblem('CR-YW26-00001', null)).toBe('crate');
  });

  it('lets ordinary truck names through', () => {
    for (const ok of ['GSR KASHGAR 1', 'KA-77', 'YW-110', '01A777BA', 'TAS-2026-014']) {
      expect(codeShapeProblem(ok, 'GS'), ok).toBeNull();
    }
  });
});

describe('batch-code.ts runs in the browser', () => {
  it('imports only the two import-free modules that decide how a code is read', () => {
    const src = readFileSync('src/modules/wms/batches/batch-code.ts', 'utf8');
    const imports = [...src.matchAll(/^import[^;]*?from\s+'([^']+)'/gm)].map((m) => m[1]).sort();
    expect(imports).toEqual(['../../platform/ai/route-text', '../search/query']);
    for (const dep of ['src/modules/platform/ai/route-text.ts', 'src/modules/wms/search/query.ts']) {
      expect(readFileSync(dep, 'utf8'), dep).not.toMatch(/^import /m);
    }
  });
});
