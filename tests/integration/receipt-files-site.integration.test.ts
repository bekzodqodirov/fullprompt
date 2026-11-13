import 'dotenv/config';
import { randomUUID } from 'node:crypto';
import { and, eq, inArray } from 'drizzle-orm';
import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest';

/**
 * «Sotuvchi prixod kartasida (saytda) ham fayl qo'sha olsin» — the owner's
 * «4 b» of 2026-11-12 (docs/PRIXOD-JAVOBLAR.md §3), at the door the card's
 * tile posts to: `/api/files/upload`, run for real with the signed-in person
 * stood in for (`requireActor` — the route asks it, never `getActor`).
 *
 * What the round changed there: a picture a reader WITHOUT `receipts.edit`
 * adds to a confirmed prixod is stored as a PAPER (never a carton photo); a
 * voided prixod is refused, as the bot refuses it; and every file added to a
 * confirmed prixod writes its History line (5a's ⭐, «tarixda ko'rinadi») —
 * while the wizard's pre-binding to a prixod that does not exist yet passes
 * and writes none.
 */
const who = vi.hoisted(() => ({ actor: null as null | Record<string, unknown> }));
vi.mock('@/modules/platform/rbac/authorize', async (original) => ({
  ...(await original<typeof import('@/modules/platform/rbac/authorize')>()),
  requireActor: async () => who.actor,
}));

import { db, pgClient } from '@/modules/platform/db/client';
import { attachments, auditLog, receipts, users, warehouses } from '@/modules/platform/db/schema';
import { getStorage } from '@/modules/platform/files/storage';
import { POST } from '@/app/api/files/upload/route';

const RUN = String(Date.now()).slice(-6);
let staffId = '';
let whId = '';
const receipt = { live: '', voided: '' };
const made: string[] = [];

/** One pixel of PNG — a picture to the route, whatever it is to a person. */
const PNG = Buffer.from(
  'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8BQDwAEhQGAhKmMIQAAAABJRU5ErkJggg==',
  'base64',
);

const seller = () => ({ id: staffId, fullName: `FS sotuvchi ${RUN}`, roles: ['sales_manager'], permissions: new Set(['crm.leads']), warehouseScoped: false, warehouseIds: [] });
const keeper = () => ({ id: staffId, fullName: `FS skladchi ${RUN}`, roles: ['warehouse_manager'], permissions: new Set(['receipts.edit']), warehouseScoped: false, warehouseIds: [] });
// Opens every prixod (an unscoped login) and works none of them.
const accountant = () => ({
  id: staffId,
  fullName: `FS buxgalter ${RUN}`,
  roles: ['accountant'],
  permissions: new Set(['finance.manage', 'finance.view', 'finance.reports', 'reports.all_warehouses']),
  warehouseScoped: false,
  warehouseIds: [],
});

async function upload(entityId: string, name = `faktura-${RUN}.png`, type = 'image/png', body: Buffer = PNG) {
  const form = new FormData();
  form.set('file', new File([new Uint8Array(body)], name, { type }));
  form.set('entityType', 'receipt');
  form.set('entityId', entityId);
  const res = await POST(new Request('http://localhost/api/files/upload', { method: 'POST', body: form }));
  const json = (await res.json()) as { id?: string; kind?: string; error?: string };
  if (json.id) made.push(json.id);
  return { status: res.status, ...json };
}
const historyOf = async (receiptId: string) =>
  db
    .select({ actorId: auditLog.actorId, action: auditLog.action, after: auditLog.after })
    .from(auditLog)
    .where(and(eq(auditLog.entityType, 'receipt'), eq(auditLog.entityId, receiptId)));

