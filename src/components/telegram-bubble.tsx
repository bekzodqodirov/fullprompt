import { LightboxImg } from './lightbox-img';

/**
 * One Telegram message, drawn the same way on both screens that show one.
 *
 * It exists because the bubble was written twice — on the conversation screen
 * and on the card panel — and both copies were wrong the same way: they asked
 * for a `surface-200`, which is not a colour in this design system at all (the
 * surface scale is DEFAULT / raised / sunken). Tailwind emitted nothing, so
 * every message a CLIENT sent rendered with no bubble behind it and only ours
 * looked like a message. `tokens.test.ts` now fails on a colour class the
 * theme cannot produce; this is the one definition it has to get right.
 *
 * Both callers put it inside a white `surface-raised` box, which is what makes
 * `surface-sunken` readable as the other side of the conversation.
 *
 * It stays a SERVER component with plain `<button data-…>` actions, and that
 * is deliberate: a thread renders up to 500 of these, so a React island per
 * bubble would be 500 hydration roots for two rarely-pressed controls. The
 * composer and the share sheet listen for those buttons by delegation — one
 * listener each, however long the conversation.
 */
export interface BubbleMessage {
  id: string;
  direction: string;
  body: string | null;
  hasMedia: boolean;
  sentAt: Date;
  manager: string;
  /** Downloaded photos pinned to this message (item 15). */
  photos?: { id: string }[];
  /** Downloaded voice notes / audio files (2026-08-07). */
  audios?: { id: string; fileName: string }[];
  /** Downloaded documents, spreadsheets, archives, clips (2026-08-11). */
  files?: { id: string; fileName: string; sizeBytes: number }[];
  /** Telegram's own id — what a reply has to name (2026-08-11). */
  tgMessageId?: bigint | string | null;
  /** Non-null = forwarded; '' = forwarded from a source Telegram hides. */
  fwdFrom?: string | null;
  /** What this message answers; null = it answers nothing. */
  quoted?: { body: string | null; direction: string; hasMedia: boolean } | null;
}

/** «1,4 MB» — a name with no size is not something anybody can decide to open. */
function fileSize(bytes: number): string {
  if (bytes >= 1024 * 1024) return `${(bytes / (1024 * 1024)).toFixed(1)} MB`;
  return `${Math.max(1, Math.round(bytes / 1024))} KB`;
}

/** One line of a quoted or shared message — text, or what the media was. */
export function messagePreview(
  msg: { body: string | null; hasMedia?: boolean },
  mediaLabel: string,
): string {
  const body = msg.body?.trim();
  if (body) return body.length > 90 ? `${body.slice(0, 90)}…` : body;
  return msg.hasMedia ? `📎 ${mediaLabel}` : '';
}

