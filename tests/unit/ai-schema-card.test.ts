import { readFileSync } from 'node:fs';
import { getTableColumns, getTableName } from 'drizzle-orm';
import { describe, expect, it } from 'vitest';
import {
  ANALYST_TABLES,
  EXCLUDED_TABLES,
  LEAD_SOURCES_GRANTED_COLUMNS,
  USERS_GRANTED_COLUMNS,
  schemaCard,
} from '@/modules/platform/ai/schema-card';
import * as schema from '@/modules/platform/db/schema';

/**
 * The card, the grants and the schema must be ONE claim in three places
 * (#163's shape — the anchor lives outside the artifact it checks):
 *  - every table the card offers is really in the Drizzle schema, under the
 *    name the card uses;
 *  - migration 0080's GRANT names exactly the card's allowlist — a table
 *    granted but not described would be dead capability, a table described
 *    but not granted teaches the model to write queries that always fail;
 *  - no excluded table is granted OR described, and the two column-granted
 *    tables never leak their secret columns into either.
 */

const MIGRATION = readFileSync(
  'src/modules/platform/db/migrations/0080_ai_assistant.sql',
  'utf8',
);
const grantOn = /GRANT SELECT ON\s+([\s\S]*?)\s+TO gsr_ai_reader/.exec(MIGRATION)?.[1] ?? '';
const grantedTables = grantOn
  .split(',')
  .map((name) => name.trim())
  .filter(Boolean);

describe('the analyst schema card', () => {
  it('names only tables that exist in the Drizzle schema, by their SQL names', () => {
    for (const [name, table] of Object.entries(ANALYST_TABLES)) {
      expect(getTableName(table), name).toBe(name);
    }
  });

  it('matches migration 0080’s GRANT list exactly, both directions', () => {
    const cardTables = [...Object.keys(ANALYST_TABLES), 'v_client_balance_usd'].sort();
    expect(grantedTables.slice().sort()).toEqual(cardTables);
  });

  it('grants and describes no excluded table', () => {
    const card = schemaCard(200);
    for (const excluded of EXCLUDED_TABLES) {
      expect(grantedTables, `${excluded} granted`).not.toContain(excluded);
      // Word-anchored: «settings» must not match «…_settings» prose.
      expect(new RegExp(`^${excluded}\\(`, 'm').test(card), `${excluded} in card`).toBe(false);
    }
  });

  it('keeps the credential columns out of the column grants and the card', () => {
    const usersGrant = /GRANT SELECT \(([^)]*)\)\s+ON users/.exec(MIGRATION)?.[1] ?? '';
    const sourcesGrant = /GRANT SELECT \(([^)]*)\)\s+ON lead_sources/.exec(MIGRATION)?.[1] ?? '';
    const split = (s: string) => s.split(',').map((c) => c.trim()).sort();
    expect(split(usersGrant)).toEqual([...USERS_GRANTED_COLUMNS].sort());
    expect(split(sourcesGrant)).toEqual([...LEAD_SOURCES_GRANTED_COLUMNS].sort());

    for (const secret of ['password_hash', 'quick_pin_hash', 'webhook_secret']) {
      expect(usersGrant).not.toContain(secret);
      expect(sourcesGrant).not.toContain(secret);
      expect(schemaCard(200)).not.toContain(secret);
    }
    // And the granted sets really are the schema minus the secrets — a users
    // column added later must fail THIS line, not silently vanish for the
    // model.
    const allUserCols = Object.values(getTableColumns(schema.users)).map((c) => c.name);
    expect(allUserCols.filter((c) => c !== 'password_hash' && c !== 'quick_pin_hash').sort()).toEqual(
      [...USERS_GRANTED_COLUMNS].sort(),
    );
    const allSourceCols = Object.values(getTableColumns(schema.leadSources)).map((c) => c.name);
    expect(allSourceCols.filter((c) => c !== 'webhook_secret').sort()).toEqual(
      [...LEAD_SOURCES_GRANTED_COLUMNS].sort(),
    );
  });

  it('generates the inventory from the schema and carries the money rule', () => {
    const card = schemaCard(200);
    // Generated, not hand-typed: a real column of a granted table is present.
    const boxCols = Object.values(getTableColumns(schema.boxes)).map((c) => c.name);
    for (const col of boxCols) expect(card).toContain(col);
    // The traps that make a correct-looking query true.
    expect(card).toContain('v_client_balance_usd');
    expect(card).toContain('voided_at IS NULL');
    expect(card).toContain('box_movements');
    expect(card).toContain('current_batch_id');
    expect(card).toContain('cash_flow');
    expect(card).toContain('company_balance');
  });
});
