import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { describe, expect, it } from 'vitest';
import { FOUNDERS, MUTE_GROUPS, groupsFromList, isTelegramMuted } from '@/modules/platform/notifications/mutes';
import { THREAD_PING_TYPES } from '@/modules/platform/notifications/thread-ref';
import { contactEvidenceSql } from '@/modules/wms/crm/first-contact';
import { sql } from 'drizzle-orm';
import { PgDialect } from 'drizzle-orm/pg-core';

/**
 * E8 a — «Ichki yozishmalar» is a mute group of its own (0127), and E11 a —
 * a thread message is never advert-lead contact.
 */
describe('the chat mute group (E8 a)', () => {
  it('holds every thread ping, born whole — its founders are its members', () => {
    for (const type of THREAD_PING_TYPES) expect(MUTE_GROUPS.chat as readonly string[], type).toContain(type);
    expect([...FOUNDERS.chat]).toEqual([...MUTE_GROUPS.chat]);
  });

  it('muting «ish jarayoni» no longer silences a colleague', () => {
    expect(MUTE_GROUPS.operations as readonly string[]).not.toContain('InternalNote');
    expect(MUTE_GROUPS.operations as readonly string[]).not.toContain('MentionedInNote');
    // A shown customer message is not a thread and cannot be replied to.
    expect(MUTE_GROUPS.operations as readonly string[]).toContain('ChatMessageShared');
    expect(isTelegramMuted([...FOUNDERS.operations], 'InternalNote')).toBe(false);
    expect(isTelegramMuted([...FOUNDERS.operations], 'CalcThread')).toBe(false);
    expect(isTelegramMuted([...MUTE_GROUPS.operations], 'MentionedInNote')).toBe(false);
  });

  it('its own box mutes all three, and «all» still does', () => {
    expect(isTelegramMuted([...MUTE_GROUPS.chat], 'MentionedInNote')).toBe(true);
    expect(isTelegramMuted([...MUTE_GROUPS.chat], 'CalcThread')).toBe(true);
    expect(isTelegramMuted(['all'], 'CalcThread')).toBe(true);
  });

  it('Q3 a — a former «ish jarayoni» muter, after 0127’s strip, reads «Ichki yozishmalar» unticked and hears it', () => {
    // The list a post-07-28 save wrote (every member «operations» had the day
    // before 0127 — the literal the strip's own integration test runs), with
    // the two names 0127 removes taken out. A STORED list from a real day,
    // never one computed from today's groups (#1116).
    const stripped = [
      'ClientBirthday',
      'ReceiptConfirmed',
      'UnknownCargoReceived',
      'ReadyForPickup',
      'BoxIssued',
      'PlanApproved',
      'PlanChangesRequested',
      'InventoryCompleted',
      'LoadFinished',
      'UnloadFinished',
      'BatchRerouted',
      'ChatMessageShared',
      'AutomationRule',
      'CalcDictReview',
      'CalcOffer',
    ];
    const read = groupsFromList(stripped);
    // The profile tells the truth: their old box still ticked, the new one not —
    // the star is «they mute it themselves on /profile», never pre-muted.
    expect(read.groups.operations).toBe(true);
    expect(read.groups.chat).toBe(false);
    for (const type of MUTE_GROUPS.chat) expect(isTelegramMuted(stripped, type), type).toBe(false);
  });

  it('the profile draws its box for everybody', () => {
    const page = readFileSync(resolve(__dirname, '../../src/app/(protected)/profile/page.tsx'), 'utf8');
    expect(page).toContain('name="mute_chat"');
    expect(page).toContain('data-testid="profile-mute-chat"');
  });
});

describe('E11 a — a thread message is not contact', () => {
  it('the NOTE branch excludes the tag and the Telegram landing inside the responsible half only', () => {
    const text = new PgDialect().sqlToQuery(
      contactEvidenceSql({ leadId: sql`l.id`, since: sql`now()`, ownerId: sql`l.owner_id`, assignedId: sql`null` }),
    ).sql;
    const note = text.slice(text.indexOf("'note'::text"), text.indexOf("'stage'::text"));
    const responsibleHalf = note.slice(0, note.indexOf("ca.kind = 'call'"));
    expect(responsibleHalf).toContain("(to_jsonb(ca) ->> 'calc_request_id') IS NULL");
    expect(responsibleHalf).toContain("(to_jsonb(ca) ->> 'tg_message_id') IS NULL");
    // The «📞 Bog'landim» note still counts from anybody — not narrowed.
    const buttonHalf = note.slice(note.indexOf("ca.kind = 'call'"));
    expect(buttonHalf).not.toContain('to_jsonb');
  });
});
