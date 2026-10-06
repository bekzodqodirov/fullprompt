import type { Context } from 'grammy';
import { logger } from '../logger';
import { reachLine } from '../notifications/staff';
import { appendLine, keyboardOf, staffTextHtml, urlRowsOf, withoutButton } from '../notifications/staff-html';
import { parseDue } from '../tasks/service';
import { activeIntake } from './calc-intake';
import { activeCapture } from './note-capture';
import { editMarkup, editText, sendText } from './send';
import {
  acceptTaskFromBot,
  answerFromBot,
  appendLatePart,
  askFromBot,
  cancelTaskFromBot,
  closeTaskMessage,
  completeTaskFromBot,
  createTaskFromDraft,
  draftAssignee,
  draftPeople,
  dropTaskPending,
  dueKeyboard,
  forwardKeyboard,
  givenFromBot,
  noteTaskPending,
  peopleKeyboard,
  postponeKeyboard,
  pressRefusalText,
  refusalFor,
  remindTaskFromBot,
  rescheduleTaskFromBot,
  sourcesFromBot,
  staffForChat,
  takeTaskPendingFor,
  TASK_ANSWERS,
  taskPressCheck,
  type BotCallback,
  type DraftStep,
  type PendingTask,
  type ReachedResult,
} from './staff-bot';
import {
  activeDraft,
  ALBUM_SETTLE_MS,
  albumSettled,
  draftNote,
  MAX_DRAFT_SOURCES,
  draftTitle,
  dueFromButton,
  endDraft,
  forwardAlbumOf,
  lateAckDue,
  lingerFor,
  noteForwardPart,
  noteLinger,
  parseTypedDue,
  postponeDue,
  startDraft,
  tooBigLine,
  updateDraft,
  withPart,
  type DraftDue,
  type DraftPart,
  type TaskDraft,
} from './task-draft';

/**
 * The grammy shell of «Telegramdan topshiriq» (docs/TELEGRAM-TOPSHIRIQ.md) —
 * thin on purpose, like staff-handlers.ts: what is DECIDED lives in
 * task-draft.ts (the collection, pure) and staff-bot.ts (the doors, reached
 * by the integration tests). Uzbek literals, like every staff sentence.
 *
 * Every handler here answers in words on every path: a callback nobody
 * answers spins on the phone for fifteen seconds with no error anywhere
 * (#939), and a press that changes nothing reads as a broken bot.
 */

/** The one thing a sentence-sender needs: a reply, from a grammy ctx or a bare chat id. */
type Say = (text: string, keyboard?: unknown) => Promise<number | null>;

function sayIn(ctx: Context): Say {
  return async (text, keyboard) => {
    const sent = await ctx.reply(text, keyboard ? { reply_markup: keyboard as never } : undefined);
    return sent.message_id;
  };
}

/** The same sentence off the poller (a timer), by chat id — nothing of grammy's ctx survives that long. */
function sayTo(chatId: bigint): Say {
  return async (text, keyboard) => {
    const sent = await sendText({ chatId, text, replyMarkup: keyboard });
    if (!sent.ok) logger.warn({ description: sent.description }, '[topshiriq] message not sent');
    return sent.messageId;
  };
}

/** «One collector at a time» (spec §3) — refused in words, never a silent discard. */
export const BUSY_DRAFT = 'Avval topshiriqni tugating yoki 🗑 bekor qiling.';

/** Is a task draft live in this chat? The calc and zametka doors ask it before they open. */
export function draftLive(chatId: bigint): boolean {
  return activeDraft(chatId) !== null;
}

// ---------------------------------------------------------------------------
// Door A — «➕ Topshiriq», /topshiriq — and the draft's own steps.
// ---------------------------------------------------------------------------

/**
 * Start a draft — empty from the label, or seeded with a forwarded message
 * (Door B). Refused while another collector is live, in BOTH directions; and
 * starting one DISCARDS a waiting one-text answer (a result, a question), so
 * the draft's first line can never be filed as somebody's result.
 */
export async function startTaskDraft(
  ctx: Context,
  chatId: bigint,
  seed: Parameters<typeof startDraft>[1] = {},
): Promise<void> {
  if (activeIntake(chatId)) {
    await ctx.reply('Hozir hisoblatish davom etyapti. Avval uni tugating yoki bekor qiling.');
    return;
  }
  if (activeCapture(chatId)) {
    await ctx.reply('Hozir yangi zametka yozilyapti. Avval uni saqlang yoki bekor qiling.');
    return;
  }
  const staff = await staffForChat(chatId);
  if (!staff) return;
  const live = activeDraft(chatId);
  if (live) {
    // A second «➕» is not a reason to lose the first one's words — and
    // neither is a SEEDED start: an old «📌 Topshiriq qilish» pressed while a
    // draft is live overwrote the pick and every typed line (review bot-2).
    await ctx.reply('Sizda tugallanmagan topshiriq bor — davom eting yoki bekor qiling.');
    await promptFor(sayIn(ctx), chatId, live, staff.id);
    return;
  }
  dropTaskPending(chatId);
  const draft = startDraft(chatId, seed);
  await promptFor(sayIn(ctx), chatId, draft, staff.id);
}

