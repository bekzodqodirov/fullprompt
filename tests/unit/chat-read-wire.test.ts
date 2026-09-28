import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';

/**
 * The read mark's wiring — the half no service test can see (#531: a
 * service-level test of a form-fed path proves the service, not the system).
 *
 * `markLeadThreadRead` is proven in the integration file, fence and all. What
 * is pinned here is that something actually CALLS it, the way the owner's
 * «chatni ichiga kirgandan keyin» means: the route takes a lead id, checks
 * it before postgres does, and moves the reader's OWN mark; the lead card's
 * chat mounts the sentinel at its newest end; and every screen that draws a
 * thread re-marks when a newer incoming message is drawn in front of the
 * reader (the design judge's seventh finding).
 */

const read = (path: string) =>
  readFileSync(path, 'utf8')
    .replace(/\/\*[\s\S]*?\*\//g, '')
    .replace(/(^|[^:])\/\/[^\n]*/g, '$1');

describe('the read route takes a lead', () => {
  const route = read('src/app/api/chat/read/route.ts');

  it('checks the id is a uuid BEFORE it reaches a ::uuid cast (a 22P02 is a 500, #514)', () => {
    const check = route.indexOf('UUID.test(leadId)');
    const mark = route.indexOf('markLeadThreadRead(');
    expect(check).toBeGreaterThan(-1);
    expect(mark).toBeGreaterThan(check);
  });

  it('moves the SIGNED-IN reader’s mark — the body never names whose', () => {
    expect(route).toContain('markLeadThreadRead(leadId, actor.id)');
  });

  it('behind the lead card’s own door', () => {
    const door = route.indexOf('mayOpenLead(actor, lead)');
    expect(door).toBeGreaterThan(-1);
    expect(door).toBeLessThan(route.indexOf('markLeadThreadRead('));
  });
});

describe('the lead card marks its chat when the chat is SEEN', () => {
  const thread = read('src/components/telegram-thread.tsx');
  const lead = thread.slice(
    thread.indexOf('if (!clientId) {'),
    thread.indexOf('threadClientFor(clientId'),
  );

  it('mounts the sentinel in the lead branch, at the newest end of the scroll box', () => {
    expect(lead).toContain('<LeadChatReadSentinel');
    // FIRST inside the reversed box — i.e. before the bubbles in the source.
    expect(lead.indexOf('<LeadChatReadSentinel')).toBeLessThan(lead.indexOf('<TelegramBubble'));
    expect(lead.indexOf('flex-col-reverse')).toBeLessThan(lead.indexOf('<LeadChatReadSentinel'));
  });

  it('and the anchor the «Lid» row links to is on the section', () => {
    expect(lead).toContain('id={LEAD_THREAD_ANCHOR}');
  });

  it('the sentinel watches visibility, re-armed per newest message', () => {
    const mark = read('src/components/chat-mark-read.tsx');
    const sentinel = mark.slice(mark.indexOf('export function LeadChatReadSentinel'));
    expect(sentinel).toContain('IntersectionObserver');
    expect(sentinel).toContain('[leadId, newest]');
    expect(sentinel).toContain('JSON.stringify({ leadId })');
  });
});

describe('a message drawn while the thread is open is marked too', () => {
  it('the thread screen keys its mark on the newest incoming message', () => {
    const mark = read('src/components/chat-mark-read.tsx');
    const client = mark.slice(
      mark.indexOf('export function ChatMarkRead'),
      mark.indexOf('export function LeadChatReadSentinel'),
    );
    expect(client).toContain('[clientId, newest]');
    const page = read('src/app/(protected)/suhbatlar/[clientId]/page.tsx');
    expect(page).toMatch(/<ChatMarkRead[\s\S]*?newest=/);
  });

  it('the dock re-marks when a refresh draws a newer incoming message', () => {
    const dock = read('src/components/dock.tsx');
    const refresh = dock.slice(
      dock.indexOf('const refreshThread'),
      dock.indexOf('const loadThread'),
    );
    expect(refresh).toContain('markRead(clientId)');
    expect(refresh).toContain('lastInbound.current');
  });
});
