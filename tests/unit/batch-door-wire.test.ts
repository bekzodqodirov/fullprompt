import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';

/*
 * The truck actions and their door (docs/CARD-TABS.md, «Holes found on the
 * way»). Source-shape on purpose: the defect was a gate that WORKED and was
 * asked the wrong question — `authorize(code, {})` checks the permission and
 * no warehouse at all, and nothing about the behaviour of a gate that says
 * yes to the right person tells it from one that also says yes to the wrong
 * one. So the fence reads which question every truck action asks.
 *
 * DERIVED, not listed: every exported action in the file is found, the ones
 * that name a truck are picked out by what they do, and the rule is asked of
 * all of them — a ninth action added tomorrow with `authorize(code, {})` is
 * red on the day it is written. And anchored on names it MUST find, so a
 * parse that silently finds nothing cannot pass (tx-pool.test.ts's lesson).
 */

const ACTIONS = 'src/app/(protected)/batches/batch-actions-server.ts';
const DOOR = 'src/modules/wms/batches/batch-authorize.ts';
const TNVED_ACTIONS = 'src/app/(protected)/batches/[id]/tnved/actions.ts';
const TNVED_EDITOR = 'src/app/(protected)/batches/[id]/tnved/tnved-editor.tsx';
const TNVED_PAGE = 'src/app/(protected)/batches/[id]/tnved/page.tsx';

/**
 * Comments out, strings kept. A regex stripper reads `//` inside a string as a
 * comment; this one walks the quotes. Without it the fence matches the
 * sentence explaining it (#725).
 */
function stripComments(source: string): string {
  let out = '';
  let quote: string | null = null;
  for (let i = 0; i < source.length; i += 1) {
    const ch = source[i]!;
    const next = source[i + 1];
    if (quote) {
      out += ch;
      if (ch === '\\') {
        out += next ?? '';
        i += 1;
      } else if (ch === quote) {
        quote = null;
      }
      continue;
    }
    if (ch === "'" || ch === '"' || ch === '`') {
      quote = ch;
      out += ch;
    } else if (ch === '/' && next === '/') {
      while (i < source.length && source[i] !== '\n') i += 1;
      out += '\n';
    } else if (ch === '/' && next === '*') {
      i += 2;
      while (i < source.length && !(source[i] === '*' && source[i + 1] === '/')) i += 1;
      i += 1;
    } else {
      out += ch;
    }
  }
  return out;
}

const read = (path: string) => stripComments(readFileSync(path, 'utf8'));