/** Whatever the draft is waiting for, asked again — one function, so the wording cannot drift. */
async function promptFor(say: Say, chatId: bigint, draft: TaskDraft, staffId: string): Promise<void> {
  if (draft.stage === 'who') {
    const people = await draftPeople(staffId);
    const id = await say('👤 Kimga? (ism yozsangiz — qidiradi)', { inline_keyboard: peopleKeyboard(people) });
    updateDraft(chatId, { promptMessageId: id });
    return;
  }
  if (draft.stage === 'what') {
    await say(
      '✍️ Nima qilish kerak? Matn, ovozli xabar, rasm, video, fayl yoki yo‘naltirilgan xabar yuboring — bir nechtasi ham bo‘ladi.',
      { inline_keyboard: [[{ text: '🗑 Bekor qilish', callback_data: 'd:cancel' }]] },
    );
    return;
  }
  if (draft.stage === 'date') {
    await say('📅 Sanani yozing: 12.10, 12.10 15:00 yoki 15:00');
    return;
  }
  await showDue(say, chatId, draft);
}

/** The due keyboard, with what has been collected so far — edited in place when it can be. */
async function showDue(say: Say, chatId: bigint, draft: TaskDraft): Promise<void> {
  const parts = [
    draft.texts.length ? `✍️ ${draft.texts.length} ta matn` : '',
    draft.sources.length ? `📎 ${draft.sources.length} ta xabar` : '',
  ].filter(Boolean);
  const text = `${parts.length ? `Qabul qilindi: ${parts.join(' · ')}\n` : ''}⏳ Muddat? (yana yozsangiz — qo‘shiladi)`;
  const keyboard = { inline_keyboard: dueKeyboard() };
  if (draft.dueShown && draft.promptMessageId) {
    const res = await editText({ chatId, messageId: draft.promptMessageId, html: staffTextHtml(text), replyMarkup: keyboard });
    if (res.ok) return;
  }
  const id = await say(text, keyboard);
  updateDraft(chatId, { dueShown: true, stage: 'when', promptMessageId: id });
}

/** «Kimga?»'s answer — a colleague, or «🙋 O'zimga». */
export async function pickAssignee(ctx: Context, chatId: bigint, userId: string | 'self'): Promise<void> {
  const draft = activeDraft(chatId);
  const staff = await staffForChat(chatId);
  if (!draft || !staff) {
    await ctx.reply('Bu tugma eskirgan — «➕ Topshiriq» dan qaytadan boshlang.');
    return;
  }
  const person = await draftAssignee(userId === 'self' ? staff.id : userId);
  if (!person) {
    await ctx.reply('Bu hodim topilmadi yoki tizimga kirmaydi — boshqasini tanlang.');
    return;
  }
  const hasContent = draft.texts.length > 0 || draft.sources.length > 0 || draft.facts.length > 0;
  const next = updateDraft(chatId, {
    assigneeId: person.id,
    assigneeName: person.name,
    stage: hasContent ? 'when' : 'what',
  })!;
  const lines = [person.id === staff.id ? '🙋 O‘zingizga.' : `👤 ${person.name}`];
  if (person.id !== staff.id) {
    // The post-pick ⚠ names a MUTE too (spec §4) — this is the author's own
    // business; the list everybody reads showed only «📵».
    const { reachOf } = await import('../notifications/staff');
    const reach = (await reachOf([person.id], 'TaskAssigned')).get(person.id) ?? 'no_chat';
    const line = reachLine(person.name, reach);
    if (line) lines.push(line);
  }
  await ctx.reply(lines.join('\n'));
  // An album still arriving: the due keyboard is its settle timer's to show
  // (review bot-3) — shown now, a press would race the album's last photos.
  if (next.stage === 'when' && !albumSettled(next)) return;
  await promptFor(sayIn(ctx), chatId, next, staff.id);
}

/** A typed name while «Kimga?» is asked: the list, narrowed. */
async function filterPeople(ctx: Context, chatId: bigint, staffId: string, text: string): Promise<void> {
  const people = await draftPeople(staffId, text);
  if (people.length === 0) {
    await ctx.reply(`«${text.trim().slice(0, 40)}» topilmadi. Boshqa ism yozing yoki ro‘yxatdan tanlang.`, {
      reply_markup: { inline_keyboard: peopleKeyboard([]) },
    });
    return;
  }
  await ctx.reply('👤 Kimga?', { reply_markup: { inline_keyboard: peopleKeyboard(people) } });
}

