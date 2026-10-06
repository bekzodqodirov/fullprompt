import type { SourceMessage } from '../tasks/service';
import { addDays, tashkentDay } from '../time/tashkent';

/**
 * A task being given from the staff bot (docs/TELEGRAM-TOPSHIRIQ.md §3, his
 * 1b: «hodimlar biriga ish buyura olishi kerak telegram orqali va bu juda
 * qulay bolishi kerak»).
 *
 * ONE collector, two doors: «➕ Topshiriq» (and /topshiriq) starts it empty;
 * a forwarded message's «📌 Topshiriq qilish» starts it with that message
 * (and its album) as the first sources. The shape of `note-capture.ts`: an
 * in-memory map keyed by chat, thirty minutes, lost on a deploy — the same
 * trade the calc intake and the zametka capture state. What a deploy cannot
 * lose is the task once it is made: nothing here writes until a due is
 * pressed, and the files are downloaded after the task exists (a pg-boss job,
 * telegram-mechanics-26), so an abandoned draft leaves no orphan.
 *
 * Everything that DECIDES is pure and here — the stage machine, the title cut,
 * the typed date, the album settle — so it is a test; the grammy shell in
 * staff-handlers.ts moves messages in and out.
 */

export type DraftStage = 'who' | 'what' | 'when' | 'date';

/** What a non-text part of the draft is — the title when nothing was typed. */
export type PartKind = 'photo' | 'voice' | 'audio' | 'video' | 'video_note' | 'document' | 'contact' | 'location';

/** A file to be downloaded for the web once the task exists (his 3a). */
export interface DraftFile {
  fileId: string;
  kind: Exclude<PartKind, 'contact' | 'location'>;
  name: string | null;
  mime: string | null;
  size: number | null;
}

/** The due the person chose — the four buttons, or a date they typed. */
export interface DraftDue {
  /** What `parseDue` reads: '' (none), 'YYYY-MM-DD', or 'YYYY-MM-DDTHH:mm'. */
  dueAt: string;
  /** The typist's wall clock when an hour was named — Tashkent's, −300. */
  tzOffsetMin: number | null;
  /** How the confirmation says it («ertaga», «12.10 15:00», «muddatsiz»). */
  label: string;
}

export interface TaskDraft {
  stage: DraftStage;
  assigneeId: string | null;
  assigneeName: string | null;
  /** Typed lines (and own captions), joined into the note. */
  texts: string[];
  /** Notes that are not typed words but must reach the web (a contact, a place). */
  facts: string[];
  /** The kind of the first non-text part, and whether it was a forward. */
  firstKind: PartKind | null;
  firstForwarded: boolean;
  /** The author's own messages, forwarded to the assignee before the text. */
  sources: SourceMessage[];
  files: DraftFile[];
  /** Files the web will not get — over Telegram's download limit, told in words. */
  tooBig: string[];
  /** Parts that came past the source cap and travel to nobody — told once (review bot-11). */
  dropped: number;
  /** media_group_id → when its last part arrived (ms) — the album settle. */
  albums: Record<string, number>;
  /** The bot message whose keyboard the draft edits. */
  promptMessageId: number | null;
  /** A due pressed while an album was still arriving: the settle timer creates the task. */
  pendingDue: DraftDue | null;
  /** The due keyboard has been shown once (after the first part, or at once on Door B). */
  dueShown: boolean;
  expires: number;
}

const TTL_MS = 30 * 60_000;
/** An album has settled once no part of it arrived for this long (telegram-mechanics-17). */
export const ALBUM_SETTLE_MS = 1_500;
/** After a task is made, a late album part is still appended to it for this long. */
export const LINGER_MS = 60_000;
/** The draft's own caps: forwards Telegram can carry in one call, and Bot API getFile's limit. */
export const MAX_DRAFT_SOURCES = 10;
export const MAX_DRAFT_FILE_BYTES = 20 * 1024 * 1024;

/**
 * The author's sentence for the files the web will not get (3a promises the
 * files on the site; Telegram hands a bot nothing past 20 MB) — said once,
 * naming them, and nothing at all when every file fits (tests-completeness-25).
 */
