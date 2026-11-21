import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';
import {
  SEAT_HEADROOM,
  SEAT_REFUSAL_WORDS,
  SEAT_REFUSALS,
  seatVerdictOf,
  type SeatFacts,
  type SeatRefusal,
} from '@/modules/wms/agent/seat-candidate';
import { seatDisplayName, SEAT_TITLE } from '@/modules/wms/agent/seat-contact';
import { LEAD_TEAMS, siteAiAsks } from '@/modules/wms/crm/site-assign-rules';
import { AGENT_LIMITS } from '@/modules/wms/agent/limits';
import { audienceFromUrl } from '@/modules/platform/broadcast/audience-url';

/**
 * Stage 1a «Hajm» (his 6 c): the AI seat takes a website visitor only when it would answer by itself. The verdict is
 * pure — every clause is dropped here in turn against one healthy fact set, so a clause deleted from
 * `seatVerdictOf` turns its own row red; the database half (one statement, the savepoint, the roster answering) is
 * `tests/integration/site-assign.integration.test.ts`.
 */

const NOW = new Date('2026-11-20T09:00:00.000Z');
const ago = (ms: number) => new Date(NOW.getTime() - ms);
const SEAT = '0b5f7a1e-0000-4000-8000-000000000001';

function healthy(): SeatFacts {
  return {
    seatId: SEAT,
    seatLive: true,
    seatName: 'AI o‘rni',
    holderId: SEAT,
    mode: 'shadow',
    sessionConfirmed: true,
    startedAt: ago(60 * 86_400_000),
    armed: true,
    workAccount: true,
    sendingEnabled: true,
    account: { status: 'active', lastSeenAt: ago(10_000), username: 'gsr_ai_seat', checkedAt: ago(5 * 60_000) },
    guard: { pausedAt: null, floodUntil: null, agentPumpAt: ago(30_000), caughtUpAt: ago(60 * 60_000) },
    sendsToday: 0,
    dayCap: null,
    ownSends: null,
  };
}

/** One change per reason — the verdict must name exactly it (the first that holds). */
const ONE_CHANGE: Record<Exclude<SeatRefusal, 'no_ai_key' | 'unreadable'>, (f: SeatFacts) => void> = {
  no_seat: (f) => {
    f.seatId = null;
  },
  seat_not_holder: (f) => {
    f.holderId = '0b5f7a1e-0000-4000-8000-000000000002';
  },
  agent_off: (f) => {
    f.mode = 'off';
  },
  not_armed: (f) => {
    f.armed = false;
  },
  not_work_account: (f) => {
    f.workAccount = false;
  },
  sending_disabled: (f) => {
    f.sendingEnabled = false;
  },
  not_connected: (f) => {
    f.account = { ...f.account!, lastSeenAt: ago(10 * 60_000) };
  },
  no_handle: (f) => {
    f.account = { ...f.account!, checkedAt: ago(2 * 3_600_000) };
  },
  paused: (f) => {
    f.guard = { ...f.guard, pausedAt: ago(60_000) };
  },
  flood: (f) => {
    f.guard = { ...f.guard, floodUntil: new Date(NOW.getTime() + 60_000) };
  },
  listener_behind: (f) => {
    f.guard = { ...f.guard, agentPumpAt: ago(10 * 60_000) };
  },
  day_cap: (f) => {
    f.sendsToday = AGENT_LIMITS.perDay - SEAT_HEADROOM + 1;
  },
};

