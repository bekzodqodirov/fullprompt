import { readFileSync } from 'node:fs';
import path from 'node:path';
import { describe, expect, it } from 'vitest';

/**
 * Regression tripwire, not the proof. The proof is `SHOW shared_buffers` on
 * the server (docs/DEPLOY.md); this spec only pins that docker-compose.yml
 * keeps carrying the tuned `command:` — production ran the stock image's
 * 2005-era defaults (shared_buffers=128MB, random_page_cost=4) for months
 * because nothing anywhere set a single server parameter.
 */
describe('postgres tuning in docker-compose.yml', () => {
  const compose = readFileSync(path.join(__dirname, '../../docker-compose.yml'), 'utf8');
  // The service block: from `  postgres:` to the next 2-space-indented key.
  const block = /\n {2}postgres:\n([\s\S]*?)(?=\n {2}\S)/.exec(compose)?.[1] ?? '';

  it('overrides CMD with the binary name first — compose command REPLACES it', () => {
    // Without 'postgres' as the first list item the container never starts
    // and the whole stack (app depends_on service_healthy) stays down.
    expect(block).toMatch(/command:\n\s+- 'postgres'/);
  });

  it('carries every tuned parameter and the shm allowance', () => {
    for (const param of [
      'shared_buffers=',
      'effective_cache_size=',
      'work_mem=',
      'maintenance_work_mem=',
      'max_wal_size=',
      'random_page_cost=',
      // Round 45: the slow-query log is how the next N+1 gets found. Without
      // it the only evidence a page is slow is somebody saying so.
      'log_min_duration_statement=',
      // The finance-audit round: JIT compiled a second of machine code for
      // statements that run in milliseconds (three measurements in the
      // compose comment). `withoutJit` covers the hottest reads either way.
      'jit=off',
    ]) {
      expect(block, param).toContain(param);
    }
    expect(block).toContain('shm_size:');
  });
});

/**
 * B9 — the container settings that make the system heal itself. Tripwires
 * like the block above: the proof is `docker inspect` on the server, this only
 * pins that the file keeps saying it.
 */
describe('the self-healing half of docker-compose.yml (B9)', () => {
  const compose = readFileSync(path.join(__dirname, '../../docker-compose.yml'), 'utf8');
  const services = compose.slice(compose.indexOf('\nservices:\n'), compose.indexOf('\nvolumes:\n'));
  const blockOf = (name: string) =>
    new RegExp(`\\n {2}${name}:\\n([\\s\\S]*?)(?=\\n {2}\\S|$)`).exec(services)?.[1] ?? '';

  it('postgres ends a transaction left idle for a minute — #714 broken from the database side', () => {
    expect(blockOf('postgres')).toContain("'idle_in_transaction_session_timeout=60s'");
  });

  it('the app runs under an init and carries the watchdog probe', () => {
    const app = blockOf('app');
    // Without tini node is PID 1, and PID 1 cannot be killed from inside.
    expect(app).toMatch(/\n {4}init: true\n/);
    expect(app).toMatch(/healthcheck:\n\s+test: \['CMD', 'node', '\/app\/ops\/health-probe\.mjs'\]/);
    // The photo disk, read-only, for the disk watch.
    expect(app).toContain('- miniodata:/minio-data:ro');
    const docker = readFileSync(path.join(__dirname, '../../Dockerfile'), 'utf8');
    expect(docker).toContain('COPY --from=build /app/ops/health-probe.mjs ./ops/health-probe.mjs');
  });

  it('every service caps its log — derived from the service list, so a new one must too', () => {
    const names = [...services.matchAll(/\n {2}([a-z][a-z0-9-]*):\n/g)].map((m) => m[1]!);
    expect(names.length).toBeGreaterThan(5);
    for (const name of names) expect(blockOf(name), name).toMatch(/\n {4}logging: \*logging\n/);
    expect(compose).toMatch(/x-logging: &logging\n {2}driver: json-file\n {2}options:\n {4}max-size: '10m'/);
  });
});
