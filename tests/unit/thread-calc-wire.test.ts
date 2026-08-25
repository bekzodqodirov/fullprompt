import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';

/**
 * The thread calc door's wiring, as source shape — every press goes through
 * `authorize`-shaped gates no integration test can press (#531), so the
 * halves are pinned as text and the rules themselves are integration-proven
 * in thread-calc.integration.test.ts.
 */
const read = (p: string) => readFileSync(p, 'utf8');
const code = (src: string) => src.replace(/\/\*[\s\S]*?\*\//g, '').replace(/\/\/.*$/gm, '');

const ISLAND = read('src/components/thread-calc.tsx');
const THREAD = read('src/components/telegram-thread.tsx');
const SERVICE = read('src/modules/wms/calc/from-thread.ts');
const ACTIONS = read('src/app/(protected)/hisoblash/actions.ts');

describe('the selection', () => {
  it('bubbles carry the id the island selects by', () => {
    expect(read('src/components/telegram-bubble.tsx')).toContain('data-msg-id={message.id}');
  });

  it('the listener is capture-phase and claims the tap while select mode is on', () => {
    // The lightbox, the audio player, the file anchor and the reply/share
    // buttons all see the click AFTER a document-capture listener — this is
    // the only phase that can win (the review's blocker; #494's cousin).
    const body = code(ISLAND);
    expect(body).toContain("document.addEventListener('click', onClick, true)");
    const handler = body.slice(body.indexOf('const onClick'), body.indexOf('document.addEventListener'));
    expect(handler).toContain('event.preventDefault()');
    expect(handler).toContain('event.stopPropagation()');
  });
});

describe('the mounts', () => {
  it('the panel mounts the island OUTSIDE the scroll box, on both branches', () => {
    const mounts = THREAD.split('<ThreadCalc').length - 1;
    expect(mounts).toBe(2);
    // Never inside the scroll box: the bar must not scroll away with the
    // history. The scroll boxes close before the island appears.
    for (const at of [THREAD.indexOf('<ThreadCalc'), THREAD.lastIndexOf('<ThreadCalc')]) {
      const before = THREAD.slice(0, at);
      const lastScroll = before.lastIndexOf('overflow-y-auto');
      expect(before.indexOf('</div>', lastScroll)).toBeGreaterThan(lastScroll);
    }
  });

  it('the deal card passes ITS OWN deal as the landing target', () => {
    const page = read('src/app/(protected)/bitimlar/[id]/page.tsx');
    expect(page).toContain("calcTarget={{ kind: 'deal', id: row.deal.id }}");
  });

  it('the conversations screen mounts the same island', () => {
    expect(read('src/app/(protected)/suhbatlar/[clientId]/page.tsx')).toContain('<ThreadCalc');
  });
});

describe('the gates and the forged-post fences', () => {
  it('both actions ask the read fence AND the card-write rule', () => {
    const gate = code(ACTIONS).slice(code(ACTIONS).indexOf('function threadCalcGate'));
    const body = gate.slice(0, gate.indexOf('\n}'));
    expect(body).toContain('canReadTg(actor)');
    expect(body).toContain('canWriteDeal(actor.permissions)');
    expect(body).toContain("entity.kind === 'lead' && !actor.permissions.has('crm.leads')");
    expect(body).toContain('isCalcSection(section)');
  });

  it('the send path REBUILDS the material server-side — the browser’s copy is never an input', () => {
    const send = code(SERVICE).slice(code(SERVICE).indexOf('export async function threadCalcSend'));
    expect(send).toContain('threadMaterial(actor, input.entity, input.messageIds)');
    // And the count mismatch refuses whole, never trims.
    expect(code(SERVICE)).toContain("if (rows.length !== ids.length) throw new CalcError('not_yours')");
  });
});
