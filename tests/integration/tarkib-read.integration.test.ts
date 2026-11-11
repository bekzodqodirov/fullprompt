import 'dotenv/config';
import { randomUUID } from 'node:crypto';
import ExcelJS from 'exceljs';
import sharp from 'sharp';
import { eq, inArray, sql } from 'drizzle-orm';
import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest';

/**
 * «🤖 Fayldan to'ldirish», pressed (docs/TARKIB-TAKLIFLAR.md §3) — the
 * route's own `POST`, against real rows and real bytes in storage.
 *
 * It stands in for three things and nothing else: the session's actor, the
 * key switch (CI has none) and the MODEL — the SDK's `messages.create`
 * answers whatever the test scripts and records every request. «Never
 * asked» is half of every refusal here (a reading is paid per call), and the
 * LEDGER is the other half: a door that refuses writes no bill line, a
 * reading that reached the model writes exactly one, and what it counts as
 * is decided by the code that runs in production.
 *
 * And it writes nothing else — not a composition, not the TNVED memory, not
 * an audit row: the proposal fills the editor's draft and «Saqlash» stays the
 * person's press.
 *
 * The fixture is this file's own: a confirmed prixod with TWO lots (so a
 * proposal says «2 lots») and a second prixod whose document must not be
 * readable through the first one's lot. The ledger's rows of this file's lots
 * are read back by lot id — the day's count belongs to every file on this
 * database. Cleanup is `afterAll`, guarded per id.
 */

const override = vi.hoisted(() => ({ actor: null as null | Record<string, unknown> }));
const model = vi.hoisted(() => ({
  calls: [] as { params: Record<string, unknown>; options: Record<string, unknown> }[],
  next: null as null | (() => unknown),
  key: true,
}));

vi.mock('@anthropic-ai/sdk', async (original) => {
  const real = await original<typeof import('@anthropic-ai/sdk')>();
  class Scripted extends real.default {
    constructor(opts?: ConstructorParameters<typeof real.default>[0]) {
      super({ ...opts, apiKey: 'test-key' });
      // The reading is STREAMED: `messages.stream(…).finalMessage()`.
      (this as unknown as { messages: unknown }).messages = {
        stream: (params: Record<string, unknown>, options: Record<string, unknown>) => ({
          finalMessage: async () => {
            model.calls.push({ params, options });
            return model.next!();
          },
        }),
      };
    }
  }
  return { ...real, default: Scripted };
});
vi.mock('@/modules/platform/auth/session', async (original) => ({
  ...(await original<typeof import('@/modules/platform/auth/session')>()),
  getSessionUser: async () => null,
}));
vi.mock('@/modules/platform/rbac/authorize', async (original) => {
  const real = await original<typeof import('@/modules/platform/rbac/authorize')>();
  return { ...real, getActor: async () => override.actor as Awaited<ReturnType<typeof real.getActor>> };
});
// CI has no key, and the reading asks for one BEFORE it counts the press —
// so the key is a switch here.
vi.mock('@/modules/platform/ai/model', async (original) => ({
  ...(await original<typeof import('@/modules/platform/ai/model')>()),
  aiConfigured: () => model.key,
}));

import Anthropic from '@anthropic-ai/sdk';
import { db } from '@/modules/platform/db/client';
import {
  attachments,
  auditLog,
  clients,
  lotCompositions,
  receiptLots,
  receipts,
  tnvedAssignments,
  users,
  warehouses,
} from '@/modules/platform/db/schema';
import { ANALYST_MODEL } from '@/modules/platform/ai/model';
import { getStorage } from '@/modules/platform/files/storage';
import { getSetting, setSetting } from '@/modules/platform/settings/service';
import { POST } from '@/app/api/tarkib/read/route';

/** Unique per run AND per name: the clock alone repeats inside one millisecond (#598). */
const STAMP = String(Date.now()).slice(-7);
let counter = 0;
const uniq = () => `${STAMP}${(counter += 1)}`;
const SFX = uniq();
const NOWHERE = '00000000-0000-4000-8000-00000a1a1a01';
const XLSX = 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet';
const DAY = 24 * 60 * 60 * 1000;

