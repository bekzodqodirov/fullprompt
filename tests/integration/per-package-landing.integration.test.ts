import 'dotenv/config';
import { and, asc, eq, gte, inArray } from 'drizzle-orm';
import { v4 as uuidv4 } from 'uuid';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { db, pgClient } from '@/modules/platform/db/client';
import { calcRequestItems, calcRequests, crmActivities, events, leads, tasks, users } from '@/modules/platform/db/schema';
import { LONE_WEIGHT_NOTE } from '@/modules/wms/calc/intake';
import { parseManualFacts } from '@/modules/wms/calc/intake-manual';
import { landIntake } from '@/modules/wms/calc/intake-land';

/**
 * docs/AI-SORAYDI.md §3.1 T4/T6 against the real database: what the bot's
 * landing STORES when the seller typed a per-carton figure and the model did
 * not read (no key, the day's budget, a failure — the typed reader is then
 * the whole reading). DIM-4 measured the defect at the INSERT:
 * calc_requests.weight_kg = 15 and the one row's weight_kg = 15 «og‘irlik
 * umumiy (brutto)dan olindi» — one carton's weight, priced per kg as the
 * whole job's. The row now stores the carton arithmetic's figures, and its
 * note says how each was made; the request stores no brutto nobody stated.
 */

const STAMP = String(Date.now()).slice(-6);
const FILE_START = new Date();
let actorId: string;
const madeLeads: string[] = [];

beforeAll(async () => {
  actorId = (await db.select().from(users).limit(1))[0]!.id;
});

afterAll(async () => {
  // The landing opens a calc request in the company-wide VED queue: cleared
  // by window (this actor, since this file started), deepest first.
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
  if (madeLeads.length) {
    await db.delete(crmActivities).where(inArray(crmActivities.entityId, madeLeads));
    await db.delete(leads).where(inArray(leads.id, madeLeads));
  }
  await pgClient.end();
});

/** The bot's landing of ONE typed message, read by the typed reader alone. */
async function land(text: string, section: 'podklyuch' | 'rastamojka' = 'podklyuch') {
  const facts = parseManualFacts(text, section);
  const target = await landIntake({
    intakeDoor: 'ai',
    noteId: uuidv4(),
    section,
    facts,
    steps: [],
    fileCount: 0,
    material: [text],
    collectedBy: actorId,
    collectedByName: 'Bot xodim',
    client: null,
    leadName: `T4 karobka ${STAMP} ${madeLeads.length}`,
    leadPhone: null,
  });
  madeLeads.push(target.id);
  const [request] = await db
    .select({ id: calcRequests.id, weightKg: calcRequests.weightKg, volumeM3: calcRequests.volumeM3 })
    .from(calcRequests)
    .where(eq(calcRequests.entityId, target.id));
  const items = await db
    .select({
      name: calcRequestItems.name,
      quantity: calcRequestItems.quantity,
      weightKg: calcRequestItems.weightKg,
      volumeM3: calcRequestItems.volumeM3,
      note: calcRequestItems.note,
    })
    .from(calcRequestItems)
    .where(eq(calcRequestItems.requestId, request!.id))
    .orderBy(asc(calcRequestItems.seq));
  const n = (v: string | null) => (v === null ? null : Number(v));
  return {
    request: { weightKg: n(request!.weightKg), volumeM3: n(request!.volumeM3) },
    items: items.map((i) => ({ ...i, quantity: n(i.quantity), weightKg: n(i.weightKg), volumeM3: n(i.volumeM3) })),
  };
}

describe('the landing stores the carton arithmetic, never one carton’s figure', () => {
  it('one carton count: the row stores 20 × 15 = 300 kg and 20 × 0.12 = 2.4 m³; the request no 15 kg brutto', async () => {
    // RE-ANCHORED (review typed-spec-1, ruling JN-7): DIM-4's own line also
    // states «300 dona», and an each beside both counts multiplies nothing —
    // pinned below. One carton count is the shape this arithmetic is for.
    const out = await land('Kurtka 20 karobka, karobka razmeri 60x40x50 sm, har biri 15 kg');
    // No brutto was typed: the column stays empty for the totals question.
    expect(out.request.weightKg).toBeNull();
    // The truck's cube is the lines' Σ — here the one line's computed 2.4.
    expect(out.request.volumeM3).toBe(2.4);
    expect(out.items).toHaveLength(1);
    expect(out.items[0]).toMatchObject({ name: 'Kurtka', weightKg: 300, volumeM3: 2.4 });
    const note = out.items[0]!.note ?? '';
    expect(note).toContain('📦 20 karobka · 60×40×50 sm · 15 kg/karobka — sotuvchi');
    expect(note).toContain('og‘irlik hisoblangan: 20 × 15 kg = 300 kg');
    expect(note).toContain('hajm hisoblangan: 20 × 60×40×50 sm = 2.4 m³');
    // …and never the copy of a total nobody stated.
    expect(note).not.toContain(LONE_WEIGHT_NOTE);
  });

  it('DIM-4 beside both counts: the cube lands computed, the weight stays for the question — «har biri 15 kg» on the note', async () => {
    const out = await land('Kurtka 300 dona, 20 karobka, karobka razmeri 60x40x50 sm, har biri 15 kg');
    expect(out.request.weightKg).toBeNull();
    expect(out.items[0]).toMatchObject({ name: 'Kurtka', quantity: 300, weightKg: null, volumeM3: 2.4 });
    expect(out.items[0]!.note ?? '').toContain('sotuvchi: har biri 15 kg');
    expect(out.items[0]!.note ?? '').not.toContain('og‘irlik hisoblangan');
  });

  it('JS-1: one PIECE’s weight lands as 300 × 0.2 = 60 kg on the row', async () => {
    const out = await land('Telefon 300 dona, har biri 0.2 kg', 'rastamojka');
    expect(out.request.weightKg).toBeNull();
    expect(out.items[0]).toMatchObject({ name: 'Telefon', quantity: 300, weightKg: 60 });
    expect(out.items[0]!.note).toContain('og‘irlik hisoblangan: 300 × 0.2 kg = 60 kg');
  });

  it('JS-2: a size nobody said is the package’s lands no cube — only its words, for the VED', async () => {
    const out = await land('Stol 120x80x75 sm, 10 karobka');
    // 10 × 0.72 = 7.2 m³ is the cube nobody shipped, if the size is the table's own.
    expect(out.request.volumeM3).toBeNull();
    expect(out.items[0]).toMatchObject({ name: 'Stol', volumeM3: null });
    expect(out.items[0]!.note).toContain('📦 10 karobka · o‘lcham (kimniki — aniq emas) 120×80×75 sm — sotuvchi');
  });
});
