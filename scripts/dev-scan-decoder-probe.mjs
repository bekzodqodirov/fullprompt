/**
 * Hold a real QR label in front of the real scan screen and MEASURE how long
 * it takes to read — including on the phone that could not read at all.
 *
 * The Kashgar warehouse reported the camera opening and no code ever being
 * read, while the same screen on the owner's phone worked (#626). Then the
 * owner reported the camera being slow: «bazida sekin o'qiyabti, QR ni
 * ko'rishi bilan o'qimayabti». Both need a camera, a video element and a
 * browser that decides for itself which barcode API it pretends to have, so no
 * unit test can see either. This is the smallest thing that reproduces them.
 *
 * It is a PROBE, not a test — it needs a running server, so it lives here
 * beside `dev-call-audio-probe.mjs` rather than in `tests/`. The decisions it
 * exercises are unit-tested in `tests/unit/scan-decoder-and-outbox.test.ts`
 * and `tests/unit/scanner-loop.test.ts`.
 *
 *   pnpm build && DATABASE_URL=…/<db> node scripts/start-standalone.mjs &
 *   node scripts/dev-scan-decoder-probe.mjs <warehouseId> [runs]
 *
 * The default mode writes NOTHING to the database: it opens the stocktake
 * screens (/inventory, «to'liq» and «bitta»), whose scanner gives physical
 * feedback on every code it reads, and times that feedback by wrapping
 * `navigator.vibrate`. So it measures the same thing on the build before a
 * change and the build after it, with no fixture.
 *
 *   node scripts/dev-scan-decoder-probe.mjs --unload <batchId> <boxShortCode>
 *
 * is the original end-to-end check (round 89): the unload counter must move.
 * It RESETS the batch's scans in the database named by DATABASE_URL, so run it
 * only against a throwaway one.
 *
 * Cases of the default mode, each on its own fresh browser profile:
 *   latency:*        first read after the picture starts (median / p90)
 *     none           no BarcodeDetector at all (iPhone Safari)
 *     kashgar        a BarcodeDetector that claims qr_code and reads nothing,
 *                    ever, without throwing — Android with no Play Services
 *                    barcode module
 *     honest         a BarcodeDetector that says it cannot read a QR
 *   remembered       the Kashgar phone opening the screen a SECOND time
 *   serial-slow      a detector that answers one call at a time, 300 ms each
 *                    (the platform's detection service is serial): how many
 *                    calls pile up behind each other
 *   pause-resume     «bitta» pauses the scanner while a code is on screen;
 *                    how long after «Bekor» the next code reads, and how many
 *                    times the camera was opened
 *   freeze           the camera track dies mid-shift (screen lock): is the
 *                    camera opened again
 *   two-codes        our label beside a supplier's URL QR: which one is read
 */
import { execSync } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import QRCode from 'qrcode';
// `@playwright/test`, not bare `playwright` — it is what this repo installs.
import { chromium } from '@playwright/test';

const BASE = process.env.PROBE_URL ?? 'http://127.0.0.1:3000';
const USER = process.env.PROBE_USER ?? '+998900000001';
const PASS = process.env.PROBE_PASS ?? 'demo1234';
const CHROME = process.env.PROBE_CHROME ?? '/opt/pw-browsers/chromium';
const OUR_CODE = process.env.PROBE_CODE ?? 'YW26-000123';
const SUPPLIER_URL = 'https://detail.tmall.com/item.htm?id=678901234567';

const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'scan-probe-'));

/**
 * Chromium's fake camera plays a Y4M file, so the QR has to become video.
 * Written by hand rather than shelled out to ffmpeg, which is not installed
 * on the machines this runs on: a white luma plane with each QR drawn black,
 * and flat 128 chroma. `draws` places codes in SOURCE pixels of a 1280×720
 * frame; the viewfinder shows the centred 720 square and the guide is 0.74 of
 * that (533 px), so everything drawn must sit inside x 374-906, y 94-626.
 */
function writeY4m(file, draws) {
  const W = 1280;
  const H = 720;
  const Y = new Uint8Array(W * H).fill(255);
  for (const d of draws) {
    const qr = QRCode.create(d.text, { errorCorrectionLevel: d.ecc ?? 'Q' });
    const size = qr.modules.size;
    const x0 = Math.round(d.cx - (size * d.scale) / 2);
    const y0 = Math.round(d.cy - (size * d.scale) / 2);
    for (let my = 0; my < size; my++) {
      for (let mx = 0; mx < size; mx++) {
        if (!qr.modules.data[my * size + mx]) continue;
        for (let dy = 0; dy < d.scale; dy++) {
          const row = (y0 + my * d.scale + dy) * W;
          for (let dx = 0; dx < d.scale; dx++) Y[row + x0 + mx * d.scale + dx] = 0;
        }
      }
    }
  }
  const chroma = new Uint8Array((W / 2) * (H / 2)).fill(128);
  const parts = [Buffer.from(`YUV4MPEG2 W${W} H${H} F30:1 Ip A1:1 C420jpeg\n`, 'ascii')];
  for (let i = 0; i < 30; i++) {
    parts.push(Buffer.from('FRAME\n', 'ascii'), Buffer.from(Y), Buffer.from(chroma), Buffer.from(chroma));
  }
  fs.writeFileSync(file, Buffer.concat(parts));
}

