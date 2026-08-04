import { NextResponse } from 'next/server';
import ExcelJS from 'exceljs';
import { eq } from 'drizzle-orm';
import { db } from '@/modules/platform/db/client';
import { deals } from '@/modules/platform/db/schema';
import { getActor } from '@/modules/platform/rbac/authorize';
import { canWriteDeal } from '@/modules/wms/deals/service';
import { parseGoods, type Cell } from '@/modules/wms/deals/goods-import';
import {
  TnvedError,
  productKey,
  proposeGoodsGrouping,
  tnvedFor,
  type TnvedGrouping,
} from '@/modules/wms/tnved/service';

/**
 * The 50-goods file lands here (a route handler, not a server action — the
 * action body cap is 1 MB, #291). Parse only: nothing is written until the
 * VED manager confirms the reviewed lines through the ordinary save.
 */

const MAX_FILE_BYTES = 5 * 1024 * 1024;

/** ExcelJS cell values arrive as strings, numbers, dates, formulas, rich text… */
function cellValue(value: ExcelJS.CellValue): Cell {
  if (value === null || value === undefined) return null;
  if (typeof value === 'string' || typeof value === 'number') return value;
  if (value instanceof Date) return value.toISOString().slice(0, 10);
  if (typeof value === 'object') {
    if ('richText' in value) return value.richText.map((r) => r.text).join('');
    if ('result' in value) return cellValue(value.result as ExcelJS.CellValue);
    if ('text' in value) return String(value.text);
  }
  return String(value);
}

export async function POST(request: Request, { params }: { params: Promise<{ id: string }> }) {
  const actor = await getActor();
  if (!actor || !canWriteDeal(actor.permissions)) {
    return NextResponse.json({ error: 'forbidden' }, { status: 403 });
  }
  const { id } = await params;
  const deal = await db.query.deals.findFirst({ where: eq(deals.id, id) });
  if (!deal) return NextResponse.json({ error: 'not_found' }, { status: 404 });

  const form = await request.formData();
  const file = form.get('file');
  if (!(file instanceof File)) return NextResponse.json({ error: 'no_file' }, { status: 400 });
  if (file.size > MAX_FILE_BYTES) {
    return NextResponse.json({ error: 'too_large' }, { status: 413 });
  }

  const workbook = new ExcelJS.Workbook();
  try {
    await workbook.xlsx.load(await file.arrayBuffer());
  } catch {
    // Content decides, not the file name (the driver-APK lesson, #284).
    return NextResponse.json({ error: 'not_xlsx' }, { status: 400 });
  }
  const sheet = workbook.worksheets[0];
  if (!sheet) return NextResponse.json({ error: 'no_goods' }, { status: 400 });

  const rows: Cell[][] = [];
  sheet.eachRow({ includeEmpty: true }, (row) => {
    const values: Cell[] = [];
    // row.values is 1-based with a hole at 0.
    for (let c = 1; c <= row.cellCount; c++) values.push(cellValue(row.getCell(c).value));
    rows.push(values);
  });

  const { goods } = parseGoods(rows);
  if (goods.length === 0) return NextResponse.json({ error: 'no_goods' }, { status: 400 });

  // Memory first (Phase 1.5): a product the book already knows never goes
  // back to the AI with an empty code.
  const known = await tnvedFor(goods.map((g) => g.description));
  for (const good of goods) {
    good.tnvedCode = known.get(productKey(good.description))?.tnvedCode ?? null;
  }

  let groups: TnvedGrouping['groups'] | null = null;
  let aiError: string | null = null;
  try {
    groups = (await proposeGoodsGrouping(
      goods.map((g) => ({ name: g.description, quantity: g.quantity, unit: g.unit })),
    )).groups;
  } catch (err) {
    // DEALS.md answer 6c: without the key (or on any AI failure) the file
    // still parses and the grouping is manual.
    aiError = err instanceof TnvedError ? err.code : 'ai_failed';
  }

  return NextResponse.json({ goods, groups, aiError });
}
