import { readdirSync, readFileSync, statSync } from 'node:fs';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { contactClockFrom, contactDueAt } from '@/modules/wms/crm/first-contact';
import {
  deliveryOf,
  inboundLeadText,
  NOTE_CLIP,
  UNTOUCHED_LINES,
  untouchedText,
  type ArrivalText,
  type UntouchedLine,
} from '@/modules/wms/crm/inbound-text';
import { FOUNDERS, groupsFromList, isTelegramMuted, MUTE_GROUPS } from '@/modules/platform/notifications/mutes';
import { sendsSilently } from '@/modules/platform/notifications/night';
import { buttonsFor, LEAD_CONTACTED_BUTTON, parseCallback } from '@/modules/platform/telegram/staff-bot';
import { STALE_AUTOMATION_CRON } from '@/modules/platform/automation/stale-jobs';
import { OFFICE_OPEN_HOUR } from '@/modules/platform/time/office-hours';

/**
 * «Reklama lidi sotuvchiga darhol yetib borsin» (0113), where it is pure:
 * the office clock, the words of both pushes, the mute group, the button's
 * callback and the night rule. Every expected value is a LITERAL (#1116) —
 * a Tashkent wall-clock time typed out, a sentence as the seller reads it —
 * never a value computed by the code under test.
 */

