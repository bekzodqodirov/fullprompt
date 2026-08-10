'use client';

import { useEffect, useRef, useState } from 'react';
import { useTranslations } from 'next-intl';
import { nativeUsable, shouldHandOver } from './decoder-choice';

/**
 * Scan input core (spec 6.4 / §15): phone camera via the native
 * BarcodeDetector when available, @zxing/browser fallback otherwise, plus
 * USB/Bluetooth HID scanners (they type the code and press Enter). Feedback
 * stays local-first — the parent handles accept/reject in <300 ms.
 *
 * The camera reads ONLY what is inside the square guide (owner: "ekranda
 * ko'rinadigandan kattaroq joyni scan qilyapti"). The preview used
 * `object-cover`, which crops what you SEE but not what the decoder reads, so
 * a label lying beside the box being scanned — or one still in the previous
 * box — was picked up off screen and silently accepted. Every frame is now
 * cropped to the guide before it reaches either decoder, which turns the
 * frame on screen from decoration into a promise.
 *
 * WHY THE DECODER IS CHOSEN THE WAY IT IS. The owner reported the camera
 * opening in the Kashgar warehouse and never reading a code, while the same
 * screen on his own phone worked — one codebase, two devices, so the
 * difference IS the defect. `window.BarcodeDetector` says only that the API
 * is compiled into the browser; on Android the actual reading is done by a
 * platform module that arrives through Google Play Services, which a phone
 * bought in China does not have. There it exists, never throws, and returns
 * an empty list for ever. So the native detector is now (a) feature-tested
 * with the documented `getSupportedFormats()`, (b) abandoned the moment it
 * throws, and (c) abandoned if it has not read a single code in the first few
 * seconds of live frames — and @zxing, which needs nothing from the platform,
 * takes over. Its module is fetched at start rather than at the moment of
 * failure, because these are the offline screens and a chunk that has to
 * cross the warehouse wifi exactly when the decoder gives up is a chunk that
 * will not arrive.
 */

/** Side of the read area, as a fraction of the visible square. */
const GUIDE = 0.74;
/**
 * Pixels the cropped frame is scaled to before decoding.
 *
 * 512 was tuned against the camera's DEFAULT stream, which on the iPhones in
 * the Chinese warehouses is 640×480 — the guide square of that is ~350 px,
 * and a QR module a couple of pixels wide is what "juda sekin tanidi" looks
 * like. The stream below now asks for 1080p, so the crop arrives sharp and
 * 640 keeps more of that sharpness for the decoder.
 */
const ROI_PX = 640;
/**
 * Frames the native detector gets to prove it can read anything at all.
 *
 * 25 frames at 180 ms is about four and a half seconds of live picture. A
 * detector that has not read one code in that time is either broken or
 * pointed at nothing, and those two cases cannot be told apart from here —
 * so we stop guessing and hand over to a decoder that needs nothing from the
 * platform. The cost of being wrong is a little more CPU; the cost of the
 * other answer is a warehouse that cannot scan.
 */
const NATIVE_TRIAL_FRAMES = 25;

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

