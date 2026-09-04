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
    // Anchored on the WRITE, not the log line beside it: the audit deleted
    // the whole last-attempt branch and every test stayed green, because the
    // assertions named `retryCount` and a message rather than the thing the
    // branch exists to do (#166 — a fence over a neighbour is not a fence).
    expect(jobs).toMatch(/last[\s\S]{0,400}failCustomsImport/);
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

/**
 * Comments STRIPPED before any of these look at the source.
 *
 * #725's lesson, met again in this file's own first run: the fence for «the
 * sweep no longer coalesces the two clocks» matched the SENTENCE in the
 * comment explaining why it must not, and reported the fix as missing.
 */
const bare = (src: string) =>
  src.replace(/\/\*[\s\S]*?\*\//g, '').replace(/(^|[^:])\/\/.*$/gm, '$1');
const serviceCode = bare(service);
const jobsCode = bare(jobs);

describe('a batch that is no longer this parse\'s', () => {
  it('the beat and the settle both fence on «still processing»', () => {
    // The sweep's verdict has to be FINAL in both directions: a parse it gave
    // up on must not go on writing its counter over the row, and must not
    // finish and flip a failed batch to READY two hours after the admin was
    // told to upload the file again — a ready batch is what every suggestion
    // in the company reads.
    const fences = serviceCode.match(/eq\(customsImportBatches\.status, 'processing'\)/g) ?? [];
    expect(fences.length).toBeGreaterThanOrEqual(2);
    // Both of them are on an UPDATE that writes the heartbeat, and both read
    // back whether they hit anything.
    const updates = serviceCode.match(/\.update\(customsImportBatches\)[\s\S]*?;/g) ?? [];
    const heartbeatWrites = updates.filter((u) => u.includes('heartbeatAt'));
    expect(heartbeatWrites.length).toBe(2);
    for (const write of heartbeatWrites) {
      expect(write).toContain("eq(customsImportBatches.status, 'processing')");
      expect(write).toContain('.returning(');
    }
  });

  it('a lost claim stops the parse and is neither retried nor written down', () => {
    expect(serviceCode).toMatch(/class BatchGoneError/);
    const branch = jobsCode.slice(
      jobsCode.indexOf('instanceof BatchGoneError'),
      jobsCode.indexOf('instanceof CustomsImportError'),
    );
    expect(branch.length).toBeGreaterThan(0);
    // There may be no row left to write on, and a person has already acted.
    expect(branch).not.toContain('failCustomsImport');
    expect(branch).toContain('continue');
  });

  it('one refused file never abandons the others in the same batch', () => {
    // pg-boss hands the handler an ARRAY. `return` walked out of the loop.
    expect(jobsCode).not.toMatch(/failCustomsImport\([\s\S]{0,200}?\breturn;/);
  });

  it('the sweep asks TWO questions, because waiting is not dying', () => {
    // The queue is serial: a second quarterly file uploaded behind the first
    // beats nothing for as long as the first one parses, and judging it by
    // its UPLOAD time called a blameless import dead at fifteen minutes.
    expect(serviceCode).toMatch(/heartbeat_at IS NOT NULL AND heartbeat_at </);
    expect(serviceCode).toMatch(/heartbeat_at IS NULL AND uploaded_at </);
    expect(serviceCode).not.toMatch(/COALESCE\(heartbeat_at, uploaded_at\)/);
  });

  it('the abort path releases the spooled worksheet too, and cannot hang doing it', () => {
    // A refused file used to keep its whole sheet in /tmp for the life of the
    // container — the same 57 MB the success path stopped leaking.
    expect(serviceCode).toMatch(/SPOOL_DRAIN_MS/);
    expect(serviceCode).toMatch(/setTimeout\(resolve, SPOOL_DRAIN_MS\)/);
  });
});