/**
 * Timestamps of what the page does, installed before any page script runs.
 * `vibrate` is the scan screens' physical feedback, fired once per code the
 * scanner hands them — the one signal both the old and the new scanner give.
 */
const INSTRUMENT = `
  window.__probe = { reads: [], playing: null, gum: 0, inFlight: 0, maxInFlight: 0,
                     detectCalls: 0, detectLat: [] };
  (() => {
    const md = navigator.mediaDevices;
    if (md && md.getUserMedia) {
      const orig = md.getUserMedia.bind(md);
      Object.defineProperty(md, 'getUserMedia', { configurable: true,
        value: (c) => { window.__probe.gum++; return orig(c); } });
    }
    Object.defineProperty(navigator, 'vibrate', { configurable: true,
      value: () => { window.__probe.reads.push(performance.now()); return true; } });
    document.addEventListener('playing', () => {
      if (window.__probe.playing === null) window.__probe.playing = performance.now();
    }, true);
  })();
`;

const LYING_DETECTOR = `
  window.BarcodeDetector = class {
    static getSupportedFormats() { return Promise.resolve(['qr_code', 'code_128']); }
    detect() { window.__probe.detectCalls++; return Promise.resolve([]); }
  };
`;
const HONEST_UNSUPPORTED = `
  window.BarcodeDetector = class {
    static getSupportedFormats() { return Promise.resolve(['ean_13']); }
    detect() { window.__probe.detectCalls++; return Promise.resolve([]); }
  };
`;
/**
 * A detector whose calls are served ONE AT A TIME, 300 ms each — a model of
 * the platform's detection service on a slow phone. It always reads our code,
 * so the only thing measured is how many calls the scanner stacks up.
 */
const SERIAL_SLOW_DETECTOR = `
  window.BarcodeDetector = class {
    static getSupportedFormats() { return Promise.resolve(['qr_code']); }
    detect() {
      const p = window.__probe;
      p.detectCalls++; p.inFlight++; p.maxInFlight = Math.max(p.maxInFlight, p.inFlight);
      const start = performance.now();
      const done = (window.__chain || Promise.resolve()).then(
        () => new Promise((r) => setTimeout(r, 300)));
      window.__chain = done;
      return done.then(() => {
        p.inFlight--; p.detectLat.push(performance.now() - start);
        return [{ rawValue: ${JSON.stringify(OUR_CODE)} }];
      });
    }
  };
`;

const probe = (page) => page.evaluate(() => window.__probe);
const decoderAttr = (page) =>
  page.evaluate(() => document.querySelector('[data-testid="scan-viewfinder"]')?.dataset.decoder ?? null);

async function newBrowser(y4m) {
  return chromium.launch({
    executablePath: CHROME,
    args: [
      '--use-fake-ui-for-media-stream',
      '--use-fake-device-for-media-stream',
      `--use-file-for-fake-video-capture=${y4m}`,
    ],
  });
}

let cookies = null;
/** One login per probe run; every case gets a fresh profile with only the session cookie. */
async function freshContext(browser, initScript) {
  if (!cookies) {
    const ctx = await browser.newContext();
    const page = await ctx.newPage();
    await page.goto(`${BASE}/login`);
    await page.locator('input[name="identifier"]').fill(USER);
    await page.locator('input[name="password"]').fill(PASS);
    await page.locator('main form button[type="submit"]').first().click();
    await page.waitForURL(`${BASE}/`);
    cookies = (await ctx.storageState()).cookies;
    await ctx.close();
  }
  const ctx = await browser.newContext({
    viewport: { width: 360, height: 800 },
    storageState: { cookies, origins: [] },
  });
  await ctx.grantPermissions(['camera'], { origin: BASE });
  await ctx.addInitScript(INSTRUMENT);
  if (initScript) await ctx.addInitScript(initScript);
  return ctx;
}

async function waitFor(page, pred, timeoutMs) {
  const end = Date.now() + timeoutMs;
  while (Date.now() < end) {
    const p = await probe(page);
    if (pred(p)) return p;
    await page.waitForTimeout(50);
  }
  return probe(page);
}

