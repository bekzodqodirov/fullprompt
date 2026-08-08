import { describe, expect, it } from 'vitest';
import {
  MAX_TG_AUDIO_BYTES,
  MAX_TG_PHOTO_BYTES,
  tgMediaPlan,
} from '@/modules/wms/crm/telegram-import';

/**
 * What comes out of a client's chat, now that a voice note counts (owner,
 * 2026-08-07: «audio habarlar bizni sistemada korinmayabti»).
 *
 * The listener fetched `MessageMediaPhoto` and nothing else, so a client's
 * spoken message reached the manager's Telegram and the CRM printed «📎» —
 * a record of the conversation with a hole exactly where the client said what
 * they wanted.
 *
 * Structural, like the photo plan it extends: no gramjs objects, and every
 * decision made from the message alone BEFORE any network I/O.
 */

const voice = (over: Record<string, unknown> = {}) => ({
  className: 'MessageMediaDocument',
  document: {
    mimeType: 'audio/ogg',
    size: 42_000,
    attributes: [{ className: 'DocumentAttributeAudio', voice: true, duration: 7 }],
    ...over,
  },
});

const audioFile = (over: Record<string, unknown> = {}) => ({
  className: 'MessageMediaDocument',
  document: {
    mimeType: 'audio/mpeg',
    size: 3_000_000,
    attributes: [
      { className: 'DocumentAttributeAudio', duration: 128 },
      { className: 'DocumentAttributeFilename', fileName: 'narx.mp3' },
    ],
    ...over,
  },
});

describe('a voice note is fetched and named', () => {
  it('the ordinary case: opus in ogg, seven seconds', () => {
    expect(tgMediaPlan(voice(), 55)).toEqual({
      kind: 'voice',
      download: true,
      approxBytes: 42_000,
      contentType: 'audio/ogg',
      fileName: 'voice_55.oga',
      durationSec: 7,
    });
  });

  it('an audio FILE keeps the name the sender gave it', () => {
    const plan = tgMediaPlan(audioFile(), 56);
    expect(plan.kind).toBe('audio');
    expect(plan.fileName).toBe('narx.mp3');
    expect(plan.contentType).toBe('audio/mpeg');
    expect(plan.durationSec).toBe(128);
  });

  it('a voice note whose mime is nonsense is still opus in ogg', () => {
    // Some clients label it application/octet-stream; the VOICE attribute is
    // the honest signal, and refusing on the mime would drop real messages.
    const plan = tgMediaPlan(voice({ mimeType: 'application/octet-stream' }), 57);
    expect(plan.kind).toBe('voice');
    expect(plan.contentType).toBe('audio/ogg');
  });

  it('over the cap → refused BEFORE any network I/O', () => {
    expect(tgMediaPlan(voice({ size: MAX_TG_AUDIO_BYTES + 1 }), 58)).toMatchObject({
      kind: 'voice',
      download: false,
    });
  });
});

describe('the sizes Telegram actually sends', () => {
  it('a bigint size counts', () => {
    expect(tgMediaPlan(voice({ size: 99_000n }), 59).approxBytes).toBe(99_000);
  });

  it("big-integer's OBJECT counts — Number() on it is NaN, and NaN <= cap is false", () => {
    // This is the one that would have silently refused every voice note on the
    // owner's server: gramjs returns document.size as a big-integer instance.
    const bigIntegerish = { value: 123_456n, toString: () => '123456' };
    const plan = tgMediaPlan(voice({ size: bigIntegerish }), 60);
    expect(plan.approxBytes).toBe(123_456);
    expect(plan.download).toBe(true);
  });

  it('an unknown size refuses — pulling blind is how a 2 GB «audio» arrives', () => {
    expect(tgMediaPlan(voice({ size: undefined }), 61).kind).toBeNull();
  });
});

describe('what stays a paperclip', () => {
  it('a video note carries a duration but is not audio', () => {
    const media = voice({
      attributes: [
        { className: 'DocumentAttributeAudio', voice: true, duration: 5 },
        { className: 'DocumentAttributeVideo', roundMessage: true, duration: 5 },
      ],
    });
    expect(tgMediaPlan(media, 62).kind).toBeNull();
  });

  it('a sticker, a pdf, a link preview', () => {
    expect(tgMediaPlan({ className: 'MessageMediaWebPage' }, 63).kind).toBeNull();
    expect(
      tgMediaPlan(
        {
          className: 'MessageMediaDocument',
          document: { mimeType: 'application/pdf', size: 900, attributes: [] },
        },
        64,
      ).kind,
    ).toBeNull();
    expect(tgMediaPlan(null, 65).kind).toBeNull();
  });
});

describe('the photo branch still answers as it did', () => {
  it('a photo is planned with its own cap and jpeg name', () => {
    const media = { className: 'MessageMediaPhoto', photo: { sizes: [{ size: 180_000 }] } };
    expect(tgMediaPlan(media, 70)).toEqual({
      kind: 'photo',
      download: true,
      approxBytes: 180_000,
      contentType: 'image/jpeg',
      fileName: 'photo_70.jpg',
      durationSec: null,
    });
  });

  it('and an oversized photo is still refused on the photo cap, not the audio one', () => {
    const media = {
      className: 'MessageMediaPhoto',
      photo: { sizes: [{ size: MAX_TG_PHOTO_BYTES + 1 }] },
    };
    expect(tgMediaPlan(media, 71).download).toBe(false);
    // Proof it is the PHOTO cap doing the refusing: the same size sails
    // through the audio cap, which is twice as large.
    expect(MAX_TG_PHOTO_BYTES + 1).toBeLessThan(MAX_TG_AUDIO_BYTES);
  });
});