let author = '';
const wh = { HOME: '', ELSEWHERE: '' };
let clientId = '';
const receipt = { MAIN: '', OTHER: '' };
const lot = { A: '', B: '', OTHER: '' };
const file: Record<string, string> = {};
const storageKeys: string[] = [];
let limitBefore: unknown;
let memoryBefore = 0;

/** The VED, unscoped — the seeded ved_manager's shape. */
const ved = (over: Record<string, unknown> = {}) => ({
  id: author,
  permissions: new Set(['ved.docs']),
  roleGrants: new Map<string, ReadonlySet<string>>(),
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

async function mintFile(
  name: keyof typeof file | string,
  input: {
    entityType?: string;
    entityId: string;
    kind: 'file' | 'photo';
    fileName: string;
    contentType: string;
    body?: Buffer;
    sizeBytes?: number;
    createdAt?: Date;
  },
) {
  const storageKey = `receipt/${input.entityId}/tarkib-read-${uniq()}`;
  if (input.body) {
    await getStorage().put(storageKey, input.body, input.contentType);
    storageKeys.push(storageKey);
  }
  const [row] = await db
    .insert(attachments)
    .values({
      entityType: input.entityType ?? 'receipt',
      entityId: input.entityId,
      kind: input.kind,
      storageKey,
      fileName: input.fileName,
      contentType: input.contentType,
      sizeBytes: input.sizeBytes ?? input.body?.length ?? 0,
      uploadedBy: author,
      ...(input.createdAt ? { createdAt: input.createdAt } : {}),
    })
    .returning({ id: attachments.id });
  file[name] = row!.id;
}

async function workbook(build: (wb: ExcelJS.Workbook) => void): Promise<Buffer> {
  const wb = new ExcelJS.Workbook();
  build(wb);
  return Buffer.from(await wb.xlsx.writeBuffer());
}

beforeAll(async () => {
  author = (await db.query.users.findFirst({ where: eq(users.phone, '+998900000004') }))!.id;
  limitBefore = await getSetting('tarkib_ai_daily_limit');
  memoryBefore = (await db.select({ id: tnvedAssignments.id }).from(tnvedAssignments)).length;
  for (const key of ['HOME', 'ELSEWHERE'] as const) {
    const [w] = await db
      .insert(warehouses)
      .values({
        code: `TR${key[0]}${SFX}`.slice(0, 12),
        name: `Tarkib o'qish ${key} ${SFX}`,
        country: 'CN',
        type: 'origin',
        timezone: 'Asia/Shanghai',
        batchPrefix: `T${key[0]}${SFX}`.slice(0, 8),
      })
      .returning({ id: warehouses.id });
    wh[key] = w!.id;
  }
  clientId = (
    await db
      .insert(clients)
      .values({ clientCode: `TR${SFX}`.slice(0, 10), name: `Tarkib o'qish mijoz ${SFX}` })
      .returning({ id: clients.id })
  )[0]!.id;
  // Confirmed YESTERDAY: a file uploaded now is a paper, a photo of two days ago a carton photo.
  const yesterday = new Date(Date.now() - DAY);
  [receipt.MAIN, receipt.OTHER] = (
    await db
      .insert(receipts)
      .values(
        [1, 2].map((n) => ({
          number: `TR-${SFX}-${n}`,
          warehouseId: wh.HOME,
          clientId,
          status: 'confirmed',
          createdBy: author,
          createdAt: yesterday,
          confirmedAt: yesterday,
          confirmedBy: author,
        })),
      )
      .returning({ id: receipts.id })
  ).map((r) => r.id) as [string, string];
  const lots = await db
    .insert(receiptLots)
    .values(
      (
        [
          ['A', receipt.MAIN, 1],
          ['B', receipt.MAIN, 2],
          ['OTHER', receipt.OTHER, 1],
        ] as const
      ).map(([, receiptId, seq]) => ({
        receiptId,
        seq,
        letter: String.fromCharCode(64 + seq),
        cycleNo: 1,
        productNameZh: `键盘${SFX}`,
        productNameRu: null,
        boxCount: 100,
        dimsMode: 'mixed',
        totalWeightKg: '1000.000',
        totalVolumeM3: '2.5000',
      })),
    )
    .returning({ id: receiptLots.id });
  [lot.A, lot.B, lot.OTHER] = lots.map((l) => l.id) as [string, string, string];

  const sheet = await workbook((wb) => {
    const ws = wb.addWorksheet('Packing list');
    ws.addRow(['Наименование', 'Кол-во', 'Мест', 'Брутто', 'Объём']);
    ws.addRow(['Клавиатура', 500, 50, 600, 1.5]);
    ws.addRow(['Мышь', 1000, 50, 400, 1]);
  });
  const pdf = Buffer.from('%PDF-1.4\n% a packing list, for the test\n%%EOF\n');
  await mintFile('sheet', { entityId: receipt.MAIN, kind: 'file', fileName: 'Packing list.xlsx', contentType: XLSX, body: sheet });
  await mintFile('pdf', { entityId: receipt.MAIN, kind: 'file', fileName: 'packing.pdf', contentType: 'application/pdf', body: pdf });
  for (const name of ['pdfRefused', 'pdfCut', 'pdfGarbage', 'pdfTimeout', 'pdfDeadKey', 'pdfNoGoods', 'pdfLimit']) {
    await mintFile(name, { entityId: receipt.MAIN, kind: 'file', fileName: `${name}.pdf`, contentType: 'application/pdf', body: pdf });
  }
  const png = await sharp({ create: { width: 2400, height: 1200, channels: 3, background: '#fafafa' } }).png().toBuffer();
  // A photographed packing list, uploaded AFTER the prixod was confirmed: a paper.
  await mintFile('photo', { entityId: receipt.MAIN, kind: 'photo', fileName: 'packing.png', contentType: 'image/png', body: png });
  // The warehouse's own carton photo, taken while receiving: not a paper.
  await mintFile('carton', {
    entityId: receipt.MAIN,
    kind: 'photo',
    fileName: 'carton.jpg',
    contentType: 'image/jpeg',
    body: png,
    createdAt: new Date(Date.now() - 2 * DAY),
  });
  // Rows whose bytes storage does NOT hold: reading one would answer «file_unavailable».
  await mintFile('video', { entityId: receipt.MAIN, kind: 'file', fileName: 'pogruzka.mp4', contentType: 'video/mp4', sizeBytes: 60 * 1024 * 1024 });
  await mintFile('hugePdf', { entityId: receipt.MAIN, kind: 'file', fileName: 'scan.pdf', contentType: 'application/pdf', sizeBytes: 11 * 1024 * 1024 });
  await mintFile('gone', { entityId: receipt.MAIN, kind: 'file', fileName: 'gone.pdf', contentType: 'application/pdf', sizeBytes: 200 });
  await mintFile('empty', {
    entityId: receipt.MAIN,
    kind: 'file',
    fileName: 'empty.xlsx',
    contentType: XLSX,
    body: await workbook((wb) => void wb.addWorksheet('Sheet1')),
  });
  await mintFile('ofOther', { entityId: receipt.OTHER, kind: 'file', fileName: 'other.pdf', contentType: 'application/pdf', body: pdf });
  await mintFile('ofLot', { entityType: 'receipt_lot', entityId: lot.A, kind: 'file', fileName: 'lot.pdf', contentType: 'application/pdf', body: pdf });
});

afterAll(async () => {
  override.actor = null;
  if (author) await setSetting('tarkib_ai_daily_limit', limitBefore, author).catch(() => {});
  for (const key of storageKeys) await getStorage().delete(key).catch(() => {});
  const lotIds = Object.values(lot).filter(Boolean);
  const receiptIds = Object.values(receipt).filter(Boolean);
  const fileIds = Object.values(file).filter(Boolean);
  // The readings' bill lines of this file's lots (they name the author, who stays).
  for (const lotId of lotIds) {
    await db.execute(sql`DELETE FROM ai_calc_passes WHERE kind = 'tarkib' AND lot_id = ${lotId}::uuid`).catch(() => {});
  }
  if (fileIds.length > 0) await db.delete(attachments).where(inArray(attachments.id, fileIds)).catch(() => {});
  if (lotIds.length > 0) await db.delete(receiptLots).where(inArray(receiptLots.id, lotIds)).catch(() => {});
  if (receiptIds.length > 0) await db.delete(receipts).where(inArray(receipts.id, receiptIds)).catch(() => {});
  if (clientId) await db.delete(clients).where(eq(clients.id, clientId)).catch(() => {});
  const whIds = Object.values(wh).filter(Boolean);
  // Nothing here writes an audit row, so the warehouses can go; if a row
  // does name one, it is deactivated instead (audit_log keeps what it names).
  if (whIds.length > 0) {
    await db
      .delete(warehouses)
      .where(inArray(warehouses.id, whIds))
      .catch(() => db.update(warehouses).set({ active: false }).where(inArray(warehouses.id, whIds)));
  }
});

type Answer = {
  status: number;
  cache: string | null;
  ok: boolean;
  error?: string;
  detail?: string;
  proposal?: {
    rows: { name: string; nameRu: string | null; pieces: string; cartons: string; kg: string; m3: string; tnved: string; notes: unknown[]; unsure: string | null }[];
    weightKind: string | null;
    fileTotals: unknown;
    document: string;
    warnings: unknown[];
    notes: string | null;
    lotsOnReceipt: number;
  };
  today?: { used: number; limit: number; usd: number | null; usd30: number | null; unpriced: number | null };
};

async function press(lotId: unknown, attachmentId: unknown): Promise<Answer> {
  model.calls.length = 0;
  const res = await POST(
    new Request('http://localhost/api/tarkib/read', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ lotId, attachmentId }),
    }),
  );
  return { status: res.status, cache: res.headers.get('cache-control'), ...((await res.json()) as object) } as Answer;
}

