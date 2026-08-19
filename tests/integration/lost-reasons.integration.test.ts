import 'dotenv/config';
import { eq, inArray } from 'drizzle-orm';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { db, pgClient } from '@/modules/platform/db/client';
import {
  clients,
  dealStages,
  deals,
  events,
  leads,
  lostReasons,
  roles,
  userRoles,
  users,
} from '@/modules/platform/db/schema';
import {
  createLead,
  listStages,
  moveLead,
  saveLostReason,
  updateLead,
} from '@/modules/wms/crm/service';
import { createDeal, moveDeal } from '@/modules/wms/deals/service';
import { salesAnalytics } from '@/modules/wms/crm/analytics';

/**
 * Round 98 part 2 — the lost-reason dictionary, the `closed_at` stamp, and
 * the analytics that read them.
 *
 * The dictionary is GLOBAL configuration: one active row anywhere switches
 * every lost move in the company from free text to the list. So this file
 * snapshots and clears the table first and restores it in afterAll — a
 * long-lived local database is a different oracle (#653), and a red proof
 * that throws before an in-test restore line leaves configuration behind
 * (#523), which is why the restore lives in afterAll and nowhere else.
 */

// A per-run counter beside the clock (#598): two fixtures minted in the same
// millisecond must still differ.
let seq = 0;
const MARK = `R98LR-${String(Date.now()).slice(-7)}-${++seq}`;

let actorId = '';
let openStage = '';
let wonStage = '';
let lostStage = '';
let openDealStage = '';
let clientId = '';
const madeLeads: string[] = [];
const madeDeals: string[] = [];
const madeReasons: string[] = [];
let priorReasons: (typeof lostReasons.$inferSelect)[] = [];

const ctx = () => ({ actorId, ip: null, userAgent: null });

beforeAll(async () => {
  const [admin] = await db
    .select({ id: users.id })
    .from(users)
    .innerJoin(userRoles, eq(userRoles.userId, users.id))
    .innerJoin(roles, eq(roles.id, userRoles.roleId))
    .where(eq(roles.code, 'super_admin'))
    .limit(1);
  actorId = admin!.id;

  const stages = await listStages();
  openStage = stages.find((s) => s.kind === 'open')!.id;
  wonStage = stages.find((s) => s.kind === 'won')!.id;
  lostStage = stages.find((s) => s.kind === 'lost')!.id;

  const dStages = await db.select().from(dealStages);
  openDealStage = dStages.find((s) => s.kind === 'open')!.id;

  const [client] = await db.select({ id: clients.id }).from(clients).limit(1);
  clientId = client!.id;

  priorReasons = await db.select().from(lostReasons);
  await db.delete(lostReasons);
});

afterAll(async () => {
  await db.delete(events).where(inArray(events.entityId, [...madeLeads, ...madeDeals]));
  if (madeDeals.length > 0) await db.delete(deals).where(inArray(deals.id, madeDeals));
  if (madeLeads.length > 0) await db.delete(leads).where(inArray(leads.id, madeLeads));
  // The dictionary back exactly as found — rows this file minted out, rows
  // that were there before back in.
  await db.delete(lostReasons);
  if (priorReasons.length > 0) await db.insert(lostReasons).values(priorReasons);
  await pgClient.end();
});

const newLead = async (stageId = openStage) => {
  const lead = await createLead({ name: `${MARK}-${++seq} lid`, stageId }, ctx());
  madeLeads.push(lead.id);
  return lead.id;
};

const leadRow = async (id: string) => (await db.select().from(leads).where(eq(leads.id, id)))[0]!;

const formInput = (over: Record<string, unknown> = {}) => ({
  name: `${MARK} lid`,
  phone: '',
  company: '',
  sourceId: '',
  ownerId: '',
  note: '',
  nextActionAt: '',
  nextActionNote: '',
  ...over,
});

describe('closed_at — when the card was decided (0076)', () => {
  it('stamps a win, and a revival clears it', async () => {
    const id = await newLead();
    expect((await leadRow(id)).closedAt).toBeNull();

    // `viaConvert` — this file's subject is the CLOCK, not the win ceremony
    // (round 107 made bare won moves a refusal; the ceremony has its own
    // tests in crm.integration).
    await moveLead(id, wonStage, '', ctx(), undefined, { viaConvert: true });
    const won = await leadRow(id);
    expect(won.closedAt).not.toBeNull();

    await moveLead(id, openStage, '', ctx());
    expect((await leadRow(id)).closedAt).toBeNull();
  });

  it('an ordinary save on a decided card does not move the month it counts in', async () => {
    const id = await newLead();
    await moveLead(id, wonStage, '', ctx(), undefined, { viaConvert: true });
    const stamped = (await leadRow(id)).closedAt!;

    await updateLead(id, formInput({ stageId: wonStage, phone: '+998907770001' }) as never, ctx());
    const after = await leadRow(id);
    expect(after.phone).toBe('+998907770001');
    expect(after.closedAt?.getTime()).toBe(stamped.getTime());
  });

  it('the ✏️ form can no longer win — the dialog owns that door (round 107)', async () => {
    // This test used to pin the OPPOSITE («the form's move to won stamps
    // exactly as the board's does»). Winning now demands a client and a deal,
    // which the form cannot supply, so its won move is the same coded refusal
    // the board gives without the dialog.
    const id = await newLead();
    await expect(
      updateLead(id, formInput({ stageId: wonStage }) as never, ctx()),
    ).rejects.toThrow('convert_required');
    expect((await leadRow(id)).closedAt).toBeNull();
  });
});

