import { defineConfig } from 'vitest/config';
import path from 'node:path';

export default defineConfig({
  test: {
    include: ['src/**/*.test.ts', 'tests/unit/**/*.test.ts', 'tests/integration/**/*.test.ts'],
    fileParallelism: false,
    environment: 'node',
    // Most of this suite talks to a real Postgres: a single case can walk a
    // receipt, a plan, scans, a departure and a cost recompute. Those land
    // around 3–5 s, so the 5 s default turns ordinary load into a flake —
    // and a timeout that fires on a healthy test teaches people to re-run
    // instead of to look.
    testTimeout: 20_000,
    // The factory map's geocoder and router are public services this
    // container cannot reach and the CI runner can (#278): the suite must
    // resolve the same in both, so it never calls out (pickups/geo-fetch.ts).
    env: { GEO_NETWORK: 'off' },
  },
  resolve: {
    alias: {
      '@': path.resolve(__dirname, 'src'),
    },
  },
});
