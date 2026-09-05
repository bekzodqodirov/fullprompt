/**
 * Writing a zametka from the phone (his answer 2c).
 *
 * Its own map, deliberately NOT `calc-intake`'s: that state is patched
 * wholesale by spread and belongs to a flow that costs a seller minutes of
 * forwarding. Two collectors in one chat is the shape this bot has already
 * paid for twice, so the rule is stated once and asked by BOTH doors —
 * `activeCapture` here, `activeIntake` there, and each refuses in WORDS while
 * the other is live rather than silently discarding somebody's work.
 *
 * In memory, thirty minutes, lost on deploy — the same trade the calc intake
 * states at its own head. What is NOT lost is anything already stored: photos
 * and files are written to the object store as they arrive, pre-bound to the
 * note id this capture minted, so a restart costs the typed words and not the
 * uploads.
 */

export type CaptureStage = 'title' | 'parts';

export interface CaptureState {
  /** Minted when the capture opens; the note is saved under it. */
  noteId: string;
  stage: CaptureStage;
  title: string;
  /** Every text message that arrived after the title, joined on save. */
  body: string[];
  fileCount: number;
  /** Asked only of somebody who may publish (his answer 1b). */
  shared: boolean;
  expires: number;
}

const TTL_MS = 30 * 60_000;
const captures = new Map<string, CaptureState>();

export function startCapture(chatId: bigint, noteId: string): CaptureState {
  const state: CaptureState = {
    noteId,
    stage: 'title',
    title: '',
    body: [],
    fileCount: 0,
    shared: false,
    expires: Date.now() + TTL_MS,
  };
  captures.set(String(chatId), state);
  return state;
}

export function activeCapture(chatId: bigint): CaptureState | null {
  const key = String(chatId);
  const state = captures.get(key);
  if (!state) return null;
  if (state.expires <= Date.now()) {
    captures.delete(key);
    return null;
  }
  return state;
}

export function updateCapture(
  chatId: bigint,
  patch: Partial<Omit<CaptureState, 'noteId' | 'expires'>>,
): CaptureState | null {
  const state = activeCapture(chatId);
  if (!state) return null;
  const next = { ...state, ...patch, expires: Date.now() + TTL_MS };
  captures.set(String(chatId), next);
  return next;
}

export function endCapture(chatId: bigint): void {
  captures.delete(String(chatId));
}

/** What the capture has to show for itself — the save gate, in one place. */
export function captureIsEmpty(state: CaptureState): boolean {
  return state.body.join('').trim() === '' && state.fileCount === 0;
}
