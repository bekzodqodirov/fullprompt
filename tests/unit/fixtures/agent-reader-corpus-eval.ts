import * as autoGate from '@/modules/wms/agent/auto-gate';
import type { AutoGateInput } from '@/modules/wms/agent/auto-gate';
import * as autoMoney from '@/modules/wms/agent/auto-money';
import { withAviaDaysNow } from '@/modules/wms/agent/avia-days';
import * as complaint from '@/modules/wms/agent/complaint';
import * as bigCargo from '@/modules/wms/agent/big-cargo';
import type { AgentContext, ChatMessage } from '@/modules/wms/agent/context';
import * as digits from '@/modules/wms/agent/digits';
import * as kb from '@/modules/wms/agent/kb';
import type { KbHit } from '@/modules/wms/agent/kb';
import * as lessons from '@/modules/wms/agent/lessons';
import * as locale from '@/modules/wms/agent/locale';
import * as loop from '@/modules/wms/agent/loop';
import type { AgentLocale, ScriptName } from '@/modules/wms/agent/locale';
import * as numbers from '@/modules/wms/agent/numbers';
import * as ownerAnswer from '@/modules/wms/agent/owner-answer';
import * as policy from '@/modules/wms/agent/policy';
import type { PolicyInput } from '@/modules/wms/agent/policy';
import * as run from '@/modules/wms/agent/run';
import type { ComposeReply } from '@/modules/wms/agent/run';
import * as seed from '@/modules/wms/agent/seed-kb';
import { SETTING_DEFAULTS, aviaDaysRange } from '@/modules/platform/settings/service';
import type { ToolOutcome } from '@/modules/wms/agent/tools';
import * as worthy from '@/modules/wms/agent/worthy';
import type { ReaderCase, Observed } from './agent-reader-corpus';

/**
 * How each reader of the corpus (agent-reader-corpus.ts) is asked — through the REAL functions a run calls, on the
 * memory a real run stores: `memoryFor`, `checkAgentReply` and `autoVerdict` where the finding was about a run, the
 * reader itself where it is a door's own refusal (the lesson, the ✍️ phone). Everything around the fact under test is
 * set to what goes, so «held» says this reader held it and nothing else did.
 *
 * Imported as namespaces on purpose: the same module measures OLD commits (fix pass 4's `measured`), where a reader
 * may not exist yet — a missing function throws here, and the measure counts the case «n/a», never «goes».
 */

const msg = (body: string, n: number): ChatMessage => ({
  ref: `#${n}`,
  id: `00000000-0000-4000-8000-${String(n).padStart(12, '0')}`,
  tgMessageId: BigInt(n),
  direction: 'in',
  media: null,
  fileName: null,
  sentAt: new Date('2026-11-11T06:00:00Z'),
  autoSent: false,
  editedAt: null,
  body,
});

/** The customer's lines as a run loads them: every line his burst. */
function ctxOf(lines: readonly string[], storedLocale: AgentLocale | null = null): AgentContext {
  const messages = lines.map((b, i) => msg(b, i + 1));
  const script = locale.dominantScript(lines.join('\n')) as ScriptName;
  return {
    managerUserId: 'u',
    peerId: 1n,
    messages,
    history: messages,
    anchor: messages.at(-1)!,
    burst: messages,
    lastOut: null,
    lastQuote: null,
    identity: { clientId: null, leadId: 'l', strength: 'lead', codes: [], customerName: null, managerName: null, cargoAllowed: false },
    storedLocale,
    customerScript: script,
    measures: [],
    openCalcs: [],
    ruleDecision: null,
  };
}

const compose = (language: AgentLocale, replyText: string, category = 'faq'): ComposeReply => ({
  replyNeeded: true,
  replyText,
  language,
  glossUz: language === 'zh' || language === 'fa' ? 'Salom.' : '',
  category,
  confidence: 0.9,
  needsOwner: false,
  ownerQuestion: '',
  nextStep: 'wait',
  actions: [],
  usedFactIds: [],
  citedMessageRefs: [],
});