/** The draft's own buttons: a due, «📅 Sana yozish», «🙋 O'zimga», «🗑». */
export async function handleDraftCallback(ctx: Context, chatId: bigint, step: DraftStep): Promise<void> {
  await ctx.answerCallbackQuery();
  if (step === 'self') return pickAssignee(ctx, chatId, 'self');
  const draft = activeDraft(chatId);
  if (!draft) {
    await ctx.reply('Bu tugma eskirgan — «➕ Topshiriq» dan qaytadan boshlang.');
    return;
  }
  if (step === 'cancel') {
    endDraft(chatId);
    await ctx.reply('🗑 Topshiriq bekor qilindi.');
    return;
  }
  if (!draft.assigneeId) {
    await ctx.reply('Avval kimga ekanini tanlang.');
    return;
  }
  if (draft.texts.length === 0 && draft.sources.length === 0 && draft.facts.length === 0) {
    await ctx.reply('Avval nima qilish kerakligini yuboring.');
    return;
  }
  if (step === 'due_s') {
    updateDraft(chatId, { stage: 'date' });
    await ctx.reply('📅 Sanani yozing: 12.10, 12.10 15:00 yoki 15:00');
    return;
  }
  await createOrWait(sayIn(ctx), chatId, dueFromButton(step));
}

/**
 * A due was pressed: the task is made AT ONCE (spec §3, no extra confirm) —
 * unless an album is still arriving, in which case the album's settle timer
 * makes it (telegram-mechanics-17): a press can reach Telegram before the
 * last photo does.
 */
async function createOrWait(say: Say, chatId: bigint, due: DraftDue): Promise<void> {
  const draft = activeDraft(chatId);
  if (!draft) return;
  if (!albumSettled(draft)) {
    updateDraft(chatId, { pendingDue: due });
    // The press is completed by a settle timer — armed HERE too, so a held
    // press never waits on a timer nobody set (review bot-3).
    for (const group of Object.keys(draft.albums)) armAlbumTimer(chatId, group);
    await say('⏳ Albom hali yuklanmoqda — tugashi bilan topshiriq beriladi.');
    return;
  }
  await finishDraft(say, chatId, draft, due);
}

async function finishDraft(say: Say, chatId: bigint, draft: TaskDraft, due: DraftDue): Promise<void> {
  // Ended FIRST: a second press, or the settle timer firing beside a press,
  // finds no draft and makes nothing — one task per draft.
  endDraft(chatId);
  const made = await createTaskFromDraft(
    chatId,
    {
      assigneeId: draft.assigneeId!,
      title: draftTitle(draft),
      note: draftNote(draft),
      sources: draft.sources,
      files: draft.files,
    },
    due,
  );
  if (!made.ok) {
    // The words are not lost to a refusal: the draft comes back, asking again.
    startDraft(chatId, {
      texts: draft.texts,
      facts: draft.facts,
      sources: draft.sources,
      files: draft.files,
      firstKind: draft.firstKind,
      firstForwarded: draft.firstForwarded,
    });
    await say(`⚠ ${TASK_ANSWERS[made.result]}`);
    return;
  }
  const lines = [
    `✅ Topshiriq berildi: ${made.title}`,
    `${made.self ? '🙋 O‘zingizga' : `👤 ${made.assigneeName}`} · 📅 ${due.label}`,
  ];
  if (!made.self) {
    const line = reachLine(made.assigneeName, made.reach);
    if (line) lines.push(line);
  }
  // 3a promises the files on the site; Telegram hands a bot nothing past
  // 20 MB, so the author is told which ones only travel in Telegram.
  const tooBig = tooBigLine(draft.tooBig);
  if (tooBig) lines.push(tooBig);
  await say(lines.join('\n'), { inline_keyboard: [[{ text: '🗑 Bekor qilish', callback_data: `tc:${made.taskId}` }]] });
  noteLinger(chatId, made.taskId, Object.keys(draft.albums));
}

/** The draft's text branch in the ladder — a name, a line of the task, or a typed date. */
export async function draftText(ctx: Context, chatId: bigint, draft: TaskDraft): Promise<void> {
  const message = ctx.message!;
  const staff = await staffForChat(chatId);
  if (!staff) return;
  const text = message.text ?? '';
  const forwarded = Boolean(message.forward_origin);
  if (draft.stage === 'who' && !forwarded) {
    await filterPeople(ctx, chatId, staff.id, text);
    return;
  }
  if (draft.stage === 'date' && !forwarded) {
    const due = parseTypedDue(text);
    if (!due) {
      await ctx.reply('Tushunmadim. 12.10, 12.10 15:00 yoki 15:00 ko‘rinishida yozing.');
      return;
    }
    await createOrWait(sayIn(ctx), chatId, due);
    return;
  }
  await addToDraft(ctx, chatId, draft, partOf(message));
}

