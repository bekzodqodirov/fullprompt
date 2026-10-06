import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';
import { ROLE_MATRIX, type RoleCode } from '@/modules/platform/rbac/catalog';
import { calcCardHref, leadNameReadable } from '@/modules/wms/calc/card-door';
import { feedNoteTarget } from '@/components/feed-note-target';

/**
 * The VED on the seller's card (the owner's 14a 15a 16a, docs/VED-TARIX.md
 * §10). Two halves: the LINK every calc surface draws, measured over the
 * SEEDED roles (the door is grants he edits with checkboxes, #170), and the
 * karta's promise to READ — pinned by source shape, because every write door
 * it omits works perfectly well somewhere else, and the defect would be its
 * presence here.
 */
const actorFor = (codes: readonly string[], id = 'me') => {
  const set = new Set<string>(codes);
  return { id, permissions: { has: (c: string) => set.has(c) } };
};
const role = (r: RoleCode) => actorFor(ROLE_MATRIX[r]);

const stripComments = (source: string) =>
  source.replace(/\/\*[\s\S]*?\*\//g, '').replace(/(^|[^:])\/\/.*$/gm, '$1');
const src = (path: string) => stripComments(readFileSync(path, 'utf8'));

const LEAD = { entityType: 'lead', entityId: 'L', requestId: 'R', leadOwnerId: 'somebody-else' };
const DEAL = { entityType: 'deal', entityId: 'D', requestId: 'R' };

describe('calcCardHref — no calc surface draws a door its destination bounces', () => {
  // A lead NOT owned by the reader: the case the old links got wrong.
  const EXPECTED_LEAD: Record<RoleCode, string | null> = {
    super_admin: '/crm/leads/L',
    admin: '/crm/leads/L',
    // The accountant reads the history and opens no card (no crm, no ved).
    accountant: null,
    // The calculator's door: the karta, never the CRM card that bounces him.
    ved_manager: '/hisoblash/R/karta',
    // A seller who does not own the lead is bounced by the CRM card.
    sales_manager: null,
    // The logist reads the whole funnel (`crm.leads.view_all`).
    logist: '/crm/leads/L',
    warehouse_manager: null,
    warehouse_operator: null,
    viewer: null,
  };

  it('answers for every seeded role on somebody else’s lead', () => {
    for (const r of Object.keys(EXPECTED_LEAD) as RoleCode[]) {
      expect(calcCardHref(role(r), LEAD), r).toBe(EXPECTED_LEAD[r]);
    }
    expect(Object.keys(EXPECTED_LEAD).sort()).toEqual(Object.keys(ROLE_MATRIX).sort());
  });

  it('a both-hats person (crm.leads + ved.docs, no view_all) gets the karta on a lead he does not own', () => {
    // Review access-money-15: «crm.leads → the CRM card» bounced exactly him.
    const both = actorFor(['crm.leads', 'ved.docs']);
    expect(calcCardHref(both, LEAD)).toBe('/hisoblash/R/karta');
    expect(calcCardHref(both, { ...LEAD, leadOwnerId: 'me' })).toBe('/crm/leads/L');
  });

  it('a deal links to the deal card for whoever it admits, and to nothing for the accountant', () => {
    expect(calcCardHref(role('ved_manager'), DEAL)).toBe('/bitimlar/D');
    expect(calcCardHref(role('sales_manager'), DEAL)).toBe('/bitimlar/D');
    expect(calcCardHref(role('accountant'), DEAL)).toBeNull();
  });

  it('lead names: the calculator reads them, the accountant keeps «Lid»', () => {
    expect(leadNameReadable(role('ved_manager'))).toBe(true);
    expect(leadNameReadable(role('sales_manager'))).toBe(true);
    expect(leadNameReadable(role('accountant'))).toBe(false);
  });
});

describe('the karta READS (14a: «may NOT edit stage, phone, price»)', () => {
  const page = src('src/app/(protected)/hisoblash/[id]/karta/page.tsx');

  it('draws none of the lead card’s write doors', () => {
    for (const door of ['LeadForm', 'StageMover', 'ConvertForm', 'TasksPanel', 'WonDialog', 'TelegramReply', 'ThreadCalc', 'CalcSendForm', 'CustomFieldInputs']) {
      expect(page, door).not.toContain(door);
    }
  });

  it('passes readOnly to the thread and the 🧮 panel', () => {
    expect(page).toMatch(/<TelegramThread[\s\S]*?readOnly[\s\S]*?\/>/);
    expect(page).toMatch(/<CalcPanel[\s\S]*?readOnly[\s\S]*?\/>/);
  });

  it('sends a CRM reader to the real card by mayOpenLead, and gates the rest on the card door', () => {
    const toCrm = page.indexOf('if (mayOpenLead(actor, lead)) redirect(`/crm/leads/${lead.id}`)');
    const gate = page.indexOf("mayOpenCalcCard(actor, { entityType: 'lead', entityId: lead.id })");
    expect(toCrm).toBeGreaterThan(-1);
    expect(gate).toBeGreaterThan(toCrm);
  });

  it('prints the lead’s quote only as the seller’s guess, and only before any price', () => {
    expect(page).toContain("!everPriced && lead.quotedAmount");
    expect(page).toContain("t('sellerGuess')");
  });
});

describe('every consumer of the ONE door asks it', () => {
  it('the thread omits ThreadCalc and the reply box when read-only', () => {
    const thread = src('src/components/telegram-thread.tsx');
    const calcs = thread.match(/<ThreadCalc\b/g) ?? [];
    const guarded = thread.match(/!readOnly && <ThreadCalc\b/g) ?? [];
    expect(calcs.length).toBeGreaterThan(0);
    expect(guarded.length).toBe(calcs.length);
    expect(thread).toContain('!readOnly && <TelegramReply');
  });

  it('the lenta admits the calc card and draws the VED a text-only box on the card itself', () => {
    const feed = src('src/components/client-feed.tsx');
    expect(feed).toContain('mayOpenCalcCard(actor, calcCard)');
    expect(feed).toContain('files={!viaCalc}');
    expect(feed).toContain('feedNoteTarget({ viaCalc, calcCard, noteOn, dealId, clientId, leadId })');
  });

  it('a note written on the karta lands on the lead for EVERY reader, the both-hats one too (access-4)', () => {
    const lead = { entityType: 'lead' as const, entityId: 'L' };
    const karta = { calcCard: lead, noteOn: lead, dealId: null, clientId: 'C', leadId: 'L' };
    // The calculator (no crm grant) and the both-hats reader (crm.leads, so
    // `viaCalc` is false) write on the same card — the lead, not its client.
    expect(feedNoteTarget({ ...karta, viaCalc: true })).toEqual(lead);
    expect(feedNoteTarget({ ...karta, viaCalc: false })).toEqual(lead);
    // The CRM card keeps its own rule: the lead's client, then the lead.
    const crmCard = { viaCalc: false, calcCard: lead, noteOn: null, dealId: null, leadId: 'L' };
    expect(feedNoteTarget({ ...crmCard, clientId: 'C' })).toEqual({ entityType: 'client', entityId: 'C' });
    expect(feedNoteTarget({ ...crmCard, clientId: null })).toEqual(lead);
    // And the karta is the caller that says so.
    const page = src('src/app/(protected)/hisoblash/[id]/karta/page.tsx');
    expect(page).toMatch(/<ClientFeed[\s\S]*?noteOn=\{\{ entityType: 'lead', entityId: lead\.id \}\}[\s\S]*?\/>/);
  });

  it('the price history links a card through calcCardHref, never by hand (review access-7)', () => {
    // `/crm/leads/<id>` bounced the VED and the accountant both.
    const page = src('src/app/(protected)/hisoblash/narxlar/page.tsx');
    expect(page).toContain('calcCardHref(actor, row)');
    expect(page).not.toMatch(/`\/(crm\/leads|bitimlar)\/\$\{row\./);
  });

  it('the note action asks the door itself, never on a client entity, and refuses a file id', () => {
    const action = src('src/modules/wms/crm/reply-actions.ts');
    const body = action.slice(action.indexOf('export async function addFeedNoteAction'));
    expect(body).toMatch(
      /\(entityType === 'lead' \|\| entityType === 'deal'\) &&\s*\(await mayOpenCalcCard\(who, \{ entityType, entityId \}\)\)/,
    );
    expect(body).toContain("if (viaCalc && rawActivityId) return { error: 'text_only' }");
  });

  it('the lead pulse admits the card door (or the karta’s thread freezes)', () => {
    const pulse = src('src/modules/wms/crm/pulse.ts');
    const body = pulse.slice(pulse.indexOf('export async function chatPulseForLead'));
    expect(body).toContain("mayOpenCalcCard(actor, { entityType: 'lead', entityId: leadId })");
  });

  it('the file branch widens inside crm_activity and nowhere else', () => {
    const access = src('src/modules/wms/attachments/access.ts');
    const branch = access.slice(access.indexOf("case 'crm_activity'"), access.indexOf("case 'call_log'"));
    expect(branch).toContain('calcCardExists(');
    expect(branch).toContain('isCalcCardClient(');
    const outside = access.replace(branch, '');
    expect(outside).not.toContain('calcCardExists(');
    expect(outside).not.toContain('isCalcCardClient(');
  });

  it('both note pings choose the link per recipient', () => {
    const chat = src('src/modules/wms/crm/internal-chat.ts');
    expect(chat).not.toContain('cardLink(');
    for (const fn of ['announceMentions', 'announceNote']) {
      const body = chat.slice(chat.indexOf(`export async function ${fn}`));
      expect(body.slice(0, body.indexOf('\n}\n')), fn).toContain('notifyByLink(');
    }
  });
});
