import { DOC, docDate } from './labels';
import { arrivalBlockLabel, arrivalsForLots, groupByArrival } from './arrivals';
import { and, asc, eq, inArray } from 'drizzle-orm';
import ExcelJS from 'exceljs';
import { db } from '../../platform/db/client';
import {
  attachments,
  clients,
  loadPlanLines,
  loadPlans,
  loadPlanVersions,
  receiptLots,
  receipts,
  warehouses,
} from '../../platform/db/schema';
import { getStorage } from '../../platform/files/storage';
import { runPooled } from '../../../components/pooled';
import { SHEET_PHOTO_PX, fitInBox, sheetPhoto, sheetPhotoKey, type SheetPhoto } from './sheet-photo';
import {
  compositionMode,
  lineIsLotGood,
  paperLinesByPart,
  planSegments,
  truckSegments,
  type PaperView,
  type StoredLine,
} from '../receipts/composition-math';
import { compositionsFor, lotTrucksFor, paperCompositionsFor } from '../receipts/lot-composition';
import {
  agentProductCell,
  ESTIMATE_FILL,
  estimateNote,
  packingBoxesCell,
  packingPiecesCell,
  wrappedLines,
} from './composition-cells';
import { planRoadReady, roadOfVersion, roadTrucksByLot } from '../planning/road';

/** The «Товар» and «Коробок» columns' widths — also what a wrapped row's height is estimated from. */
const PRODUCT_WIDTH = 40;
const BOXES_WIDTH = 10;

/**
 * Agent approval Excel (W3, spec 6.3): one row per planned line with an
 * embedded box photo — the logist sends this file to the agent outside the
 * system (owner's rule) and records the verdict manually.
 *
 * Since the owner asked for it, the sheet is also ORDERED the way the cargo
 * came in: «qaysi partiyada Qashqarga kelganini … qashqarga kelgan partiyasi
 * bo'yicha sort bo'lgan holda». A plan out of Kashgar consolidates what
 * several trucks from Yiwu and Guangzhou brought there, and the agent judging
 * the load reads it truck by truck. Blocks, not just a sorted column: the
 * rows carry embedded photographs, so the agent cannot re-sort this sheet
 * himself without tearing the pictures off the goods they belong to — the
 * grouping has to be right in the file.
 *
 * A lot with a tarkib prints ONE ROW PER GOOD (the owner, 2026-11-10 —
 * «yuklamada har bir tarkib alohida qatorlarga bo'linib chiqsin, hozirda
 * prixod 1 qator bo'lib tarkibi nomlarni ichida turibdi»;
 * docs/TARKIB-TUZATISH.md §4). It was the one paper that still printed a
 * composed lot as a single row, with its goods as text under the name.
 */
