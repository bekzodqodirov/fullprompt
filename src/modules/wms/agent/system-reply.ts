import type { AgentLocale, ScriptName } from './locale';
import type { ComposeReply } from './run';
import type { SystemReplyReason } from './types';
import type { BurstMessage, Worthiness } from './worthy';

/**
 * The tayyor matn — the lines the CODE answers with when the model cannot (stage 1a P3, docs/ai-toliq/qurish/
 * STAGE-0-1A.md §4.4): a voice note it cannot hear (his 13 a), a photo or a file it cannot open (eyes are stage 2), a
 * Pashto message it cannot write. Today each was silence to the customer — a notice to him, or nothing at all — and a
 * customer who sends his invoice as a photo waited for nobody. Now he gets ONE honest line, and the owner gets the card.
 *
 * The line goes through everything a reply does — the policy on the same memory, the gate, the card, the same draft
 * writer (run `handleInbound`: one write site, J10) — and is marked `policy.system`, so the gate does not refuse it for
 * the very photo it answers (`media`) and the card says what it is. It states no cargo, no money and no code, and it
 * promises nothing: «write it as text» is all it asks.
 *
 * Words measured against the policy in the six languages (`tests/unit/agent-system-reply.test.ts`): no figure, no
 * promise word, no numeral character in the Chinese, and the Pashto line's Persian half holds more letters than its
 * Russian one — G5 judges a reply by its dominant script, and a long Russian half made the whole line Cyrillic. The media
 * line is NEUTRAL (J29): it asks for «the information you need» as text, never «kub and kg» of a customer who has just
 * given them, or of a coded client's cheque. Three wordings each, chosen by the chat (G10 counts identical texts).
 */

export interface SystemLine {
  text: string;
  /** His Uzbek reading of a line he cannot read (Persian, Chinese, English); '' where he reads the line itself. */
  glossUz: string;
}

const G_VOICE = 'Ovozli xabarni hozir eshita olmayapman — iltimos, yozib yuboring.';
const G_MEDIA = 'Faylni oldim, lekin hozircha ocha olmayapman — kerakli ma’lumotni matn bilan yozib yuboring.';
const G_PASHTO = 'Iltimos, fors yoki rus tilida yozing.';

const lines = (gloss: string, texts: readonly [string, string, string]): readonly SystemLine[] =>
  texts.map((text) => ({ text, glossUz: gloss }));