/** Every exported async function: its name → its text, up to the next top-level declaration. */
function exportedActions(path: string): Map<string, string> {
  const src = read(path);
  const out = new Map<string, string>();
  for (const match of src.matchAll(/^export async function (\w+)\s*\(/gm)) {
    const from = match.index!;
    const rest = src.slice(from + 1);
    const next = rest.search(/\n(export |async function |function |const |let |type |interface |class )/);
    out.set(match[1]!, next === -1 ? src.slice(from) : src.slice(from, from + 1 + next));
  }
  return out;
}

/** The argument text of every call to `name(` — balanced, so a nested call cannot cut it short. */
function callArgs(text: string, name: string): string[] {
  const out: string[] = [];
  for (const match of text.matchAll(new RegExp(`\\b${name}\\(`, 'g'))) {
    const open = match.index! + match[0].length - 1;
    let depth = 0;
    for (let i = open; i < text.length; i += 1) {
      if (text[i] === '(') depth += 1;
      else if (text[i] === ')') {
        depth -= 1;
        if (depth === 0) {
          out.push(text.slice(open + 1, i));
          break;
        }
      }
    }
  }
  return out;
}

/** The eight that changed ONE truck through `authorize(code, {})`, with the permission each keeps. */
const ON_THE_TRUCK: Record<string, string> = {
  setSentToAgentAction: 'ved.docs',
  setCustomsFirmAction: 'ved.docs',
  setReceiptCustomsAction: 'ved.docs',
  setCustomsClearedAction: 'ved.docs',
  setProfitTrackedAction: 'finance.reports',
  setTrackingCheckpointAction: 'batches.vehicle_info',
  createDriverDeviceAction: 'batches.vehicle_info',
  revokeDriverDeviceAction: 'batches.vehicle_info',
};

/** The truck actions that were always judged at one end — the derivation must find them too. */
const AT_ONE_END = [
  'unloadRemainingAction',
  'countAcceptLotAction',
  'countAcceptCrateAction',
  'resolveMissingLotAction',
  'finishUnloadAction',
  'resolveMissingAction',
  'removeLoadedAction',
  'closeBatchAction',
];

/** Names a truck: carries a batch id, or reads a batch row by one. */
const namesATruck = (text: string) =>
  /\bbatchId\b/.test(text) || /\bbatches\.findFirst\(/.test(text) || /\.from\(batches\)/.test(text);

describe('every truck action is judged at a warehouse', () => {
  const actions = exportedActions(ACTIONS);
  const truckActions = [...actions].filter(([, text]) => namesATruck(text));

  it('finds every action it must — a parse that finds nothing is not a pass', () => {
    const found = truckActions.map(([name]) => name);
    for (const name of [...Object.keys(ON_THE_TRUCK), ...AT_ONE_END]) expect(found, name).toContain(name);
  });

  it('no action in the file calls authorize without a warehouse', () => {
    let calls = 0;
    for (const [name, text] of actions) {
      for (const args of callArgs(text, 'authorize')) {
        calls += 1;
        expect(args, `${name}: authorize(${args})`).toMatch(/,\s*\{\s*warehouseId:\s*\S/);
      }
    }
    // The one-end doors are still plain authorize calls — nine of them. If
    // this falls to zero the scan above asserted nothing.
    expect(calls).toBeGreaterThanOrEqual(AT_ONE_END.length);
  });

  it('every truck action asks a door: authorizeOnBatch, or authorize at one of the truck’s ends', () => {
    for (const [name, text] of truckActions) {
      const onBatch = callArgs(text, 'authorizeOnBatch');
      const atEnd = callArgs(text, 'authorize').filter((args) => /warehouseId:/.test(args));
      expect(onBatch.length + atEnd.length, name).toBeGreaterThan(0);
    }
  });

  it('the eight go through authorizeOnBatch with the permission they always had, and read no truck themselves', () => {
    for (const [name, permission] of Object.entries(ON_THE_TRUCK)) {
      const text = actions.get(name);
      expect(text, name).toBeDefined();
      expect(callArgs(text!, 'authorizeOnBatch'), name).toEqual([`'${permission}', batchId`]);
      expect(callArgs(text!, 'authorize'), name).toEqual([]);
      // The door hands the row back; a second read is a second chance to
      // read a different truck than the one the door judged.
      expect(text, name).not.toMatch(/\bbatches\.findFirst\(/);
      // A truck that is not there still returns quietly, as it always did.
      expect(text, name).toMatch(/if \(!door( \|\||\))/);
    }
  });
});

describe('the door itself', () => {
  const door = read(DOOR);

  it('asks the permission first, with NO warehouse — the card’s door is the warehouse half', () => {
    const auth = door.indexOf('await authorize(permission)');
    expect(auth).toBeGreaterThan(0);
    expect(auth).toBeLessThan(door.indexOf('batches.findFirst('));
    expect(callArgs(door, 'authorize')).toEqual(['permission']);
  });

  it('refuses through mayOpenBatchCard, in authorize’s own words — never a copy of the two-end rule', () => {
    expect(door).toContain('mayOpenBatchCard(actor, batch)');
    expect(door).toContain("new AuthError('Batch out of scope', 'forbidden')");
    expect(door.indexOf('assertOnBatchCard(actor, batch)')).toBeGreaterThan(door.indexOf('batches.findFirst('));
    expect(door).not.toMatch(/\binScope\(|warehouseIds|originWarehouseId|destWarehouseId/);
  });
});

describe('what the truck door cannot see — the other id in the same post', () => {
  const actions = exportedActions(ACTIONS);

  it('per-prixod customs: the receipt must be one of the rows the panel draws, before anything is written', () => {
    const text = actions.get('setReceiptCustomsAction')!;
    const rows = text.indexOf('batchCustomsRows(batchId)');
    const check = text.indexOf('row.receiptId === receiptId');
    const write = text.indexOf('setReceiptCustoms(receiptId');
    expect(rows).toBeGreaterThan(0);
    expect(check).toBeGreaterThan(rows);
    expect(write).toBeGreaterThan(check);
    expect(text).toContain("new AuthError('Receipt is not on this batch', 'forbidden')");
    // The list's membership, never one restated here.
    expect(text).not.toMatch(/riderFilter|batchMemberFilter|aboardFilter|currentBatchId/);
  });

  it('revoke: the phone must be THIS truck’s, before the service is called', () => {
    const text = actions.get('revokeDriverDeviceAction')!;
    const check = text.indexOf('device.batchId !== batch.id');
    expect(check).toBeGreaterThan(0);
    expect(text.indexOf('revokeDriverDevice(deviceId')).toBeGreaterThan(check);
    expect(text).toContain("new AuthError('Device is not on this batch', 'forbidden')");
  });

  it('TNVED: the truck’s card door and the lot’s membership, both before the photo is read or the model is paid', () => {
    const text = exportedActions(TNVED_ACTIONS).get('suggestTnvedForLotAction')!;
    expect(text).toMatch(/^export async function suggestTnvedForLotAction\(\s*batchId: string,\s*lotId: string,/);
    const permission = text.indexOf('await vedActor()');
    const card = text.indexOf('mayOpenBatchCard(actor, batch)');
    const member = text.indexOf('batchMemberFilter(batchId)');
    expect(permission).toBeGreaterThan(0);
    expect(card).toBeGreaterThan(permission);
    expect(member).toBeGreaterThan(card);
    expect(text).toContain('eq(boxes.lotId, lotId)');
    for (const spend of ['from(attachments)', 'getStorage()', 'suggestTnved({']) {
      expect(text.indexOf(spend), spend).toBeGreaterThan(member);
    }
  });

  it('TNVED: the editor sends the truck with every 🤖, and the page hands it the truck', () => {
    const editor = read(TNVED_EDITOR);
    expect(editor).toContain('suggestTnvedForLotAction(batchId, row.lotId)');
    expect(editor).toMatch(/export function TnvedEditor\(\{ batchId, rows: initial \}: \{ batchId: string;/);
    // A refusal is not «AI did not answer — try later».
    expect(editor).toContain("res.error === 'forbidden'");
    expect(editor).toContain("tc('forbidden')");
    expect(read(TNVED_PAGE)).toMatch(/<TnvedEditor\s[^>]*\bbatchId=\{/);
  });
});
