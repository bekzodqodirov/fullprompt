import { describe, expect, it } from 'vitest';
import {
  FRESH_TRIAL,
  NATIVE_FORMATS,
  NATIVE_MIN_GAP_MS,
  PROOF_SPAN_MS,
  VERDICT_TTL_MS,
  handOverReason,
  nativeFormatsFor,
  nativeUsable,
  nextDelayMs,
  pickCodes,
  planAfterHandOver,
  planAfterNativeRead,
  rememberZxing,
  rememberedVerdict,
  shouldHandOver,
  startPlan,
  trialAt,
  trialStep,
  verdictEntry,
  verdictKey,
  type TrialFrame,
  type TrialState,
} from '@/components/scan/decoder-choice';
import { isOwnCodeShape, looksLikeRetailBarcode } from '@/offline/code-shape';
import { isSendableCode, MAX_PER_SYNC } from '@/offline/scan-outbox';

/**
 * The decisions behind «kamera ochilyapti, lekin QR o'qilmayapti» (#626), the
 * ones behind «bazida sekin o'qiyabti, QR ni ko'rishi bilan o'qimayabti» (the
 * QR-siz round), and the one behind a queue that stops draining. All were
 * reported from a real warehouse: the owner's own phone read codes while the
 * Kashgar warehouse's did not, on identical code.
 */

/** A trial at the given moment, with every field a caller does not name set to «nothing yet». */
const trial = (over: Partial<Parameters<typeof shouldHandOver>[0]>) => ({
  framesSeen: 0,
  nativeWorks: false,
  threw: false,
  trialFrames: 25,
  zxingProof: 0,
  sinceNativeOkMs: null,
  ...over,
});

/**
 * Feed a sequence of frames through the scanner's own fold and report the
 * first hand-over, if any — the same two calls the camera loop makes.
 */
function run(frames: TrialFrame[]): { at: number; reason: string } | null {
  let s: TrialState = FRESH_TRIAL;
  for (const f of frames) {
    s = trialStep(s, f);
    const reason = handOverReason(trialAt(s, f.at));
    if (reason) return { at: f.at, reason };
  }
  return null;
}

describe('which decoder the scanner runs', () => {
  it('uses the native detector when the browser cannot say (an old browser is not a refusal)', () => {
    expect(nativeUsable(undefined)).toBe(true);
  });

  it('refuses a detector that says it cannot read a QR', () => {
    expect(nativeUsable([])).toBe(false);
    expect(nativeUsable(['ean_13', 'code_128'])).toBe(false);
  });

  it('accepts a detector that says it can', () => {
    expect(nativeUsable(['qr_code', 'code_128'])).toBe(true);
  });

  it('hands over the moment detect() throws — one throw is the whole answer', () => {
    expect(shouldHandOver(trial({ framesSeen: 1, threw: true }))).toBe(true);
    expect(handOverReason(trial({ framesSeen: 1, threw: true }))).toBe('throw');
  });

  it('hands over after a barren trial: this is the Kashgar phone, which never throws', () => {
    expect(shouldHandOver(trial({ framesSeen: 24, sinceNativeOkMs: 4500 }))).toBe(false);
    expect(shouldHandOver(trial({ framesSeen: 25, sinceNativeOkMs: 4500 }))).toBe(true);
    expect(handOverReason(trial({ framesSeen: 25, sinceNativeOkMs: 4500 }))).toBe('backstop');
  });

  it('does not shorten the barren trial because the loop got faster', () => {
    // 25 frames at the new pace is 1.7 s — an operator still lifting the phone.
    expect(shouldHandOver(trial({ framesSeen: 25, sinceNativeOkMs: 1700 }))).toBe(false);
    expect(shouldHandOver(trial({ framesSeen: 200, sinceNativeOkMs: 4499 }))).toBe(false);
  });

  it('never takes a working detector away, however long the next box takes', () => {
    expect(shouldHandOver(trial({ framesSeen: 10_000, nativeWorks: true, sinceNativeOkMs: 1e6 }))).toBe(false);
    // Even a throw after it has proved itself: it read codes, it will again.
    expect(shouldHandOver(trial({ framesSeen: 10_000, nativeWorks: true, threw: true }))).toBe(false);
    // And no amount of library proof outweighs one native read.
    expect(shouldHandOver(trial({ nativeWorks: true, zxingProof: 99, sinceNativeOkMs: 1e6 }))).toBe(false);
  });
});

