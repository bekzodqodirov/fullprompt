import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';

/**
 * On the screen a LOADER reads, the carton's OUTSIDE comes first.
 *
 * The owner, at a truck (2026-09-14): «yuklash jarayonida skladchi nimalarni
 * yuklashi kerakligini qaraganda tovarlarni rasimi korinyabti — skladchi
 * yuklash payitida karobkani ichini kormaydiku, shu payitda tovarni tashqa
 * rasimi turishi kerak unga». He sent the screenshot: the batch card's
 * «Tarkibi» table, three rows, every thumbnail a picture of toys lying inside
 * an opened carton.
 *
 * Both ids have been selected by that query since the table shipped — the
 * receipt's general box photo was merely the FALLBACK. So the fix is the
 * order, and the order is the whole fact: nothing about behaviour can see it,
 * both versions render a photograph, and a later edit that "tidies" the
 * ternary back would be invisible in every screenshot. Hence a source-shape
 * fence, like card-facts and chat-controls, for the same reason.
 *
 * The direction is per SCREEN and not global, which is why this file names
 * both sides: /stock and the receipt card answer «what is inside», and there
 * the goods photo stays first. Reversing either is the defect.
 */

const read = (path: string) => readFileSync(path, 'utf8');

const BATCH_CARD = 'src/app/(protected)/batches/[id]/page.tsx';
const STOCK = 'src/app/(protected)/stock/page.tsx';

/** Where the ternary's two branches sit, in source order. */
function order(src: string): { general: number; goods: number } {
  return {
    general: src.indexOf('lot.generalPhotoId ? ('),
    goods: src.indexOf('lot.photoId ? ('),
  };
}

describe('the loading surface shows the carton, not its contents', () => {
  it('the batch card asks for the general box photo BEFORE the goods photo', () => {
    const src = read(BATCH_CARD);
    const { general, goods } = order(src);
    // #494: prove the scan found both branches before trusting their order.
    expect(general, `${BATCH_CARD} no longer renders lot.generalPhotoId`).toBeGreaterThan(-1);
    expect(goods, `${BATCH_CARD} no longer renders lot.photoId`).toBeGreaterThan(-1);
    expect(
      general,
      'the loader must see the outside of the carton first — the goods photo is the fallback',
    ).toBeLessThan(goods);
  });

  it('the batch card still selects both, so the fallback is real', () => {
    const src = read(BATCH_CARD);
    expect(src).toContain("a.entity_type = 'receipt_lot'");
    expect(src).toContain("a.entity_type = 'receipt'");
  });

  it('/stock keeps the opposite order — that screen answers «what is inside»', () => {
    const src = read(STOCK);
    // /stock names its row `row.line`, not `lot` — the first version of this
    // fence asserted `lot.photoId` here and went red on its own guard (#494).
    const general = src.indexOf('row.line.generalPhotoId');
    const goods = src.indexOf('row.line.photoId ? (');
    expect(general).toBeGreaterThan(-1);
    expect(goods).toBeGreaterThan(-1);
    expect(
      goods,
      '/stock is the inventory screen, not a loading list: the goods photo leads there',
    ).toBeLessThan(general);
  });
});
