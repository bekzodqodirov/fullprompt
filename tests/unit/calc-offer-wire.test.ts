import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';

/**
 * The offer's halves, pinned as SOURCE SHAPE.
 *
 * Every door here calls `authorize`/`getActor`, so no integration test can
 * press any of them — a service-level test of a form-fed path proves the
 * service and not the system, which is the lesson #531 recorded and rounds
 * 90 and 98 each had to restate. So the wiring is read as text:
 *
 *   1. the form POSTS the card it is standing on (#171 — a control that
 *      renders as chosen and posts nothing is the recurring defect),
 *   2. the ACTION gates on that card and on nothing wider,
 *   3. the SERVICE proves the version really belongs to the card it was told,
 *   4. the PDF route carries the SAME door, because this app has no
 *      middleware and a route that forgot one is how four screens leaked
 *      (#721-726).
 */
const read = (p: string) => readFileSync(p, 'utf8');

const FORM = read('src/components/calc-offer.tsx');
const ACTIONS = read('src/app/(protected)/hisoblash/actions.ts');
const SERVICE = read('src/modules/wms/calc/workspace.ts');
const ROUTE = read('src/app/api/calc/[versionId]/offer.pdf/route.ts');

describe('the offer form and its action agree about the card', () => {
  it('the form posts the entity it is mounted on', () => {
    expect(FORM).toContain('entityType,');
    expect(FORM).toContain('entityId,');
  });

  it('the action gates on the CARD, not on the VED queue’s own grant', () => {
    const body = ACTIONS.slice(ACTIONS.indexOf('export async function makeOfferAction'));
    expect(body).toContain('canWriteDeal(actor.permissions)');
    expect(body).toContain("actor.permissions.has('crm.leads')");
    // `ved.docs` would be the wrong grant: a calculator does not talk to the
    // customer, and every seller would be locked out of their own offer.
    expect(body.slice(0, body.indexOf('recordOffer('))).not.toContain("'ved.docs'");
  });

  it('the action hands the card down so the service can prove it', () => {
    const body = ACTIONS.slice(ACTIONS.indexOf('export async function makeOfferAction'));
    expect(body).toContain('expect: { entityType: input.entityType, entityId: input.entityId }');
  });

  it('the service refuses a version that belongs to another card', () => {
    const body = SERVICE.slice(SERVICE.indexOf('export async function recordOffer'));
    expect(body).toContain('input.expect');
    expect(body).toContain("throw new CalcError('not_found')");
  });
});

describe('the PDF route carries its own door', () => {
  it('asks for a signed-in actor and refuses the anonymous one', () => {
    expect(ROUTE).toContain('requireActor()');
    expect(ROUTE).toContain("new Response('Unauthorized', { status: 401 })");
  });

  it('asks the same two permissions the button asks', () => {
    expect(ROUTE).toContain('canWriteDeal(actor.permissions)');
    expect(ROUTE).toContain("actor.permissions.has('crm.leads')");
  });

  it('renders the OFFER’s price and 404s without one — never the sealed floor', () => {
    expect(ROUTE).toContain('Number(offer.clientPriceUsd)');
    expect(ROUTE).toContain("if (!offer) return new Response('Not found', { status: 404 })");
    expect(ROUTE).not.toContain('totalUsd');
  });

  it('survives deploy morning: 0087’s tables are caught, not thrown at a seller', () => {
    expect(ROUTE).toContain('isServerBehind(err)');
    expect(ROUTE).toContain("status: 503");
  });
});

describe('the panel that hosts it', () => {
  const PANEL = read('src/components/calc-panel.tsx');

  it('shows the sealed price without a fold — it is what the card is opened for', () => {
    expect(PANEL).toContain('open={open.length > 0 || Boolean(seal)}');
  });

  it('gives an EXPIRED price words instead of a price box', () => {
    expect(PANEL).toContain('seal.expired ?');
    expect(PANEL).toContain("t('sealExpiredHint')");
  });

  it('catches its own reads so a card never dies on a missing table', () => {
    expect(PANEL).toContain('isServerBehind(err)');
  });
});