/** A part of what the author sent, taken into the draft — then the next question. */
export async function addToDraft(ctx: Context, chatId: bigint, draft: TaskDraft, part: DraftPart): Promise<void> {
  const firstOfAlbum = Boolean(part.mediaGroupId) && !Object.hasOwn(draft.albums, part.mediaGroupId!);
  const next = updateDraft(chatId, { ...withPart(draft, part, Number(chatId)) })!;
  if (next.dropped > 0 && draft.dropped === 0) {
    // The first part past the cap, said ONCE (review bot-11): one
    // forwardMessages call carries ten, and the rest were going nowhere in
    // silence.
    await ctx.reply(`⚠ Bitta topshiriqqa ko‘pi bilan ${MAX_DRAFT_SOURCES} ta xabar qo‘shiladi — qolganlari hodimga yuborilmaydi.`);
  }
  // An album is N updates: its settle timer is armed at EVERY stage. Armed
  // only after the pick, an album sent while «Kimga?» stood had none, so a
  // due pressed inside the settle window was held for ever (review bot-3).
  if (part.mediaGroupId) armAlbumTimer(chatId, part.mediaGroupId);
  if (next.stage === 'who') {
    // Sent before the person was picked: kept, and the question stands —
    // said once per album, never once per photo.
    if (!part.mediaGroupId || firstOfAlbum) await ctx.reply('📎 Qabul qilindi. Endi kimga ekanini tanlang.');
    return;
  }
  // The due keyboard waits until the album has settled; the timer shows it.
  if (part.mediaGroupId) return;
  await showDue(sayIn(ctx), chatId, next);
}

/** Per-album settle timers, off the poller (telegram-mechanics-17). */
const albumTimers = new Map<string, ReturnType<typeof setTimeout>>();

function armAlbumTimer(chatId: bigint, mediaGroupId: string): void {
  const key = `${chatId}:${mediaGroupId}`;
  const old = albumTimers.get(key);
  if (old) clearTimeout(old);
  albumTimers.set(
    key,
    setTimeout(() => {
      albumTimers.delete(key);
      void albumSettledNow(chatId).catch((err: unknown) =>
        logger.warn({ err }, '[topshiriq] album settle failed'),
      );
    }, ALBUM_SETTLE_MS + 100),
  );
}

/**
 * The timer fired: re-read the draft (it may be gone, or another album part
 * may have re-armed it), then either make the task a press was waiting for,
 * or show the due keyboard the album had held back.
 */
async function albumSettledNow(chatId: bigint): Promise<void> {
  const draft = activeDraft(chatId);
  if (!draft || !albumSettled(draft)) return;
  const say = sayTo(chatId);
  if (draft.pendingDue) {
    await finishDraft(say, chatId, draft, draft.pendingDue);
    return;
  }
  if (draft.stage === 'what' || draft.stage === 'when') await showDue(say, chatId, draft);
}

/**
 * A grammy message as a draft part. A forward's words are NOT taken into the
 * note — they are somebody else's (a customer's chat, often) and the pointer
 * is all that is stored (access-money-12's premise); the author's own caption
 * is typed text and is.
 */
export function partOf(message: NonNullable<Context['message']>): DraftPart {
  const forwarded = Boolean(message.forward_origin);
  const own = (value: string | undefined) => (forwarded ? null : (value ?? null));
  const base = { messageId: message.message_id, forwarded, mediaGroupId: message.media_group_id ?? null };
  if (message.photo?.length) {
    const best = message.photo[message.photo.length - 1]!;
    return { ...base, kind: 'photo', text: own(message.caption), file: { fileId: best.file_id, name: null, mime: 'image/jpeg', size: best.file_size ?? null } };
  }
  if (message.voice) {
    return { ...base, kind: 'voice', text: own(message.caption), file: { fileId: message.voice.file_id, name: null, mime: message.voice.mime_type ?? null, size: message.voice.file_size ?? null } };
  }
  if (message.audio) {
    return { ...base, kind: 'audio', text: own(message.caption), file: { fileId: message.audio.file_id, name: message.audio.file_name ?? null, mime: message.audio.mime_type ?? null, size: message.audio.file_size ?? null } };
  }
  if (message.video) {
    return { ...base, kind: 'video', text: own(message.caption), file: { fileId: message.video.file_id, name: message.video.file_name ?? null, mime: message.video.mime_type ?? null, size: message.video.file_size ?? null } };
  }
  if (message.video_note) {
    return { ...base, kind: 'video_note', file: { fileId: message.video_note.file_id, name: null, mime: 'video/mp4', size: message.video_note.file_size ?? null } };
  }
  if (message.document) {
    return { ...base, kind: 'document', text: own(message.caption), file: { fileId: message.document.file_id, name: message.document.file_name ?? null, mime: message.document.mime_type ?? null, size: message.document.file_size ?? null } };
  }
  if (message.contact) {
    const who = [message.contact.first_name, message.contact.last_name].filter(Boolean).join(' ');
    return { ...base, kind: 'contact', fact: `👤 Kontakt: ${who} ${message.contact.phone_number}`.trim() };
  }
  if (message.location) {
    const venue = message.venue ? `${[message.venue.title, message.venue.address].filter(Boolean).join(', ')} — ` : '';
    return { ...base, kind: 'location', fact: `📍 Joylashuv: ${venue}${message.location.latitude}, ${message.location.longitude}` };
  }
  return { ...base, text: own(message.text) };
}

