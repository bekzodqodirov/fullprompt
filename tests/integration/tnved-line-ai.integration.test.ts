import 'dotenv/config';
import { randomUUID } from 'node:crypto';
import { eq, inArray, sql } from 'drizzle-orm';
import { beforeAll, describe, expect, it, vi } from 'vitest';

/**
 * The 🤖 on a lot tarkibi LINE, pressed (the owner's item 5, 2026-11-10;
 * docs/TARKIB-TUZATISH.md §5) — the twin of batch-door's «the TNVED
 * suggestion», for the action the Bojxona tab's line rows call.
 *
 * It stands in for three things and nothing else: the session's actor, Next's
 * cache and the MODEL. The stand-in model records every question it is put —
 * «never asked» is half of every refusal here (the AI is paid per call, and a
 * code that could not be saved must not be paid for), and what it IS asked is
 * the other half of the round: the line's own name, the photograph only when
 * every carton of the lot is that one good.
 *
 * The fixture is this file's own: a departed truck CN → UZ, and a prixod
 * received at a THIRD warehouse (RCV — an internal leg brought it to the
 * truck) with three lots: S (a one-line tarkib of the lot's own good), M (two
 * goods, neither the lot's name), P (no tarkib) — plus a fourth lot with a
 * tarkib that does NOT ride the truck. RCV is what lets the card door be
 * proven alone: a person standing there may read the prixod (the
 * composition's door lets them through) and may not open the truck.
 * Cleanup is the final test (#57); the three warehouses are deactivated,
 * not deleted (an audit row names one).
 */

const override = vi.hoisted(() => ({ actor: null as null | Record<string, unknown> }));
const model = vi.hoisted(() => ({
  asked: [] as { nameZh: string; nameRu: string | null; photo: boolean; context: string[] }[],
  fail: null as null | string,
  /** A failure AFTER the model answered carries what the answer cost. */
  failUsage: null as null | { model: string; inputTokens: number; outputTokens: number },
  /** What a good answer cost (0144: the press is billed). */
  usage: null as null | { model: string; inputTokens: number; outputTokens: number },
  /** The failure was OUR deadline running out after the request was sent. */
  timedOut: false,
  key: true,
}));

vi.mock('@/modules/platform/auth/session', async (original) => ({
  ...(await original<typeof import('@/modules/platform/auth/session')>()),
  getSessionUser: async () => null,
  requestMeta: async () => ({ ip: null, userAgent: 'tnved-line-ai.integration' }),
}));
vi.mock('next/cache', async (original) => ({
  ...(await original<typeof import('next/cache')>()),
  revalidatePath: () => {},
}));
vi.mock('@/modules/platform/rbac/authorize', async (original) => {
  const real = await original<typeof import('@/modules/platform/rbac/authorize')>();
  return {
    ...real,
    requireActor: async () => (override.actor ?? (await real.requireActor())) as Awaited<ReturnType<typeof real.requireActor>>,
  };
});
// CI has no key, and since 0144 the action asks for one BEFORE it counts the
// press — so the key is a switch here.
vi.mock('@/modules/platform/ai/model', async (original) => ({
  ...(await original<typeof import('@/modules/platform/ai/model')>()),
  aiConfigured: () => model.key,
}));
vi.mock('@/modules/wms/tnved/service', async (original) => {
  const real = await original<typeof import('@/modules/wms/tnved/service')>();
  return {
    ...real,
    suggestTnved: async (input: Parameters<typeof real.suggestTnved>[0]) => {
      model.asked.push({
        nameZh: input.nameZh,
        nameRu: input.nameRu,
        photo: Boolean(input.photo),
        context: [...(input.context ?? [])],
      });
      if (model.fail) throw new real.TnvedError(model.fail as 'ai_failed', model.failUsage ?? undefined, model.timedOut);
      return {
        tnved_code: '8471607000',
        name_ru: 'Мышь',
        confidence: 'high' as const,
        reasoning: 'test',
        ...(model.usage ? { usage: model.usage } : {}),
      };
    },
  };
});

