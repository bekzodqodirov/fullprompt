import 'dotenv/config';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { eq, inArray, like } from 'drizzle-orm';
import { db, pgClient } from '@/modules/platform/db/client';
import {
  crmActivities,
  customFieldValues,
  customFields,
  inboundRoutes,
  leadFieldMap,
  leadIntakes,
  leads,
  users,
} from '@/modules/platform/db/schema';
import { landInboundLead } from '@/modules/wms/crm/inbound';
import { deleteMapping, saveMapping, seenKeys } from '@/modules/wms/crm/field-map';
import { createRoute } from '@/modules/wms/crm/routing';

/**
 * The tarjimon against a real database (round 97): a mapped answer lands as a
 * structured value BESIDE its note line; a poisoned answer degrades to
 * note-only and the arrival's ledger row still exists (the review's blocker);
 * a volume rule reads the mapped kub.
 */

const STAMP = String(Date.now()).slice(-7);
let actorId = '';
let sellerId = '';
let checkboxFieldId = '';
let strictFieldId = '';
const routeIds: string[] = [];
const mapKeys: string[] = [];
let previouslyFlagged: string[] = [];

const P = (tail: string) => `+9989${STAMP}${tail}`;

const arrival = (over: Record<string, unknown> = {}) => ({
  channel: 'form' as const,
  sourceKey: 'instagram',
  name: `Tarjimon lid ${STAMP}`,
  phone: P('1'),
  note: null,
  ...over,
});

beforeAll(async () => {
  const flagged = await db
    .select({ id: users.id })
    .from(users)
    .where(eq(users.inboundRota, true));
  previouslyFlagged = flagged.map((row) => row.id);
  if (previouslyFlagged.length) {
    await db
      .update(users)
      .set({ inboundRota: false })
      .where(inArray(users.id, previouslyFlagged));
  }

  const [seeded] = await db.select({ id: users.id }).from(users).limit(1);
  actorId = seeded!.id;
  const [seller] = await db
    .insert(users)
    .values({
      phone: `+99895${STAMP.slice(-5)}01`,
      fullName: `Tarjimon hodim ${STAMP}`,
      passwordHash: 'x',
      active: true,
      inboundRota: false,
    })
    .returning({ id: users.id });
  sellerId = seller!.id;

  const [checkbox] = await db
    .insert(customFields)
    .values({
      entityType: 'lead',
      label: `Bazada yuk ${STAMP}`,
      type: 'checkbox',
      sortOrder: 900,
    })
    .returning({ id: customFields.id });
  checkboxFieldId = checkbox!.id;
  // A text field with a pattern its advert answer will violate — the
  // poisoned-write fixture.
  const [strict] = await db
    .insert(customFields)
    .values({
      entityType: 'lead',
      label: `Qattiq ${STAMP}`,
      type: 'text',
      sortOrder: 901,
      rules: { pattern: '^[0-9]+$' },
    })
    .returning({ id: customFields.id });
  strictFieldId = strict!.id;
});

afterAll(async () => {
  // Mappings, routes and FIELDS are configuration (#183) — while they exist
  // every later spec's arrivals are translated by them.
  if (mapKeys.length) await db.delete(leadFieldMap).where(inArray(leadFieldMap.key, mapKeys));
  if (routeIds.length) await db.delete(inboundRoutes).where(inArray(inboundRoutes.id, routeIds));
  await db.delete(leadIntakes).where(like(leadIntakes.name, `%${STAMP}%`));
  const made = await db.select({ id: leads.id }).from(leads).where(like(leads.name, `%${STAMP}%`));
  for (const row of made) {
    await db.delete(crmActivities).where(eq(crmActivities.entityId, row.id));
    await db.delete(customFieldValues).where(eq(customFieldValues.entityId, row.id));
  }
  await db.delete(leads).where(like(leads.name, `%${STAMP}%`));
  await db
    .delete(customFields)
    .where(inArray(customFields.id, [checkboxFieldId, strictFieldId].filter(Boolean)));
  await db.delete(users).where(like(users.fullName, `Tarjimon hodim %${STAMP}`));
  if (previouslyFlagged.length) {
    await db
      .update(users)
      .set({ inboundRota: true })
      .where(inArray(users.id, previouslyFlagged));
  }
  await pgClient.end();
});

const mapKey = async (key: string, target: 'kub' | 'kg' | 'field' | 'note', fieldId?: string) => {
  await saveMapping({ key, target, fieldId: fieldId ?? null }, { actorId, ip: null, userAgent: null });
  mapKeys.push(key);
};