/** A Tashkent wall-clock moment, `+05:00` spelled out. */
const tk = (dayTime: string) => new Date(`${dayTime}:00+05:00`);
const read = (p: string) =>
  readFileSync(p, 'utf8')
    .replace(/\/\*[\s\S]*?\*\//g, '')
    .replace(/^\s*\/\/.*$/gm, '');

describe('the first-contact clock is office time', () => {
  it('starts at the arrival inside the office day', () => {
    expect(contactClockFrom(tk('2026-09-01T09:00'))).toEqual(tk('2026-09-01T09:00'));
    expect(contactClockFrom(tk('2026-09-01T21:44'))).toEqual(tk('2026-09-01T21:44'));
    expect(contactClockFrom(tk('2026-09-01T21:59'))).toEqual(tk('2026-09-01T21:59'));
  });

  it('starts at the next 09:00 outside it — the night, and the hour before the office opens', () => {
    // 07:59 and 08:00 are both before the office: 08:00 is no longer the
    // customers' night (quietHour) but nobody has sat down yet (judge, 9).
    expect(contactClockFrom(tk('2026-09-01T07:59'))).toEqual(tk('2026-09-01T09:00'));
    expect(contactClockFrom(tk('2026-09-01T08:00'))).toEqual(tk('2026-09-01T09:00'));
    expect(contactClockFrom(tk('2026-09-01T08:59'))).toEqual(tk('2026-09-01T09:00'));
    expect(contactClockFrom(tk('2026-09-01T22:00'))).toEqual(tk('2026-09-02T09:00'));
    expect(contactClockFrom(tk('2026-09-01T23:30'))).toEqual(tk('2026-09-02T09:00'));
    expect(contactClockFrom(tk('2026-09-02T01:00'))).toEqual(tk('2026-09-02T09:00'));
  });

  it('the reminder falls 15 OFFICE minutes later — into the morning when the evening runs out', () => {
    expect(contactDueAt(tk('2026-09-01T10:00'), 15)).toEqual(tk('2026-09-01T10:15'));
    expect(contactDueAt(tk('2026-09-01T21:44'), 15)).toEqual(tk('2026-09-01T21:59'));
    // 21:46: fourteen minutes before closing, one left for the morning.
    expect(contactDueAt(tk('2026-09-01T21:46'), 15)).toEqual(tk('2026-09-02T09:01'));
    expect(contactDueAt(tk('2026-09-01T21:55'), 15)).toEqual(tk('2026-09-02T09:10'));
    // Fifteen minutes that end exactly at closing are due at the opening.
    expect(contactDueAt(tk('2026-09-01T21:45'), 15)).toEqual(tk('2026-09-02T09:00'));
    expect(contactDueAt(tk('2026-09-02T09:00'), 15)).toEqual(tk('2026-09-02T09:15'));
  });

  it('0 minutes means no reminder at all, and the clock itself does not read the minutes (judge, 12)', () => {
    expect(contactDueAt(tk('2026-09-01T10:00'), 0)).toBeNull();
    // The same 21:55 arrival is measured from 21:55 whatever the setting says.
    expect(contactClockFrom(tk('2026-09-01T21:55'))).toEqual(tk('2026-09-01T21:55'));
  });

  it('the automation sweep opens with the same office (one constant, not two)', () => {
    expect(OFFICE_OPEN_HOUR).toBe(9);
    // 09:20 Tashkent = 04:20 UTC, the schedule production has run since round 86.
    expect(STALE_AUTOMATION_CRON).toBe('20 4-14 * * *');
    expect(read('src/modules/platform/automation/stale-jobs.ts')).toContain('OFFICE_OPEN_HOUR');
  });
});

const created: ArrivalText = {
  kind: 'created',
  sourceName: 'Instagram',
  name: 'Aziz',
  phone: '+998901234567',
  volumeM3: 12.5,
  note: 'Guangzhoudan yuk bor',
  link: 'https://gsrwms.uz/crm/leads/abc',
};

describe('the seller’s push says who, how much, what they wrote — and ends in the card', () => {
  it('a new lead', () => {
    expect(inboundLeadText(created)).toBe(
      [
        '🆕 Yangi lid · Instagram',
        'Aziz · +998 90 123 45 67',
        '📦 12.5 kub',
        '«Guangzhoudan yuk bor»',
        'https://gsrwms.uz/crm/leads/abc',
      ].join('\n'),
    );
  });

  it('the same person again, a handover, a known client', () => {
    expect(inboundLeadText({ ...created, kind: 'joined' }).split('\n')[0]).toBe('🔁 Qayta yozdi · Instagram');
    expect(inboundLeadText({ ...created, kind: 'reassigned' }).split('\n')[0]).toBe('🆕 Lid sizga berildi · Instagram');
    expect(inboundLeadText({ ...created, kind: 'client', clientCode: 'GS123' }).split('\n')[0]).toBe(
      '📣 Mijoz GS123 reklamadan yozdi · Instagram',
    );
  });

  it('says WHY when it went to the office instead of a seller', () => {
    expect(inboundLeadText({ ...created, orphan: 'unowned' })).toContain('⚠️ Egasiz — taqsimotni tekshiring');
    expect(inboundLeadText({ ...created, orphan: 'inactive', ownerName: 'Bobur' })).toContain(
      '⚠️ Egasi (Bobur) ishlamaydi — boshqa sotuvchiga bering',
    );
    expect(inboundLeadText({ ...created, kind: 'client', orphan: 'no_manager' })).toContain(
      '⚠️ Mijozning menejeri yo‘q',
    );
    // …and the card is still the LAST line, so the drain lifts it to «↗️ Ochish».
    const lines = inboundLeadText({ ...created, orphan: 'unowned' }).split('\n');
    expect(lines.at(-1)).toBe('https://gsrwms.uz/crm/leads/abc');
  });

  it('prints no volume it was not given, no money, and clips the note in code points', () => {
    const bare = inboundLeadText({ ...created, volumeM3: null, name: null, note: null });
    expect(bare).toBe(['🆕 Yangi lid · Instagram', '+998 90 123 45 67', 'https://gsrwms.uz/crm/leads/abc'].join('\n'));
    expect(bare).not.toMatch(/\$/);
    // Emoji are two UTF-16 units; a slice would halve one (#1107).
    const long = inboundLeadText({ ...created, note: '📦'.repeat(400) });
    const quoted = long.split('\n').find((l) => l.startsWith('«'))!;
    expect(Array.from(quoted.slice(1, -1)).length).toBe(NOTE_CLIP);
    expect(quoted.endsWith('…»')).toBe(true);
  });
});

const line = (over: Partial<UntouchedLine> = {}): UntouchedLine => ({
  name: 'Aziz',
  phone: '+998901234567',
  sourceName: 'Instagram',
  ownerName: 'Bobur',
  delivery: 'not_linked',
  link: 'https://gsrwms.uz/crm/leads/abc',
  ...over,
});

describe('the owner’s reminder', () => {
  it('one lead: who, whose, whether the seller was even told — the card last', () => {
    expect(untouchedText([line()], { minutes: 15, ledgerLink: 'https://gsrwms.uz/crm/kelganlar' })).toBe(
      [
        '⏰ Reklama lidi 15 daqiqadan beri tegilmagan — tizimda qayd yo‘q',
        'Aziz · +998 90 123 45 67 · Instagram',
        'Egasi: Bobur — 📵 Telegrami ulanmagan',
        'https://gsrwms.uz/crm/leads/abc',
      ].join('\n'),
    );
  });

  it('many leads: ONE message, capped, the ledger last (judge, 9)', () => {
    const many = Array.from({ length: UNTOUCHED_LINES + 3 }, (_, i) => line({ name: `Lid ${i}` }));
    const text = untouchedText(many, { minutes: 15, ledgerLink: 'https://gsrwms.uz/crm/kelganlar' });
    expect(text.split('\n')[0]).toBe('⏰ 11 ta reklama lidi 15 daqiqadan beri tegilmagan — tizimda qayd yo‘q');
    expect(text).toContain('Lid 7');
    expect(text).not.toContain('Lid 8');
    expect(text).toContain('…va yana 3 ta');
    expect(text.split('\n').at(-1)).toBe('https://gsrwms.uz/crm/kelganlar');
  });

  it('an ownerless lead says so instead of naming nobody', () => {
    expect(untouchedText([line({ ownerName: null })], { minutes: 15, ledgerLink: null })).toContain(
      'Egasi yo‘q — taqsimotni tekshiring',
    );
  });

  it('reads the drain’s own settlement words', () => {
    expect(deliveryOf(null, null)).toBe('none');
    expect(deliveryOf('sent', null)).toBe('sent');
    expect(deliveryOf('pending', null)).toBe('queued');
    expect(deliveryOf('sending', null)).toBe('queued');
    expect(deliveryOf('failed', 'x')).toBe('failed');
    expect(deliveryOf('muted', 'telegram not linked')).toBe('not_linked');
    expect(deliveryOf('muted', 'muted by user')).toBe('muted');
    expect(deliveryOf('muted', 'user deactivated')).toBe('inactive');
  });
});

describe('the «leads» mute group', () => {
  it('holds both pushes, born whole — both are founders', () => {
    expect([...MUTE_GROUPS.leads]).toEqual(['InboundLeadArrived', 'InboundLeadUntouched']);
    expect([...FOUNDERS.leads]).toEqual(['InboundLeadArrived', 'InboundLeadUntouched']);
    expect(isTelegramMuted(['InboundLeadArrived', 'InboundLeadUntouched'], 'InboundLeadArrived')).toBe(true);
    // A seller who muted the morning call list did NOT mute new leads.
    expect(isTelegramMuted(['CrmFollowUps'], 'InboundLeadArrived')).toBe(false);
    expect(groupsFromList(['CrmFollowUps']).groups.leads).toBe(false);
  });

  it('every group has its checkbox on the profile form — a missing one un-mutes on the next save (#171)', () => {
    const page = readFileSync('src/app/(protected)/profile/page.tsx', 'utf8');
    for (const group of Object.keys(MUTE_GROUPS)) {
      expect(page, group).toContain(`name="mute_${group}"`);
    }
  });

  it('both types are sent from the module that owns them, by these names', () => {
    const src = read('src/modules/wms/crm/inbound-notify.ts');
    expect(src).toContain("type: 'InboundLeadArrived'");
    expect(src).toContain("type: 'InboundLeadUntouched'");
  });
});

const LEAD = '123e4567-e89b-12d3-a456-426614174000';

describe('«📞 Bog‘landim»', () => {
  it('parses back from every button the push draws, and nothing else', () => {
    const rows = buttonsFor('InboundLeadArrived', { text: 'x', leadId: LEAD })!;
    expect(rows).toEqual([[{ text: LEAD_CONTACTED_BUTTON, callback_data: `lc:${LEAD}` }]]);
    for (const row of rows) {
      for (const button of row) expect(parseCallback(button.callback_data)).toEqual({ kind: 'lead_contacted', leadId: LEAD });
    }
    for (const junk of ['lc:', 'lc:x', `lcx:${LEAD}`, `lc:${LEAD}:1`]) expect(parseCallback(junk), junk).toBeNull();
    expect(Buffer.byteLength(`lc:${LEAD}`)).toBeLessThanOrEqual(64);
  });

  it('is drawn only where there is a lead to answer for — a client’s message has none', () => {
    expect(buttonsFor('InboundLeadArrived', { text: 'x', clientId: LEAD })).toBeNull();
    expect(buttonsFor('InboundLeadUntouched', { text: 'x', leadId: LEAD })).toBeNull();
  });

  it('is handled BEFORE the approval guard, which returns on every kind it does not name (#939)', () => {
    const handlers = read('src/modules/platform/telegram/staff-handlers.ts');
    const branch = handlers.indexOf("parsed.kind === 'lead_contacted'");
    const guard = handlers.indexOf("parsed.kind !== 'approval'");
    expect(branch).toBeGreaterThan(0);
    expect(branch).toBeLessThan(guard);
  });
});

describe('the night rule is decided at SEND time', () => {
  const night = tk('2026-09-01T23:30');
  const day = tk('2026-09-01T11:00');
  it('an advert lead arrives silently at night and rings by day', () => {
    expect(sendsSilently('InboundLeadArrived', {}, night)).toBe(true);
    expect(sendsSilently('InboundLeadArrived', {}, day)).toBe(false);
  });
  it('touches no other type, and the queue-time burst flag wins at any hour', () => {
    expect(sendsSilently('TaskAssigned', {}, night)).toBe(false);
    expect(sendsSilently('InboundLeadArrived', { silent: true }, day)).toBe(true);
  });
});

/** Every `.ts` under a directory — the fence below walks all of `src/`. */
function sources(dir: string): string[] {
  return readdirSync(dir).flatMap((name) => {
    const path = join(dir, name);
    if (statSync(path).isDirectory()) return sources(path);
    return /\.tsx?$/.test(name) ? [path] : [];
  });
}

describe('the arrival ledger is written in raw SQL on the columns a behind database has (judge, 2)', () => {
  it('no drizzle insert into lead_intakes anywhere in src/', () => {
    // drizzle's insert names EVERY column the schema knows, so on a database
    // one migration behind it refuses the arrival — the replay fence — and a
    // retried advert creates a second lead. Derived over all of src/: a third
    // writer turns this red the day it is added.
    const offenders = sources('src').filter((file) => /\.insert\(\s*leadIntakes\s*\)/.test(read(file)));
    expect(offenders).toEqual([]);
  });
});
