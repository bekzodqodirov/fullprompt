import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';

/**
 * Every ending of a calc job retires its task's Telegram copies, with the
 * outcome the task itself records (review integration-5).
 *
 * The seal half is proven in the database (ved-tarix.integration: a queued
 * copy is muted by the seal); what a database cannot see without a live bot
 * is WHERE the call sits and WHICH outcome line a sent copy gains, so those
 * two are pinned by source shape. Comments stripped first (#725).
 */
const strip = (s: string) => s.replace(/\/\*[\s\S]*?\*\//g, '').replace(/(^|[^:])\/\/.*$/gm, '$1');
const read = (path: string) => strip(readFileSync(path, 'utf8'));

describe('the seal retires its task after its transaction commits', () => {
  const ws = read('src/modules/wms/calc/workspace.ts');
  const seal = ws.slice(ws.indexOf('export async function sealCalc('), ws.indexOf('\nasync function announceSeal('));

  it('the transaction hands the closed task out, and the retire follows the commit', () => {
    expect(seal.length).toBeGreaterThan(1000);
    const tx = seal.indexOf('await db.transaction(async (tx) =>');
    const commit = seal.indexOf('\n  });', tx);
    const retire = seal.indexOf("retireTaskCopiesSoon({ taskIds: [result.taskId], outcome: 'done' })");
    expect(tx).toBeGreaterThan(-1);
    expect(seal.slice(tx, commit)).toContain('taskId: row.taskId');
    expect(retire, 'the seal must retire its task’s copies').toBeGreaterThan(commit);
  });
});

describe('a hand-back is not «✅ Bajarildi»', () => {
  it('endRequest retires a returned job’s task as cancelled', () => {
    const service = read('src/modules/wms/calc/service.ts');
    const end = service.slice(service.indexOf('async function endRequest('));
    const body = end.slice(0, end.indexOf('\n}\n'));
    expect(body).toContain("result: patch.via === 'returned' ? 'Qaytarildi' : 'Hisoblandi'");
    expect(body).toContain("outcome: patch.via === 'returned' ? 'cancelled' : 'done'");
  });
});