export function tooBigLine(names: string[]): string | null {
  return names.length > 0 ? `⚠ Saytga yuklanmadi — 20 MB dan katta; Telegramda yuborildi: ${names.join(', ')}` : null;
}
/** A title is the first typed line cut here, on a word. */
export const TITLE_MAX = 120;
export const NOTE_MAX = 4000;

const drafts = new Map<string, TaskDraft>();

export function startDraft(
  chatId: bigint,
  seed: Partial<Pick<TaskDraft, 'sources' | 'files' | 'firstKind' | 'firstForwarded' | 'texts' | 'facts' | 'tooBig'>> = {},
): TaskDraft {
  const state: TaskDraft = {
    stage: 'who',
    assigneeId: null,
    assigneeName: null,
    texts: seed.texts ?? [],
    facts: seed.facts ?? [],
    firstKind: seed.firstKind ?? null,
    firstForwarded: seed.firstForwarded ?? false,
    sources: (seed.sources ?? []).slice(0, MAX_DRAFT_SOURCES),
    files: seed.files ?? [],
    // A seed's oversized files are still told at the end (review bot-7): a
    // hard [] here dropped Door B's «20 MB dan katta» sentence.
    tooBig: seed.tooBig ?? [],
    dropped: 0,
    albums: {},
    promptMessageId: null,
    pendingDue: null,
    dueShown: false,
    expires: Date.now() + TTL_MS,
  };
  drafts.set(String(chatId), state);
  return state;
}

/**
 * Does a refused task keep the person it was for? Not when the refusal is
 * ABOUT that person — they left, they never sign in, they are gone — and the
 * draft must ask «Kimga?» again; any other refusal keeps the pick and asks
 * for the due again (review bot-5: the draft came back with the pick dropped
 * and asked nothing, so the next typed line was read as a name search).
 */
const PICK_REFUSALS: ReadonlySet<string> = new Set(['no_assignee', 'assignee_inactive', 'assignee_no_login']);

export function refusalKeepsPick(result: string): boolean {
  return !PICK_REFUSALS.has(result);
}

export function activeDraft(chatId: bigint): TaskDraft | null {
  const key = String(chatId);
  const state = drafts.get(key);
  if (!state) return null;
  if (state.expires <= Date.now()) {
    drafts.delete(key);
    return null;
  }
  return state;
}

export function updateDraft(chatId: bigint, patch: Partial<Omit<TaskDraft, 'expires'>>): TaskDraft | null {
  const state = activeDraft(chatId);
  if (!state) return null;
  const next = { ...state, ...patch, expires: Date.now() + TTL_MS };
  drafts.set(String(chatId), next);
  return next;
}

export function endDraft(chatId: bigint): void {
  drafts.delete(String(chatId));
}

/** One part of what the author sent — a text, a file, a forward, an album member. */
export interface DraftPart {
  messageId: number;
  /** Typed by the author (a message, or an own caption) — never a forward's words. */
  text?: string | null;
  kind?: PartKind | null;
  forwarded: boolean;
  mediaGroupId?: string | null;
  file?: Omit<DraftFile, 'kind'> | null;
  /** A contact or a place, as one line the web keeps. */
  fact?: string | null;
}

/**
 * What one part does to the draft. A text-only, own message is the note and
 * not a source (the note IS its words); anything else is forwarded to the
 * assignee AND, when it carries bytes, downloaded for the web. A forward's
 * words are never copied into the note: they are somebody else's — a
 * customer's chat, often — and the pointer is all that is stored
 * (access-money-12's premise).
 */
export function withPart(draft: TaskDraft, part: DraftPart, chatId: number, now = Date.now()): TaskDraft {
  const texts = part.text?.trim() && !part.forwarded ? [...draft.texts, part.text.trim()] : draft.texts;
  const isSource = part.forwarded || Boolean(part.kind);
  const fits = draft.sources.length < MAX_DRAFT_SOURCES;
  const sources = isSource && fits ? [...draft.sources, { chatId, messageId: part.messageId }] : draft.sources;
  let files = draft.files;
  let tooBig = draft.tooBig;
  if (part.file && part.kind && part.kind !== 'contact' && part.kind !== 'location') {
    if (part.file.size !== null && part.file.size > MAX_DRAFT_FILE_BYTES) {
      tooBig = [...tooBig, part.file.name ?? KIND_TITLE[part.kind]];
    } else {
      files = [...files, { ...part.file, kind: part.kind }];
    }
  }
  return {
    ...draft,
    texts,
    facts: part.fact ? [...draft.facts, part.fact] : draft.facts,
    sources,
    files,
    tooBig,
    dropped: isSource && !fits ? draft.dropped + 1 : draft.dropped,
    // What the FIRST source was names the task when nothing was typed.
    firstKind: draft.sources.length === 0 && isSource ? (part.kind ?? null) : draft.firstKind,
    firstForwarded: draft.sources.length === 0 && isSource ? part.forwarded : draft.firstForwarded,
    albums: part.mediaGroupId ? { ...draft.albums, [part.mediaGroupId]: now } : draft.albums,
  };
}

