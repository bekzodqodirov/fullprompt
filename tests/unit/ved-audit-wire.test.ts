import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';

/**
 * The whole-module audit's smaller fixes, pinned as source shape — each was
 * an agreed behaviour (docs/VED.md) that shipped missing or shrunk, and each
 * is one deleted line away from shipping missing again.
 */
const read = (p: string) => readFileSync(p, 'utf8');
const code = (src: string) => src.replace(/\/\*[\s\S]*?\*\//g, '').replace(/\/\/.*$/gm, '');

// Phase 2 split the screen: the table (groups, bazas, teach/lgota/stale)
// lives in items-table.tsx, the panels stayed in calc-workspace.tsx — the
// fence reads BOTH, because the law it pins is about the SCREEN, not a file.
const WORKSPACE_UI =
  read('src/app/(protected)/hisoblash/[id]/calc-workspace.tsx') +
  read('src/app/(protected)/hisoblash/[id]/items-table.tsx');
const WORKSPACE = read('src/modules/wms/calc/workspace.ts');
const LEDGER = read('src/app/(protected)/finance/[clientId]/page.tsx');

describe('law 10: the last FIVE quotes', () => {
  it('the workspace asks for 5, the agreed number', () => {
    expect(code(read('src/app/(protected)/hisoblash/[id]/last-quotes.tsx'))).toContain(
      'lastQuotesByCode(list, 5)',
    );
  });
});

describe('law 5: the stale ⚠ where a stale baza prices a job', () => {
  it('loadWorkspace computes it and the workspace draws it', () => {
    expect(code(WORKSPACE)).toContain('stale: dict.effectiveDate <= bazaStaleCutoff');
    expect(WORKSPACE_UI).toContain('calc-baza-stale');
  });
});

describe('law 8: very small cargo gets only a warning', () => {
  it('the flag exists in the engine and the workspace draws it', () => {
    // The engine half is behavioural (calc-pricing.test.ts); this is the
    // half a screen edit can silently drop.
    expect(WORKSPACE_UI).toContain('calc-freight-small');
    expect(WORKSPACE_UI).toContain('freight.small');
  });
});

describe('law 6: a typed correction is REMEMBERED by a press, never silently', () => {
  it('the workspace has the teach button and it writes source correction', () => {
    const btn = WORKSPACE_UI.slice(WORKSPACE_UI.indexOf('calc-teach-rates'));
    expect(btn.slice(0, btn.indexOf('</button>'))).toContain("source: 'correction'");
  });

  it('nothing teaches the dictionary without a person', () => {
    // sealCalc must not call saveRates: a rate learned silently from every
    // seal would learn a one-off lgota-driven number (0086's own comment).
    const seal = code(WORKSPACE).slice(code(WORKSPACE).indexOf('export async function sealCalc'));
    expect(seal).not.toContain('saveRates');
  });
});

describe('law 7: the lgota offered from the last sealed decision', () => {
  it('the offer is a button that applies, not a value that applied itself', () => {
    const btn = WORKSPACE_UI.slice(WORKSPACE_UI.indexOf('calc-lgota-last'));
    expect(btn.slice(0, btn.indexOf('</button>'))).toContain('setRatesAction');
  });
});

describe('law 4: both figures at cash intake, behind the upsale scope', () => {
  it('the ledger gates the strip on the upsale scope, not on finance.view', () => {
    // The difference between the two numbers IS the upsale; the VED holds
    // finance.manage and must not read it here any more than on /upsale.
    const body = code(LEDGER);
    expect(body).toContain("upsaleScopeFor(actor) === 'all'");
    expect(body).toContain('both-figures');
    const gate = body.slice(0, body.indexOf('both-figures'));
    expect(gate).toContain('seesBothFigures');
  });

  it('the service reads only standing released offers', () => {
    const svc = code(read('src/modules/wms/calc/upsale-service.ts'));
    const fn = svc.slice(svc.indexOf('export async function bothFiguresForDeals'));
    expect(fn).toContain('releasedOfferWhere()');
    expect(fn).toContain('offerStandsSql()');
  });
});

describe('law 11: the bot hands the words themselves to the card', () => {
  it('landCollectedIntake passes state.material through', () => {
    const bot = code(read('src/modules/platform/telegram/staff-bot.ts'));
    const fn = bot.slice(bot.indexOf('export async function landCollectedIntake'));
    expect(fn.slice(0, fn.indexOf('leadName'))).toContain('material: state.material');
  });
});
