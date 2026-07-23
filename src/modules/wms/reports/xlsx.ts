import ExcelJS from 'exceljs';
import {
  batchRegister,
  landedCostByClient,
  landedCostByLot,
  stockAging,
} from './queries';

/** §13 report XLSX builders — same queries as the report pages. */

function sheetSetup(workbook: ExcelJS.Workbook, name: string, title: string) {
  const sheet = workbook.addWorksheet(name);
  sheet.addRow([title]);
  sheet.getRow(1).font = { bold: true, size: 13, name: 'Arial' };
  sheet.addRow([]);
  return sheet;
}

export async function buildLandedCostXlsx(clientId?: string): Promise<Buffer> {
  const workbook = new ExcelJS.Workbook();
  const stamp = new Date().toISOString().slice(0, 10);

  if (clientId) {
    const lots = await landedCostByLot(clientId);
    const sheet = sheetSetup(workbook, 'Landed cost', `Себестоимость по лотам · ${stamp}`);
    const head = sheet.addRow(['Лот', 'Товар', 'Коробок', 'кг', 'Себестоимость $', '$ / коробка']);
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
      'ИТОГО', '',
      lots.reduce((a, l) => a + l.boxCount, 0),
      Math.round(lots.reduce((a, l) => a + l.kg, 0) * 10) / 10,
      Math.round(lots.reduce((a, l) => a + l.totalUsd, 0) * 100) / 100,
      '',
    ]);
    total.font = { bold: true };
  } else {
    const rows = await landedCostByClient();
    const sheet = sheetSetup(workbook, 'Landed cost', `Себестоимость по клиентам · ${stamp}`);
    const head = sheet.addRow(['Клиент', 'Название', 'Коробок', 'Себестоимость $']);
    head.font = { bold: true };
    sheet.columns = [{ width: 12 }, { width: 36 }, { width: 10 }, { width: 16 }];
    for (const row of rows) {
      sheet.addRow([row.clientCode, row.clientName, row.boxCount, row.totalUsd]);
    }
    const total = sheet.addRow([
      'ИТОГО', '',
      rows.reduce((a, r) => a + r.boxCount, 0),
      Math.round(rows.reduce((a, r) => a + r.totalUsd, 0) * 100) / 100,
    ]);
    total.font = { bold: true };
  }
  return Buffer.from(await workbook.xlsx.writeBuffer());
}

export async function buildStockAgingXlsx(warehouseIds?: string[]): Promise<Buffer> {
  const rows = await stockAging(warehouseIds);
  const workbook = new ExcelJS.Workbook();
  const sheet = sheetSetup(
    workbook,
    'Stock',
    `Остатки со сроком хранения · ${new Date().toISOString().slice(0, 10)}`,
  );
  const head = sheet.addRow(['Склад', 'Код', 'Товар', 'Коробок', 'кг', 'м³', 'кг/м³', 'Дней на складе']);
  head.font = { bold: true };
  sheet.columns = [
    { width: 8 }, { width: 12 }, { width: 44 }, { width: 10 },
    { width: 10 }, { width: 8 }, { width: 8 }, { width: 14 },
  ];
  for (const row of rows) {
    sheet.addRow([row.whCode, row.code, row.product, row.boxCount, row.kg, row.m3, row.density ?? '', row.days]);
  }
  const total = sheet.addRow([
    'ИТОГО', '', '',
    rows.reduce((a, r) => a + r.boxCount, 0),
    Math.round(rows.reduce((a, r) => a + r.kg, 0) * 10) / 10,
    Math.round(rows.reduce((a, r) => a + r.m3, 0) * 100) / 100,
    '', '',
  ]);
  total.font = { bold: true };
  return Buffer.from(await workbook.xlsx.writeBuffer());
}

