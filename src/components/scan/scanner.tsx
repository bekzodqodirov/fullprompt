'use client';

import { useEffect, useRef } from 'react';

/**
 * Scan input core (spec 6.4 / §15): phone camera via the native
 * BarcodeDetector when available, @zxing/browser fallback otherwise, plus
 * USB/Bluetooth HID scanners (they type the code and press Enter). Feedback
 * stays local-first — the parent handles accept/reject in <300 ms.
 */
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
    let zxingStop: (() => void) | null = null;
    let timer: ReturnType<typeof setInterval> | null = null;

    void (async () => {
      try {
        stream = await navigator.mediaDevices.getUserMedia({
          video: { facingMode: 'environment' },
          audio: false,
        });
        if (stopped) {
          stream.getTracks().forEach((track) => track.stop());
          return;
        }
        video.srcObject = stream;
        await video.play();

        const DetectorCtor = (
          window as unknown as {
            BarcodeDetector?: new (opts: { formats: string[] }) => {
              detect(source: HTMLVideoElement): Promise<{ rawValue: string }[]>;
            };
          }
        ).BarcodeDetector;
        if (DetectorCtor) {
          const detector = new DetectorCtor({ formats: ['qr_code', 'code_128'] });
          timer = setInterval(async () => {
            if (video.readyState < 2) return;
            try {
              const found = await detector.detect(video);
              for (const item of found) emit(item.rawValue);
            } catch {
              /* per-frame detect errors are non-fatal */
            }
          }, 180);
        } else {
          const { BrowserQRCodeReader } = await import('@zxing/browser');
          const reader = new BrowserQRCodeReader();
          const controls = await reader.decodeFromVideoElement(video, (result) => {
            if (result) emit(result.getText());
          });
          zxingStop = () => controls.stop();
        }
      } catch {
        /* camera unavailable (denied / desktop without cam) — HID still works */
      }
    })();

    return () => {
      stopped = true;
      if (timer) clearInterval(timer);
      zxingStop?.();
      stream?.getTracks().forEach((track) => track.stop());
    };
  }, [active]);

  return (
    <video
      ref={videoRef}
      className="h-44 w-full rounded-xl bg-black object-cover"
      muted
      playsInline
    />
  );
}