const billed = async (lotId: string) =>
  (await db.execute(sql`
    SELECT outcome, input_tokens, output_tokens, model, staff_id::text AS staff_id, batch_id::text AS batch_id,
           (cost_usd IS NOT NULL) AS priced
      FROM ai_calc_passes WHERE kind = 'tarkib' AND lot_id = ${lotId}::uuid ORDER BY created_at
  `)) as unknown as {
    outcome: string;
    input_tokens: number;
    output_tokens: number;
    model: string;
    staff_id: string;
    batch_id: string | null;
    priced: boolean;
  }[];
/** The day's count, by the ledger's own predicate. */
const countedToday = async () =>
  Number(
    (
      (await db.execute(sql`
        SELECT count(*)::int AS n FROM ai_calc_passes
         WHERE kind = 'tarkib' AND outcome IS DISTINCT FROM 'no_answer'
           AND created_at >= date_trunc('day', now() AT TIME ZONE 'Asia/Tashkent') AT TIME ZONE 'Asia/Tashkent'
      `)) as unknown as { n: number }[]
    )[0]!.n,
  );

const ROWS = [
  { name: 'Клавиатура', name_ru: null, pieces: 500, cartons: 50, gross_kg: 600, net_kg: 550, volume_m3: 1.5, hs_code: '8471.60.7000', unsure: null },
  { name: '鼠标', name_ru: 'Мышь', pieces: 1000, cartons: 50, gross_kg: 400, net_kg: 380, volume_m3: 1, hs_code: '847160', unsure: 'вес указан на две строки' },
];
const answered = (over: Record<string, unknown> = {}, stop = 'end_turn') => ({
  stop_reason: stop,
  // The provider echoes its own spelling of the model; the ledger must not take it.
  model: 'an-echoed-spelling',
  content: [{ type: 'text', text: JSON.stringify({ rows: ROWS, totals: { cartons: 100, gross_kg: 1000, volume_m3: 2.5 }, document: 'packing_list', notes: null, ...over }) }],
  usage: { input_tokens: 2100, output_tokens: 640 },
});

