import 'dotenv/config';
import { eq, inArray, like } from 'drizzle-orm';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { db, pgClient } from '@/modules/platform/db/client';
import { leadIntakes, leadSources, leads } from '@/modules/platform/db/schema';
import {
  inboundDoors,
  intakesBySource,
  landInboundLead,
  setSourceWebhookSecret,
  sourceWebhookSecret,
} from '@/modules/wms/crm/inbound';
import { secretMatches } from '@/modules/wms/crm/inbound-webhook';

/**
 * Round 86b's door, against a real database.
 *
 * The ROUTE cannot be exercised here for the same reason Meta's cannot — it is
 * an HTTP surface — but everything it decides with is a real function called
 * with real rows: is the door open, does this key match, and does the arrival
 * land where the ledger says.
 *
 * The source it uses is `tiktok`, which the seed ships and no other test file
 * touches; its secret is put back to null in `afterAll`, because a key left
 * behind is CONFIGURATION that opens a public write path for every later spec
 * (#183).
 */

const STAMP = Date.now();
const KEY = 'tiktok';
const madeLeads: string[] = [];
const ctx = { actorId: null, ip: null, userAgent: null };

beforeAll(async () => {
  // The seed ships this row; the file is meaningless without it.
  const [row] = await db.select().from(leadSources).where(eq(leadSources.key, KEY)).limit(1);
  expect(row, 'seeded lead source').toBeTruthy();
});

afterAll(async () => {
  /**
   * The key AND the active flag, both here rather than at the end of the test
   * that changes them.
   *
   * A red proof against the retirement guard left `tiktok` deactivated in the
   * local database, because the assertion threw before the test's own restore
   * line — and a source switched off is CONFIGURATION every later screen reads
   * (#183, #523's shape). Cleanup that only runs when the test passes is not
   * cleanup.
   */
  await db
    .update(leadSources)
    .set({ webhookSecret: null, active: true })
    .where(eq(leadSources.key, KEY));
  await db.delete(leadIntakes).where(like(leadIntakes.name, `WH-${STAMP}%`));
  if (madeLeads.length) await db.delete(leads).where(inArray(leads.id, madeLeads));
  await pgClient.end();
});

describe('the door only exists once it is switched on', () => {
  it('is closed by default, opens with a minted key, and closes again', async () => {
    // Ships OFF: an unconfigured webhook must read as «no such door», which is
    // what makes the route's 404 the honest answer.
    await db.update(leadSources).set({ webhookSecret: null }).where(eq(leadSources.key, KEY));
    expect(await sourceWebhookSecret(KEY)).toBeNull();

    const secret = await setSourceWebhookSecret(KEY, true, ctx);
    expect(secret).toBeTruthy();
    expect(secret!.length).toBeGreaterThanOrEqual(24);
    expect(await sourceWebhookSecret(KEY)).toBe(secret);
    // The real comparison the route makes.
    expect(secretMatches(secret, await sourceWebhookSecret(KEY))).toBe(true);
    expect(secretMatches('not-it', await sourceWebhookSecret(KEY))).toBe(false);

    expect(await setSourceWebhookSecret(KEY, false, ctx)).toBeNull();
    expect(await sourceWebhookSecret(KEY)).toBeNull();
  });

  it('mints a DIFFERENT key each time — a re-issued key is a key that was never rotated', async () => {
    const first = await setSourceWebhookSecret(KEY, true, ctx);
    const second = await setSourceWebhookSecret(KEY, true, ctx);
    expect(first).not.toBe(second);
    expect(await sourceWebhookSecret(KEY)).toBe(second);
  });

  it('a retired source’s door closes with it', async () => {
    await setSourceWebhookSecret(KEY, true, ctx);
    await db.update(leadSources).set({ active: false }).where(eq(leadSources.key, KEY));
    // Otherwise a key goes on accepting leads into a channel nobody looks at.
    expect(await sourceWebhookSecret(KEY)).toBeNull();
    await db.update(leadSources).set({ active: true }).where(eq(leadSources.key, KEY));
  });
});

describe('an arrival through the webhook channel', () => {
  it('lands as a lead and is counted against its source', async () => {
    const before = (await intakesBySource()).find((row) => row.sourceKey === KEY)?.arrivals ?? 0;

    const result = await landInboundLead({
      channel: 'webhook',
      sourceKey: KEY,
      externalId: `wh-${STAMP}`,
      ref: { campaign_id: 'bahor' },
      name: `WH-${STAMP} Aziz`,
      phone: `+9989${String(STAMP).slice(-8)}`,
      note: 'city: Toshkent',
    });
    expect(result.outcome).toBe('created');
    if (result.leadId) madeLeads.push(result.leadId);

    const [intake] = await db
      .select()
      .from(leadIntakes)
      .where(eq(leadIntakes.externalId, `wh-${STAMP}`));
    expect(intake!.channel).toBe('webhook');
    expect(intake!.sourceKey).toBe(KEY);

    const after = (await intakesBySource()).find((row) => row.sourceKey === KEY)?.arrivals ?? 0;
    expect(after).toBe(before + 1);
  });

  it('the same delivery twice is one lead — the platform retries until it gets a 200', async () => {
    const phone = `+9989${String(STAMP + 1).slice(-8)}`;
    const first = await landInboundLead({
      channel: 'webhook',
      sourceKey: KEY,
      externalId: `wh-dup-${STAMP}`,
      name: `WH-${STAMP} Dup`,
      phone,
    });
    if (first.leadId) madeLeads.push(first.leadId);
    const second = await landInboundLead({
      channel: 'webhook',
      sourceKey: KEY,
      externalId: `wh-dup-${STAMP}`,
      name: `WH-${STAMP} Dup`,
      phone,
    });
    if (second.leadId && second.leadId !== first.leadId) madeLeads.push(second.leadId);

    const rows = await db
      .select()
      .from(leadIntakes)
      .where(eq(leadIntakes.externalId, `wh-dup-${STAMP}`));
    expect(rows, 'one ledger row per delivery id').toHaveLength(1);
  });
});

describe('the door directory', () => {
  it('lists only sources whose key the code actually understands', async () => {
    const doors = await inboundDoors();
    expect(doors.some((door) => door.key === KEY)).toBe(true);
    // A door we would answer 404 to is worse than no door: it looks like one.
    for (const door of doors) {
      expect(await sourceWebhookSecret(door.key)).toBe(door.secret);
    }
  });
});