/** First read after the picture starts, in ms; null when nothing read in 15 s. */
async function firstRead(page) {
  const p = await waitFor(page, (x) => x.playing !== null && x.reads.length > 0, 15_000);
  if (p.playing === null || p.reads.length === 0) return null;
  return Math.round(p.reads[0] - p.playing);
}

const stats = (xs) => {
  const ok = xs.filter((x) => x !== null).sort((a, b) => a - b);
  if (!ok.length) return { n: xs.length, read: 0 };
  const at = (q) => ok[Math.min(ok.length - 1, Math.floor(q * ok.length))];
  return { n: xs.length, read: ok.length, p50: at(0.5), p90: at(0.9), min: ok[0], max: ok.at(-1) };
};

async function latencyCase(browser, wh, runs, initScript) {
  const out = [];
  for (let i = 0; i < runs; i++) {
    const ctx = await freshContext(browser, initScript);
    const page = await ctx.newPage();
    await page.goto(`${BASE}/inventory?warehouseId=${wh}&mode=full`);
    out.push(await firstRead(page));
    await ctx.close();
  }
  return stats(out);
}

async function rememberedCase(browser, wh) {
  const ctx = await freshContext(browser, LYING_DETECTOR);
  const page = await ctx.newPage();
  const url = `${BASE}/inventory?warehouseId=${wh}&mode=full`;
  await page.goto(url);
  const first = await firstRead(page);
  // Stay long enough for the hand-over to happen on this visit, then leave.
  await page.waitForTimeout(6000);
  const firstDecoder = await decoderAttr(page);
  await page.goto(`${BASE}/`);
  await page.goto(url);
  const second = await firstRead(page);
  await page.waitForTimeout(1500);
  const p = await probe(page);
  const result = {
    first,
    firstDecoder,
    second,
    secondDecoder: await decoderAttr(page),
    secondNativeCalls: p.detectCalls,
  };
  await ctx.close();
  return result;
}

async function serialSlowCase(browser, wh) {
  const ctx = await freshContext(browser, SERIAL_SLOW_DETECTOR);
  const page = await ctx.newPage();
  await page.goto(`${BASE}/inventory?warehouseId=${wh}&mode=full`);
  await waitFor(page, (x) => x.playing !== null, 15_000);
  await page.waitForTimeout(8000);
  const p = await probe(page);
  await ctx.close();
  return {
    detectCalls: p.detectCalls,
    maxInFlight: p.maxInFlight,
    lastCallLatencyMs: Math.round(p.detectLat.at(-1) ?? -1),
  };
}

async function pauseResumeCase(browser, wh, initScript) {
  const ctx = await freshContext(browser, initScript);
  const page = await ctx.newPage();
  await page.goto(`${BASE}/inventory?warehouseId=${wh}&mode=bitta`);
  const first = await firstRead(page);
  if (first === null) {
    await ctx.close();
    return { first: null };
  }
  await page.getByTestId('accept-pending').waitFor({ timeout: 5000 });
  // Past the scanner's own 2.5 s per-code cooldown, so the same code may read again.
  await page.waitForTimeout(3000);
  const before = (await probe(page)).reads.length;
  const t0 = await page.evaluate(() => performance.now());
  await page.locator('[data-testid="accept-pending"] button.btn-secondary').click();
  const p = await waitFor(page, (x) => x.reads.length > before, 15_000);
  const after = p.reads.length > before ? Math.round(p.reads[before] - t0) : null;
  await ctx.close();
  return { first, resumeToReadMs: after, cameraOpens: p.gum };
}

async function freezeCase(browser, wh) {
  const ctx = await freshContext(browser, null);
  const page = await ctx.newPage();
  await page.goto(`${BASE}/inventory?warehouseId=${wh}&mode=full`);
  const first = await firstRead(page);
  await page.evaluate(() => {
    const v = document.querySelector('[data-testid="scan-viewfinder"] video');
    v?.srcObject?.getVideoTracks().forEach((t) => t.stop());
  });
  const stoppedAt = (await probe(page)).reads.length;
  await page.waitForTimeout(8000);
  const p = await probe(page);
  await ctx.close();
  return { first, cameraOpens: p.gum, readsAfterFreeze: p.reads.length - stoppedAt };
}

async function twoCodesCase(browser, wh, runs) {
  const seen = [];
  for (let i = 0; i < runs; i++) {
    const ctx = await freshContext(browser, null);
    const page = await ctx.newPage();
    await page.goto(`${BASE}/inventory?warehouseId=${wh}&mode=bitta`);
    const first = await firstRead(page);
    let text = null;
    if (first !== null) {
      text = (await page.locator('[data-testid="accept-pending"] p.font-mono').textContent())?.trim() ?? null;
    }
    seen.push(first === null ? 'nothing' : text === OUR_CODE ? 'ours' : `foreign`);
    await ctx.close();
  }
  return seen.reduce((acc, s) => ({ ...acc, [s]: (acc[s] ?? 0) + 1 }), {});
}

