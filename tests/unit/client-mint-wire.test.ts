import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';

/**
 * The four halves of «a client code, opened by whoever needs it».
 *
 * Source-shape, and for the reason that has produced this idiom four times
 * before (#531): both client doors call `authorize`/`getActor`, so no
 * integration test can press either of them, and a service-level test would
 * prove the service and not the system. What can go wrong here is a wire
 * coming loose — the screen offering what the action refuses, one door
 * stamping a manager and the other not, or the deal quietly disappearing from
 * one of the two.
 */

const SRC = {
  service: readFileSync('src/modules/platform/clients/service.ts', 'utf8'),
  actions: readFileSync('src/app/(protected)/admin/clients/actions.ts', 'utf8'),
  layout: readFileSync('src/app/(protected)/layout.tsx', 'utf8'),
  panel: readFileSync('src/components/quick-create.tsx', 'utf8'),
};

/** Comments stripped — a rule must not be satisfied by prose (#725). */
const code = (src: string) =>
  src.replace(/\{\/\*[\s\S]*?\*\/\}/g, '').replace(/\/\*[\s\S]*?\*\//g, '').replace(/\/\/.*$/gm, '');

describe('who may open a client code', () => {
  it('is ONE predicate, not the pair written out at each door', () => {
    expect(SRC.service).toContain('export function canMintClient');
    expect(code(SRC.service)).toContain("CLIENT_MINT_PERMISSIONS = ['clients.manage', 'crm.leads']");
  });

  it('the screen and the action both ask it', () => {
    // The app bar decides what is drawn; the action decides what happens. A
    // hand-posted call meets the same rule as the button.
    expect(code(SRC.layout)).toContain('canMintClient(actor.permissions)');
    expect(code(SRC.actions)).toContain('canMintClient(actor.permissions)');
  });

  it('the three doors that were NOT widened still take the single-code gate', () => {
    // createClientAction (the full admin form), updateClientAction and the
    // active toggle are unchanged — widening them would additionally hand over
    // the typed-code field, the manager picker and the internal notes.
    const bare = code(SRC.actions).match(/authorize\('clients\.manage'\)/g) ?? [];
    expect(bare.length).toBe(3);
  });

  it('«Batafsil» is offered per kind, so it cannot bounce the person it was opened to', () => {
    expect(code(SRC.layout)).toContain('quickFullForms');
    expect(code(SRC.panel)).toContain('fullForms.includes(kind)');
  });
});

describe('a new client code carries a manager and a deal', () => {
  const actions = code(SRC.actions);

  it('the minter is the manager on the quick door, which has no picker', () => {
    expect(actions).toContain('salesManagerId: actor.id');
  });

  it('the full form keeps its picker and falls back to the minter', () => {
    expect(actions).toContain('salesManagerId: values.salesManagerId ?? actor.id');
  });

  it('BOTH doors open the deal, and only through the shared helper', () => {
    expect(actions).toContain('async function openDealForNewClient');
    const calls = actions.match(/openDealForNewClient\(/g) ?? [];
    // The definition plus one call from each door.
    expect(calls.length).toBe(3);
  });

  it('the deal is opened AFTER the client, and its failure never loses the code', () => {
    const helper = actions.slice(actions.indexOf('async function openDealForNewClient'));
    const body = helper.slice(0, helper.indexOf('\nexport '));
    expect(body).toContain('try {');
    expect(body).toContain('return null;');
    // At the bottom of its column: it carries no price and no goods.
    expect(body).toContain('atBottom: true');
  });

  it('the panel draws the deal link only when a deal actually exists', () => {
    expect(code(SRC.panel)).toContain('madeClient.dealId &&');
    expect(SRC.panel).toContain("t('toDeal')");
  });
});