import { db } from '@/modules/platform/db/client';
import {
  attachments,
  batchSentCompositions,
  batches,
  boxMovements,
  boxes,
  clients,
  lotCompositionLines,
  lotCompositions,
  receiptLots,
  receipts,
  tnvedAssignments,
  users,
  warehouses,
} from '@/modules/platform/db/schema';
import { getStorage } from '@/modules/platform/files/storage';
import { getSetting, setSetting } from '@/modules/platform/settings/service';
import {
  saveLineCodesAction,
  saveTnvedAction,
  suggestTnvedForLineAction,
} from '@/app/(protected)/batches/[id]/tnved/actions';
import { batchTnvedProducts } from '@/modules/wms/tnved/batch-lots';
import { productKey } from '@/modules/wms/tnved/service';

const SFX = randomUUID().replace(/-/g, '').slice(0, 6).toUpperCase();
const NOWHERE = '00000000-0000-4000-8000-00000a1a1a00';
const ZH = { S: `键盘${SFX}`, M: `杂货${SFX}`, P: `灯${SFX}`, OFF: `别的${SFX}` };

let author = '';
const wh = { CN: '', UZ: '', RCV: '' };
let truck = '';
let receiptId = '';
let offReceiptId = '';
const lot = { S: '', M: '', P: '', OFF: '' };
const lineId = { S: '', M1: '', M2: '', OFF: '' };
const boxIds: string[] = [];
const photoKeys: string[] = [];
let memoryBefore = 0;

/** The VED, unscoped — the seeded ved_manager's shape. */
const ved = (over: Record<string, unknown> = {}) => ({
  id: author,
  permissions: new Set(['ved.docs']),
  warehouseScoped: false,
  warehouseIds: [] as string[],
  roles: [] as string[],
  fullName: 'VED',
  phone: null,
  username: null,
  locale: 'uz',
  active: true,
  sessionId: NOWHERE,
  ...over,
});

async function mintLot(key: keyof typeof lot, receipt: string, seq: number, n: number, onTruck: boolean) {
  const [row] = await db
    .insert(receiptLots)
    .values({
      receiptId: receipt,
      seq,
      letter: String.fromCharCode(64 + seq),
      cycleNo: 1,
      productNameZh: ZH[key],
      productNameRu: key === 'S' ? 'Клавиатура' : null,
      boxCount: n,
      dimsMode: 'mixed',
      totalWeightKg: '100.000',
      totalVolumeM3: '1.0000',
    })
    .returning({ id: receiptLots.id });
  lot[key] = row!.id;
  const made = await db
    .insert(boxes)
    .values(
      Array.from({ length: n }, (_, i) => ({
        lotId: row!.id,
        seqInLot: i + 1,
        shortCode: `AI${SFX}${key}${i + 1}`,
        status: onTruck ? 'in_transit' : 'in_stock',
        currentWarehouseId: onTruck ? null : wh.CN,
        currentBatchId: onTruck ? truck : null,
      })),
    )
    .returning({ id: boxes.id });
  boxIds.push(...made.map((b) => b.id));
  if (onTruck) {
    await db.insert(boxMovements).values(
      made.map((b) => ({
        boxId: b.id,
        fromStatus: 'loading',
        toStatus: 'in_transit',
        cause: 'batch_departed',
        refType: 'batch',
        refId: truck,
        actorId: author,
      })),
    );
  }
}

async function compose(key: keyof typeof lot, n: number, lines: { name: string; cartons: number; kg: string; m3: string; pieces?: number }[]) {
  await db.insert(lotCompositions).values({ lotId: lot[key], seenBoxCount: n, savedBy: author });
  const made = await db
    .insert(lotCompositionLines)
    .values(
      lines.map((l, i) => ({
        lotId: lot[key],
        seq: i + 1,
        name: l.name,
        pieces: l.pieces ?? null,
        cartons: l.cartons,
        weightKg: l.kg,
        volumeM3: l.m3,
      })),
    )
    .returning({ id: lotCompositionLines.id, seq: lotCompositionLines.seq });
  return made.sort((a, b) => a.seq - b.seq).map((r) => r.id);
}