const usage = { inputTokens: 0, outputTokens: 0, cacheReadTokens: 0, cacheWriteTokens: 0 };

/**
 * The flight's days a run is told and vouches for (stage 1a P7, `agent_avia_days`): the setting's own default, as
 * production ships it — every loop below carries them the way `runLoop` hands them to `memoryFor`.
 */
const AVIA_DAYS = aviaDaysRange(SETTING_DEFAULTS.agent_avia_days)!;

/** The seeded knowledge as a run's prompt serves it (kb `hitOf`). */
function facts(): KbHit[] {
  const served = (q: string, a: string) => (typeof kb.servedText === 'function' ? kb.servedText(q, a) : a);
  return seed.SEED_FACTS.map((f, i) => ({
    id: `00000000-0000-4000-8000-0000000004${String(i).padStart(2, '0')}`,
    ref: `F${i}`,
    answer: served(f.question, f.answer),
    phones: [...digits.normalizeDigits(f.answer).matchAll(numbers.PHONE_RE)].map((m) => m[0]),
    urls: numbers.urlsIn(digits.normalizeDigits(f.answer)),
  }));
}

function anchors(): PolicyInput['warehouseAddress'] {
  return policy.addressAnchorsOf(
    seed.SEED_FACTS.filter((f) => f.key.startsWith(kb.WAREHOUSE_ADDRESS_SEED)).map((f) => f.answer),
    [seed.GS_REMINDER],
  );
}

/** The customer's lines a reply in each language answers — the first-reply suite's own. */
const LINES: Record<AgentLocale, readonly string[]> = {
  uz: ['Assalomu alaykum', 'yuk bor', 'narxi qancha', 'Xitoydan'],
  uz_cyrl: ['Ассалому алайкум', 'юк бор', 'нархи қанча', 'Хитойдан'],
  ru: ['Здравствуйте', 'есть груз', 'сколько стоит', 'из Китая'],
  en: ['Hello', 'I have cargo', 'how much', 'from China'],
  fa: ['سلام', 'بار دارم', 'قیمت چند است', 'از چین'],
  zh: ['你好', '我有货', '多少钱', '从中国'],
};

const FIVE = ['greeting', 'qualification', 'faq', 'status', 'price'];
const NOON = new Date('2026-11-11T07:00:00Z');

/** Everything the gate reads, set to what goes. */
function eligibleInput(): AutoGateInput {
  return {
    config: { armed: true, categories: [...FIVE], maxChars: 2000, perDay: 1000 },
    agentOn: true,
    draft: {
      kind: 'reply',
      status: 'pending',
      ownText: false,
      blocked: false,
      needsOwner: false,
      warningCodes: [],
      noteCodes: [],
      systemAck: false,
      honestLine: false,
      actionTypes: [],
      category: 'faq',
      language: 'uz',
      body: 'Assalomu alaykum! Qanday yordam bera olaman?',
      confidence: 0.9,
      ledger: [],
      hasEstimate: false,
      estimatesStored: false,
      calcPricesStored: false,
      rail: false,
      // The customer's language, confidently the reply's (fix pass 6: an absent guess holds every reply now).
      customerLocale: { locale: 'uz', confident: true },
      unreadNumeral: false,
    },
    tools: [],
    money: { unnamed: false, moved: false, tariffUnconfirmed: false, foreignDestination: false, ownerPersonal: false, answerStale: false, ownerFigure: false },
    burstMedia: false,
    calc: null,
    calcPrice: null,
    chat: { hasOwner: true, prospect: false, offUntil: null, humanUntil: null, muted: false },
    workAccount: true,
    at: NOON,
    now: NOON,
    loop: false,
    complaint: false,
    nightPrices: 'table',
    pressedToday: 0,
    budgetLeft: null,
    sendingEnabled: null,
    listenerCurrent: null,
  };
}