describe('seatVerdictOf — the seat takes a visitor only when it answers by itself', () => {
  it('a healthy seat takes one, with the handle Telegram itself confirmed', () => {
    expect(seatVerdictOf(healthy(), NOW, true)).toEqual({
      ok: true,
      userId: SEAT,
      username: 'gsr_ai_seat',
      name: 'AI o‘rni',
    });
  });

  it.each(Object.keys(ONE_CHANGE) as (keyof typeof ONE_CHANGE)[])('one clause off → «%s», and nothing else', (reason) => {
    const f = healthy();
    ONE_CHANGE[reason](f);
    expect(seatVerdictOf(f, NOW, true)).toEqual({ ok: false, reason });
  });

  it('no model key is «no» before anything is read', () => {
    expect(seatVerdictOf(healthy(), NOW, false)).toEqual({ ok: false, reason: 'no_ai_key' });
  });

  it('a seat that cannot log in is no seat (a reused tag is answered only for a colleague)', () => {
    const f = healthy();
    f.seatLive = false;
    expect(seatVerdictOf(f, NOW, true)).toEqual({ ok: false, reason: 'no_seat' });
  });

  it('a session never confirmed is the agent off', () => {
    const f = healthy();
    f.sessionConfirmed = false;
    expect(seatVerdictOf(f, NOW, true)).toEqual({ ok: false, reason: 'agent_off' });
  });

  it('no account at all, and a signed-out one, are «not connected»', () => {
    const none = healthy();
    none.account = null;
    expect(seatVerdictOf(none, NOW, true)).toEqual({ ok: false, reason: 'not_connected' });
    const out = healthy();
    out.account = { ...out.account!, status: 'signed_out' };
    expect(seatVerdictOf(out, NOW, true)).toEqual({ ok: false, reason: 'not_connected' });
  });

  it('a verified handle never read is «no handle» — a TYPED one is never handed out for the seat', () => {
    const f = healthy();
    f.account = { ...f.account!, username: null, checkedAt: null };
    expect(seatVerdictOf(f, NOW, true)).toEqual({ ok: false, reason: 'no_handle' });
  });

  it('a listener whose catch-up is not done is behind, as the ✅ judges it', () => {
    const f = healthy();
    f.guard = { ...f.guard, caughtUpAt: null };
    expect(seatVerdictOf(f, NOW, true)).toEqual({ ok: false, reason: 'listener_behind' });
  });

  it('a flood wait that has ended stops nothing', () => {
    const f = healthy();
    f.guard = { ...f.guard, floodUntil: ago(1_000) };
    expect(seatVerdictOf(f, NOW, true).ok).toBe(true);
  });

  it('the headroom is counted against his stored day cap, and exactly SEAT_HEADROOM left still takes one', () => {
    const f = healthy();
    f.dayCap = 40;
    f.sendsToday = 40 - SEAT_HEADROOM;
    expect(seatVerdictOf(f, NOW, true).ok).toBe(true);
    f.sendsToday += 1;
    expect(seatVerdictOf(f, NOW, true)).toEqual({ ok: false, reason: 'day_cap' });
  });

  it('inside the ramp the ceiling is his own average, as the ✅ counts it', () => {
    const f = healthy();
    f.startedAt = ago(3 * 86_400_000);
    // 300 own sends in the 30 days before the start: 10 a day — exactly the headroom, so the first send of the
    // day already leaves too little.
    f.ownSends = 300;
    expect(seatVerdictOf(f, NOW, true).ok).toBe(true);
    f.sendsToday = 1;
    expect(seatVerdictOf(f, NOW, true)).toEqual({ ok: false, reason: 'day_cap' });
  });

  it('an agent never started has no ceiling to send under', () => {
    const f = healthy();
    f.startedAt = null;
    expect(seatVerdictOf(f, NOW, true)).toEqual({ ok: false, reason: 'day_cap' });
  });
});

describe('the reasons, in his words (J32)', () => {
  it('every reason has its words and the map holds nothing else', () => {
    expect(Object.keys(SEAT_REFUSAL_WORDS).sort()).toEqual([...SEAT_REFUSALS].sort());
    expect(Object.keys(SEAT_REFUSAL_WORDS)).toHaveLength(SEAT_REFUSALS.length);
  });

  it('a word is a sentence, never the code itself', () => {
    for (const reason of SEAT_REFUSALS) {
      const words = SEAT_REFUSAL_WORDS[reason];
      expect(words.trim().length, reason).toBeGreaterThan(8);
      expect(words, reason).not.toMatch(/_/u);
    }
  });

  it('every reason but the read failure is reachable from the verdict (no dead word)', () => {
    const reachable = new Set<string>(['no_ai_key', 'unreadable', ...Object.keys(ONE_CHANGE)]);
    expect([...SEAT_REFUSALS].filter((r) => !reachable.has(r))).toEqual([]);
  });
});

describe('which website teams the AI choice covers (his 6 c, ⭐ 1)', () => {
  it('off covers none; all covers every team but «Sotib olib berish»', () => {
    for (const team of LEAD_TEAMS) expect(siteAiAsks('off', team), team).toBe(false);
    expect(siteAiAsks('all', 'cargo')).toBe(true);
    expect(siteAiAsks('all', 'general')).toBe(true);
    expect(siteAiAsks('all', 'buying')).toBe(false);
  });
});

describe('the seat as a client contact', () => {
  it('the title, then the persona’s name when one is set', () => {
    expect(seatDisplayName('')).toBe(SEAT_TITLE);
    expect(seatDisplayName('  ')).toBe(SEAT_TITLE);
    expect(seatDisplayName('Sinov')).toBe(`${SEAT_TITLE} Sinov`);
  });
});