/** A photograph of the lot whose bytes storage really holds — the action reads them. */
async function mintPhoto(key: keyof typeof lot) {
  const storageKey = `receipt_lot/${lot[key]}/ai-${SFX}.jpg`;
  await getStorage().put(storageKey, Buffer.from('not really a jpeg'), 'image/jpeg');
  photoKeys.push(storageKey);
  await db.insert(attachments).values({
    entityType: 'receipt_lot',
    entityId: lot[key],
    kind: 'photo',
    storageKey,
    fileName: `ai-${SFX}.jpg`,
    contentType: 'image/jpeg',
    sizeBytes: 17,
    uploadedBy: author,
  });
}

beforeAll(async () => {
  author = (await db.query.users.findFirst({ where: eq(users.phone, '+998900000004') }))!.id;
  for (const key of ['CN', 'UZ', 'RCV'] as const) {
    const [w] = await db
      .insert(warehouses)
      .values({
        code: `AI${key}${SFX}`.slice(0, 12),
        name: `AI qator ${key} ${SFX}`,
        country: key === 'UZ' ? 'UZ' : 'CN',
        type: key === 'UZ' ? 'distribution' : 'origin',
        timezone: key === 'UZ' ? 'Asia/Tashkent' : 'Asia/Shanghai',
        batchPrefix: `A${key}${SFX}`.slice(0, 8),
      })
      .returning({ id: warehouses.id });
    wh[key] = w!.id;
  }
  truck = (
    await db
      .insert(batches)
      .values({
        code: `AIT-${SFX}`,
        originWarehouseId: wh.CN,
        destWarehouseId: wh.UZ,
        status: 'in_transit',
        departedAt: new Date(),
        createdBy: author,
      })
      .returning({ id: batches.id })
  )[0]!.id;
  const clientId = (
    await db
      .insert(clients)
      .values({ clientCode: `AI${SFX}`.slice(0, 10), name: `AI qator mijoz ${SFX}` })
      .returning({ id: clients.id })
  )[0]!.id;
  [receiptId, offReceiptId] = (
    await db
      .insert(receipts)
      .values([
        { number: `AI-${SFX}-1`, warehouseId: wh.RCV, clientId, status: 'confirmed', createdBy: author, confirmedAt: new Date(), confirmedBy: author },
        { number: `AI-${SFX}-2`, warehouseId: wh.RCV, clientId, status: 'confirmed', createdBy: author, confirmedAt: new Date(), confirmedBy: author },
      ])
      .returning({ id: receipts.id })
  ).map((r) => r.id) as [string, string];

  await mintLot('S', receiptId, 1, 4, true);
  await mintLot('M', receiptId, 2, 4, true);
  await mintLot('P', receiptId, 3, 2, true);
  await mintLot('OFF', offReceiptId, 1, 2, false);
  // S: «Bitta tovar» — one line named as the lot's Russian name, with pieces.
  [lineId.S] = (await compose('S', 4, [{ name: 'Клавиатура', cartons: 4, kg: '100.000', m3: '1.0000', pieces: 400 }])) as [string];
  // M: two goods, neither of them the lot's name.
  [lineId.M1, lineId.M2] = (await compose('M', 4, [
    { name: `Мышь ${SFX}`, cartons: 3, kg: '75.000', m3: '0.7500', pieces: 900 },
    { name: `Коврик ${SFX}`, cartons: 1, kg: '25.000', m3: '0.2500' },
  ])) as [string, string];
  [lineId.OFF] = (await compose('OFF', 2, [{ name: `Лампа ${SFX}`, cartons: 2, kg: '100.000', m3: '1.0000' }])) as [string];
  await mintPhoto('S');
  await mintPhoto('M');
  memoryBefore = (await db.select({ id: tnvedAssignments.id }).from(tnvedAssignments)).length;
});

