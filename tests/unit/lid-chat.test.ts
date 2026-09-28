import { describe, expect, it } from 'vitest';
import {
  LEAD_THREAD_ANCHOR,
  conversationHref,
  leadThreadSource,
} from '@/modules/wms/crm/conversation-row';
import { mayOpenLead } from '@/modules/wms/crm/lead-door';
import { LEAD_CHAT_ALARMS_FROM, leadAlarmStands, leadChatState } from '@/modules/wms/crm/waiting';
import { unansweredText, type UnansweredChat } from '@/modules/wms/crm/unanswered';
import { composeStaffHtml } from '@/modules/platform/notifications/staff-html';

/**
 * The lead chats round's pure rules (owner's answer 4a: a prospect's
 * Telegram chat watched «exactly like a client's»). The wiring — that every
 * reader reaches these through the one resolver — is
 * `tests/integration/lead-chat.integration.test.ts`.
 */

const LEAD = '01a0e9c2-0000-7000-8000-00000000aaaa';
const CLIENT = '01a0e9c2-0000-7000-8000-00000000cccc';

describe('where a conversation row opens', () => {
  it('a client row opens its thread screen', () => {
    expect(
      conversationHref({ kind: 'client', clientId: CLIENT, leadId: null, openable: true }),
    ).toBe(`/suhbatlar/${CLIENT}`);
  });

  it('a lead row opens the LEAD card, scrolled to its chat', () => {
    expect(conversationHref({ kind: 'lead', clientId: null, leadId: LEAD, openable: true })).toBe(
      `/crm/leads/${LEAD}#${LEAD_THREAD_ANCHOR}`,
    );
    expect(LEAD_THREAD_ANCHOR).toBe('tg-thread');
  });

  it('a lead the reader may not open gets NO link — never one that bounces', () => {
    expect(
      conversationHref({ kind: 'lead', clientId: null, leadId: LEAD, openable: false }),
    ).toBeNull();
  });
});

describe('who may open a lead card (one predicate for every door)', () => {
  const reader = (...grants: string[]) => ({ id: 'me', permissions: new Set(grants) });

  it('the whole funnel for crm.leads.view_all', () => {
    expect(mayOpenLead(reader('crm.leads', 'crm.leads.view_all'), { ownerId: 'someone' })).toBe(
      true,
    );
    expect(mayOpenLead(reader('crm.leads', 'crm.leads.view_all'), { ownerId: null })).toBe(true);
  });

  it('otherwise their own lead only — not a colleague’s, not an unowned one', () => {
    expect(mayOpenLead(reader('crm.leads'), { ownerId: 'me' })).toBe(true);
    expect(mayOpenLead(reader('crm.leads'), { ownerId: 'someone' })).toBe(false);
    expect(mayOpenLead(reader('crm.leads'), { ownerId: null })).toBe(false);
  });

  it('and nothing without crm.leads, whatever else they hold', () => {
    expect(mayOpenLead(reader('ved.docs', 'crm.leads.view_all'), { ownerId: 'me' })).toBe(false);
  });
});

describe('which chat the lead card shows', () => {
  it('the lead’s OWN standing chat wins over a client matched by phone', () => {
    // The precedence the round exists for: the «Lid» row must open onto the
    // chat it promised, not onto whichever client the typed phone matched.
    expect(leadThreadSource({ ownLeadRows: 3, resolvedClientId: CLIENT })).toEqual({
      kind: 'lead',
    });
  });

  it('a lead with no chat of its own falls back to the phone-matched client', () => {
    expect(leadThreadSource({ ownLeadRows: 0, resolvedClientId: CLIENT })).toEqual({
      kind: 'client',
      clientId: CLIENT,
    });
  });

  it('and neither is none', () => {
    expect(leadThreadSource({ ownLeadRows: 0, resolvedClientId: null })).toEqual({ kind: 'none' });
  });
});

describe('a lead chat’s alarm has two extra lines', () => {
  const after = new Date(LEAD_CHAT_ALARMS_FROM.getTime() + 3_600_000);
  const before = new Date(LEAD_CHAT_ALARMS_FROM.getTime() - 3_600_000);

  it('nothing from before the watch began rings — no burst on deploy morning', () => {
    expect(leadAlarmStands({ sentAt: before, closedAt: null })).toBe(false);
    expect(leadAlarmStands({ sentAt: after, closedAt: null })).toBe(true);
  });

  it('a closed lead settled what came before its closing; a new message rings', () => {
    const closedAt = new Date(after.getTime() + 60_000);
    expect(leadAlarmStands({ sentAt: after, closedAt })).toBe(false);
    expect(leadAlarmStands({ sentAt: closedAt, closedAt })).toBe(false);
    expect(leadAlarmStands({ sentAt: new Date(closedAt.getTime() + 1), closedAt })).toBe(true);
  });

  it('a silenced «new» reads as nothing-to-answer — never as «seen», which nobody did', () => {
    expect(leadChatState('new', { sentAt: before, closedAt: null })).toBe('answered');
    expect(leadChatState('new', { sentAt: after, closedAt: null })).toBe('new');
    // The line only ever quiets an alarm; it never invents or erases a read.
    expect(leadChatState('seen', { sentAt: before, closedAt: null })).toBe('seen');
    expect(leadChatState('answered', { sentAt: after, closedAt: null })).toBe('answered');
  });
});

describe('the 30-minute nudge for a lead', () => {
  const base: UnansweredChat = {
    kind: 'lead',
    clientId: null,
    leadId: LEAD,
    code: null,
    name: 'Dilshod aka',
    managerUserId: 'm',
    messageId: 'x',
    waitingMinutes: 42,
    lastBody: 'Salom, Toshkentga yuk bor',
    openable: true,
    leadOwner: null,
  };
  const APP = 'https://gsrwms.uz';

  it('says «Lid» — never «Yangi lid» — and its link becomes the real «↗️ Ochish» button', () => {
    const text = unansweredText(base, APP);
    expect(text.split('\n')[0]).toBe('💬 Lid: Dilshod aka javob kutmoqda — 42 daqiqa');
    expect(text).not.toContain('Yangi');
    expect(text).toContain('«Salom, Toshkentga yuk bor»');
    // Through the drain's OWN lifter, not a restatement of it.
    const sent = composeStaffHtml('ClientWaiting', text, { appUrl: APP, openLabel: '↗️ Ochish' });
    expect(sent.url).toBe(`${APP}/crm/leads/${LEAD}#tg-thread`);
    expect(sent.urlRow).toEqual([{ text: '↗️ Ochish', url: `${APP}/crm/leads/${LEAD}#tg-thread` }]);
    expect(sent.html).not.toContain('/crm/leads/');
  });

  it('a lead the manager may not open names its owner and carries no button', () => {
    const text = unansweredText({ ...base, openable: false, leadOwner: 'Bekzod' }, APP);
    expect(text).not.toContain('https://');
    expect(text.split('\n').at(-1)).toBe('Lid egasi: Bekzod');
    const sent = composeStaffHtml('ClientWaiting', text, { appUrl: APP, openLabel: '↗️ Ochish' });
    expect(sent.url).toBeNull();
  });

  it('a client’s nudge keeps its words and its thread link', () => {
    const text = unansweredText(
      { ...base, kind: 'client', clientId: CLIENT, leadId: null, code: 'GS777', name: 'Aziz' },
      APP,
    );
    expect(text.split('\n')[0]).toBe('💬 GS777 (Aziz) javob kutmoqda — 42 daqiqa');
    expect(text.split('\n').at(-1)).toBe(`${APP}/suhbatlar/${CLIENT}`);
  });
});