describe('the broadcast page’s address bar keeps the «no seller» fence (J13)', () => {
  const tooLong = 'G'.repeat(21); // a code longer than a code: the schema refuses the whole URL

  it('a URL the schema refuses keeps the tick — the AI number’s message never widens to every seller’s customer', () => {
    expect(audienceFromUrl({ sotuvchisiz: '1', kod: tooLong })).toEqual({
      sectors: [],
      cargoKinds: [],
      locales: [],
      codes: [],
      noManager: true,
    });
    expect(audienceFromUrl({ sotuvchisiz: '1', hodim: 'qo‘lda-yozilgan' }).noManager).toBe(true);
  });

  it('without the tick the refused URL falls back as it always has; an accepted one reads as typed', () => {
    expect(audienceFromUrl({ kod: tooLong })).toEqual({ sectors: [], cargoKinds: [], locales: [], codes: [] });
    expect(audienceFromUrl({ sotuvchisiz: '1', kod: 'GS1, gs2' })).toMatchObject({ codes: ['GS1', 'gs2'], noManager: true });
    expect(audienceFromUrl({ sotuvchisiz: 'ha' }).noManager).toBeUndefined();
  });
});

describe('the seat files stay light — they join the listener’s closure (site-assign.ts, client-cabinet/service.ts)', () => {
  const strip = (src: string) => src.replace(/\/\*[\s\S]*?\*\//g, '').replace(/(^|[^:])\/\/.*$/gm, '$1');
  for (const file of ['src/modules/wms/agent/seat-candidate.ts', 'src/modules/wms/agent/seat-contact.ts']) {
    it(`${file} imports no run, press or auto layer`, () => {
      const src = strip(readFileSync(file, 'utf8'));
      const from = [...src.matchAll(/from\s+['"]([^'"]+)['"]/g)].map((m) => m[1]!);
      expect(from.length).toBeGreaterThan(0);
      for (const heavy of ['/run', '/decide', '/auto-send', '/auto-gate', '/prompt', '/policy', '/tools']) {
        expect(from.filter((f) => f.endsWith(heavy)), heavy).toEqual([]);
      }
    });
  }

  it('the door asks the seat INSIDE its transaction, on that transaction — and the choice on the pool before it', () => {
    const src = strip(readFileSync('src/modules/wms/crm/site-assign.ts', 'utf8'));
    const start = src.indexOf('export async function assignForTag(');
    const body = src.slice(start, src.indexOf('\n}\n', start));
    const tx = body.indexOf('db.transaction(');
    expect(body.indexOf('readLeadAssignAi()')).toBeGreaterThan(-1);
    expect(body.indexOf('readLeadAssignAi()')).toBeLessThan(tx);
    expect(body.slice(tx)).toMatch(/siteAiAsks\(mode, input\.team\)[\s\S]*seatCandidate\(tx, now\)/u);
    // Under the door's budget and BEFORE the lock (the review's D1): a slow seat read held under the lock made every
    // visitor queued behind it time out on the lock itself — «nobody» because of the AI.
    const budget = body.indexOf("SET LOCAL statement_timeout = '400ms'");
    const seat = body.indexOf('seatCandidate(tx, now)');
    expect(budget).toBeGreaterThan(-1);
    expect(budget).toBeLessThan(seat);
    expect(seat).toBeLessThan(body.indexOf("pg_advisory_xact_lock(hashtext('lead_assign'))"));
    // …and before the roster, which answers whenever the seat does not.
    expect(seat).toBeLessThan(body.indexOf('pickAssignee(input.team, tx, now)'));
  });

  it('the broadcast narrowed to ticked codes keeps the «no seller» fence (J13)', () => {
    const src = strip(readFileSync('src/app/(protected)/admin/xabarlar/composer.tsx', 'utf8'));
    expect(src).toMatch(/codes: picked, \.\.\.\(audience\.noManager \? \{ noManager: true \} : \{\}\)/u);
  });

  it('the seat’s facts are read in a savepoint of the handle it is given (J23)', () => {
    const src = strip(readFileSync('src/modules/wms/agent/seat-candidate.ts', 'utf8'));
    const start = src.indexOf('export async function seatCandidate(');
    const body = src.slice(start, src.indexOf('\n}\n', start));
    expect(body).toMatch(/handle\.transaction\(async \(sp\) => \{[\s\S]*return readSeatFacts\(sp, now\);/u);
    // On the pool (the roster page) the read carries the door's budget itself; inside the door it never sets one.
    expect(body).toMatch(/if \(handle === db\) await sp\.execute\(sql`SET LOCAL statement_timeout = '400ms'`\)/u);
    expect(body).toMatch(/catch \(err\)[\s\S]*refused\('unreadable'\)/u);
  });
});
