/**
 * Which decoder the scanner should be running, as pure questions.
 *
 * These live outside the component because the component cannot be tested —
 * it needs a camera, a video element and a browser that decides for itself
 * which barcode API it pretends to have. The DECISIONS are what went wrong in
 * the Kashgar warehouse and what made the camera slow everywhere else, and a
 * decision can be called directly (#166).
 *
 * The story they encode: `window.BarcodeDetector` existing says only that the
 * API is compiled into the browser. On Android the reading itself is done by a
 * platform module delivered through Google Play Services, which a phone bought
 * in China does not have — so the class is there, the constructor succeeds,
 * `detect()` never throws, and it returns an empty list for ever. The camera
 * opens, the picture is perfect, and no code is ever read. Nothing in the
 * browser reports this as an error, so the only way to notice is to watch
 * whether the detector ever actually reads anything (#626).
 *
 * What changed in the QR-siz round (owner: «bazida sekin o'qiyabti, QR ni
 * ko'rishi bilan o'qimayabti»): the old answer was to WAIT — give the native
 * detector 25 barren frames (≈4.5 s) and only then start the library — and
 * the wait was paid again on every screen visit and after every red confirm.
 * Now both decoders run on the same frames until one of them has proved
 * itself, so a phone whose platform cannot read reads at the library's speed
 * from its first frame, and a phone whose platform can is never taken away
 * from it on a guess.
 */

/**
 * What the camera is being asked to read. `qr` is our own label — the hot
 * path, every carton of every truck. `retail` is a factory's barcode on the
 * carton (EAN/UPC/ITF), read only when somebody asks for it (Q10 c).
 */
export type ScanMode = 'qr' | 'retail';

/**
 * The hot path reads QR and nothing else.
 *
 * It used to ask for Code 128 as well, which nothing in this app prints — and
 * a Chinese courier waybill IS a Code 128 whose 12-15 characters pass
 * `isSendableCode`: on a planned truck that was a red «not on plan» confirm
 * (which also tore the camera down), on a quick truck a false +1. Restricting
 * the formats is also the platform's own advice for speed.
 */
export const NATIVE_FORMATS = ['qr_code'] as const;
/** A factory's retail symbologies — plus our QR, so a label in the band still reads. */
export const RETAIL_FORMATS = [
  'ean_13',
  'ean_8',
  'upc_a',
  'upc_e',
  'itf',
  'code_128',
  'qr_code',
] as const;

export function nativeFormatsFor(mode: ScanMode): string[] {
  return mode === 'retail' ? [...RETAIL_FORMATS] : [...NATIVE_FORMATS];
}

/**
 * May the native detector be used at all?
 *
 * `BarcodeDetector.getSupportedFormats()` is the documented feature test and
 * the scanner used to skip it entirely — the constructor happily accepts
 * formats the platform cannot read. `undefined` means the browser is too old
 * to answer, which is not a refusal: it gets the trial below like everyone
 * else. An EMPTY list is a refusal, and the loudest one available. A retail
 * read needs the platform to know EAN-13, the commonest factory code.
 */
export function nativeUsable(formats: string[] | undefined, mode: ScanMode = 'qr'): boolean {
  if (formats === undefined) return true;
  return formats.includes(mode === 'retail' ? 'ean_13' : 'qr_code');
}

/**
 * The barren backstop: frames AND time the native detector gets to read one
 * code before it is dropped for this visit.
 *
 * 25 frames used to be ≈4.5 s, because the loop ran every 180 ms. The loop is
 * now paced by the camera and runs up to fifteen native calls a second, so 25
 * frames alone would be 1.7 s — short enough that an operator who takes two
 * seconds to lift the phone loses a working detector. Both halves have to be
 * spent.
 */
export const NATIVE_TRIAL_FRAMES = 25;
export const NATIVE_TRIAL_MIN_MS = 4500;
/**
 * The proof rule. A frame is PROOF when the library read one of the codes
 * this mode is for while the native detector, on the same frame, answered []
 * without throwing. Five of them, with at least 1.5 s passed since native's
 * first answer, hands the rest of this visit to the library.
 *
 * Two frames were proposed and refused: a platform detector commonly answers
 * [] for its first calls while its model loads, and an operator who aims in
 * the first second would have taken a working detector away (#626 turned
 * inside out). The time half is what a warm-up cannot fake.
 */
export const PROOF_FRAMES = 5;
export const PROOF_SPAN_MS = 1500;

