/**
 * Does the customer's own burst complain, or ask for a person? (stage 1a P3, docs/ai-toliq/qurish/STAGE-0-1A.md §4.4.)
 *
 * The model's label `complaint` was the only thing that kept such a reply his — and since stage 1a the label decides
 * nothing else (the gate reads what a reply DOES), so a model that labels «Pulimni qaytaring» `faq` would answer it by
 * itself. This is the tripwire beside the label: a CLOSED list, six languages, read over what the customer wrote since
 * our last message (auto-send `autoFactsFor` reads the stored lines, at the scheduling and again at the press). A hit is
 * a card for his ✅ (gate `complaint`), never a block; a false hit costs one card, a miss costs a complaint answered by a
 * machine — so the list leans to holding. It names no person and no figure: it only reads.
 *
 * PURE. A free-text reader: every change runs the reader corpus (`complaint` rows, tests/unit/fixtures/
 * agent-reader-corpus.ts) first.
 */

const B = '(?<![\\p{L}\\p{N}])';
const E = '(?![\\p{L}\\p{N}])';

const COMPLAINT = new RegExp(
  [
    // Uzbek Latin: a manager wanted, the boss, a complaint, money back, deceived, the court.
    `${B}(?:menejer|menedjer|manager)\\p{L}*\\s+(?:kerak|chaqir\\p{L}*|bilan\\s+gaplash\\p{L}*)`,
    // «…bilan bog‘lab bering» — the asking forms only: «menejer bilan bog‘landim» is a manager already reached.
    `${B}(?:menejer|menedjer|manager|rahbar|odam)\\p{L}*\\s+bilan\\s+bog['‘’ʻ\`]?la(?:b\\s+ber\\p{L}*|ng\\p{L}*|sh(?:tiring|ing|ish\\s+kerak))${E}`,
    // «Odam bilan gaplashmoqchiman» — a person wanted; «bir odam bilan gaplashib, keyin yozaman» wants nobody.
    `${B}odam\\s+bilan\\s+gaplash(?:moqchi\\p{L}*|ish\\s+(?:kerak|mumkin)\\p{L}*|tiring|ing|ay\\p{L}*)${E}`,
    `${B}(?:firibgar|aldov)\\p{L}*`,
    `${B}rahbar\\p{L}*\\s+bilan`,
    `${B}rahbar\\p{L}*ni\\s+chaqir\\p{L}*`,
    `${B}shikoyat\\p{L}*`,
    `${B}pul(?:im|imiz|ingiz)?(?:ni)?\\s+qaytar\\p{L}*`,
    `${B}ald(?:ad|ab|ay)\\p{L}*`,
    `${B}sud(?:ga|da|ga\\s+ber\\p{L}*)${E}`,
    `${B}(?:tirik|haqiqiy)\\s+odam\\p{L}*\\s+(?:kerak|bilan)`,
    // Uzbek Cyrillic.
    `${B}(?:менежер|менеджер)\\p{L}*\\s+(?:керак|чақир\\p{L}*|чакир\\p{L}*)`,
    `${B}ра[ҳх]бар\\p{L}*\\s+билан`,
    `${B}шикоят\\p{L}*`,
    `${B}пул(?:им|имиз|ингиз)?(?:ни)?\\s+[қк]айтар\\p{L}*`,
    `${B}алда(?:д|б|й)\\p{L}*`,
    `${B}(?:фирибгар|алдов)\\p{L}*`,
    // Russian.
    `${B}жалоб\\p{L}*`,
    `${B}жалу(?:юсь|ется|ются)${E}`,
    `${B}жалова\\p{L}*`,
    `${B}мошенн\\p{L}*`,
    `${B}верн\\p{L}*\\s+(?:мне\\s+|мои\\s+|наши\\s+)?деньги`,
    `${B}возврат\\p{L}*\\s+(?:денег|средств|оплаты)`,
    `${B}(?:позовите|позови|дайте|соедините|свяжите)\\s+(?:меня\\s+)?(?:с\\s+)?(?:менеджер|руководител|начальник|живого|человек|оператор)\\p{L}*`,
    `${B}(?:поговорить|связаться|общаться)\\s+с\\s+(?:менеджер|руководител|начальник|живым|человеком|оператор)\\p{L}*`,
    `${B}(?:обманул|обманули|обман)\\p{L}*`,
    `${B}(?:в\\s+суд|суд\\p{L}*\\s+пода\\p{L}*)`,
    // English.
    `${B}refund${E}`,
    `${B}(?:my|the)\\s+money\\s+back${E}`,
    `${B}complain(?:t|ts|ing|ed)?${E}`,
    `${B}(?:real|live|actual)\\s+(?:person|human|manager)${E}`,
    `${B}(?:talk|speak)\\s+(?:to|with)\\s+(?:a\\s+|the\\s+|your\\s+)?(?:manager|boss|supervisor|human)${E}`,
    `${B}(?:scam\\p{L}*|fraud\\p{L}*|cheated|lawyer|sue)${E}`,
    // Chinese.
    '投诉|退款|退钱|骗子|骗人|找你们(?:经理|老板|领导)|叫你们(?:经理|老板|领导)|真人客服|人工客服',
    // Persian.
    'شکایت|پولم\\s+را\\s+پس|پول\\s+مرا\\s+پس|بازپرداخت|کلاهبرداری|(?:با|به)\\s+(?:مدیر|مسئول)\\s+(?:صحبت|وصل)',
  ].join('|'),
  'iu',
);

/** A customer's line complains, or asks for a person. */
export function complains(text: string): boolean {
  return COMPLAINT.test(text);
}

/** Does any of the customer's lines — his burst — complain or ask for a person? */
export function complaintIn(texts: readonly (string | null)[]): boolean {
  return texts.some((t) => t !== null && complains(t));
}
