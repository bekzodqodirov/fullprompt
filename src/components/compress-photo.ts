import imageCompression from 'browser-image-compression';

/**
 * Shrinking a photograph before it leaves the phone — in one place, because
 * the reason it needs saying is not obvious and three screens do it.
 *
 * THE DEFECT this exists to fix (round 97, the owner at a warehouse: «yuk qabul
 * qilganda rasimni kirgizgandan keyin prixodga ruxsat chiqmayabti»):
 * `browser-image-compression` runs its work in a Web Worker, and the worker it
 * builds does not contain the library — it `importScripts` it **from
 * cdn.jsdelivr.net, at runtime, on every photo**. So adding a photo makes the
 * phone fetch 57 KB of JavaScript from a third-party CDN before anything
 * happens, and until that resolves the photo does not appear, the confirm
 * button stays disabled and NOTHING on the screen says why.
 *
 * That fetch fails in the two places this company works. Measured in this
 * container, which has no route to the public internet: **12.7 s** to fail,
 * then a silent fall-back to the main thread — the whole of the «13 seconds and
 * no photo» the e2e has been quietly living with, dismissed in CLAUDE.md for
 * rounds as «no image service in this container». And in mainland China —
 * Yiwu, Guangzhou, Kashgar, where the cargo is actually received — jsDelivr is
 * not reliably reachable at all, so on a warehouse phone the wait is however
 * long that network takes to give up.
 *
 * `libURL` points the worker at our own copy instead (`public/vendor/`, kept
 * byte-identical to the installed package by `tests/unit/vendored-lib.test.ts`
 * — a stale copy would run different code in the worker than the bundle does).
 * Nothing about the compression changes; it simply stops asking a foreign
 * server for permission to start.
 *
 * The options themselves are the ones the receive wizard has always used, and
 * they are here so the other two callers cannot drift from them.
 */
export const COMPRESS_LIB_URL = '/vendor/browser-image-compression.js';

export interface CompressOptions {
  /** Ceiling for the result. 0.3 MB is what the warehouse screens ask for. */
  maxSizeMB?: number;
  maxWidthOrHeight?: number;
}

/**
 * «This file is not a photograph» — told apart from «the upload failed»,
 * because the screens say opposite things about them and only one of the two is
 * the network's fault.
 *
 * It could not happen while `capture` forced the camera: the operator was
 * handed a fresh JPEG and had no way to choose anything else. Round 111 opened
 * the gallery and the file browser (owner: «fildan tanlash yokida rasimga olish
 * qilib ochadigan yoli borku»), so a PDF invoice is now one tap away from a
 * slot that renders its result as an <img> — and the library's own refusal
 * («The file given is not an image») was landing in a catch that says «check
 * the connection», sending a warehouse with perfect wifi to look at its router.
 * That is round 97's own mistake (#669) arriving through a new door.
 */
export class PhotoUnreadable extends Error {
  constructor() {
    super('photo_unreadable');
  }
}

export async function compressPhoto(file: File, options: CompressOptions = {}): Promise<File> {
  // Asked here and not in each caller: every photo slot needs the same answer,
  // and the library already applies the same test (`/^image/`) — it just
  // reports it as a bare Error no caller can tell from a decode failure.
  if (!file.type.startsWith('image/')) throw new PhotoUnreadable();
  let compressed;
  try {
    compressed = await imageCompression(file, {
      maxSizeMB: options.maxSizeMB ?? 0.3,
      maxWidthOrHeight: options.maxWidthOrHeight ?? 1600,
      useWebWorker: true,
      // The whole point of this module. Without it the worker reaches for
      // cdn.jsdelivr.net and the operator waits for a network that, in a
      // Chinese warehouse, may never answer.
      libURL: COMPRESS_LIB_URL,
    });
  } catch {
    // Anything reaching here is a file the browser could not decode as an
    // image — an HEIC on a browser with no codec is the common one, and it
    // passes the type test above because `image/heic` IS an image type. The
    // library does no network work any more (round 97), so nothing else is
    // left to blame.
    throw new PhotoUnreadable();
  }
  // The library hands back a Blob; the upload wants a File with a name and a
  // type, and `compressed.type` can be empty when the source had no mime.
  return new File([compressed], file.name || 'photo.jpg', {
    type: compressed.type || 'image/jpeg',
  });
}
