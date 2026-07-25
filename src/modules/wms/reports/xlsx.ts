import ExcelJS from 'exceljs';
import {
  batchRegister,
  landedCostByClient,
  landedCostByLot,
  stockAging,
} from './queries';
import { reportLabels } from './labels';

/**
 * §13 report XLSX builders — same queries as the report pages.
 *
 * Every builder takes the reader's locale: these files are downloaded to be
 * read, so their headers follow the same language as the screens (the customs
 * documents deliberately stay bilingual instead — see documents/).
 */

function sheetSetup(workbook: ExcelJS.Workbook, name: string, title: string) {
  const sheet = workbook.addWorksheet(name);
  sheet.addRow([title]);
  sheet.getRow(1).font = { bold: true, size: 13, name: 'Arial' };
  sheet.addRow([]);
  return sheet;
}

export async function buildLandedCostXlsx(clientId?: string, locale?: string): Promise<Buffer> {
  const L = reportLabels(locale);
  const workbook = new ExcelJS.Workbook();
  const stamp = new Date().toISOString().slice(0, 10);

  if (clientId) {
    const lots = await landedCostByLot(clientId);
    const sheet = sheetSetup(workbook, 'Landed cost', `${L.tLandedCostByLot} · ${stamp}`);
    const head = sheet.addRow([L.lot, L.product, L.boxes, L.kg, L.landedCostUsd, L.usdPerBox]);
    head.font = { bold: true };
    sheet.columns = [
      { width: 8 }, { width: 44 }, { width: 10 }, { width: 10 }, { width: 16 }, { width: 12 },
    ];
    for (const lot of lots) {
      sheet.addRow([
        lot.letter ?? '',
        `${lot.productNameZh}${lot.productNameRu ? ` (${lot.productNameRu})` : ''}`,
        lot.boxCount,
        lot.kg,
        lot.totalUsd,
        lot.usdPerBox,
      ]);
    }
    const total = sheet.addRow([
      L.total, '',
      lots.reduce((a, l) => a + l.boxCount, 0),
      Math.round(lots.reduce((a, l) => a + l.kg, 0) * 10) / 10,
      Math.round(lots.reduce((a, l) => a + l.totalUsd, 0) * 100) / 100,
      '',
    ]);
    total.font = { bold: true };
  } else {
    const rows = await landedCostByClient();
    const sheet = sheetSetup(workbook, 'Landed cost', `${L.tLandedCostByClient} · ${stamp}`);
    const head = sheet.addRow([L.client, L.name, L.boxes, L.landedCostUsd]);
    head.font = { bold: true };
    sheet.columns = [{ width: 12 }, { width: 36 }, { width: 10 }, { width: 16 }];
    for (const row of rows) {
      sheet.addRow([row.clientCode, row.clientName, row.boxCount, row.totalUsd]);
    }
    const total = sheet.addRow([
      L.total, '',
      rows.reduce((a, r) => a + r.boxCount, 0),
      Math.round(rows.reduce((a, r) => a + r.totalUsd, 0) * 100) / 100,
    ]);
    total.font = { bold: true };
  }
  return Buffer.from(await workbook.xlsx.writeBuffer());
}

export async function buildStockAgingXlsx(warehouseIds?: string[], locale?: string): Promise<Buffer> {
  const L = reportLabels(locale);
  const rows = await stockAging(warehouseIds);
  const workbook = new ExcelJS.Workbook();
  const sheet = sheetSetup(
    workbook,
    'Stock',
    `${L.tStockAging} · ${new Date().toISOString().slice(0, 10)}`,
  );
  const head = sheet.addRow([L.warehouse, L.code, L.product, L.boxes, L.kg, L.m3, L.density, L.daysInStock]);
  head.font = { bold: true };
  sheet.columns = [
    { width: 8 }, { width: 12 }, { width: 44 }, { width: 10 },
    { width: 10 }, { width: 8 }, { width: 8 }, { width: 14 },
  ];
  for (const row of rows) {
    sheet.addRow([row.whCode, row.code, row.product, row.boxCount, row.kg, row.m3, row.density ?? '', row.days]);
  }
  const total = sheet.addRow([
    L.total, '', '',
    rows.reduce((a, r) => a + r.boxCount, 0),
    Math.round(rows.reduce((a, r) => a + r.kg, 0) * 10) / 10,
    Math.round(rows.reduce((a, r) => a + r.m3, 0) * 100) / 100,
    '', '',
  ]);
  total.font = { bold: true };
  return Buffer.from(await workbook.xlsx.writeBuffer());
}

