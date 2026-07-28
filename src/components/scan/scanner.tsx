'use client';

import { useEffect, useRef, useState } from 'react';

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

export function Scanner({
  active,
  onCode,
}: {
  active: boolean;
  onCode: (code: string) => void;
}) {
  const videoRef = useRef<HTMLVideoElement>(null);
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

    void (async () => {
      try {
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

        const track = stream.getVideoTracks()[0] ?? null;
        trackRef.current = track;
        const capabilities = track?.getCapabilities?.() as
          | (MediaTrackCapabilities & { torch?: boolean })
          | undefined;
        if (capabilities?.torch) setTorchAvailable(true);

        const DetectorCtor = (
          window as unknown as {
            BarcodeDetector?: new (opts: { formats: string[] }) => {
              detect(source: CanvasImageSource): Promise<{ rawValue: string }[]>;
            };
          }
        ).BarcodeDetector;

        if (DetectorCtor) {
          const detector = new DetectorCtor({ formats: ['qr_code', 'code_128'] });
          timer = setInterval(async () => {
            if (!drawGuide()) return;
            try {
              const found = await detector.detect(canvas);
              for (const item of found) emit(item.rawValue);
            } catch {
              /* per-frame detect errors are non-fatal */
            }
          }, 180);
        } else {
          // The continuous `decodeFromVideoElement` helper reads the whole
          // frame and cannot be told otherwise, so the fallback drives the
          // same cropped canvas on the same interval.
          const { BrowserQRCodeReader } = await import('@zxing/browser');
          const reader = new BrowserQRCodeReader();
          timer = setInterval(() => {
            if (!drawGuide()) return;
            try {
              const result = reader.decodeFromCanvas(canvas);
              if (result) emit(result.getText());
            } catch {
              /* NotFoundException on a frame with no code — the normal case */
            }
          }, 200);
        }
      } catch {
        /* camera unavailable (denied / desktop without cam) — HID still works */
      }
    })();

    return () => {
      stopped = true;
      if (timer) clearInterval(timer);
      stream?.getTracks().forEach((track) => track.stop());
      trackRef.current = null;
      setTorchAvailable(false);
      setTorchOn(false);
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