describe('«🤖 Fayldan to‘ldirish» — every door before any spend', () => {
  const refused = async (lotId: unknown, attachmentId: unknown, error: string) => {
    const before = (await billed(lot.A)).length;
    const answer = await press(lotId, attachmentId);
    expect({ status: answer.status, ok: answer.ok, error: answer.error }).toEqual({ status: 200, ok: false, error });
    // Refused at a door: the model was never asked and no bill line was written.
    expect(model.calls).toEqual([]);
    expect((await billed(lot.A)).length).toBe(before);
    expect(answer.cache).toBe('private, no-store');
  };

  it('nobody signed in is a 401 — and nothing is read', async () => {
    override.actor = null;
    const answer = await press(lot.A, file.pdf);
    expect({ status: answer.status, ok: answer.ok, error: answer.error }).toEqual({ status: 401, ok: false, error: 'unauthorized' });
    expect(model.calls).toEqual([]);
    expect(await billed(lot.A)).toEqual([]);
  });

  it('forged ids are «forbidden» in words — never a 22P02 error page', async () => {
    override.actor = ved();
    await refused('not-a-lot', file.pdf, 'forbidden');
    await refused(lot.A, '1 OR 1=1', 'forbidden');
    await refused(undefined, undefined, 'forbidden');
    // A body that is not JSON at all.
    model.calls.length = 0;
    const res = await POST(new Request('http://localhost/api/tarkib/read', { method: 'POST', body: 'lotId=x' }));
    expect(await res.json()).toEqual({ ok: false, error: 'forbidden' });
  });

  it('the save’s own door: neither permission, a lot that is not there, a scoped reader standing elsewhere', async () => {
    override.actor = ved({ permissions: new Set(['receipts.edit', 'finance.view']) });
    await refused(lot.A, file.pdf, 'forbidden');
    override.actor = ved();
    await refused(randomUUID(), file.pdf, 'forbidden');
    override.actor = ved({ warehouseScoped: true, warehouseIds: [wh.ELSEWHERE] });
    await refused(lot.A, file.pdf, 'forbidden');
    // …and the same person standing where the prixod was received is let through to the next door.
    override.actor = ved({ warehouseScoped: true, warehouseIds: [wh.HOME] });
    await refused(lot.A, file.video, 'read_unsupported');
  });

  it('a prixod that is no longer confirmed: the save would refuse, so the reading is not paid for', async () => {
    override.actor = ved();
    await db.update(receipts).set({ status: 'voided' }).where(eq(receipts.id, receipt.MAIN));
    try {
      await refused(lot.A, file.pdf, 'receipt_not_confirmed');
    } finally {
      await db.update(receipts).set({ status: 'confirmed' }).where(eq(receipts.id, receipt.MAIN));
    }
  });

  it('the file must be a paper of THIS lot’s prixod — another prixod’s, a lot’s own file and an id that is not there answer alike', async () => {
    override.actor = ved();
    await refused(lot.A, file.ofOther, 'document_not_on_receipt');
    await refused(lot.A, file.ofLot, 'document_not_on_receipt');
    await refused(lot.A, randomUUID(), 'document_not_on_receipt');
    // The prixod is the LOT's: the other prixod's lot opens its own document's door.
    await refused(lot.OTHER, file.pdf, 'document_not_on_receipt');
    // A carton photo taken while receiving is not the client's paper.
    await refused(lot.A, file.carton, 'document_is_photo');
  });

  it('the kind and the size are judged from the ROW: a 60 MB video and an 11 MB PDF are refused without storage being asked', async () => {
    override.actor = ved();
    // Storage holds no bytes for either row — a read would answer «file_unavailable».
    await refused(lot.A, file.video, 'read_unsupported');
    await refused(lot.A, file.hugePdf, 'read_too_large');
  });

  it('a server with no key says so before the ledger and before the file: nothing counted, nothing read', async () => {
    override.actor = ved();
    model.key = false;
    try {
      await refused(lot.A, file.pdf, 'ai_not_configured');
      // Not even the bytes: a row whose file is gone still answers about the key.
      await refused(lot.A, file.gone, 'ai_not_configured');
    } finally {
      model.key = true;
    }
  });

  it('a file storage no longer holds, and a workbook with no cell, spend nothing', async () => {
    override.actor = ved();
    await refused(lot.A, file.gone, 'file_unavailable');
    await refused(lot.A, file.empty, 'read_empty');
  });
});

