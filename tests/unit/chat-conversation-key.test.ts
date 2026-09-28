import { globSync, readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';

/**
 * What a Telegram conversation is KEYED by — the lead chats round's one
 * structural rule, over every statement in `src/` that groups `tg_messages`
 * into conversations.
 *
 * A conversation belongs to a client OR to a lead, and the two keys live on
 * one table with nullable columns, so there are exactly two ways to get the
 * grouping wrong and both have shipped here before:
 *
 *  - keying on a column that can be NULL without its null clause. Postgres
 *    groups every NULL together, so a `DISTINCT ON (client_id)` over rows
 *    that include lead chats collapses the whole company's lead chats into
 *    ONE phantom «waiting» row, openable nowhere (#651, on the seller's home);
 *  - keying on the (client_id, lead_id) PAIR. A won lead's rows carry both
 *    ids while the tray's client door writes only the client, so the pair
 *    splits one person's conversation into two rows.
 *
 * So: a client-keyed statement says `client_id IS NOT NULL`, a lead-keyed
 * one embeds `leadChatOnlySql` (the one sentence — null clause, the client
 * id winning, and the dialog the tray moved to a client), and no key names
 * both. The lead's follow-up queries — the count and the manager names —
 * GROUP BY the lead and need the same sentence, or a lead's number counts
 * rows that live on a client's card (the design judge's ninth finding).
 *
 * Source-shape on purpose: a phantom row is a query that RUNS and answers,
 * wrongly, for data the local database may not hold (#653) — and comments
 * are stripped first, or the fence reads the sentences explaining it (#725).
 */

function stripComments(source: string): string {
  return (
    source
      .replace(/\/\*[\s\S]*?\*\//g, '')
      // A `//` that is not the tail of a URL scheme (`https://`).
      .replace(/(^|[^:])\/\/[^\n]*/g, '$1')
      // SQL comments inside the templates.
      .replace(/--\s[^\n]*/g, '')
  );
}

const files = globSync('src/**/*.ts').filter((file) => !file.endsWith('.d.ts'));
const sources = files.map((file) => ({ file, text: stripComments(readFileSync(file, 'utf8')) }));

interface Statement {
  file: string;
  key: string;
  text: string;
}

/** Every `DISTINCT ON (…)` with the statement text up to its ORDER BY. */
function distinctOnStatements(): Statement[] {
  const out: Statement[] = [];
  for (const { file, text } of sources) {
    for (const match of text.matchAll(/DISTINCT ON \(([^)]*)\)/g)) {
      const start = match.index!;
      const end = text.indexOf('ORDER BY', start);
      const body = text.slice(start, end === -1 ? undefined : end);
      if (!body.includes('tg_messages')) continue;
      out.push({ file, key: match[1]!, text: body });
    }
  }
  return out;
}

/** Every `GROUP BY <alias.>lead_id`, with the statement from its SELECT. */
function leadGroupStatements(): Statement[] {
  const out: Statement[] = [];
  for (const { file, text } of sources) {
    for (const match of text.matchAll(/GROUP BY (?:\w+\.)?lead_id\b/g)) {
      const end = match.index!;
      const start = text.lastIndexOf('SELECT', end);
      const body = text.slice(start, end);
      if (!body.includes('tg_messages')) continue;
      out.push({ file, key: 'lead_id', text: body });
    }
  }
  return out;
}

describe('a Telegram conversation is keyed by ONE owner column', () => {
  const distinct = distinctOnStatements();
  const groups = leadGroupStatements();

  it('finds the statements it is about (a fence that sees nothing passes on nothing)', () => {
    // The list, the badges and the nudge — once per kind each.
    expect(distinct.filter((s) => /\bclient_id\b/.test(s.key)).length).toBeGreaterThanOrEqual(3);
    expect(distinct.filter((s) => /\blead_id\b/.test(s.key)).length).toBeGreaterThanOrEqual(3);
    // The list's count and its supervision names.
    expect(groups.length).toBeGreaterThanOrEqual(2);
  });

  it('never keys a conversation by the (client, lead) pair', () => {
    const paired = distinct.filter((s) => /\bclient_id\b/.test(s.key) && /\blead_id\b/.test(s.key));
    expect(paired.map((s) => `${s.file}: DISTINCT ON (${s.key})`)).toEqual([]);
  });

  it('a client-keyed conversation states its null clause', () => {
    const bare = distinct.filter(
      (s) => /\bclient_id\b/.test(s.key) && !/client_id IS NOT NULL/.test(s.text),
    );
    expect(bare.map((s) => `${s.file}: DISTINCT ON (${s.key})`)).toEqual([]);
  });

  it('a lead-keyed conversation — and every lead count or name list — carries the one sentence', () => {
    const bare = [...distinct.filter((s) => /\blead_id\b/.test(s.key)), ...groups].filter(
      (s) => !s.text.includes('${leadChatOnlySql}'),
    );
    expect(bare.map((s) => `${s.file}: ${s.key}`)).toEqual([]);
  });

  it('and that sentence keeps all three of its clauses', () => {
    const source = readFileSync('src/modules/wms/crm/conversations.ts', 'utf8');
    const at = source.indexOf('export const leadChatOnlySql');
    const fragment = source.slice(at, source.indexOf('`;', at));
    expect(fragment).toContain('m.client_id IS NULL');
    expect(fragment).toContain('m.lead_id IS NOT NULL');
    expect(fragment).toMatch(/NOT EXISTS[\s\S]*moved\.client_id IS NOT NULL/);
  });
});
