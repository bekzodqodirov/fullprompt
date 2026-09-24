'use server';

import { eq } from 'drizzle-orm';
import { revalidatePath } from 'next/cache';
import { z } from 'zod';
import { db } from '@/modules/platform/db/client';
import { pickupStops, receipts } from '@/modules/platform/db/schema';
import { AuthError, authorize } from '@/modules/platform/rbac/authorize';
import { requestMeta } from '@/modules/platform/auth/session';
import {
  addStop,
  cancelPickup,
  collectStop,
  confirmFactoryPoint,
  createPickup,
  linkReceiptToStop,
  markArrived,
  PICKUP_WRITE,
  PickupError,
  removeStop,
  resolveLineOwners,
  saveFactory,
  saveStopLines,
  setFactoryActive,
  setFactoryPoint,
  updatePickupHeader,
} from '@/modules/wms/pickups/service';

export interface PickupActionResult {
  ok: boolean;
  error?: string;
  id?: string;
  /** saveFactory only: what the geocoder said, so the form can say it too. */
  geocoded?: 'found' | 'not_found' | 'kept';
}

/**
 * One wrapper for every write: authorize, run, name the refusal. A refusal
 * comes back as a CODE the form turns into a sentence, never a white page
 * (#472), and a form that can be refused keeps its inputs (#463).
 */
async function run(
  gate: () => Promise<{ id: string }>,
  body: (ctx: { actorId: string }) => Promise<Partial<PickupActionResult> | void>,
  paths: string[],
): Promise<PickupActionResult> {
  let actor;
  try {
    actor = await gate();
  } catch (err) {
    if (err instanceof AuthError) return { ok: false, error: 'forbidden' };
    throw err;
  }
  const meta = await requestMeta();
  try {
    const extra = await body({ actorId: actor.id, ...meta });
    for (const path of paths) revalidatePath(path);
    return { ok: true, ...(extra ?? {}) };
  } catch (err) {
    if (err instanceof PickupError) return { ok: false, error: err.code };
    if (err instanceof z.ZodError) return { ok: false, error: 'validation' };
    throw err;
  }
}

const writer = () => authorize(PICKUP_WRITE);

// --- factories ---------------------------------------------------------------

export async function saveFactoryAction(input: unknown): Promise<PickupActionResult> {
  return run(writer, async (ctx) => {
    const res = await saveFactory(input as Parameters<typeof saveFactory>[0], ctx);
    return { id: res.id, geocoded: res.geocoded };
  }, ['/zavod/zavodlar']);
}

const pointSchema = z.object({
  id: z.string().uuid(),
  text: z.string().trim().min(3).max(500),
  datum: z.enum(['wgs84', 'gcj02']),
});

export async function setFactoryPointAction(input: unknown): Promise<PickupActionResult> {
  const parsed = pointSchema.safeParse(input);
  if (!parsed.success) return { ok: false, error: 'bad_point' };
  return run(writer, (ctx) => setFactoryPoint(parsed.data.id, parsed.data, ctx), ['/zavod/zavodlar', '/map']);
}

export async function confirmFactoryPointAction(id: string): Promise<PickupActionResult> {
  if (!z.string().uuid().safeParse(id).success) return { ok: false, error: 'validation' };
  return run(writer, (ctx) => confirmFactoryPoint(id, ctx), ['/zavod/zavodlar']);
}

export async function setFactoryActiveAction(id: string, active: boolean): Promise<PickupActionResult> {
  if (!z.string().uuid().safeParse(id).success) return { ok: false, error: 'validation' };
  return run(writer, (ctx) => setFactoryActive(id, active, ctx), ['/zavod/zavodlar']);
}

// --- trips -------------------------------------------------------------------

const ownerLine = z.object({
  owner: z.string().trim().min(1).max(50),
  goods: z.string(),
  factoryBoxes: z.number(),
  volumeM3: z.number().nullable().optional(),
  weightKg: z.number().nullable().optional(),
  note: z.string().optional(),
});

const createSchema = z.object({
  destWarehouseId: z.string(),
  vehiclePlate: z.string().optional(),
  driverName: z.string().optional(),
  driverPhone: z.string().optional(),
  plannedOn: z.string().optional(),
  note: z.string().optional(),
  stops: z.array(z.object({ factoryId: z.string(), lines: z.array(ownerLine) })),
});

export async function createPickupAction(input: unknown): Promise<PickupActionResult> {
  const parsed = createSchema.safeParse(input);
  if (!parsed.success) return { ok: false, error: 'validation' };
  return run(writer, async (ctx) => {
    const stops = [];
    for (const stop of parsed.data.stops) {
      stops.push({ factoryId: stop.factoryId, lines: await resolveLineOwners(stop.lines) });
    }
    const created = await createPickup({ ...parsed.data, stops }, ctx);
    return { id: created.id };
  }, ['/zavod', '/receive']);
}

