import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';

/**
 * The office receipt's four halves (0112, Q9 b; #531's rule): a service-level
 * test proves the service, not the wire. The page decides what is DRAWN from
 * the count door, the wizard posts the two fields only for the office, the
 * ACTION asks the door and says so to the service, and the service refuses
 * the fields whenever it was not said.
 */

const strip = (source: string) =>
  source.replace(/\/\*[\s\S]*?\*\//g, '').replace(/(^|[^:])\/\/.*$/gm, '$1');
const read = (file: string) => strip(readFileSync(file, 'utf8'));

describe('the office receipt, end to end on the wire', () => {
  it('the page draws the office row from the count door', () => {
    const page = read('src/app/(protected)/receive/page.tsx');
    expect(page).toMatch(/mayCountMove\(actor, wh\.id\)/);
    expect(page).toMatch(/office=\{/);
  });

  it('the wizard posts the receiver and the day ONLY for the office', () => {
    const wizard = read('src/app/(protected)/receive/receive-wizard.tsx');
    const post = wizard.slice(wizard.indexOf('const payload = {'), wizard.indexOf('extraCosts: []'));
    expect(post).toMatch(/\.\.\.\(canOnBehalf && receivedBy\s*\?/);
    expect(post).toContain('receivedBy,');
    expect(post).toContain('receivedDay:');
    // …and an office viewer starts with no warehouse chosen.
    expect(wizard).toMatch(/const firstWarehouse = canOnBehalf \? ''/);
  });

  it('the action asks the door at the posted warehouse and passes the answer', () => {
    const action = read('src/app/(protected)/receive/actions.ts');
    expect(action).toMatch(/mayCountMove\(actor, parsed\.data\.warehouseId\)/);
    expect(action).toMatch(/confirmReceipt\(parsed\.data, \{[^}]*\}, \{ onBehalf \}\)/);
    expect(action).toContain('isServerBehind(err)');
  });

  it('the service refuses the fields by default', () => {
    const service = read('src/modules/wms/receipts/service.ts');
    expect(service).toMatch(
      /if \(!opts\.onBehalf && \(input\.receivedDay \|\| input\.receivedBy\)\)\s*\{\s*throw new ReceiptError\('on_behalf_forbidden'\)/,
    );
    expect(service).toMatch(/if \(opts\.onBehalf && !input\.receivedBy\) throw new ReceiptError\('receiver_required'\)/);
  });

  it('the correction door asks the count door and the entry day, never the named receiver', () => {
    const edit = read('src/modules/wms/receipts/edit.ts');
    const door = edit.slice(edit.indexOf('export function mayCorrectReceived'), edit.indexOf('export async function setReceiptReceived'));
    expect(door).toContain('mayCountMove(actor, receipt.warehouseId)');
    expect(door).toContain('dayIn(receipt.createdAt, warehouseTimezone) === dayIn(now, warehouseTimezone)');
    expect(door).not.toContain('receivedByUserId');
    // canEditReceipt is NOT widened to the named receiver (decision 39).
    const canEdit = edit.slice(edit.indexOf('export function canEditReceipt'), edit.indexOf('function barcodeEdit'));
    expect(canEdit).not.toContain('receivedByUserId');
  });
});
