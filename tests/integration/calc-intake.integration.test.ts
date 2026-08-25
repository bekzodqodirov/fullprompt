import 'dotenv/config';
import { and, asc, eq, gte, inArray } from 'drizzle-orm';
import { v4 as uuidv4 } from 'uuid';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { db, pgClient } from '@/modules/platform/db/client';
import {
  calcRequestItems,
  calcRequests,
  clients,
  crmActivities,
  deals,
  events,
  leadStages,
  leads,
  tasks,
  users,
} from '@/modules/platform/db/schema';
import { getSetting, setSetting } from '@/modules/platform/settings/service';
import {
  intakeNoteText,
  intakeSummaryText,
  isComplete,
  missingFields,
  parseClientHint,
  type CalcFacts,
} from '@/modules/wms/calc/intake';
import { parseManualFacts } from '@/modules/wms/calc/intake-manual';
import { landIntake, resolveIntakeClient } from '@/modules/wms/calc/intake-land';

/**
 * «Hisoblatish» — the owner's own design for the AI intake: staff send the
 * material, the system checks that a quote is even possible, and the card
 * lands where his rule says (a coded client → a deal, a stranger → a lead).
 *
 * The completeness rules are pure and tested as such; the landing is tested
 * against the real database because "which card did it go on" is the part a
 * salesperson would notice being wrong.
 */

const STAMP = String(Date.now()).slice(-6);
/** When this file started — the window its own queue rows live in. */
const FILE_START = new Date();
let actorId: string;
const madeLeads: string[] = [];

beforeAll(async () => {
  actorId = (await db.select().from(users).limit(1))[0]!.id;
});

afterAll(async () => {
  // Since the VED module (phase A) a landing also opens a CALC REQUEST, so
  // this file now leaves work in a company-wide queue: rows that put a number
  // on the VED home, sit in front of the next spec's own, and after two hours
  // telegraph the owner about a fixture. Cleared here, deepest first — the
  // items reference the request, the request references the task.
  // By WINDOW rather than by id: `landIntake` mints deals of its own
  // (a coded client with no open deal gets one), so there is no list of
  // entities to sweep — but vitest runs files serially, so «this actor,
  // since this file started» is exactly this file's rows.
  {
    const rows = await db
      .select({ id: calcRequests.id, taskId: calcRequests.taskId })
      .from(calcRequests)
      .where(and(eq(calcRequests.requestedBy, actorId), gte(calcRequests.requestedAt, FILE_START)));
    if (rows.length) {
      const requestIds = rows.map((row) => row.id);
      await db.delete(calcRequestItems).where(inArray(calcRequestItems.requestId, requestIds));
      await db.delete(calcRequests).where(inArray(calcRequests.id, requestIds));
      const taskIds = rows.map((row) => row.taskId).filter(Boolean) as string[];
      if (taskIds.length) {
        await db.delete(events).where(inArray(events.entityId, taskIds));
        await db.delete(tasks).where(inArray(tasks.id, taskIds));
      }
    }
  }
  if (madeLeads.length) {
    await db.delete(crmActivities).where(inArray(crmActivities.entityId, madeLeads));
    await db.delete(leads).where(inArray(leads.id, madeLeads));
  }
  await pgClient.end();
});