/** The policy over a reply, on the memory a real run stores (`policyFor`'s mapping). */
function checked(lines: readonly string[], language: AgentLocale, reply: string, outcomes: ToolOutcome[] = []) {
  const mem = run.memoryFor(ctxOf(lines), { compose: compose(language, reply), tools: [], outcomes, usage, aviaDays: AVIA_DAYS }, facts(), 'gsr-t');
  const input: PolicyInput = {
    body: reply,
    language: mem.language,
    customerScript: mem.customerScript,
    // …the flight's days brought to the setting as `policyFor` reads it (stage 1a P7) — the shipped pair, the run's own.
    numberSources: withAviaDaysNow(mem.sources, AVIA_DAYS),
    removeWhole: [],
    ownCodes: mem.ownCodes ?? [],
    bookCodes: new Set(),
    codePrefix: 'GS',
    allowedPhones: mem.allowedPhones,
    allowedUrls: mem.allowedUrls,
    mapUrls: mem.mapUrls,
    askedLocation: mem.askedLocation,
    staffNames: [],
    customerNames: [],
    canary: mem.canary,
    fingerprintPeers: 0,
    urlsToChat7d: 0,
    urlsToday: 0,
    hasEstimate: mem.hasEstimate,
    fromOurWarehouse: mem.fromOurWarehouse === true,
    factNameWords: mem.factNameWords ?? [],
    askedMode: mem.askedMode ?? null,
    hasGloss: true,
    aviaOnly: mem.aviaOnly === true,
    aviaMentioned: mem.aviaMentioned === true,
    quotableHan: mem.quotableHan ?? '',
    warehouseAddress: anchors(),
  };
  return { mem, result: policy.checkAgentReply(input) };
}

/** A reply through the policy and the gate, as the machine's press judges it: held for any reason. */
function pressed(language: AgentLocale, reply: string): Observed {
  return pressedReasons(language, reply).length > 0 ? 'held' : 'goes';
}

/** …and why — the gate's reasons and the policy's blocks, for a case that surprises (`explain`). */
function pressedReasons(language: AgentLocale, reply: string): string[] {
  const lines = LINES[language];
  const { mem, result } = checked(lines, language, reply);
  const input = eligibleInput();
  input.draft.blocked = !result.ok;
  input.draft.warningCodes = result.warnings.map((w) => w.code);
  input.draft.language = language;
  input.draft.body = reply;
  input.draft.ledger = result.ledger.map((l) => ({ kind: l.kind, origin: l.origin ?? null, tool: l.tool ?? null, role: l.role ?? null }));
  input.draft.customerLocale = mem.customerLocale ?? null;
  input.draft.unreadNumeral = typeof autoMoney.numeralUnread === 'function' ? autoMoney.numeralUnread(reply, mem.quotableHan ?? '') : false;
  return [...autoGate.autoVerdict(input).reasons, ...result.blocks.map((b) => `${b.code}${b.detail ? `:${b.detail}` : ''}`)];
}

/**
 * Every wall that holds a reply in a given chat — the gate's reasons, the policy's blocks, and the policy's warnings BY
 * CODE (`warnings:<code>`; the gate's own word «warnings» cannot tell `questions` from `avia_maybe`, and stage 1a lets
 * the first go). The customer-safety corpus's K1 snapshot (agent-customer-safety.test.ts) is taken with it: the
 * corpus's chats are not always `LINES[language]` — a customer who stated his own figures, a run that quoted the
 * flight — so the lines and the tool outcomes come in as arguments. With outcomes that priced, the draft is what a run
 * that priced stores (the estimate kept, the tool called, the label `price`), as `destination` builds its truck quote.
 */
