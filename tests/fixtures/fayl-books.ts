import ExcelJS from 'exceljs';

/**
 * Workbooks as a Yiwu/Guangzhou factory office writes them (docs/FAYL-OQISH.md
 * §4.7) — rewritten from the diagnosis' scratch builders (wf_edbf4e25-bff,
 * `zz-repro-xlsxN-books`, `zz-repro-known-goods`, `zz-repro-skxN02-split`),
 * which lived in a worktree on an older base. The commercial invoice and the
 * packing list carry a title block, a bilingual header, a TOTAL row and a
 * footer, because those are what a reader trips on.
 */
export const GOODS = [
  { no: 1, item: 'LJ-2023', zh: '女士夹克', en: 'Ladies jacket', pcsCtn: 20, ctns: 15, nw: 9.5, gw: 10.5, cbm: 0.12, price: 6.5, hs: '6202930000' },
  { no: 2, item: 'MJ-1108', zh: '男士夹克', en: 'Mens jacket', pcsCtn: 20, ctns: 12, nw: 10.2, gw: 11.2, cbm: 0.13, price: 7.2, hs: '6201930000' },
  { no: 3, item: 'KP-55', zh: '儿童裤子', en: 'Kids pants', pcsCtn: 50, ctns: 8, nw: 12, gw: 13, cbm: 0.09, price: 2.1, hs: '6203420000' },
  { no: 4, item: 'BG-301', zh: '女士手提包', en: 'Ladies handbag PU', pcsCtn: 30, ctns: 10, nw: 8, gw: 9, cbm: 0.15, price: 3.8, hs: '4202220000' },
  { no: 5, item: 'SH-7788', zh: '运动鞋', en: 'Sports shoes 39-44#', pcsCtn: 12, ctns: 25, nw: 9.6, gw: 10.8, cbm: 0.1, price: 8.5, hs: '6404110000' },
  { no: 6, item: 'CP-12', zh: '棒球帽', en: 'Baseball cap', pcsCtn: 200, ctns: 4, nw: 14, gw: 15, cbm: 0.2, price: 0.8, hs: '6505009000' },
  { no: 7, item: 'TW-5070', zh: '毛巾', en: 'Cotton towel 50*70cm', pcsCtn: 100, ctns: 6, nw: 18, gw: 19, cbm: 0.08, price: 1.2, hs: '6302600000' },
  { no: 8, item: 'LED-50W', zh: 'LED投光灯', en: 'LED flood light 50W', pcsCtn: 10, ctns: 20, nw: 11, gw: 12.5, cbm: 0.06, price: 9.9, hs: '9405420000' },
  { no: 9, item: 'PB-10000', zh: '充电宝', en: 'Power bank 10000mAh', pcsCtn: 100, ctns: 5, nw: 22, gw: 23.5, cbm: 0.07, price: 4.6, hs: '8507600000' },
  { no: 10, item: 'CB-1M', zh: '数据线', en: 'USB cable 1m', pcsCtn: 500, ctns: 3, nw: 16, gw: 17, cbm: 0.05, price: 0.35, hs: '8544429000' },
  { no: 11, item: 'MG-350', zh: '陶瓷杯', en: 'Ceramic mug 350ml', pcsCtn: 48, ctns: 10, nw: 15, gw: 16.8, cbm: 0.09, price: 0.9, hs: '6912001000' },
  { no: 12, item: 'TOY-RC8', zh: '遥控车', en: 'RC car toy', pcsCtn: 24, ctns: 9, nw: 7.2, gw: 8.4, cbm: 0.18, price: 5.5, hs: '9503009000' },
];
export type Good = (typeof GOODS)[number];

export const r2 = (n: number) => Math.round(n * 100) / 100;
export const pcs = (g: Good) => g.pcsCtn * g.ctns;
/** The shipment's own sums, as a packing list's TOTAL row states them. */
export const sums = (rows: readonly Good[]) => ({
  pcs: rows.reduce((n, g) => n + pcs(g), 0),
  kg: r2(rows.reduce((n, g) => n + g.gw * g.ctns, 0)),
  m3: r2(rows.reduce((n, g) => n + g.cbm * g.ctns, 0)),
});