const press = (lotKey: keyof typeof lot, line: string, batch = truck) => {
  model.asked.length = 0;
  return suggestTnvedForLineAction(batch, lot[lotKey], line);
};

describe('the 🤖 on a tarkib line — what the model is asked', () => {
  it('the tab draws these lines, each with a live id — the premise', async () => {
    const rows = (await batchTnvedProducts(truck, true)).filter((r) => r.line);
    expect(rows.map((r) => [r.nameZh, r.line!.lineId, r.line!.frozen])).toEqual([
      ['Клавиатура', lineId.S, false],
      [`Мышь ${SFX}`, lineId.M1, false],
      [`Коврик ${SFX}`, lineId.M2, false],
    ]);
  });

  it('a one-line tarkib of the lot’s own good: the lot’s Chinese name, its Russian one, and the photograph', async () => {
    override.actor = ved();
    const answer = await press('S', lineId.S);
    expect(answer).toMatchObject({ ok: true, photo: true });
    expect(answer.suggestion?.tnved_code).toBe('8471607000');
    expect(model.asked).toEqual([
      {
        nameZh: ZH.S,
        nameRu: 'Клавиатура',
        photo: true,
        context: ['Количество этого товара: 400 шт · 4 кор. · 100 кг · 1 м³'],
      },
    ]);
  });

  it('a line of a lot of several goods: its own name, NO photograph, the siblings and the warehouse’s word as context', async () => {
    override.actor = ved();
    const answer = await press('M', lineId.M1);
    // `photo: false` is what lets the screen say «faqat nomga qarab».
    expect(answer).toMatchObject({ ok: true, photo: false });
    expect(model.asked).toHaveLength(1);
    const asked = model.asked[0]!;
    expect([asked.nameZh, asked.nameRu, asked.photo]).toEqual([`Мышь ${SFX}`, null, false]);
    expect(asked.context).toEqual([
      'Количество этого товара: 900 шт · 3 кор. · 75 кг · 0.75 м³',
      `На складе эти коробки были приняты под названием «${ZH.M}» — это название может быть неточным`,
      `В тех же коробках лежат и другие товары: Коврик ${SFX}`,
    ]);
  });

  it('it writes nothing — not the line, not the memory', async () => {
    const lines = await db.query.lotCompositionLines.findMany({ where: inArray(lotCompositionLines.lotId, [lot.S, lot.M]) });
    expect(lines.map((l) => l.tnvedCode)).toEqual([null, null, null]);
    expect((await db.select({ id: tnvedAssignments.id }).from(tnvedAssignments)).length).toBe(memoryBefore);
  });

  it('the model’s own failure comes back in its own word', async () => {
    override.actor = ved();
    model.fail = 'ai_failed';
    expect(await press('M', lineId.M2)).toMatchObject({ ok: false, error: 'ai_failed' });
    model.fail = 'ai_not_configured';
    expect(await press('M', lineId.M2)).toMatchObject({ ok: false, error: 'ai_not_configured' });
    model.fail = null;
  });
});

/**
 * 0144 (docs/TARKIB-TAKLIFLAR.md §2): the press is COUNTED before it spends
 * and BILLED after. The ledger's pressed rows of this file's lots are read
 * back by lot id — the day's count belongs to every file on this database.
 */