// ---------------------------------------------------------------------------
// The original round-89 end-to-end mode.

async function unloadMode(batchId, boxCode) {
  const y4m = path.join(dir, 'unload.y4m');
  writeY4m(y4m, [{ text: boxCode, ecc: 'M', scale: 18, cx: 640, cy: 360 }]);
  /** Put the truck back on the road so every case starts from the same place. */
  const reset = () => {
    if (!process.env.DATABASE_URL) return;
    const sql = `
      DELETE FROM scan_events WHERE batch_id = '${batchId}';
      DELETE FROM box_movements WHERE ref_id = '${batchId}' AND cause <> 'batch_departed';
      UPDATE boxes SET status = 'in_transit', current_batch_id = '${batchId}'
       WHERE id IN (SELECT box_id FROM box_movements
                    WHERE ref_id = '${batchId}' AND cause = 'batch_departed');
      UPDATE batches SET status = 'in_transit', arrived_at = NULL WHERE id = '${batchId}';`;
    execSync(`psql "${process.env.DATABASE_URL}" -q -c "${sql.replace(/\n/g, ' ')}"`);
  };
  const browser = await newBrowser(y4m);
  const run = async (label, initScript) => {
    reset();
    const ctx = await freshContext(browser, initScript);
    const page = await ctx.newPage();
    await page.goto(`${BASE}/batches/${batchId}/unload`);
    await page.getByTestId('unload-counter').waitFor({ timeout: 20_000 });
    const before = (await page.getByTestId('unload-counter').textContent())?.trim();
    let decoded = false;
    for (let i = 0; i < 30 && !decoded; i++) {
      await page.waitForTimeout(1000);
      decoded = (await page.getByTestId('unload-counter').textContent())?.trim() !== before;
    }
    const calls = (await probe(page)).detectCalls;
    console.log(`[${label}] decoded=${decoded} nativeDetectCalls=${calls}`);
    await ctx.close();
    return decoded;
  };
  const results = {
    zxingPath: await run('zxing-path', null),
    kashgarPhone: await run('kashgar-phone', LYING_DETECTOR),
    honestUnsupported: await run('honest-unsupported', HONEST_UNSUPPORTED),
  };
  await browser.close();
  console.log(JSON.stringify(results));
  return Object.values(results).every(Boolean);
}

// ---------------------------------------------------------------------------

const args = process.argv.slice(2);
let ok = true;
if (args[0] === '--unload') {
  if (!args[1] || !args[2]) {
    console.error('usage: node scripts/dev-scan-decoder-probe.mjs --unload <batchId> <boxShortCode>');
    process.exit(2);
  }
  ok = await unloadMode(args[1], args[2]);
} else {
  const [wh, runsArg] = args;
  if (!wh) {
    console.error('usage: node scripts/dev-scan-decoder-probe.mjs <warehouseId> [runs]');
    process.exit(2);
  }
  const runs = Number(runsArg ?? 5);
  // A label at arm's length: 10 source px per module ≈ 12 px in the decoder's crop.
  const single = path.join(dir, 'single.y4m');
  writeY4m(single, [{ text: OUR_CODE, scale: 10, cx: 640, cy: 360 }]);
  // Ours at 5 px/module beside a supplier URL at 4, both inside the guide.
  const two = path.join(dir, 'two.y4m');
  writeY4m(two, [
    { text: OUR_CODE, scale: 5, cx: 480, cy: 330 },
    { text: SUPPLIER_URL, ecc: 'M', scale: 4, cx: 740, cy: 360 },
  ]);

  const results = {};
  let browser = await newBrowser(single);
  results['latency:none'] = await latencyCase(browser, wh, runs, null);
  results['latency:kashgar'] = await latencyCase(browser, wh, runs, LYING_DETECTOR);
  results['latency:honest'] = await latencyCase(browser, wh, runs, HONEST_UNSUPPORTED);
  results.remembered = await rememberedCase(browser, wh);
  results['serial-slow'] = await serialSlowCase(browser, wh);
  results['pause-resume:none'] = await pauseResumeCase(browser, wh, null);
  results['pause-resume:kashgar'] = await pauseResumeCase(browser, wh, LYING_DETECTOR);
  results.freeze = await freezeCase(browser, wh);
  await browser.close();
  browser = await newBrowser(two);
  results['two-codes'] = await twoCodesCase(browser, wh, runs);
  await browser.close();
  for (const [k, v] of Object.entries(results)) console.log(`${k.padEnd(22)} ${JSON.stringify(v)}`);
  ok = results['latency:none'].read === runs && results['latency:kashgar'].read === runs;
}
fs.rmSync(dir, { recursive: true, force: true });
if (!ok) process.exit(1);