// ---------------------------------------------------------------------------
// Media: the draft takes it, then Door B, else the next handler (the cabinet).
// ---------------------------------------------------------------------------

/**
 * One staff message that is not text — photo, file, voice, audio, video,
 * round video, contact, place, sticker — offered to the draft, then to Door B.
 * Answers true when it took the message; false hands it to the next handler.
 * Never while a calc intake or a zametka capture is live (the caller asks
 * them first): forwarding is the intake's core and stays theirs.
 */
export async function draftMedia(ctx: Context, chatId: bigint): Promise<boolean> {
  const message = ctx.message;
  if (!message) return false;
  const staff = await staffForChat(chatId);
  if (!staff) return false;
  const draft = activeDraft(chatId);
  if (message.sticker) {
    if (!draft) return false;
    await ctx.reply('Stiker topshiriqqa qo‘shilmaydi — matn, ovoz, rasm yoki fayl yuboring.');
    return true;
  }
  const part = partOf(message);
  if (draft) {
    await addToDraft(ctx, chatId, draft, part);
    return true;
  }
  // A late part of an album whose task was just made (telegram-mechanics-17).
  const linger = lingerFor(chatId, part.mediaGroupId);
  if (linger) {
    const added = await appendLatePart(chatId, linger, {
      messageId: part.messageId,
      file: part.file && part.kind && part.kind !== 'contact' && part.kind !== 'location' ? { ...part.file, kind: part.kind } : null,
    });
    // Said once per album either way — a part the task could not take is
    // told, never swallowed (review bot-11).
    const group = part.mediaGroupId!;
    if (added === 'added' && lateAckDue(linger, group)) {
      await ctx.reply('📎 Albomning qolgan qismi topshiriqqa qo‘shildi.');
    } else if (added !== 'added' && lateAckDue(linger, `${group}:refused`)) {
      await ctx.reply(
        added === 'cap'
          ? `⚠ Albomning qolgan qismi qo‘shilmadi — bitta topshiriqqa ko‘pi bilan ${MAX_DRAFT_SOURCES} ta xabar.`
          : '⚠ Albomning qolgan qismi qo‘shilmadi — topshiriq endi ochiq emas.',
      );
    }
    return true;
  }
  // Door B: a forward, or a colleague's contact card («call this person» —
  // the cabinet's contact handler would answer «send your OWN number» and
  // take the staff keyboard off the phone, telegram-mechanics-19).
  const ownContact = message.contact && message.contact.user_id === ctx.from?.id;
  if (part.forwarded || (message.contact && !ownContact)) {
    await offerForwardTask(ctx, chatId, part.mediaGroupId ?? null);
    return true;
  }
  return false;
}

// ---------------------------------------------------------------------------
// Door B — a forwarded message while no collector is live.
// ---------------------------------------------------------------------------

/**
 * «📌 Topshiriq qilamizmi?», as a REPLY to the forwarded message — once per
 * album (telegram-mechanics-18), the album's ids remembered for the press.
 */
export async function offerForwardTask(ctx: Context, chatId: bigint, mediaGroupId: string | null): Promise<void> {
  const message = ctx.message!;
  if (mediaGroupId && !noteForwardPart(chatId, mediaGroupId, message.message_id).offer) return;
  await ctx.reply('📌 Topshiriq qilamizmi?', {
    reply_markup: { inline_keyboard: forwardKeyboard() },
    reply_parameters: { message_id: message.message_id, allow_sending_without_reply: true },
  });
}

/**
 * Door B's two buttons. Both read the forwarded message off the press's own
 * `reply_to_message` — no memory needed for a single message, so a deploy
 * between the forward and the press loses nothing. «🔍 Qidirish» replays
 * TODAY's whole tail on its words (lookup, codes, notes, the AI), so nobody
 * loses the old behaviour of a forwarded text.
 */