describe('what a quote cannot be made without', () => {
  const full: CalcFacts = {
    fromCity: 'Yiwu',
    toCity: 'Toshkent',
    weightKg: 250,
    volumeM3: 3,
    goods: [{ name: 'Chexol' }],
  };

  it('freight needs the road, customs does not — and podklyuch needs both', () => {
    // His words: podklyuch is rastamojka and yo'lkira added together, so it
    // asks for everything either of them asks for.
    expect(missingFields('yolkira', full)).toEqual([]);
    expect(missingFields('rastamojka', full)).toEqual([]);
    expect(missingFields('podklyuch', full)).toEqual([]);

    const noRoute = { ...full, fromCity: null, toCity: '  ' };
    // Customs does not care where the truck starts.
    expect(missingFields('rastamojka', noRoute)).toEqual([]);
    expect(missingFields('yolkira', noRoute)).toEqual(['fromCity', 'toCity']);
    expect(missingFields('podklyuch', noRoute)).toEqual(['fromCity', 'toCity']);
  });

  it('a zero is a blank, not a number', () => {
    expect(missingFields('rastamojka', { ...full, weightKg: 0 })).toEqual(['weightKg']);
    expect(missingFields('rastamojka', { ...full, volumeM3: -1 })).toEqual(['volumeM3']);
    expect(missingFields('rastamojka', { ...full, goods: [] })).toEqual(['goods']);
    expect(isComplete('rastamojka', full)).toBe(true);
    expect(isComplete('rastamojka', { ...full, weightKg: null })).toBe(false);
  });

  it('the review message shows what is there AND what is missing', () => {
    const text = intakeSummaryText({
      section: 'yolkira',
      facts: { ...full, toCity: null },
      clientLabel: 'GS777',
      fileCount: 2,
    });
    expect(text).toContain('GS777');
    expect(text).toContain('Yiwu');
    expect(text).toContain('250 kg');
    expect(text).toContain('Fayllar: 2');
    expect(text).toContain('Yetishmayapti');
    expect(text).toContain('qaysi shaharga');

    const complete = intakeSummaryText({
      section: 'yolkira',
      facts: full,
      clientLabel: null,
      fileCount: 0,
    });
    expect(complete).toContain('to‘liq');
    expect(complete).not.toContain('Yetishmayapti');
  });

  it("the card's note carries the AI's working, which is the point of it", () => {
    const note = intakeNoteText({
      section: 'rastamojka',
      facts: {
        ...full,
        goods: [{ name: 'Chexol', quantity: 100, tnvedCode: '3926909709', note: 'plastik' }],
      },
      steps: ['Tovarlar 1 guruhga jamlandi', 'TNVED 3926909709 — plastmassa buyumlar'],
      collectedBy: 'Sotuvchi',
      fileCount: 1,
    });
    expect(note).toContain('3926909709');
    expect(note).toContain('AI izohi');
    expect(note).toContain('Tovarlar 1 guruhga jamlandi');
    // Customs section prints no route line — it does not have one.
    expect(note).not.toContain('Yo‘nalish');
  });

  it("the note carries the seller's own words, unabridged (law 11)", () => {
    // The whole-module audit's find: the bot path persisted only the parsed
    // digest — the typed and forwarded TEXT lived in a 30-minute in-memory
    // state whose sole consumer was the model, so the VED priced a job off a
    // summary nobody could reopen. The words go onto the card now.
    const note = intakeNoteText({
      section: 'podklyuch',
      facts: full,
      steps: [],
      collectedBy: 'Sotuvchi',
      fileCount: 0,
      material: ['Mijoz: 500 dona chexol, Yiwu skladga keldi', '2 kub bo‘lishi kerak dedi'],
    });
    expect(note).toContain('Sotuvchi yuborgani (asl matn):');
    expect(note).toContain('Mijoz: 500 dona chexol, Yiwu skladga keldi');
    expect(note).toContain('2 kub bo‘lishi kerak dedi');

    // Past the cap it says it was cut, rather than cutting in silence.
    const long = intakeNoteText({
      section: 'podklyuch',
      facts: full,
      steps: [],
      collectedBy: 'Sotuvchi',
      fileCount: 0,
      material: ['x'.repeat(25_000)],
    });
    expect(long).toContain('… (qisqartirildi)');
    expect(long.length).toBeLessThan(25_000);

    // No material — no empty heading pretending there was some.
    const bare = intakeNoteText({
      section: 'podklyuch',
      facts: full,
      steps: [],
      collectedBy: 'Sotuvchi',
      fileCount: 0,
    });
    expect(bare).not.toContain('Sotuvchi yuborgani');
  });
});