/** The title block a factory office writes above both sheets. */
function titles(ws: ExcelJS.Worksheet, doc: string, cols: number) {
  const last = String.fromCharCode(64 + cols);
  ws.addRow(['YIWU XINGHUA IMPORT & EXPORT CO., LTD 义乌兴华进出口有限公司']);
  ws.mergeCells(`A1:${last}1`);
  ws.addRow(['ADD: NO. 188 CHOUZHOU NORTH ROAD, YIWU, ZHEJIANG, CHINA  TEL: +86-579-85551234']);
  ws.mergeCells(`A2:${last}2`);
  ws.addRow([doc]);
  ws.mergeCells(`A3:${last}3`);
  ws.addRow(['TO: GSR LOGISTICS, TASHKENT, UZBEKISTAN', null, null, null, null, 'INVOICE NO.:', 'XH20261028']);
  ws.addRow(['SHIPPING MARK: GS777', null, null, null, null, 'DATE:', '2026-10-28']);
  ws.addRow([]);
}

/**
 * The packing list: bilingual 中英 headers over TWO rows, «G.W.(KG)» and
 * «N.W.(KG)» merged over «PER CTN | TOTAL», PCS/CTN + TOTAL PCS, a TOTAL row
 * and a footer.
 */
export function packingSheet(ws: ExcelJS.Worksheet, rows: readonly Good[]) {
  titles(ws, '装箱单 PACKING LIST', 12);
  const h1 = ws.addRow([
    '序号\nNO.', '唛头\nMARKS', '货号\nITEM NO.', '品名\nDESCRIPTION', '每箱数量\nPCS/CTN', '箱数\nCTNS', '总数量\nTOTAL PCS',
    '净重(KG)\nN.W.(KG)', null, '毛重(KG)\nG.W.(KG)', null, '体积\nCBM',
  ]);
  const h2 = ws.addRow([null, null, null, null, null, null, null, 'PER CTN', 'TOTAL', 'PER CTN', 'TOTAL', null]);
  for (const col of ['A', 'B', 'C', 'D', 'E', 'F', 'G', 'L']) ws.mergeCells(`${col}${h1.number}:${col}${h2.number}`);
  ws.mergeCells(`H${h1.number}:I${h1.number}`);
  ws.mergeCells(`J${h1.number}:K${h1.number}`);
  const first = ws.rowCount + 1;
  rows.forEach((g, i) => {
    ws.addRow([g.no, i === 0 ? 'GS777' : null, g.item, `${g.zh} ${g.en}`, g.pcsCtn, g.ctns, pcs(g), g.nw, r2(g.nw * g.ctns), g.gw, r2(g.gw * g.ctns), r2(g.cbm * g.ctns)]);
  });
  ws.mergeCells(`B${first}:B${ws.rowCount}`);
  const t = sums(rows);
  ws.addRow([]);
  ws.addRow(['TOTAL 合计', null, null, null, null, rows.reduce((n, g) => n + g.ctns, 0), t.pcs, null, r2(rows.reduce((n, g) => n + g.nw * g.ctns, 0)), null, t.kg, t.m3]);
  ws.addRow([]);
  ws.addRow([`SAY TOTAL: ${rows.reduce((n, g) => n + g.ctns, 0)} CARTONS ONLY`]);
  ws.addRow(['MADE IN CHINA']);
}

/** The commercial invoice: title block, bilingual one-row header, TOTAL, SAY US DOLLARS. */
export function invoiceSheet(ws: ExcelJS.Worksheet, rows: readonly Good[]) {
  titles(ws, '商业发票 COMMERCIAL INVOICE', 8);
  ws.addRow(['序号 NO.', '货号 ITEM NO.', '品名 DESCRIPTION OF GOODS', '海关编码 HS CODE', '数量 QUANTITY', '单位 UNIT', '单价 UNIT PRICE (USD)', '金额 AMOUNT (USD)']);
  let sum = 0;
  for (const g of rows) {
    const amount = r2(pcs(g) * g.price);
    sum += amount;
    ws.addRow([g.no, g.item, `${g.zh} ${g.en}`, g.hs, pcs(g), 'PCS', g.price, amount]);
  }
  ws.addRow(['TOTAL', null, null, null, rows.reduce((n, g) => n + pcs(g), 0), null, null, r2(sum)]);
  ws.addRow([`SAY US DOLLARS ${r2(sum)} ONLY`]);
}

