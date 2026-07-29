import { describe, expect, it } from 'vitest';
import {
  classifyDialog,
  countVerdict,
  emptySummary,
  isWorthKeeping,
  toMessageRow,
  type ClientPhones,
  type DialogPeer,
  mediaBackfillPlan,
} from '@/modules/wms/crm/telegram-import';

/**
 * What may be read from a manager's personal Telegram, and what may not.
 *
 * This is the whole of the privacy promise made to twelve employees: their
 * family, their friends and their other business stay out of the company
 * database. The promise is one function, so it is tested like one.
 */

const CLIENTS: ClientPhones[] = [
  { id: 'c-777', clientCode: 'GS777', phones: ['+998901234567'] },
  { id: 'c-555', clientCode: 'GS555', phones: ['998 90 765 43 21', '+998911111111'] },
];

const peer = (over: Partial<DialogPeer> = {}): DialogPeer => ({
  id: 42n,
  isPrivate: true,
  phone: '+998901234567',
  ...over,
});

describe('whose conversations are ours to keep', () => {
  it('keeps a private chat whose number is in the client book', () => {
    expect(classifyDialog(peer(), CLIENTS)).toEqual({
      keep: true,
      clientId: 'c-777',
      clientCode: 'GS777',
    });
  });

  it('matches however either side wrote the number', () => {
    // The client book holds "998 90 765 43 21" with spaces and no plus;
    // Telegram reports "+998907654321". Same person, and a match that only
    // worked on identical strings would drop half the client base.
    expect(classifyDialog(peer({ phone: '+998907654321' }), CLIENTS)).toMatchObject({
      keep: true,
      clientCode: 'GS555',
    });
  });

  it('REFUSES a chat with somebody who is not a client', () => {
    // The manager's brother. Nothing about this conversation is the company's,
    // and it must not be stored, summarised, or logged by name.
    expect(classifyDialog(peer({ phone: '+998999999999' }), CLIENTS)).toEqual({
      keep: false,
      reason: 'not_a_client',
    });
  });

  it('refuses groups, channels and bots outright', () => {
    expect(classifyDialog(peer({ isPrivate: false }), CLIENTS)).toEqual({
      keep: false,
      reason: 'not_private',
    });
    expect(classifyDialog(peer({ isBot: true }), CLIENTS)).toEqual({
      keep: false,
      reason: 'is_bot',
    });
  });

  it('separates "no number visible" from "not a client"', () => {
    /**
     * Telegram only reveals a phone number to contacts. A manager who never
     * saved their clients in the address book produces a pile of these — and
     * that is a FIXABLE problem ("save them as contacts, run it again"), where
     * `not_a_client` is simply somebody else's conversation. Reporting both as
     * one number would hide a bad import behind a plausible one.
     */
    expect(classifyDialog(peer({ phone: null }), CLIENTS)).toEqual({
      keep: false,
      reason: 'no_phone',
    });
    expect(classifyDialog(peer({ phone: '   ' }), CLIENTS)).toEqual({
      keep: false,
      reason: 'no_phone',
    });
  });

  it('never matches on a name or a username', () => {
    // Only the phone decides. A namesake — or somebody who set their display
    // name to a client's — must not open that client's thread.
    const impostor = peer({ phone: null, firstName: 'GS777', username: 'gs777' });
    expect(classifyDialog(impostor, CLIENTS).keep).toBe(false);
  });
});

describe('what one message becomes', () => {
  it('reads Telegram’s seconds as seconds', () => {
    // `date` is SECONDS. Treating it as milliseconds files every conversation
    // in January 1970 — which sorts correctly against itself, so nobody
    // notices until they look at a date.
    const row = toMessageRow(42n, { id: 7, date: 1_785_000_000, message: 'salom' });
    expect(row.sentAt.getUTCFullYear()).toBe(2026);
    expect(row.sentAt.toISOString()).toBe(new Date(1_785_000_000_000).toISOString());
  });

  it('knows who spoke', () => {
    expect(toMessageRow(1n, { id: 1, date: 1, out: true }).direction).toBe('out');
    expect(toMessageRow(1n, { id: 1, date: 1 }).direction).toBe('in');
  });

  it('keeps a photo with no caption, and drops an empty service entry', () => {
    const photo = toMessageRow(1n, { id: 2, date: 1, message: '', media: { photo: true } });
    expect(photo.body).toBeNull();
    expect(photo.hasMedia).toBe(true);
    expect(isWorthKeeping(photo)).toBe(true);

    // "user joined", "call ended" — no text, no media, no reason to be in a
    // thread somebody has to read.
    const service = toMessageRow(1n, { id: 3, date: 1, message: '   ' });
    expect(isWorthKeeping(service)).toBe(false);
  });

  it('carries Telegram’s own ids, which is what makes a re-run free', () => {
    const row = toMessageRow(9_999_999_999n, { id: 123456, date: 1 });
    expect(row.peerId).toBe(9_999_999_999n);
    expect(row.tgMessageId).toBe(123456n);
  });
});

describe('what the operator is told afterwards', () => {
  it('counts each refusal under its own reason', () => {
    const s = emptySummary();
    countVerdict(s, classifyDialog(peer(), CLIENTS));
    countVerdict(s, classifyDialog(peer({ phone: null }), CLIENTS));
    countVerdict(s, classifyDialog(peer({ phone: '+998000000000' }), CLIENTS));
    countVerdict(s, classifyDialog(peer({ isPrivate: false }), CLIENTS));

    expect(s).toMatchObject({
      dialogsSeen: 4,
      matched: 1,
      skippedNoPhone: 1,
      skippedNotClient: 1,
      skippedOther: 1,
    });
  });
});

/**
 * The `--media` backfill's one decision (round 22): which stored rows still
 * owe their photograph. Pure, because the cap is a storage promise — MinIO
 * holds ~1.5 GB with no off-site copy yet, and an uncapped backfill is a
 * storage incident, not a feature.
 */
describe('which photographs a --media run may fetch', () => {
  const row = (minutesAgo: number, hasMedia: boolean, hasPhoto: boolean) => ({
    hasMedia,
    hasPhoto,
    sentAt: new Date(1_700_000_000_000 - minutesAgo * 60_000),
  });

  it('takes only media rows that lack their photo, newest first, capped', () => {
    const plan = mediaBackfillPlan(
      [row(30, true, false), row(10, true, false), row(20, true, true), row(5, false, false)],
      1,
    );
    expect(plan).toHaveLength(1);
    // The newest photo-less media row wins the single slot.
    expect(plan[0]!.sentAt.getTime()).toBe(1_700_000_000_000 - 10 * 60_000);
  });

  it('an already-fetched photo is never fetched twice, and zero cap fetches nothing', () => {
    expect(mediaBackfillPlan([row(1, true, true)], 50)).toHaveLength(0);
    expect(mediaBackfillPlan([row(1, true, false)], 0)).toHaveLength(0);
  });
});