export async function buildAgentXlsx(planId: string, versionNo: number): Promise<Buffer | null> {
  const plan = await db.query.loadPlans.findFirst({ where: eq(loadPlans.id, planId) });
  if (!plan) return null;
  const version = await db.query.loadPlanVersions.findFirst({
    where: and(eq(loadPlanVersions.planId, planId), eq(loadPlanVersions.versionNo, versionNo)),
  });
  if (!version) return null;

  const [origin, dest] = await Promise.all([
    db.query.warehouses.findFirst({ where: eq(warehouses.id, plan.originWarehouseId) }),
    db.query.warehouses.findFirst({ where: eq(warehouses.id, plan.destWarehouseId) }),
  ]);

  const lines = await db
    .select({
      line: loadPlanLines,
      lot: receiptLots,
      clientCode: clients.clientCode,
      marking: receipts.unclaimedMarking,
    })
    .from(loadPlanLines)
    .innerJoin(receiptLots, eq(loadPlanLines.lotId, receiptLots.id))
    .innerJoin(receipts, eq(receiptLots.receiptId, receipts.id))
    .leftJoin(clients, eq(receipts.clientId, clients.id))
    .where(eq(loadPlanLines.versionId, version.id))
    .orderBy(asc(loadPlanLines.id));

  // ALL photos of every lot go side by side after the data columns (owner's
  // request — one photo was not enough for the agent to judge the cargo).
  const lotIds = [...new Set(lines.map((l) => l.lot.id))];
  const photoRows = lotIds.length
    ? await db
        .select()
        .from(attachments)
        .where(
          and(
            eq(attachments.entityType, 'receipt_lot'),
            inArray(attachments.entityId, lotIds),
            eq(attachments.kind, 'photo'),
          ),
        )
        .orderBy(asc(attachments.createdAt))
    : [];
  const photosByLot = new Map<string, string[]>();
  for (const att of photoRows) {
    photosByLot.set(att.entityId, [...(photosByLot.get(att.entityId) ?? []), att.id]);
  }
  const maxPhotos = Math.max(1, ...[...photosByLot.values()].map((ids) => ids.length));

  // Yo'ldagi yuk (docs/YOLDAGI-YUK.md §9): a line with a road part is TWO
  // rows — what stands here under the truck that brought it, and what is
  // still on the road under its own block — each with its own count and its
  // share of the kilos. Filed whole under an arrival, the road part would be
  // a false «arrived here» on a customs document. Before the approval the
  // road part is the promise; after, what is still owed (what has landed
  // stands here and files under its arrival like any carton). What a loading
  // ENDED without (`missed`) never came: its own block, never «received here».
  const road = await planRoadReady();
  const roadByLine = await roadOfVersion(db, road, version.id);
  const approved = version.agentVerdict === 'approved';
  type SheetRow = (typeof lines)[number];
  const share = (row: SheetRow, n: number): SheetRow => ({
    ...row,
    line: {
      ...row.line,
      plannedBoxCount: n,
      plannedKg: String(Math.round((Number(row.line.plannedKg) * n * 1000) / row.line.plannedBoxCount) / 1000),
      plannedM3: String(Math.round((Number(row.line.plannedM3) * n * 10_000) / row.line.plannedBoxCount) / 10_000),
    },
  });
  const hereRows: SheetRow[] = [];
  const roadRows: SheetRow[] = [];
  const missedRows: SheetRow[] = [];
  for (const row of lines) {
    const part = roadByLine.get(row.line.id);
    const onRoad = part ? (approved ? part.owed : part.part) : 0;
    const missed = part && approved ? part.missed : 0;
    if (onRoad <= 0 && missed <= 0) {
      hereRows.push(row);
      continue;
    }
    const here = row.line.plannedBoxCount - onRoad - missed;
    if (here > 0) hereRows.push(share(row, here));
    if (onRoad > 0) roadRows.push(share(row, onRoad));
    if (missed > 0) missedRows.push(share(row, missed));
  }
  const roadTrucks = await roadTrucksByLot(db, road, plan.originWarehouseId, [
    ...new Set(roadRows.map((r) => r.lot.id)),
  ]);

  // Which truck brought each lot to the warehouse this plan loads FROM.
  const arrivals = await arrivalsForLots(lotIds, plan.originWarehouseId);
  const blocks = [
    ...groupByArrival(hereRows, ({ lot, clientCode, marking }) => ({
      arrival: arrivals.get(lot.id),
      within: `${clientCode ?? marking ?? '?'}-${lot.letter ?? ''}`,
    })).map((block) => ({ ...block, onRoad: false })),
    ...(roadRows.length
      ? [
          {
            key: 'road',
            code: [...new Set(roadRows.flatMap((r) => roadTrucks.get(r.lot.id) ?? []))].sort().join(', '),
            source: null,
            factories: [] as string[],
            arrivedAt: null,
            rows: roadRows,
            onRoad: true,
          },
        ]
      : []),
    ...(missedRows.length
      ? [
          {
            key: 'missed',
            code: '',
            source: null,
            factories: [] as string[],
            arrivedAt: null,
            rows: missedRows,
            onRoad: false,
            notCame: true,
          },
        ]
      : []),
  ];

  const workbook = new ExcelJS.Workbook();
  const sheet = workbook.addWorksheet(`План v${versionNo}`);
  sheet.columns = [
    { header: DOC.code, key: 'code', width: 14 },
    { header: DOC.product, key: 'product', width: PRODUCT_WIDTH },
    // BEFORE the carton count, blank when unknown (his 8.5 and 7b, 2026-10-27).
    { header: DOC.pieces, key: 'pieces', width: 10 },
    { header: DOC.boxes, key: 'boxCount', width: BOXES_WIDTH },
    { header: DOC.kg, key: 'kg', width: 10 },
    { header: DOC.m3, key: 'm3', width: 10 },
    { header: DOC.density, key: 'density', width: 10 },
    // Wide enough for a factory trip's «ZR-00012 · factory · plate»: the
    // photographs anchor on their own columns (PHOTO_START_COL), so widening
    // this one moves no picture off its goods.
    { header: DOC.arrivalBatch, key: 'arrivalBatch', width: 34 },
    { header: DOC.arrivalDate, key: 'arrivedAt', width: 13 },
    ...Array.from({ length: maxPhotos }, (_, i) => ({
      header: i === 0 ? DOC.photo : '',
      key: `photo${i}`,
      width: 14,
    })),
  ];
  sheet.getRow(1).font = { bold: true };
  sheet.insertRow(1, [
    `План ${origin?.code} → ${dest?.code} · v${versionNo} · ${version.totalBoxes} кор. · ${version.totalKg} кг · ${version.totalM3} м³`,
  ]);
  sheet.getRow(1).font = { bold: true, size: 13 };
  // A long plan scrolls the column names away, and reaching the third
  // photograph scrolls the CLIENT CODE away — the one cell that says whose
  // goods the picture is of. Both are frozen.
  sheet.views = [{ state: 'frozen', xSplit: 1, ySplit: 2 }];

  // The 800-px copy, fitted into its cell (`sheet-photo.ts` — his «hira
  // korinyabti»); four at a time, as every other photo pipe here.
  const thumbs = new Map<string, SheetPhoto>();
  await runPooled(photoRows, 4, async (att) => {
    try {
      const bytes = await getStorage().get(sheetPhotoKey(att));
      thumbs.set(att.id, await sheetPhoto(bytes, SHEET_PHOTO_PX.document));
    } catch {
      /* photo unavailable — leave the cell empty */
    }
  });

  // Lot tarkibi: a composed lot's rows of ONE block (its plan lines there —
  // `load_plan_lines_version_lot_unique` is (version, lot, crate), so a lot
  // planned «81 loose + 19 in CR-12» has two) are one group of line rows, the
  // lot's three blocks cut out of the plan's positions in the sheet's own
  // order. The plan's truck reads its frozen copy once its papers are sent;
  // a plan with no truck yet reads the live compositions and comes after
  // every truck the lot already crossed on.
  const contents = await planContents(
    plan,
    { here: hereRows, road: roadRows, missed: missedRows },
    lotIds,
    origin?.country ?? '',
    dest?.country ?? '',
  );

  const PHOTO_START_COL = 9; // zero-based: right after the arrival columns
  // Every date on this sheet is the warehouse's own day, not the server's.
  const zone = origin?.timezone ?? 'UTC';
  let rowNo = 3;
  for (const block of blocks) {
    const kind: BlockKind = block.onRoad ? 'road' : 'notCame' in block ? 'missed' : 'here';
    // By LOT ID, never by adjacency or by label: a label is not unique (the
    // letter counter is per warehouse and cycles), so two lots can sort as one.
    const linesPrinted = new Set<string>();
    const totals = block.rows.reduce(
      (sum, { line }) => ({
        boxes: sum.boxes + line.plannedBoxCount,
        kg: sum.kg + Number(line.plannedKg),
        m3: sum.m3 + Number(line.plannedM3),
      }),
      { boxes: 0, kg: 0, m3: 0 },
    );
    // Deliberately NOT a merged cell. Excel refuses Sort and Filter over a
    // range holding unequally-merged rows, and the heading spills across the
    // empty cells beside it on its own — merging would buy the look it
    // already has at the price of two things the agent might want.
    const heading = sheet.getCell(rowNo, 1);
    const totalsText = `${totals.boxes} ${DOC.boxes} · ${totals.kg.toFixed(1)} кг · ${totals.m3.toFixed(3)} м³`;
    // A factory trip is a truck we hired, not a walk-in: it gets its own
    // words and names its factories (every stop the block's cargo came
    // from) and plate. «Received here» stays for what came on no truck.
    const dated = block.arrivedAt ? ` · ${docDate(block.arrivedAt, zone)}` : '';
    heading.value = block.onRoad
      ? `${DOC.onRoad}: ${block.code || '—'} · ${totalsText}`
      : 'notCame' in block
        ? `${DOC.notCame} · ${totalsText}`
        : !block.source
        ? `${DOC.receivedHere} · ${totalsText}`
        : `${block.source.kind === 'pickup' ? DOC.factoryPickup : DOC.arrivalBatch}: ${arrivalBlockLabel(block)}${dated} · ${totalsText}`;
    heading.font = { bold: true };
    heading.fill = { type: 'pattern', pattern: 'solid', fgColor: { argb: 'FFEFEFEF' } };
    rowNo += 1;

    for (const { line, lot, clientCode, marking } of block.rows) {
      const arrival = arrivals.get(lot.id);
      const code = `${clientCode ?? marking ?? '?'}-${lot.letter ?? ''}`;
      // The block names ONE truck — the earliest — so this cell is where a
      // lot that came in two halves says so, and it is the only place the
      // split is visible at all. It also survives a row being copied out of
      // the sheet or read after the heading has scrolled away, which is
      // what the owner asked to be ADDED; the blocks are the order he asked
      // for, not a substitute for it. A factory trip's cell names THIS
      // row's own stop — the heading lists every factory of the block.
      const arrivalCells = {
        arrivalBatch: block.onRoad
          ? `🚚 ${(roadTrucks.get(lot.id) ?? []).join(', ') || '—'}`
          : 'notCame' in block
            ? '—'
            : arrival?.labels.join(', ') || '—',
        arrivedAt: !block.onRoad && !('notCame' in block) && arrival ? docDate(arrival.arrivedAt, zone) : '',
      };
      const photos = (atRow: number) => {
        const photoIds = photosByLot.get(lot.id) ?? [];
        photoIds.forEach((photoId, i) => {
          const thumb = thumbs.get(photoId);
          if (!thumb) return;
          const imageId = workbook.addImage({ buffer: thumb.buffer as unknown as ExcelJS.Buffer, extension: 'jpeg' });
          sheet.addImage(imageId, {
            tl: { col: PHOTO_START_COL + i + 0.1, row: atRow - 1 + 0.1 },
            ext: fitInBox(thumb),
          });
        });
      };

      const group = contents.get(lot.id)?.[kind];
      if (group) {
        // One group of line rows per lot per block; the lot's other plan
        // rows of this block (its crated share) are already inside it.
        if (linesPrinted.has(lot.id)) continue;
        linesPrinted.add(lot.id);
        const { view, cartons, mode } = group;
        const names = { zh: lot.productNameZh, ru: lot.productNameRu };
        // The Chinese name must not vanish from the one sheet read
        // Chinese-first: when no printed line is the lot's own good, the
        // first row carries it on a second line.
        const orphan = !view.lines.some((l) => lineIsLotGood(l.name, names));
        view.lines.forEach((good, i) => {
          const product = agentProductCell(good, names, i === 0 && orphan ? lot.productNameZh : null);
          const row = sheet.getRow(rowNo);
          row.values = {
            code,
            product,
            pieces: packingPiecesCell(good),
            boxCount: packingBoxesCell(good, mode, i === 0, cartons),
            kg: good.kg,
            m3: good.m3 ?? '',
            density: good.m3 !== null && good.m3 > 0 ? Math.round(good.kg / good.m3) : '',
            ...arrivalCells,
          };
          const cell = row.getCell('product');
          const boxes = row.getCell('boxCount');
          const boxesText = typeof boxes.value === 'string' ? boxes.value : '';
          // EVERY good's row wraps and is as tall as its text. Only a first
          // row with the sticker's name under it wrapped, and the others
          // were 20 pt whatever they held — so a name with its code in
          // brackets ran past the 40-wide column and lost the END: «Мышь
          // компьютерная беспроводная [84716060», a ten-digit code read as a
          // valid eight-digit one (the review of the built round). The
          // «same cartons» sentence of an «aralash» lot sits in a 10-wide
          // column and was «(в тех же ко» for the same reason.
          row.eachCell((each) => {
            each.alignment = { ...each.alignment, vertical: 'top' };
          });
          cell.alignment = { wrapText: true, vertical: 'top' };
          if (boxesText) boxes.alignment = { wrapText: true, vertical: 'top' };
          const textLines = Math.max(
            wrappedLines(product, PRODUCT_WIDTH),
            boxesText ? wrappedLines(boxesText, BOXES_WIDTH) : 1,
          );
          if (view.estimate) {
            cell.note = estimateNote(view, cartons, lot.boxCount, 'block');
            cell.fill = ESTIMATE_FILL;
          }
          // The photographs once per block, beside the group's first good —
          // a row never shorter than a photograph, nor than its own text.
          row.height = Math.max(i === 0 ? 60 : 20, 15 * textLines);
          if (i === 0) photos(rowNo);
          rowNo += 1;
        });
        continue;
      }

      const density =
        Number(line.plannedM3) > 0
          ? Math.round(Number(line.plannedKg) / Number(line.plannedM3))
          : '';
      sheet.getRow(rowNo).values = {
        code,
        product: `${lot.productNameZh}${lot.productNameRu ? ` (${lot.productNameRu})` : ''}`,
        pieces: '',
        boxCount: line.plannedBoxCount,
        kg: Number(line.plannedKg),
        m3: Number(line.plannedM3),
        density,
        ...arrivalCells,
      };
      sheet.getRow(rowNo).height = 60;
      photos(rowNo);
      rowNo += 1;
    }
  }

  // STORED, not deflated: JPEG does not shrink under deflate, and exceljs's
  // default ran pure-JS deflate over every photograph on the one Node process
  // — 9 s of CPU at 1,200 photos for ~1 % of size (the review).
  return Buffer.from(await workbook.xlsx.writeBuffer({ zip: { compression: 'STORE' } }));
}