export async function buildBatchRegisterXlsx(warehouseIds?: string[], locale?: string): Promise<Buffer> {
  const L = reportLabels(locale);
  const rows = await batchRegister(warehouseIds);
  const workbook = new ExcelJS.Workbook();
  const sheet = sheetSetup(
    workbook,
    'Batches',
    `${L.tBatchRegister} · ${new Date().toISOString().slice(0, 10)}`,
  );
  const head = sheet.addRow([
    L.batch, L.route, L.status, L.created, L.departed,
    L.loaded, L.shortLoaded, L.added, L.kg, L.m3, L.costsUsd, L.usdPerKg, L.usdPerM3,
  ]);
  head.font = { bold: true };
  sheet.columns = [
    { width: 12 }, { width: 12 }, { width: 12 }, { width: 12 }, { width: 12 },
    { width: 10 }, { width: 10 }, { width: 10 }, { width: 10 }, { width: 8 },
    { width: 12 }, { width: 8 }, { width: 8 },
  ];
  for (const row of rows) {
    sheet.addRow([
      row.code,
      row.route,
      row.status,
      row.createdAt.toISOString().slice(0, 10),
      row.departedAt ? row.departedAt.toISOString().slice(0, 10) : '',
      row.loaded,
      row.short,
      row.added,
      row.kg,
      row.m3,
      row.costUsd,
      row.usdPerKg ?? '',
      row.usdPerM3 ?? '',
    ]);
  }
  return Buffer.from(await workbook.xlsx.writeBuffer());
}

export async function buildReceiptsJournalXlsx(days: number, warehouseIds?: string[], locale?: string): Promise<Buffer> {
  const L = reportLabels(locale);
  const { receiptsJournal } = await import('./queries');
  const rows = await receiptsJournal(days, warehouseIds);
  const workbook = new ExcelJS.Workbook();
  const sheet = sheetSetup(workbook, 'Receipts', `${L.tReceiptsJournal} (${days} ${L.daysSuffix}) · ${new Date().toISOString().slice(0, 10)}`);
  const head = sheet.addRow([L.number, L.date, L.warehouse, L.client, L.operator, L.lots, L.boxes, L.kg, L.m3, L.status]);
  head.font = { bold: true };
  sheet.columns = [
    { width: 20 }, { width: 12 }, { width: 8 }, { width: 12 }, { width: 20 },
    { width: 8 }, { width: 10 }, { width: 10 }, { width: 8 }, { width: 12 },
  ];
  for (const row of rows) {
    sheet.addRow([
      row.number, row.receivedAt.toISOString().slice(0, 10), row.whCode,
      row.clientCode ?? row.marking ?? '?', row.operator ?? '', row.lots,
      row.boxCount, row.kg, row.m3, row.status,
    ]);
  }
  return Buffer.from(await workbook.xlsx.writeBuffer());
}

export async function buildUnclaimedXlsx(warehouseIds?: string[], locale?: string): Promise<Buffer> {
  const L = reportLabels(locale);
  const { unclaimedReport } = await import('./queries');
  const rows = await unclaimedReport(warehouseIds);
  const workbook = new ExcelJS.Workbook();
  const sheet = sheetSetup(workbook, 'Unclaimed', `${L.tUnclaimed} · ${new Date().toISOString().slice(0, 10)}`);
  const head = sheet.addRow([L.number, L.marking, L.warehouse, L.date, L.days, L.boxes, L.kg]);
  head.font = { bold: true };
  sheet.columns = [
    { width: 20 }, { width: 14 }, { width: 8 }, { width: 12 }, { width: 8 }, { width: 10 }, { width: 10 },
  ];
  for (const row of rows) {
    sheet.addRow([
      row.number, row.marking ?? '', row.whCode, row.receivedAt.toISOString().slice(0, 10),
      row.days, row.boxesInStock, row.kg,
    ]);
  }
  return Buffer.from(await workbook.xlsx.writeBuffer());
}