describe('the 🤖 on a tarkib line — counted before, billed after', () => {
  const billed = async (lotKey: keyof typeof lot) =>
    (await db.execute(sql`
      SELECT outcome, input_tokens, output_tokens, staff_id::text AS staff_id, batch_id::text AS batch_id
        FROM ai_calc_passes WHERE kind = 'tnved' AND lot_id = ${lot[lotKey]}::uuid ORDER BY created_at
    `)) as unknown as { outcome: string; input_tokens: number; output_tokens: number; staff_id: string; batch_id: string }[];
  const countedToday = async () =>
    Number(
      (
        (await db.execute(sql`
          SELECT count(*)::int AS n FROM ai_calc_passes
           WHERE kind = 'tnved' AND outcome IS DISTINCT FROM 'no_answer'
             AND created_at >= date_trunc('day', now() AT TIME ZONE 'Asia/Tashkent') AT TIME ZONE 'Asia/Tashkent'
        `)) as unknown as { n: number }[]
      )[0]!.n,
    );
  let limitBefore: unknown;

  it('(setup) the day’s limit as this file found it', async () => {
    limitBefore = await getSetting('tnved_ai_daily_limit');
    // The presses of the tests above are this file's too; the block below counts from none.
    for (const lotId of Object.values(lot)) {
      await db.execute(sql`DELETE FROM ai_calc_passes WHERE kind = 'tnved' AND lot_id = ${lotId}::uuid`);
    }
  });

  it('a press that reached the model is ONE bill line with its tokens — this lot, this truck, the presser', async () => {
    override.actor = ved();
    model.usage = { model: 'm-test', inputTokens: 1200, outputTokens: 340 };
    const answer = await press('S', lineId.S);
    model.usage = null;
    expect(answer.ok).toBe(true);
    expect(await billed('S')).toEqual([
      { outcome: 'ok', input_tokens: 1200, output_tokens: 340, staff_id: author, batch_id: truck },
    ]);
    // The count rides back with the answer; a VED reads no dollars.
    expect(answer.today).toMatchObject({ usd: null, usd30: null });
    expect(answer.today!.used).toBe(await countedToday());
    // …and the browser gets a suggestion, never the token counts.
    expect(answer.suggestion).not.toHaveProperty('usage');
  });

  it('an answer that was no good was still paid for: «failed», with its tokens, and it counts', async () => {
    override.actor = ved();
    const before = await countedToday();
    model.fail = 'ai_failed';
    model.failUsage = { model: 'm-test', inputTokens: 900, outputTokens: 16000 };
    expect(await press('M', lineId.M1)).toMatchObject({ ok: false, error: 'ai_failed' });
    model.fail = null;
    model.failUsage = null;
    expect(await billed('M')).toEqual([
      { outcome: 'failed', input_tokens: 900, output_tokens: 16000, staff_id: author, batch_id: truck },
    ]);
    expect(await countedToday()).toBe(before + 1);
  });

  it('no answer at all — a dead key, a dead network — is written down and NOT counted against the day', async () => {
    override.actor = ved();
    const before = await countedToday();
    model.fail = 'ai_failed';
    expect(await press('M', lineId.M2)).toMatchObject({ ok: false, error: 'ai_failed' });
    model.fail = null;
    expect((await billed('M')).map((row) => row.outcome)).toEqual(['failed', 'no_answer']);
    expect(await countedToday()).toBe(before);
  });

  it('…but OUR deadline running out after the request was sent IS counted: the provider had been working, and an uncounted timeout can be pressed for ever', async () => {
    override.actor = ved();
    const before = await countedToday();
    model.fail = 'ai_failed';
    model.timedOut = true;
    try {
      expect(await press('M', lineId.M2)).toMatchObject({ ok: false, error: 'ai_failed' });
    } finally {
      model.fail = null;
      model.timedOut = false;
    }
    const rows = await billed('M');
    expect(rows.map((row) => row.outcome)).toEqual(['failed', 'no_answer', 'failed']);
    // No usage came back: the row carries no tokens — and still spends one of the day's.
    expect([Number(rows.at(-1)!.input_tokens), Number(rows.at(-1)!.output_tokens)]).toEqual([0, 0]);
    expect(await countedToday()).toBe(before + 1);
  });

  it('a door that refuses writes no bill line', async () => {
    override.actor = ved({ permissions: new Set(['receipts.edit']) });
    const before = (await billed('M')).length;
    expect(await press('M', lineId.M1)).toEqual({ ok: false, error: 'forbidden' });
    expect((await billed('M')).length).toBe(before);
  });

  it('a server with no key says so before the ledger: nothing counted', async () => {
    override.actor = ved();
    const before = (await billed('M')).length;
    model.key = false;
    try {
      expect(await press('M', lineId.M1)).toEqual({ ok: false, error: 'ai_not_configured' });
    } finally {
      model.key = true;
    }
    expect(model.asked).toEqual([]);
    expect((await billed('M')).length).toBe(before);
  });

  it('the day’s limit: at the limit the press is refused in its own word — the model unasked, the photograph unread', async () => {
    override.actor = ved();
    await setSetting('tnved_ai_daily_limit', await countedToday(), author);
    const before = (await billed('S')).length;
    const refused = await press('S', lineId.S);
    expect(refused).toMatchObject({ ok: false, error: 'ai_limit' });
    expect(refused.today).toMatchObject({ used: await countedToday(), limit: await countedToday() });
    expect(model.asked).toEqual([]);
    expect((await billed('S')).length).toBe(before);
    // One more allowed: exactly one press goes through, the next is refused.
    await setSetting('tnved_ai_daily_limit', (await countedToday()) + 1, author);
    expect((await press('S', lineId.S)).ok).toBe(true);
    expect(await press('S', lineId.S)).toMatchObject({ ok: false, error: 'ai_limit' });
  });

  it('a limit of 0 is «switched off», and says so', async () => {
    override.actor = ved();
    await setSetting('tnved_ai_daily_limit', 0, author);
    expect(await press('S', lineId.S)).toMatchObject({ ok: false, error: 'ai_off' });
    expect(model.asked).toEqual([]);
  });

  it('(teardown) the limit goes back as it was', async () => {
    await setSetting('tnved_ai_daily_limit', limitBefore as number, author);
    expect(await getSetting('tnved_ai_daily_limit')).toBe(limitBefore);
  });
});

