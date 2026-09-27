'use client';

import { useEffect, useRef, useState } from 'react';
import { useTranslations } from 'next-intl';
import { isOwnCodeShape, looksLikeRetailBarcode } from '@/offline/code-shape';
import {
  FRESH_TRIAL,
  handOverReason,
  nativeFormatsFor,
  nativeUsable,
  nextDelayMs,
  pickCodes,
  planAfterHandOver,
  planAfterNativeRead,
  rememberZxing,
  rememberedVerdict,
  startPlan,
  trialAt,
  trialStep,
  verdictEntry,
  verdictKey,
  type DecoderVerdict,
  type HandOverReason,
  type Plan,
  type ScanMode,
  type TrialState,
} from './decoder-choice';
import { hidChar } from './hid';

/**
 * Scan input core (spec 6.4 / §15): phone camera via the native
 * BarcodeDetector when it can read, @zxing/browser when it cannot, plus
 * USB/Bluetooth HID scanners (they type the code and press Enter). Feedback
 * stays local-first — the parent handles accept/reject in <300 ms.
 *
 * The camera reads ONLY what is inside the drawn guide (owner: "ekranda
 * ko'rinadigandan kattaroq joyni scan qilyapti"). The preview used
 * `object-cover`, which crops what you SEE but not what the decoder reads, so
 * a label lying beside the box being scanned — or one still in the previous
 * box — was picked up off screen and silently accepted. Every frame is
 * cropped to the guide before it reaches either decoder, which turns the
 * frame on screen from decoration into a promise (#160).
 *
 * WHY IT IS BUILT THE WAY IT IS (owner: «bazida sekin o'qiyabti, QR ni
 * ko'rishi bilan o'qimayabti»). The label was measured and is not the cause.
 * Four things in this component were:
 *
 * 1. The camera was opened and closed with `active`. Every red «not on plan»
 *    confirm (and every «bitta» accept) closed it, so the next box paid a new
 *    camera start AND a fresh 4.5 s native trial. The stream now lives as
 *    long as the component; `active` only stops frames being decoded, checked
 *    again after every await so a code can never reach a confirm (#244).
 * 2. The decoder was chosen by WAITING (#626): native got 25 barren frames
 *    before the library started, on every visit. Now both read the same
 *    frames until one has proved itself, and the answer is remembered per
 *    phone, per mode (decoder-choice.ts).
 * 3. `setInterval(async …)` stacked native calls behind each other on a slow
 *    phone, so reads lagged further and further behind the picture. One
 *    decode is in flight at a time, paced by the camera's own frames.
 * 4. A frozen or ended camera track (screen lock, app switch) was never
 *    noticed; the loop decoded the last frame for ever. A watchdog reopens.
 *
 * The library's module is fetched at start rather than at the moment it is
 * needed, because these are the offline screens and a chunk that has to cross
 * the warehouse wifi exactly when the platform gives up is a chunk that will
 * not arrive.
 */

/** Side of the QR read area, as a fraction of the visible square. */
const GUIDE = 0.74;
/**
 * Pixels the cropped QR frame is scaled to before decoding.
 *
 * 512 was tuned against the camera's DEFAULT stream, which on the iPhones in
 * the Chinese warehouses is 640×480 — the guide square of that is ~350 px,
 * and a QR module a couple of pixels wide is what "juda sekin tanidi" looks
 * like. The stream below asks for 1080p, so the crop arrives sharp and 640
 * keeps more of that sharpness for the decoder.
 */
const ROI_PX = 640;
/**
 * The read area per mode, as fractions of the visible square, and the canvas
 * the decoders read. A retail barcode is a wide, short stripe, and a square
 * guide would make the operator hold the phone twice as far away to fit it.
 */
const READ_AREA: Record<ScanMode, { w: number; h: number; pxW: number; pxH: number }> = {
  qr: { w: GUIDE, h: GUIDE, pxW: ROI_PX, pxH: ROI_PX },
  retail: { w: 0.9, h: 0.35, pxW: 960, pxH: Math.round((960 * 0.35) / 0.9) },
};
/** What each mode is FOR — a frame holding one of these hands on nothing else. */
const PREFER: Record<ScanMode, (code: string) => boolean> = {
  qr: isOwnCodeShape,
  retail: looksLikeRetailBarcode,
};
/** For this long after a foreign QR was seen, a failed frame is tried again in halves. */
const FOREIGN_MEMORY_MS = 2000;
/** The library reads ONE code per call; this much white around the one it found hides it. */
const MASK_PAD_PX = 40;
/** Width of each overlapping half, in the 640 px QR canvas. */
const HALF_PX = 400;
/** A picture that has not moved for this long, while it should, is a dead camera. */
const FROZEN_MS = 2000;
/** A camera that keeps dying is reopened at most this often. */
const REOPEN_GAP_MS = 3000;
const WATCH_MS = 1000;

