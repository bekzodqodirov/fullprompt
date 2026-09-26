import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';

/**
 * His item 7 on the truck's pricing screen, and law 4 around it: the deal's
 * sold price, the floor and the upsale are read only for the owner and the
 * accountant — the VED who computed the floor never reads a client price.
 * Source-shape: the page resolves the actor, no integration test renders it.
 */
const read = (path: string) => readFileSync(path, 'utf8');

describe('the deal price on the pricing screen', () => {
  it('is fetched only for upsale scope «all»', () => {
    const page = read('src/app/(protected)/batches/[id]/pricing/page.tsx');
    expect(page).toContain("const dealPriceSight = !internal && upsaleScopeFor(actor) === 'all';");
    expect(page).toMatch(/dealPriceSight && groupDealIds\.length > 0\s*\?/);
  });

  it('the form stops the press before its action and asks once', () => {
    const form = read('src/app/(protected)/batches/[id]/pricing/pricing-form.tsx');
    expect(form).toContain('needsConfirmation(typed, expectedUsd)');
    expect(form).toContain('event.preventDefault();');
    expect(form).toContain('confirmed.current = true;');
  });
});