export interface NativeTrial {
  /** Frames actually handed to the detector — a blank frame is not a trial. */
  framesSeen: number;
  /** Has it read ANY code, ever, on this screen? */
  nativeWorks: boolean;
  /** Did a `detect()` call reject? */
  threw: boolean;
  /** Frames it is given to prove itself. */
  trialFrames: number;
  /** Proof frames so far (see PROOF_FRAMES). */
  zxingProof: number;
  /** ms since native's first call that did NOT throw; null before one. */
  sinceNativeOkMs: number | null;
}

export type HandOverReason = 'throw' | 'proof' | 'backstop';

/**
 * Why the native detector should be abandoned for the library, or null.
 *
 * A THROW is a fact about the detector and needs no patience: a call that
 * errors will error again for the same reason. PROOF is evidence: the library
 * read our code on frames the platform looked at and called empty, for long
 * enough that a warm-up is ruled out. SILENCE is ambiguous — a detector
 * reading nothing looks exactly like an operator who has not pointed the
 * phone at a label yet — so it is given the backstop and then, still
 * ambiguous, resolved in favour of the decoder the platform cannot break.
 *
 * Once it HAS read something the question never comes back: a detector that
 * works does not stop working because the next box takes a while to line up.
 */
export function handOverReason(trial: NativeTrial): HandOverReason | null {
  if (trial.nativeWorks) return null;
  if (trial.threw) return 'throw';
  const since = trial.sinceNativeOkMs;
  if (since === null) return null;
  if (trial.zxingProof >= PROOF_FRAMES && since >= PROOF_SPAN_MS) return 'proof';
  if (trial.framesSeen >= trial.trialFrames && since >= NATIVE_TRIAL_MIN_MS) return 'backstop';
  return null;
}

export function shouldHandOver(trial: NativeTrial): boolean {
  return handOverReason(trial) !== null;
}

/** What one frame told the trial. */
export interface TrialFrame {
  /** When the frame was taken, on any monotonic clock. */
  at: number;
  /** The native detector's answer on this frame. */
  native: 'threw' | 'empty' | 'read';
  /** Did the library read a code of this mode's own kind on the SAME frame? */
  libraryOwn: boolean;
}

/** The trial's running record — what the scanner keeps between frames. */
export interface TrialState {
  framesSeen: number;
  nativeWorks: boolean;
  threw: boolean;
  zxingProof: number;
  /** When native first answered without throwing; the proof and backstop clocks start here. */
  nativeOkAt: number | null;
}

export const FRESH_TRIAL: TrialState = {
  framesSeen: 0,
  nativeWorks: false,
  threw: false,
  zxingProof: 0,
  nativeOkAt: null,
};

/**
 * Fold one frame into the trial. The scanner calls exactly this, so the
 * warm-up and proof sequences in the unit test are the scanner's own
 * arithmetic and not a restatement of it (#166).
 */
export function trialStep(s: TrialState, f: TrialFrame): TrialState {
  const framesSeen = s.framesSeen + 1;
  if (f.native === 'threw') return { ...s, framesSeen, threw: true };
  return {
    framesSeen,
    threw: s.threw,
    nativeOkAt: s.nativeOkAt ?? f.at,
    nativeWorks: s.nativeWorks || f.native === 'read',
    zxingProof: s.zxingProof + (f.native === 'empty' && f.libraryOwn ? 1 : 0),
  };
}

/** The trial as `handOverReason` reads it, at a given moment. */
export function trialAt(s: TrialState, now: number): NativeTrial {
  return {
    framesSeen: s.framesSeen,
    nativeWorks: s.nativeWorks,
    threw: s.threw,
    trialFrames: NATIVE_TRIAL_FRAMES,
    zxingProof: s.zxingProof,
    sinceNativeOkMs: s.nativeOkAt === null ? null : now - s.nativeOkAt,
  };
}

/**
 * Which decoders run. `both` is the proof trial: each frame goes to both, so
 * the library reads from the first frame while the platform proves itself.
 */
export type Plan = 'both' | 'native' | 'zxing';
export type DecoderVerdict = 'native' | 'zxing';

/**
 * The plan a visit starts with.
 *
 * - no native detector at all → the library;
 * - remembered `zxing` → the library, native is not asked;
 * - remembered `native` → native alone (the library's main-thread work is
 *   saved), still under the per-visit backstop;
 * - nothing remembered → the proof trial.
 */
export function startPlan(remembered: DecoderVerdict | null, nativeAvailable: boolean): Plan {
  if (!nativeAvailable || remembered === 'zxing') return 'zxing';
  if (remembered === 'native') return 'native';
  return 'both';
}

/**
 * The plan after a hand-over. From the proof trial the library carries on
 * alone. From a REMEMBERED native that went quiet the answer is the trial,
 * not the library: that detector read codes on this phone within the last
 * days, and silence on this visit is weaker evidence than that — so it keeps
 * running beside the library and must be out-proved like any other. A throw
 * is a fact and ends native either way.
 */
