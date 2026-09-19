import { readdirSync, readFileSync, statSync } from 'node:fs';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';

/**
 * A total on the screen must be the COUNT, never the length of the slice.
 *
 * `myDay` caps each bucket at 40 and returns real `counts` beside the rows.
 * `/bugun` was taught to print the counts with a «+N» remainder and the
 * Telegram digest was too — the HOME banner and the DOCK badge were not, so
 * they topped out at 80 while the screen one tap away printed 187. The round
 * that added the cap did so because a count and its list must never disagree,
 * and it left two consumers behind.
 *
 * The rule is mechanical and needs no judgement: SUMMING two buckets' array
 * lengths is only ever an attempt at a total. `/bugun`'s own
 * `more(overdue.length, day.counts.overdue)` and its `length > 0` section
 * guards are about the LIST and stay legal, which is why this is not a blanket
 * ban on `.length`.
 *
 * DERIVED over the tree rather than pinned to two paths, so a third consumer
 * written next month is covered the day it appears (#725, #896's shape).
 */
const strip = (src: string) =>
  src.replace(/\/\*[\s\S]*?\*\//g, '').replace(/\/\/.*$/gm, '');

function walk(dir: string, out: string[] = []): string[] {
  for (const name of readdirSync(dir)) {
    const path = join(dir, name);
    if (statSync(path).isDirectory()) walk(path, out);
    else if (/\.tsx?$/.test(path)) out.push(path);
  }
  return out;
}

/** `a.overdue.length + a.today.length`, however the halves are spelled. */
const SUMMED_LENGTHS =
  /\.overdue(?:\?)?\.length[^;\n]{0,40}\+[^;\n]{0,40}\.today(?:\?)?\.length/;

describe('a day total', () => {
  const files = walk('src');

  it('is never the sum of two capped slices', () => {
    const offenders = files.filter((path) => SUMMED_LENGTHS.test(strip(readFileSync(path, 'utf8'))));
    expect(
      offenders,
      'these print a total built from the rows, which stops climbing at the cap',
    ).toEqual([]);
  });

  it('reaches the dock — the route sends counts and the badge reads them', () => {
    const route = strip(readFileSync('src/app/api/dock/tasks/route.ts', 'utf8'));
    expect(route, 'the dock had no counts to read at all').toContain('counts: day.counts');
    const dock = strip(readFileSync('src/components/dock.tsx', 'utf8'));
    expect(dock, 'the badge must ask for the count').toMatch(/counts\.overdue/);
  });

  it('reaches the home banner', () => {
    const home = strip(readFileSync('src/app/(protected)/page.tsx', 'utf8'));
    expect(home).toContain('day.counts.overdue');
    expect(home).toContain('day.counts.today');
  });

  it('and /bugun keeps using the rows for what the rows are for', () => {
    // The guard against over-reading this rule: a slice's length is the right
    // answer to «how many rows am I drawing», and that is what `more()` needs.
    const bugun = strip(readFileSync('src/app/(protected)/bugun/page.tsx', 'utf8'));
    expect(bugun).toContain('day.counts.overdue');
    expect(bugun, 'the «+N» remainder compares the slice with the truth').toMatch(
      /more\(\s*overdue\.length/,
    );
  });
});
