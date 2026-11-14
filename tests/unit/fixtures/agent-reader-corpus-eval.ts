import * as autoGate from '@/modules/wms/agent/auto-gate';
import type { AutoGateInput } from '@/modules/wms/agent/auto-gate';
import * as autoMoney from '@/modules/wms/agent/auto-money';
import type { AgentContext, ChatMessage } from '@/modules/wms/agent/context';
import * as digits from '@/modules/wms/agent/digits';
import * as kb from '@/modules/wms/agent/kb';
import type { KbHit } from '@/modules/wms/agent/kb';
import * as lessons from '@/modules/wms/agent/lessons';
import * as locale from '@/modules/wms/agent/locale';
import type { AgentLocale, ScriptName } from '@/modules/wms/agent/locale';
import * as numbers from '@/modules/wms/agent/numbers';
import * as ownerAnswer from '@/modules/wms/agent/owner-answer';
import * as policy from '@/modules/wms/agent/policy';
import type { PolicyInput } from '@/modules/wms/agent/policy';
import * as run from '@/modules/wms/agent/run';
import type { ComposeReply } from '@/modules/wms/agent/run';
import * as seed from '@/modules/wms/agent/seed-kb';
import type { ToolOutcome } from '@/modules/wms/agent/tools';
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
    config: { armed: true, categories: [...FIVE], maxChars: 2000, minConfidence: 0.8, perDay: 1000 },
    agentOn: true,
    draft: {
      kind: 'reply',
      status: 'pending',
      ownText: false,
      blocked: false,
      needsOwner: false,
      warnings: 0,
      notes: 0,
      actionTypes: [],
      category: 'faq',
      language: 'uz',
      body: 'Assalomu alaykum! Qanday yordam bera olaman?',
      confidence: 0.9,
      ledger: [],
      hasEstimate: false,
      estimatesStored: false,
      rail: false,
      // The customer's language, confidently the reply's (fix pass 6: an absent guess holds every reply now).
      customerLocale: { locale: 'uz', confident: true },
      unreadNumeral: false,
    },
    tools: [],
    money: { unnamed: false, moved: false, tariffUnconfirmed: false, foreignDestination: false, ownerPersonal: false, answerStale: false, ownerFigure: false },
    burstMedia: false,
    chat: { hasOwner: true, prospect: false, offUntil: null, humanUntil: null, muted: false },
    workAccount: true,
    at: NOON,
    now: NOON,
    streak: 0,
    pressedToday: 0,
    budgetLeft: null,
    sendingEnabled: null,
    listenerCurrent: null,
  };
}

/** The policy over a reply, on the memory a real run stores (`policyFor`'s mapping). */
function checked(lines: readonly string[], language: AgentLocale, reply: string, outcomes: ToolOutcome[] = []) {
  const mem = run.memoryFor(ctxOf(lines), { compose: compose(language, reply), tools: [], outcomes, usage }, facts(), 'gsr-t');
  const input: PolicyInput = {
    body: reply,
    language: mem.language,
    customerScript: mem.customerScript,
    numberSources: mem.sources,
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
  input.draft.warnings = result.warnings.length;
  input.draft.language = language;
  input.draft.body = reply;
  input.draft.ledger = result.ledger.map((l) => ({ kind: l.kind, origin: l.origin ?? null, tool: l.tool ?? null, role: l.role ?? null }));
  input.draft.customerLocale = mem.customerLocale ?? null;
  input.draft.unreadNumeral = typeof autoMoney.numeralUnread === 'function' ? autoMoney.numeralUnread(reply, mem.quotableHan ?? '') : false;
  return [...autoGate.autoVerdict(input).reasons, ...result.blocks.map((b) => `${b.code}${b.detail ? `:${b.detail}` : ''}`)];
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

/** The truck quote the money clause admits, to a customer who wrote these lines (`memoryFor`'s `foreignDestination`). */
function destination(lines: readonly string[]): Observed {
  const mem = run.memoryFor(ctxOf(lines), { compose: compose('uz', 'x', 'price'), tools: [], outcomes: [], usage }, [], 'gsr-t');
  const input = eligibleInput();
  input.draft.category = 'price';
  input.draft.body = '5 kub, 1000 kg yukingiz uchun Toshkentgacha taxminan 800 $. Boj va QQS alohida hisoblanadi.';
  input.draft.ledger = [{ kind: 'money', origin: 'tool', tool: 'yolkira_estimate', role: 'total' }];
  input.draft.hasEstimate = true;
  input.draft.estimatesStored = true;
  input.tools = [{ name: 'yolkira_estimate', ok: true, estimate: true }];
  input.money.foreignDestination = mem.foreignDestination === true;
  return autoGate.autoVerdict(input).reasons.length > 0 ? 'held' : 'goes';
}

/**
 * A later turn (fix pass 7, the check #1/#4): the customer's earlier lines in the chat's window, our reply after them,
 * then this burst. With `remember`, the chat's stored language is what the earlier turn's run REMEMBERED
 * (`localeToRemember`, run.ts — a commit without it counts the case «n/a»); without, the window alone.
 */
function laterTurn(before: readonly string[], lines: readonly string[], stored: AgentLocale | null): AgentContext {
  const earlier = before.map((b, i) => msg(b, i + 1));
  const ours: ChatMessage = { ...msg('Rahmat!', before.length + 1), direction: 'out' };
  const now = lines.map((b, i) => msg(b, before.length + 2 + i));
  const messages = [...earlier, ours, ...now];
  return { ...ctxOf(lines, stored), messages, history: messages, anchor: now.at(-1)!, burst: now };
}

/** The language clause on the memory a real run stores (`memoryFor`'s `customerLocale`). */
function language(lines: readonly string[], stored: AgentLocale | null, reply: AgentLocale, before?: string, remember?: boolean): Observed {
  let ctx = ctxOf(lines, stored);
  if (before !== undefined) {
    const prior = before.split('\n');
    const kept = remember ? run.localeToRemember(ctxOf(prior, stored)) : stored;
    ctx = laterTurn(prior, lines, kept);
  }
  const mem = run.memoryFor(ctx, { compose: compose(reply, 'x'), tools: [], outcomes: [], usage }, [], 'gsr-t');
  const input = eligibleInput();
  input.draft.language = reply;
  input.draft.body = 'x';
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

/** What the reader under test makes of the case — throws when the reader does not exist at this commit. */
export function observe(c: ReaderCase, mode: 'armed' | 'off' = 'armed'): Observed {
  const reply = (c.context?.reply ?? 'uz') as AgentLocale;
  switch (c.reader) {
    case 'avia':
      return aviaAsks(c.input, mode === 'armed');
    case 'destination':
      return destination(c.input.split('\n'));
    case 'language':
      return language(c.input.split('\n'), (c.context?.stored ?? null) as AgentLocale | null, reply, c.context?.before, c.context?.remember);
    case 'owner_figure':
      return ownerFigure(c.input);
    case 'money':
    case 'han':
      return pressed(reply, c.input);
    case 'han_g1':
      return hanCheck(c.input);
    case 'lesson':
      return lessons.lessonShapeRefusal(c.input)?.code === 'money' ? 'held' : 'goes';
    case 'phone':
      return ownerAnswer.answerTextRefusal(c.input)?.what === 'phone' ? 'held' : 'goes';
  }
}

/** Why a money or Chinese case is held — the gate's reasons, then the policy's blocks. For a person reading a failure. */
export function explain(c: ReaderCase): string[] {
  return pressedReasons((c.context?.reply ?? 'uz') as AgentLocale, c.input);
}