export function planAfterHandOver(plan: Plan, reason: HandOverReason): Plan {
  if (reason === 'throw') return 'zxing';
  return plan === 'native' ? 'both' : 'zxing';
}

/** Once native has read, the library's parallel run is pure cost. */
export function planAfterNativeRead(plan: Plan): Plan {
  return plan === 'zxing' ? plan : 'native';
}

/** Where a verdict is remembered: one per mode, never one for both (#42). */
export function verdictKey(mode: ScanMode): string {
  return `gsr.scan.decoder.${mode}`;
}
/** A verdict older than this is tried again: a phone's barcode module may arrive later. */
export const VERDICT_TTL_MS = 3 * 24 * 60 * 60 * 1000;

/**
 * The remembered verdict for this browser, or null.
 *
 * Anything unreadable, expired, dated in the future or recorded by a
 * different browser (an update is a different decoder) is no verdict at all:
 * the cost of null is one proof trial, the cost of a wrong verdict is days.
 */
export function rememberedVerdict(stored: unknown, ua: string, now: number): DecoderVerdict | null {
  let entry: unknown = stored;
  if (typeof stored === 'string') {
    try {
      entry = JSON.parse(stored);
    } catch {
      return null;
    }
  }
  if (!entry || typeof entry !== 'object') return null;
  const { v, ua: seenUa, at } = entry as { v?: unknown; ua?: unknown; at?: unknown };
  if (v !== 'native' && v !== 'zxing') return null;
  if (seenUa !== ua || typeof at !== 'number') return null;
  const age = now - at;
  if (!(age >= 0 && age <= VERDICT_TTL_MS)) return null;
  return v;
}

export function verdictEntry(v: DecoderVerdict, ua: string, now: number): string {
  return JSON.stringify({ v, ua, at: now });
}

/** What one visit to a scan screen showed, read when it ends. */
export interface VisitOutcome {
  /** Codes the native detector read during the visit. */
  nativeReads: number;
  /** Why native was dropped during the visit, if it was. */
  handedOver: HandOverReason | null;
  /** Codes of this mode's own kind the library read. */
  zxingOwnReads: number;
  /** Proof frames (see PROOF_FRAMES). */
  zxingProof: number;
}

/**
 * Should the library be remembered as this phone's decoder when the visit
 * ends?
 *
 * Only on evidence, never on the ambiguous timeout alone: native read nothing
 * the whole visit, native was dropped during it, and the library read at
 * least one of our codes. A dropped detector that THREW needs nothing more.
 * One dropped for silence or proof also needs a proof frame — a code the
 * library read while native, looking at the same frame, called it empty.
 * Without that clause an operator who simply took five seconds to aim would
 * be remembered as a Kashgar phone for three days: native stops at the
 * backstop, the library reads the first carton, and nothing in the record
 * says native ever saw it.
 */
export function rememberZxing(o: VisitOutcome): boolean {
  if (o.nativeReads > 0 || o.handedOver === null || o.zxingOwnReads < 1) return false;
  if (o.handedOver === 'throw') return true;
  return o.zxingProof >= 1;
}

/** The fewest ms between two native calls: at most fifteen a second. */
export const NATIVE_MIN_GAP_MS = 66;

/**
 * When the next decode may start, measured from when the last one started.
 *
 * Native work happens off the main thread, so a fixed floor is enough. The
 * library runs ON the main thread, so it waits at least twice as long as its
 * last attempt took: the page keeps at least half of every second for the
 * operator's own taps.
 */
export function nextDelayMs(lastMs: number, where: 'native' | 'main'): number {
  if (where === 'native') return NATIVE_MIN_GAP_MS;
  return Math.max(NATIVE_MIN_GAP_MS, Math.ceil(2 * lastMs));
}

/**
 * The codes one frame hands to the screen, in the order it hands them.
 *
 * Normalised like the scanner's emit (trimmed, upper-cased), de-duplicated,
 * and — when any of them is what this mode is for — only those. A frame that
 * holds our label and a supplier's URL gives the label and says nothing about
 * the URL; a frame holding ONLY foreign codes still hands them on, so the
 * screens can say «❓ begona QR» (#628).
 */
export function pickCodes(values: readonly string[], prefer: (code: string) => boolean): string[] {
  const seen = new Set<string>();
  const all: string[] = [];
  for (const raw of values) {
    const code = raw.trim().toUpperCase();
    if (!code || seen.has(code)) continue;
    seen.add(code);
    all.push(code);
  }
  const own = all.filter(prefer);
  return own.length > 0 ? own : all;
}