export async function buildClientHistoryXlsx(clientId: string, locale?: string): Promise<Buffer> {
  const L = reportLabels(locale);
  const { clientHistory } = await import('./queries');
  const rows = await clientHistory(clientId);
  const workbook = new ExcelJS.Workbook();
  const sheet = sheetSetup(workbook, 'History', `${L.tClientHistory} · ${new Date().toISOString().slice(0, 10)}`);
  const head = sheet.addRow([L.lot, L.product, L.receivedAt, L.warehouse, L.batches, L.boxesShort, L.inStock, L.inTransit, L.ready, L.issued, L.lostVoid]);
  head.font = { bold: true };
  sheet.columns = [
    { width: 8 }, { width: 40 }, { width: 12 }, { width: 8 }, { width: 18 },
    { width: 8 }, { width: 10 }, { width: 8 }, { width: 8 }, { width: 8 }, { width: 12 },
  ];
  for (const row of rows) {
    sheet.addRow([
      row.letter ?? '', `${row.productNameZh}${row.productNameRu ? ` (${row.productNameRu})` : ''}`,
      row.receivedAt.toISOString().slice(0, 10), row.whCode, row.batchCodes ?? '',
      row.boxCount, row.inStock, row.inTransit, row.ready, row.issued, row.lostVoid,
    ]);
  }
  return Buffer.from(await workbook.xlsx.writeBuffer());
}

export async function buildStaffActivityXlsx(days: number, locale?: string): Promise<Buffer> {
  const L = reportLabels(locale);
  const { staffActivity } = await import('./queries');
  const rows = await staffActivity(days);
  const workbook = new ExcelJS.Workbook();
  const sheet = sheetSetup(workbook, 'Staff', `${L.tStaffActivity} (${days} ${L.daysSuffix}) · ${new Date().toISOString().slice(0, 10)}`);
  const head = sheet.addRow([L.date, L.employee, L.receipts, L.edits, L.labelPrints, L.scans, L.exports]);
  head.font = { bold: true };
  sheet.columns = [
    { width: 12 }, { width: 24 }, { width: 10 }, { width: 10 }, { width: 14 }, { width: 10 }, { width: 10 },
  ];
  for (const row of rows) {
    sheet.addRow([row.day, row.name, row.receipts, row.edits, row.prints, row.scans, row.exports]);
  }
  return Buffer.from(await workbook.xlsx.writeBuffer());
}

export async function buildLabelPrintLogXlsx(days: number, locale?: string): Promise<Buffer> {
  const L = reportLabels(locale);
  const { labelPrintLog } = await import('./queries');
  const rows = await labelPrintLog(days);
  const workbook = new ExcelJS.Workbook();
  const sheet = sheetSetup(workbook, 'Labels', `${L.tLabelPrintLog} (${days} ${L.daysSuffix}) · ${new Date().toISOString().slice(0, 10)}`);
  const head = sheet.addRow([L.when, L.who, L.receipt, L.labelsCount]);
  head.font = { bold: true };
  sheet.columns = [{ width: 18 }, { width: 24 }, { width: 20 }, { width: 10 }];
  for (const row of rows) {
    sheet.addRow([
      row.at.toISOString().slice(0, 16).replace('T', ' '),
      row.name, row.receiptNumber ?? row.receiptId, row.count ?? '',
    ]);
  }
  return Buffer.from(await workbook.xlsx.writeBuffer());
}

export async function buildInTransitXlsx(warehouseIds?: string[], locale?: string): Promise<Buffer> {
  const L = reportLabels(locale);
  const { inTransitBatches } = await import('./queries');
  const rows = await inTransitBatches(warehouseIds);
  const workbook = new ExcelJS.Workbook();
  const sheet = sheetSetup(workbook, 'In transit', `${L.tInTransit} · ${new Date().toISOString().slice(0, 10)}`);
  const head = sheet.addRow([L.batch, L.route, L.departed, L.boxes]);
  head.font = { bold: true };
  sheet.columns = [{ width: 12 }, { width: 14 }, { width: 12 }, { width: 10 }];
  for (const row of rows) {
    sheet.addRow([
      row.code, `${row.originCode} → ${row.destCode}`,
      row.departedAt ? row.departedAt.toISOString().slice(0, 10) : '', row.boxCount,
    ]);
  }
  return Buffer.from(await workbook.xlsx.writeBuffer());
}
