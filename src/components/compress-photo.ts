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

export async function compressPhoto(file: File, options: CompressOptions = {}): Promise<File> {
  const compressed = await imageCompression(file, {
    maxSizeMB: options.maxSizeMB ?? 0.3,
    maxWidthOrHeight: options.maxWidthOrHeight ?? 1600,
    useWebWorker: true,
    // The whole point of this module. Without it the worker reaches for
    // cdn.jsdelivr.net and the operator waits for a network that, in a Chinese
    // warehouse, may never answer.
    libURL: COMPRESS_LIB_URL,
  });
  // The library hands back a Blob; the upload wants a File with a name and a
  // type, and `compressed.type` can be empty when the source had no mime.
  return new File([compressed], file.name || 'photo.jpg', {
    type: compressed.type || 'image/jpeg',
  });
}
