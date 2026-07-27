/**
 * The bot token the e2e run pretends to be.
 *
 * Shared by `playwright.config.ts` (which hands it to the server) and the
 * cabinet spec (which signs its `initData` with it), because the whole point
 * of the test is that both sides compute the same HMAC — two copies of a
 * literal would drift and the failure would look like a broken signature
 * check rather than a broken test.
 *
 * Fake, and local to a test run. The real one lives only in the server `.env`.
 */
export const E2E_BOT_TOKEN = '100200300:E2E-FAKE-BOT-TOKEN-NOT-A-REAL-ONE';