export function wallsOf(
  language: AgentLocale,
  reply: string,
  lines: readonly string[] = LINES[language],
  outcomes: ToolOutcome[] = [],
  toolName = 'avia_estimate',
): string[] {
  const { mem, result } = checked(lines, language, reply, outcomes);
  const input = eligibleInput();
  input.draft.blocked = !result.ok;
  input.draft.warningCodes = result.warnings.map((w) => w.code);
  input.draft.language = language;
  input.draft.body = reply;
  input.draft.ledger = result.ledger.map((l) => ({ kind: l.kind, origin: l.origin ?? null, tool: l.tool ?? null, role: l.role ?? null }));
  input.draft.customerLocale = mem.customerLocale ?? null;
  input.draft.unreadNumeral = typeof autoMoney.numeralUnread === 'function' ? autoMoney.numeralUnread(reply, mem.quotableHan ?? '') : false;
  if (outcomes.some((o) => o.estimate === true)) {
    input.draft.category = 'price';
    input.draft.hasEstimate = mem.hasEstimate;
    input.draft.estimatesStored = true;
    input.tools = [{ name: toolName, ok: true, estimate: true }];
  }
  return [
    ...autoGate.autoVerdict(input).reasons,
    ...result.blocks.map((b) => `${b.code}${b.detail ? `:${b.detail}` : ''}`),
    ...result.warnings.map((w) => `warnings:${w.code}`),
  ];
}

/** The flight the air chat quoted: 30 kg from Shenzhen, 510 $. */
const AIR: ToolOutcome = {
  ok: true,
  text: '',
  estimate: true,
  air: { kg: 30, origin: 'Shenzhen' },
  sources: [
    { value: 510, kind: 'money', label: 'avia (tarif × kg)', origin: 'tool', currency: 'USD', role: 'total' },
    { value: 17, kind: 'money', label: 'avia tarifi', origin: 'tool', currency: 'USD', role: 'rate' },
    { value: 30, kind: 'measure', label: 'mijoz #1', origin: 'tool' },
  ],
};

/** The avia rule (run `withAviaRule`) in a flight's chat that quoted the flight: does the reply ask HIM? */
function aviaAsks(reply: string, priceArmed: boolean): Observed {
  const chat = ctxOf(['Shenzhendan avia 30 kg']);
  const c = run.withAviaRule(compose('uz', reply), { outcomes: [AIR], tools: [] }, chat, { priceArmed });
  return c.needsOwner ? 'held' : 'goes';
}

/** The truck quote the money clause admits (he ticked «Narx»): a priced yo'lkira estimate, its total the one money line. */
function asQuote(input: AutoGateInput): AutoGateInput {
  input.draft.category = 'price';
  input.draft.body = '5 kub, 1000 kg yukingiz uchun Toshkentgacha taxminan 800 $. Boj va QQS alohida hisoblanadi.';
  input.draft.ledger = [{ kind: 'money', origin: 'tool', tool: 'yolkira_estimate', role: 'total' }];
  input.draft.hasEstimate = true;
  input.draft.estimatesStored = true;
  input.tools = [{ name: 'yolkira_estimate', ok: true, estimate: true }];
  return input;
}

/** The truck quote the money clause admits, to a customer who wrote these lines (`memoryFor`'s `foreignDestination`). */
function destination(lines: readonly string[]): Observed {
  const mem = run.memoryFor(ctxOf(lines), { compose: compose('uz', 'x', 'price'), tools: [], outcomes: [], usage, aviaDays: AVIA_DAYS }, [], 'gsr-t');
  const input = asQuote(eligibleInput());
  input.money.foreignDestination = mem.foreignDestination === true;
  return autoGate.autoVerdict(input).reasons.length > 0 ? 'held' : 'goes';
}

/**
 * A later turn (fix pass 7, the check #1/#4): the customer's earlier lines in the chat's window, our reply after them,
 * then this burst. With `remember`, the chat's stored language is what the earlier turn's run REMEMBERED
 * (`localeToRemember`, run.ts — a commit without it counts the case «n/a»); without, the window alone. With `approved`
 * (fix pass 8, the check #1), HE pressed ✅ on that earlier turn's reply in that language: what his ✅ teaches the chat
 * (locale `approvedLocale`) is stored where nothing was — decide's own `coalesce` (a commit without it: «n/a»).
 */