describe('facts the person typed', () => {
  it('reads kg, kub and an arrow route, and refuses to invent goods', () => {
    const facts = parseManualFacts('Yiwu → Toshkent, 250 kg, 3.5 kub, chexollar');
    expect(facts.fromCity).toBe('Yiwu');
    expect(facts.toCity).toBe('Toshkent');
    expect(facts.weightKg).toBe(250);
    expect(facts.volumeM3).toBe(3.5);
    // Splitting a typed product list is the model's job — a wrong split
    // would read as fact on the card.
    expect(facts.goods).toEqual([]);

    expect(parseManualFacts('vazni 120кг, 2 куб').weightKg).toBe(120);
    expect(parseManualFacts('vazni 120кг, 2 куб').volumeM3).toBe(2);
    expect(parseManualFacts('Guangzhou dan Andijon ga').fromCity).toBe('Guangzhou');
    // Nothing stated is nothing invented.
    expect(parseManualFacts('salom').weightKg).toBeNull();
  });

  it('reads a client hint as a code, a phone, or neither', () => {
    expect(parseClientHint('GS777')).toEqual({ code: 'GS777' });
    expect(parseClientHint(' gs777 ')).toEqual({ code: 'GS777' });
    expect(parseClientHint('+998 90 175 78 00')?.phone).toBeTruthy();
    // A person's name is neither — the intake keeps it as the lead's name.
    expect(parseClientHint('Alisher aka')).toBeNull();
  });
});

