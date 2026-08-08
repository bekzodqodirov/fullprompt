import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';
import ru from '../../messages/ru.json';

/**
 * Two rules about the board that no other test can see.
 *
 * The first is the owner's, twice stated: a card is dragged with a MOUSE and
 * with nothing else. That was not true — which board a viewer gets is decided
 * by viewport width alone (`md`, 768 px), and the desktop board's drag armed a
 * 250 ms hold for every pointer that was not a mouse. A tablet in portrait is
 * 768 px, so it got hold-to-drag: the gesture refused in round 14 and again in
 * the batch-4 agreement.
 *
 * The second follows from the first. Take the drag away from a finger and the
 * desktop board has NO way left to move a card, because the move controls live
 * in the phone view. So the desktop card carries the ⋯ too.
 *
 * Source-shape assertions, like `chat-controls.test.ts` and
 * `style-cascade.test.ts`: what is being pinned is not a value a function
 * returns, it is which lines exist — and both defects were adjacency, not
 * logic. Everything else about the board is exercised by m8 in a real browser.
 */

const SOURCE = readFileSync('src/components/kanban.tsx', 'utf8');
// The refusal map moved out of the board in round 76 so the LEAD CARD's stage
// fold could share it without dragging DragBoard into that bundle. The rule
// did not move — this file still pins it, just one door further along.
const ERRORS = readFileSync('src/components/move-errors.ts', 'utf8');
const CARD_MOVER = readFileSync('src/app/(protected)/crm/leads/[id]/stage-mover.tsx', 'utf8');

describe('a card is dragged with a mouse, and with nothing else', () => {
  it('refuses any pointer that is not a mouse, in both handlers', () => {
    const guards = SOURCE.match(/if \(event\.pointerType !== 'mouse'\) return;/g) ?? [];
    expect(guards.length, 'onPointerDown and onPointerMove each need one').toBe(2);
  });

  it('arms nothing before it has asked what the pointer is', () => {
    // The trap the review caught: assigning the drag origin above the guard
    // leaves the move handler holding a live origin for a finger, and the drag
    // then starts on the next 8 px with no hold at all — worse than the
    // gesture being removed.
    const down = SOURCE.slice(SOURCE.indexOf('const onPointerDown'));
    const guard = down.indexOf("event.pointerType !== 'mouse'");
    const origin = down.indexOf('start.current = {');
    expect(guard).toBeGreaterThan(-1);
    expect(origin).toBeGreaterThan(guard);
  });

  it('keeps no hold timer, and buzzes no phone', () => {
    // A hold is a touch gesture's opening move; nothing here should have one.
    expect(SOURCE).not.toContain('HOLD_MS');
    expect(SOURCE).not.toContain('holdTimer');
    expect(SOURCE).not.toContain('navigator.vibrate');
  });
});

describe('every board can move a card', () => {
  it('puts the move sheet on the desktop card too', () => {
    // `move-other` used to appear once, inside the phone view. A tablet lands
    // on the DESKTOP board — width decides, not pointer — so without this it
    // would have a board it cannot move anything on.
    const buttons = SOURCE.match(/data-testid="move-other"/g) ?? [];
    expect(buttons.length, 'one on the phone card, one on the desktop card').toBe(2);
  });

  it('does not gate that button on a pointer query', () => {
    // This file's own comment says a trackpad can report as touch. A machine
    // answering «fine» to the media query and «not a mouse» to the event would
    // get neither door, so the button is unconditional.
    expect(SOURCE).not.toContain('useCoarsePointer');
    expect(SOURCE).not.toContain('pointer: coarse');
  });
});

describe('a refused move says which refusal it was', () => {
  it('names every code the two services can return', () => {
    // moveLead spells it `reason_required`; moveDeal spells the same refusal
    // `lost_reason_required`. Both boards share one map, so both spellings
    // have to be in it.
    for (const code of [
      'forbidden',
      'unauthenticated',
      'not_found',
      'stage_not_found',
      'reason_required',
      'lost_reason_required',
    ]) {
      expect(ERRORS, `useMoveErrors has no entry for ${code}`).toContain(`${code}:`);
    }
  });

  it('falls back rather than throwing on a code nobody translated', () => {
    expect(SOURCE).toContain('labels.moveErrors[error] ?? labels.error');
  });

  it('includes the lead CARD, which sat outside this contract until round 76', () => {
    // The card's stage buttons awaited moveLeadAction and dropped the result,
    // so a refused move there was a tap that did nothing — for every round
    // since #512 gave the two boards their words.
    expect(CARD_MOVER).toContain('useMoveErrors');
    expect(CARD_MOVER).toContain('moveErrors[res.error]');
  });

  it('resolves each sentence from a literal key, so the bundle test can see it', () => {
    const keys = [...ERRORS.matchAll(/t\('(moveErrors\.[a-zA-Z]+)'\)/g)].map((m) => m[1]!);
    expect(keys.length).toBeGreaterThan(0);
    for (const key of keys) {
      const leaf = key.split('.')[1]!;
      expect(
        ru.common.moveErrors[leaf as keyof typeof ru.common.moveErrors],
        `common.${key} is missing from the reference bundle`,
      ).toBeTypeOf('string');
    }
  });
});
