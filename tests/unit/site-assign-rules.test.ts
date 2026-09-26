import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';
import {
  findLeadTag,
  ipKey,
  LEAD_TAG_RE,
  normalizeUsername,
  primaryUsername,
  rankByLoad,
  reachableAt,
  readOfferInput,
  readTag,
  readTeam,
  siteTagAction,
  suspectsStaleBook,
  TokenBuckets,
  USERNAME_FRESH_MS,
} from '@/modules/wms/crm/site-assign-rules';
import { isOrigin, originsSettingValid, parseOrigins } from '@/modules/platform/http/origins';
import type { LiveVerdict } from '@/modules/wms/crm/telegram-live';
import type { MessageRow } from '@/modules/wms/crm/telegram-import';

/**
 * Round 113's decisions, as functions — the website's question, the listener's
 * tag, and the ranking both the route and the panel read.
 */

describe('the tag has ONE shape', () => {
  it('is the migration CHECK, character for character', () => {
    // Three definitions (route, listener, CHECK) is how a tag passes the route
    // and dies on the INSERT. The route reads LEAD_TAG_RE, the listener reads
    // it through findLeadTag, and this holds the database to the same text.
    const sql = readFileSync('src/modules/platform/db/migrations/0107_lead_assign.sql', 'utf8');
    const check = /tag text NOT NULL UNIQUE CHECK \(tag ~ '([^']+)'\)/.exec(sql)?.[1];
    expect(check).toBeDefined();
    expect(check).toBe(LEAD_TAG_RE.source);
  });

  it('reads a query-string tag, upper-cased, and refuses anything else', () => {
    expect(readTag('GSR-7F3K2')).toBe('GSR-7F3K2');
    expect(readTag(' gsr-7f3k2 ')).toBe('GSR-7F3K2');
    expect(readTag('GSR-7F3K')).toBeNull(); // four characters: too short
    expect(readTag(`GSR-${'A'.repeat(17)}`)).toBeNull(); // seventeen: too long
    expect(readTag(`GSR-${'A'.repeat(16)}`)).toBe(`GSR-${'A'.repeat(16)}`);
    expect(readTag('GSR-7F3K2; DROP')).toBeNull();
    expect(readTag(null)).toBeNull();
  });

  it('finds the tag inside what the visitor typed, bounded on both sides', () => {
    expect(findLeadTag('Salom! Kod: GSR-7F3K2, 20 kub yuk bor')).toBe('GSR-7F3K2');
    expect(findLeadTag('gsr-ab12cd')).toBe('GSR-AB12CD');
    expect(findLeadTag('XGSR-7F3K2')).toBeNull();
    expect(findLeadTag('GSR-7F3K2X7F3K2X7F3K2')).toBeNull();
    expect(findLeadTag('Salom')).toBeNull();
    expect(findLeadTag(null)).toBeNull();
  });
});

describe('the website parameters', () => {
  it('an unknown team is general, never a refusal', () => {
    expect(readTeam('cargo')).toBe('cargo');
    expect(readTeam('BUYING')).toBe('buying');
    expect(readTeam('tomorrow')).toBe('general');
    expect(readTeam(null)).toBe('general');
  });

  it('keeps only values that cannot carry a sentence onto a staff card', () => {
    const ok = readOfferInput(
      new URLSearchParams('team=cargo&tag=yuk&page=/narxlar/&lang=uz&lead=GSR-7F3K2'),
    );
    expect(ok).toEqual({ team: 'cargo', tag: 'GSR-7F3K2', topic: 'yuk', page: '/narxlar/', lang: 'uz' });
    const hostile = readOfferInput(
      new URLSearchParams({
        team: 'x',
        tag: 'Pul yuboring shu kartaga',
        page: 'https://evil.example/',
        lang: 'klingon',
        lead: 'GSR-7F3K2',
      }),
    );
    expect(hostile).toEqual({ team: 'general', tag: 'GSR-7F3K2', topic: null, page: null, lang: null });
  });
});

