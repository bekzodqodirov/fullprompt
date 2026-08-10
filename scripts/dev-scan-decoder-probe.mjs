/**
 * Hold a real QR label in front of the real scan screen and see whether it
 * reads — including on the phone that could not.
 *
 * The Kashgar warehouse reported the camera opening and no code ever being
 * read, while the same screen on the owner's phone worked. One codebase, two
 * devices, so the difference is a browser capability, and no unit test can
 * see it: it needs a camera, a video element and a browser that decides for
 * itself which barcode API it pretends to have. This is the smallest thing
 * that reproduces all three cases end to end.
 *
 * It is a PROBE, not a test — it needs a running server and a database it may
 * write to, so it lives here beside `dev-call-audio-probe.mjs` rather than in
 * `tests/`. The decisions it exercises are unit-tested in
 * `tests/unit/scan-decoder-and-outbox.test.ts`.
 *
 *   pnpm build && DATABASE_URL=…/gsr_ci node scripts/start-standalone.mjs &
 *   node scripts/dev-scan-decoder-probe.mjs <batchId> <boxShortCode>
 *
 * Three cases, each expected to end with the counter moving:
 *   zxing-path         no BarcodeDetector at all (iPhone Safari)
 *   kashgar-phone      BarcodeDetector that claims qr_code and reads nothing,
 *                      ever, without throwing — an Android with no Google
 *                      Play Services barcode module
 *   honest-unsupported BarcodeDetector that says it cannot read a QR
 */
import { execSync } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import QRCode from 'qrcode';
// `@playwright/test`, not bare `playwright` — it is what this repo installs.
import { chromium } from '@playwright/test';

const [batchId, boxCode] = process.argv.slice(2);
const BASE = process.env.PROBE_URL ?? 'http://127.0.0.1:3000';
const USER = process.env.PROBE_USER ?? '+998900000001';
const PASS = process.env.PROBE_PASS ?? 'demo1234';
const CHROME = process.env.PROBE_CHROME ?? '/opt/pw-browsers/chromium';
if (!batchId || !boxCode) {
  console.error('usage: node scripts/dev-scan-decoder-probe.mjs <batchId> <boxShortCode>');
  process.exit(2);
}

const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'scan-probe-'));
const y4m = path.join(dir, 'qr.y4m');

/**
 * Chromium's fake camera plays a Y4M file, so the QR has to become video.
 * Written by hand rather than shelled out to ffmpeg, which is not installed
 * on the machines this runs on: a white luma plane with the QR drawn black,
 * and flat 128 chroma.
 */
function writeY4m(text, file) {
  const W = 1280;
  const H = 720;
  const qr = QRCode.create(text, { errorCorrectionLevel: 'M' });
  const size = qr.modules.size;
  const scale = Math.floor(380 / size);
  const drawn = scale * size;
  const Y = new Uint8Array(W * H).fill(255);
  const x0 = Math.floor((W - drawn) / 2);
  const y0 = Math.floor((H - drawn) / 2);
  for (let my = 0; my < size; my++) {
    for (let mx = 0; mx < size; mx++) {
      if (!qr.modules.data[my * size + mx]) continue;
      for (let dy = 0; dy < scale; dy++) {
        const row = (y0 + my * scale + dy) * W;
        for (let dx = 0; dx < scale; dx++) Y[row + x0 + mx * scale + dx] = 0;
      }
    }
  }
  const chroma = new Uint8Array((W / 2) * (H / 2)).fill(128);
  const parts = [Buffer.from(`YUV4MPEG2 W${W} H${H} F15:1 Ip A1:1 C420jpeg\n`, 'ascii')];
  for (let i = 0; i < 30; i++) {
    parts.push(Buffer.from('FRAME\n', 'ascii'), Buffer.from(Y), Buffer.from(chroma), Buffer.from(chroma));
  }
  fs.writeFileSync(file, Buffer.concat(parts));
}

const LYING_DETECTOR = `
  window.__detectCalls = 0;
  window.BarcodeDetector = class {
    static getSupportedFormats() { return Promise.resolve(['qr_code', 'code_128']); }
    detect() { window.__detectCalls++; return Promise.resolve([]); }
  };
`;
const HONEST_UNSUPPORTED = `
  window.__detectCalls = 0;
  window.BarcodeDetector = class {
    static getSupportedFormats() { return Promise.resolve(['ean_13']); }
    detect() { window.__detectCalls++; return Promise.resolve([]); }
  };
`;

/** Put the truck back on the road so every case starts from the same place. */
function reset() {
  if (!process.env.DATABASE_URL) return;
  const sql = `
    DELETE FROM scan_events WHERE batch_id = '${batchId}';
    DELETE FROM box_movements WHERE ref_id = '${batchId}' AND cause <> 'batch_departed';
    UPDATE boxes SET status = 'in_transit', current_batch_id = '${batchId}'
     WHERE id IN (SELECT box_id FROM box_movements
                  WHERE ref_id = '${batchId}' AND cause = 'batch_departed');
    UPDATE batches SET status = 'in_transit', arrived_at = NULL WHERE id = '${batchId}';`;
  execSync(`psql "${process.env.DATABASE_URL}" -q -c "${sql.replace(/\n/g, ' ')}"`);
}

async function run(label, initScript) {
  reset();
  const browser = await chromium.launch({
    executablePath: CHROME,
    args: [
      '--use-fake-ui-for-media-stream',
      '--use-fake-device-for-media-stream',
      `--use-file-for-fake-video-capture=${y4m}`,
    ],
  });
  const ctx = await browser.newContext({ viewport: { width: 360, height: 800 } });
  await ctx.grantPermissions(['camera'], { origin: BASE });
  if (initScript) await ctx.addInitScript(initScript);
  const page = await ctx.newPage();
  await page.goto(`${BASE}/login`);
  await page.locator('input[name="identifier"]').fill(USER);
  await page.locator('input[name="password"]').fill(PASS);
  await page.locator('main form button[type="submit"]').first().click();
  await page.waitForURL(`${BASE}/`);
  await page.goto(`${BASE}/batches/${batchId}/unload`);
  await page.getByTestId('unload-counter').waitFor({ timeout: 20_000 });
  const before = (await page.getByTestId('unload-counter').textContent())?.trim();

  let decoded = false;
  for (let i = 0; i < 30 && !decoded; i++) {
    await page.waitForTimeout(1000);
    decoded = (await page.getByTestId('unload-counter').textContent())?.trim() !== before;
  }
  const calls = await page.evaluate(() => window.__detectCalls ?? null);
  console.log(`[${label}] decoded=${decoded} nativeDetectCalls=${calls} (${before} -> ${(await page.getByTestId('unload-counter').textContent())?.trim()})`);
  await browser.close();
  return decoded;
}

writeY4m(boxCode, y4m);
const results = {
  zxingPath: await run('zxing-path', null),
  kashgarPhone: await run('kashgar-phone', LYING_DETECTOR),
  honestUnsupported: await run('honest-unsupported', HONEST_UNSUPPORTED),
};
fs.rmSync(dir, { recursive: true, force: true });
console.log(JSON.stringify(results));
if (Object.values(results).some((ok) => !ok)) process.exit(1);
