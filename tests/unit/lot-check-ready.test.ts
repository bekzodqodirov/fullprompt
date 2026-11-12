import { beforeEach, describe, expect, it, vi } from 'vitest';

/**
 * The probe that tells every list which migrations have landed — three
 * answers from ONE statement (0122/0123, 0144, 0146).
 *
 * It remembers a «yes» and asks a «no» again every time, so the screens come
 * back the moment a repaired migration lands, with no restart. The trap the
 * third answer walked into: the early return read the first two flags only,
 * so a process that had seen 0144 and not 0146 NEVER asked again — after
 * `docker compose run --rm migrate` the customers went on being asked the
 * old question for ever, with the ledger and the build stamp both right.
 * No integration test can see it: each file mocks this module, or starts on
 * a database that already has everything.
 */
const answers: { ok: boolean; client: boolean; measures: boolean }[] = [];
let asked = 0;

vi.mock('@/modules/platform/db/client', () => ({
  db: {
    execute: async () => {
      asked += 1;
      return [answers.shift() ?? { ok: true, client: true, measures: true }];
    },
  },
}));

async function load() {
  vi.resetModules();
  return import('@/modules/wms/receipts/lot-check-ready');
}

beforeEach(() => {
  answers.length = 0;
  asked = 0;
});

describe('the three answers', () => {
  it('a server that has everything is asked once', async () => {
    const probe = await load();
    expect(await probe.lotChecksReady()).toBe(true);
    expect(probe.lotClientMeasuresReady()).toBe(true);
    await probe.lotChecksReady();
    await probe.clientMeasuresReady();
    expect(asked).toBe(1);
  });

  it('0146 missing: «no» is asked again on every call — and the answer flips the moment the migration lands', async () => {
    answers.push({ ok: true, client: true, measures: false }, { ok: true, client: true, measures: false }, { ok: true, client: true, measures: true });
    const probe = await load();
    expect(await probe.lotChecksReady()).toBe(true);
    expect(probe.lotClientMeasuresReady()).toBe(false);
    expect(await probe.clientMeasuresReady()).toBe(false);
    expect(asked).toBe(2);
    // `docker compose run --rm migrate`, no restart:
    expect(await probe.clientMeasuresReady()).toBe(true);
    expect(probe.lotClientMeasuresReady()).toBe(true);
    expect(asked).toBe(3);
    // …and only now is it remembered.
    await probe.lotChecksReady();
    expect(asked).toBe(3);
  });

  it('0144 missing: the client’s side is off, and so are its measures — whatever the catalogue says', async () => {
    // Asked twice (a «no» is never remembered), answered the same both times.
    answers.push({ ok: true, client: false, measures: true }, { ok: true, client: false, measures: true });
    const probe = await load();
    expect(await probe.lotChecksReady()).toBe(true);
    expect(probe.lotClientMeasuresReady()).toBe(false);
    expect(await probe.clientMeasuresReady()).toBe(false);
    expect(asked).toBe(2);
  });
});
