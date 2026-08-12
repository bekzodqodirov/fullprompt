import { describe, expect, it } from 'vitest';
import {
  BOARD_MIN_GAP,
  BOARD_SPACING,
  compareBoardOrder,
  slotBetween,
} from '@/modules/wms/crm/board-order';

/**
 * The arithmetic behind the owner's «qaysi ketma ketlikda qoysa usha saqlanib
 * qoladgan qilsa boladimi» (round 96).
 *
 * Pure and tested here because two things read it and they must agree: the
 * service that writes the number, and the board in the browser that has to
 * show the card in its new place before Uzbekistan answers.
 */

describe('where a dropped card lands', () => {
  it('takes the midpoint between its two new neighbours', () => {
    expect(slotBetween(1000, 2000)).toBe(1500);
    expect(slotBetween(1500, 2000)).toBe(1750);
  });

  it('goes ABOVE everything when dropped at the top of a column', () => {
    expect(slotBetween(null, 1000)).toBe(1000 - BOARD_SPACING);
    // …including a column whose top card is already at a negative number,
    // which is what months of «move to won» arriving at the top produces.
    expect(slotBetween(null, -4000)).toBe(-4000 - BOARD_SPACING);
  });

  it('goes below everything when dropped at the end', () => {
    expect(slotBetween(9000, null)).toBe(9000 + BOARD_SPACING);
  });

  it('starts an empty column somewhere it can still be split on both sides', () => {
    expect(slotBetween(null, null)).toBe(BOARD_SPACING);
  });

  it('asks for a renumber when the gap can no longer be split', () => {
    // Dropping between the same two cards over and over halves the gap each
    // time. A double runs out of digits at about the fiftieth, and the last
    // few produce a number EQUAL to its neighbour — at which point the order
    // has silently stopped being an order.
    expect(slotBetween(1000, 1000 + BOARD_MIN_GAP / 2)).toBe('renumber');
    expect(slotBetween(1000, 1000)).toBe('renumber');
  });

  it('survives the fifty drops that get it there', () => {
    // The realistic worst case, played out: always drop onto the same seam.
    const low = 0;
    let high = BOARD_SPACING;
    let splits = 0;
    for (;;) {
      const slot = slotBetween(low, high);
      if (slot === 'renumber') break;
      expect(slot).toBeGreaterThan(low);
      expect(slot).toBeLessThan(high);
      high = slot;
      splits += 1;
      expect(splits).toBeLessThan(100);
    }
    // Far more than anybody does by hand, and the answer when it runs out is
    // a renumber rather than two cards claiming the same place.
    expect(splits).toBeGreaterThan(20);
  });
});

describe('an unplaced card sits at the top', () => {
  it('sorts before every numbered one', () => {
    expect(compareBoardOrder(null, 1000)).toBeLessThan(0);
    expect(compareBoardOrder(1000, null)).toBeGreaterThan(0);
    expect(compareBoardOrder(null, -9999)).toBeLessThan(0);
  });

  it('answers EQUAL for two unplaced cards, so the caller’s order survives', () => {
    // `Array.prototype.sort` is stable, so 0 here means the server's own
    // ORDER BY — tie-broken by date — is what the eye actually sees.
    expect(compareBoardOrder(null, null)).toBe(0);
    const order = ['c', 'a', 'b'];
    expect([...order].sort(() => compareBoardOrder(null, null))).toEqual(order);
  });

  it('otherwise sorts by the number, small first', () => {
    expect([3000, 1000, 2000].sort(compareBoardOrder)).toEqual([1000, 2000, 3000]);
  });
});