/** What the operator is told. `ready` says nothing — a working camera needs no caption. */
type CamState =
  | { kind: 'starting' }
  | { kind: 'ready' }
  | { kind: 'failed'; reason: 'insecure' | 'denied' | 'unavailable' };

interface NativeDetector {
  detect(source: CanvasImageSource): Promise<{ rawValue: string }[]>;
}
type DetectorCtorType = (new (opts: { formats: string[] }) => NativeDetector) & {
  getSupportedFormats?: () => Promise<string[]>;
};
/** The two calls this file makes on a zxing result, and nothing else of @zxing/library. */
interface ZxingResult {
  getText(): string;
  getResultPoints(): ({ getX(): number; getY(): number } | null)[] | null;
}
interface ZxingReader {
  decodeFromCanvas(canvas: HTMLCanvasElement): ZxingResult;
}
type ZxingModule = typeof import('@zxing/browser');

/** One mode's decoders and what this visit has learned about them. */
interface Engine {
  mode: ScanMode;
  canvas: HTMLCanvasElement;
  ctx: CanvasRenderingContext2D | null;
  detector: NativeDetector | null;
  reader: ZxingReader | null;
  plan: Plan;
  trial: TrialState;
  handedOver: HandOverReason | null;
  nativeReads: number;
  zxingOwnReads: number;
  nativeRemembered: boolean;
}

/**
 * The verdict outlives the visit in localStorage; a private window refuses
 * that, so the tab keeps its own copy and a second screen in the same session
 * does not pay the trial again.
 */
const verdictMemory = new Map<string, string>();
function readVerdict(mode: ScanMode): DecoderVerdict | null {
  const key = verdictKey(mode);
  let stored: string | null = null;
  try {
    stored = window.localStorage.getItem(key);
  } catch {
    /* storage refused — the tab's copy below */
  }
  return rememberedVerdict(stored ?? verdictMemory.get(key) ?? null, navigator.userAgent, Date.now());
}
function writeVerdict(mode: ScanMode, v: DecoderVerdict): void {
  const key = verdictKey(mode);
  const entry = verdictEntry(v, navigator.userAgent, Date.now());
  verdictMemory.set(key, entry);
  try {
    window.localStorage.setItem(key, entry);
  } catch {
    /* storage refused — the tab's copy above lasts until it closes */
  }
}

function zxingOnce(reader: ZxingReader, canvas: HTMLCanvasElement): ZxingResult | null {
  try {
    return reader.decodeFromCanvas(canvas);
  } catch {
    return null; // NotFoundException on a frame with no code — the normal case
  }
}

