import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';

/**
 * «Rastamojka tugadi»: the four halves, pinned in source.
 *
 * The action calls `authorize`, which needs a request scope, so no integration
 * test can press this button — and a service-level test of a form-fed path
 * proves the service, not the system (#531, third appearance). What can go
 * wrong here is the WIRE: a button that posts a field the action does not
 * read, an action that writes a column nobody queries, or a page that renders
 * the control without its current value so it always looks unpressed.
 */

const action = readFileSync('src/app/(protected)/batches/batch-actions-server.ts', 'utf8');
const button = readFileSync('src/app/(protected)/batches/[id]/customs-cleared.tsx', 'utf8');
const page = readFileSync('src/app/(protected)/batches/[id]/page.tsx', 'utf8');
const cabinet = readFileSync('src/modules/wms/client-cabinet/service.ts', 'utf8');

describe('the customs-cleared wire', () => {
  it('the button posts the batch and calls the action', () => {
    expect(button).toContain('setCustomsClearedAction');
    expect(button).toContain('name="batchId"');
  });

  it('the action is the customs manager’s, not the warehouse’s', () => {
    const body = action.slice(action.indexOf('export async function setCustomsClearedAction'));
    expect(body.slice(0, 1200)).toContain("authorize('ved.docs'");
  });

  it('the action TOGGLES, so a wrong truck can be un-marked', () => {
    const body = action.slice(action.indexOf('export async function setCustomsClearedAction'));
    expect(body).toMatch(/batch\.customsClearedAt \? null : new Date\(\)/);
  });

  it('the page renders the control with the value it is about', () => {
    expect(page).toContain('<CustomsCleared');
    expect(page).toContain('clearedAt={batch.customsClearedAt}');
    // On the FOLD's face, or a collapsed panel says nothing (round 43).
    expect(page).toContain("batch.customsClearedAt ? '✅' : null");
  });

  it('the customer’s timeline reads the same column', () => {
    expect(cabinet).toContain('customsClearedAt: batches.customsClearedAt');
    expect(cabinet).toContain('customsCleared: r.customsClearedAt !== null');
  });
});