describe('a reading that reached the model — one bill line, and what it counts as', () => {
  it('(setup) this file’s lots start with no bill lines', async () => {
    expect(await billed(lot.A)).toEqual([]);
    expect(await billed(lot.B)).toEqual([]);
  });

  it('a spreadsheet: the model is sent its TEXT, the answer becomes the proposal, and the press is one «ok» row with its tokens', async () => {
    override.actor = ved();
    model.next = () => answered();
    const answer = await press(lot.A, file.sheet);
    expect(answer.status).toBe(200);
    expect(answer.ok).toBe(true);
    // What the model was shown: the house call, and the sheet as text.
    expect(model.calls).toHaveLength(1);
    const { params, options } = model.calls[0]!;
    expect(params.model).toBe(ANALYST_MODEL);
    expect(params.max_tokens).toBe(32_000);
    expect((params.output_config as { effort?: string }).effort).toBe('medium');
    const content = (params.messages as { content: { type: string; text?: string }[] }[])[0]!.content;
    expect(content.map((b) => b.type)).toEqual(['text']);
    expect(content[0]!.text).toContain(
      '[Packing list]\nНаименование | Кол-во | Мест | Брутто | Объём\nКлавиатура | 500 | 50 | 600 | 1.5\nМышь | 1000 | 50 | 400 | 1\n',
    );
    expect(content[0]!.text).toContain('Файл: Packing list.xlsx');
    expect(options.signal).toBeInstanceOf(AbortSignal);

    // The proposal: the editor's own cells, the paper's names, the prixod's lot count.
    expect(answer.proposal).toEqual({
      rows: [
        {
          name: 'Клавиатура',
          nameRu: null,
          pieces: '500',
          cartons: '50',
          kg: '600.000',
          m3: '1.5000',
          tnved: '8471607000',
          // Ten digits printed on the paper are the DOCUMENT's code — the cell says whose it is.
          notes: [{ code: 'paper_code', params: { value: '8471607000' } }],
          unsure: null,
        },
        {
          name: '鼠标',
          nameRu: 'Мышь',
          pieces: '1000',
          cartons: '50',
          kg: '400.000',
          m3: '1.0000',
          tnved: '',
          notes: [{ code: 'seller_code', params: { value: '847160' } }],
          unsure: 'вес указан на две строки',
        },
      ],
      weightKind: 'gross',
      fileTotals: { cartons: '100', kg: '1000.000', m3: '2.5000' },
      document: 'packing_list',
      warnings: [],
      notes: null,
      lotsOnReceipt: 2,
    });

    // ONE bill line: this lot, no truck, the presser, the tokens — priced as the model the call was MADE with.
    expect(await billed(lot.A)).toEqual([
      { outcome: 'ok', input_tokens: 2100, output_tokens: 640, model: ANALYST_MODEL, staff_id: author, batch_id: null, priced: true },
    ]);
    // The count rides back with the answer; a VED reads no dollars.
    expect(answer.today).toMatchObject({ used: await countedToday(), usd: null, usd30: null, unpriced: null });
  });

  it('a PDF goes whole as a document block; a photograph as a reduced JPEG', async () => {
    override.actor = ved();
    model.next = () => answered();
    expect((await press(lot.B, file.pdf)).ok).toBe(true);
    const pdfContent = (model.calls[0]!.params.messages as { content: { type: string; source?: { media_type: string; data: string } }[] }[])[0]!.content;
    expect(pdfContent.map((b) => b.type)).toEqual(['document', 'text']);
    expect(pdfContent[0]!.source!.media_type).toBe('application/pdf');
    expect(Buffer.from(pdfContent[0]!.source!.data, 'base64').toString()).toContain('%PDF-1.4');

    expect((await press(lot.B, file.photo)).ok).toBe(true);
    const photoContent = (model.calls[0]!.params.messages as { content: { type: string; source?: { media_type: string; data: string } }[] }[])[0]!.content;
    expect(photoContent.map((b) => b.type)).toEqual(['image', 'text']);
    expect(photoContent[0]!.source!.media_type).toBe('image/jpeg');
    const meta = await sharp(Buffer.from(photoContent[0]!.source!.data, 'base64')).metadata();
    expect([meta.format, meta.width, meta.height]).toEqual(['jpeg', 2000, 1000]);
    expect((await billed(lot.B)).map((row) => row.outcome)).toEqual(['ok', 'ok']);
  });

  it('a reader of the company’s money gets the dollars beside the count — nobody else does', async () => {
    override.actor = ved({ permissions: new Set(['ved.docs', 'finance.manage', 'finance.reports']) });
    model.next = () => answered();
    const answer = await press(lot.B, file.pdf);
    expect(answer.today!.usd).toBeGreaterThan(0);
    expect(answer.today!.usd30).toBeGreaterThanOrEqual(answer.today!.usd!);
    expect(answer.today!.unpriced).toBe(0);
  });

  it('a refusal, a cut-off and an unreadable answer were ANSWERED: their own words, «failed», with their tokens — and they count', async () => {
    override.actor = ved();
    for (const [name, script, error] of [
      ['pdfRefused', () => answered({}, 'refusal'), 'ai_refused'],
      ['pdfCut', () => ({ ...answered({}, 'max_tokens'), content: [{ type: 'text', text: '{"rows": [{"name": "Кла' }] }), 'ai_truncated'],
      ['pdfGarbage', () => ({ ...answered(), content: [{ type: 'text', text: 'Вот таблица товаров:' }] }), 'ai_failed'],
    ] as const) {
      const before = await countedToday();
      const rows = (await billed(lot.A)).length;
      model.next = script;
      const answer = await press(lot.A, file[name]);
      expect({ ok: answer.ok, error: answer.error }, name).toEqual({ ok: false, error });
      expect(model.calls).toHaveLength(1);
      const lines = await billed(lot.A);
      expect(lines.length, name).toBe(rows + 1);
      expect(lines.at(-1), name).toMatchObject({ outcome: 'failed', input_tokens: 2100, output_tokens: 640, priced: true });
      expect(await countedToday(), name).toBe(before + 1);
      expect(answer.today!.used).toBe(before + 1);
    }
  });

  it('a connection that never OPENED (the SDK calls it a «timeout») is not our deadline: «ai_failed», not counted, the document not cooled', async () => {
    // The T1 review, A1: counted as our timeout, a dead network spent one of the day's readings, cooled
    // the document for ten minutes and told the person «the paper may be too large».
    override.actor = ved();
    const before = await countedToday();
    model.next = () => {
      throw new Anthropic.APIConnectionTimeoutError();
    };
    expect(await press(lot.A, file.pdfTimeout)).toMatchObject({ ok: false, error: 'ai_failed' });
    expect((await billed(lot.A)).at(-1)).toMatchObject({ outcome: 'no_answer', input_tokens: 0, output_tokens: 0 });
    expect(await countedToday()).toBe(before);
    // Not cooled: the very next press reaches the model again.
    model.next = () => {
      throw new Anthropic.APIConnectionTimeoutError();
    };
    expect(await press(lot.A, file.pdfTimeout)).toMatchObject({ ok: false, error: 'ai_failed' });
    expect(model.calls).toHaveLength(1);
  });

  it('OUR deadline ran out: «ai_timeout», counted, with no tokens — whatever the abort was thrown as', async () => {
    override.actor = ved();
    const before = await countedToday();
    // The leash has run out: the reading's own signal is already aborted, and what is thrown is the bare
    // abort of a body cut in mid-arrival (the provider had answered and billed).
    const leash = vi.spyOn(AbortSignal, 'timeout').mockReturnValueOnce(AbortSignal.abort());
    model.next = () => {
      throw new DOMException('This operation was aborted', 'AbortError');
    };
    try {
      expect(await press(lot.A, file.pdfTimeout)).toMatchObject({ ok: false, error: 'ai_timeout' });
    } finally {
      leash.mockRestore();
    }
    expect((await billed(lot.A)).at(-1)).toMatchObject({ outcome: 'failed', input_tokens: 0, output_tokens: 0 });
    expect(await countedToday()).toBe(before + 1);
  });

  it('…and that document cools off: pressed again it is refused in its own word — the model unasked, nothing counted', async () => {
    override.actor = ved();
    const before = await countedToday();
    const rows = (await billed(lot.A)).length;
    model.next = () => answered();
    for (const name of ['pdfTimeout', 'pdfCut'] as const) {
      expect(await press(lot.A, file[name]), name).toMatchObject({ ok: false, error: 'cooling' });
      expect(model.calls, name).toEqual([]);
    }
    // From another lot of the same prixod too: it is the DOCUMENT that is too much.
    expect(await press(lot.B, file.pdfTimeout)).toMatchObject({ ok: false, error: 'cooling' });
    expect((await billed(lot.A)).length).toBe(rows);
    expect(await countedToday()).toBe(before);
    // A refusal or an unreadable answer does not cool a document, and another document is read as ever.
    expect((await press(lot.A, file.pdfRefused)).ok).toBe(true);
    expect((await press(lot.A, file.pdf)).ok).toBe(true);
  });

  it('a call that never ran — a dead key — is written down and NOT counted against the day', async () => {
    override.actor = ved();
    const before = await countedToday();
    model.next = () => {
      throw Anthropic.APIError.generate(401, { type: 'error', error: { type: 'authentication_error', message: 'invalid x-api-key' } }, 'invalid x-api-key', new Headers());
    };
    expect(await press(lot.A, file.pdfDeadKey)).toMatchObject({ ok: false, error: 'ai_failed' });
    expect((await billed(lot.A)).at(-1)).toMatchObject({ outcome: 'no_answer', input_tokens: 0, output_tokens: 0, priced: false });
    expect(await countedToday()).toBe(before);
    // Not cooled either: the document was never the problem.
    model.next = () => answered();
    expect((await press(lot.A, file.pdfDeadKey)).ok).toBe(true);
  });

  it('an answer with no goods is paid for and SAID — with the model’s own sentence about the paper', async () => {
    override.actor = ved();
    model.next = () => answered({ rows: [], totals: null, document: 'other', notes: 'Это счёт на оплату услуг, таблицы товаров нет.' });
    const answer = await press(lot.A, file.pdfNoGoods);
    expect(answer).toMatchObject({ ok: false, error: 'read_no_goods', detail: 'Это счёт на оплату услуг, таблицы товаров нет.' });
    expect((await billed(lot.A)).at(-1)).toMatchObject({ outcome: 'ok', input_tokens: 2100 });
  });
});

