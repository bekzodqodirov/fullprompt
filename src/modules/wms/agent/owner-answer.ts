import { and, eq, gte, sql } from 'drizzle-orm';
import { db } from '../../platform/db/client';
import { tgMessageFlags, tgMessages } from '../../platform/db/schema';
import { holdsNumeral } from './digits';
import { personalBitsWithBook } from './kb';
import { PHONE_RE, urlsIn } from './numbers';
import { keptFileSql } from './outbox-store';
import { asksAnew } from './send-step';
import { knownNamesForMask } from './style';
import { isNudge } from './worthy';

/**
 * «Bilmayman» → he answers the FACT → the AI writes the customer's words (spec SPEC-P1-v2 §2): the rules of his
 * answer that more than one door asks — the bot that takes it, the run that redrafts from it, the auto layer that
 * judges the redraft. The press, the wait and the worker are their doors' own (decide `answerQuestion`, agent-bot,
 * owner-answer-job).
 */

/** How long «✍️ Savolga javob» waits for his answer — the bot's one-text wait's own half hour (agent-bot). */
export const ANSWER_WAIT_MS = 30 * 60_000;

/**
 * An answer stored and still not drafted after this long is a worker that died with it (a deploy, a kill): the
 * sweep hands the question back and says so. Past the one retry's own wait (`HAND_BACK_RETRY_S`, five minutes) and a
 * run's whole wall clock, with room for a queue behind them.
 */
export const ANSWER_RUN_STALE_MS = 15 * 60_000;

/**
 * Why his typed answer is refused before anything is stored (§2.2, the money lens's «swipe»): a phone, a link or
 * Chinese text is an address or a contact — the AI never re-types one (a garbled Chinese street sends the cargo to
 * the wrong place, and `statesChinaAddress` checks only OUR anchors), so it goes verbatim through ✏️. Null = take it.
 */
export function answerTextRefusal(text: string): 'contact' | null {
  if (urlsIn(text).length > 0) return 'contact';
  if ([...text.matchAll(PHONE_RE)].length > 0) return 'contact';
  if (/\p{Script=Han}/u.test(text)) return 'contact';
  return null;
}

/** The refusal's words — the wait stays armed, so his next text is still the answer. */
export const ANSWER_CONTACT_WORDS = 'Manzil yoki telefonni ✏️ bilan yozing — AI uni qayta yozmaydi. Javobni manzil va telefonsiz qayta yozing.';

/** How much of the AI's own question the redraft is shown — a question is a sentence, never the chat. */
const QUESTION_SHOWN_CHARS = 400;

/**
 * The redraft's instruction (§2.2, judge learn): his words quoted VERBATIM, named as a source. Prompt rule 1 says a
 * figure in the task's answer may be used as it stands; the policy then holds every figure to his text
 * (`ownerAnswerSources`) — the instruction is never the source itself.
 *
 * `question`: what the AI had asked him (`owner_question`). His «Ha, olamiz» answers THAT sentence — the model's
 * own wording of the customer's line, which the redraft's run would otherwise never see — so it is shown beside the
 * answer, named as no source: a figure in it is the model's own retelling, and a reply repeating it is held by the
 * policy like any other unsourced figure.
 */
export function ownerAnswerInstruction(text: string, question: string | null = null): string {
  const asked = (question ?? '').replace(/\s+/gu, ' ').trim();
  const shown = [...asked].length > QUESTION_SHOWN_CHARS ? `${[...asked].slice(0, QUESTION_SHOWN_CHARS).join('')}…` : asked;
  const about = shown ? ` Bu — sening Bekzodga bergan shu savolingga javob (savol manba emas, undagi sonni ishlatma): «${shown}».` : '';
  return `Bekzodning javobi (manba — undagi raqamni o'zgartirmay ishlat): «${text.trim()}».${about} Shu javob asosida mijozning so'nggi savoliga mijoz tilida va alifbosida qisqa javob yoz.`;
}

/**
 * What his answer names that is not this chat's to hear (§2.2 `owner_personal`): another customer's code, a phone,
 * a name the client book or the staff hold that is not this chat's own — and this chat's OWN code while the chat has
 * not proved it is that client (`identity.cargoAllowed`: a typed code serves no cargo, and must not get it by relay).
 * A redraft that carries any of them comes back to him as a card, never by itself.
 */
