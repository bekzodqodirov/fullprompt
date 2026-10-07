import 'dotenv/config';
import { eq, inArray } from 'drizzle-orm';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { db, pgClient } from '@/modules/platform/db/client';
import {
  calcExtras,
  calcGroups,
  calcOffers,
  calcRequestItems,
  calcRequests,
  calcVersions,
  clients,
  crmActivities,
  dealStages,
  deals,
  events,
  tasks,
  users,
} from '@/modules/platform/db/schema';
import { ROLE_MATRIX, type RoleCode } from '@/modules/platform/rbac/catalog';
import { openCalcRequest } from '@/modules/wms/calc/service';
import {
  confirmAllGroups,
  createGroup,
  loadWorkspace,
  moveItemToGroup,
  recordOffer,
  sealCalc,
  setFreightZone,
  setGroupRates,
  setItemBaza,
} from '@/modules/wms/calc/workspace';
import { quoteHistoryFor } from '@/modules/wms/calc/history';
import { upsaleScopeFor } from '@/modules/wms/calc/upsale-scope';

/**
 * His F1 a (2026-10-07) on /hisoblash/narxlar, BEHAVIOURAL over every seeded
 * role: a seller sees only the client prices HE gave. The price channel names
 * the seller and carries the floor, so a colleague's client price beside it
 * would be one subtraction from that colleague's upsale (law 4). The owner and
 * the accountant still read both; the VED reads neither (law 4 as before).
 */
const SUFFIX = String(Date.now()).slice(-6);
const CODE = `8471${SUFFIX}`;

let vedId = '';
let sellerA = '';
let sellerB = '';
let clientId = '';
let dealId = '';
const madeRequests: string[] = [];
let floorA = 0;
let floorB = 0;

async function user(name: string, tail: string) {
  const [u] = await db
    .insert(users)
    .values({ phone: `+99892${SUFFIX}${tail}`, fullName: name, passwordHash: 'x' })
    .returning();
  return u!.id;
}

async function sealedVersion(): Promise<{ versionId: string; floor: number }> {
  const request = await openCalcRequest(
    {
      entityType: 'deal',
      entityId: dealId,
      section: 'podklyuch',
      fromCity: 'Yiwu',
      toCity: 'Toshkent',
      weightKg: 1500,
      volumeM3: 30,
      items: [{ name: `narx tovar ${SUFFIX}`, quantity: 100 }],
      source: 'card',
    },
    { actorId: vedId },
  );
  madeRequests.push(request.id);
  const ctx = { actorId: vedId };
  const groupId = await createGroup(request.id, { label: 'Guruh', tnvedCode: CODE }, ctx);
  const workspace = await loadWorkspace(request.id);
  for (const item of workspace!.ungrouped) {
    await moveItemToGroup(request.id, item.seq, groupId, ctx);
    await setItemBaza(request.id, item.seq, { bazaUsd: 20, basis: 'unit', source: 'typed' }, ctx);
  }
  await setGroupRates(
    groupId,
    { tnvedCode: CODE, dutyPct: 10, vatPct: 12, dutyFree: false, vatFree: false, source: 'typed' },
    ctx,
  );
  await setFreightZone(request.id, 'cn', ctx);
  await confirmAllGroups(request.id, ctx);
  await sealCalc(request.id, { discountUsd: 0, discountReason: null, bandOverrideMin: null, bandOverrideReason: null }, ctx);
  const v = await db.query.calcVersions.findFirst({ where: eq(calcVersions.requestId, request.id) });
  return { versionId: v!.id, floor: Number(v!.totalUsd) };
}

