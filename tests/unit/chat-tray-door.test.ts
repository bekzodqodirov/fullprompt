import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';

/**
 * The tray's door is ONE predicate, asked at every entrance (round 93).
 *
 * `mayDecideChats` itself is proven against a real database in
 * `round93.integration.test.ts`; what only a source-shape check can say is
 * that the screen and all three actions actually ASK it. The defect this
 * pins was exactly that shape: the predicate of the day (`clients.manage`)
 * was right where it was asked and wrong for who needed the door — a
 * seller's tray filled up on a screen only the admin could open.
 */
describe('who may open the chat tray', () => {
  const page = readFileSync('src/app/(protected)/suhbatlar/qaysi/page.tsx', 'utf8');
  const actions = readFileSync('src/app/(protected)/suhbatlar/qaysi/actions.ts', 'utf8');
  const list = readFileSync('src/app/(protected)/suhbatlar/page.tsx', 'utf8');

  it('the tray screen asks the shared predicate', () => {
    expect(page).toContain('mayDecideChats(actor)');
    expect(page).not.toContain("permissions.has('clients.manage')) redirect");
  });

  it('all three actions ask it — a screen is a view, an action is a door', () => {
    const gates = actions.match(/mayDecideChats\(who\)/g) ?? [];
    expect(gates).toHaveLength(3);
    // The old permission must not linger as a second, narrower gate.
    expect(actions).not.toContain("authorize('clients.manage')");
  });

  it('the conversations screen offers the door by the same rule', () => {
    expect(list).toContain('await mayDecideChats(actor)');
  });

  it('a manager still answers only for their own rows', () => {
    // The widened door must not widen the LIST: the non-admin path keeps
    // filtering candidates by the actor's own id, in the page and actions.
    expect(page).toContain('managerUserId: seeAll ? undefined : actor.id');
    expect(actions.match(/managerUserId: who\.id/g) ?? []).toHaveLength(3);
  });
});