export async function ownerPersonalOf(input: {
  text: string;
  ownCodes: readonly string[];
  ownNames: readonly string[];
  cargoAllowed: boolean;
}): Promise<string[]> {
  const lowered = input.text.toLowerCase();
  const ownCodes = new Set(input.ownCodes.map((c) => c.toUpperCase()));
  const ownNames = new Set(input.ownNames.map((n) => n.trim().toLowerCase()).filter((n) => n !== ''));
  // The book's whole names his words carry — the «📌» writer's own reading (bot-door `kbPress`) — minus this chat's
  // own: the names are dropped BEFORE the reading, never from its answer. `personalBits` answers with every needle of
  // a name it found («Ali Valiyev», «Ali», «Valiyev»), and only the whole name is one of the chat's own — filtered
  // afterwards, «Ali Valiyev so'ragan edi» about the very customer he is answering left «Ali» and «Valiyev» standing
  // as another customer's, and every answer naming its own customer came back as a card.
  const others = (await knownNamesForMask(false)).filter((n) => lowered.includes(n.toLowerCase()) && !ownNames.has(n.trim().toLowerCase()));
  const bits = await personalBitsWithBook(input.text, others);
  // A code of this chat's own is the chat's to hear only once it has proved it is that client.
  return [...new Set(bits)].filter((b) => !ownCodes.has(b.toUpperCase()) || !input.cargoAllowed);
}

/**
 * Did his ✍️ answer hold a figure (§2.2 `owner_figure`, his Q2 a ⭐: «javobingizda raqam bo'lsa AI yozgan javob har
 * doim sizga karta bo'lib keladi»)? Asked of HIS words, once, when the redraft is written — never of the ledger's
 * attribution: `sourceFor` names the FIRST source that fits, and his answer's sources come last, so «300 kg dan kam
 * yukni olmaymiz» answered to a customer who wrote «300 kg yukim bor» left a line vouched for by the customer, and
 * «Ha, 300 kg yukingizni bemalol olib kelamiz» — his figure, its meaning turned round — went by itself; and a
 * redraft that quotes the tool's 800 $ where he said 700 $ carries no line of his at all.
 */
export function answerHoldsFigure(text: string): boolean {
  return holdsNumeral(text);
}

/**
 * Is his answer no longer an answer to what the customer is asking (§2.2 `answer_stale`)? Three ways:
 *  - the customer wrote again — something that asks anew (`asksAnew`, the head's own rule: a photo, a file, any
 *    line that is not a nudge) — after the line the question was asked about;
 *  - he EDITED that very line after the question was drafted over it (`anchorEditedAt`, the ✅'s own
 *    `editedSince`): an edit keeps the message id, the edit's own run stands down while the question is `editing`,
 *    and the redraft anchors on the edited line with the edit as its OWN stamp — so «…suyuq atir va litiy batareya
 *    ham…» was answered with his «Ha, olamiz» to the wording his card showed, and went by itself;
 *  - he DELETED it: the redraft anchors on an older line, and answers a question that is no longer there.
 * Then the redraft waits for his eye.
 */
export async function answerStale(
  managerUserId: string,
  peerId: bigint,
  questionAnchor: bigint,
  anchorEditedAt: Date | null = null,
): Promise<boolean> {
  const rows = await db
    .select({
      tgMessageId: tgMessages.tgMessageId,
      body: tgMessages.body,
      editedAt: tgMessages.editedAt,
      deletedAt: tgMessageFlags.deletedAt,
      kept: keptFileSql(sql`${tgMessages}.id`).mapWith(Boolean),
    })
    .from(tgMessages)
    .leftJoin(tgMessageFlags, eq(tgMessageFlags.messageId, tgMessages.id))
    .where(
      and(
        eq(tgMessages.managerUserId, managerUserId),
        eq(tgMessages.peerId, peerId),
        eq(tgMessages.direction, 'in'),
        gte(tgMessages.tgMessageId, questionAnchor),
      ),
    );
  const anchor = rows.find((m) => m.tgMessageId === questionAnchor);
  // The line the question was asked about is gone, or is no longer the line he saw.
  if (!anchor || anchor.deletedAt !== null) return true;
  if (anchor.editedAt !== null && (anchorEditedAt === null || anchor.editedAt.getTime() > anchorEditedAt.getTime())) return true;
  return rows.some((m) => m.tgMessageId !== questionAnchor && m.deletedAt === null && asksAnew({ text: m.body ?? '', media: m.kept }, isNudge));
}