/**
 * Is an album still arriving? Telegram delivers one as N updates, and a due
 * pressed between them would make the task without the rest — so a press
 * while any album's last part is younger than the settle window waits for
 * the settle timer (telegram-mechanics-17).
 */
export function albumSettled(draft: TaskDraft, now = Date.now(), settleMs = ALBUM_SETTLE_MS): boolean {
  return Object.values(draft.albums).every((at) => now - at >= settleMs);
}

const KIND_TITLE: Record<PartKind, string> = {
  voice: '🎤 Ovozli topshiriq',
  audio: '🎤 Ovozli topshiriq',
  photo: '🖼 Rasm',
  video: '🎬 Video',
  video_note: '🎬 Video',
  document: '📎 Fayl',
  contact: '👤 Kontakt',
  location: '📍 Joylashuv',
};

/**
 * The task's title: the first typed line cut at ≤ 120 characters on a word —
 * or, when nothing was typed, what the draft IS («🎤 Ovozli topshiriq»,
 * «↪️ Yo‘naltirilgan xabar»…), so the list on /bugun still says something.
 */
export function draftTitle(draft: Pick<TaskDraft, 'texts' | 'firstKind' | 'firstForwarded'>): string {
  const first = draft.texts.join('\n').split('\n').map((line) => line.trim()).find(Boolean);
  if (first) return cutTitle(first);
  if (draft.firstForwarded) return '↪️ Yo‘naltirilgan xabar';
  return draft.firstKind ? KIND_TITLE[draft.firstKind] : '📝 Topshiriq';
}

/** Cut on a word, in code points, never through half an emoji. */
export function cutTitle(line: string, max = TITLE_MAX): string {
  const chars = Array.from(line);
  if (chars.length <= max) return line;
  const cut = chars.slice(0, max).join('');
  const space = cut.lastIndexOf(' ');
  return (space > cut.length / 2 ? cut.slice(0, space) : cut).trimEnd();
}

/** The note: every typed line, then the contacts and places, within the column's cap. */
export function draftNote(draft: Pick<TaskDraft, 'texts' | 'facts'>): string {
  const all = [...draft.texts, ...draft.facts].join('\n').trim();
  return Array.from(all).slice(0, NOTE_MAX).join('');
}

export type DueButton = 'due_b' | 'due_e' | 'due_i' | 'due_n';

/**
 * The four due buttons on the Tashkent calendar (spec §3): today, tomorrow,
 * the day after, none. A DAY, never a moment — `parseDue` makes a bare date
 * the whole day, which is what «ertaga» means.
 */
export function dueFromButton(button: DueButton, now = new Date()): DraftDue {
  const today = tashkentDay(now);
  if (button === 'due_n') return { dueAt: '', tzOffsetMin: null, label: 'muddatsiz' };
  const offset = button === 'due_b' ? 0 : button === 'due_e' ? 1 : 2;
  const day = addDays(today, offset);
  const label = button === 'due_b' ? 'bugun' : button === 'due_e' ? 'ertaga' : 'indinga';
  return { dueAt: day, tzOffsetMin: null, label: `${label} (${dotted(day)})` };
}

/** ⏰'s three quick answers, the same calendar (spec §4). */
export function postponeDue(step: 'e' | 'i' | 'w', now = new Date()): DraftDue {
  const day = addDays(tashkentDay(now), step === 'e' ? 1 : step === 'i' ? 2 : 7);
  const label = step === 'e' ? 'ertaga' : step === 'i' ? 'indinga' : '1 haftaga';
  return { dueAt: day, tzOffsetMin: null, label: `${label} (${dotted(day)})` };
}