export async function handleForwardCallback(
  ctx: Context,
  chatId: bigint,
  step: 'task' | 'search',
  replayTail: (text: string) => Promise<void>,
): Promise<void> {
  await ctx.answerCallbackQuery();
  const asked = ctx.callbackQuery?.message;
  const original = asked && 'reply_to_message' in asked ? asked.reply_to_message : undefined;
  if (!original) {
    await ctx.reply('Asl xabar topilmadi — uni qaytadan yo‘naltiring.');
    return;
  }
  // One collector at a time (spec §3): an offer stays pressable after a
  // draft started, and pressing it then replaced the draft in silence
  // (review bot-2). Refused BEFORE the offer's keyboard goes, so the same
  // press still works once the draft is finished; «🔍 Qidirish» is only a
  // lookup and touches no draft.
  if (step === 'task' && draftLive(chatId)) {
    await ctx.reply(BUSY_DRAFT);
    return;
  }
  // The question goes: it has been answered.
  if (asked) void editMarkup({ chatId, messageId: asked.message_id }).catch(() => {});
  if (step === 'search') {
    const text = (original.text ?? original.caption ?? '').trim();
    if (!text) {
      await ctx.reply('Bu xabarda qidiradigan matn yo‘q.');
      return;
    }
    await replayTail(text);
    return;
  }
  const part = partOf(original as NonNullable<Context['message']>);
  const albumIds = forwardAlbumOf(chatId, original.media_group_id);
  let seed = withPart(startDraftSeed(), part, Number(chatId));
  if (albumIds) {
    // The album's other parts: their pointers travel; the web gets the one
    // file the press carried (the rest were never handed to us as files).
    for (const id of albumIds) {
      if (id === original.message_id) continue;
      seed = withPart(seed, { messageId: id, forwarded: true, kind: part.kind ?? null }, Number(chatId));
    }
  }
  await startTaskDraft(ctx, chatId, {
    sources: seed.sources,
    files: seed.files,
    texts: seed.texts,
    facts: seed.facts,
    firstKind: seed.firstKind,
    firstForwarded: seed.firstForwarded,
  });
  if (original.media_group_id && !albumIds) {
    // The map is memory and a deploy took it: SAY so, never drop parts in silence.
    await ctx.reply('⚠ Albomning faqat 1 ta qismi qo‘shildi — qolganlarini qaytadan yo‘naltiring.');
  }
}

/** An empty draft shape to fold Door B's parts into before the real draft starts. */
function startDraftSeed(): TaskDraft {
  return {
    stage: 'who',
    assigneeId: null,
    assigneeName: null,
    texts: [],
    facts: [],
    firstKind: null,
    firstForwarded: false,
    sources: [],
    files: [],
    tooBig: [],
    dropped: 0,
    albums: {},
    promptMessageId: null,
    pendingDue: null,
    dueShown: false,
    expires: 0,
  };
}

// ---------------------------------------------------------------------------
// The assignee's and the author's buttons on a task's own messages.
// ---------------------------------------------------------------------------

type TaskPress = Extract<
  BotCallback,
  {
    kind:
      | 'task_accept'
      | 'task_wait'
      | 'task_postpone'
      | 'task_question'
      | 'task_reply'
      | 'task_noresult'
      | 'task_remind'
      | 'task_cancel'
      | 'task_sources';
  }
>;

/** The message a callback came from, as the edits need it. */
function pressedOf(ctx: Context): { messageId: number; text: string; markup: unknown } | null {
  const message = ctx.callbackQuery?.message;
  if (!message || !('text' in message) || !message.text) return null;
  return {
    messageId: message.message_id,
    text: message.text,
    markup: 'reply_markup' in message ? message.reply_markup : undefined,
  };
}

/** A sentence for a reached-or-not answer: the done line, then the ⚠ when nobody will hear. */
function reachedText(done: string, out: ReachedResult): string {
  if (out.result !== 'done') return TASK_ANSWERS[out.result];
  const line = out.reach ? reachLine(out.name ?? 'Hodim', out.reach) : null;
  return line ? `${done}\n${line}` : done;
}

