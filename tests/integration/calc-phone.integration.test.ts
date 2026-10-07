import 'dotenv/config';
import { eq, inArray, sql } from 'drizzle-orm';
import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest';

/**
 * The phone round's server half (his B2 a, B6 a), against a real database.
 *
 * What the browser's per-row settle rests on: a save answers the rev it
 * committed, consecutive saves move the clock by EXACTLY one (an empty one
 * included — the machine's sweep is a save), a delete answers its rev too;
 * the AI claim is read off TEXT as well as a Date; a one-row post writes that
 * row and no other; and a retried add is an EDIT of the stored row — which is
 * why the browser must never re-post a stale ghost.
 *
 * The two server actions are PRESSED with a stand-in session (the seeded demo
 * VED) — a service-level test of a form-fed path proves the service, not the
 * system (#531). Fixtures are this file's own (#183); the audited actor is
 * deactivated, never deleted (audit_log FK).
 */

const session = vi.hoisted(() => ({ user: null as null | Record<string, unknown> }));
vi.mock('@/modules/platform/auth/session', async (original) => ({
  ...(await original<typeof import('@/modules/platform/auth/session')>()),
  getSessionUser: async () => session.user,
  requestMeta: async () => ({ ip: null, userAgent: 'calc-phone.integration' }),
}));
// revalidatePath needs the request store of a real Next request.
vi.mock('next/cache', async (original) => ({
  ...(await original<typeof import('next/cache')>()),
  revalidatePath: () => {},
}));

import { db, pgClient } from '@/modules/platform/db/client';
import {
  calcGroups,
  calcRequestItems,
  calcRequests,
  clients,
  deals,
  dealStages,
  events,
  tasks,
  tnvedAssignments,
  users,
} from '@/modules/platform/db/schema';
import { openCalcRequest } from '@/modules/wms/calc/service';
import { itemNameNorm } from '@/modules/wms/calc/memory';
import {
  confirmAllGroups,
  deleteItem,
  loadWorkspace,
  requestClock,
  saveTable,
  type TableItemEdit,
  type TableNewItem,
} from '@/modules/wms/calc/workspace';
import { deleteItemAction, saveTableAction } from '@/app/(protected)/hisoblash/actions';

const SUFFIX = String(Date.now()).slice(-6);
let seq = 0;
// Digits, not a random base-36 token: word_similarity can score two random
// tokens over the memory's threshold (#1250).
const tag = () => `T${SUFFIX}${String((seq += 1)).padStart(3, '0')}`;

let actorId = '';
let clientId = '';
let dealId = '';
const madeRequests: string[] = [];
const madeNames: string[] = [];
const ctx = () => ({ actorId });

beforeAll(async () => {
  const [actor] = await db
    .insert(users)
    .values({
      phone: `+99893${String(Date.now()).slice(-7)}`,
      fullName: `VED phone fixture ${SUFFIX}`,
      passwordHash: 'x',
    })
    .returning();
  actorId = actor!.id;
  const [client] = await db
    .insert(clients)
    .values({ clientCode: `VP${SUFFIX}`, name: `VED phone fixture ${SUFFIX}` })
    .returning();
  clientId = client!.id;
  const stage = await db.query.dealStages.findFirst({ where: eq(dealStages.kind, 'open') });
  const [deal] = await db
    .insert(deals)
    .values({
      code: `VP-${SUFFIX}`,
      clientId,
      stageId: stage!.id,
      title: 'VED phone fixture',
      createdBy: actorId,
    })
    .returning();
  dealId = deal!.id;
});

afterAll(async () => {
  if (madeRequests.length > 0) {
    await db.delete(calcRequestItems).where(inArray(calcRequestItems.requestId, madeRequests));
    await db.delete(calcGroups).where(inArray(calcGroups.requestId, madeRequests));
    const rows = await db
      .select({ taskId: calcRequests.taskId })
      .from(calcRequests)
      .where(inArray(calcRequests.id, madeRequests));
    await db.delete(calcRequests).where(inArray(calcRequests.id, madeRequests));
    const taskIds = rows.map((r) => r.taskId).filter(Boolean) as string[];
    if (taskIds.length > 0) {
      await db.delete(events).where(inArray(events.entityId, taskIds));
      await db.delete(tasks).where(inArray(tasks.id, taskIds));
    }
  }
  if (madeNames.length > 0) {
    await db
      .delete(tnvedAssignments)
      .where(inArray(tnvedAssignments.productKey, madeNames.map((n) => itemNameNorm(n))));
  }
  await db.delete(deals).where(eq(deals.id, dealId));
  await db.update(clients).set({ active: false }).where(eq(clients.id, clientId));
  await db.update(users).set({ active: false }).where(eq(users.id, actorId));
  await pgClient.end();
});