describe('the lost-reason dictionary gates the lost move', () => {
  it('an empty list keeps free text legal — day one changes nothing', async () => {
    const id = await newLead();
    await moveLead(id, lostStage, 'erkin matn sabab', ctx());
    expect((await leadRow(id)).lostReason).toBe('erkin matn sabab');
  });

  it('once the owner has written his list, only its labels pass', async () => {
    const reason = await saveLostReason(
      { label: `${MARK} Narx qimmat`, sortOrder: 1, active: true },
      ctx(),
    );
    madeReasons.push(reason.id);

    const id = await newLead();
    await expect(moveLead(id, lostStage, 'boshqa narsa', ctx())).rejects.toThrow(
      'lost_reason_not_listed',
    );
    expect((await leadRow(id)).stageId).toBe(openStage);

    await moveLead(id, lostStage, `${MARK} Narx qimmat`, ctx());
    expect((await leadRow(id)).lostReason).toBe(`${MARK} Narx qimmat`);
  });

  it('a deactivated reason stops being offered AND stops passing', async () => {
    const [row] = await db
      .select()
      .from(lostReasons)
      .where(eq(lostReasons.id, madeReasons[0]!));
    await saveLostReason({ id: row!.id, label: row!.label, sortOrder: 1, active: false }, ctx());

    // The list is now effectively empty again → free text is legal.
    const id = await newLead();
    await moveLead(id, lostStage, 'endi erkin', ctx());
    expect((await leadRow(id)).lostReason).toBe('endi erkin');
  });

  it('the deal board asks the same dictionary', async () => {
    const [row] = await db
      .select()
      .from(lostReasons)
      .where(eq(lostReasons.id, madeReasons[0]!));
    await saveLostReason({ id: row!.id, label: row!.label, sortOrder: 1, active: true }, ctx());

    const id = await createDeal(
      { clientId, title: `${MARK} bitim`, stageId: openDealStage } as never,
      ctx(),
    );
    madeDeals.push(id);
    const lostDeal = (await db.select().from(dealStages)).find((s) => s.kind === 'lost')!.id;
    await expect(moveDeal(id, lostDeal, ctx(), 'boshqa narsa')).rejects.toThrow(
      'lost_reason_not_listed',
    );

    // Back to empty for the analytics half below.
    await saveLostReason(
      { id: row!.id, label: row!.label, sortOrder: 1, active: false },
      ctx(),
    );
  });
});

describe('salesAnalytics reads the two clocks', () => {
  // A window nothing else in any database can fall into: the company did not
  // exist in March 2020, so every count inside it is this file's alone.
  const FROM = new Date('2020-03-01T00:00:00Z');
  const TO = new Date('2020-03-11T00:00:00Z');

  it('counts arrivals by created_at and decisions by closed_at', async () => {
    // Arrived + won inside the window, 3 days apart → the cycle.
    const wonId = await newLead();
    await moveLead(wonId, wonStage, '', ctx(), undefined, { viaConvert: true });
    await db
      .update(leads)
      .set({
        ownerId: null,
        createdAt: new Date('2020-03-02T08:00:00Z'),
        closedAt: new Date('2020-03-05T08:00:00Z'),
        quotedAmount: '500.00',
        quotedCurrency: 'USD',
      })
      .where(eq(leads.id, wonId));

    // Arrived + lost inside the window.
    const lostId = await newLead();
    await moveLead(lostId, lostStage, 'Test-sabab R98', ctx());
    await db
      .update(leads)
      .set({
        ownerId: null,
        createdAt: new Date('2020-03-03T08:00:00Z'),
        closedAt: new Date('2020-03-04T08:00:00Z'),
      })
      .where(eq(leads.id, lostId));

    // Arrived BEFORE the window, won inside it: a decision this month about
    // last month's enquiry — counts as won here, not as new.
    const oldWonId = await newLead();
    await moveLead(oldWonId, wonStage, '', ctx(), undefined, { viaConvert: true });
    await db
      .update(leads)
      .set({
        ownerId: null,
        createdAt: new Date('2020-02-20T08:00:00Z'),
        closedAt: new Date('2020-03-06T08:00:00Z'),
        quotedAmount: '250.00',
        quotedCurrency: 'USD',
      })
      .where(eq(leads.id, oldWonId));

    // Arrived inside the window, still open: new, not decided.
    const openId = await newLead();
    await db
      .update(leads)
      .set({ ownerId: null, createdAt: new Date('2020-03-07T08:00:00Z') })
      .where(eq(leads.id, openId));

    const data = await salesAnalytics({ from: FROM, to: TO });

    expect(data.totals.fresh).toBe(3);
    expect(data.totals.won).toBe(2);
    expect(data.totals.lost).toBe(1);
    expect(data.totals.winRate).toBeCloseTo(66.7, 1);
    expect(data.totals.wonUsd).toBe(750);
    // 3 days + 15 days over two won leads → 9 on average.
    expect(data.totals.cycleDays).toBeCloseTo(9, 1);

    const reasonRow = data.lostReasons.find((row) => row.reason === 'Test-sabab R98');
    expect(reasonRow?.n).toBe(1);

    // The trend carries only days that saw something — five distinct here.
    expect(data.perDay.map((d) => d.day)).toEqual([
      '2020-03-02',
      '2020-03-03',
      '2020-03-05',
      '2020-03-06',
      '2020-03-07',
    ]);
    const day5 = data.perDay.find((d) => d.day === '2020-03-05');
    expect(day5?.won).toBe(1);
    expect(day5?.fresh).toBe(0);

    // Everything above is unowned, so it all lands on the «—» seller row.
    const nobody = data.sellers.find((row) => row.name === '—');
    expect(nobody?.fresh).toBe(3);
    expect(nobody?.won).toBe(2);
    expect(nobody?.lost).toBe(1);
    expect(nobody?.wonUsd).toBe(750);
  });
});
