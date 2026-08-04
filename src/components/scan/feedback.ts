'use client';

/**
 * Cross-platform scan feedback: vibration (Android) + a WebAudio beep
 * (iPhone has no vibration API — sound is the only physical signal).
 * iOS unlocks audio only inside a user gesture, so screens call
 * `armScanAudio()` on mount to piggyback on the first touch.
 */

let ctx: AudioContext | null = null;

function audioCtx(): AudioContext | null {
  try {
    ctx ??= new (window.AudioContext ??
      (window as unknown as { webkitAudioContext: typeof AudioContext }).webkitAudioContext)();
    return ctx;
  } catch {
    return null;
  }
}

/** Register a one-time gesture listener that unlocks the AudioContext (iOS). */
export function armScanAudio(): () => void {
  const unlock = () => {
    const a = audioCtx();
    if (a && a.state === 'suspended') void a.resume();
    window.removeEventListener('touchend', unlock);
    window.removeEventListener('click', unlock);
  };
  window.addEventListener('touchend', unlock, { once: true });
  window.addEventListener('click', unlock, { once: true });
  return () => {
    window.removeEventListener('touchend', unlock);
    window.removeEventListener('click', unlock);
  };
}

function beep(kind: 'ok' | 'dup' | 'bad'): void {
  const a = audioCtx();
  if (!a) return;
  if (a.state === 'suspended') void a.resume();
  try {
    const durations = { ok: 0.12, dup: 0.2, bad: 0.4 };
    const freqs = { ok: 1250, dup: 700, bad: 280 };
    const osc = a.createOscillator();
    const gain = a.createGain();
    osc.connect(gain);
    gain.connect(a.destination);
    osc.type = 'square';
    osc.frequency.value = freqs[kind];
    gain.gain.setValueAtTime(0.2, a.currentTime);
    gain.gain.exponentialRampToValueAtTime(0.001, a.currentTime + durations[kind]);
    osc.start();
    osc.stop(a.currentTime + durations[kind]);
  } catch {
    /* audio still locked — vibration/flash carry the signal */
  }
}

/** Physical scan verdict: vibrate where supported, always try the beep. */
export function scanFeedback(kind: 'ok' | 'dup' | 'bad'): void {
  if (typeof navigator !== 'undefined' && 'vibrate' in navigator) {
    navigator.vibrate(kind === 'ok' ? 60 : [70, 60, 70]);
  }
  beep(kind);
}