const TASHKENT_OFFSET_MIN = -300;

/**
 * «📅 Sana yozish»: `12.10`, `12.10 15:00` or `15:00`, on the Tashkent clock
 * (spec §3). A bare time already past today means TOMORROW — and the label
 * says «ertaga 15:00», so the person sees the day they got. A date without a
 * year that is already behind us is NEXT year's: nobody gives a task due in
 * the past. Anything else — a 31st of a 30-day month, 25:00 — is null and
 * asked again, never rolled into a different day by the calendar.
 *
 * …and so is a moment the person NAMED that is already gone — today at an
 * hour that passed, a year typed in the past (review bot-10): it used to make
 * the task overdue on the minute it was given. `typedDuePast` says which of
 * the two a null was, so the bot can say «o'tib ketgan» and not «tushunmadim».
 * The label prints the year whenever it is not this one, typed or rolled.
 */
export function parseTypedDue(raw: string, now = new Date()): DraftDue | null {
  const read = readTypedDue(raw, now);
  return read && !read.past ? read.due : null;
}

/** Was `raw` a real moment, only one already behind us? */
export function typedDuePast(raw: string, now = new Date()): boolean {
  return readTypedDue(raw, now)?.past ?? false;
}

function readTypedDue(raw: string, now: Date): { due: DraftDue; past: boolean } | null {
  const text = raw.trim();
  const today = tashkentDay(now);
  const y = Number(today.slice(0, 4));
  const time = /^(\d{1,2}):(\d{2})$/.exec(text);
  if (time) {
    const hh = Number(time[1]);
    const mm = Number(time[2]);
    if (hh > 23 || mm > 59) return null;
    const clock = `${pad(hh)}:${pad(mm)}`;
    const at = instantOf(today, clock);
    const day = at.getTime() <= now.getTime() ? addDays(today, 1) : today;
    return {
      due: { dueAt: `${day}T${clock}`, tzOffsetMin: TASHKENT_OFFSET_MIN, label: day === today ? `bugun ${clock}` : `ertaga ${clock}` },
      past: false,
    };
  }
  const date = /^(\d{1,2})[./](\d{1,2})(?:[./](\d{2}|\d{4}))?(?:\s+(\d{1,2}):(\d{2}))?$/.exec(text);
  if (!date) return null;
  const dd = Number(date[1]);
  const mo = Number(date[2]);
  let year = date[3] ? Number(date[3].length === 2 ? `20${date[3]}` : date[3]) : y;
  if (!realDate(year, mo, dd)) return null;
  let day = `${year}-${pad(mo)}-${pad(dd)}`;
  if (!date[3] && day < today) {
    year += 1;
    if (!realDate(year, mo, dd)) return null;
    day = `${year}-${pad(mo)}-${pad(dd)}`;
  }
  const shown = year === y ? dotted(day) : `${dotted(day)}.${year}`;
  if (date[4] !== undefined) {
    const hh = Number(date[4]);
    const mm = Number(date[5]);
    if (hh > 23 || mm > 59) return null;
    const clock = `${pad(hh)}:${pad(mm)}`;
    return {
      due: { dueAt: `${day}T${clock}`, tzOffsetMin: TASHKENT_OFFSET_MIN, label: `${shown} ${clock}` },
      past: instantOf(day, clock).getTime() <= now.getTime(),
    };
  }
  return { due: { dueAt: day, tzOffsetMin: null, label: shown }, past: day < today };
}

function realDate(year: number, month: number, day: number): boolean {
  if (month < 1 || month > 12 || day < 1 || day > 31) return false;
  const at = new Date(Date.UTC(year, month - 1, day));
  return at.getUTCFullYear() === year && at.getUTCMonth() === month - 1 && at.getUTCDate() === day;
}

/** A Tashkent wall-clock moment as an instant (UTC+5, no daylight saving). */
function instantOf(day: string, clock: string): Date {
  // `parseDue`'s own arithmetic: the naive wall clock plus whose wall it was.
  return new Date(Date.parse(`${day}T${clock}:00.000Z`) + TASHKENT_OFFSET_MIN * 60_000);
}

function pad(n: number): string {
  return String(n).padStart(2, '0');
}