export async function handleTaskPress(ctx: Context, chatId: bigint, press: TaskPress): Promise<void> {
  const data = ctx.callbackQuery?.data ?? '';

  if (press.kind === 'task_accept') {
    const result = await acceptTaskFromBot(chatId, press.taskId);
    await ctx.answerCallbackQuery({ text: result === 'done' ? '👀 Qabul qilindi' : TASK_ANSWERS[result] });
    const pressed = pressedOf(ctx);
    if ((result === 'done' || result === 'already_accepted') && pressed) {
      // ONE button goes — its row neighbour «✅ Bajarildi» stays
      // (telegram-mechanics-4: `withoutCallback` would take the whole row).
      void editText({
        chatId,
        messageId: pressed.messageId,
        html: appendLine(staffTextHtml(pressed.text, 'TaskAssigned'), '👀 Qabul qilindi'),
        replyMarkup: keyboardOf(withoutButton(pressed.markup, data)),
      }).catch((err: unknown) => logger.warn({ err }, '[topshiriq] accept not settled'));
    } else if (result !== 'done') {
      await ctx.reply(await refusalFor(press.taskId, result));
    }
    return;
  }

  if (press.kind === 'task_wait') {
    const check = await taskPressCheck(chatId, press.taskId, 'act');
    if (!check.ok) {
      await ctx.answerCallbackQuery({ text: TASK_ANSWERS[check.result] });
      await ctx.reply(pressRefusalText(check));
      return;
    }
    if (check.task.repeatUnit) {
      await ctx.answerCallbackQuery({ text: TASK_ANSWERS.repeat_series });
      await ctx.reply(TASK_ANSWERS.repeat_series);
      return;
    }
    await ctx.answerCallbackQuery();
    await ctx.reply(`⏰ Qachonga surilsin?\n${check.task.title}`, {
      reply_markup: { inline_keyboard: postponeKeyboard(press.taskId) },
    });
    return;
  }

  if (press.kind === 'task_postpone') {
    if (press.to === 's') {
      if (draftLive(chatId)) {
        await ctx.answerCallbackQuery({ text: BUSY_DRAFT });
        return;
      }
      const check = await taskPressCheck(chatId, press.taskId, 'act');
      await ctx.answerCallbackQuery(check.ok ? undefined : { text: TASK_ANSWERS[check.result] });
      if (!check.ok) {
        await ctx.reply(pressRefusalText(check));
        return;
      }
      noteTaskPending(chatId, press.taskId, null, 'reschedule');
      await ctx.reply('📅 Yangi sanani yozing: 12.10, 12.10 15:00 yoki 15:00');
      return;
    }
    const due = postponeDue(press.to);
    const parsed = parseDue(due.dueAt, due.tzOffsetMin);
    const result = await rescheduleTaskFromBot(chatId, press.taskId, { dueAt: parsed.dueAt!, allDay: parsed.allDay });
    await ctx.answerCallbackQuery({ text: result === 'done' ? `⏰ ${due.label}` : TASK_ANSWERS[result] });
    const pressed = pressedOf(ctx);
    if (result === 'done' && pressed) {
      void editText({
        chatId,
        messageId: pressed.messageId,
        html: appendLine(staffTextHtml(pressed.text), `✅ Muddat: ${due.label}`),
      }).catch(() => {});
    } else if (result !== 'done') {
      await ctx.reply(await refusalFor(press.taskId, result));
    }
    return;
  }

  if (press.kind === 'task_question' || press.kind === 'task_reply') {
    if (draftLive(chatId)) {
      await ctx.answerCallbackQuery({ text: BUSY_DRAFT });
      await ctx.reply(BUSY_DRAFT);
      return;
    }
    const check = await taskPressCheck(chatId, press.taskId, press.kind === 'task_question' ? 'assignee' : 'author');
    if (!check.ok) {
      await ctx.answerCallbackQuery({ text: TASK_ANSWERS[check.result] });
      await ctx.reply(pressRefusalText(check));
      return;
    }
    await ctx.answerCallbackQuery();
    noteTaskPending(chatId, press.taskId, null, press.kind === 'task_question' ? 'question' : 'answer');
    await ctx.reply(press.kind === 'task_question' ? '💬 Savolingizni yozing:' : '💬 Javobingizni yozing:');
    return;
  }

  if (press.kind === 'task_noresult') {
    // The NAMED second door (telegram-mechanics-13): the wait is taken only
    // when it is for this task, so the original message is closed and the
    // next typed «GS777» is a lookup again.
    const pending = takeTaskPendingFor(chatId, press.taskId);
    const result = await completeTaskFromBot(chatId, press.taskId, '', pending?.pressed ?? null);
    await ctx.answerCallbackQuery({ text: result === 'done' ? '✅ Vazifa yopildi' : TASK_ANSWERS[result] });
    const prompt = ctx.callbackQuery?.message;
    if (prompt) void editMarkup({ chatId, messageId: prompt.message_id }).catch(() => {});
    if (result === 'done' || result === 'already_closed') {
      if (pending) {
        void closeTaskMessage(chatId, pending, '', result).catch((err: unknown) =>
          logger.warn({ err }, 'task message not closed'),
        );
      }
    } else {
      await ctx.reply(await refusalFor(press.taskId, result));
    }
    return;
  }

  if (press.kind === 'task_remind') {
    const out = await remindTaskFromBot(chatId, press.taskId);
    await ctx.answerCallbackQuery({ text: out.result === 'done' ? '🔔 Eslatildi' : TASK_ANSWERS[out.result] });
    await ctx.reply(reachedText('🔔 Eslatma yuborildi.', out));
    return;
  }

  if (press.kind === 'task_cancel') {
    const pressed = pressedOf(ctx);
    const result = await cancelTaskFromBot(chatId, press.taskId, pressed);
    await ctx.answerCallbackQuery({ text: result === 'done' ? '🗑 Bekor qilindi' : TASK_ANSWERS[result] });
    if ((result === 'done' || result === 'already_closed') && pressed) {
      void editText({
        chatId,
        messageId: pressed.messageId,
        html: appendLine(staffTextHtml(pressed.text), result === 'done' ? '🗑 Bekor qilindi' : TASK_ANSWERS.already_closed),
      }).catch(() => {});
    } else if (result !== 'done' && result !== 'already_closed') {
      // An open calc job's task cannot be cancelled (review tasks-2): the
      // author is told where the job IS handled, not just a toast.
      await ctx.reply(await refusalFor(press.taskId, result));
    }
    return;
  }

  // task_sources — «📤 Yuborildi» only when something WAS queued, and the
  // author told when the holder will not hear it (review bot-13).
  const out = await sourcesFromBot(chatId, press.taskId);
  await ctx.answerCallbackQuery({ text: out.result === 'done' ? '📤 Yuborildi' : TASK_ANSWERS[out.result] });
  const pressed = pressedOf(ctx);
  if (out.result !== 'done') {
    await ctx.reply(await refusalFor(press.taskId, out.result));
    return;
  }
  if (pressed) {
    void editText({
      chatId,
      messageId: pressed.messageId,
      html: appendLine(staffTextHtml(pressed.text, 'TaskReassigned'), '📤 Manba yangi odamga yuborildi'),
      // The pressed button goes; the «↗️ Ochish» link stays.
      replyMarkup: keyboardOf(urlRowsOf(pressed.markup)),
    }).catch(() => {});
  }
  const line = out.reach ? reachLine(out.name ?? 'Hodim', out.reach) : null;
  if (line) await ctx.reply(line);
}