describe('the proof trial (native and the library on the same frames)', () => {
  it('a native detector warming up ([] three times, slowly, then reads) is never handed over', () => {
    // A platform model still loading answers [] and answers late — three
    // empty frames 800 ms apart while the operator is already aiming.
    const frames: TrialFrame[] = [
      { at: 0, native: 'empty', libraryOwn: true },
      { at: 800, native: 'empty', libraryOwn: true },
      { at: 1600, native: 'empty', libraryOwn: true },
      { at: 2400, native: 'read', libraryOwn: true },
      { at: 2466, native: 'read', libraryOwn: true },
    ];
    expect(run(frames)).toBeNull();
  });

  it('five proofs in less than 1.5 s do not hand over — a warm-up is fast too', () => {
    const fast: TrialFrame[] = Array.from({ length: 20 }, (_, i) => ({
      at: i * NATIVE_MIN_GAP_MS,
      native: 'empty' as const,
      libraryOwn: true,
    }));
    expect(fast.at(-1)!.at).toBeLessThan(PROOF_SPAN_MS);
    expect(run(fast)).toBeNull();
  });

  it('the Kashgar phone: proof over 1.5 s hands the visit to the library', () => {
    const frames: TrialFrame[] = Array.from({ length: 40 }, (_, i) => ({
      at: i * NATIVE_MIN_GAP_MS,
      native: 'empty' as const,
      libraryOwn: true,
    }));
    const handed = run(frames);
    expect(handed).toEqual({ at: expect.any(Number), reason: 'proof' });
    expect(handed!.at).toBeGreaterThanOrEqual(PROOF_SPAN_MS);
    // …and it is far sooner than the 4.5 s the old barren trial waited.
    expect(handed!.at).toBeLessThan(2000);
  });

  it('a frame where the library read nothing is no proof, and neither is one native did not look at', () => {
    let s = trialStep(FRESH_TRIAL, { at: 0, native: 'empty', libraryOwn: false });
    s = trialStep(s, { at: 66, native: 'threw', libraryOwn: true });
    expect(s.zxingProof).toBe(0);
    s = trialStep(s, { at: 132, native: 'read', libraryOwn: true });
    expect(s.zxingProof).toBe(0);
  });

  it('the clock starts at native\'s first answer that did not throw', () => {
    const s = trialStep(trialStep(FRESH_TRIAL, { at: 100, native: 'threw', libraryOwn: false }), {
      at: 500,
      native: 'empty',
      libraryOwn: false,
    });
    expect(s.nativeOkAt).toBe(500);
    expect(trialAt(s, 2000).sinceNativeOkMs).toBe(1500);
  });
});

describe('what a visit leaves behind', () => {
  it('never remembers the library on the ambiguous timeout alone', () => {
    // The operator took five seconds to aim: native stopped at the backstop,
    // the library read the first carton, and native never saw it.
    expect(
      rememberZxing({ nativeReads: 0, handedOver: 'backstop', zxingOwnReads: 3, zxingProof: 0 }),
    ).toBe(false);
    expect(rememberZxing({ nativeReads: 0, handedOver: null, zxingOwnReads: 9, zxingProof: 9 })).toBe(false);
  });

  it('remembers the library on evidence', () => {
    expect(rememberZxing({ nativeReads: 0, handedOver: 'proof', zxingOwnReads: 5, zxingProof: 5 })).toBe(true);
    expect(rememberZxing({ nativeReads: 0, handedOver: 'backstop', zxingOwnReads: 2, zxingProof: 1 })).toBe(true);
    expect(rememberZxing({ nativeReads: 0, handedOver: 'throw', zxingOwnReads: 1, zxingProof: 0 })).toBe(true);
  });

  it('never remembers the library when native read anything, or when the library read none of ours', () => {
    expect(rememberZxing({ nativeReads: 1, handedOver: 'proof', zxingOwnReads: 5, zxingProof: 5 })).toBe(false);
    expect(rememberZxing({ nativeReads: 0, handedOver: 'throw', zxingOwnReads: 0, zxingProof: 0 })).toBe(false);
  });

  it('reads a verdict back only for the same browser, within three days', () => {
    const ua = 'Mozilla/5.0 (Linux; Android 13) Chrome/128';
    const at = 1_800_000_000_000;
    const stored = verdictEntry('zxing', ua, at);
    expect(rememberedVerdict(stored, ua, at + 1000)).toBe('zxing');
    expect(rememberedVerdict(verdictEntry('native', ua, at), ua, at + VERDICT_TTL_MS)).toBe('native');
    // An updated browser is a different decoder.
    expect(rememberedVerdict(stored, `${ua}.1`, at + 1000)).toBeNull();
    // Expired: a barcode module may have arrived since.
    expect(rememberedVerdict(stored, ua, at + VERDICT_TTL_MS + 1)).toBeNull();
    // Dated in the future: a clock that jumped is not evidence.
    expect(rememberedVerdict(stored, ua, at - 1)).toBeNull();
  });

  it('treats anything unreadable as no verdict at all', () => {
    const ua = 'x';
    expect(rememberedVerdict(null, ua, 0)).toBeNull();
    expect(rememberedVerdict('{not json', ua, 0)).toBeNull();
    expect(rememberedVerdict('"zxing"', ua, 0)).toBeNull();
    expect(rememberedVerdict(JSON.stringify({ v: 'wasm', ua, at: 0 }), ua, 0)).toBeNull();
    expect(rememberedVerdict(JSON.stringify({ v: 'zxing', ua, at: '0' }), ua, 0)).toBeNull();
  });

  it('keeps one verdict per mode — a QR proof says nothing about EAN', () => {
    expect(verdictKey('qr')).toBe('gsr.scan.decoder.qr');
    expect(verdictKey('retail')).toBe('gsr.scan.decoder.retail');
  });
});