export const SYSTEM_LINES: {
  voice: Record<AgentLocale, readonly SystemLine[]>;
  media: Record<AgentLocale, readonly SystemLine[]>;
  /** One language, Persian, with a SHORT Russian half — the customer reads one of the two. */
  pashto: readonly SystemLine[];
} = {
  voice: {
    uz: lines('', [
      'Ovozli xabaringizni hozir eshita olmayapman — iltimos, yozib yuboring.',
      'Ovozli xabarni hozircha tinglay olmayman — iltimos, matn bilan yozib yuboring.',
      'Kechirasiz, ovozli xabarni hozir eshita olmayapman — iltimos, yozib yuboring.',
    ]),
    uz_cyrl: lines('', [
      'Овозли хабарингизни ҳозир эшита олмаяпман — илтимос, ёзиб юборинг.',
      'Овозли хабарни ҳозирча тинглай олмайман — илтимос, матн билан ёзиб юборинг.',
      'Кечирасиз, овозли хабарни ҳозир эшита олмаяпман — илтимос, ёзиб юборинг.',
    ]),
    ru: lines('', [
      'Голосовое сообщение сейчас прослушать не могу — пожалуйста, напишите текстом.',
      'К сожалению, сейчас не могу прослушать голосовое — пожалуйста, напишите текстом.',
      'Извините, голосовые сообщения сейчас не открываются — напишите, пожалуйста, текстом.',
    ]),
    en: lines(G_VOICE, [
      'I can’t listen to voice messages right now — please type your message.',
      'Sorry, I’m unable to play voice notes at the moment — please write it as text.',
      'I can’t open voice messages for now — please send it as text.',
    ]),
    fa: lines(G_VOICE, [
      'فعلاً نمی‌توانم پیام صوتی را گوش کنم — لطفاً پیام را بنویسید.',
      'متأسفانه الان پیام صوتی را نمی‌توانم بشنوم — لطفاً متنی بنویسید.',
      'ببخشید، فعلاً پیام صوتی باز نمی‌شود — لطفاً بنویسید.',
    ]),
    zh: lines(G_VOICE, ['我现在听不了语音消息，请您用文字发过来。', '抱歉，暂时无法收听语音，请用文字写给我。', '不好意思，我现在打不开语音，麻烦您打字发过来。']),
  },
  media: {
    uz: lines('', [
      'Faylni oldim, lekin hozircha ocha olmayapman — kerakli ma’lumotni matn bilan yozib yuboring.',
      'Yuborganingizni oldim, ammo hozircha ocha olmayman — iltimos, kerakli ma’lumotni matn bilan yozing.',
      'Rahmat, oldim, lekin hozircha faylni ocha olmayapman — kerakli ma’lumotni yozib yuborsangiz bo‘ladi.',
    ]),
    uz_cyrl: lines('', [
      'Файлни олдим, лекин ҳозирча оча олмаяпман — керакли маълумотни матн билан ёзиб юборинг.',
      'Юборганингизни олдим, аммо ҳозирча оча олмайман — илтимос, керакли маълумотни матн билан ёзинг.',
      'Раҳмат, олдим, лекин ҳозирча файлни оча олмаяпман — керакли маълумотни ёзиб юборсангиз бўлади.',
    ]),
    ru: lines('', [
      'Файл получил, но пока не могу его открыть — напишите, пожалуйста, нужные данные текстом.',
      'Получил, но открыть пока не получается — пожалуйста, напишите нужное текстом.',
      'Спасибо, получил, но файл сейчас открыть не могу — напишите нужную информацию текстом, пожалуйста.',
    ]),
    en: lines(G_MEDIA, [
      'I got your file, but I can’t open it for now — please type the details you need as text.',
      'Received, thank you — I can’t open files at the moment, so please write the details in a message.',
      'Thanks, I got it, but I can’t open it right now — please type the information as text.',
    ]),
    fa: lines(G_MEDIA, [
      'فایل را دریافت کردم، اما فعلاً نمی‌توانم آن را باز کنم — لطفاً اطلاعات لازم را به صورت متن بنویسید.',
      'دریافت شد، ولی الان نمی‌توانم بازش کنم — لطفاً اطلاعات را متنی بنویسید.',
      'ممنون، رسید، اما فعلاً باز نمی‌شود — لطفاً اطلاعات لازم را بنویسید.',
    ]),
    zh: lines(G_MEDIA, [
      '文件收到了，但我暂时打不开——请把需要的信息用文字发给我。',
      '已收到，不过现在打不开，请用文字写下需要的信息。',
      '谢谢，收到了，但暂时无法打开，麻烦您用文字发过来。',
    ]),
  },
  pashto: lines(G_PASHTO, [
    'لطفاً به فارسی یا روسی بنویسید. Пишите по-русски.',
    'لطفاً پیام را به زبان فارسی یا روسی بنویسید. Напишите по-русски.',
    'خواهش می‌کنم به فارسی یا روسی بنویسید. Можно по-русски.',
  ]),
};

/** The card's own line for a tayyor matn (J33) — drawn from `policy.system` when the card is rendered, never a stored note. */
const CARD_HEAD: Record<SystemReplyReason, string> = {
  voice: '🎤 Mijoz ovozli xabar yubordi',
  media: '📎 Mijoz rasm yoki fayl yubordi',
  pashto: '🌐 Mijoz pushtu tilida yozdi',
};

/**
 * The card's line: what the customer sent, and that the answer is the code's tayyor matn — «ketdi» only once it went (a
 * line claiming a send that did not happen is #1106's mistake). Quoted in Uzbek, so he reads it whatever the language.
 */
export function systemCardLine(reason: SystemReplyReason, went: boolean, glossUz: string): string {
  return `${CARD_HEAD[reason]} — ${went ? 'tayyor matn ketdi' : 'javob — tayyor matn'}: «${glossUz}»`;
}

