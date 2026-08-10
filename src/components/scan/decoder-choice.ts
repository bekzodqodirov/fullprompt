/**
 * Which QR decoder the scanner should be running, as two pure questions.
 *
 * These live outside the component because the component cannot be tested —
 * it needs a camera, a video element and a browser that decides for itself
 * which barcode API it pretends to have. The DECISIONS are what went wrong in
 * the Kashgar warehouse, and a decision can be called directly (#166).
 *
 * The story they encode: `window.BarcodeDetector` existing says only that the
 * API is compiled into the browser. On Android the reading itself is done by a
 * platform module delivered through Google Play Services, which a phone bought
 * in China does not have — so the class is there, the constructor succeeds,
 * `detect()` never throws, and it returns an empty list for ever. The camera
 * opens, the picture is perfect, and no code is ever read. Nothing in the
 * browser reports this as an error, so the only way to notice is to watch
 * whether the detector ever actually reads anything.
 */

/**
 * May the native detector be used at all?
 *
 * `BarcodeDetector.getSupportedFormats()` is the documented feature test and
 * the scanner used to skip it entirely — the constructor happily accepts
 * formats the platform cannot read. `undefined` means the browser is too old
 * to answer, which is not a refusal: it gets the trial below like everyone
 * else. An EMPTY list is a refusal, and the loudest one available.
 */
export function nativeUsable(formats: string[] | undefined): boolean {
  if (formats === undefined) return true;
  return formats.includes('qr_code');
}

export interface NativeTrial {
  /** Frames actually handed to the detector — a blank frame is not a trial. */
  framesSeen: number;
  /** Has it read ANY code, ever, on this screen? */
  nativeWorks: boolean;
  /** Did a `detect()` call reject? */
  threw: boolean;
  /** Frames it is given to prove itself. */
  trialFrames: number;
}

/**
 * Should the native detector be abandoned for the library fallback?
 *
 * Two reasons, and they are different in kind. A THROW is a fact about the
 * detector and needs no patience: a call that errors will error again for the
 * same reason, so the hand-over is immediate. SILENCE is ambiguous — a
 * detector reading nothing looks exactly like an operator who has not pointed
 * the phone at a label yet — so it is given a fixed number of live frames and
 * then, still ambiguous, resolved in favour of the decoder that cannot be
 * broken by the platform. Being wrong that way costs some CPU on the phone.
 * Being wrong the other way costs a warehouse that cannot scan, which is the
 * bug this exists to end.
 *
 * Once it HAS read something the question never comes back: a detector that
 * works does not stop working because the next box takes a while to line up.
 */
export function shouldHandOver(trial: NativeTrial): boolean {
  if (trial.nativeWorks) return false;
  if (trial.threw) return true;
  return trial.framesSeen >= trial.trialFrames;
}