async function open(items: { name: string; quantity?: number | null; tnvedCode?: string | null }[]) {
  for (const i of items) madeNames.push(i.name);
  const result = await openCalcRequest(
    {
      entityType: 'deal',
      entityId: dealId,
      section: 'rastamojka',
      fromCity: 'Yiwu',
      toCity: 'Toshkent',
      weightKg: 500,
      volumeM3: 10,
      items,
      source: 'card',
    },
    ctx(),
  );
  madeRequests.push(result.id);
  return result.id;
}

const itemRows = (requestId: string) =>
  db.select().from(calcRequestItems).where(eq(calcRequestItems.requestId, requestId)).orderBy(calcRequestItems.seq);
const revOf = async (requestId: string) =>
  (await db.select({ rev: calcRequests.rev }).from(calcRequests).where(eq(calcRequests.id, requestId)))[0]!.rev;
const save = (requestId: string, input: { items?: TableItemEdit[]; adds?: TableNewItem[] }) =>
  saveTable(requestId, { items: input.items ?? [], adds: input.adds ?? [] }, ctx());
async function editOf(requestId: string, seqNo: number, patch: Omit<TableItemEdit, 'id' | 'seq'>) {
  const item = (await itemRows(requestId)).find((i) => i.seq === seqNo)!;
  return { id: item.id, seq: item.seq, ...patch };
}

async function signInVed() {
  // The seeded demo VED (scripts/seed-demo.ts): ved.docs, unscoped.
  const ved = await db.query.users.findFirst({ where: eq(users.phone, '+998900000004') });
  expect(ved, 'the demo VED is seeded').toBeTruthy();
  session.user = {
    id: ved!.id,
    phone: ved!.phone,
    username: ved!.username,
    fullName: ved!.fullName,
    locale: ved!.locale,
    active: true,
    sessionId: '00000000-0000-4000-8000-0000000ca1c0',
  };
}

describe('a save answers the rev it committed (D3, D11)', () => {
  it('saveTable and deleteItem return the request’s rev after commit, one step per save — an empty one too', async () => {
    const id = await open([
      { name: `kafel ${tag()}`, quantity: 5 },
      { name: `kosa ${tag()}`, quantity: 2 },
    ]);
    const first = await save(id, {});
    expect(first.rev).toBe(await revOf(id));
    const second = await save(id, { items: [await editOf(id, 1, { quantity: 6 })] });
    expect(second.rev).toBe(first.rev + 1);
    // The machine's sweep is exactly this post — it moves the clock too, so
    // «the rev moved» can never mean «a person changed this row».
    const empty = await save(id, {});
    expect(empty.rev).toBe(second.rev + 1);
    expect(empty.rev).toBe(await revOf(id));
    const row = (await itemRows(id)).find((i) => i.seq === 2)!;
    const deleted = await deleteItem(id, row.id, ctx());
    expect(deleted.rev).toBe(empty.rev + 1);
    expect(deleted.rev).toBe(await revOf(id));
  });

  it('the two actions the buttons press answer the rev on success', async () => {
    const id = await open([{ name: `likopcha ${tag()}`, quantity: 3 }]);
    await signInVed();
    const saved = await saveTableAction(id, { items: [], adds: [] });
    expect(saved.ok).toBe(true);
    if (!saved.ok) return;
    expect(saved.rev).toBe(await revOf(id));
    const row = (await itemRows(id))[0]!;
    const deleted = await deleteItemAction(id, row.id);
    expect(deleted.ok).toBe(true);
    if (!deleted.ok) return;
    expect(deleted.rev).toBe(saved.rev + 1);
  });
});

