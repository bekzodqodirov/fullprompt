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
 * one reads its rows through `leadDialogsSql` (the one statement — null
 * clauses, the client id winning, and the dialog a NEWER client row took
 * over), and no key names both. The lead's follow-up queries — the manager
 * names — GROUP BY the lead and read the same statement, or a lead's line
 * counts rows that live on a client's card (the design judge's ninth
 * finding).
 *
 * And the statement's SHAPE is pinned with it: the supersede is asked once
 * per DIALOG, after the grouping, never once per message. Per message it was
 * quadratic in a dialog's length — 2.5 s for the list and 2.3 s for the nudge
 * on a shaped copy (the review's first finding) — and a statement that runs
 * and answers correctly, only slowly, is invisible to every behavioural test
 * on a small database.
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

/** Does this statement read Telegram messages — directly or through the lead statement? */
const readsMessages = (body: string) =>
  body.includes('tg_messages') || body.includes('${leadDialogsSql(');

/** Every `DISTINCT ON (…)` with the statement text up to its ORDER BY. */
function distinctOnStatements(): Statement[] {
  const out: Statement[] = [];
  for (const { file, text } of sources) {
    for (const match of text.matchAll(/DISTINCT ON \(([^)]*)\)/g)) {
      const start = match.index!;
      const end = text.indexOf('ORDER BY', start);
      const body = text.slice(start, end === -1 ? undefined : end);
      if (!readsMessages(body)) continue;
      out.push({ file, key: match[1]!, text: body });
    }
  }
  return out;
}

/** Every `GROUP BY <alias.>lead_id…`, with the statement from its SELECT. */
function leadGroupStatements(): Statement[] {
  const out: Statement[] = [];
  for (const { file, text } of sources) {
    for (const match of text.matchAll(/GROUP BY (?:\w+\.)?lead_id\b/g)) {
      const end = match.index!;
      const start = text.lastIndexOf('SELECT', end);
      const body = text.slice(start, end);
      if (!readsMessages(body)) continue;
      out.push({ file, key: 'lead_id', text: body });
    }
  }
  return out;
}

/** The lead statement's own source, comments stripped. */
function leadDialogsSource(): string {
  const source = stripComments(readFileSync('src/modules/wms/crm/conversations.ts', 'utf8'));
  const at = source.indexOf('export function leadDialogsSql');
  expect(at).toBeGreaterThan(-1);
  return source.slice(at, source.indexOf('`;', at));
}

describe('a Telegram conversation is keyed by ONE owner column', () => {
  const distinct = distinctOnStatements();
  const groups = leadGroupStatements();

  it('finds the statements it is about (a fence that sees nothing passes on nothing)', () => {
    // The list, the badges and the nudge — once per kind each.
    expect(distinct.filter((s) => /\bclient_id\b/.test(s.key)).length).toBeGreaterThanOrEqual(3);
    expect(distinct.filter((s) => /\blead_id\b/.test(s.key)).length).toBeGreaterThanOrEqual(3);
    // The list's supervision names, and the lead statement's own grouping.
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

  it('a lead-keyed conversation — and every lead name list — reads through the one statement', () => {
    const helper = leadDialogsSource();
    const bare = [...distinct.filter((s) => /\blead_id\b/.test(s.key)), ...groups].filter(
      // The statement's own grouping is the one place that reads the table.
      (s) => !s.text.includes('${leadDialogsSql(') && !helper.includes(s.text),
    );
    expect(bare.map((s) => `${s.file}: ${s.key}`)).toEqual([]);
  });

  it('and that statement keeps all four of its clauses', () => {
    const helper = leadDialogsSource();
    expect(helper).toContain('m.client_id IS NULL');
    expect(helper).toContain('m.lead_id IS NOT NULL');
    expect(helper).toMatch(/NOT EXISTS[\s\S]*moved\.client_id IS NOT NULL/);
    // Only a NEWER client row supersedes: the door swings both ways, and a
    // dialog filed under a lead AFTER its client half must still ring.
    expect(helper).toMatch(/NOT EXISTS[\s\S]*moved\.tg_message_id > t\.tg_message_id/);
  });

  it('asks the supersede once per DIALOG — after the grouping, as a probe, never per message', () => {
    const helper = leadDialogsSource();
    const grouped = helper.indexOf('GROUP BY m.lead_id, m.manager_user_id, m.peer_id');
    const lateral = helper.indexOf('CROSS JOIN LATERAL');
    const supersede = helper.indexOf('NOT EXISTS');
    const limit = helper.indexOf('LIMIT 1');
    expect(grouped).toBeGreaterThan(-1);
    // Grouped first, then the newest row of each dialog and its witness —
    // inside a LATERAL whose LIMIT keeps the planner from flattening it into
    // a hash over the whole table (measured: it did, twice).
    expect(lateral).toBeGreaterThan(grouped);
    expect(supersede).toBeGreaterThan(lateral);
    expect(limit).toBeGreaterThan(supersede);
    // …against the dialog's newest row, found by the grouping's own number.
    expect(helper).toMatch(/t\.tg_message_id = g\.tg_message_id/);
    expect(helper).toMatch(/moved\.manager_user_id = t\.manager_user_id/);
    expect(helper).toMatch(/moved\.peer_id = t\.peer_id/);
  });
});