beforeAll(async () => {
  const people = await db.select({ id: users.id }).from(users).where(eq(users.active, true)).limit(1);
  staffId = people[0]!.id;
  const [wh] = await db
    .insert(warehouses)
    .values({ code: `FS${RUN}`, name: `Fayl sklad ${RUN}`, country: 'CN', type: 'origin', timezone: 'Asia/Shanghai', batchPrefix: `FS${RUN}` })
    .returning({ id: warehouses.id });
  whId = wh!.id;
  for (const key of ['live', 'voided'] as const) {
    const [row] = await db
      .insert(receipts)
      .values({
        warehouseId: whId,
        number: `FS-${RUN}-${key}`,
        status: key === 'live' ? 'confirmed' : 'voided',
        voidedAt: key === 'live' ? null : new Date(),
        voidReason: key === 'live' ? null : 'sinov',
        createdBy: staffId,
        confirmedAt: new Date(Date.now() - 3_600_000),
        confirmedBy: staffId,
      })
      .returning({ id: receipts.id });
    receipt[key] = row!.id;
  }
});

afterAll(async () => {
  if (made.length > 0) {
    const rows = await db.select({ key: attachments.storageKey }).from(attachments).where(inArray(attachments.id, made));
    for (const row of rows) await getStorage().delete(row.key).catch(() => undefined);
    await db.delete(attachments).where(inArray(attachments.id, made));
  }
  const ids = Object.values(receipt).filter(Boolean);
  if (ids.length > 0) await db.delete(receipts).where(inArray(receipts.id, ids));
  if (whId) await db.update(warehouses).set({ active: false }).where(eq(warehouses.id, whId));
  await pgClient.end();
});

describe('a file added on the prixod card (4b)', () => {
  it('a seller’s picture is stored as a PAPER — never the prixod’s carton photo — and the screen is told so', async () => {
    who.actor = seller();
    const res = await upload(receipt.live);
    expect([res.status, res.kind]).toEqual([201, 'file']);
    const [row] = await db.select({ kind: attachments.kind }).from(attachments).where(eq(attachments.id, res.id!));
    expect(row?.kind).toBe('file');
  });

  it('the warehouse’s picture stays a carton photo, as it always was', async () => {
    who.actor = keeper();
    const res = await upload(receipt.live, `karobka-${RUN}.png`);
    expect([res.status, res.kind]).toEqual([201, 'photo']);
  });

  it('every file added to a confirmed prixod writes its History line — an `update`, by the uploader, keyed by the file', async () => {
    who.actor = seller();
    const res = await upload(receipt.live, `invoys-${RUN}.pdf`, 'application/pdf', Buffer.from('%PDF-1.4\n%%EOF\n'));
    expect(res.status).toBe(201);
    const line = (await historyOf(receipt.live)).find((r) => r.after && `fileAdded:${res.id}` in (r.after as Record<string, unknown>));
    expect(line?.action).toBe('update');
    expect(line?.actorId).toBe(staffId);
    // The file's own name — the bot's line says «· Telegram», the site's says nothing more.
    expect((line!.after as Record<string, string>)[`fileAdded:${res.id}`]).toBe(`invoys-${RUN}.pdf`);
  });

  it('a reader who works no prixod — the accountant — opens the card and adds nothing to it (the owner lens, O7)', async () => {
    who.actor = accountant();
    const files = async () => (await db.select({ id: attachments.id }).from(attachments).where(eq(attachments.entityId, receipt.live))).length;
    const before = await files();
    const res = await upload(receipt.live, `buxgalter-${RUN}.pdf`, 'application/pdf', Buffer.from('%PDF-1.4\n%%EOF\n'));
    expect(res.status).toBe(403);
    expect(await files()).toBe(before);
  });

  it('a voided prixod takes no file — the bot’s own refusal', async () => {
    who.actor = keeper();
    const res = await upload(receipt.voided);
    expect(res.status).toBe(403);
    expect(await historyOf(receipt.voided)).toEqual([]);
  });

  it('the wizard’s pre-binding (no prixod yet) still passes, and writes no History', async () => {
    who.actor = keeper();
    const draftId = randomUUID();
    const res = await upload(draftId);
    expect([res.status, res.kind]).toEqual([201, 'photo']);
    expect(await historyOf(draftId)).toEqual([]);
  });
});