describe('the 🤖 on a tarkib line — every door before any spend', () => {
  it('a person with neither permission is refused', async () => {
    override.actor = ved({ permissions: new Set(['receipts.edit', 'finance.view']) });
    expect(await press('M', lineId.M1)).toEqual({ ok: false, error: 'forbidden' });
    expect(model.asked).toEqual([]);
  });

  it('forged ids are «forbidden» in words — never a 22P02 error page', async () => {
    override.actor = ved();
    for (const [b, l, ln] of [
      ['not-a-truck', lot.M, lineId.M1],
      [truck, 'x', lineId.M1],
      [truck, lot.M, '1 OR 1=1'],
    ] as const) {
      model.asked.length = 0;
      expect(await suggestTnvedForLineAction(b, l, ln)).toEqual({ ok: false, error: 'forbidden' });
      expect(model.asked).toEqual([]);
    }
  });

  it('the truck’s card door: a scoped holder standing at neither end, and a truck that is not there', async () => {
    // Standing where the prixod was RECEIVED: the composition's own door
    // would let this person through, so only the truck's door refuses here.
    override.actor = ved({ warehouseScoped: true, warehouseIds: [wh.RCV] });
    expect(await press('M', lineId.M1)).toEqual({ ok: false, error: 'forbidden' });
    expect(model.asked).toEqual([]);
    // …and the same person at one END of the trip is answered.
    override.actor = ved({ warehouseScoped: true, warehouseIds: [wh.RCV, wh.UZ] });
    expect(await press('M', lineId.M1)).toMatchObject({ ok: true });
    override.actor = ved();
    expect(await press('M', lineId.M1, NOWHERE)).toEqual({ ok: false, error: 'forbidden' });
    expect(model.asked).toEqual([]);
  });

  it('a lot that does not ride the truck — its tarkib and its line are real, and the model is still never asked', async () => {
    override.actor = ved();
    expect(await press('OFF', lineId.OFF)).toEqual({ ok: false, error: 'forbidden' });
    expect(model.asked).toEqual([]);
  });

  it('a lot with no tarkib, and a line id the tarkib no longer holds, are «composition_changed»', async () => {
    override.actor = ved();
    expect(await press('P', lineId.M1)).toEqual({ ok: false, error: 'composition_changed' });
    expect(model.asked).toEqual([]);
    // A real line — of ANOTHER lot: an id is the line's, never a position.
    expect(await press('M', lineId.S)).toEqual({ ok: false, error: 'composition_changed' });
    expect(await press('M', randomUUID())).toEqual({ ok: false, error: 'composition_changed' });
    expect(model.asked).toEqual([]);
  });

  it('a prixod that is no longer confirmed: the save would refuse, so the model is not paid', async () => {
    override.actor = ved();
    await db.update(receipts).set({ status: 'voided' }).where(eq(receipts.id, receiptId));
    try {
      expect(await press('M', lineId.M1)).toEqual({ ok: false, error: 'receipt_not_confirmed' });
      expect(model.asked).toEqual([]);
    } finally {
      await db.update(receipts).set({ status: 'confirmed' }).where(eq(receipts.id, receiptId));
    }
  });

  it('a ticked truck prints its frozen copy — «frozen», and nothing is asked', async () => {
    override.actor = ved();
    await db.insert(batchSentCompositions).values({
      batchId: truck,
      lotId: lot.M,
      rev: 1,
      seenBoxCount: 4,
      lines: [
        { seq: 1, name: `Мышь ${SFX}`, pieces: 900, cartons: 3, kg: '75.000', m3: '0.7500', tnvedCode: null },
        { seq: 2, name: `Коврик ${SFX}`, pieces: null, cartons: 1, kg: '25.000', m3: '0.2500', tnvedCode: null },
      ],
      segments: null,
    });
    try {
      expect(await press('M', lineId.M1)).toEqual({ ok: false, error: 'frozen' });
      expect(model.asked).toEqual([]);
      // …while a lot of the same truck that was NOT frozen still answers.
      expect(await press('S', lineId.S)).toMatchObject({ ok: true });
    } finally {
      await db.delete(batchSentCompositions).where(eq(batchSentCompositions.batchId, truck));
    }
  });
});