export async function updatePickupHeaderAction(pickupId: string, input: unknown): Promise<PickupActionResult> {
  if (!z.string().uuid().safeParse(pickupId).success) return { ok: false, error: 'validation' };
  return run(writer, (ctx) => updatePickupHeader(pickupId, input as never, ctx), [`/zavod/${pickupId}`, '/zavod']);
}

export async function addStopAction(pickupId: string, factoryId: string): Promise<PickupActionResult> {
  const ids = z.array(z.string().uuid()).safeParse([pickupId, factoryId]);
  if (!ids.success) return { ok: false, error: 'validation' };
  return run(writer, async (ctx) => ({ id: await addStop(pickupId, factoryId, ctx) }), [`/zavod/${pickupId}`]);
}

async function pickupOf(stopId: string) {
  const stop = await db.query.pickupStops.findFirst({ where: eq(pickupStops.id, stopId) });
  return stop?.pickupId ?? null;
}

export async function removeStopAction(stopId: string): Promise<PickupActionResult> {
  if (!z.string().uuid().safeParse(stopId).success) return { ok: false, error: 'validation' };
  const pickupId = await pickupOf(stopId);
  return run(writer, (ctx) => removeStop(stopId, ctx), [`/zavod/${pickupId}`]);
}

export async function saveStopLinesAction(stopId: string, lines: unknown): Promise<PickupActionResult> {
  if (!z.string().uuid().safeParse(stopId).success) return { ok: false, error: 'validation' };
  const parsed = z.array(ownerLine).max(40).safeParse(lines);
  if (!parsed.success) return { ok: false, error: 'validation' };
  const pickupId = await pickupOf(stopId);
  return run(
    writer,
    async (ctx) => saveStopLines(stopId, await resolveLineOwners(parsed.data), ctx),
    [`/zavod/${pickupId}`, '/receive'],
  );
}

const collectSchema = z.object({
  stopId: z.string().uuid(),
  driverBoxes: z.record(z.string().uuid(), z.number().int().positive().nullable()).optional(),
  stampNote: z.string().trim().max(500).optional(),
});

export async function collectStopAction(input: unknown): Promise<PickupActionResult> {
  const parsed = collectSchema.safeParse(input);
  if (!parsed.success) return { ok: false, error: 'validation' };
  const pickupId = await pickupOf(parsed.data.stopId);
  return run(
    writer,
    (ctx) => collectStop(parsed.data.stopId, parsed.data, ctx),
    [`/zavod/${pickupId}`, '/zavod', '/receive', '/map'],
  );
}

export async function markArrivedAction(pickupId: string): Promise<PickupActionResult> {
  if (!z.string().uuid().safeParse(pickupId).success) return { ok: false, error: 'validation' };
  return run(writer, (ctx) => markArrived(pickupId, ctx), [`/zavod/${pickupId}`, '/zavod', '/map']);
}

export async function cancelPickupAction(pickupId: string, reason: string): Promise<PickupActionResult> {
  if (!z.string().uuid().safeParse(pickupId).success) return { ok: false, error: 'validation' };
  return run(writer, (ctx) => cancelPickup(pickupId, reason, ctx), [`/zavod/${pickupId}`, '/zavod', '/receive']);
}

/**
 * Attach a prixod to a stop, or detach it (`stopId` null). This moves the
 * truck's MONEY, so the gate is the one a truck's cost has —
 * `costs.enter_batch` — at the RECEIPT's warehouse, not the pickup writer's.
 */
export async function linkReceiptAction(receiptId: string, stopId: string | null): Promise<PickupActionResult> {
  if (!z.string().uuid().safeParse(receiptId).success) return { ok: false, error: 'validation' };
  if (stopId !== null && !z.string().uuid().safeParse(stopId).success) return { ok: false, error: 'validation' };
  const receipt = await db.query.receipts.findFirst({ where: eq(receipts.id, receiptId) });
  if (!receipt) return { ok: false, error: 'receipt_not_found' };
  const before = receipt.pickupStopId ? await pickupOf(receipt.pickupStopId) : null;
  const after = stopId ? await pickupOf(stopId) : null;
  return run(
    () => authorize('costs.enter_batch', { warehouseId: receipt.warehouseId }),
    (ctx) => linkReceiptToStop(receiptId, stopId, ctx),
    [`/receipts/${receiptId}`, ...[before, after].filter(Boolean).map((id) => `/zavod/${id}`)],
  );
}