/** R1's invoice: English names, the pieces, the money. */
export function englishInvoice(ws: ExcelJS.Worksheet, rows: readonly Good[] = GOODS) {
  ws.addRow(['COMMERCIAL INVOICE']);
  ws.addRow(['Description', 'Quantity', 'Unit price (USD)', 'Amount (USD)']);
  for (const g of rows) ws.addRow([g.en, pcs(g), g.price, r2(pcs(g) * g.price)]);
}

/** R1's packing list: Chinese names only, cartons and gross — no piece column, nothing in common with the invoice. */
export function chinesePacking(ws: ExcelJS.Worksheet, rows: readonly Good[] = GOODS, opts: { net?: boolean } = {}) {
  ws.addRow(['装箱单']);
  ws.addRow(opts.net ? ['品名', '箱数', '净重', '毛重', '体积'] : ['品名', '箱数', '毛重', '体积']);
  for (const g of rows) {
    ws.addRow(opts.net ? [g.zh, g.ctns, r2(g.nw * g.ctns), r2(g.gw * g.ctns), r2(g.cbm * g.ctns)] : [g.zh, g.ctns, r2(g.gw * g.ctns), r2(g.cbm * g.ctns)]);
  }
}

/** A plain one-row-header list, as a small office writes it. */
export function plainSheet(ws: ExcelJS.Worksheet, header: (string | null)[], rows: (string | number | null)[][]) {
  ws.addRow(header);
  for (const r of rows) ws.addRow(r);
}

export async function bookOf(build: (wb: ExcelJS.Workbook) => void): Promise<Buffer> {
  const wb = new ExcelJS.Workbook();
  build(wb);
  return Buffer.from(await wb.xlsx.writeBuffer());
}

/** A workbook of plain sheets, each `[name, header, rows]`. */
export function sheetsBook(sheets: [string, (string | null)[], (string | number | null)[][]][]): Promise<Buffer> {
  return bookOf((wb) => {
    for (const [name, header, rows] of sheets) plainSheet(wb.addWorksheet(name), header, rows);
  });
}

/** One sheet of an invoice per factory (or per category): «1 dona fileda ko‘p tovarlar». */
export type Row = { name: string; pcs: number; nw: number; gw: number; cbm: number; price: number };
export const INVOICE_HEAD = ['No.', 'Description', 'Quantity (pcs)', 'Unit price (USD)', 'Amount (USD)', 'N.W. (kg)', 'G.W. (kg)', 'CBM'];
export const invoiceRows = (rows: readonly Row[]) => rows.map((r, i) => [i + 1, r.name, r.pcs, r.price, r2(r.pcs * r.price), r.nw, r.gw, r.cbm]);

export const A_KURTKA: Row = { name: 'Куртка женская', pcs: 300, nw: 150, gw: 165, cbm: 1.8, price: 6.5 };
export const A_SHIM: Row = { name: 'Брюки мужские', pcs: 200, nw: 80, gw: 88, cbm: 0.72, price: 4.2 };
export const A_SUMKA: Row = { name: 'Сумка женская PU', pcs: 300, nw: 80, gw: 90, cbm: 1.5, price: 3.8 };
export const B_KROSS: Row = { name: 'Кроссовки мужские', pcs: 120, nw: 96, gw: 104, cbm: 1.1, price: 8.5 };
export const B_KEPKA: Row = { name: 'Кепка бейсболка', pcs: 800, nw: 56, gw: 60, cbm: 0.8, price: 0.8 };

/** K10: «Zavod A» and «Zavod B», one invoice sheet each. */
export function twoFactoryBook(a: readonly Row[], b: readonly Row[], names: [string, string] = ['Zavod A', 'Zavod B']): Promise<Buffer> {
  return sheetsBook([
    [names[0], INVOICE_HEAD, invoiceRows(a)],
    [names[1], INVOICE_HEAD, invoiceRows(b)],
  ]);
}

export const XLSX = 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet';
