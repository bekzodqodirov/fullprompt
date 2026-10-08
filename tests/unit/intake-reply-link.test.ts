import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';

/**
 * The two replies a «Hisoblatish» sender gets — the bot's ✅ and the AI-VED's
 * answer — link through ONE rule (`calcJobHrefFor`), chosen for the reader.
 *
 * Source-shape, because both are reached only through Telegram (no network
 * here, m9x's reason) and the integration file drives the functions they call
 * (`landingLinkFor`, `aiPrefill`): what is pinned here is that the doors still
 * CALL them, and that the one-literal-for-everyone link cannot come back.
 */
const strip = (s: string) => s.replace(/\/\*[\s\S]*?\*\//g, '').replace(/(^|[^:])\/\/.*$/gm, '$1');
const read = (p: string) => strip(readFileSync(p, 'utf8'));

function bodyOf(src: string, name: string): string {
  const at = src.search(new RegExp(`function ${name}\\b`));
  expect(at, `${name} is not in the file`).toBeGreaterThan(-1);
  const rest = src.slice(at);
  return rest.slice(0, rest.indexOf('\n}') + 2);
}

describe('the ✅ after «Hisoblatish» links what its sender can open', () => {
  const handlers = read('src/modules/platform/telegram/staff-handlers.ts');
  // The save branch: from the landing to the end of the handler it closes.
  const at = handlers.indexOf('await landCollectedIntake(');
  const save = handlers.slice(at, handlers.indexOf('\n}', at) + 2);

  it('asks `landingLinkFor` and prints the line only when it answers', () => {
    expect(at).toBeGreaterThan(-1);
    expect(save).toContain('landingLinkFor(staff.id, target)');
    expect(save).toMatch(/\(link \? `\$\{link\}\\n` : ''\)/);
  });

  it('holds no card path of its own', () => {
    expect(save).not.toMatch(/crm\/leads|bitimlar/);
    expect(save).not.toContain('APP_URL');
  });

  it('`landingLinkFor` reaches the one rule by dynamic import and fails to NO link', () => {
    const bot = read('src/modules/platform/telegram/staff-bot.ts');
    const body = bodyOf(bot, 'landingLinkFor');
    expect(body).toContain("await import('../../wms/calc/card-door')");
    expect(body).toContain('calcJobHrefFor(');
    expect(body).toContain('userPermissions(staffId)');
    expect(body).toMatch(/catch \(err\) \{[\s\S]*return null;/);
  });
});

describe('the AI-VED’s answer: the same rule for the reader, and no link on the lenta', () => {
  const prefill = read('src/modules/wms/calc/prefill.ts');

  it('`requestAbout` asks `calcJobHrefFor` for `replyTo` and never draws `cardLink`', () => {
    const about = bodyOf(prefill, 'requestAbout');
    expect(about).not.toContain('cardLink(');
    expect(about).toContain('calcJobHrefFor(');
    expect(about).toMatch(/if \(!replyTo\) return null;/);
  });

  it('the job passes the recipient as `replyTo` and writes the linkless text to the lenta', () => {
    const jobs = read('src/modules/wms/calc/jobs.ts');
    expect(jobs).toContain('{ replyTo: staffId }');
    expect(jobs).toContain('writeReplyToLenta(requestId, out.lentaText)');
    expect(jobs).not.toContain('writeReplyToLenta(requestId, out.text)');
  });
});
