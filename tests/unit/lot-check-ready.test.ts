import { beforeEach, describe, expect, it, vi } from 'vitest';

/**
 * The probe that tells every list which migrations have landed — five
 * answers from ONE statement (0122/0123, 0144, 0146, and 0147's two: the
 * tick's measures and the notices' remembered question).
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
type Answer = { ok: boolean; client: boolean; measures: boolean; tick: boolean; asked: boolean };
const answers: Answer[] = [];
const ALL: Answer = { ok: true, client: true, measures: true, tick: true, asked: true };
let asked = 0;

vi.mock('@/modules/platform/db/client', () => ({
  db: {
    execute: async () => {
      asked += 1;
      return [answers.shift() ?? ALL];
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
    answers.push({ ...ALL, measures: false }, { ...ALL, measures: false }, ALL);
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
    answers.push({ ...ALL, client: false }, { ...ALL, client: false });
    const probe = await load();
    expect(await probe.lotChecksReady()).toBe(true);
    expect(probe.lotClientMeasuresReady()).toBe(false);
    expect(await probe.clientMeasuresReady()).toBe(false);
    expect(asked).toBe(2);
  });

  it('0147 missing: the tick and the notices speak 0146, and «no» is asked again until it lands', async () => {
    answers.push({ ...ALL, tick: false, asked: false }, { ...ALL, tick: false, asked: false }, ALL);
    const probe = await load();
    expect(await probe.lotChecksReady()).toBe(true);
    expect(probe.lotTickMeasuresReady()).toBe(false);
    expect(await probe.tickMeasuresReady()).toBe(false);
    expect(asked).toBe(2);
    // The repaired migration, no restart: both of 0147's answers flip together.
    expect(await probe.askedTagReady()).toBe(true);
    expect(probe.lotTickMeasuresReady()).toBe(true);
    expect(asked).toBe(3);
    await probe.lotChecksReady();
    expect(asked).toBe(3);
  });

  it('the tick’s measures need the check tables, never the client’s: 0144 missing keeps the tick term', async () => {
    answers.push({ ...ALL, client: false });
    const probe = await load();
    await probe.lotChecksReady();
    expect(probe.lotClientConfirmsReady()).toBe(false);
    expect(probe.lotTickMeasuresReady()).toBe(true);
  });
});
