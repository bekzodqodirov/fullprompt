import { describe, expect, it } from 'vitest';
import { nativeUsable, shouldHandOver } from '@/components/scan/decoder-choice';
import { isSendableCode, MAX_PER_SYNC } from '@/offline/scan-outbox';

/**
 * The two decisions behind «kamera ochilyapti, lekin QR o'qilmayapti», and the
 * one behind a queue that stops draining. All three were reported from a real
 * warehouse: the owner's own phone read codes while the Kashgar warehouse's
 * did not, on identical code.
 */
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
    expect(
      shouldHandOver({ framesSeen: 1, nativeWorks: false, threw: true, trialFrames: 25 }),
    ).toBe(true);
  });

  it('hands over after a barren trial: this is the Kashgar phone, which never throws', () => {
    expect(
      shouldHandOver({ framesSeen: 24, nativeWorks: false, threw: false, trialFrames: 25 }),
    ).toBe(false);
    expect(
      shouldHandOver({ framesSeen: 25, nativeWorks: false, threw: false, trialFrames: 25 }),
    ).toBe(true);
  });

  it('never takes a working detector away, however long the next box takes', () => {
    expect(
      shouldHandOver({ framesSeen: 10_000, nativeWorks: true, threw: false, trialFrames: 25 }),
    ).toBe(false);
    // Even a throw after it has proved itself: it read codes, it will again.
    expect(
      shouldHandOver({ framesSeen: 10_000, nativeWorks: true, threw: true, trialFrames: 25 }),
    ).toBe(false);
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
