import type { Api as GramApi, helpers as GramHelpers } from 'telegram';
import type { AgentTelegram, HeadMessage } from './send-step';

/**
 * The listener's Telegram as the agent's send steps need it (review
 * build-3): `send-step.ts` decides, this calls. A thin shell on purpose —
 * every call is one raw request, and the tests hand it a fake client that
 * records what was invoked.
 *
 * Raw `invoke` and not gramjs's conveniences, for three reasons the review
 * found:
 *   - `client.sendMessage` builds a NEW SendMessage per call, and the TL
 *     constructor mints a fresh random_id when none is given (ban-5). The
 *     row's own random_id, minted once at approval, is what makes a resend
 *     after a lost answer a RANDOM_ID_DUPLICATE instead of a second message.
 *   - `noWebpage` — a link the customer pasted must not unfurl into a card
 *     in OUR message (and every preview is another fetch Telegram logs).
 *   - `client.markAsRead` marks the whole dialog; `ReadHistory` with the
 *     anchor as maxId reads exactly what the reply answers, so a line the
 *     customer adds while we type stays unread on his phone.
 *
 * `Api` and `helpers` are passed in rather than imported: `telegram` is a
 * large node-only package, and the listener already holds the module it
 * loaded (the tg-import discipline — nothing else should pull it in).
 */

/** The one method of TelegramClient the adapter uses. */
export interface InvokingClient {
  invoke(request: GramApi.AnyRequest): Promise<unknown>;
}

export interface GramModule {
  Api: typeof GramApi;
  helpers: Pick<typeof GramHelpers, 'returnBigInt'>;
}

interface RawMessageLike {
  className?: string;
  id?: number;
  out?: boolean;
  message?: unknown;
  media?: unknown;
}

/** Media classes that are not something the customer SENT: nothing, a link's own unfurl, a client too old to say. */
const NOT_CONTENT = new Set(['MessageMediaEmpty', 'MessageMediaWebPage', 'MessageMediaUnsupported', 'MessageMediaDice']);

/**
 * Does this message carry something the customer sent (review S4)? A photo, a
 * voice note, an audio, a file, a video, a place, a contact — each wants its
 * own answer, and its text is '' so the text alone read it as a nudge. Not a
 * sticker: it is the «👍» it stands for, and the listener keeps no file of it
 * either (`tgMediaPlan`), so the stored check and the head agree.
 */
export function carriesContent(media: unknown): boolean {
  const m = media as { className?: string; document?: { attributes?: { className?: string }[] } } | null | undefined;
  if (!m || typeof m.className !== 'string' || NOT_CONTENT.has(m.className)) return false;
  if (m.className === 'MessageMediaDocument') {
    const attributes = Array.isArray(m.document?.attributes) ? m.document.attributes : [];
    if (attributes.some((a) => a?.className === 'DocumentAttributeSticker')) return false;
  }
  return true;
}

interface RawUpdateLike {
  className?: string;
  id?: number;
  randomId?: { toString(): string };
  message?: { id?: number };
}

/**
 * The id Telegram gave the message we just sent. A private chat answers
 * with `UpdateShortSentMessage`; anything else carries `UpdateMessageID`
 * pairing our random_id with the id — matched by the random_id, because an
 * Updates bundle can carry other messages too. Null when neither is there:
 * the row is still SENT (Telegram took it), only its echo cannot be written.
 */
export function sentMessageId(result: unknown, randomId: bigint): bigint | null {
  const r = result as { className?: string; id?: number; updates?: RawUpdateLike[] } | null | undefined;
  if (!r) return null;
  if (r.className === 'UpdateShortSentMessage' && typeof r.id === 'number') return BigInt(r.id);
  const updates = Array.isArray(r.updates) ? r.updates : [];
  const mine = updates.find(
    (u) => u.className === 'UpdateMessageID' && u.randomId?.toString() === randomId.toString(),
  );
  if (mine && typeof mine.id === 'number') return BigInt(mine.id);
  const fresh = updates.find((u) => u.className === 'UpdateNewMessage' && typeof u.message?.id === 'number');
  return fresh?.message?.id !== undefined ? BigInt(fresh.message.id) : null;
}

export function agentTelegramOver(client: InvokingClient, gram: GramModule): AgentTelegram {
  const { Api, helpers } = gram;
  // Through the library's own big integer: a JS bigint is not an EntityLike,
  // and Number() on a Telegram id is a silent wrong recipient. The id
  // resolves out of the entity cache the conversation itself filled.
  const peerOf = (peerId: bigint) => helpers.returnBigInt(peerId.toString());

  return {
    async history(peerId, limit) {
      const res = (await client.invoke(
        new Api.messages.GetHistory({
          peer: peerOf(peerId),
          limit,
          offsetId: 0,
          offsetDate: 0,
          addOffset: 0,
          maxId: 0,
          minId: 0,
          hash: helpers.returnBigInt(0),
        }),
      )) as { messages?: RawMessageLike[] } | null;
      const list = Array.isArray(res?.messages) ? res.messages : [];
      const head: HeadMessage[] = [];
      for (const m of list) {
        if (m.className === 'MessageEmpty' || typeof m.id !== 'number') continue;
        head.push({
          id: BigInt(m.id),
          out: m.out === true,
          text: typeof m.message === 'string' ? m.message : '',
          media: carriesContent(m.media),
        });
      }
      return head;
    },

    async readHistory(peerId, maxId) {
      await client.invoke(new Api.messages.ReadHistory({ peer: peerOf(peerId), maxId: Number(maxId) }));
    },

    async setTyping(peerId) {
      await client.invoke(
        new Api.messages.SetTyping({ peer: peerOf(peerId), action: new Api.SendMessageTypingAction() }),
      );
    },

    async markUnread(peerId) {
      // The request's peer is an InputDialogPeer; gramjs resolves an
      // EntityLike into one itself (its `resolve` step, case InputDialogPeer),
      // so the id travels the same way as every other call here.
      await client.invoke(
        new Api.messages.MarkDialogUnread({
          peer: peerOf(peerId) as unknown as GramApi.TypeInputDialogPeer,
          unread: true,
        }),
      );
    },

    async send({ peerId, body, randomId, replyTo }) {
      const result = await client.invoke(
        new Api.messages.SendMessage({
          peer: peerOf(peerId),
          message: body,
          randomId: helpers.returnBigInt(randomId.toString()),
          noWebpage: true,
          replyTo: replyTo !== null ? new Api.InputReplyToMessage({ replyToMsgId: Number(replyTo) }) : undefined,
        }),
      );
      return { tgMessageId: sentMessageId(result, randomId) };
    },
  };
}