export function Scanner({
  active,
  onCode,
}: {
  active: boolean;
  onCode: (code: string) => void;
}) {
  const t = useTranslations('common');
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
  // Per-code cooldown so a QR held in front of the camera fires once.
  const cooldownRef = useRef(new Map<string, number>());
  // The torch, where the hardware offers one: a warehouse aisle in the
  // evening is where scanning actually slows down, and the phone knows how
  // to light it. Hidden entirely when the track has no torch capability.
  const trackRef = useRef<MediaStreamTrack | null>(null);
  const [torchAvailable, setTorchAvailable] = useState(false);
  const [torchOn, setTorchOn] = useState(false);

  async function toggleTorch() {
    const track = trackRef.current;
    if (!track) return;
    const next = !torchOn;
    try {
      await track.applyConstraints({ advanced: [{ torch: next } as MediaTrackConstraintSet] });
      setTorchOn(next);
    } catch {
      /* the capability lied — leave the button state alone */
    }
  }

  function emit(raw: string) {
    const code = raw.trim().toUpperCase();
    if (!code) return;
    setEverRead(true);
    const now = Date.now();
    const last = cooldownRef.current.get(code) ?? 0;
    if (now - last < 2500) return;
    cooldownRef.current.set(code, now);
    onCodeRef.current(code);
  }

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
        if (buffer.length >= 4) emit(buffer);
        buffer = '';
      } else if (e.key.length === 1) {
        buffer += e.key;
      }
    };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, [active]);

  // Camera scanning.
  useEffect(() => {
    if (!active || !videoRef.current) return;
    const video = videoRef.current;
    let stream: MediaStream | null = null;
    let stopped = false;
    let timer: ReturnType<typeof setInterval> | null = null;

    const canvas = document.createElement('canvas');
    canvas.width = ROI_PX;
    canvas.height = ROI_PX;
    const ctx = canvas.getContext('2d', { willReadFrequently: true });

    /**
     * Copy the guide square out of the current frame.
     *
     * The preview is a square box with `object-cover`, so what the operator
     * sees is the centred square of the frame's shorter side, and the guide
     * is `GUIDE` of that. Cropping to exactly that rectangle is what makes
     * the drawn frame mean something.
     */
    const drawGuide = (): boolean => {
      const vw = video.videoWidth;
      const vh = video.videoHeight;
      if (!ctx || !vw || !vh || video.readyState < 2) return false;
      const side = Math.min(vw, vh) * GUIDE;
      ctx.drawImage(video, (vw - side) / 2, (vh - side) / 2, side, side, 0, 0, ROI_PX, ROI_PX);
      return true;
    };

    // Fetched NOW, not when it is needed — see the note at the top of the file.
    // A rejection is an answer (null), not a crash: HID and the native
    // detector must keep working on a phone that cannot load the chunk.
    const zxingReady = import('@zxing/browser')
      .then((mod) => new mod.BrowserQRCodeReader())
      .catch(() => null);

    /** The zxing loop. Also the place the native detector hands over to. */
    const runZxing = async () => {
      const reader = await zxingReady;
      if (stopped || !reader) return;
      // The continuous `decodeFromVideoElement` helper reads the whole frame
      // and cannot be told otherwise, so this drives the same cropped canvas.
      timer = setInterval(() => {
        if (!drawGuide()) return;
        try {
          const result = reader.decodeFromCanvas(canvas);
          if (result) emit(result.getText());
        } catch {
          /* NotFoundException on a frame with no code — the normal case */
        }
      }, 200);
    };

    /**
     * The native detector, or null if this browser only pretends to have one.
     *
     * `getSupportedFormats()` is the documented way to ask, and skipping it
     * was the whole bug: the constructor happily accepts formats the platform
     * cannot read.
     */
    const nativeDetector = async (): Promise<NativeDetector | null> => {
      const Ctor = (window as unknown as { BarcodeDetector?: DetectorCtorType }).BarcodeDetector;
      if (!Ctor) return null;
      try {
        if (!nativeUsable(await Ctor.getSupportedFormats?.())) return null;
        return new Ctor({ formats: ['qr_code', 'code_128'] });
      } catch {
        return null;
      }
    };

    void (async () => {
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
        stream = await navigator.mediaDevices.getUserMedia({
          video: {
            facingMode: 'environment',
            width: { ideal: 1920 },
            height: { ideal: 1080 },
          },
          audio: false,
        });
        if (stopped) {
          stream.getTracks().forEach((track) => track.stop());
          return;
        }
        video.srcObject = stream;
        await video.play();
        if (stopped) return;
        setCam({ kind: 'ready' });

        const track = stream.getVideoTracks()[0] ?? null;
        trackRef.current = track;
        const capabilities = track?.getCapabilities?.() as
          | (MediaTrackCapabilities & { torch?: boolean })
          | undefined;
        if (capabilities?.torch) setTorchAvailable(true);

        const detector = await nativeDetector();
        if (stopped) return;
        if (!detector) {
          await runZxing();
          return;
        }

        let framesSeen = 0;
        let nativeWorks = false;
        const handOver = () => {
          if (timer) clearInterval(timer);
          timer = null;
          void runZxing();
        };
        timer = setInterval(async () => {
          if (!drawGuide()) return;
          framesSeen += 1;
          let threw = false;
          try {
            const found = await detector.detect(canvas);
            if (found.length > 0) {
              nativeWorks = true;
              for (const item of found) emit(item.rawValue);
            }
          } catch {
            threw = true;
          }
          if (shouldHandOver({ framesSeen, nativeWorks, threw, trialFrames: NATIVE_TRIAL_FRAMES })) {
            handOver();
          }
        }, 180);
      } catch (err) {
        // Every one of these used to be swallowed, so a denied permission, a
        // camera another app is holding and a browser with no camera at all
        // looked identical: a black square and no explanation.
        const name = err instanceof Error ? err.name : '';
        setCam({
          kind: 'failed',
          reason: name === 'NotAllowedError' || name === 'SecurityError' ? 'denied' : 'unavailable',
        });
      }
    })();

    // "The camera has been open a while and has read nothing" is worth saying
    // out loud, because the manual door is one tap away and the operator has
    // no way to know it is the right one.
    const quietTimer = setTimeout(() => setQuiet(true), 12_000);

    return () => {
      stopped = true;
      if (timer) clearInterval(timer);
      clearTimeout(quietTimer);
      stream?.getTracks().forEach((track) => track.stop());
      trackRef.current = null;
      setTorchAvailable(false);
      setTorchOn(false);
      setCam({ kind: 'starting' });
      setQuiet(false);
    };
  }, [active]);

  const inset = ((1 - GUIDE) / 2) * 100;

  return (
    <div
      data-testid="scan-viewfinder"
      className="relative mx-auto aspect-square w-full max-w-[19rem] overflow-hidden rounded-xl bg-black"
    >
      <video ref={videoRef} className="h-full w-full object-cover" muted playsInline />

      <div className="pointer-events-none absolute inset-0">
        {/* Everything outside the read area is dimmed — and genuinely
            ignored, which is the point of dimming it. Four panels rather
            than a masked overlay: mask-composite is still unreliable on the
            Android WebViews these phones run. */}
        <div className="absolute inset-x-0 top-0 bg-black/50" style={{ height: `${inset}%` }} />
        <div className="absolute inset-x-0 bottom-0 bg-black/50" style={{ height: `${inset}%` }} />
        <div
          className="absolute left-0 bg-black/50"
          style={{ top: `${inset}%`, bottom: `${inset}%`, width: `${inset}%` }}
        />
        <div
          className="absolute right-0 bg-black/50"
          style={{ top: `${inset}%`, bottom: `${inset}%`, width: `${inset}%` }}
        />

        {/* Corner brackets: a full border reads as a photo frame, corners
            read as "put the code in here". */}
        <div
          className="absolute"
          style={{
            left: `${inset}%`,
            top: `${inset}%`,
            width: `${GUIDE * 100}%`,
            height: `${GUIDE * 100}%`,
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
