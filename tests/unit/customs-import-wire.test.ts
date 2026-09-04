import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';
import { CustomsImportError } from '@/modules/wms/customs/import-service';
import { importFailureText } from '@/modules/wms/customs/jobs';
import { WORKER_REGISTRATIONS } from '@/modules/platform/jobs/boss';

/**
 * The wiring behind «читается» — the state two of his uploads were stuck in.
 *
 * Source-shape where the fact is a wire and not a behaviour: the sweep only
 * runs if this process registers it, the job only gets its two hours if the
 * upload asks for them, and neither can be reached by a service-level test
 * of the functions themselves (#531).
 */
const jobs = readFileSync('src/modules/wms/customs/jobs.ts', 'utf8');
const service = readFileSync('src/modules/wms/customs/import-service.ts', 'utf8');
const route = readFileSync('src/app/api/admin/customs-import/route.ts', 'utf8');

describe('the import says what happened to it', () => {
  it('every refusal the parser can raise has a sentence — derived from the union', () => {
    // The reasons are a literal union in the service, so the fence READS
    // them: a fifth reason added tomorrow turns this red on the day it is
    // written, not on the day somebody uploads a file that hits it.
    const union = service.match(/readonly reason:\s*([^,]+),/)?.[1] ?? '';
    const reasons = [...union.matchAll(/'([a-z_]+)'/g)].map((m) => m[1]!);
    expect(reasons.length).toBeGreaterThanOrEqual(4);
    for (const reason of reasons) {
      const text = importFailureText(new CustomsImportError(reason as 'no_rows'));
      expect(text, reason).toBeTruthy();
      // A code is not a sentence. The admin who uploaded the file reads this.
      expect(text, reason).not.toContain(reason);
    }
  });

  it('the sweep is a worker this process actually registers', () => {
    const names = WORKER_REGISTRATIONS.map(([name]) => name);
    expect(names).toContain('customs-import');
    expect(names).toContain('customs-import-sweep');
  });

  it('the sweep is on a clock, not on a request', () => {
    expect(jobs).toMatch(/boss\.schedule\(JOB_CUSTOMS_IMPORT_SWEEP/);
  });

  it('the worker asks for the metadata that tells it this is the last attempt', () => {
    // Without `includeMetadata` the handler cannot know it will not run
    // again, and the failure that killed two of his uploads is written
    // nowhere at all.
    expect(jobs).toMatch(/includeMetadata:\s*true/);
    expect(jobs).toMatch(/retryCount/);
  });

  it('the upload gives the parse its own expiry and retry budget', () => {
    // pg-boss expires a claimed job after fifteen minutes by default and
    // retries it five times. Half a million declaration rows is neither
    // shape: measured at 83 s here, and six re-reads of an 80 MB file before
    // anybody is told anything is not a budget, it is a silence.
    expect(route).toContain('JOB_CUSTOMS_IMPORT');
    expect(route).toMatch(/expireInSeconds:/);
    expect(route).toMatch(/retryLimit:/);
  });

  it('the parse beats on a wall clock, never on a row count', () => {
    // A file smaller than one row-step showed «0» from the first second to
    // the last, and a file that died on row three showed exactly the same.
    expect(service).toMatch(/HEARTBEAT_MS/);
    expect(service).not.toMatch(/PROGRESS_EVERY/);
  });
});
