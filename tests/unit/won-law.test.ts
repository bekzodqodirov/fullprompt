import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';
import { leadFormStages, formStages } from '@/modules/wms/crm/stage-law';

/**
 * Round 107: winning a lead goes through the convert dialog — a client and a
 * deal — and every other door is shut. The service half is behaviourally
 * proven in crm.integration; what belongs here is the WIRING, which works in
 * both directions and so no behavioural test can see it drift:
 *
 * - `viaConvert` must never appear in a server action's surface: a public
 *   action's arguments are the caller's to invent, so an action that takes
 *   the flag IS the bypass.
 * - the board's intercept must sit AFTER the same-column allowance and judge
 *   the OPTIMISTIC stage, or a drag inside the won column becomes a dialog
 *   (round 64: a guard armed in the wrong order is worse than no guard).
 */

const read = (p: string) => readFileSync(p, 'utf8');

describe('won law wiring (round 107)', () => {
  it('no server action exposes viaConvert', () => {
    const actions = read('src/app/(protected)/crm/actions.ts');
    // The dialog has its own action; the move action's signature stays what
    // it has been since round 96.
    expect(actions).toContain(
      'moveLeadAction(\n  id: string,\n  stageId: string,\n  reason: string,\n  beforeId?: string | null,\n)',
    );
    // The flag may be MENTIONED (comments explain it); it must never be READ
    // out of an action's input.
    expect(actions).not.toMatch(/input[.?]*viaConvert|formData.*viaConvert/);
    expect(actions).toContain('winLeadAction');
  });

  it('the board intercepts won AFTER the same-column allowance, on the optimistic stage', () => {
    const board = read('src/components/kanban.tsx');
    const sameColumn = board.indexOf(
      'if (beforeId === undefined && stage.id === (placement[item.id] ?? item.stageId)) return;',
    );
    const intercept = board.indexOf(
      "if (onWon && stage.kind === 'won' && stage.id !== (placement[item.id] ?? item.stageId))",
    );
    const lostBranch = board.indexOf("if (stage.kind === 'lost')");
    expect(sameColumn).toBeGreaterThan(-1);
    expect(intercept).toBeGreaterThan(sameColumn);
    expect(lostBranch).toBeGreaterThan(intercept);
  });

  it('the leads board wires the dialog and offers no bulk door into won', () => {
    const wrapper = read('src/app/(protected)/crm/leads/kanban.tsx');
    expect(wrapper).toContain('onWon={(lead, stageId)');
    expect(wrapper).toContain('<WonDialog');
    expect(wrapper).toContain("stages.filter((stage) => stage.kind !== 'won')");
  });

  it('the card’s stage fold intercepts won before committing', () => {
    const mover = read('src/app/(protected)/crm/leads/[id]/stage-mover.tsx');
    const wonIntercept = mover.indexOf("if (stage.kind === 'won')");
    const commit = mover.indexOf('function commit(');
    expect(wonIntercept).toBeGreaterThan(-1);
    expect(commit).toBeGreaterThan(wonIntercept);
    expect(mover).toContain('<WonDialog');
  });

  it('the LEAD pickers drop won stages; the DEAL pickers keep them', () => {
    for (const page of [
      'src/app/(protected)/crm/leads/new/page.tsx',
      'src/app/(protected)/crm/leads/[id]/page.tsx',
    ]) {
      expect(read(page), page).toContain('leadFormStages(stages,');
    }
    for (const page of [
      'src/app/(protected)/bitimlar/new/page.tsx',
      'src/app/(protected)/bitimlar/[id]/page.tsx',
    ]) {
      const source = read(page);
      expect(source, page).toContain('formStages(stages');
      expect(source, page).not.toContain('leadFormStages');
    }
  });

  it('leadFormStages keeps only open stages plus the record’s own', () => {
    const stages = [
      { id: 'a', kind: 'open' },
      { id: 'b', kind: 'open' },
      { id: 'w', kind: 'won' },
      { id: 'l', kind: 'lost' },
    ];
    expect(leadFormStages(stages, null).map((s) => s.id)).toEqual(['a', 'b']);
    // The fall-back trap: the record's own closed stage stays, or the select
    // falls back to its first option and Save silently moves the lead.
    expect(leadFormStages(stages, 'w').map((s) => s.id)).toEqual(['a', 'b', 'w']);
    expect(leadFormStages(stages, 'l').map((s) => s.id)).toEqual(['a', 'b', 'l']);
    // …and the deal version still only drops lost.
    expect(formStages(stages, null).map((s) => s.id)).toEqual(['a', 'b', 'w']);
  });
});

describe('the won dialog cannot freeze (round 112)', () => {
  // Found by the round's own screenshot: `winLeadAction` THREW (the index's
  // 23505 is not a CrmError, so `run()` rethrows it) and `busy` stayed true —
  // a greyed button and no sentence. Both awaits now sit in try/finally, and
  // the refusal has a word at both doors. Source-shape, because the frozen
  // version also «worked» for every input a test would think to send.
  it('both action awaits release the busy flag in a finally', () => {
    const dialog = read('src/components/won-dialog.tsx');
    expect(dialog.match(/finally \{\s*setBusy\(false\);\s*\}/g)?.length).toBe(2);
    expect(dialog).toContain("client_has_lead: t('won.errors.clientHasLead')");
  });

  it('a second lead on one client is refused by the service AND named at the echo', () => {
    const service = read('src/modules/wms/crm/service.ts');
    expect(service).toContain("throw new CrmError('client_has_lead')");
    const actions = read('src/app/(protected)/crm/actions.ts');
    expect(actions).toContain("return { error: 'client_has_lead', name: row.name, clientCode: row.clientCode, leadName: taken.name }");
  });
});