beforeAll(async () => {
  vedId = await user(`Narx VED ${SUFFIX}`, '01');
  sellerA = await user(`Narx Sotuvchi A ${SUFFIX}`, '02');
  sellerB = await user(`Narx Sotuvchi B ${SUFFIX}`, '03');
  const [client] = await db.insert(clients).values({ clientCode: `NS${SUFFIX}`, name: `Narx scope ${SUFFIX}` }).returning();
  clientId = client!.id;
  const stage = await db.query.dealStages.findFirst({ where: eq(dealStages.kind, 'open') });
  const [deal] = await db
    .insert(deals)
    .values({ code: `NS-${SUFFIX}`, clientId, stageId: stage!.id, title: 'Narx scope', createdBy: vedId })
    .returning();
  dealId = deal!.id;

  // Version A — older, offered by seller A; version B — newer, offered by seller B.
  const a = await sealedVersion();
  floorA = a.floor;
  await recordOffer({ versionId: a.versionId }, { clientPriceUsd: floorA + 500, locale: 'uz' }, { actorId: sellerA });
  const b = await sealedVersion();
  floorB = b.floor;
  await recordOffer({ versionId: b.versionId }, { clientPriceUsd: floorB + 600, locale: 'uz' }, { actorId: sellerB });
  // A NEWER colleague offer on seller A's OWN version: A must still see his own.
  await recordOffer({ versionId: a.versionId }, { clientPriceUsd: floorA + 700, locale: 'uz' }, { actorId: sellerB });
});

afterAll(async () => {
  if (madeRequests.length > 0) {
    const versionIds = (
      await db.select({ id: calcVersions.id }).from(calcVersions).where(inArray(calcVersions.requestId, madeRequests))
    ).map((r) => r.id);
    if (versionIds.length > 0) await db.delete(calcOffers).where(inArray(calcOffers.versionId, versionIds));
    await db.delete(calcVersions).where(inArray(calcVersions.requestId, madeRequests));
    await db.delete(calcExtras).where(inArray(calcExtras.requestId, madeRequests));
    await db.delete(calcRequestItems).where(inArray(calcRequestItems.requestId, madeRequests));
    await db.delete(calcGroups).where(inArray(calcGroups.requestId, madeRequests));
    const rows = await db.select({ taskId: calcRequests.taskId }).from(calcRequests).where(inArray(calcRequests.id, madeRequests));
    await db.delete(calcRequests).where(inArray(calcRequests.id, madeRequests));
    const taskIds = rows.map((r) => r.taskId).filter(Boolean) as string[];
    if (taskIds.length > 0) {
      await db.delete(events).where(inArray(events.entityId, taskIds));
      await db.delete(tasks).where(inArray(tasks.id, taskIds));
    }
  }
  await db.delete(crmActivities).where(eq(crmActivities.entityId, dealId));
  await db.delete(deals).where(eq(deals.id, dealId));
  await db.update(clients).set({ active: false }).where(eq(clients.id, clientId));
  await db.update(users).set({ active: false }).where(inArray(users.id, [vedId, sellerA, sellerB]));
  await pgClient.end();
});

const actorFor = (role: RoleCode) => {
  const codes = new Set<string>(ROLE_MATRIX[role]);
  return { permissions: { has: (c: string) => codes.has(c) } };
};

const SEES: Record<RoleCode, 'both' | 'own' | 'neither'> = {
  super_admin: 'both',
  admin: 'both',
  accountant: 'both',
  sales_manager: 'own',
  logist: 'own',
  ved_manager: 'neither',
  warehouse_manager: 'neither',
  warehouse_operator: 'neither',
  viewer: 'neither',
};

describe('narxlar: a seller sees only the client prices HE gave (F1 a)', () => {
  it('answers for every seeded role, read through the real query', async () => {
    for (const role of Object.keys(ROLE_MATRIX) as RoleCode[]) {
      const scope = upsaleScopeFor(actorFor(role));
      const rows = await quoteHistoryFor(CODE, { scope, viewerId: sellerA, limit: 10 });
      expect(rows, role).toHaveLength(2);
      const [newest, older] = rows as [(typeof rows)[0], (typeof rows)[0]];
      const prices = { own: older.clientPriceUsd, theirs: newest.clientPriceUsd };
      const expected = SEES[role];
      if (expected === 'both') {
        expect(prices, role).toEqual({ own: floorA + 700, theirs: floorB + 600 });
      } else if (expected === 'own') {
        // His OWN offer on his version — not the colleague's newer one on it.
        expect(prices, role).toEqual({ own: floorA + 500, theirs: null });
        expect(newest.belowFloor, role).toBe(false);
        // Not widened in this package (D9): the cost family stays hidden.
        expect(newest.totalUsd, role).toBeNull();
      } else {
        expect(prices, role).toEqual({ own: null, theirs: null });
      }
    }
  });
});
