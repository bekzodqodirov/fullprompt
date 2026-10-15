/**
 * WHICH column of his tariff a truck's yo'lkira bill is split by — his 1a of
 * 2026-10-15: «bizning YW Guangzhou dan Toshkentga sotish narximiz bor»,
 * ONE table for EVERY truck, the ones leaving Kashgar and the internal legs
 * (Andijon → Toshkent) included. Nothing is written per warehouse any more
 * (the 2c door of 0132 is gone, docs/YOLKIRA-TAQSIMOT.md §15.1).
 *
 * The prices are only the RATIO between lots — the money split is the bill a
 * person typed — so one column on a truck whose own road it is not is right
 * by his own reading, not an approximation of it.
 *
 * Zero imports and a FUNCTION, not a const: the two callers (the save's
 * `prepareFreightCopy` and the preview's `freightOffer`) ask it at call time,
 * so an integration file can `vi.mock` this one module onto a private column
 * and never write a test row into the real `cn` one (a tariff row is
 * configuration that reprices seals in other files, #824/#183). Never a
 * setting: a setting is a door, and 1a removes the door.
 */
export function freightSplitZone(): string {
  return 'cn';
}