describe('the plan a visit runs', () => {
  it('starts from what is remembered', () => {
    expect(startPlan(null, true)).toBe('both');
    expect(startPlan('native', true)).toBe('native');
    expect(startPlan('zxing', true)).toBe('zxing');
    expect(startPlan(null, false)).toBe('zxing');
    expect(startPlan('native', false)).toBe('zxing');
  });

  it('a remembered native that goes quiet is out-proved, not dropped', () => {
    expect(planAfterHandOver('native', 'backstop')).toBe('both');
    expect(planAfterHandOver('native', 'throw')).toBe('zxing');
    expect(planAfterHandOver('both', 'proof')).toBe('zxing');
    expect(planAfterHandOver('both', 'backstop')).toBe('zxing');
  });

  it('stops the library once native has read', () => {
    expect(planAfterNativeRead('both')).toBe('native');
    expect(planAfterNativeRead('native')).toBe('native');
  });

  it('paces native at fifteen a second and keeps the main thread at least half free', () => {
    expect(nextDelayMs(5, 'native')).toBe(66);
    expect(nextDelayMs(20, 'main')).toBe(66);
    expect(nextDelayMs(40, 'main')).toBe(80);
  });
});

describe('what the camera reads', () => {
  it('reads QR and nothing else on the hot path', () => {
    // A courier waybill is a Code 128 whose number passes isSendableCode.
    expect([...NATIVE_FORMATS]).toEqual(['qr_code']);
    expect(nativeFormatsFor('qr')).toEqual(['qr_code']);
  });

  it('reads a factory barcode only when asked to, and our QR beside it', () => {
    const retail = nativeFormatsFor('retail');
    for (const f of ['ean_13', 'ean_8', 'upc_a', 'upc_e', 'itf', 'code_128', 'qr_code']) {
      expect(retail).toContain(f);
    }
    expect(nativeUsable(['qr_code'], 'retail')).toBe(false);
    expect(nativeUsable(['ean_13', 'qr_code'], 'retail')).toBe(true);
  });

  it('within one frame hands over our label and nothing else', () => {
    const url = 'https://detail.tmall.com/item.htm?id=678901234567';
    expect(pickCodes([url, ' yw26-000123 '], isOwnCodeShape)).toEqual(['YW26-000123']);
    expect(pickCodes(['CR-YW26-00007', url], isOwnCodeShape)).toEqual(['CR-YW26-00007']);
  });

  it('still hands over a frame of only foreign codes, so the screen can say «begona QR»', () => {
    const url = 'https://detail.tmall.com/item.htm?id=678901234567';
    expect(pickCodes([url], isOwnCodeShape)).toEqual([url.toUpperCase()]);
  });

  it('collapses the same code read twice in one frame', () => {
    expect(pickCodes(['YW26-000123', 'yw26-000123', ''], isOwnCodeShape)).toEqual(['YW26-000123']);
  });

  it('in retail mode prefers the factory barcode over our label', () => {
    expect(pickCodes(['YW26-000123', '4601234567893'], looksLikeRetailBarcode)).toEqual(['4601234567893']);
  });
});

describe('what may be put in the outbox', () => {
  it('accepts a box code and a crate code', () => {
    expect(isSendableCode('YW26-000123')).toBe(true);
    expect(isSendableCode('CR-YW26-00007')).toBe(true);
  });

  it('refuses a supplier QR — a URL is not a short code, and the server 400s the whole body', () => {
    expect(isSendableCode('https://detail.tmall.com/item.htm?id=678901234567')).toBe(false);
  });

  it('refuses something too short to be anything', () => {
    expect(isSendableCode('A')).toBe(false);
    expect(isSendableCode('   ')).toBe(false);
  });

  it('is exactly the server\'s own bound, so nothing sendable is refused here', () => {
    expect(isSendableCode('X'.repeat(40))).toBe(true);
    expect(isSendableCode('X'.repeat(41))).toBe(false);
  });

  it('slices at the ceiling the sync route validates against', () => {
    expect(MAX_PER_SYNC).toBe(200);
  });
});
