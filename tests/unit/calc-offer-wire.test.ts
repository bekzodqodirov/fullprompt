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

/**
 * Source without its comments.
 *
 * A sentence explaining why a door is NOT what it used to be must not satisfy
 * a fence asserting the old door is gone — #725 minted a pooled function
 * called `for` out of my own prose, and this is the same mistake wearing a
 * negative assertion.
 */
const code = (src: string) => src.replace(/\/\*[\s\S]*?\*\//g, '').replace(/\/\/.*$/gm, '');

const FORM = read('src/components/calc-offer.tsx');
const ACTIONS = read('src/app/(protected)/hisoblash/actions.ts');
const SERVICE = read('src/modules/wms/calc/workspace.ts');
const ROUTE = read('src/app/api/calc/[versionId]/offer.pdf/route.ts');

describe('the offer form and its action agree about the card', () => {
  it('the form posts the entity it is mounted on', () => {
    expect(FORM).toContain('entityType,');
    expect(FORM).toContain('entityId,');
  });

  it('the action refuses the VED, who may work the card but not quote it', () => {
    const body = ACTIONS.slice(ACTIONS.indexOf('export async function makeOfferAction'));
    expect(body).toContain('mayOffer(actor)');
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

  it('is gated by law 4 itself, and lets the accountant in', () => {
    // `canWriteDeal` was the wrong question in BOTH directions: it admitted
    // the VED (`ved.docs` is in the deal-write list) and it shut out the
    // accountant, who pays the commission measured off this very number.
    expect(code(ROUTE)).not.toContain('canWriteDeal');
    expect(ROUTE).toContain('upsaleScopeFor(actor)');
  });

  it('holds a SELLER to the funnel’s gate on a lead, and nobody else', () => {
    expect(ROUTE).toContain("scope === 'own' &&");
    expect(ROUTE).toContain("actor.permissions.has('crm.leads')");
  });

  it('refuses the VED, whom `canWriteDeal` alone lets straight through', () => {
    // The sheet IS a client price, and `DEAL_WRITE_PERMISSIONS` carries
    // `ved.docs` on purpose (the VED recalculates jobs). So the card door and
    // the offer door cannot be the same door — law 4.
    expect(ROUTE).toContain('upsaleScopeFor(actor)');
    expect(ROUTE).toContain("scope === 'none'");
  });

  it('lets a seller reprint their OWN promise and nobody else’s', () => {
    expect(ROUTE).toContain("scope === 'own' && offer.offeredBy !== actor.id");
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

/*
 * DELIBERATE REWRITE (docs/VED-TARIX.md §11, review access-money-17 and
 * tests-completeness-4). This block used to say the panel «never offers the
 * offer list to the VED» — and the owner's 16a reverses exactly that for the
 * client PRICE («sotuvchi bergan narxni ham koraversin»). Left as it was, its
 * `toContain` pins would have stayed green while its sentence became false
 * (#974: a test that pins old behaviour as intended). What stays: the price
 * BOX and the offer form wait on law 4's scope. What is new: the VED reads a
 * PROJECTION of the offers (no PDF, no payout, no below-floor reason), and
 * the panel draws the door of whatever STANDS.
 */
describe('the panel that hosts it', () => {
  const PANEL = read('src/components/calc-panel.tsx');
  const PANEL_CODE = code(PANEL);

  it('shows the price without a fold — it is what the card is opened for', () => {
    // `forceOpen` (2026-09-26) only ever ADDS an opening — «+ Yangi →
    // Hisoblatish» landing on the form — so the price's rule still reads here.
    expect(PANEL).toContain('open={forceOpen || open.length > 0 || hasPrice || Boolean(last)}');
  });

  it('gives an EXPIRED price words instead of a price box', () => {
    expect(PANEL).toContain('seal.expired ?');
    expect(PANEL).toContain("t('sealExpiredHint')");
  });

  it('catches its own reads so a card never dies on a missing table', () => {
    expect(PANEL).toContain('isServerBehind(err)');
  });

  it('never offers the price BOX to the VED, nor on the read-only karta', () => {
    expect(PANEL).toContain('upsaleScopeFor(actor)');
    // The seal's form and the answer's form both wait on the seller's hands
    // AND law 4's scope.
    expect(PANEL_CODE).toContain("!writes || scope === 'none' ? null :");
    expect(PANEL_CODE).toContain("writes && scope !== 'none'");
    // `writes` is false on the karta and, on a lead, without `crm.leads`.
    expect(PANEL_CODE).toContain("const writes = !readOnly && (entityType === 'deal' || sellerOnLead);");
    // The send form is the seller's too — the VED must not open a request on
    // a seller's lead from the karta (14a, review access-money-2).
    expect(PANEL_CODE).toMatch(/\{writes \? \(\s*<div className="border-t border-line pt-2">\s*<p className="text-2xs text-ink-500 sm:hidden">\{t\('sendOnPhone'\)\}/);
  });

  it('16a: the seller\'s full offer rows only for who may offer; a PROJECTION for who may only read', () => {
    // Rewritten deliberately (review access-1 / ved-money-2): this test used
    // to pin `else if (… seesOfferPrices)`, i.e. the both-hats defect as the
    // intended shape (#974). The reads are decided by `offerReadsFor`, whose
    // role matrix is calc-control-scope.test.ts; here only the wiring.
    expect(PANEL_CODE).toContain('const reads = offerReadsFor(actor);');
    expect(PANEL_CODE).toContain('if (priced && reads.full) offers = await offersFor(entityType, entityId);');
    expect(PANEL_CODE).toContain('if (priced && reads.prices) {');
    expect(PANEL_CODE).not.toMatch(/else if \(priced && [a-z.]*[Pp]rices\)/);
  });

  it('the projection list draws NO PDF link and no below-floor reason', () => {
    const list = PANEL_CODE.slice(PANEL_CODE.indexOf('export async function OfferPriceList'));
    expect(list.length).toBeGreaterThan(100);
    expect(list).not.toContain('/pdf');
    expect(list).not.toMatch(/belowFloorReason|payout|\.text\b/);
  });

  it('draws what STANDS — one list for the panel and the quote lock (ved-correctness-4/-6)', () => {
    expect(PANEL_CODE).toContain('standingAnchorsFor(entityType, entityId)');
    expect(PANEL_CODE).toContain('anchors.seals.map((seal) => sealBlock(seal, true))');
    expect(PANEL_CODE).toContain('anchors.answers.map((answer) =>');
    const lock = code(read('src/modules/wms/crm/service.ts'));
    const fn = lock.slice(lock.indexOf('export async function quoteLockedFor'));
    expect(fn.slice(0, fn.indexOf('\n}'))).toContain('standingAnchorsFor(entityType, entityId)');
  });
});

describe('the 16a projection cannot carry a payout (review access-money-8)', () => {
  it('OfferPrice declares exactly the six facts 16a names', () => {
    const fn = /export interface OfferPrice \{([\s\S]*?)\n\}/.exec(SERVICE);
    expect(fn, 'OfferPrice not found').not.toBeNull();
    const fields = [...fn![1]!.matchAll(/^ {2}(\w+)\??:/gm)].map((f) => f[1]!).sort();
    expect(fields).toEqual(
      ['clientPriceUsd', 'currency', 'id', 'offeredAt', 'offeredByName', 'pendingApproval'].sort(),
    );
  });

  it('offerPricesFor selects columns, never the whole row', () => {
    const body = code(SERVICE).slice(code(SERVICE).indexOf('export async function offerPricesFor'));
    const select = body.slice(0, body.indexOf('.from(calcOffers)'));
    expect(select).toContain('.select({');
    expect(select).not.toMatch(/payout|belowFloorReason|text:/);
  });
});

describe('the PDF route serves RELEASED offers only (law 4, the promise lock)', () => {
  it('the offer select carries the released clause, not just the version id', () => {
    // The panel hiding a pending offer's link is a courtesy; the WHERE is the
    // door. Without it a below-floor price no admin allowed renders as a
    // customer sheet by URL — the whole-module audit's confirmed hole.
    const body = code(ROUTE);
    const select = body.slice(body.indexOf('from(calcOffers)'));
    expect(select.slice(0, select.indexOf('orderBy'))).toContain('releasedOfferWhere()');
  });

  it('the clause has ONE home, shared with the card price', () => {
    const service = code(SERVICE);
    const fn = service.slice(service.indexOf('export function releasedOfferWhere'));
    // slice to the function's closing line, not the first '}' — the template
    // literal's own interpolations close braces before the body does.
    expect(fn.slice(0, fn.indexOf('\n}'))).toContain('approvedAt} IS NOT NULL');
    const priceFn = service.slice(service.indexOf('export async function lastReleasedOfferFor'));
    expect(priceFn.slice(0, priceFn.indexOf('orderBy'))).toContain('releasedOfferWhere()');
  });
});
