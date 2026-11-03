import { Api, helpers } from 'telegram';
import { describe, expect, it } from 'vitest';
import { agentTelegramOver, carriesContent, sentMessageId } from '@/modules/wms/agent/gramjs-adapter';

/**
 * The agent's Telegram calls, over a fake client that records every request
 * it is handed (review build-3: the listener builds only this adapter, and
 * this is where its calls can be seen without a network). The requests are
 * gramjs's own TL objects, so a renamed field or a wrong class fails here.
 */

function recorder(answer: (request: Api.AnyRequest) => unknown = () => ({})) {
  const calls: Api.AnyRequest[] = [];
  return {
    calls,
    client: {
      async invoke(request: Api.AnyRequest) {
        calls.push(request);
        return answer(request);
      },
    },
  };
}

const PEER = 7_000_000_123n;

describe('the agent adapter', () => {
  it('reads the live head with GetHistory and maps it newest-first, skipping empty slots', async () => {
    const { calls, client } = recorder(() => ({
      messages: [
        new Api.Message({ id: 52, peerId: new Api.PeerUser({ userId: helpers.returnBigInt(PEER.toString()) }), date: 1, message: 'Narxi?', out: false }),
        new Api.MessageEmpty({ id: 51 }),
        new Api.Message({ id: 50, peerId: new Api.PeerUser({ userId: helpers.returnBigInt(PEER.toString()) }), date: 1, message: 'Salom', out: true }),
      ],
    }));
    const tg = agentTelegramOver(client, { Api, helpers });
    const head = await tg.history(PEER, 3);
    expect(head).toEqual([
      { id: 52n, out: false, text: 'Narxi?', media: false },
      { id: 50n, out: true, text: 'Salom', media: false },
    ]);
    const req = calls[0] as Api.messages.GetHistory;
    expect(req.className).toBe('messages.GetHistory');
    expect(req.limit).toBe(3);
    expect(String(req.peer)).toBe(PEER.toString());
  });

  it('marks a line that carries something the customer SENT — a photo, a voice note, a file — and not a sticker (S4)', async () => {
    const user = new Api.PeerUser({ userId: helpers.returnBigInt(PEER.toString()) });
    const doc = (attributes: Api.TypeDocumentAttribute[]) =>
      new Api.MessageMediaDocument({
        document: new Api.Document({
          id: helpers.returnBigInt('1'),
          accessHash: helpers.returnBigInt('1'),
          fileReference: Buffer.from(''),
          date: 1,
          mimeType: 'audio/ogg',
          size: helpers.returnBigInt('100'),
          dcId: 2,
          attributes,
        }),
      });
    const photo = new Api.MessageMediaPhoto({});
    const voice = doc([new Api.DocumentAttributeAudio({ duration: 3, voice: true })]);
    const sticker = doc([
      new Api.DocumentAttributeSticker({ alt: '👍', stickerset: new Api.InputStickerSetEmpty() }),
    ]);
    const { client } = recorder(() => ({
      messages: [
        new Api.Message({ id: 55, peerId: user, date: 1, message: '', media: sticker }),
        new Api.Message({ id: 54, peerId: user, date: 1, message: '', media: voice }),
        new Api.Message({ id: 53, peerId: user, date: 1, message: '', media: photo }),
        new Api.Message({ id: 52, peerId: user, date: 1, message: 'https://x.uz', media: new Api.MessageMediaWebPage({ webpage: new Api.WebPageEmpty({ id: helpers.returnBigInt('1') }) }) }),
      ],
    }));
    const head = await agentTelegramOver(client, { Api, helpers }).history(PEER, 4);
    expect(head.map((m) => [m.id, m.media])).toEqual([
      [55n, false],
      [54n, true],
      [53n, true],
      [52n, false],
    ]);
    expect(carriesContent(undefined)).toBe(false);
    expect(carriesContent(new Api.MessageMediaEmpty())).toBe(false);
    expect(carriesContent(new Api.MessageMediaGeo({ geo: new Api.GeoPointEmpty() }))).toBe(true);
  });

  it('reads exactly up to the anchor with ReadHistory — not the whole dialog', async () => {
    const { calls, client } = recorder();
    await agentTelegramOver(client, { Api, helpers }).readHistory(PEER, 50n);
    const req = calls[0] as Api.messages.ReadHistory;
    expect(req.className).toBe('messages.ReadHistory');
    expect(req.maxId).toBe(50);
  });

  it('types with SetTyping and a typing action', async () => {
    const { calls, client } = recorder();
    await agentTelegramOver(client, { Api, helpers }).setTyping(PEER);
    const req = calls[0] as Api.messages.SetTyping;
    expect(req.className).toBe('messages.SetTyping');
    expect(req.action).toBeInstanceOf(Api.SendMessageTypingAction);
  });

  it('gives the badge back with MarkDialogUnread', async () => {
    const { calls, client } = recorder();
    await agentTelegramOver(client, { Api, helpers }).markUnread(PEER);
    const req = calls[0] as Api.messages.MarkDialogUnread;
    expect(req.className).toBe('messages.MarkDialogUnread');
    expect(req.unread).toBe(true);
  });

  it('sends with the ROW’s random_id, previews off, quoting by id (ban-5)', async () => {
    const randomId = -4_611_686_018_427_387_905n;
    const { calls, client } = recorder(
      () => new Api.UpdateShortSentMessage({ id: 77, pts: 1, ptsCount: 1, date: 1, out: true }),
    );
    const sent = await agentTelegramOver(client, { Api, helpers }).send({
      peerId: PEER,
      body: 'Yukingiz keldi.',
      randomId,
      replyTo: 50n,
    });
    expect(sent).toEqual({ tgMessageId: 77n });
    const req = calls[0] as Api.messages.SendMessage;
    expect(req.className).toBe('messages.SendMessage');
    // The TL constructor mints a fresh random_id when none is given; the one
    // on the wire must be the row's, or a resend becomes a second message.
    expect(String(req.randomId)).toBe(randomId.toString());
    expect(req.noWebpage).toBe(true);
    expect(req.message).toBe('Yukingiz keldi.');
    expect(req.replyTo).toBeInstanceOf(Api.InputReplyToMessage);
    expect((req.replyTo as Api.InputReplyToMessage).replyToMsgId).toBe(50);
  });

  it('sends with no quote when the row has none', async () => {
    const { calls, client } = recorder(() => null);
    await agentTelegramOver(client, { Api, helpers }).send({ peerId: PEER, body: 'x', randomId: 5n, replyTo: null });
    expect((calls[0] as Api.messages.SendMessage).replyTo).toBeUndefined();
  });
});

describe('sentMessageId', () => {
  it('reads the id from a private chat’s short answer', () => {
    expect(sentMessageId(new Api.UpdateShortSentMessage({ id: 9, pts: 1, ptsCount: 1, date: 1 }), 1n)).toBe(9n);
  });

  it('pairs UpdateMessageID by OUR random_id, not the first one in the bundle', () => {
    const updates = new Api.Updates({
      updates: [
        new Api.UpdateMessageID({ id: 3, randomId: helpers.returnBigInt('111') }),
        new Api.UpdateMessageID({ id: 4, randomId: helpers.returnBigInt('222') }),
      ],
      users: [],
      chats: [],
      date: 1,
      seq: 0,
    });
    expect(sentMessageId(updates, 222n)).toBe(4n);
  });

  it('is null when Telegram took the message and named no id', () => {
    expect(sentMessageId(undefined, 1n)).toBeNull();
    expect(sentMessageId(new Api.Updates({ updates: [], users: [], chats: [], date: 1, seq: 0 }), 1n)).toBeNull();
  });
});
