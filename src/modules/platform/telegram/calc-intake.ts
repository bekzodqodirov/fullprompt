import { v4 as uuidv4 } from 'uuid';
import { logger } from '../logger';
import { staffForChat } from './staff-bot';

/**
 * The «Hisoblatish» collection, as the bot holds it.
 *
 * A collection is a few minutes of one person's attention: press the button,
 * forward the client's files and facts, press «Bo'ldi». It lives in memory
 * with a TTL, like the round-35 task-result pendings and the round-21
 * connect flow — the FILES are not in memory, they go straight to storage
 * pre-bound to the note id minted here, exactly as the receiving wizard
 * pre-binds lot photos before the receipt exists.
 *
 * What that costs, stated plainly: a bot restart mid-collection loses the
 * typed text and the person starts again. The alternative — a table, a
 * status column and a cleanup job for abandoned rows — is more machinery
 * than a five-minute conversation deserves, and the confirmed result is
 * persisted the moment it matters.
 */

export type IntakeStage = 'section' | 'client' | 'material' | 'review';

export interface IntakeState {
  section: import('../../wms/calc/intake').CalcSection;
  stage: IntakeStage;
  /** Minted up front so photos can be stored against it while they arrive. */
  noteId: string;
  /** What staff typed to name the customer — a code, a phone, or a name. */
  clientHintRaw: string;
  /** Everything typed or captioned, in the order it came. */
  material: string[];
  fileCount: number;
  facts: import('../../wms/calc/intake').CalcFacts;
  steps: string[];
  aiUsed: boolean;
  /**
   * Photographs the model is allowed to LOOK at, downscaled.
   *
   * The owner's report: «kub kilosi rasimni ichiga yozilgan bo'lsa analiz
   * qilmayabti» — and he is right, the analysis only ever saw text. His
   * office photographs the packing list; the numbers on it were stored on
   * the card and read by nobody.
   *
   * Held in memory beside the rest of the collection (the FILES themselves
   * are already in storage against the note id — these are the reduced
   * copies the call sends). Capped in both directions: a handful of images,
   * downscaled, or a forwarded album is a request body nobody budgeted for.
   */
  images: { data: Buffer; mediaType: 'image/jpeg' }[];
  /** How many photos arrived but were NOT reduced — counted, never silent. */
  imagesSkipped: number;
  /**
   * The one live «Bo'ldi» control. Every material message used to answer
   * with a fresh keyboard, so eight forwards left eight buttons and the
   * person could not tell which was current (his second report). The prompt
   * is EDITED in place instead, and its id is how.
   */
  promptMessageId: number | null;
  expires: number;
}

/** At most this many photographs reach the model. */
export const MAX_INTAKE_IMAGES = 6;

const TTL_MS = 30 * 60_000;
const collections = new Map<string, IntakeState>();

const key = (chatId: bigint) => String(chatId);

export function startIntake(
  chatId: bigint,
  section: import('../../wms/calc/intake').CalcSection,
): IntakeState {
  const state: IntakeState = {
    section,
    stage: 'client',
    noteId: uuidv4(),
    clientHintRaw: '',
    material: [],
    fileCount: 0,
    facts: {},
    steps: [],
    aiUsed: false,
    images: [],
    imagesSkipped: 0,
    promptMessageId: null,
    expires: Date.now() + TTL_MS,
  };
  collections.set(key(chatId), state);
  return state;
}

/** The live collection for a chat, or nothing — expiry is checked on read. */
export function activeIntake(chatId: bigint): IntakeState | null {
  const state = collections.get(key(chatId));
  if (!state) return null;
  if (state.expires <= Date.now()) {
    collections.delete(key(chatId));
    return null;
  }
  return state;
}

export function updateIntake(chatId: bigint, patch: Partial<IntakeState>): IntakeState | null {
  const state = activeIntake(chatId);
  if (!state) return null;
  const next = { ...state, ...patch, expires: Date.now() + TTL_MS };
  collections.set(key(chatId), next);
  return next;
}

export function endIntake(chatId: bigint): void {
  collections.delete(key(chatId));
}

/**
 * Read the collected material with the model, then keep whatever the person
 * typed for anything it could not find.
 *
 * The manual layer is not a fallback for a broken key — it is the truth
 * beside the model's reading: a staff member who typed «5 kub» meant it,
 * and a model that missed it must not erase it.
 */
export async function analyzeCollected(state: IntakeState): Promise<IntakeState> {
  const { analyzeIntake } = await import('../../wms/calc/intake-ai');
  const { parseManualFacts } = await import('../../wms/calc/intake-manual');
  const text = state.material.join('\n');
  const manual = parseManualFacts(text);

  const ai = await analyzeIntake({
    section: state.section,
    text,
    fileCount: state.fileCount,
    images: state.images,
  }).catch((err: unknown) => {
    logger.warn({ err }, 'intake analyze failed');
    return null;
  });

  // Typed facts win over read ones: the person is looking at the material.
  const facts = {
    fromCity: manual.fromCity ?? ai?.facts.fromCity ?? null,
    toCity: manual.toCity ?? ai?.facts.toCity ?? null,
    weightKg: manual.weightKg ?? ai?.facts.weightKg ?? null,
    volumeM3: manual.volumeM3 ?? ai?.facts.volumeM3 ?? null,
    goods: ai?.facts.goods?.length ? ai.facts.goods : manual.goods,
  };
  return {
    ...state,
    facts,
    steps: ai?.steps ?? [],
    aiUsed: Boolean(ai),
    stage: 'review',
  };
}

/** Is this chat a member of staff who may use «Hisoblatish»? Everyone is
 * (owner's answer 3) — the only question is whether they are staff at all. */
export async function mayCollect(chatId: bigint): Promise<boolean> {
  return (await staffForChat(chatId)) !== null;
}