describe('a mapped answer lands beside its note line', () => {
  it('kub fills the quote, ha/yo`q fills the checkbox, and the note keeps everything', async () => {
    await mapKey(`kub_${STAMP}`, 'kub');
    await mapKey(`bazada_${STAMP}`, 'field', checkboxFieldId);

    const landed = await landInboundLead(
      arrival({
        // The parsers fold the pairs into the note AND hand them over as
        // pairs — this fixture is the wire truth mapFieldData produces.
        note: `kub_${STAMP}: 12,5 kub\nbazada_${STAMP}: Ha\nshahar_${STAMP}: Toshkent`,
        fields: [
          { key: `kub_${STAMP}`, value: '12,5 kub' },
          { key: `bazada_${STAMP}`, value: 'Ha' },
          { key: `shahar_${STAMP}`, value: 'Toshkent' },
        ],
      }),
    );
    expect(landed.outcome).toBe('created');

    const [lead] = await db.select().from(leads).where(eq(leads.id, landed.leadId!));
    expect(lead!.quotedVolumeM3).toBe('12.500');

    const [value] = await db
      .select()
      .from(customFieldValues)
      .where(eq(customFieldValues.entityId, landed.leadId!));
    expect(value!.fieldId).toBe(checkboxFieldId);
    expect(value!.valueBool).toBe(true);

    // The lenta note is the RECORD of what the person wrote — mapping adds a
    // structured copy, never removes a line.
    const notes = await db
      .select()
      .from(crmActivities)
      .where(eq(crmActivities.entityId, landed.leadId!));
    expect(notes[0]!.note).toContain(`kub_${STAMP}: 12,5 kub`);
    expect(notes[0]!.note).toContain('Toshkent');

    // The arrival's raw pairs are on the ledger — the seen-keys list's source.
    const [intake] = await db
      .select()
      .from(leadIntakes)
      .where(eq(leadIntakes.leadId, landed.leadId!));
    expect(intake!.fields).toEqual([
      { key: `kub_${STAMP.toLowerCase()}`, value: '12,5 kub' },
      { key: `bazada_${STAMP}`, value: 'Ha' },
      { key: `shahar_${STAMP}`, value: 'Toshkent' },
    ]);
  });

  it('a poisoned answer degrades to note-only and the LEDGER ROW still exists', async () => {
    // The review's blocker: a throwing structured write used to be able to
    // abort the landing BEFORE record(), opening the replay fence. The strict
    // field's pattern refuses this answer — the lead and its intake row must
    // both exist anyway.
    await mapKey(`qattiq_${STAMP}`, 'field', strictFieldId);
    const landed = await landInboundLead(
      arrival({
        phone: P('2'),
        name: `Tarjimon zahar ${STAMP}`,
        externalId: `fm_${STAMP}`,
        channel: 'meta' as const,
        fields: [{ key: `qattiq_${STAMP}`, value: 'harflar-raqam-emas' }],
      }),
    );
    expect(landed.outcome).toBe('created');

    const [intake] = await db
      .select()
      .from(leadIntakes)
      .where(eq(leadIntakes.externalId, `fm_${STAMP}`));
    expect(intake, 'the ledger row must survive a refused structured write').toBeTruthy();

    // And the replay fence therefore still holds.
    const again = await landInboundLead(
      arrival({
        phone: P('2'),
        name: `Tarjimon zahar ${STAMP}`,
        externalId: `fm_${STAMP}`,
        channel: 'meta' as const,
      }),
    );
    expect(again.outcome).toBe('dropped');
    expect(again.reason).toBe('replay');
  });
});

describe('the volume rule reads the mapped kub, and free text as the fallback', () => {
  it('routes a big mapped kub to the big-cargo pool', async () => {
    const routeId = await createRoute(
      { sourceKey: null, keyword: null, minM3: 10, maxM3: null, userIds: [sellerId] },
      { actorId, ip: null, userAgent: null },
    );
    routeIds.push(routeId);

    const big = await landInboundLead(
      arrival({
        phone: P('3'),
        name: `Tarjimon katta ${STAMP}`,
        fields: [{ key: `kub_${STAMP}`, value: '25' }],
      }),
    );
    const [bigLead] = await db.select().from(leads).where(eq(leads.id, big.leadId!));
    expect(bigLead!.ownerId).toBe(sellerId);

    // Small cargo — and an arrival that never said its size — fall past it.
    const small = await landInboundLead(
      arrival({
        phone: P('4'),
        name: `Tarjimon kichik ${STAMP}`,
        fields: [{ key: `kub_${STAMP}`, value: '3' }],
      }),
    );
    const [smallLead] = await db.select().from(leads).where(eq(leads.id, small.leadId!));
    expect(smallLead!.ownerId).toBeNull();
  });

  it('«25 kub» typed into the /ariza note reaches the same rule', async () => {
    const landed = await landInboundLead(
      arrival({ phone: P('5'), name: `Tarjimon matn ${STAMP}`, note: '25 kub yuk bor edi' }),
    );
    const [lead] = await db.select().from(leads).where(eq(leads.id, landed.leadId!));
    expect(lead!.ownerId).toBe(sellerId);
    // Routing may use the text guess; the CARD may not — a guess is good
    // enough to pick whose phone rings, not good enough to print as a fact.
    expect(lead!.quotedVolumeM3).toBeNull();
  });
});

describe('the screen`s two lists', () => {
  it('seen keys aggregate with a sample, and a decided key leaves the unmapped side', async () => {
    const seen = await seenKeys(1);
    const shahar = seen.find((row) => row.key === `shahar_${STAMP}`);
    expect(shahar).toBeTruthy();
    expect(shahar!.sample).toBe('Toshkent');

    await mapKey(`shahar_${STAMP}`, 'note');
    // 'note' is a stored DECISION: the landing behaves as before, but the
    // key must stop nagging — the caller filters by the map, proven here.
    const { listFieldMap } = await import('@/modules/wms/crm/field-map');
    const map = await listFieldMap();
    expect(map.some((row) => row.key === `shahar_${STAMP}` && row.target === 'note')).toBe(true);

    await deleteMapping(`shahar_${STAMP}`, { actorId, ip: null, userAgent: null });
    const after = await listFieldMap();
    expect(after.some((row) => row.key === `shahar_${STAMP}`)).toBe(false);
  });
});