/** «2026-10-12» as «12.10» — the Telegram date the rest of the staff texts print. */
function dotted(day: string): string {
  const [, mm, dd] = day.split('-');
  return `${dd}.${mm}`;
}

// ---------------------------------------------------------------------------
// After a task is made: a late album part still belongs to it.
// ---------------------------------------------------------------------------

interface Linger {
  taskId: string;
  albums: Set<string>;
  /** Albums whose late parts were already acknowledged — once per album, never per photo. */
  acked: Set<string>;
  until: number;
}

const lingers = new Map<string, Linger>();

/** The draft just became a task: its albums linger for a minute (telegram-mechanics-17). */
export function noteLinger(chatId: bigint, taskId: string, albums: string[]): void {
  if (albums.length === 0) return;
  lingers.set(String(chatId), {
    taskId,
    // Not the holder: a late part goes to whoever holds the task WHEN it
    // arrives, read by the append's own UPDATE (review bot-11).
    albums: new Set(albums),
    acked: new Set(),
    until: Date.now() + LINGER_MS,
  });
}

/** The task a late part of this album belongs to, if it still lingers. */
export function lingerFor(chatId: bigint, mediaGroupId: string | null | undefined): Linger | null {
  if (!mediaGroupId) return null;
  const entry = lingers.get(String(chatId));
  if (!entry || entry.until <= Date.now()) {
    if (entry) lingers.delete(String(chatId));
    return null;
  }
  return entry.albums.has(mediaGroupId) ? entry : null;
}

/** Should a late part of this album be acknowledged? True once per album. */
export function lateAckDue(linger: Linger, mediaGroupId: string): boolean {
  if (linger.acked.has(mediaGroupId)) return false;
  linger.acked.add(mediaGroupId);
  return true;
}

// ---------------------------------------------------------------------------
// Door B — a forwarded message with no collector live.
// ---------------------------------------------------------------------------

/** One part of a forwarded album, as the press needs it: its pointer AND its file. */
export interface ForwardPart {
  messageId: number;
  kind: PartKind | null;
  file: DraftPart['file'];
}

interface ForwardAlbum {
  parts: ForwardPart[];
  offered: boolean;
  expires: number;
}

/** chat → media_group_id → the album's own parts (telegram-mechanics-18). */
const forwardAlbums = new Map<string, Map<string, ForwardAlbum>>();
const ALBUM_TTL_MS = 30 * 60_000;

/**
 * Remember one forwarded album part — its pointer AND its file: every part
 * was handed to us as a file when it arrived, and keeping only the pointer
 * meant a four-photo album reached the web as one photo with nothing said
 * (review bot-4). Answers whether the «📌 Topshiriq qilamizmi?» is still owed
 * — once per album, never once per photo.
 */
export function noteForwardPart(
  chatId: bigint,
  mediaGroupId: string,
  part: ForwardPart,
): { offer: boolean } {
  const key = String(chatId);
  const now = Date.now();
  const byGroup = forwardAlbums.get(key) ?? new Map<string, ForwardAlbum>();
  for (const [id, album] of byGroup) if (album.expires <= now) byGroup.delete(id);
  const album = byGroup.get(mediaGroupId) ?? { parts: [], offered: false, expires: now + ALBUM_TTL_MS };
  if (!album.parts.some((p) => p.messageId === part.messageId)) album.parts.push(part);
  const offer = !album.offered;
  album.offered = true;
  byGroup.set(mediaGroupId, album);
  forwardAlbums.set(key, byGroup);
  return { offer };
}

/**
 * The album a pressed «Topshiriq qilish» was offered under, its parts in
 * order — null after a deploy (the map is memory), and the caller SAYS that
 * only one part was taken rather than dropping the rest in silence.
 */
export function forwardAlbumOf(chatId: bigint, mediaGroupId: string | null | undefined): ForwardPart[] | null {
  if (!mediaGroupId) return null;
  const album = forwardAlbums.get(String(chatId))?.get(mediaGroupId);
  if (!album || album.expires <= Date.now()) return null;
  return [...album.parts].sort((a, b) => a.messageId - b.messageId);
}

/** Tests only: a clean slate between cases. */
export function __resetDrafts(): void {
  drafts.clear();
  lingers.clear();
  forwardAlbums.clear();
}