function laterTurn(before: readonly string[], lines: readonly string[], stored: AgentLocale | null): AgentContext {
  const earlier = before.map((b, i) => msg(b, i + 1));
  const ours: ChatMessage = { ...msg('Rahmat!', before.length + 1), direction: 'out' };
  const now = lines.map((b, i) => msg(b, before.length + 2 + i));
  const messages = [...earlier, ours, ...now];
  return { ...ctxOf(lines, stored), messages, history: messages, anchor: now.at(-1)!, burst: now };
}

/**
 * The language clause on the memory a real run stores (`memoryFor`'s `customerLocale`) — on a reply with no money in
 * it (stage 1a: the class `autoClassOf` calls talk), or with `quote`, on a truck quote the money clause admits
 * (`language_money`, J19: a price keeps today's language rule whatever the talk rule becomes).
 */
function language(
  lines: readonly string[],
  stored: AgentLocale | null,
  reply: AgentLocale,
  before?: string,
  remember?: boolean,
  approved?: AgentLocale,
  quote = false,
): Observed {
  let ctx = ctxOf(lines, stored);
  if (before !== undefined) {
    const prior = before.split('\n');
    const earlier = ctxOf(prior, stored);
    let kept = remember ? run.localeToRemember(earlier) : stored;
    if (approved !== undefined) {
      const taught = locale.approvedLocale({ reading: run.customerLocaleOf(earlier), language: approved, ownText: null });
      kept = kept ?? taught;
    }
    ctx = laterTurn(prior, lines, kept);
  }
  const mem = run.memoryFor(ctx, { compose: compose(reply, 'x'), tools: [], outcomes: [], usage, aviaDays: AVIA_DAYS }, [], 'gsr-t');
  const input = quote ? asQuote(eligibleInput()) : eligibleInput();
  input.draft.language = reply;
  if (!quote) input.draft.body = 'x';
  input.draft.customerLocale = mem.customerLocale ?? null;
  return autoGate.autoVerdict(input).reasons.length > 0 ? 'held' : 'goes';
}

/** His ✍️ answer, as the redraft's mark carries it (run `fromAnswer.figures`) and the gate reads it. */
function ownerFigure(answer: string): Observed {
  const input = eligibleInput();
  input.money.ownerFigure = ownerAnswer.answerHoldsFigure(answer);
  return autoGate.autoVerdict(input).reasons.length > 0 ? 'held' : 'goes';
}

/** G1 on a Chinese reply: is it held as a Chinese numeral (his ✅ taken away)? */
function hanCheck(reply: string): Observed {
  const { result } = checked(LINES.zh, 'zh', reply);
  return result.blocks.some((b) => b.code === 'number_unverifiable' && b.detail === 'han_numeral') ? 'held' : 'goes';
}

/** The corpus's whole chats start here; a script's seconds are counted from it (agent-reader-corpus.ts `LOOP_DANGEROUS`). */
const LOOP_T0 = Date.parse('2026-11-20T07:00:00Z');

/**
 * A loop case's script read into the detector's facts, exactly as `loopFactsFor` hands them over: the LAST customer
 * line is the anchor, the ones before it his earlier lines (`>` with no words, and every `@`, came with a file), `<`
 * our sends, the last `~` the one typing stamp kept, the last `!` the moment he was told, and `=` the reply about to
 * go. Judged at the `=` reply's second, else the anchor's. Then the verdict — any signal, or the hold, is «held».
 */
