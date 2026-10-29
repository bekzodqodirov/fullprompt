import { readFileSync } from 'node:fs';
import ts from 'typescript';
import { describe, expect, it } from 'vitest';
import { AGENT_SOURCE_KEY, INBOUND_SOURCE_KEYS } from '@/modules/wms/crm/inbound';
import { parseInboundPayload } from '@/modules/wms/crm/inbound-webhook';

/**
 * Every source key the code understands has a SEEDED row.
 *
 * The seed's `KEYED` list is the only thing that gives a key its
 * `lead_sources` row, and nothing fails without one: `sourceIdForKey` falls
 * back to «Boshqa» silently, `sourceWebhookSecret` answers null, the door
 * 404s, and the doors screen simply leaves it out — a key added to the code
 * and forgotten in the seed is a door that looks built and is not
 * (the agent round's own `agent`, docs/AGENT-FEED.md).
 *
 * Read with TypeScript's own parser, so a key mentioned in a comment or a
 * string elsewhere in the file cannot satisfy it (#725).
 */
function seededKeys(): string[] {
  const path = 'scripts/seed.ts';
  const file = ts.createSourceFile(path, readFileSync(path, 'utf8'), ts.ScriptTarget.Latest, true);
  const keys: string[] = [];
  let found = false;
  const visit = (node: ts.Node) => {
    if (
      ts.isVariableDeclaration(node) &&
      ts.isIdentifier(node.name) &&
      node.name.text === 'KEYED' &&
      node.initializer &&
      ts.isArrayLiteralExpression(node.initializer)
    ) {
      found = true;
      for (const element of node.initializer.elements) {
        if (!ts.isObjectLiteralExpression(element)) continue;
        for (const prop of element.properties) {
          if (
            ts.isPropertyAssignment(prop) &&
            ts.isIdentifier(prop.name) &&
            prop.name.text === 'key' &&
            ts.isStringLiteral(prop.initializer)
          ) {
            keys.push(prop.initializer.text);
          }
        }
      }
    }
    ts.forEachChild(node, visit);
  };
  visit(file);
  expect(found, 'the seed still declares its KEYED list').toBe(true);
  return keys;
}

describe('inbound source keys', () => {
  it('every key the code accepts is seeded as a keyed lead source', () => {
    const seeded = seededKeys();
    const missing = INBOUND_SOURCE_KEYS.filter((key) => !seeded.includes(key));
    expect(missing, 'keys with no seeded row').toEqual([]);
  });

  it('the agent is one of them', () => {
    expect(AGENT_SOURCE_KEY).toBe('agent');
    expect(INBOUND_SOURCE_KEYS).toContain('agent');
  });
});

describe('the firm on the plain webhook', () => {
  it('is read as `company` AND stays the note line and question pair it always was', () => {
    // Only the agent's landing writes `company` onto the card; a website or a
    // connector that posts it keeps its lenta line, its push, its keyword
    // routes and its mapping exactly as before (review, regression lens).
    const fields = parseInboundPayload({ firma: 'X MChJ', name: 'A', phone: '9' });
    expect(fields.company).toBe('X MChJ');
    expect(fields.fields).toContainEqual({ key: 'firma', value: 'X MChJ' });
    expect(fields.note).toBe('firma: X MChJ');
    expect(parseInboundPayload({ company: 'Acme LLC', note: 'Yiwudan 5 kub' }).note).toBe(
      'Yiwudan 5 kub\ncompany: Acme LLC',
    );
  });

  it('`company` wins over `firma`, whatever the sender’s capitals', () => {
    expect(parseInboundPayload({ Firma: 'B', COMPANY: 'A' }).company).toBe('A');
    expect(parseInboundPayload({ Firma: 'B' }).company).toBe('B');
    expect(parseInboundPayload({ name: 'A' }).company).toBeNull();
  });

  it('Google’s shape carries none', () => {
    const google = parseInboundPayload({
      user_column_data: [{ column_id: 'FULL_NAME', string_value: 'Aziz' }],
    });
    expect(google.company).toBeNull();
  });
});