export function Scanner({
  active,
  onCode,
  mode = 'qr',
}: {
  active: boolean;
  onCode: (code: string) => void;
  /** What to read. Switching it swaps the decoders; the camera stays open. */
  mode?: ScanMode;
}) {
  const t = useTranslations('common');
  const ts = useTranslations('scanner');
  const rootRef = useRef<HTMLDivElement>(null);
  const videoRef = useRef<HTMLVideoElement>(null);
  const [cam, setCam] = useState<CamState>({ kind: 'starting' });
  /** Has ANY decoder read anything since this screen was opened? */
  const [everRead, setEverRead] = useState(false);
  /** Live for long enough that "nothing has been read" is worth saying. */
  const [quiet, setQuiet] = useState(false);
  const onCodeRef = useRef(onCode);
  useEffect(() => {
    onCodeRef.current = onCode;
  }, [onCode]);
  /**
   * Read by the camera loop on every frame. The loop never restarts: a pause
   * (a confirm on screen) is this ref turning false, and the camera keeps its
   * picture so the next box reads on the next frame.
   */
  const activeRef = useRef(active);
  useEffect(() => {
    activeRef.current = active;
  }, [active]);
  const modeRef = useRef<ScanMode>(mode);
  useEffect(() => {
    modeRef.current = mode;
  }, [mode]);
  // Per-code cooldown so a QR held in front of the camera fires once.
  const cooldownRef = useRef(new Map<string, number>());
  /** Codes the decoders have handed over, cooldown included — for the probe and ⓘ. */
  const readsRef = useRef(0);
  // The torch, where the hardware offers one: a warehouse aisle in the
  // evening is where scanning actually slows down, and the phone knows how
  // to light it. Hidden entirely when the track has no torch capability.
  const trackRef = useRef<MediaStreamTrack | null>(null);
  const [torchAvailable, setTorchAvailable] = useState(false);
  const [torchOn, setTorchOn] = useState(false);
  const torchOnRef = useRef(false);
  /**
   * ⓘ: which decoder, which resolution, how fast. Three rounds were once
   * spent asking the owner to describe a black square (#627); a screenshot of
   * this line answers «which phone, which decoder» in one message.
   */
  const [diagOpen, setDiagOpen] = useState(false);
  const diagOpenRef = useRef(false);
  const [diag, setDiag] = useState('…');

  async function toggleTorch() {
    const track = trackRef.current;
    if (!track) return;
    const next = !torchOn;
    try {
      await track.applyConstraints({ advanced: [{ torch: next } as MediaTrackConstraintSet] });
      torchOnRef.current = next;
      setTorchOn(next);
    } catch {
      /* the capability lied — leave the button state alone */
    }
  }

  function toggleDiag() {
    diagOpenRef.current = !diagOpenRef.current;
    setDiag('…');
    setDiagOpen(diagOpenRef.current);
  }

  const emitRef = useRef((raw: string) => {
    const code = raw.trim().toUpperCase();
    if (!code) return;
    readsRef.current += 1;
    setEverRead(true);
    const now = Date.now();
    const last = cooldownRef.current.get(code) ?? 0;
    if (now - last < 2500) return;
    cooldownRef.current.set(code, now);
    onCodeRef.current(code);
  });

  // HID scanner: buffered keystrokes terminated by Enter.
  useEffect(() => {
    if (!active) return;
    let buffer = '';
    let lastKey = 0;
    const onKey = (e: KeyboardEvent) => {
      if (e.target instanceof HTMLInputElement || e.target instanceof HTMLTextAreaElement) return;
      const now = Date.now();
      if (now - lastKey > 300) buffer = '';
      lastKey = now;
      if (e.key === 'Enter') {
        if (buffer.length >= 4) emitRef.current(buffer);
        buffer = '';
        return;
      }
      // By the physical key when the layout would spell it otherwise
      // (Cyrillic, a Chinese input method) — see hid.ts.
      const ch = hidChar(e.key, e.code);
      if (ch !== null) buffer += ch;
    };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, [active]);

  // "The camera has been open a while and has read nothing" is worth saying
  // out loud, because the manual door is one tap away and the operator has
  // no way to know it is the right one.
  useEffect(() => {
    if (!active) return;
    const quietTimer = setTimeout(() => setQuiet(true), 12_000);
    return () => {
      clearTimeout(quietTimer);
      setQuiet(false);
    };
  }, [active]);

  // The camera: opened once, closed once. Nothing in here may depend on
  // `active` or `mode` — both are read through refs by the loop.
  useEffect(() => {
    const video = videoRef.current;
    if (!video) return;
    let stream: MediaStream | null = null;
    let stopped = false;
    let opening = false;
    let lastOpenAt = -Infinity;
    let frameKind: 'video' | 'animation' =
      'requestVideoFrameCallback' in video ? 'video' : 'animation';
    let frameHandle: number | null = null;
    let watchTimer: ReturnType<typeof setTimeout> | null = null;
    let inFlight = false;
    let nextAt = 0;
    let foreignAt = -Infinity;
    // Watchdog: when the loop last ran and when the picture last moved.
    let lastTickAt = performance.now();
    let lastMediaTime = -1;
    let lastProgressAt = performance.now();
    /**
     * Has the picture's clock moved at all since this stream opened? A
     * browser that keeps `currentTime` still on a live stream must not read
     * as a frozen camera and be reopened every three seconds.
     */
    let sawProgress = false;
    // ⓘ counters.
    let attempts = 0;
    let ticks = 0;
    const durations: number[] = [];
    let focusMode = '';
    let lastReport = { at: performance.now(), attempts: 0, frames: 0 };

    const engines = new Map<ScanMode, Engine>();
    const building = new Set<ScanMode>();
    // Fetched NOW, not when it is needed — see the note at the top of the file.
    // A rejection is an answer (null), not a crash: HID and the native
    // detector must keep working on a phone that cannot load the chunk.
    const zxingModule: Promise<ZxingModule | null> = import('@zxing/browser').catch(() => null);
    const half = document.createElement('canvas');
    half.width = HALF_PX;
    half.height = ROI_PX;
    const halfCtx = half.getContext('2d', { willReadFrequently: true });

    const emitAll = (values: string[], prefer: (code: string) => boolean, skip: string[] = []) => {
      for (const code of pickCodes(values, prefer)) {
        if (!skip.includes(code)) emitRef.current(code);
      }
    };

    /**
     * The native detector for a mode, or null if this browser only pretends
     * to have one. `getSupportedFormats()` is the documented way to ask, and
     * skipping it was the whole Kashgar bug: the constructor happily accepts
     * formats the platform cannot read.
     */
    const nativeDetector = async (mode: ScanMode): Promise<NativeDetector | null> => {
      const Ctor = (window as unknown as { BarcodeDetector?: DetectorCtorType }).BarcodeDetector;
      if (!Ctor) return null;
      try {
        if (!nativeUsable(await Ctor.getSupportedFormats?.(), mode)) return null;
        return new Ctor({ formats: nativeFormatsFor(mode) });
      } catch {
        return null;
      }
    };

    const buildEngine = async (mode: ScanMode) => {
      building.add(mode);
      const area = READ_AREA[mode];
      const canvas = document.createElement('canvas');
      canvas.width = area.pxW;
      canvas.height = area.pxH;
      const detector = await nativeDetector(mode);
      const eng: Engine = {
        mode,
        canvas,
        ctx: canvas.getContext('2d', { willReadFrequently: true }),
        detector,
        reader: null,
        plan: startPlan(readVerdict(mode), detector !== null),
        trial: FRESH_TRIAL,
        handedOver: null,
        nativeReads: 0,
        zxingOwnReads: 0,
        nativeRemembered: false,
      };
      engines.set(mode, eng);
      building.delete(mode);
      // The library joins the moment its chunk is here; native does not wait for it.
      void zxingModule.then((mod) => {
        if (!mod) return;
        eng.reader =
          mode === 'retail' ? new mod.BrowserMultiFormatOneDReader() : new mod.BrowserQRCodeReader();
      });
    };

    const engineFor = (mode: ScanMode): Engine | null => {
      const eng = engines.get(mode);
      if (eng) return eng;
      if (!building.has(mode)) void buildEngine(mode);
      return null;
    };

    /**
     * Copy the read area out of the current frame.
     *
     * The preview is a square box with `object-cover`, so what the operator
     * sees is the centred square of the frame's shorter side, and the guide
     * is a fixed fraction of that. Cropping to exactly that rectangle is what
     * makes the drawn frame mean something.
     */
    const drawGuide = (eng: Engine): boolean => {
      const vw = video.videoWidth;
      const vh = video.videoHeight;
      if (!eng.ctx || !vw || !vh || video.readyState < 2) return false;
      const side = Math.min(vw, vh);
      const area = READ_AREA[eng.mode];
      const sw = side * area.w;
      const sh = side * area.h;
      eng.ctx.drawImage(video, (vw - sw) / 2, (vh - sh) / 2, sw, sh, 0, 0, eng.canvas.width, eng.canvas.height);
      return true;
    };

    /**
     * White out the symbol the library just returned and ask again.
     *
     * zxing reads ONE code per call, and with a supplier's QR beside ours it
     * returns the supplier's — every frame, measured. Hiding what it found is
     * the cheapest way to make it look at what it did not.
     */
    const maskAndRetry = (eng: Engine, found: ZxingResult): ZxingResult | null => {
      const points = (found.getResultPoints() ?? []).filter(
        (p): p is { getX(): number; getY(): number } => p !== null,
      );
      if (!eng.ctx || !eng.reader || points.length === 0) return null;
      const xs = points.map((p) => p.getX());
      const ys = points.map((p) => p.getY());
      const [x0, x1, y0, y1] = [Math.min(...xs), Math.max(...xs), Math.min(...ys), Math.max(...ys)];
      // Finder centres sit 3.5 modules inside the symbol: pad by a third of its span too.
      const pad = Math.max(MASK_PAD_PX, 0.35 * Math.max(x1 - x0, y1 - y0));
      eng.ctx.fillStyle = '#fff';
      eng.ctx.fillRect(x0 - pad, y0 - pad, x1 - x0 + 2 * pad, y1 - y0 + 2 * pad);
      return zxingOnce(eng.reader, eng.canvas);
    };

    /** Two codes the library returns NOTHING for, whole — left and right halves separately. */
    const decodeHalves = (eng: Engine): string[] => {
      if (!halfCtx || !eng.reader) return [];
      const out: string[] = [];
      for (const sx of [0, ROI_PX - HALF_PX]) {
        halfCtx.drawImage(eng.canvas, sx, 0, HALF_PX, ROI_PX, 0, 0, HALF_PX, ROI_PX);
        const found = zxingOnce(eng.reader, half);
        if (found) out.push(found.getText());
      }
      return out;
    };

    /** One frame through whichever decoders the plan runs. Never two at once. */
    const decodeFrame = async (eng: Engine, t0: number) => {
      const prefer = PREFER[eng.mode];
      const runNative = eng.plan !== 'zxing' && eng.detector !== null;
      const runLibrary = eng.plan !== 'native' && eng.reader !== null;
      let libraryMs = 0;
      attempts += 1;
      try {
        // ONE frame for both decoders. Native is asked first: the platform
        // takes its copy of the canvas when detect() is called, before the
        // library reads it or the mask below paints over it.
        const nativeCall =
          runNative && eng.detector
            ? eng.detector.detect(eng.canvas).then(
                (found) => ({ threw: false, values: found.map((item) => item.rawValue) }),
                () => ({ threw: true, values: [] as string[] }),
              )
            : null;
        let first: ZxingResult | null = null;
        if (runLibrary && eng.reader) {
          const z0 = performance.now();
          first = zxingOnce(eng.reader, eng.canvas);
          libraryMs = performance.now() - z0;
        }
        const libraryValues = first ? [first.getText()] : [];
        // Our own code goes to the screen now, not after native answers. Nothing
        // has been awaited since the tick checked `active`.
        const early = pickCodes(libraryValues, prefer).filter(prefer);
        emitAll(early, prefer);

        const nativeFound = nativeCall ? await nativeCall : null;
        // Paused while native was working — a confirm is on screen, and a
        // code must never reach it (#244). The frame is simply forgotten.
        if (stopped || !activeRef.current) return;
        const now = performance.now();

        // A foreign QR in the way: look again past it (QR only — the retail
        // reader already scans every row).
        let extra: string[] = [];
        if (eng.mode === 'qr' && runLibrary && eng.reader) {
          const z1 = performance.now();
          if (first && !prefer(first.getText())) {
            foreignAt = now;
            const again = maskAndRetry(eng, first);
            if (again) extra.push(again.getText());
          } else if (!first && now - foreignAt < FOREIGN_MEMORY_MS) {
            extra = decodeHalves(eng);
          }
          // The second look is main-thread work too; the gap pays for it.
          libraryMs += performance.now() - z1;
        }
        const libraryAll = [...libraryValues, ...extra];
        const libraryOwn = libraryAll.some(prefer);
        if (libraryOwn) eng.zxingOwnReads += 1;

        // The trial: what native answered on the frame the library looked at.
        if (nativeFound) {
          const answer = nativeFound.threw ? 'threw' : nativeFound.values.length > 0 ? 'read' : 'empty';
          eng.trial = trialStep(eng.trial, { at: t0, native: answer, libraryOwn });
          if (answer === 'read') {
            eng.nativeReads += nativeFound.values.length;
            eng.plan = planAfterNativeRead(eng.plan);
            if (!eng.nativeRemembered) {
              eng.nativeRemembered = true;
              writeVerdict(eng.mode, 'native');
            }
          } else if (eng.plan !== 'zxing') {
            const reason = handOverReason(trialAt(eng.trial, now));
            if (reason) {
              eng.handedOver = reason;
              eng.plan = planAfterHandOver(eng.plan, reason);
              // A remembered native that went quiet gets a fresh trial beside the library.
              if (eng.plan === 'both') eng.trial = FRESH_TRIAL;
            }
          }
        }

        emitAll([...libraryAll, ...(nativeFound?.values ?? [])], prefer, early);
      } finally {
        durations.push(performance.now() - t0);
        if (durations.length > 30) durations.shift();
        nextAt = t0 + nextDelayMs(libraryMs, runLibrary ? 'main' : 'native');
      }
    };

    const schedule = () => {
      if (stopped) return;
      frameHandle =
        frameKind === 'video' ? video.requestVideoFrameCallback(tick) : requestAnimationFrame(tick);
    };

    /**
     * Paced by the camera: once per new frame (requestAnimationFrame where
     * the browser has no frame callback), one decode in flight at most. Both
     * callbacks stop by themselves while the page is hidden, where a timer
     * went on decoding a stale frame in the background.
     */
    function tick() {
      if (stopped) return;
      schedule();
      const now = performance.now();
      lastTickAt = now;
      ticks += 1;
      if (!activeRef.current || inFlight || document.hidden || now < nextAt) return;
      const eng = engineFor(modeRef.current);
      if (!eng || !drawGuide(eng)) return;
      inFlight = true;
      void decodeFrame(eng, now)
        .catch(() => undefined)
        .finally(() => {
          inFlight = false;
        });
    }

    const onEnded = (e: Event) => {
      if (e.target === trackRef.current) void reopen();
    };
    const onUnmute = () => {
      void video.play().catch(() => undefined);
    };

    /** Torch, focus and what ⓘ reports, read off the track the camera actually gave us. */
    const tune = (track: MediaStreamTrack | null) => {
      const caps = track?.getCapabilities?.() as
        | (MediaTrackCapabilities & { torch?: boolean; focusMode?: string[] })
        | undefined;
      setTorchAvailable(Boolean(caps?.torch));
      if (caps?.torch && torchOnRef.current && track) {
        track
          .applyConstraints({ advanced: [{ torch: true } as MediaTrackConstraintSet] })
          .catch(() => undefined);
      } else if (!caps?.torch) {
        torchOnRef.current = false;
        setTorchOn(false);
      }
      const settings = track?.getSettings?.() as (MediaTrackSettings & { focusMode?: string }) | undefined;
      focusMode = settings?.focusMode ?? '';
      // A lens left on a fixed focus reads a label at one distance only.
      if (track && caps?.focusMode?.includes('continuous') && settings?.focusMode !== 'continuous') {
        track
          .applyConstraints({ advanced: [{ focusMode: 'continuous' } as MediaTrackConstraintSet] })
          .then(() => {
            focusMode = 'continuous';
          })
          .catch(() => undefined);
      }
    };

    /** Open the camera — the first time, and again when the watchdog finds it dead. */
    const openStream = async () => {
      opening = true;
      lastOpenAt = performance.now();
      try {
        // On a plain http:// origin `navigator.mediaDevices` does not exist at
        // all, so this would throw a TypeError that reads like a bug in our
        // code. It is not: it is the browser saying the page is not secure,
        // and the operator can act on that sentence.
        if (!navigator.mediaDevices?.getUserMedia) {
          setCam({ kind: 'failed', reason: 'insecure' });
          return;
        }
        // Ask for a REAL resolution. Without constraints iOS Safari hands
        // over 640×480, and a 10 cm label at arm's length is a handful of
        // pixels — the decoder was not slow, it was half blind. `ideal`
        // degrades gracefully on cameras that cannot do 1080p.
        const next = await navigator.mediaDevices.getUserMedia({
          video: {
            facingMode: 'environment',
            width: { ideal: 1920 },
            height: { ideal: 1080 },
          },
          audio: false,
        });
        if (stopped) {
          next.getTracks().forEach((track) => track.stop());
          return;
        }
        // A reopen replaces a stream that died; the dead one is released here.
        stream?.getTracks().forEach((track) => track.stop());
        stream = next;
        video.srcObject = next;
        await video.play();
        if (stopped) return;
        setCam({ kind: 'ready' });
        lastProgressAt = performance.now();
        lastTickAt = lastProgressAt;
        sawProgress = false;
        const track = next.getVideoTracks()[0] ?? null;
        trackRef.current = track;
        track?.addEventListener('ended', onEnded);
        track?.addEventListener('unmute', onUnmute);
        tune(track);
      } catch (err) {
        // Every one of these used to be swallowed, so a denied permission, a
        // camera another app is holding and a browser with no camera at all
        // looked identical: a black square and no explanation.
        const name = err instanceof Error ? err.name : '';
        setCam({
          kind: 'failed',
          reason: name === 'NotAllowedError' || name === 'SecurityError' ? 'denied' : 'unavailable',
        });
      } finally {
        opening = false;
      }
    };

    const reopen = async () => {
      if (stopped || opening || performance.now() - lastOpenAt < REOPEN_GAP_MS) return;
      await openStream();
    };

    /**
     * Coming back to a locked phone or from another app: the picture may be
     * paused (play it) or the track gone (open a new one).
     */
    const onVisibility = () => {
      if (document.hidden) return;
      lastProgressAt = performance.now();
      lastTickAt = lastProgressAt;
      if (trackRef.current?.readyState === 'ended') void reopen();
      else void video.play().catch(() => undefined);
    };

    /** Once per second: is the camera alive, and what does ⓘ say. */
    const report = (now: number) => {
      const eng = engines.get(modeRef.current);
      const decoder = eng?.plan ?? '';
      const quality = video.getVideoPlaybackQuality?.().totalVideoFrames;
      const frames = frameKind === 'video' || quality === undefined ? ticks : quality;
      const secs = Math.max((now - lastReport.at) / 1000, 0.001);
      const fps = Math.round((frames - lastReport.frames) / secs);
      const perSec = Math.round((attempts - lastReport.attempts) / secs);
      lastReport = { at: now, attempts, frames };
      const root = rootRef.current;
      if (root) {
        root.dataset.decoder = decoder;
        root.dataset.attempts = String(attempts);
        root.dataset.reads = String(readsRef.current);
      }
      if (!diagOpenRef.current) return;
      const sorted = [...durations].sort((a, b) => a - b);
      const p50 = sorted.length ? Math.round(sorted[Math.floor(sorted.length / 2)]!) : 0;
      setDiag(
        [
          modeRef.current === 'retail' ? 'retail' : null,
          decoder || '…',
          `${video.videoWidth}×${video.videoHeight}`,
          `${fps}fps`,
          `AF ${focusMode || '—'}`,
          `${perSec}/s`,
          `${p50}ms`,
        ]
          .filter(Boolean)
          .join(' · '),
      );
    };

    const watch = () => {
      if (stopped) return;
      watchTimer = setTimeout(watch, WATCH_MS);
      const now = performance.now();
      const track = trackRef.current;
      if (track && !document.hidden) {
        if (track.readyState === 'ended') {
          void reopen();
        } else if (activeRef.current) {
          if (video.currentTime !== lastMediaTime) {
            if (lastMediaTime >= 0) sawProgress = true;
            lastMediaTime = video.currentTime;
            lastProgressAt = now;
          } else if (sawProgress && now - lastProgressAt > FROZEN_MS) {
            // The picture stopped while the track says it is live — a frozen
            // camera after a screen lock. Nudge it, and open a new one.
            void video.play().catch(() => undefined);
            void reopen();
          }
          // The picture moves but the frame callback never comes: fall back
          // to the display's clock rather than decode nothing.
          if (
            frameKind === 'video' &&
            sawProgress &&
            now - lastTickAt > FROZEN_MS &&
            now - lastProgressAt < FROZEN_MS
          ) {
            if (frameHandle !== null) video.cancelVideoFrameCallback(frameHandle);
            frameKind = 'animation';
            schedule();
          }
        }
      }
      report(now);
    };

    /** Evidence that this phone reads only with the library is kept when the visit ends. */
    const remember = () => {
      for (const eng of engines.values()) {
        if (
          rememberZxing({
            nativeReads: eng.nativeReads,
            handedOver: eng.handedOver,
            zxingOwnReads: eng.zxingOwnReads,
            zxingProof: eng.trial.zxingProof,
          })
        ) {
          writeVerdict(eng.mode, 'zxing');
        }
      }
    };

    document.addEventListener('visibilitychange', onVisibility);
    // Closing the tab or a full reload runs no React cleanup; this does.
    window.addEventListener('pagehide', remember);
    void engineFor(modeRef.current);
    void openStream();
    schedule();
    watch();

    return () => {
      stopped = true;
      remember();
      if (frameHandle !== null) {
        if (frameKind === 'video') video.cancelVideoFrameCallback(frameHandle);
        else cancelAnimationFrame(frameHandle);
      }
      if (watchTimer) clearTimeout(watchTimer);
      document.removeEventListener('visibilitychange', onVisibility);
      window.removeEventListener('pagehide', remember);
      stream?.getTracks().forEach((track) => track.stop());
      trackRef.current = null;
    };
  }, []);

  const area = READ_AREA[mode];
  const insetX = ((1 - area.w) / 2) * 100;
  const insetY = ((1 - area.h) / 2) * 100;

  return (
    <div
      ref={rootRef}
      data-testid="scan-viewfinder"
      className="relative mx-auto aspect-square w-full max-w-[19rem] overflow-hidden rounded-xl bg-black"
    >
      <video ref={videoRef} className="h-full w-full object-cover" muted playsInline />

      <div className="pointer-events-none absolute inset-0">
        {/* Everything outside the read area is dimmed — and genuinely
            ignored, which is the point of dimming it. Four panels rather
            than a masked overlay: mask-composite is still unreliable on the
            Android WebViews these phones run. */}
        <div className="absolute inset-x-0 top-0 bg-black/50" style={{ height: `${insetY}%` }} />
        <div className="absolute inset-x-0 bottom-0 bg-black/50" style={{ height: `${insetY}%` }} />
        <div
          className="absolute left-0 bg-black/50"
          style={{ top: `${insetY}%`, bottom: `${insetY}%`, width: `${insetX}%` }}
        />
        <div
          className="absolute right-0 bg-black/50"
          style={{ top: `${insetY}%`, bottom: `${insetY}%`, width: `${insetX}%` }}
        />

        {/* Corner brackets: a full border reads as a photo frame, corners
            read as "put the code in here". */}
        <div
          className="absolute"
          style={{
            left: `${insetX}%`,
            top: `${insetY}%`,
            width: `${area.w * 100}%`,
            height: `${area.h * 100}%`,
          }}
        >
          <span className="absolute left-0 top-0 h-7 w-7 rounded-tl-lg border-l-4 border-t-4 border-white/90" />
          <span className="absolute right-0 top-0 h-7 w-7 rounded-tr-lg border-r-4 border-t-4 border-white/90" />
          <span className="absolute bottom-0 left-0 h-7 w-7 rounded-bl-lg border-b-4 border-l-4 border-white/90" />
          <span className="absolute bottom-0 right-0 h-7 w-7 rounded-br-lg border-b-4 border-r-4 border-white/90" />
        </div>
      </div>

      {/* The one thing this component never did: say what is wrong. A black
          square means "denied", "no https", "camera busy" and "still
          starting" all at once, and the operator cannot act on any of them.
          The message sits over the picture rather than under it, because on
          a phone the space under the viewfinder belongs to the counter. */}
      {cam.kind === 'failed' && (
        <p
          data-testid="scan-camera-error"
          className="absolute inset-x-2 top-1/2 -translate-y-1/2 rounded-lg bg-bad/90 p-2 text-center text-sm font-semibold text-white"
        >
          {cam.reason === 'insecure'
            ? t('scanNeedsHttps')
            : cam.reason === 'denied'
              ? t('scanNoPermission')
              : t('scanNoCamera')}
        </p>
      )}
      {cam.kind === 'ready' && quiet && !everRead && (
        <p
          data-testid="scan-quiet-hint"
          className="absolute inset-x-2 bottom-2 rounded-lg bg-black/70 p-2 text-center text-xs font-semibold text-white"
        >
          {t('scanNothingRead')}
        </p>
      )}

      {/* Technical tokens only — it is read off a screenshot by whoever
          fixes the phone, not by the operator. */}
      {diagOpen && (
        <p
          data-testid="scan-diag"
          className="absolute left-1 right-11 top-1 break-all rounded bg-black/70 p-1 font-mono text-2xs text-white"
        >
          {diag}
        </p>
      )}
      <button
        type="button"
        onClick={toggleDiag}
        data-testid="scan-diag-toggle"
        aria-pressed={diagOpen}
        aria-label={ts('diagnostics')}
        title={ts('diagnostics')}
        className="absolute right-1 top-1 grid h-9 w-9 place-items-center rounded-full bg-black/40 text-base text-white"
      >
        ⓘ
      </button>

      {torchAvailable && (
        <button
          type="button"
          onClick={toggleTorch}
          data-testid="scan-torch"
          aria-pressed={torchOn}
          className={`absolute bottom-2 right-2 grid h-11 w-11 place-items-center rounded-full text-xl ${
            torchOn ? 'bg-white text-black' : 'bg-black/60 text-white'
          }`}
        >
          🔦
        </button>
      )}
    </div>
  );
}