describe('the day’s limit', () => {
  it('at the limit the press is refused in its own word — the model unasked, no bill line — and one more allowed is exactly one', async () => {
    override.actor = ved();
    model.next = () => answered();
    try {
      await setSetting('tarkib_ai_daily_limit', await countedToday(), author);
      const rows = (await billed(lot.A)).length;
      const refused = await press(lot.A, file.pdfLimit);
      expect(refused).toMatchObject({ ok: false, error: 'ai_limit' });
      expect(refused.today).toMatchObject({ used: await countedToday(), limit: await countedToday() });
      expect(model.calls).toEqual([]);
      expect((await billed(lot.A)).length).toBe(rows);

      await setSetting('tarkib_ai_daily_limit', (await countedToday()) + 1, author);
      expect((await press(lot.A, file.pdfLimit)).ok).toBe(true);
      expect(await press(lot.A, file.pdfLimit)).toMatchObject({ ok: false, error: 'ai_limit' });

      // 0 is «switched off», and says so.
      await setSetting('tarkib_ai_daily_limit', 0, author);
      expect(await press(lot.A, file.pdfLimit)).toMatchObject({ ok: false, error: 'ai_off' });
      expect(model.calls).toEqual([]);
      // …BEFORE a byte is asked of storage: a row whose file is gone still answers «switched off»,
      // not «the file could not be loaded» — a press that can never run loads nothing (A14).
      expect(await press(lot.A, file.gone)).toMatchObject({ ok: false, error: 'ai_off' });
    } finally {
      await setSetting('tarkib_ai_daily_limit', limitBefore, author);
    }
    expect(await getSetting('tarkib_ai_daily_limit')).toBe(limitBefore);
  });
});

describe('it is never a writer', () => {
  it('no composition, no TNVED memory row, no audit row — only its own bill lines', async () => {
    const lotIds = Object.values(lot);
    expect(await db.select({ lotId: lotCompositions.lotId }).from(lotCompositions).where(inArray(lotCompositions.lotId, lotIds))).toEqual([]);
    expect((await db.select({ id: tnvedAssignments.id }).from(tnvedAssignments)).length).toBe(memoryBefore);
    expect(
      await db
        .select({ id: auditLog.id })
        .from(auditLog)
        .where(inArray(auditLog.entityId, [...Object.values(receipt), ...lotIds])),
    ).toEqual([]);
    // …and every reading that reached the model is one row of this file's two lots.
    const lines = [...(await billed(lot.A)), ...(await billed(lot.B))];
    expect(lines.length).toBeGreaterThan(8);
    expect(lines.every((line) => line.staff_id === author && line.batch_id === null)).toBe(true);
    expect(lines.filter((line) => line.outcome === 'reserved')).toEqual([]);
  });
});