describe('the AI claim is read off TEXT as well as a Date (#923)', () => {
  const stamp = (requestId: string, when: 'now' | 'old' | 'none') =>
    db.execute(
      when === 'none'
        ? sql`UPDATE calc_requests SET ai_proposal_started_at = NULL WHERE id = ${requestId}::uuid`
        : when === 'now'
          ? sql`UPDATE calc_requests SET ai_proposal_started_at = now() - interval '1 minute' WHERE id = ${requestId}::uuid`
          : sql`UPDATE calc_requests SET ai_proposal_started_at = now() - interval '11 minutes' WHERE id = ${requestId}::uuid`,
    );

  it('a live claim is shown, refuses the table in words, and heals after ten minutes', async () => {
    const id = await open([{ name: `kafel ${tag()}`, quantity: 5 }]);
    await stamp(id, 'now');
    expect((await loadWorkspace(id))!.aiRunningSince).not.toBeNull();
    expect((await requestClock(id))!.aiRunning).toBe(true);
    // A refusal with a code — never a TypeError out of `.getTime()` on text.
    await expect(save(id, {})).rejects.toMatchObject({ code: 'ai_running' });

    await stamp(id, 'old');
    expect((await loadWorkspace(id))!.aiRunningSince).toBeNull();
    expect((await requestClock(id))!.aiRunning).toBe(false);
    await expect(save(id, {})).resolves.toMatchObject({ rev: expect.any(Number) });

    await stamp(id, 'none');
    expect((await loadWorkspace(id))!.aiRunningSince).toBeNull();
    const clock = await requestClock(id);
    expect(clock).toEqual({ rev: await revOf(id), aiRunning: false, closed: false });
  });

  it('the probe says closed once the request is done, and nothing for a request that is not there', async () => {
    const id = await open([{ name: `kosa ${tag()}`, quantity: 1 }]);
    await db.execute(sql`UPDATE calc_requests SET completed_at = now() WHERE id = ${id}::uuid`);
    expect((await requestClock(id))!.closed).toBe(true);
    expect(await requestClock('00000000-0000-4000-8000-00000000c0de')).toBeNull();
  });
});

describe('a one-row post writes that row and no other (B2 a)', () => {
  it('row A’s baza alone — row B’s cells and its block’s ✅ stand', async () => {
    const id = await open([
      { name: `kafel ${tag()}`, quantity: 5, tnvedCode: '6907' },
      { name: `monitor ${tag()}`, quantity: 2, tnvedCode: '8528520000' },
    ]);
    await save(id, {});
    await confirmAllGroups(id, ctx());
    const before = await itemRows(id);
    const b = before.find((i) => i.seq === 2)!;

    await save(id, { items: [await editOf(id, 1, { bazaUsd: 3, bazaBasis: null })] });

    const after = await itemRows(id);
    const a2 = after.find((i) => i.seq === 1)!;
    const b2 = after.find((i) => i.seq === 2)!;
    expect(Number(a2.bazaUsd)).toBe(3);
    expect(b2).toMatchObject({
      name: b.name,
      quantity: b.quantity,
      tnvedCode: b.tnvedCode,
      bazaUsd: b.bazaUsd,
      groupId: b.groupId,
    });
    const groups = await db.select().from(calcGroups).where(eq(calcGroups.requestId, id));
    expect(groups.find((g) => g.id === a2.groupId)!.confirmedAt).toBeNull();
    expect(groups.find((g) => g.id === b2.groupId)!.confirmedAt).not.toBeNull();
  });
});

describe('a retried add is an EDIT of the stored row — so the browser must convert its ghost', () => {
  it('a retry carrying the correction stores it; a retry carrying the stale value writes the stale value back', async () => {
    const id = await open([{ name: `kosa ${tag()}`, quantity: 1 }]);
    const clientRowId = crypto.randomUUID();
    const name = `likopcha ${tag()}`;
    madeNames.push(name);
    await save(id, { adds: [{ clientId: clientRowId, name, quantity: 5 }] });
    const stored = (await itemRows(id)).find((i) => i.id === clientRowId)!;
    expect(Number(stored.quantity)).toBe(5);

    // The edit the phone posts once the ghost has become a draft of its row.
    await save(id, { items: [{ id: clientRowId, seq: stored.seq, quantity: 6 }] });
    // A retried add with the SAME values: still one row, still 6.
    await save(id, { adds: [{ clientId: clientRowId, name, quantity: 6 }] });
    let rows = await itemRows(id);
    expect(rows.filter((i) => i.id === clientRowId)).toHaveLength(1);
    expect(Number(rows.find((i) => i.id === clientRowId)!.quantity)).toBe(6);

    // …and the reason the browser must never re-post a stale ghost: the
    // server cannot tell a stale 5 from a correction to 5.
    await save(id, { adds: [{ clientId: clientRowId, name, quantity: 5 }] });
    rows = await itemRows(id);
    expect(rows).toHaveLength(2);
    expect(Number(rows.find((i) => i.id === clientRowId)!.quantity)).toBe(5);
  });
});