function loopHeld(script: string): Observed {
  const at = (sec: string) => new Date(LOOP_T0 + Number(sec) * 1000);
  const lines: { at: Date; body: string; media: boolean }[] = [];
  const sends: { at: Date; body: string }[] = [];
  let typingAt: Date | null = null;
  let toldAt: Date | null = null;
  let draft: { at: Date; body: string } | null = null;
  for (const row of script.split('\n')) {
    const m = /^([<>~=@!]) (\d+)(?: (.*))?$/u.exec(row);
    if (!m) throw new Error(`a loop script line the eval cannot read: «${row}»`);
    const [, mark, sec, text = ''] = m;
    if (mark === '>') lines.push({ at: at(sec!), body: text, media: text === '' });
    else if (mark === '@') lines.push({ at: at(sec!), body: text, media: true });
    else if (mark === '<') sends.push({ at: at(sec!), body: text });
    else if (mark === '~') typingAt = at(sec!);
    else if (mark === '!') toldAt = at(sec!);
    else draft = { at: at(sec!), body: text };
  }
  const anchor = lines.at(-1) ?? null;
  const now = draft?.at ?? anchor?.at ?? new Date(LOOP_T0);
  const facts = { anchor, inbound: lines.slice(0, -1), sends, typingAt, toldAt, now, draft };
  const verdict = loop.loopVerdict(facts);
  return verdict.signals.length > 0 || verdict.held ? 'held' : 'goes';
}

/** «Botmisiz?» (stage 1a P3, J6): does any line of the customer's burst ask whether we are a bot? */
function botQuestion(lines: readonly string[]): Observed {
  return lines.some((l) => worthy.asksIfBot(l)) ? 'held' : 'goes';
}

/**
 * «Hisoblatishga yubordim» with no calculation sent (J9): the reply as the gate reads it, with no `calc_submit` beside
 * it, the customer's language confidently the reply's — held for any reason (the gate's `calc_claim_unbacked`).
 */
function calcClaim(language: AgentLocale, reply: string): Observed {
  const input = eligibleInput();
  input.draft.language = language;
  input.draft.customerLocale = { locale: language, confident: true };
  input.draft.body = reply;
  return autoGate.autoVerdict(input).reasons.length > 0 ? 'held' : 'goes';
}

/** A Pashto burst (J7), as the run decides it: `draftWorthy` over the customer's lines, text only. */
function pashto(lines: readonly string[]): Observed {
  const w = worthy.draftWorthy(lines.map((text) => ({ text, media: null })), false);
  return !w.worthy && w.reason === 'pashto' ? 'held' : 'goes';
}

/** What the reader under test makes of the case — throws when the reader does not exist at this commit. */
export function observe(c: ReaderCase, mode: 'armed' | 'off' = 'armed'): Observed {
  const reply = (c.context?.reply ?? 'uz') as AgentLocale;
  switch (c.reader) {
    case 'avia':
      return aviaAsks(c.input, mode === 'armed');
    case 'destination':
      return destination(c.input.split('\n'));
    case 'language':
    case 'language_money':
      return language(
        c.input.split('\n'),
        (c.context?.stored ?? null) as AgentLocale | null,
        reply,
        c.context?.before,
        c.context?.remember,
        c.context?.approved as AgentLocale | undefined,
        c.reader === 'language_money',
      );
    case 'owner_figure':
      return ownerFigure(c.input);
    case 'money':
    case 'han':
      return pressed(reply, c.input);
    case 'han_g1':
      return hanCheck(c.input);
    case 'lesson':
      return lessons.lessonShapeRefusal(c.input)?.code === 'money' ? 'held' : 'goes';
    case 'bot_question':
      return botQuestion(c.input.split('\n'));
    case 'pashto':
      return pashto(c.input.split('\n'));
    case 'complaint':
      return complaint.complaintIn(c.input.split('\n')) ? 'held' : 'goes';
    case 'calc_claim':
      return calcClaim(reply, c.input);
    case 'phone':
      return ownerAnswer.answerTextRefusal(c.input)?.what === 'phone' ? 'held' : 'goes';
    case 'loop':
      return loopHeld(c.input);
    case 'avia_days':
      return pressed(reply, c.input);
    case 'full_truck':
      // The customer's lines, one per line of the case — the burst `bigCargoOf` reads (stage 1a §4.5).
      return bigCargo.saysFullTruck(c.input.split('\n')) ? 'held' : 'goes';
  }
}

/** Why a money or Chinese case is held — the gate's reasons, then the policy's blocks. For a person reading a failure. */
export function explain(c: ReaderCase): string[] {
  return pressedReasons((c.context?.reply ?? 'uz') as AgentLocale, c.input);
}
