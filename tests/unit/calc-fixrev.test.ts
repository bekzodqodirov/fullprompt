import { readFileSync } from 'node:fs';
import { afterEach, describe, expect, it } from 'vitest';
import { endIntake, intakeIsEmpty, nothingNewToRead, startIntake } from '@/modules/platform/telegram/calc-store';
import type { IntakeState } from '@/modules/platform/telegram/calc-intake';
import { sawRevFor, typedAtNext } from '@/modules/wms/calc/row-draft';
import { reloadCure } from '@/components/build-check';

/**
 * The fix review of the merged review's fixes (docs/SAKKIZ-R3.md §20.2) —
 * the pure halves. Each case calls the real function; the two source fences
 * pin where a pure rule is asked, because the screens that ask it are React
 * components no unit test renders.
 */

const chats: bigint[] = [];
let seq = 0;
function collection(patch: Partial<IntakeState> = {}): IntakeState {
  seq += 1;
  const chat = BigInt(-7_800_000_000) - BigInt(seq);
  chats.push(chat);
  return { ...startIntake(chat, 'rastamojka', { staffId: 'staff-fixrev' }), ...patch };
}
afterEach(() => {
  for (const chat of chats.splice(0)) endIntake(chat);
});

const SEED = [{ name: 'Sumka', quantity: 10 }];

describe('a seeded collection’s certificate answer is content (fix review FR-10)', () => {
  it('changed from the one it opened with → not empty: reminded, said goodbye to, asked before a replace', () => {
    const opened = collection({ seed: SEED, clientHintRaw: 'GS777', doorHint: 'GS777', hasCertificate: true, certificateAtOpen: true });
    expect(intakeIsEmpty(opened)).toBe(true);
    expect(intakeIsEmpty({ ...opened, hasCertificate: false })).toBe(false);
    // Pressed back to what it was: nothing of his is left.
    expect(intakeIsEmpty({ ...opened, hasCertificate: true })).toBe(true);
  });
  it('a row written before the field (none at open) reads as before', () => {
    const old = collection({ seed: SEED, clientHintRaw: 'GS777', doorHint: 'GS777', hasCertificate: false });
    expect(intakeIsEmpty({ ...old, certificateAtOpen: undefined })).toBe(true);
  });
});

describe('nothing new to read on a collection carrying rows of its own (fix review W-11)', () => {
  const amend = { requestId: 'r', cardLabel: 'B-1' } as unknown as IntakeState['amend'];
  it('an add or seeded collection with no material and no file', () => {
    expect(nothingNewToRead(collection({ amend }))).toBe(true);
    expect(nothingNewToRead(collection({ seed: SEED }))).toBe(true);
  });
  it('anything sent, or a plain collection, is something to read', () => {
    expect(nothingNewToRead(collection({ amend, material: ['Shim 20 dona'] }))).toBe(false);
    expect(nothingNewToRead(collection({ seed: SEED, fileCount: 1 }))).toBe(false);
    expect(nothingNewToRead(collection())).toBe(false);
  });
});

describe('the grid’s save posts the rev its drafts were TYPED over (fix review FR-9)', () => {
  it('set by the first draft, kept while any stands — a refresh never moves it — cleared with the last', () => {
    let typed: number | null = null;
    typed = typedAtNext(typed, true, 4); // the first draft, typed over rev 4
    expect(typed).toBe(4);
    typed = typedAtNext(typed, true, 5); // the pulse refreshed onto the seller's addition (rev 5)
    expect(typed).toBe(4);
    typed = typedAtNext(typed, false, 6); // every draft settled
    expect(typed).toBeNull();
    expect(typedAtNext(typed, true, 6)).toBe(6);
  });
  it('the older of the two is posted, so the addition under a held draft refuses it', () => {
    expect(sawRevFor(5, 4)).toBe(4);
    expect(sawRevFor(5, null)).toBe(5);
    expect(sawRevFor(5, undefined)).toBe(5);
  });
  it('the grid’s save hands it in; the phone sheet’s presses keep the screen’s rev (they show what changed under them)', () => {
    const src = readFileSync('src/app/(protected)/hisoblash/[id]/items-table.tsx', 'utf8');
    expect(src).toContain('const sawRev = sawRevFor(revAtPress, typedAt);');
    expect(src).toContain('saveTableAction(id, { items, adds, sawRev })');
    expect(src).toContain('await send(items, adds, { drafts: postedDrafts, ghosts: postedGhosts }, typedAtRev.current);');
    expect(src).toContain('typedAtRev.current = typedAtNext(typedAtRev.current, holdsDrafts, workspace.rev);');
    // The sheet's two sends pass no typed rev.
    expect(src).toContain('await send([edit], [], { drafts: new Map([[target.id, d]]), ghosts: new Map() });');
    expect(src).toContain('await send([], [built.add], { drafts: new Map(), ghosts: new Map([[row.key, row]]) });');
  });
});

describe('«… sahifani yangilang» comes with its reload (fix review W-5)', () => {
  it('a new build: the whole cleanup; a seller’s addition: a plain reload; anything else: none', () => {
    expect(reloadCure('stale_build')).toBe('fresh');
    expect(reloadCure('amended_since')).toBe('plain');
    expect(reloadCure('save_failed')).toBeNull();
    expect(reloadCure(null)).toBeNull();
  });
  it('the three calc screens that print the refusal ask the one rule', () => {
    for (const file of ['items-table.tsx', 'row-sheet.tsx', 'calc-workspace.tsx']) {
      const src = readFileSync(`src/app/(protected)/hisoblash/[id]/${file}`, 'utf8');
      expect(src, file).toMatch(/\{reloadCure\((?:tableError\.code|error)\) \? \(/u);
      expect(src, file).toMatch(/onClick=\{\(\) => runReload\(reloadCure\((?:tableError\.code|error)\)!\)\}/u);
      expect(src, file).not.toContain("=== 'stale_build' ? (");
    }
  });
});

describe('the add door’s reading keys each name ONCE (fix review DRILL-1)', () => {
  it('addReading keys the kept rows before its loop and never calls the per-pair keying `sameGoodsLine`', () => {
    const src = readFileSync('src/modules/platform/telegram/calc-intake.ts', 'utf8');
    const start = src.indexOf('function addReading(');
    expect(start, 'addReading moved — re-anchor this fence').toBeGreaterThan(-1);
    const end = src.indexOf('\nfunction ', start + 1);
    const body = src.slice(start, end > start ? end : undefined);
    // `sameGoodsLine` keys BOTH names on every call: inside the loop over the
    // read lines and the find over the kept rows that was N×M keyings.
    expect(body).not.toContain('sameGoodsLine(');
    const keyed = body.indexOf('kept.map((k) => ({ row: k, names: goodsNameKeys(k.name) }))');
    const loop = body.indexOf('for (const read of picked.goods)');
    expect(keyed).toBeGreaterThan(-1);
    expect(loop).toBeGreaterThan(keyed);
    expect(body.indexOf('const readNames = goodsNameKeys(read.name);')).toBeGreaterThan(loop);
  });
});