describe('«Saqlash»: one refusal does not stop the rest (the review of the built round)', () => {
  const revOf = async (lotKey: keyof typeof lot) =>
    (await batchTnvedProducts(truck, true)).find((r) => r.line?.lotId === lot[lotKey])!.line!.rev;
  const codesOf = async (lotKey: keyof typeof lot) =>
    (
      await db
        .select({ seq: lotCompositionLines.seq, code: lotCompositionLines.tnvedCode })
        .from(lotCompositionLines)
        .where(eq(lotCompositionLines.lotId, lot[lotKey]))
        .orderBy(lotCompositionLines.seq)
    ).map((r) => r.code);

  it('a lot whose tarkib moved under the screen is refused and NAMED — the lots after it are saved', async () => {
    // Lot M is posted FIRST with a dead revision (its tarkib was re-saved on
    // the prixod card), lot S after it with a live one. The action used to
    // return at M: S was never attempted, however often «Saqlash» was
    // pressed, and the only way on the screen offered was a reload that
    // dropped S's code.
    override.actor = ved();
    const answer = await saveLineCodesAction(truck, [
      { lotId: lot.M, lineId: lineId.M1, rev: 0, code: '8471607000' },
      { lotId: lot.S, lineId: lineId.S, rev: await revOf('S'), code: '8471300000' },
    ]);
    expect(answer).toMatchObject({ ok: false, error: 'composition_changed', refused: [lot.M], saved: 1 });
    expect(Object.keys(answer.revs)).toEqual([lot.S]);
    expect(await codesOf('S')).toEqual(['8471300000']);
    expect(await codesOf('M')).toEqual([null, null]);
    // …and the revision that came back is the one the next press must carry.
    expect(answer.revs[lot.S]).toBe(await revOf('S'));
    await db.update(lotCompositionLines).set({ tnvedCode: null }).where(eq(lotCompositionLines.lotId, lot.S));
  });

  it('a wrong code is all-or-nothing: every code is read before the first write', async () => {
    // The loop writes row by row, so an invalid code at row two used to
    // leave row one in the memory while the screen was told nothing was saved.
    override.actor = ved();
    expect(
      await saveTnvedAction(truck, [
        { nameZh: ZH.P, nameRu: null, code: '9405100000', source: 'manual' },
        { nameZh: ZH.P, nameRu: null, code: '12', source: 'manual' },
      ]),
    ).toEqual({ ok: false, error: 'invalid_code' });
    expect((await db.select({ id: tnvedAssignments.id }).from(tnvedAssignments)).length).toBe(memoryBefore);
  });

  it('a name that is no longer a product row of the truck is never written — and no longer refuses the names that are', async () => {
    // A colleague composed a lot meanwhile: its product row is a tarkib's
    // lines now. That one name used to refuse every other code on the screen.
    override.actor = ved();
    const stranger = `不在${SFX}`;
    const answer = await saveTnvedAction(truck, [
      { nameZh: stranger, nameRu: null, code: '9405100000', source: 'manual' },
      { nameZh: ZH.P, nameRu: null, code: '9405100000', source: 'ai', aiReasoning: 'test' },
      // A tarkib LINE's name is not a product row either: its code never reaches the memory.
      { nameZh: `Мышь ${SFX}`, nameRu: null, code: '8471607000', source: 'manual' },
    ]);
    expect(answer).toEqual({ ok: false, saved: 1, error: 'not_on_truck', gone: [stranger, `Мышь ${SFX}`] });
    const keys = [ZH.P, stranger, `Мышь ${SFX}`].map(productKey);
    const stored = await db.select({ key: tnvedAssignments.productKey, code: tnvedAssignments.tnvedCode }).from(tnvedAssignments).where(inArray(tnvedAssignments.productKey, keys));
    expect(stored).toEqual([{ key: productKey(ZH.P), code: '9405100000' }]);
    await db.delete(tnvedAssignments).where(inArray(tnvedAssignments.productKey, keys));
  });
});

