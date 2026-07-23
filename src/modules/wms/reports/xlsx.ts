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