/** The Uzbek reading of a tayyor matn, whichever wording and language went. */
export function systemGlossUz(reason: SystemReplyReason): string {
  return reason === 'voice' ? G_VOICE : reason === 'media' ? G_MEDIA : G_PASHTO;
}

/**
 * Which tayyor matn a burst the model cannot answer gets (§4.4 and its finding 1) — null when it gets none. Pashto: the
 * Pashto line. A burst with no text: any kept photo or file → the media line; else any voice note or audio → the voice
 * line (a voice note beside a sticker is still a voice note — `draftWorthy` calls that burst `media_only`); a burst of
 * stickers, round videos or files storage refused (`other`) alone gets nothing, as today.
 */
export function systemReasonOf(w: Worthiness, burst: readonly BurstMessage[]): SystemReplyReason | null {
  if (w.worthy) return null;
  if (w.reason === 'pashto') return 'pashto';
  if (w.reason !== 'voice_only' && w.reason !== 'media_only') return null;
  if (burst.some((m) => m.media === 'photo' || m.media === 'document')) return 'media';
  if (burst.some((m) => m.media === 'voice' || m.media === 'audio')) return 'voice';
  return null;
}

/**
 * The language of a tayyor matn (§4.4 finding 3): the customer's language when what he said or what the chat
 * remembers names one (run `customerLocaleOf`), else by the chat's SCRIPT — G5 compares the reply's script with the
 * customer's, and an Uzbek Latin line to a Cyrillic chat was measured `wrong_script`: Cyrillic → Russian, Arabic →
 * Persian, Han → Chinese, Latin or nothing → Uzbek.
 */
export function systemLocaleOf(said: AgentLocale | null, script: ScriptName | null): AgentLocale {
  if (said !== null) return said;
  switch (script) {
    case 'cyrillic':
      return 'ru';
    case 'arabic':
      return 'fa';
    case 'han':
      return 'zh';
    default:
      return 'uz';
  }
}

/** One of the three wordings, the same for a chat every time (G10 counts identical texts across chats). */
function pick<T>(list: readonly T[], peerId: bigint): T {
  let h = 0;
  for (const c of String(peerId)) h = (h * 31 + c.charCodeAt(0)) >>> 0;
  return list[h % list.length]!;
}

/** The tayyor matn for a burst, as the model's reply would come — so the rest of the run treats it as one. */
export function systemReplyFor(input: { reason: SystemReplyReason; locale: AgentLocale; peerId: bigint }): ComposeReply {
  const language: AgentLocale = input.reason === 'pashto' ? 'fa' : input.locale;
  const line = input.reason === 'pashto' ? pick(SYSTEM_LINES.pashto, input.peerId) : pick(SYSTEM_LINES[input.reason][language], input.peerId);
  return {
    replyNeeded: true,
    replyText: line.text,
    language,
    glossUz: line.glossUz,
    // `other`: the drafts' category CHECK admits seven labels, and `status` would ask for a cargo reading
    // (`status_unbacked`) the line never claims.
    category: 'other',
    // No model rated it.
    confidence: null,
    needsOwner: false,
    ownerQuestion: '',
    nextStep: 'wait',
    actions: [],
    usedFactIds: [],
    citedMessageRefs: [],
  };
}

/** Every tayyor matn's text, folded — what «our last line was one» is compared against. */
const fold = (t: string) => t.normalize('NFC').toLowerCase().replace(/\s+/gu, ' ').trim();
const ALL_LINES = new Set(
  [...Object.values(SYSTEM_LINES.voice).flat(), ...Object.values(SYSTEM_LINES.media).flat(), ...SYSTEM_LINES.pashto].map((l) => fold(l.text)),
);

/**
 * Our last line in the chat IS a tayyor matn (§4.4 «once per silence»): the burst after it gets no second one — the
 * customer was told already, and a line per photo of a ten-page invoice is a robot talking to itself.
 */
export function isSystemLine(body: string | null | undefined): boolean {
  return ALL_LINES.has(fold(body ?? ''));
}