export function TelegramBubble({
  message,
  clientLabel,
  mediaLabel,
  labels,
}: {
  message: BubbleMessage;
  /** What to call the other side — the client's own name is not in the row. */
  clientLabel: string;
  /** Stands in for an attachment: phase 2 imports that one WAS sent, not it. */
  mediaLabel: string;
  /**
   * The two actions and the two prefixes. Absent on the card panel and the
   * dock, where a reply already has its own composer and a share sheet would
   * be a third overlay on a drawer — the thread screen is where they live.
   */
  labels?: { reply: string; share: string; forwarded: string; hidden: string };
}) {
  const out = message.direction === 'out';
  const media =
    (message.photos?.length ?? 0) + (message.audios?.length ?? 0) + (message.files?.length ?? 0);
  const quotePreview = message.quoted ? messagePreview(message.quoted, mediaLabel) : '';
  return (
    <div
      className={`max-w-[85%] rounded-xl px-3 py-2 text-sm ${
        out ? 'ml-auto bg-brand-50' : 'mr-auto bg-surface-sunken'
      }`}
      data-testid="tg-bubble"
      // The «Hisoblatishga yuborish» island selects bubbles by delegation —
      // one listener over plain server markup, the share sheet's shape.
      data-msg-id={message.id}
    >
      <div className="mb-0.5 flex justify-between gap-3 text-xs text-ink-500">
        {/* Truncated: a manager's full name wrapped to a second line inside a
            narrow bubble on a phone, pushing the message itself down. */}
        <span className="truncate">{out ? message.manager : clientLabel}</span>
        <span className="whitespace-nowrap">
          {new Date(message.sentAt).toLocaleString('ru-RU', {
            dateStyle: 'short',
            timeStyle: 'short',
          })}
        </span>
      </div>

      {/* «forvarded deb accountusername turadi» — the owner's item 1. An
          EMPTY string is a real answer and not a missing one: Telegram hides
          the source when the sender's privacy says so, and «forwarded, from
          somebody» is still the fact that changes how a manager reads it. */}
      {labels && message.fwdFrom !== null && message.fwdFrom !== undefined && (
        <p className="mb-1 truncate text-xs italic text-ink-500" data-testid="tg-fwd">
          ↪ {labels.forwarded}: {message.fwdFrom || labels.hidden}
        </p>
      )}

      {/* What this answers (owner's item 2). Drawn even when the target is
          not stored here — a reply to a message older than the import is
          still a reply, and an empty strip says so more honestly than
          silence. */}
      {message.quoted && (
        <div
          className="mb-1 border-l-2 border-line-strong pl-2 text-xs text-ink-500"
          data-testid="tg-quote"
        >
          <span className="line-clamp-2 break-words">{quotePreview || `↩ …`}</span>
        </div>
      )}

      {/* The photograph ITSELF where we hold it (owner, item 15) — the
          paperclip line remains only for media we did not download. */}
      {(message.photos?.length ?? 0) > 0 && (
        <div className="mb-1 flex flex-wrap gap-1.5">
          {message.photos!.map((photo) => (
            <LightboxImg
              key={photo.id}
              attachmentId={photo.id}
              className="h-32 w-32 rounded-lg object-cover"
            />
          ))}
        </div>
      )}
      {/* The voice note ITSELF (owner, 2026-08-07: «audio habarlar
          korinmayabti» — a client explaining what they want, out loud, was
          reaching the manager's Telegram and printing «📎» here).
          preload="none": a thread of thirty voice notes must not fetch thirty
          files to draw itself. */}
      {(message.audios?.length ?? 0) > 0 && (
        <div className="mb-1 space-y-1">
          {message.audios!.map((audio) => (
            <audio
              key={audio.id}
              controls
              preload="none"
              src={`/api/attachments/${audio.id}`}
              data-testid="tg-audio"
              className="h-9 w-full min-w-48"
            />
          ))}
        </div>
      )}
      {/* A DOCUMENT is a download, not a player and not a paperclip (owner,
          2026-08-11: «klientlar ham bizga fillar jonatishadi»). The name and
          the size both print, because an invoice and a photo of an invoice
          are opened by different people for different reasons. */}
      {(message.files?.length ?? 0) > 0 && (
        <div className="mb-1 space-y-1">
          {message.files!.map((file) => (
            <a
              key={file.id}
              href={`/api/attachments/${file.id}`}
              download={file.fileName}
              className="flex items-center gap-1.5 rounded-lg bg-surface px-2 py-1.5 text-xs font-semibold underline"
              data-testid="tg-file"
            >
              <span className="shrink-0">📄</span>
              <span className="min-w-0 flex-1 truncate">{file.fileName}</span>
              <span className="shrink-0 font-normal text-ink-500">
                {fileSize(file.sizeBytes)}
              </span>
            </a>
          ))}
        </div>
      )}
      {message.body ? (
        <p className="whitespace-pre-wrap break-words">{message.body}</p>
      ) : media > 0 ? null : (
        <p className="text-ink-500">📎 {mediaLabel}</p>
      )}

      {/* Plain buttons carrying their data — no island, see the note above.
          `type="button"` because the thread's compose form is an ancestor on
          the dock and a bare button inside a form submits it. */}
      {labels && (
        <div className="mt-1 flex justify-end gap-1 text-xs">
          {/* Empty label = the composer is not on this screen (the bridge is
              down, or the chat is somebody else's), so the ↩ would open
              nothing. The ➦ stays: showing a colleague works either way. */}
          {message.tgMessageId != null && labels.reply !== '' && (
            <button
              type="button"
              className="text-ink-500 underline"
              data-reply-to={String(message.tgMessageId)}
              data-reply-preview={messagePreview(message, mediaLabel)}
              data-testid="tg-reply-pick"
            >
              ↩ {labels.reply}
            </button>
          )}
          <button
            type="button"
            className="text-ink-500 underline"
            data-share-msg={message.id}
            data-testid="tg-share-pick"
          >
            ➦ {labels.share}
          </button>
        </div>
      )}
    </div>
  );
}
