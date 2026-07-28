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
    ]) {
      expect(block, param).toContain(param);
    }
    expect(block).toContain('shm_size:');
  });
});
