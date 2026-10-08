import { describe, expect, it } from 'vitest';
import { ROLE_MATRIX, type RoleCode } from '@/modules/platform/rbac/catalog';
import { calcCardHref, calcJobHrefFor } from '@/modules/wms/calc/card-door';

/**
 * Where «my job landed» links the person who SENT it (the bot's ✅ after a
 * «Hisoblatish», and the AI-VED's answer to the same person).
 *
 * The reply printed `/crm/leads/<id>` or `/bitimlar/<id>` to everyone, and a
 * stranger's lead is created under its SENDER — so the VED, who holds no
 * `crm.leads`, was handed his own lead's CRM card, which bounces him. The
 * readers are the SEEDED roles where one exists (the door is grants the owner
 * edits with checkboxes, #170), and named grant sets for the two people no
 * seeded role is: a seller with the whole funnel, and a both-hats person.
 */
const actorFor = (codes: readonly string[], id = 'me') => {
  const set = new Set<string>(codes);
  return { id, permissions: { has: (c: string) => set.has(c) } };
};
const role = (r: RoleCode) => actorFor(ROLE_MATRIX[r]);

const VED = role('ved_manager');
const SELLER = role('sales_manager');
const OPERATOR = role('warehouse_operator');
const SELLER_ALL = actorFor(['crm.leads', 'crm.leads.view_all']);
const BOTH = actorFor(['crm.leads', 'ved.docs']);

const ownLead = (requestId: string | null) =>
  ({ entityType: 'lead', entityId: 'L', leadOwnerId: 'me', requestId }) as const;
const colleaguesLead = (requestId: string | null) =>
  ({ entityType: 'lead', entityId: 'L', leadOwnerId: 'colleague', requestId }) as const;
const deal = { entityType: 'deal', entityId: 'D', leadOwnerId: null, requestId: 'R' } as const;

describe('calcJobHrefFor — the ✅ links a door its sender can open, or no line at all', () => {
  it('the VED on his own lead gets the calculation’s screen, never the CRM card (the defect)', () => {
    expect(calcJobHrefFor(VED, ownLead('R'))).toBe('/hisoblash/R');
  });

  it('the VED with no request (the queue refused it) gets nothing', () => {
    expect(calcJobHrefFor(VED, ownLead(null))).toBeNull();
  });

  it('a seller on his own lead gets the card', () => {
    expect(calcJobHrefFor(SELLER, ownLead('R'))).toBe('/crm/leads/L');
  });

  it('a seller whose request joined a colleague’s lead gets nothing — the card bounces him', () => {
    expect(calcJobHrefFor(SELLER, colleaguesLead('R'))).toBeNull();
  });

  it('a seller with the whole funnel gets the colleague’s card', () => {
    expect(calcJobHrefFor(SELLER_ALL, colleaguesLead('R'))).toBe('/crm/leads/L');
  });

  it('a both-hats person on a colleague’s lead gets the calculation’s screen', () => {
    expect(calcJobHrefFor(BOTH, colleaguesLead('R'))).toBe('/hisoblash/R');
  });

  it('the VED on a deal gets the deal card (the deal card admits `ved.docs`)', () => {
    expect(calcJobHrefFor(VED, deal)).toBe('/bitimlar/D');
  });

  it('a warehouse operator gets nothing, on a deal or a lead', () => {
    expect(calcJobHrefFor(OPERATOR, deal)).toBeNull();
    expect(calcJobHrefFor(OPERATOR, ownLead('R'))).toBeNull();
  });

  it('the card question is ONE sentence: wherever the lists link a card, the ✅ links the same card', () => {
    // #513 — `calcCardHref` (the lists) and `calcJobHrefFor` (the bot) share
    // `admittedCardHref`; only their fallbacks differ (the karta vs the
    // workspace), so on every seeded role a CARD answer is the same answer.
    for (const r of Object.keys(ROLE_MATRIX) as RoleCode[]) {
      for (const job of [ownLead('R'), colleaguesLead('R'), deal]) {
        const list = calcCardHref(role(r), job as { entityType: string; entityId: string; requestId: string; leadOwnerId: string | null });
        const bot = calcJobHrefFor(role(r), job);
        if (list && !list.startsWith('/hisoblash/')) expect(bot, `${r} ${job.entityType} ${job.leadOwnerId}`).toBe(list);
        if (bot && !bot.startsWith('/hisoblash/')) expect(list, `${r} ${job.entityType} ${job.leadOwnerId}`).toBe(bot);
      }
    }
  });
});
