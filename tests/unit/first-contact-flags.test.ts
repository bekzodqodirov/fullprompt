import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { sql } from 'drizzle-orm';
import { PgDialect } from 'drizzle-orm/pg-core';
import { describe, expect, it } from 'vitest';
import { contactEvidenceSql } from '@/modules/wms/crm/first-contact';

/**
 * The account's own robot is not contact (first-contact.ts rule 2), and the
 * rule still runs on a database one migration behind 0138: the flag table is
 * named only when the caller says it is there. The behaviour is proven in
 * `inbound-contact` and `agent-feed` (integration); this pins the guard, which
 * no database that HAS the table can see.
 */
const text = (flags: boolean) =>
  new PgDialect().sqlToQuery(
    contactEvidenceSql({ leadId: sql`l.id`, since: sql`now()`, ownerId: sql`l.owner_id`, assignedId: sql`null`, flags }),
  ).sql;

describe('first contact and tg_message_flags', () => {
  it('the Telegram branch skips an auto_sent row when the table is there', () => {
    const tg = text(true).slice(text(true).indexOf("'telegram'::text"), text(true).indexOf("'note'::text"));
    expect(tg).toContain('NOT EXISTS (SELECT 1 FROM tg_message_flags tf WHERE tf.message_id = tm.id AND tf.auto_sent)');
  });

  it('names no flag table at all when it is not (a 42P01 would fail the sweep, the landing and the button)', () => {
    expect(text(false)).not.toContain('tg_message_flags');
  });

  it('every caller asks the one predicate the flag’s writer asks — never a literal', () => {
    const source = readFileSync(resolve(__dirname, '../../src/modules/wms/crm/first-contact.ts'), 'utf8')
      .replace(/\/\*[\s\S]*?\*\//g, '')
      .replace(/\/\/.*$/gm, '');
    expect(source).toContain('export const flagsReady = (): Promise<boolean> => agentTablesReady();');
    expect(source).not.toMatch(/flags:\s*(true|false)/);
    expect(source).not.toMatch(/(firstContactSql|arrivalEvidence|earlierEvidence)\((true|false)\)/);
  });
});