/** «Crosses a border», `crossesBorderSql` restated for a plan with no truck yet. */
function planCrossesBorder(originCountry: string, destCountry: string): boolean {
  const o = originCountry.trim().toUpperCase();
  return !(o !== '' && o === destCountry.trim().toUpperCase());
}

type BlockKind = 'here' | 'road' | 'missed';
/** The sheet's order of a lot's parts — and the order their positions are cut in. */
const BLOCK_KINDS: readonly BlockKind[] = ['here', 'road', 'missed'];

interface LotGroup {
  view: PaperView;
  /** The lot's cartons in THIS block. */
  cartons: number;
  mode: 'separate' | 'mixed';
}

/**
 * Each composed lot's line rows, per block of the sheet, by lot id.
 *
 * The plan's positions for the lot are taken ONCE (after every truck the lot
 * already crossed on, or the plan's own truck's) and cut consecutively into
 * the blocks — here, on the road, not come (`paperLinesByPart`): a line's
 * cartons and pieces over the blocks are then exactly what the whole plan
 * states, and each block's kg and m³ add up to that block's own rows. In the
 * sheet's own precision — three decimals of kg and four of m³, what an
 * uncomposed row prints from `planned_kg` — so a block's cells add up to its
 * heading.
 */
async function planContents(
  plan: { batchId: string | null },
  rowsByKind: Record<
    BlockKind,
    readonly {
      line: { plannedBoxCount: number; plannedKg: string; plannedM3: string };
      lot: { id: string; boxCount: number; totalWeightKg: string; totalVolumeM3: string };
    }[]
  >,
  lotIds: string[],
  originCountry: string,
  destCountry: string,
): Promise<Map<string, Partial<Record<BlockKind, LotGroup>>>> {
  const out = new Map<string, Partial<Record<BlockKind, LotGroup>>>();
  if (lotIds.length === 0) return out;
  const comps: Map<string, { seenBoxCount: number; lines: StoredLine[] }> = plan.batchId
    ? await paperCompositionsFor(plan.batchId, lotIds)
    : await compositionsFor(lotIds);
  if (comps.size === 0) return out;
  const trucks = await lotTrucksFor(db, [...comps.keys()]);
  const crosses = planCrossesBorder(originCountry, destCountry);
  type Sum = { cartons: number; kg: number; m3: number };
  const sums = new Map<string, { lot: (typeof rowsByKind)['here'][number]['lot']; parts: Record<BlockKind, Sum> }>();
  for (const kind of BLOCK_KINDS) {
    for (const { line, lot } of rowsByKind[kind]) {
      if (!comps.has(lot.id)) continue;
      const agg = sums.get(lot.id) ?? {
        lot,
        parts: { here: { cartons: 0, kg: 0, m3: 0 }, road: { cartons: 0, kg: 0, m3: 0 }, missed: { cartons: 0, kg: 0, m3: 0 } },
      };
      agg.parts[kind].cartons += line.plannedBoxCount;
      agg.parts[kind].kg += Number(line.plannedKg);
      agg.parts[kind].m3 += Number(line.plannedM3);
      sums.set(lot.id, agg);
    }
  }
  for (const [lotId, agg] of sums) {
    const comp = comps.get(lotId)!;
    const ofLot = trucks.get(lotId) ?? [];
    const total = BLOCK_KINDS.reduce((n, kind) => n + agg.parts[kind].cartons, 0);
    // The plan's truck, when it already holds (or carried) a carton of this
    // lot; else the plan's own positions — after every truck the lot has
    // crossed on. An APPROVED plan whose truck holds no carton of the lot
    // yet (every carton owed from the road, or missed) is not among the
    // lot's trucks, and `truckSegments` answers «from position 0» for a
    // truck it does not know: the file printed the lot's FIRST goods where
    // the plan takes its last cartons — «А 2, Б 1» of a lot whose first two
    // cartons had crossed earlier — and went back to «А 1, Б 1, В 1» when
    // the first carton landed. The same plan's file must not change its
    // goods at the approval (the review of the built round).
    const onTruck = plan.batchId !== null && ofLot.some((t) => t.batchId === plan.batchId);
    const segments = onTruck ? truckSegments(ofLot, plan.batchId!) : planSegments(ofLot, total, crosses);
    const views = paperLinesByPart(
      comp,
      { boxCount: agg.lot.boxCount, kg: agg.lot.totalWeightKg, m3: agg.lot.totalVolumeM3 },
      {
        segments,
        parts: BLOCK_KINDS.map((kind) => ({
          cartons: agg.parts[kind].cartons,
          kg: Math.round(agg.parts[kind].kg * 1000) / 1000,
          m3: Math.round(agg.parts[kind].m3 * 10_000) / 10_000,
        })),
      },
      { kgDecimals: 3, m3Decimals: 4 },
    );
    const mode = compositionMode(comp.lines) === 'separate' ? 'separate' : 'mixed';
    const groups: Partial<Record<BlockKind, LotGroup>> = {};
    BLOCK_KINDS.forEach((kind, i) => {
      const view = views[i];
      if (view) groups[kind] = { view, cartons: agg.parts[kind].cartons, mode };
    });
    out.set(lotId, groups);
  }
  return out;
}