describe('usernames', () => {
  it('reads what a person types, and refuses what Telegram would', () => {
    expect(normalizeUsername('@ali_gsr')).toEqual({ ok: true, value: 'ali_gsr' });
    expect(normalizeUsername('https://t.me/ali_gsr')).toEqual({ ok: true, value: 'ali_gsr' });
    expect(normalizeUsername('t.me/ali_gsr/')).toEqual({ ok: true, value: 'ali_gsr' });
    expect(normalizeUsername('  ')).toEqual({ ok: true, value: null });
    expect(normalizeUsername('ali')).toEqual({ ok: false }); // under five
    expect(normalizeUsername('9ali_gsr')).toEqual({ ok: false }); // a digit first
    expect(normalizeUsername('ali gsr')).toEqual({ ok: false });
  });

  it('a collectible-only account still has a handle', () => {
    expect(primaryUsername({ username: 'ali_gsr' })).toBe('ali_gsr');
    expect(
      primaryUsername({
        username: null,
        usernames: [
          { username: 'old_gsr', active: false },
          { username: 'ali_gsr', active: true },
        ],
      }),
    ).toBe('ali_gsr');
    expect(primaryUsername({ usernames: [{ username: 'gone', active: false }] })).toBeNull();
    expect(primaryUsername({})).toBeNull();
  });
});

describe('where a visitor can be sent, and whether we will see it', () => {
  const now = new Date('2026-09-26T10:00:00Z');
  const recently = new Date(now.getTime() - 30_000);
  const account = (over: Partial<{ status: string; lastSeenAt: Date | null; username: string | null; checkedAt: Date | null }> = {}) => ({
    status: 'active',
    lastSeenAt: recently,
    username: 'ali_gsr',
    checkedAt: recently,
    ...over,
  });

  it('a live connected account with a fresh handle is reachable AND captured', () => {
    expect(reachableAt({ typedUsername: null, account: account() }, now)).toMatchObject({
      ok: true,
      username: 'ali_gsr',
      source: 'verified',
      capturable: true,
    });
  });

  it('the same handle with the listener down is reachable but NOT captured', () => {
    const quiet = account({ lastSeenAt: new Date(now.getTime() - 5 * 60_000) });
    expect(reachableAt({ typedUsername: null, account: quiet }, now)).toMatchObject({
      ok: true,
      source: 'verified',
      capturable: false,
    });
  });

  it('a handle nobody has confirmed lately is not handed out', () => {
    const stale = account({ checkedAt: new Date(now.getTime() - USERNAME_FRESH_MS - 1) });
    expect(reachableAt({ typedUsername: null, account: stale }, now)).toMatchObject({
      ok: false,
      reason: 'username_stale',
    });
    // …but a typed one stands in, honestly uncaptured.
    expect(reachableAt({ typedUsername: 'ali_tel', account: stale }, now)).toMatchObject({
      ok: true,
      username: 'ali_tel',
      source: 'typed',
      capturable: false,
    });
  });

  it('a typed handle alone is reachable and never captured; nothing at all is not reachable', () => {
    expect(reachableAt({ typedUsername: 'vali_gsr', account: null }, now)).toMatchObject({
      ok: true,
      source: 'typed',
      capturable: false,
    });
    expect(reachableAt({ typedUsername: null, account: null }, now)).toMatchObject({
      ok: false,
      reason: 'no_username',
    });
  });
});

describe('least busy first', () => {
  const at = (minutes: number) => new Date(Date.UTC(2026, 8, 26, 6, minutes));
  it('fewest units, then longest since, and «not yet today» at the front', () => {
    const ranked = rankByLoad([
      { userId: 'c', name: 'C', units: 1, lastAt: at(5) },
      { userId: 'a', name: 'A', units: 1, lastAt: at(1) },
      { userId: 'b', name: 'B', units: 2, lastAt: null },
      { userId: 'd', name: 'D', units: 1, lastAt: null },
    ]);
    expect(ranked.map((r) => r.userId)).toEqual(['d', 'a', 'c', 'b']);
  });

  it('two runs over the same numbers agree', () => {
    const rows = [
      { userId: 'y', name: 'Y', units: 0, lastAt: null },
      { userId: 'x', name: 'X', units: 0, lastAt: null },
    ];
    expect(rankByLoad(rows).map((r) => r.userId)).toEqual(['x', 'y']);
    expect(rankByLoad([...rows].reverse()).map((r) => r.userId)).toEqual(['x', 'y']);
  });
});

describe('the limiter', () => {
  it('keys IPv6 by its /64 and an unknown caller into one shared bucket', () => {
    expect(ipKey('203.0.113.7')).toBe('203.0.113.7');
    expect(ipKey('2001:db8:1:2:aaaa:bbbb:cccc:dddd')).toBe('2001:db8:1:2::/64');
    expect(ipKey('2001:db8:1:2::9')).toBe('2001:db8:1:2::/64');
    expect(ipKey('2001:db8::1')).toBe('2001:db8:0:0::/64');
    expect(ipKey(null)).toBe('unknown');
    expect(ipKey('')).toBe('unknown');
  });

  it('spends its capacity, refuses, then refills with time', () => {
    const buckets = new TokenBuckets(2, 1 / 1000);
    expect(buckets.take('k', 0)).toBe(true);
    expect(buckets.take('k', 0)).toBe(true);
    expect(buckets.take('k', 0)).toBe(false);
    expect(buckets.take('other', 0)).toBe(true); // one caller's flood is not another's
    expect(buckets.take('k', 1000)).toBe(true);
    expect(buckets.take('k', 1000)).toBe(false);
  });
});