describe('where a confirmed intake lands', () => {
  it('a coded client gets a DEAL; the same client twice reuses the open one', async () => {
    const code = `HC${STAMP}`;
    const [client] = await db
      .insert(clients)
      .values({ clientCode: code, name: 'Hisoblatish mijoz', phones: ['+998901110000'] })
      .returning();

    expect((await resolveIntakeClient({ code: code.toLowerCase() }))?.id).toBe(client!.id);

    const first = await landIntake({
      noteId: uuidv4(),
      section: 'podklyuch',
      facts: { weightKg: 100, volumeM3: 2, goods: [{ name: 'Chexol' }] },
      steps: ['AI: 1 guruh'],
      fileCount: 1,
      collectedBy: actorId,
      collectedByName: 'Bot xodim',
      client: { id: client!.id, clientCode: code, name: client!.name },
      leadName: code,
      leadPhone: null,
    });
    expect(first.kind).toBe('deal');

    // The note landed on that deal with the AI's working on it.
    const notes = await db
      .select()
      .from(crmActivities)
      .where(and(eq(crmActivities.entityType, 'deal'), eq(crmActivities.entityId, first.id)));
    expect(notes).toHaveLength(1);
    expect(notes[0]!.note).toContain('Hisoblatish');
    expect(notes[0]!.note).toContain('AI: 1 guruh');

    // A second request from the same client joins the SAME open deal rather
    // than opening a second one beside it.
    const second = await landIntake({
      noteId: uuidv4(),
      section: 'rastamojka',
      facts: { weightKg: 50, volumeM3: 1, goods: [{ name: 'Sumka' }] },
      steps: [],
      fileCount: 0,
      collectedBy: actorId,
      collectedByName: 'Bot xodim',
      client: { id: client!.id, clientCode: code, name: client!.name },
      leadName: code,
      leadPhone: null,
    });
    expect(second.id).toBe(first.id);
    const dealRows = await db.select().from(deals).where(eq(deals.clientId, client!.id));
    expect(dealRows).toHaveLength(1);
  });

  it('a stranger gets a LEAD, and their second request joins it', async () => {
    const phone = `+99894${STAMP}1`;
    const target = await landIntake({
      noteId: uuidv4(),
      section: 'yolkira',
      facts: { fromCity: 'Yiwu', toCity: 'Toshkent', weightKg: 80, volumeM3: 1, goods: [] },
      steps: [],
      fileCount: 0,
      collectedBy: actorId,
      collectedByName: 'Bot xodim',
      client: null,
      leadName: 'Yangi mijoz',
      leadPhone: phone,
    });
    expect(target.kind).toBe('lead');

    const again = await landIntake({
      noteId: uuidv4(),
      section: 'yolkira',
      facts: { fromCity: 'Yiwu', toCity: 'Andijon', weightKg: 40, volumeM3: 1, goods: [] },
      steps: [],
      fileCount: 0,
      collectedBy: actorId,
      collectedByName: 'Bot xodim',
      client: null,
      // The number is typed differently the second time, as it always is.
      leadName: 'Yangi mijoz',
      leadPhone: phone.replace('+998', ''),
    });
    expect(again.id, 'the same prospect must not sprout a second card').toBe(target.id);

    const rows = await db.select().from(leads).where(eq(leads.id, target.id));
    expect(rows).toHaveLength(1);
    const notes = await db
      .select()
      .from(crmActivities)
      .where(and(eq(crmActivities.entityType, 'lead'), eq(crmActivities.entityId, target.id)));
    expect(notes).toHaveLength(2);
  });

  it('moves the card to the hisoblatish stage — forward only', async () => {
    // The owner, round 83: «lead qilsa bo'ladimi va hisoblatish etapiga
    // tushishi kerak». The stage is a SETTING because the funnel is his to
    // rename and reorder, so the test configures it the way the screen does.
    const stages = await db.select().from(leadStages).orderBy(asc(leadStages.sortOrder));
    const open = stages.filter((row) => row.kind === 'open' && row.active);
    const first = open[0]!;
    const calc = open[2] ?? open[1]!;
    const before = await getSetting('crm_calc_stage');
    await setSetting('crm_calc_stage', calc.id, actorId);
    try {
      const phone = `+99897${STAMP}3`;
      const landed = await landIntake({
        noteId: uuidv4(),
        section: 'rastamojka',
        facts: { weightKg: 90, volumeM3: 1, goods: [{ name: 'Chiroq' }] },
        steps: [],
        fileCount: 0,
        collectedBy: actorId,
        collectedByName: 'Bot xodim',
        client: null,
        leadName: `Etap sinov ${STAMP}`,
        leadPhone: phone,
      });
      madeLeads.push(landed.id);
      const [row] = await db.select().from(leads).where(eq(leads.id, landed.id));
      expect(row!.stageId, 'a new request lands on the hisoblatish stage').toBe(calc.id);
      // …and it belongs to whoever sent it, which is the other half of his ask.
      expect(row!.ownerId).toBe(actorId);

      // A card already PAST that stage is a person's work in progress — a
      // second request must not drag it backwards (#392's rule).
      const ahead = open.at(-1)!;
      if (ahead.id !== calc.id) {
        await db.update(leads).set({ stageId: ahead.id }).where(eq(leads.id, landed.id));
        await landIntake({
          noteId: uuidv4(),
          section: 'rastamojka',
          facts: { weightKg: 10, volumeM3: 1, goods: [{ name: 'Yana' }] },
          steps: [],
          fileCount: 0,
          collectedBy: actorId,
          collectedByName: 'Bot xodim',
          client: null,
          leadName: `Etap sinov ${STAMP}`,
          leadPhone: phone,
        });
        const [after] = await db.select().from(leads).where(eq(leads.id, landed.id));
        expect(after!.stageId, 'a machine must not walk a card backwards').toBe(ahead.id);
      }

      // And with nothing configured the card stays where the funnel puts it.
      await setSetting('crm_calc_stage', '', actorId);
      const plain = await landIntake({
        noteId: uuidv4(),
        section: 'rastamojka',
        facts: { weightKg: 5, volumeM3: 1, goods: [{ name: 'Yo' }] },
        steps: [],
        fileCount: 0,
        collectedBy: actorId,
        collectedByName: 'Bot xodim',
        client: null,
        leadName: `Etap sozlanmagan ${STAMP}`,
        leadPhone: `+99897${STAMP}4`,
      });
      madeLeads.push(plain.id);
      const [plainRow] = await db.select().from(leads).where(eq(leads.id, plain.id));
      expect(plainRow!.stageId).toBe(first.id);
    } finally {
      // The setting is CONFIGURATION (#183): it decides where every later
      // spec's intake lands.
      await setSetting('crm_calc_stage', before, actorId);
    }
  });

  it('an ambiguous phone names nobody, rather than the wrong somebody', async () => {
    const shared = `+99895${STAMP}2`;
    await db.insert(clients).values([
      { clientCode: `HA${STAMP}`, name: 'Aka', phones: [shared] },
      { clientCode: `HB${STAMP}`, name: 'Uka', phones: [shared] },
    ]);
    expect(await resolveIntakeClient({ phone: shared })).toBeNull();
    expect(await resolveIntakeClient({ code: `ZZ${STAMP}` })).toBeNull();
  });
});