/**
 * A waiting answer that is NOT a result — a question, an answer, a typed
 * date. The result itself stays in staff-handlers' ladder, beside the
 * message it closes.
 *
 * Answers whether the text was CONSUMED. A typed date that is not a date is
 * not: the wait is dropped (the read already took it) and the words go on to
 * the staff tail as anything else typed would. Re-arming it instead swallowed
 * every lookup — «GS777» answered «Tushunmadim» for as long as the person
 * kept typing, with no button out (review tasks-5 / bot-1).
 */
export async function answerPendingText(
  ctx: Context,
  chatId: bigint,
  pending: PendingTask,
  text: string,
): Promise<boolean> {
  if (pending.kind === 'question') {
    await ctx.reply(reachedText('✅ Savol yuborildi.', await askFromBot(chatId, pending.taskId, text)));
    return true;
  }
  if (pending.kind === 'answer') {
    await ctx.reply(reachedText('✅ Javob yuborildi.', await answerFromBot(chatId, pending.taskId, text)));
    return true;
  }
  // reschedule
  const due = parseTypedDue(text);
  if (!due) {
    await ctx.reply('Bu sana emas — muddat o‘zgarmadi. Kerak bo‘lsa, «⏰» ni qayta bosing.');
    return false;
  }
  const parsed = parseDue(due.dueAt, due.tzOffsetMin);
  if (!parsed.dueAt) {
    await ctx.reply(TASK_ANSWERS.bad_due_date);
    return true;
  }
  const result = await rescheduleTaskFromBot(chatId, pending.taskId, { dueAt: parsed.dueAt, allDay: parsed.allDay });
  await ctx.reply(result === 'done' ? `⏰ Muddat: ${due.label}` : await refusalFor(pending.taskId, result));
  return true;
}

/** «📤 Men bergan», /berganlarim. */
export async function answerGiven(ctx: Context, chatId: bigint): Promise<void> {
  const out = await givenFromBot(chatId).catch((err: unknown) => {
    logger.warn({ err }, '[topshiriq] men bergan failed');
    return null;
  });
  if (!out) {
    await ctx.reply('Ro‘yxatni o‘qib bo‘lmadi — birozdan keyin urinib ko‘ring.');
    return;
  }
  await ctx.reply(out.text, out.buttons ? { reply_markup: { inline_keyboard: out.buttons } } : undefined);
}