describe('cleanup', () => {
  it('leaves nothing of this file behind', async () => {
    override.actor = null;
    for (const key of photoKeys) await getStorage().delete(key).catch(() => {});
    const lotIds = Object.values(lot);
    // The 🤖's bill lines of this file's lots (they name the author, who stays).
    for (const lotId of lotIds) await db.execute(sql`DELETE FROM ai_calc_passes WHERE kind = 'tnved' AND lot_id = ${lotId}::uuid`);
    await db.delete(attachments).where(inArray(attachments.entityId, lotIds));
    await db.delete(lotCompositions).where(inArray(lotCompositions.lotId, lotIds));
    await db.delete(boxMovements).where(inArray(boxMovements.boxId, boxIds));
    await db.delete(boxes).where(inArray(boxes.id, boxIds));
    await db.delete(receiptLots).where(inArray(receiptLots.id, lotIds));
    const [{ clientId }] = (await db.select({ clientId: receipts.clientId }).from(receipts).where(eq(receipts.id, receiptId))) as [
      { clientId: string },
    ];
    await db.delete(receipts).where(inArray(receipts.id, [receiptId, offReceiptId]));
    await db.delete(batches).where(eq(batches.id, truck));
    await db.delete(clients).where(eq(clients.id, clientId));
    // DEACTIVATED, never deleted: the line-code save above wrote an audit row
    // that names the prixod's warehouse, and audit_log keeps what it names.
    await db.update(warehouses).set({ active: false }).where(inArray(warehouses.id, Object.values(wh)));
    expect(await db.query.batches.findFirst({ where: eq(batches.id, truck) })).toBeUndefined();
    expect((await db.select({ id: tnvedAssignments.id }).from(tnvedAssignments)).length).toBe(memoryBefore);
  });
});
