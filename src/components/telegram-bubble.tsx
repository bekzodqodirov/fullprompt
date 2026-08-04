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
}

export function TelegramBubble({
  message,
  clientLabel,
  mediaLabel,
}: {
  message: BubbleMessage;
  /** What to call the other side — the client's own name is not in the row. */
  clientLabel: string;
  /** Stands in for an attachment: phase 2 imports that one WAS sent, not it. */
  mediaLabel: string;
}) {
  const out = message.direction === 'out';
  return (
    <div
      className={`max-w-[85%] rounded-xl px-3 py-2 text-sm ${
        out ? 'ml-auto bg-brand-50' : 'mr-auto bg-surface-sunken'
      }`}
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
      {message.body ? (
        <p className="whitespace-pre-wrap break-words">{message.body}</p>
      ) : (message.photos?.length ?? 0) > 0 ? null : (
        <p className="text-ink-500">📎 {mediaLabel}</p>
      )}
    </div>
  );
}
