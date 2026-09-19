import 'dotenv/config';
import { inArray } from 'drizzle-orm';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { db, pgClient } from '@/modules/platform/db/client';
import { clients, crmPeople, users } from '@/modules/platform/db/schema';
import { suggestGroups } from '@/modules/wms/crm/people';

/**
 * Grouping a person's codes must be CORRECTABLE, which is the whole reason
 * the owner picked 3.1c («tizim taklif qiladi, siz bir marta "ha" deysiz,
 * keyin tuzatish ham mumkin») over the automatic 3.1b.
 *
 * It was not. The suggestion pass asked only about codes where BOTH sides
 * were ungrouped, so a code taken out of a person had no partner left to be
 * suggested against and there was no other door back in — a one-way door
 * wearing an «undo» label. The fixture below is that exact sequence.
 */

const SUFFIX = String(Date.now()).slice(-6);
const PHONE = `+998 55 ${SUFFIX.slice(0, 3)}-${SUFFIX.slice(3)}`;
const OTHER = `+998 44 ${SUFFIX.slice(0, 3)}-${SUFFIX.slice(3)}`;
let actorId: string;
let personId: string;
let rival: string;
const made: string[] = [];

const mintClient = async (code: string, name: string, over: Record<string, unknown> = {}) => {
  const id = (
    await db
      .insert(clients)
      .values({ clientCode: code, name, ...over } as typeof clients.$inferInsert)
      .returning({ id: clients.id })
  )[0]!.id;
  made.push(id);
  return id;
};

beforeAll(async () => {
  actorId = (await db.select({ id: users.id }).from(users).limit(1))[0]!.id;
  personId = (
    await db
      .insert(crmPeople)
      .values({ name: `Yolchi ${SUFFIX}`, phones: [PHONE], createdBy: actorId })
      .returning({ id: crmPeople.id })
  )[0]!.id;
  rival = (
    await db
      .insert(crmPeople)
      .values({ name: `Boshqa odam ${SUFFIX}`, phones: [OTHER], createdBy: actorId })
      .returning({ id: crmPeople.id })
  )[0]!.id;
});

afterAll(async () => {
  await db.delete(clients).where(inArray(clients.id, made));
  await db.delete(crmPeople).where(inArray(crmPeople.id, [personId, rival]));
  await pgClient.end();
});

describe('suggestGroups', () => {
  it('offers to put an ungrouped code BACK onto the person it left', async () => {
    // Two codes on one person, and a third carrying the same number that
    // somebody detached (or never grouped).
    await mintClient(`PA${SUFFIX}`, `Yolchi A ${SUFFIX}`, { personId, phones: [PHONE] });
    const loose = await mintClient(`PB${SUFFIX}`, `Yolchi B ${SUFFIX}`, {
      // Written the way the office writes it — no spaces, no country code.
      phones: [PHONE.replace(/\D/g, '').slice(-9)],
    });

    const suggestions = await suggestGroups(200);
    const mine = suggestions.find((group) =>
      group.members.some((member) => member.id === loose),
    );
    expect(mine, 'the detached code is suggested against nothing').toBeDefined();
    expect(mine!.kind, 'it belongs to a person who already exists').toBe('join');
    if (mine!.kind !== 'join') throw new Error('narrowing');
    expect(mine!.personId).toBe(personId);
    expect(mine!.personName).toContain('Yolchi');
    // Only the code that needs moving is offered — the one already on the
    // person is not something to confirm again.
    expect(mine!.members.map((member) => member.code)).toEqual([`PB${SUFFIX}`]);
  });

  it('still offers two ungrouped codes as a NEW person', async () => {
    const a = await mintClient(`PC${SUFFIX}`, `Yangi C ${SUFFIX}`, { phones: [OTHER] });
    await mintClient(`PD${SUFFIX}`, `Yangi D ${SUFFIX}`, { phones: [OTHER] });
    const suggestions = await suggestGroups(200);
    const mine = suggestions.find((group) => group.members.some((member) => member.id === a));
    expect(mine, 'two ungrouped codes on one phone are still a suggestion').toBeDefined();
    expect(mine!.kind).toBe('new');
    expect(mine!.members.map((member) => member.code).sort()).toEqual([
      `PC${SUFFIX}`,
      `PD${SUFFIX}`,
    ]);
  });

  it('says NOTHING when the number reaches two different people', async () => {
    // The same phone now belongs to two people — one person holds it through
    // a member code, the other through a second. A guess here files cargo
    // under the wrong human being, so the code is left alone.
    const shared = `+998 33 ${SUFFIX.slice(0, 3)}-${SUFFIX.slice(3)}`;
    await mintClient(`PE${SUFFIX}`, `Ikki odam E ${SUFFIX}`, { personId, phones: [shared] });
    await mintClient(`PF${SUFFIX}`, `Ikki odam F ${SUFFIX}`, { personId: rival, phones: [shared] });
    const ambiguous = await mintClient(`PG${SUFFIX}`, `Ikki odam G ${SUFFIX}`, {
      phones: [shared],
    });
    const suggestions = await suggestGroups(200);
    expect(
      suggestions.some((group) => group.members.some((member) => member.id === ambiguous)),
      'an ambiguous match must not be guessed at',
    ).toBe(false);
  });
});