export async function buildBatchRegisterXlsx(warehouseIds?: string[]): Promise<Buffer> {
  const rows = await batchRegister(warehouseIds);
  const workbook = new ExcelJS.Workbook();
  const sheet = sheetSetup(
    workbook,
    'Batches',
    `Реестр партий · ${new Date().toISOString().slice(0, 10)}`,
  );
  const head = sheet.addRow([
    'Партия', 'Маршрут', 'Статус', 'Создана', 'Отправлена',
    'Загружено', 'Недогруз', 'Добавлено', 'кг', 'м³', 'Расходы $', '$/кг', '$/м³',
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

export async function buildReceiptsJournalXlsx(days: number, warehouseIds?: string[]): Promise<Buffer> {
  const { receiptsJournal } = await import('./queries');
  const rows = await receiptsJournal(days, warehouseIds);
  const workbook = new ExcelJS.Workbook();
  const sheet = sheetSetup(workbook, 'Receipts', `Журнал приёмок (${days} дн.) · ${new Date().toISOString().slice(0, 10)}`);
  const head = sheet.addRow(['Номер', 'Дата', 'Склад', 'Клиент', 'Оператор', 'Лотов', 'Коробок', 'кг', 'м³', 'Статус']);
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

export async function buildUnclaimedXlsx(warehouseIds?: string[]): Promise<Buffer> {
  const { unclaimedReport } = await import('./queries');
  const rows = await unclaimedReport(warehouseIds);
  const workbook = new ExcelJS.Workbook();
  const sheet = sheetSetup(workbook, 'Unclaimed', `Грузы без владельца · ${new Date().toISOString().slice(0, 10)}`);
  const head = sheet.addRow(['Номер', 'Маркировка', 'Склад', 'Дата', 'Дней', 'Коробок', 'кг']);
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

export async function buildClientHistoryXlsx(clientId: string): Promise<Buffer> {
  const { clientHistory } = await import('./queries');
  const rows = await clientHistory(clientId);
  const workbook = new ExcelJS.Workbook();
  const sheet = sheetSetup(workbook, 'History', `История грузов клиента · ${new Date().toISOString().slice(0, 10)}`);
  const head = sheet.addRow(['Лот', 'Товар', 'Принят', 'Склад', 'Партии', 'Кор.', 'На складе', 'В пути', 'Готово', 'Выдано', 'Потеряно/анн.']);
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

export async function buildStaffActivityXlsx(days: number): Promise<Buffer> {
  const { staffActivity } = await import('./queries');
  const rows = await staffActivity(days);
  const workbook = new ExcelJS.Workbook();
  const sheet = sheetSetup(workbook, 'Staff', `Активность сотрудников (${days} дн.) · ${new Date().toISOString().slice(0, 10)}`);
  const head = sheet.addRow(['Дата', 'Сотрудник', 'Приёмки', 'Правки', 'Печать этикеток', 'Сканы', 'Экспорты']);
  head.font = { bold: true };
  sheet.columns = [
    { width: 12 }, { width: 24 }, { width: 10 }, { width: 10 }, { width: 14 }, { width: 10 }, { width: 10 },
  ];
  for (const row of rows) {
    sheet.addRow([row.day, row.name, row.receipts, row.edits, row.prints, row.scans, row.exports]);
  }
  return Buffer.from(await workbook.xlsx.writeBuffer());
}

export async function buildLabelPrintLogXlsx(days: number): Promise<Buffer> {
  const { labelPrintLog } = await import('./queries');
  const rows = await labelPrintLog(days);
  const workbook = new ExcelJS.Workbook();
  const sheet = sheetSetup(workbook, 'Labels', `Журнал печати этикеток (${days} дн.) · ${new Date().toISOString().slice(0, 10)}`);
  const head = sheet.addRow(['Когда', 'Кто', 'Приёмка', 'Этикеток']);
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

export async function buildInTransitXlsx(warehouseIds?: string[]): Promise<Buffer> {
  const { inTransitBatches } = await import('./queries');
  const rows = await inTransitBatches(warehouseIds);
  const workbook = new ExcelJS.Workbook();
  const sheet = sheetSetup(workbook, 'In transit', `Грузы в пути · ${new Date().toISOString().slice(0, 10)}`);
  const head = sheet.addRow(['Партия', 'Маршрут', 'Отправлена', 'Коробок']);
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
