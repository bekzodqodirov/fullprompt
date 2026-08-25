import { DOC } from './labels';
import { asc, eq, inArray } from 'drizzle-orm';
import fontkit from '@pdf-lib/fontkit';
import { PDFDocument, rgb } from 'pdf-lib';
import { db } from '../../platform/db/client';
import {
  clients,
  handovers,
  receiptLots,
  scanEvents,
  boxes,
  warehouses,
} from '../../platform/db/schema';
import { getSetting } from '../../platform/settings/service';
import { cjkSubsetFor, pdfTextCleaner } from '../labels/cjk-font';

/** Handover act PDF (spec 6.7, optional per issue): who took what, signatures. */
export async function buildHandoverAct(handoverId: string): Promise<Uint8Array | null> {
  const handover = await db.query.handovers.findFirst({ where: eq(handovers.id, handoverId) });
  if (!handover) return null;
  const [client, wh] = await Promise.all([
    handover.clientId
      ? db.query.clients.findFirst({ where: eq(clients.id, handover.clientId) })
      : null,
    db.query.warehouses.findFirst({ where: eq(warehouses.id, handover.warehouseId) }),
  ]);
  const scans = await db
    .select({ boxId: scanEvents.boxId })
    .from(scanEvents)
    .where(eq(scanEvents.handoverId, handoverId));
  const boxRows = scans.length
    ? await db
        .select({ box: boxes, letter: receiptLots.letter, productNameZh: receiptLots.productNameZh, productNameRu: receiptLots.productNameRu })
        .from(boxes)
        .innerJoin(receiptLots, eq(boxes.lotId, receiptLots.id))
        .where(inArray(boxes.id, scans.map((s) => s.boxId)))
        .orderBy(asc(receiptLots.letter), asc(boxes.seqInLot))
    : [];

  const doc = await PDFDocument.create();
  doc.registerFontkit(fontkit);
  // HarfBuzz-subsetted (fontkit's subsetter drops CJK glyphs — see cjk-font.ts).
  const cjkBytes = await cjkSubsetFor([
    String(await getSetting('company_name')),
    handover.personName,
    handover.note ?? '',
    client?.name ?? '',
    ...boxRows.flatMap((r) => [r.productNameZh, r.productNameRu ?? '']),
  ]);
  const font = await doc.embedFont(cjkBytes, { subset: false });
  // Everything drawn goes through the cleaner first. This font has NO glyph
  // for any of ў Ў қ Қ ғ Ғ ҳ Ҳ (measured), so a customer or a receiver whose
  // name is written in Uzbek Cyrillic signed an act with their own name
  // printed as blanks — silently, since `.notdef` raises nothing.
  const clean = await pdfTextCleaner();

  // Mutable on purpose: `line` and the signature block must draw on whichever
  // page is current, so a new page swaps the binding they close over.
  let page = doc.addPage([595, 842]); // A4 portrait, pt
  const black = rgb(0, 0, 0);
  let y = 800;
  const newPage = () => {
    page = doc.addPage([595, 842]);
    y = 800;
  };
  // Everything drawn goes through `drawable` first. This font has NO glyph
  // for any of ў Ў қ Қ ғ Ғ ҳ Ҳ (measured), so a customer or a receiver whose
  // name is written in Uzbek Cyrillic signed an act with their own name
  // printed as blanks — silently, since `.notdef` raises nothing.
  const line = (text: string, size = 11, indent = 50) => {
    page.drawText(clean(text), { x: indent, y, size, font, color: black });
    y -= size + 7;
  };

  line(String(await getSetting('company_name')), 16);
  line(DOC.handoverTitle, 12);
  y -= 6;
  line(`Дата: ${handover.createdAt.toISOString().slice(0, 10)}    Склад: ${wh?.code ?? ''}`);
  line(`Клиент: ${client ? `${client.clientCode} — ${client.name}` : '—'}`);
  line(`Получил: ${handover.personName}   тел: ${handover.personPhone}`);
  if (handover.note) line(`Примечание: ${handover.note}`);
  y -= 8;
  line(`Передано коробок: ${boxRows.length}`, 12);
  y -= 4;
  // Every box, every act. This loop used to stop at one page's worth (~33
  // rows) and silently drop the rest — a 50-box handover printed 33 rows and
  // both sides signed an incomplete list. 137 = the 120pt signature floor
  // plus one 17pt row, so a row never invades the signature zone.
  for (const row of boxRows) {
    if (y < 137) newPage();
    line(
      `${row.box.shortCode}   ${client?.clientCode ?? ''}-${row.letter ?? ''}   ${row.productNameZh}${row.productNameRu ? ` (${row.productNameRu})` : ''}`,
      10,
      60,
    );
  }

  if (y < 120) newPage();
  y = Math.min(y, 110);
  page.drawText(DOC.handedBy, { x: 50, y, size: 11, font, color: black });
  page.drawText(DOC.receivedBy, { x: 330, y, size: 11, font, color: black });

  return doc.save();
}
