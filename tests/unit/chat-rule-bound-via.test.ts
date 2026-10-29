import { readdirSync, readFileSync, statSync } from 'node:fs';
import { join, relative, resolve } from 'node:path';
import { describe, expect, it } from 'vitest';

/**
 * The listener's own lead binding and its 0139 mark (`tg_chat_rules.bound_via`),
 * source-shape — comments stripped first (#725: a fence must not match the
 * sentence explaining it). The behaviour is proven against a real database in
 * chat-machine-binding.integration; what only the source can show is WHERE:
 *
 *  - the column is NOT declared on the drizzle table (every whole-row read of
 *    `tg_chat_rules` would 42703 one migration behind — 0127's reason, #472);
 *  - ONE writer: the work-number door, inside `phonelessLeadForChat` — a second
 *    writer is how round 113's website rule came to read as the machine's (the
 *    2026-10-29 review's blocker, from the other direction);
 *  - the listener runs the live line in the order the integration file
 *    restates (`listenerLine`): a line the switch passed over is settled
 *    BEFORE it is called not kept, by the line's DIRECTION (the manager's own
 *    line retires nothing — the second review) — and its rows never keep it,
 *    on the live path or the catch-up (the second review: a chat kept by its
 *    rows had no tray question and no «hech qachon»).
 */
const ROOT = resolve(__dirname, '../..');

function stripComments(source: string): string {
  let out = '';
  let quote: string | null = null;
  for (let i = 0; i < source.length; i += 1) {
    const ch = source[i]!;
    const next = source[i + 1];
    if (quote) {
      out += ch;
      if (ch === '\\') {
        out += next ?? '';
        i += 1;
      } else if (ch === quote) {
        quote = null;
      }
      continue;
    }
    if (ch === "'" || ch === '"' || ch === '`') {
      quote = ch;
      out += ch;
    } else if (ch === '/' && next === '/') {
      while (i < source.length && source[i] !== '\n') i += 1;
      out += '\n';
    } else if (ch === '/' && next === '*') {
      i += 2;
      while (i < source.length && !(source[i] === '*' && source[i + 1] === '/')) i += 1;
      i += 1;
    } else {
      out += ch;
    }
  }
  return out;
}

const src = (rel: string) => stripComments(readFileSync(join(ROOT, rel), 'utf8'));

function filesUnder(dir: string): string[] {
  const out: string[] = [];
  for (const name of readdirSync(dir)) {
    const full = join(dir, name);
    if (statSync(full).isDirectory()) out.push(...filesUnder(full));
    else if (/\.(ts|tsx)$/.test(name)) out.push(full);
  }
  return out;
}

/** From `start` to the first `end` after it. */
function between(text: string, start: string, end: string): string {
  const from = text.indexOf(start);
  expect(from, `anchor not found: ${start}`).toBeGreaterThanOrEqual(0);
  const to = text.indexOf(end, from + start.length);
  expect(to, `end not found: ${end}`).toBeGreaterThan(from);
  return text.slice(from, to);
}

const CHAT_LEAD = 'src/modules/wms/crm/chat-lead.ts';

describe('the 0139 mark has one home', () => {
  it('is not declared on the drizzle table — every whole-row read of the rules would 42703 one migration behind', () => {
    const schema = src('src/modules/platform/db/schema/wms.ts');
    expect(schema).not.toMatch(/['"]bound_via['"]/);
    expect(schema).not.toMatch(/\bboundVia\s*:/);
  });

  it('is named in code by chat-lead alone — every other module reads it through `boundViaSql`', () => {
    const naming = filesUnder(join(ROOT, 'src'))
      .filter((file) => src(relative(ROOT, file)).includes('bound_via'))
      .map((file) => relative(ROOT, file));
    expect(naming).toEqual([CHAT_LEAD]);
    const scripts = filesUnder(join(ROOT, 'scripts')).filter((file) => src(relative(ROOT, file)).includes('bound_via'));
    expect(scripts).toEqual([]);
  });

  it('is WRITTEN once, by the minting door, in its transaction', () => {
    const lead = src(CHAT_LEAD);
    const writes = lead.match(/SET bound_via/g) ?? [];
    expect(writes).toHaveLength(1);
    const door = between(lead, 'export async function phonelessLeadForChat(', 'async function closeStrangerCardsFor(');
    expect(door).toContain('SET bound_via = ${machine ? WORK_ACCOUNT_BINDING : null}');
    // A machine binding without its mark would read as a door's answer for good.
    expect(door).toContain('if (machine && !markable)');
    // `isMachineBinding` asks the mark first, the shape beside it.
    const pred = between(lead, 'export function isMachineBinding(', 'export function nobodyDecided(');
    expect(pred).toContain('rule.boundVia === WORK_ACCOUNT_BINDING');
  });
});

describe('the listener settles a line the switch passed over before calling it not kept', () => {
  const listener = src('scripts/tg-listen.ts');
  const handle = between(listener, 'const handleMessage = async', 'const rethinkOnEdit = async');
  const catchUp = between(listener, 'const catchUp = async', 'const CATCHUP_RETRY_MS');

  it('live: after the site tag, before the not-kept branch, by the line’s direction — and a retire re-reads the rules', () => {
    const settle = handle.indexOf('await settlePassedChat(');
    expect(settle).toBeGreaterThan(handle.indexOf('await applySiteTag(peer, msg, verdict)'));
    expect(settle).toBeLessThan(handle.indexOf('if (!verdict.store) {'));
    const step = handle.slice(settle, handle.indexOf('if (!verdict.store) {'));
    expect(step).toContain("msg.out === true ? 'out' : 'in',");
    expect(step).toContain('rules = await rulesFor(account.managerUserId);');
    // The step decides nothing about the line: what is not a new stranger stands by its rule.
    expect(step).not.toMatch(/\bverdict\s*=/);
    // The retired binding's chat is a new question — the card's claim is given back with it.
    expect(handle).toContain("await strangerSeen(peer, msg.out === true, 'ask', reopened);");
    expect(handle).toContain("await strangerSeen(peer, msg.out === true, 'no_phone', reopened);");
  });

  it('rows never keep a passed line — the catch-up decides exactly as before, and nothing names a rows road', () => {
    expect(catchUp).toMatch(/const verdict = decideIncoming\(peer, msg, book\.clients, rules, workMode\.work\);\s*if \(!verdict\.store\) continue;/);
    expect(listener).not.toMatch(/keptLeadOfChat|keptOnLead/);
    expect(src(CHAT_LEAD)).not.toMatch(/keptLeadOfChat/);
  });
});
