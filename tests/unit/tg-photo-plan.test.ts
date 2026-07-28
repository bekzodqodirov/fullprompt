import { describe, expect, it } from 'vitest';
import { MAX_TG_PHOTO_BYTES, tgPhotoPlan } from '@/modules/wms/crm/telegram-import';

/**
 * What gets downloaded from a client's chat (item 15).
 *
 * `hasMedia` is true for link previews, stickers, voice notes and arbitrary
 * documents; the plan must say PHOTO, KNOWN SIZE, WITHIN CAP — everything
 * else stays a paperclip. Refusing an unknown size is the load-bearing case:
 * pulling blind is how a 2 GB "photo sent as file" ends up on the account
 * the business depends on.
 */

const photo = (sizes: unknown[]) => ({ className: 'MessageMediaPhoto', photo: { sizes } });

describe('what deserves a download', () => {
  it('a normal photo with a stated size', () => {
    const plan = tgPhotoPlan(photo([{ type: 'm', size: 40_000 }, { type: 'x', size: 180_000 }]));
    expect(plan).toEqual({ download: true, approxBytes: 180_000 });
  });

  it('progressive sizes count too — the largest step is the real size', () => {
    const plan = tgPhotoPlan(photo([{ type: 'y', sizes: [8_000, 60_000, 220_000] }]));
    expect(plan).toEqual({ download: true, approxBytes: 220_000 });
  });

  it('over the cap → refused BEFORE any network I/O', () => {
    expect(tgPhotoPlan(photo([{ size: MAX_TG_PHOTO_BYTES + 1 }])).download).toBe(false);
  });

  it('a link preview is media but never a photograph of cargo', () => {
    expect(tgPhotoPlan({ className: 'MessageMediaWebPage' }).download).toBe(false);
  });

  it('a document — even an image sent as file — is not pulled in v1', () => {
    expect(
      tgPhotoPlan({ className: 'MessageMediaDocument', document: { size: 100 } }).download,
    ).toBe(false);
  });

  it('unknown size refuses rather than downloading blind', () => {
    expect(tgPhotoPlan(photo([])).download).toBe(false);
    expect(tgPhotoPlan(photo([{ type: 'i', bytes: 'stripped' }])).download).toBe(false);
    expect(tgPhotoPlan(null).download).toBe(false);
    expect(tgPhotoPlan(undefined).download).toBe(false);
  });
});