describe('what a tag in a message may do', () => {
  const row = (body: string, over: Partial<MessageRow> = {}) => ({
    direction: 'in' as const,
    body,
    fwdFrom: null,
    ...over,
  });
  const messageRow = { peerId: 1n, tgMessageId: 1n, direction: 'in', body: 'x', hasMedia: false, sentAt: new Date(), replyToTgMessageId: null, fwdFrom: null } as MessageRow;
  const tag = 'Salom GSR-7F3K2';

  it('lands a stranger: the tray question, a hidden number, a work account lead', () => {
    const ask: LiveVerdict = { store: false, ask: true, peerId: 1n, phone: '998901112233', title: 'A' };
    const hidden: LiveVerdict = { store: false, reason: 'no_phone' };
    const work: LiveVerdict = { store: true, openLead: true, peer: { phone: '1', title: 'A' }, row: messageRow };
    for (const verdict of [ask, hidden, work]) {
      expect(siteTagAction(verdict, row(tag))).toEqual({ kind: 'land', tag: 'GSR-7F3K2' });
    }
  });

  it('a chat that already has an owner only confirms', () => {
    const client: LiveVerdict = { store: true, clientId: 'c1', clientCode: 'GS1', row: messageRow };
    const lead: LiveVerdict = { store: true, leadId: 'l1', row: messageRow };
    expect(siteTagAction(client, row(tag))).toEqual({ kind: 'confirm', tag: 'GSR-7F3K2', clientId: 'c1', leadId: null });
    expect(siteTagAction(lead, row(tag))).toEqual({ kind: 'confirm', tag: 'GSR-7F3K2', clientId: null, leadId: 'l1' });
  });

  it('a written «never», Saved Messages, a bot and a group all win over the tag', () => {
    for (const reason of ['excluded', 'self', 'is_bot', 'not_private', 'empty'] as const) {
      expect(siteTagAction({ store: false, reason }, row(tag)), reason).toBeNull();
    }
  });

  it('only the visitor arriving — never our own message, a forward, or no tag', () => {
    const ask: LiveVerdict = { store: false, reason: 'no_phone' };
    expect(siteTagAction(ask, row(tag, { direction: 'out' }))).toBeNull();
    expect(siteTagAction(ask, row(tag, { fwdFrom: 'Ali' }))).toBeNull();
    expect(siteTagAction(ask, row(tag, { fwdFrom: '' }))).toBeNull(); // forwarded, source hidden
    expect(siteTagAction(ask, row('Salom'))).toBeNull();
  });
});

describe('the stale-book refresh', () => {
  it('is keyed on the verdicts a stranger actually gets', () => {
    const messageRow = { peerId: 1n } as MessageRow;
    expect(suspectsStaleBook({ store: false, ask: true, peerId: 1n, phone: '1', title: 'A' })).toBe(true);
    expect(suspectsStaleBook({ store: true, openLead: true, peer: { phone: '1', title: 'A' }, row: messageRow })).toBe(true);
    expect(suspectsStaleBook({ store: false, reason: 'no_phone' })).toBe(false);
    expect(suspectsStaleBook({ store: true, clientId: 'c', clientCode: 'GS1', row: messageRow })).toBe(false);
  });
});

describe('the allowed pages', () => {
  it('an origin is exactly scheme and host', () => {
    expect(isOrigin('https://gsrlogistics.uz')).toBe(true);
    expect(isOrigin('https://gsrlogistics.uz/')).toBe(false);
    expect(isOrigin('http://gsrlogistics.uz')).toBe(false);
    expect(isOrigin('gsrlogistics.uz')).toBe(false);
  });

  it('the setting is read leniently and saved strictly', () => {
    expect(parseOrigins('https://a.uz, https://www.a.uz junk')).toEqual([
      'https://a.uz',
      'https://www.a.uz',
    ]);
    expect(originsSettingValid('https://a.uz https://www.a.uz')).toBe(true);
    expect(originsSettingValid('https://a.uz junk')).toBe(false);
    expect(originsSettingValid('')).toBe(true); // empty = the door is closed
  });
});
