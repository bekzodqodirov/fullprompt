import { readdirSync, readFileSync, statSync } from 'node:fs';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';

/**
 * The phone round (his B1 a … B6 a + 21b) and 0125's one-chain rule — as
 * SOURCE SHAPE, because none of it is visible to a behavioural test this
 * suite can run: a thrown server action only exists on a broken network, the
 * phone's cards are `md:hidden` markup that is in the DOM at 1280 too, and
 * «the four sites ask one function» is a property of the code rather than of
 * any one screen.
 *
 * Comments are stripped first (#725): a rule that trips on the sentence
 * explaining it is a rule that gets deleted.
 */
const strip = (text: string) =>
  text
    .replace(/\/\*[\s\S]*?\*\//g, '')
    .replace(/^\s*\/\/.*$/gm, '')
    .replace(/\{\/\*[\s\S]*?\*\/\}/g, '');
const read = (path: string) => strip(readFileSync(path, 'utf8'));
const WS = read('src/app/(protected)/hisoblash/[id]/calc-workspace.tsx');
const TABLE = read('src/app/(protected)/hisoblash/[id]/items-table.tsx');
const SHEET = read('src/app/(protected)/hisoblash/[id]/row-sheet.tsx');
const PHONE = read('src/app/(protected)/hisoblash/[id]/phone-blocks.tsx');
const ROW_DRAFT = read('src/modules/wms/calc/row-draft.ts');
const DICT = read('src/app/(protected)/hisoblash/lugatlar/dict-forms.tsx');
const SW = read('src/app/sw.ts');
const BANNER = read('src/components/update-banner.tsx');

/** A top-level `const` inside ItemsTable, up to the next one. */
function constBody(name: string): string {
  const at = TABLE.indexOf(`\n  const ${name} =`);
  expect(at, name).toBeGreaterThan(-1);
  const next = TABLE.indexOf('\n  const ', at + 10);
  return TABLE.slice(at, next === -1 ? undefined : next);
}

describe('a thrown action is a sentence, never the error page', () => {
  it('act() wraps the work in try/catch and says save_failed', () => {
    const at = WS.indexOf('const act =');
    expect(at).toBeGreaterThan(-1);
    const body = WS.slice(at, WS.indexOf(';\n\n', at) + 1);
    expect(body).toContain('try {');
    expect(body).toMatch(/catch\s*\{\s*setError\('save_failed'\)/);
    // …and after a deploy, the right sentence (D9).
    expect(body).toContain('isBuildStale()');
  });

  it('the one sender asks whether the build is stale after a throw, and writes no error itself', () => {
    const send = constBody('send');
    expect(send).toContain("(await isBuildStale()) ? 'stale_build' : 'save_failed'");
    // `send` RETURNS the state: the grid's save writes the grid's error line,
    // the sheet writes its own — a sheet press must not paint the desktop's.
    expect(send).not.toContain('setTableError(');
  });
});

describe('the phone ✅ waits on unsaved cells, as the desktop one does', () => {
  it('the confirm button renders only when nothing is unsaved or waiting to be restored', () => {
    const at = PHONE.indexOf('data-testid="calc-phone-confirm"');
    expect(at).toBeGreaterThan(-1);
    const before = PHONE.slice(Math.max(0, at - 1200), at);
    expect(before).toContain('gateCount > 0 ?');
    expect(before).toContain('data-testid="calc-phone-save-first"');
  });

  it('the gate counts the restorable rows too, and feeds the seal', () => {
    expect(TABLE).toMatch(
      /const gateCount = dirtyCount \+ \(restore \? restorableCount\(restore\) : 0\);/,
    );
    expect(TABLE).toContain('useEffect(() => onDirty(gateCount), [gateCount, onDirty]);');
  });
});

describe('new rows carry the id their screen minted', () => {
  it('the ghost row and the paste both post a clientId', () => {
    expect(TABLE).toContain('clientId: row.clientId');
    expect(TABLE).toMatch(/clientId: ids\[i\]/);
    // emptyRow moved to row-draft.ts with its id.
    const at = ROW_DRAFT.indexOf('export const emptyRow');
    expect(at).toBeGreaterThan(-1);
    expect(ROW_DRAFT.slice(at, ROW_DRAFT.indexOf('});', at))).toContain('clientId: mintClientId()');
  });
});

describe('ONE chain for the unit on screen (#886, #171)', () => {
  it('the old per-group law helpers are gone from the grid', () => {
    expect(TABLE).not.toContain('requiredUnitOf');
    expect(TABLE).not.toContain('EXT_UNITS');
    // No hand-written basis list left in the grid either.
    expect(TABLE).not.toMatch(/\['unit', 'kg'/);
  });

  it('the row, the live engine item, the builder and the self-clean all ask screenRowOf', () => {
    const uses = TABLE.match(/screenRowOf\(item, /g) ?? [];
    // serverValueOf (measure + basis), liveItem, buildEdit, ItemRowBlock.
    expect(uses.length).toBeGreaterThanOrEqual(5);
    const live = TABLE.slice(
      TABLE.indexOf('const liveItem'),
      TABLE.indexOf('const liveCustomsByGroup'),
    );
    expect(live).toContain('screenRowOf(item');
    expect(live).toContain('volumeM3: numOf(d?.volumeM3');
    const build = constBody('buildEdit');
    expect(build).toContain('screenRowOf(item, d,');
    // The unit a baza edit posts is ONE rule (screen-row.ts), unit-tested in
    // calc-screen-row.test.ts — a touched unit, a cleared price, a stored one.
    expect(build).toContain('edit.bazaBasis = postedBasis(d.bazaBasis, v === null, item);');
  });

  it('the grid’s save and the sheet’s press both build through buildEdit (one chain, two presses)', () => {
    expect(constBody('save')).toContain('buildEdit(');
    expect(constBody('saveSheetRow')).toContain('buildEdit(');
    expect(constBody('saveSheetRow')).toContain('buildAdd(');
  });

  it('the 📥 statistics marker asks the same chain on both shapes (his C, #1299)', () => {
    // Desktop: the ⋯ fold is handed the row's ONE answer, never `draft ??
    // stored` — null on an untouched «avto» row whose select shows the law's.
    expect(TABLE).toContain('screenBasis={screen.basis}');
    // Phone: the sheet's 📥 builds its marker from the same resolver.
    const door = constBody('openPickerFromSheet');
    expect(door).toContain('screenRowOf(item, d,');
    expect(door).toContain('screen.basis');
  });

  it('the desktop footer’s A1 chip reads the LIVE rows its baza reads (review units-r2-2)', () => {
    const memo = TABLE.slice(
      TABLE.indexOf('const liveBasisNotLawByGroup'),
      TABLE.indexOf('const liveTotals'),
    );
    expect(memo).toContain('basisNotLaw(g.dutyUnit, g.items.map((i) => liveItem(i)))');
    const footer = TABLE.slice(TABLE.indexOf('function BlockFooter'));
    expect(footer).toContain('{liveBasisNotLaw && group.dutyUnit ? (');
    expect(footer).not.toContain("group.warnings.includes('basis_not_law')");
  });
});

describe('the phone renders the SAME state — never the desktop grid’s markup (m9zp reads it strictly)', () => {
  const FORBIDDEN_TESTIDS = [
    'calc-row',
    'calc-baza',
    'calc-basis',
    'calc-measure',
    'calc-save-table',
    'calc-add-row',
  ];
  const FORBIDDEN_PREFIXES = ['calc-group-', 'calc-item-', 'calc-new-'];

  it.each([
    ['row-sheet.tsx', SHEET],
    ['phone-blocks.tsx', PHONE],
  ])(
    '%s carries no grid cell, no grid testid, no 14 px input and no AI or bulk door',
    (_name, source) => {
      expect(source).not.toContain('data-cell=');
      expect(source).not.toContain('data-row=');
      // An attribute, a `testId=` prop, AND a quoted `calc-…` literal — the
      // sheet maps its fields to their testids in an object, which an
      // attribute-only read would never see.
      const testids = [
        ...[...source.matchAll(/(?:data-testid|testId)="([^"]+)"/g)].map((m) => m[1]!),
        ...[...source.matchAll(/'(calc-[a-z0-9-]+)'/g)].map((m) => m[1]!),
      ];
      expect(testids.length).toBeGreaterThan(3);
      for (const id of testids) {
        expect(FORBIDDEN_TESTIDS, id).not.toContain(id);
        for (const prefix of FORBIDDEN_PREFIXES) expect(id.startsWith(prefix), id).toBe(false);
      }
      expect(source).not.toMatch(/\binput-cell\b|\binput-sm\b/);
      // His B1/B3: rates are phase 2, no ✨, no mass pull on the phone.
      expect(source).not.toMatch(/proposeAction|pullBazasAction|setRatesAction/);
    },
  );

  it('ONE sheet, mounted once and toggled (#684)', () => {
    expect(SHEET.match(/<Overlay\b/g) ?? []).toHaveLength(1);
    const at = TABLE.indexOf('<RowSheet');
    expect(at).toBeGreaterThan(-1);
    const tag = TABLE.slice(at, TABLE.indexOf('/>', at));
    expect(tag).toContain('open=');
    // Never behind a conditional — an Overlay that mounts already open
    // closes itself the frame it appears.
    const before = TABLE.slice(Math.max(0, at - 40), at);
    expect(before).not.toMatch(/\?\s*\($|&&\s*\($|\?\s*$|&&\s*$/);
  });
});

describe('B2 a: the sheet posts ONE row', () => {
  it('saveSheetRow sends a single built edit or a single built add, never the whole table', () => {
    const body = constBody('saveSheetRow');
    expect(body).toContain('send([edit], [],');
    expect(body).toContain('send([], [built.add],');
    expect(body).not.toMatch(/\bsave\(\)/);
    // The one edit is the built one, with at most the expectation beside it.
    expect(body).toMatch(/const edit: TableItemEdit = acknowledged \? built\.edit : \{ \.\.\.built\.edit, expect: expectFor\(item, d\) \};/);
  });

  it('the sheet’s figure merges only the row it saves (#886, D14)', () => {
    const figure = constBody('sheetFigure');
    expect(figure).toContain('liveItem(i, i.id ===');
    expect(figure).not.toContain('liveCustomsByGroup');
  });
});

describe('B4 a: ONE number reader on every cell and on the dictionary’s baza', () => {
  it('parseCell is gone from the table and the phone', () => {
    for (const source of [TABLE, SHEET, PHONE]) expect(source).not.toContain('parseCell');
    // The one comma reader left in the grid is the rates fold's (phase 2).
    expect(TABLE.match(/\.replace\(',', '\.'\)/g) ?? []).toHaveLength(1);
  });

  it('the dictionary baza form asks readNumberCell, not a comma swap', () => {
    const at = DICT.indexOf('data-testid="baza-save"');
    expect(at).toBeGreaterThan(-1);
    const next = DICT.indexOf('data-testid=', at + 25);
    const press = DICT.slice(at, next);
    expect(press).toContain('readNumberCell(amount)');
    expect(press).not.toContain("Number(amount.replace(',', '.'))");
  });
});

/** Every .ts/.tsx file under `dir`, repo-relative. */
function sourceFiles(dir: string): string[] {
  const out: string[] = [];
  for (const name of readdirSync(dir)) {
    const rel = join(dir, name);
    if (statSync(rel).isDirectory()) out.push(...sourceFiles(rel));
    else if (/\.(ts|tsx)$/.test(name)) out.push(rel);
  }
  return out;
}

describe('his 2b (2026-10-07): «boshqa kishi hozirgina o‘zgartirdi» is the PHONE’s alone', () => {
  it('the desktop grid’s one save posts no expectation and looks at no clock first', () => {
    expect(constBody('save')).not.toMatch(/expect:|expectFor\(|lookFirst\(|probeClock\(/);
    // The edits it posts are buildEdit's, and those carry none either — only
    // the sheet adds one beside the built edit (B2 a above).
    expect(constBody('buildEdit')).not.toMatch(/expect:|expectFor\(/);
    // The desktop row's 🗑 deletes without looking first.
    const at = TABLE.indexOf('data-testid="calc-item-delete"');
    expect(at).toBeGreaterThan(-1);
    const press = TABLE.slice(at, TABLE.indexOf("🗑 {tc('delete')}", at));
    expect(press).not.toMatch(/lookFirst\(|probeClock\(/);
  });

  it('the 15-second probe runs only while a sheet is open or an AI pass holds the request', () => {
    const at = TABLE.indexOf('const sheetKey = sheetKeyOf(sheet);');
    expect(at).toBeGreaterThan(-1);
    const effect = TABLE.slice(at, TABLE.indexOf('}, [sheetKey, aiRunning, id, router]);', at));
    expect(effect).toContain('if (sheetKey === null && !aiRunning) return;');
    expect(effect).toContain('probeClock(id)');
  });

  it('a sheet opens only from the phone cards, and only the sheet draws the warning', () => {
    const opens = TABLE.split('onOpenItem={openItemSheet}').length - 1;
    expect(opens).toBe(1);
    const mount = TABLE.indexOf('<PhoneBlocks');
    expect(mount).toBeGreaterThan(-1);
    const end = TABLE.indexOf('/>', TABLE.indexOf('onOpenGhost={openGhostSheet}', mount));
    const opener = TABLE.indexOf('onOpenItem={openItemSheet}');
    expect(opener).toBeGreaterThan(mount);
    expect(opener).toBeLessThan(end);
    expect(PHONE).toContain('md:hidden');
    const drawers = sourceFiles('src').filter((file) => read(file).includes("'phone.changed'"));
    expect(drawers).toEqual([join('src', 'app', '(protected)', 'hisoblash', '[id]', 'row-sheet.tsx')]);
  });
});

describe('his 3b (2026-10-07): «1,125 — qaysi biri?» is asked by the goods cells and the dictionary baza ONLY', () => {
  it('the files that import the one reader are a closed set', () => {
    const importers = sourceFiles('src')
      .filter((file) => /from ['"][^'"]*\/number-cell['"]/.test(readFileSync(file, 'utf8')))
      .sort();
    expect(importers).toEqual(
      [
        'src/app/(protected)/hisoblash/[id]/items-table.tsx',
        'src/app/(protected)/hisoblash/[id]/phone-blocks.tsx',
        'src/app/(protected)/hisoblash/[id]/row-sheet.tsx',
        'src/app/(protected)/hisoblash/lugatlar/dict-forms.tsx',
        'src/modules/wms/calc/row-draft.ts',
      ].map((rel) => join(...rel.split('/'))),
    );
  });

  it('in the dictionary only the baza form asks; the rates and the price book keep their comma swap', () => {
    const baza = DICT.slice(DICT.indexOf('export function BazaForm'), DICT.indexOf('export function RatesForm'));
    const rates = DICT.slice(DICT.indexOf('export function RatesForm'), DICT.indexOf('export function PriceBookForm'));
    const book = DICT.slice(DICT.indexOf('export function PriceBookForm'));
    expect(baza).toContain('readNumberCell(amount)');
    for (const form of [rates, book]) expect(form).not.toContain('readNumberCell');
    expect(rates).toContain("Number(duty.replace(',', '.'))");
    expect(book).toContain("Number(price.replace(',', '.'))");
  });

  it('the seal’s discount reads money without asking; the workspace never imports the reader', () => {
    expect(WS).not.toContain('readNumberCell');
    const at = WS.indexOf('data-testid="calc-do-seal"');
    expect(at).toBeGreaterThan(-1);
    const press = WS.slice(at, WS.indexOf('bandOverrideReason', at));
    expect(press).toContain('parseTypedMoney(discount)');
    expect(press).toContain("Number(override.replace(',', '.'))");
  });
});

describe('B5 a: the stored drafts are read before anything writes over them', () => {
  it('the READ effect is declared before the WRITE effect, and the write waits on the ref gate', () => {
    const readAt = TABLE.indexOf('parseStoredDrafts(readStored(');
    const writeAt = TABLE.indexOf("storagePhase.current === 'init') return;");
    expect(readAt).toBeGreaterThan(-1);
    expect(writeAt).toBeGreaterThan(readAt);
    const write = TABLE.slice(
      writeAt,
      TABLE.indexOf('}, [drafts, bases, newRows, storageKey]);', writeAt),
    );
    // While the question stands (prompt) or a skipped entry is kept (kept),
    // the stored entry is merged in; only `live` writes the live state alone.
    expect(write).toContain(
      "storagePhase.current === 'live' ? live : mergeForStorage(storedEntry.current, live)",
    );
  });
});

describe('D15: every field the phone reaches is 16 px', () => {
  it('each 14 px input-sm field of the workspace grows to 16 px below md', () => {
    const fields = [...WS.matchAll(/className="([^"]*\binput-sm\b[^"]*)"/g)].map((m) => m[1]!);
    expect(fields.length).toBe(8);
    for (const cls of fields) expect(cls, cls).toContain('max-md:!text-base');
  });
});

describe('the clock is never answered from a cache (sw.ts)', () => {
  it('the NetworkOnly matcher names /api/calc/rev/', () => {
    const at = SW.indexOf('handler: new NetworkOnly()');
    expect(at).toBeGreaterThan(-1);
    expect(SW.slice(0, at)).toContain("pathname.startsWith('/api/calc/rev/')");
  });
});

describe('D9: ONE way to reload a stale tab', () => {
  it.each([
    ['update-banner.tsx', BANNER],
    ['items-table.tsx', TABLE],
    ['row-sheet.tsx', SHEET],
  ])('%s reloads through reloadFresh() and never by hand', (_name, source) => {
    expect(source).toContain('reloadFresh(');
    expect(source).not.toMatch(/location\.assign\(|location\.href\s*=/);
  });
});

describe('review PHONE-1: a posted ghost carries what it carried', () => {
  it('the sender stamps every posted ghost before the wire, settles on the stamped object, and un-stamps a refusal', () => {
    const send = constBody('send');
    const stampAt = send.indexOf('stamped.set(key, { ...row, posted: cells });');
    const wireAt = send.indexOf('await saveTableAction(');
    expect(stampAt).toBeGreaterThan(-1);
    expect(wireAt).toBeGreaterThan(stampAt);
    // The FIRST unanswered post's stamp stands.
    expect(send).toContain('if (row.posted !== null) {');
    expect(send).toContain('ghosts: stamped, atPress');
    // A refusal wrote nothing — the stamp it minted is taken back.
    const refusal = send.slice(send.indexOf('if (!result.ok) {'), send.indexOf('return result;'));
    expect(refusal).toContain('{ ...r, posted: null }');
  });
});

describe('review PHONE-2: the sheet’s look is closed at the commit', () => {
  it('a refused compare-and-set brings the change in on the sheet, or says so in the table line', () => {
    const body = constBody('saveSheetRow');
    expect(body).toContain("if (result.error === 'changed_under') {");
    expect(body).toContain("if (showing(target) && (await lookFirst(target)) !== 'none') return;");
  });
});

describe('review PHONE-3: a press is bound to the row it was pressed on', () => {
  it.each(['saveSheetRow', 'deleteSheetRow'])(
    '%s never retargets to whatever sheet is open now, and closes only its own',
    (name) => {
      const body = constBody(name);
      expect(body).toContain('const pressed = start.sheet;');
      expect(body).not.toMatch(/\bnow\.sheet\b|latest\.current\??\.sheet/);
      const closes = [...body.matchAll(/closeSheet\(\)/g)];
      expect(closes.length).toBeGreaterThan(0);
      for (const m of closes) {
        // The nearest guard before it is the row's own, and no block has
        // closed between the guard and the close.
        const before = body.slice(0, m.index!);
        const guard = Math.max(before.lastIndexOf('if (showing(pressed))'), before.lastIndexOf('if (showing(target))'));
        expect(guard, name).toBeGreaterThan(-1);
        expect(before.slice(guard), name).not.toContain('}');
      }
    },
  );

  it('the save resolves the pressed row through pressedNow; a refusal goes where the VED is', () => {
    expect(constBody('saveSheetRow')).toContain('pressedNow(now, pressed, pressedClientId)');
    const refusal = constBody('showRefusal');
    expect(refusal).toMatch(/if \(!showing\(pressed\)\) \{[^}]*setTableError\(\{ code: refusal\.code, seq: refusal\.seq \}\)/);
    expect(constBody('deleteSheetRow')).toMatch(/if \(showing\(pressed\)\) setDeleteWarn\(changes\);/);
  });
});

describe('review PHONE-5: the phone sweep is drawn on what it places', () => {
  it('no «(0)» button over duplicates no press can merge', () => {
    expect(PHONE).toContain('gateCount === 0 && sweepable > 0 ? (');
    expect(PHONE).not.toContain('duplicateGroups');
  });
});

describe('review PHONE-6: a restore with nothing to restore is news shown once', () => {
  it('the mount asks the pure decision, and a kept entry is merged like a standing question', () => {
    // mountDecision is proven in calc-draft-store.test.ts; here: the screen asks it and obeys it.
    expect(TABLE).toContain('const decision = mountDecision(parsed, plan);');
    expect(TABLE).toContain('storedEntry.current = decision.keep;');
    expect(TABLE).toContain('storagePhase.current = decision.phase;');
    expect(TABLE).toContain(
      "const value = storagePhase.current === 'live' ? live : mergeForStorage(storedEntry.current, live);",
    );
    const RESTORE = read('src/app/(protected)/hisoblash/[id]/draft-restore.tsx');
    expect(RESTORE).toContain("count > 0 ? t('restore.no') : t('restore.dismiss')");
  });

  it('«Tushunarli» on news closes the notice and keeps the entry a fresh page may still offer back', () => {
    const body = constBody('dropRestore');
    expect(body).toMatch(/if \(storagePhase\.current === 'kept'\) \{\s*setRestore\(null\);\s*return;\s*\}/);
    expect(body.indexOf("storagePhase.current === 'kept'")).toBeLessThan(body.indexOf('writeStored('));
  });
});

describe('review PHONE-4: a marked box is marked on the SCREEN', () => {
  it('a warn border on an `.input` / `.input-cell` is `!border-warn` — the plain utility loses to the class', () => {
    for (const source of [SHEET, TABLE]) expect(source).not.toContain("' border-warn'");
    expect(SHEET).toContain("' !border-warn'");
    expect(TABLE).toContain("' !border-warn'");
  });

  it('a bad number is asked under its own box, as the ambiguity question is', () => {
    expect(SHEET).toContain('data-testid="calc-phone-bad"');
    expect(constBody('showRefusal')).toContain(
      "(refusal.code === 'ambiguous_number' || refusal.code === 'bad_number') && refusal.field",
    );
  });
});
