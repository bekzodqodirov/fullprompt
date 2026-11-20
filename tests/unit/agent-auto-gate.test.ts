import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';
import {
  AUTO_LANGUAGES,
  AUTO_REFUSALS,
  AUTO_REFUSAL_WORDS,
  AUTO_SEND_CATEGORIES,
  MONEY_TOOLS,
  autoClassOf,
  autoVerdict,
  type AutoGateInput,
  type AutoRefusal,
} from '@/modules/wms/agent/auto-gate';
import { AUTO_SEND_CATEGORIES as ONE_HOME } from '@/modules/wms/agent/auto-categories';
import { toolCallsOf } from '@/modules/wms/agent/auto-send';
import { AUTO_CATEGORIES, calibrationCells, categoryVerdicts, type CalibrationDraftRow } from '@/modules/wms/agent/calibration';
import { agentStats, type StatsDraftRow } from '@/modules/wms/agent/stats';
import { TOOL_SPECS } from '@/modules/wms/agent/tools';

/**
 * «O'zi yuborish»'s gate (docs/AI-SOTUVCHI.md §18.3, his answer of
 * 2026-11-11). Pure: every refusal is driven from ONE eligible input by one
 * change, the verdict lists EVERY reason in a stable order, and each code has
 * words. Then the counting: a reply the machine pressed is nobody's decision,
 * so it never enters the rate the page prints or the calibration table.
 */

/** 12:00 Tashkent — a working day's noon. */
const NOON = new Date('2026-11-11T07:00:00Z');
/** 23:00 Tashkent — the pump's night (send-step `isTashkentNight`). */
const NIGHT = new Date('2026-11-11T18:00:00Z');

/** The four kinds the layer shipped with — the stored row 0148 leaves as it found it (the price box ships unticked). */
const FOUR = ['greeting', 'qualification', 'faq', 'status'];

function eligible(): AutoGateInput {
  return {
    config: { armed: true, categories: [...FOUR], maxChars: 400, perDay: 30 },
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
      actionTypes: [],
      category: 'greeting',
      language: 'uz',
      body: 'Assalomu alaykum! Qanday yordam bera olaman?',
      confidence: 0.9,
      ledger: [],
      hasEstimate: false,
      estimatesStored: false,
      calcPricesStored: false,
      rail: false,
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
    budgetLeft: 10,
    sendingEnabled: true,
    listenerCurrent: true,
  };
}

const PRICED_BODY = '5 kub, 800 kg yukingiz uchun Toshkentgacha taxminan 960 $. Boj va QQS alohida hisoblanadi.';

/**
 * A truck quote the money clause admits (spec §1.1): he ticked «Narx», the run's one money call is a yo'lkira
 * estimate that answered with a price, the ledger's money line is that tool's total, the estimate is stored, the
 * reply restates the load and says «Toshkentgacha».
 */
function quote(i: AutoGateInput): AutoGateInput {
  i.config.categories = [...FOUR, 'price'];
  i.draft.category = 'price';
  i.draft.body = PRICED_BODY;
  i.draft.ledger = [
    { kind: 'measure', origin: 'customer', tool: null, role: null },
    { kind: 'measure', origin: 'customer', tool: null, role: null },
    { kind: 'money', origin: 'tool', tool: 'yolkira_estimate', role: 'total' },
  ];
  i.draft.hasEstimate = true;
  i.draft.estimatesStored = true;
  i.tools = [{ name: 'yolkira_estimate', ok: true, estimate: true }];
  return i;
}

/**
 * A calculation the machine would land by itself (SPEC-P2-v2 §1.1): «Hisoblatish» ticked, the draft's one act a calc
 * submit, labelled as the model labels a submit reply (`price`) — judged as `calc` whatever the label — and every one
 * of its five facts clear.
 */
function calcSubmit(i: AutoGateInput): AutoGateInput {
  i.config.categories = [...FOUR, 'calc'];
  i.draft.actionTypes = ['calc_submit', 'set_followup'];
  i.draft.category = 'price';
  i.draft.body = 'Hisoblatishga yubordim, javob kelishi bilan aytaman.';
  i.calc = { unproven: false, foreign: false, refused: false, recent: false, fileMissing: false };
  return i;
}

/**
 * A VED answer's price the money clause admits (SPEC-P2-v2 §2.3): «VED narxi» ticked, the run's `calc_price` answered,
 * the ledger's money line is that tool's total, the prices are stored, and its four facts clear.
 */
function calcQuote(i: AutoGateInput): AutoGateInput {
  i.config.categories = [...FOUR, 'calc_price'];
  i.draft.category = 'price';
  i.draft.body = 'VED javobi keldi: rastamojka 1 359 $ bo‘ladi.';
  i.draft.ledger = [{ kind: 'money', origin: 'tool', tool: 'calc_price', role: 'total' }];
  i.draft.calcPricesStored = true;
  i.tools = [{ name: 'calc_price', ok: true, estimate: false }];
  i.calcPrice = { unconfirmed: false, moved: false, foreign: false, media: false, ownerPriced: false, personOffer: false };
  return i;
}

/** The refusals only a VED price can meet. */
const CALC_PRICE_ONLY: ReadonlySet<AutoRefusal> = new Set(['markup_unconfirmed', 'calc_price_moved', 'calc_owner_priced', 'calc_person_offer']);

/** The refusals only a calc draft can meet. */
const CALC_ONLY: ReadonlySet<AutoRefusal> = new Set(['calc_identity', 'calc_foreign', 'calc_refused', 'calc_recent', 'calc_file_missing']);

/** The refusals only a quote the money clause admitted can meet. */
const QUOTE_ONLY: ReadonlySet<AutoRefusal> = new Set([
  'estimate_unnamed',
  'estimate_moved',
  'tariff_unconfirmed',
  'foreign_destination',
  'destination_unsaid',
]);

/** One change per refusal — the eligible input with exactly that one fact turned. */
const ONE_CHANGE: Record<AutoRefusal, (i: AutoGateInput) => void> = {
  not_armed: (i) => (i.config.armed = false),
  agent_off: (i) => (i.agentOn = false),
  not_reply: (i) => (i.draft.kind = 'price'),
  not_pending: (i) => (i.draft.status = 'editing'),
  blocked: (i) => (i.draft.blocked = true),
  needs_owner: (i) => (i.draft.needsOwner = true),
  // One code each that stage 1a keeps a machine stop (never the eye-only `questions` or `late`): the row means the same after P1.
  warnings: (i) => (i.draft.warningCodes = ['avia_maybe']),
  notes: (i) => (i.draft.noteCodes = ['calc_open']),
  actions: (i) => (i.draft.actionTypes = ['calc_submit']),
  calc_identity: (i) => (calcSubmit(i).calc!.unproven = true),
  calc_foreign: (i) => (calcSubmit(i).calc!.foreign = true),
  calc_refused: (i) => (calcSubmit(i).calc!.refused = true),
  calc_recent: (i) => (calcSubmit(i).calc!.recent = true),
  calc_file_missing: (i) => (calcSubmit(i).calc!.fileMissing = true),
  money: (i) => (i.tools = [{ name: 'own_balance', ok: true, estimate: false }]),
  // A currency beside a quantity no reader placed («a few dollars» — vague, so G1 holds nothing) and no money line.
  money_unread: (i) => (i.draft.body = 'Narxi bir necha dollar.'),
  // A Chinese numeral the readers cannot tell from a word (auto-money `numeralUnread`, read by `autoFactsFor`).
  numeral_unread: (i) => (i.draft.unreadNumeral = true),
  estimate_unnamed: (i) => (quote(i).money.unnamed = true),
  estimate_moved: (i) => (quote(i).money.moved = true),
  tariff_unconfirmed: (i) => (quote(i).money.tariffUnconfirmed = true),
  foreign_destination: (i) => (quote(i).money.foreignDestination = true),
  destination_unsaid: (i) => (quote(i).draft.body = '5 kub, 800 kg yukingiz uchun taxminan 960 $. Boj va QQS alohida hisoblanadi.'),
  markup_unconfirmed: (i) => (calcQuote(i).calcPrice!.unconfirmed = true),
  calc_price_moved: (i) => (calcQuote(i).calcPrice!.moved = true),
  // His own 💵 for the job arrived while the machine's price counted down (finding 1): his figure outranks it.
  calc_owner_priced: (i) => (calcQuote(i).calcPrice!.ownerPriced = true),
  // A person's offer became the card's newest word on the quoted job (fix pass 3): a seller's price outranks the machine's.
  calc_person_offer: (i) => (calcQuote(i).calcPrice!.personOffer = true),
  // A day count from HIS ✍️ answer — no money in it, and it still comes back to him.
  owner_figure: (i) => (i.draft.ledger = [{ kind: 'duration', origin: 'owner', tool: null, role: null }]),
  owner_personal: (i) => (i.money.ownerPersonal = true),
  answer_stale: (i) => (i.money.answerStale = true),
  // DELIBERATE EDIT (stage 1a §6.2): the ticked label is gone; a complaint — the model's own label — stays his.
  complaint: (i) => (i.draft.category = 'complaint'),
  status_unbacked: (i) => (i.draft.category = 'status'),
  language: (i) => (i.draft.language = 'en'),
  media: (i) => (i.burstMedia = true),
  too_long: (i) => (i.draft.body = 'x'.repeat(401)),
  stranger: (i) => (i.chat.hasOwner = false),
  prospect: (i) => (i.chat.prospect = true),
  chat_off: (i) => (i.chat.offUntil = new Date(NOON.getTime() + 60_000)),
  // His 🙋 «Suhbat meniki» and a chat the AI was muted in (final check): the chat is not the machine's to answer.
  human_active: (i) => (i.chat.humanUntil = new Date(NOON.getTime() + 60_000)),
  chat_muted: (i) => (i.chat.muted = true),
  not_work_account: (i) => (i.workAccount = false),
  // DELIBERATE EDIT (stage 1a §6.2, his 4 a): the night bars a CLASS by his setting — a table price under «none».
  night: (i) => {
    quote(i).at = NIGHT;
    i.nightPrices = 'none';
  },
  // The reply about to go is word for word one of our last sends here (stage 1a P2, loop `own_repeat`).
  loop: (i) => (i.loop = true),
  daily_cap: (i) => (i.pressedToday = 30),
  // The ✅'s own refusals that are already facts at the scheduling (fix pass A, C8).
  budget_spent: (i) => (i.budgetLeft = 0),
  sending_disabled: (i) => (i.sendingEnabled = false),
  listener_behind: (i) => (i.listenerCurrent = false),
};

describe('the gate', () => {
  it('an ordinary greeting on a work number, by day, armed, goes by itself', () => {
    expect(autoVerdict(eligible())).toEqual({ eligible: true, reasons: [] });
  });

  it('…and so does a truck quote the money clause admits, once he ticked «Narx» (spec §1.1, his Q1 ⭐)', () => {
    expect(autoVerdict(quote(eligible()))).toEqual({ eligible: true, reasons: [] });
  });

  it.each(AUTO_REFUSALS.map((r) => [r] as const))('%s — refused by its own fact, and by nothing else', (code) => {
    const input = eligible();
    ONE_CHANGE[code](input);
    expect(autoVerdict(input)).toEqual({ eligible: false, reasons: [code] });
  });

  it('collects EVERY reason, in the one stable order — never the first alone', () => {
    const input = eligible();
    for (const code of [...AUTO_REFUSALS].reverse()) {
      // The quote's own facts are asked of a quote the money clause admitted — the second input below;
      // status_unbacked, category and the two body-reading refusals are set by hand at the end.
      // The night is set by hand too (stage 1a): its own change makes a quote, which the money refusal here would hide.
      if (QUOTE_ONLY.has(code) || CALC_ONLY.has(code) || CALC_PRICE_ONLY.has(code) || ['complaint', 'status_unbacked', 'money_unread', 'too_long', 'night'].includes(code)) continue;
      ONE_CHANGE[code](input);
    }
    // DELIBERATE EDIT (stage 1a §6.2): the complaint is the burst's own words here (P3's reader, `complaint`) — the
    // label is the status claim; and the draft's act (a calc submit) is a class the night always bars.
    input.draft.category = 'status';
    input.complaint = true;
    input.at = NIGHT;
    input.draft.body = `Narxi bir necha dollar. ${'x'.repeat(400)}`;
    const out = autoVerdict(input);
    expect(out.eligible).toBe(false);
    expect(out.reasons).toEqual(AUTO_REFUSALS.filter((r) => !QUOTE_ONLY.has(r) && !CALC_ONLY.has(r) && !CALC_PRICE_ONLY.has(r)));
    // A calculation's own five, all at once, in the same order (SPEC-P2-v2 §1.1).
    const c = calcSubmit(eligible());
    c.calc = { unproven: true, foreign: true, refused: true, recent: true, fileMissing: true };
    expect(autoVerdict(c).reasons).toEqual(AUTO_REFUSALS.filter((r) => CALC_ONLY.has(r)));
    // The quote's own five, all at once, in the same order.
    const q = quote(eligible());
    q.money.unnamed = true;
    q.money.moved = true;
    q.money.tariffUnconfirmed = true;
    q.money.foreignDestination = true;
    q.draft.body = '5 kub, 800 kg yukingiz uchun taxminan 960 $.';
    expect(autoVerdict(q).reasons).toEqual(AUTO_REFUSALS.filter((r) => QUOTE_ONLY.has(r)));
  });

  it('at the press the three facts the ✅ asks itself are not the gate’s (null): the scheduling alone judges them', () => {
    const input = eligible();
    input.budgetLeft = null;
    input.sendingEnabled = null;
    input.listenerCurrent = null;
    expect(autoVerdict(input)).toEqual({ eligible: true, reasons: [] });
  });

  it('every refusal has words, and no word is a code', () => {
    expect(Object.keys(AUTO_REFUSAL_WORDS).sort()).toEqual([...AUTO_REFUSALS].sort());
    for (const code of AUTO_REFUSALS) {
      expect(AUTO_REFUSAL_WORDS[code].length).toBeGreaterThan(5);
      expect(AUTO_REFUSAL_WORDS[code]).not.toMatch(/^[a-z_]+$/u);
    }
  });

  it('the new refusals say the spec’s own words (SPEC-P1-v2 §1.1)', () => {
    expect(AUTO_REFUSAL_WORDS.money_unread).toBe('javobda pul so‘zi bor, lekin raqami o‘qilmadi');
    expect(AUTO_REFUSAL_WORDS.estimate_unnamed).toBe('narx qaysi yuk uchunligi (kub, kg) aytilmagan');
    expect(AUTO_REFUSAL_WORDS.estimate_moved).toBe('narx jadvali o‘zgargan — narx qayta tekshirilmagan');
    expect(AUTO_REFUSAL_WORDS.tariff_unconfirmed).toBe('Xitoy tarifi o‘zgargan — birinchi narxni o‘zingiz tasdiqlang');
    expect(AUTO_REFUSAL_WORDS.foreign_destination).toBe('mijoz Toshkentdan boshqa shaharni aytgan');
    expect(AUTO_REFUSAL_WORDS.destination_unsaid).toBe('javobda «Toshkentgacha» deyilmagan');
    expect(AUTO_REFUSAL_WORDS.owner_figure).toBe('javobda sizning raqamingiz bor — ko‘rib yuboring');
    expect(AUTO_REFUSAL_WORDS.owner_personal).toBe('javobingizda boshqa mijoz ma’lumoti bor — ko‘rib yuboring');
    expect(AUTO_REFUSAL_WORDS.answer_stale).toBe('savolingizdan keyin mijoz yana yozdi');
    expect(AUTO_REFUSAL_WORDS.language).toBe('mijoz tili aniq emas yoki javob boshqa tilda');
  });

  it('a 🙋 that has run out is no refusal — the chat is the layer’s again; one still running refuses at any press', () => {
    const input = eligible();
    input.chat.humanUntil = new Date(NOON.getTime() - 60_000);
    expect(autoVerdict(input)).toEqual({ eligible: true, reasons: [] });
    input.chat.humanUntil = new Date(NOON.getTime() + 23 * 3_600_000);
    expect(autoVerdict(input).reasons).toEqual(['human_active']);
  });

  it('his own words on the card are never the machine’s to send — a pending draft he wrote for is not pending for auto', () => {
    const input = eligible();
    input.draft.ownText = true;
    expect(autoVerdict(input).reasons).toEqual(['not_pending']);
  });

  it('the money tools are tools the agent really has, and the ones that are not money stay out', () => {
    const names = TOOL_SPECS.map((t) => t.name);
    for (const t of MONEY_TOOLS) expect(names).toContain(t);
    for (const name of ['cargo_status', 'kb_search', 'cargo_volume', 'calc_checklist']) {
      const input = eligible();
      input.tools = [{ name, ok: true, estimate: false }];
      expect(autoVerdict(input).eligible, name).toBe(true);
    }
  });

  it('«status» goes only when the cargo was READ — and read ok', () => {
    const input = eligible();
    input.draft.category = 'status';
    input.tools = [{ name: 'cargo_status', ok: false, estimate: false }];
    expect(autoVerdict(input).reasons).toEqual(['status_unbacked']);
    input.tools = [{ name: 'cargo_status', ok: true, estimate: false }];
    expect(autoVerdict(input)).toEqual({ eligible: true, reasons: [] });
  });

  it('the label is free since stage 1a (§4.2: the ticked label goes) — only «complaint» stays his, however the reply reads', () => {
    // DELIBERATE EDIT: before 1a a label outside the ticked kinds was `category`; what a reply DOES decides now.
    expect(autoVerdict(Object.assign(eligible(), { draft: { ...eligible().draft, category: 'complaint' } })).reasons).toEqual(['complaint']);
    for (const category of ['other', null, 'price', 'greeting', 'calc', 'calc_price']) {
      const input = eligible();
      input.draft.category = category;
      expect(autoVerdict(input), String(category)).toEqual({ eligible: true, reasons: [] });
    }
    // The four ordinary kinds are no longer read: none of them ticked, a greeting still goes.
    const unticked = eligible();
    unticked.config.categories = ['price'];
    expect(autoVerdict(unticked)).toEqual({ eligible: true, reasons: [] });
    // …and the burst's own complaint (P3's reader) stays his whatever the label says.
    const words = eligible();
    words.complaint = true;
    expect(autoVerdict(words).reasons).toEqual(['complaint']);
  });

  it('a label naming «calc» or «calc_price» with nothing behind it is talk — the kinds of those two are decided by the act and the tool', () => {
    for (const category of ['calc', 'calc_price']) {
      const input = eligible();
      input.draft.category = category;
      input.config.categories = [...AUTO_SEND_CATEGORIES];
      expect(autoClassOf(input), category).toBe('talk');
      expect(autoVerdict(input).eligible, category).toBe(true);
    }
  });

  it('the kinds have ONE home: the gate re-exports the pure module the page reads, and the LAST CHECK re-maker (0149) says the same seven', () => {
    expect(AUTO_SEND_CATEGORIES).toBe(ONE_HOME);
    expect([...AUTO_SEND_CATEGORIES]).toEqual(['greeting', 'qualification', 'faq', 'status', 'price', 'calc', 'calc_price']);
    const sql = readFileSync('src/modules/platform/db/migrations/0149_agent_full_p2.sql', 'utf8');
    const check = /"categories" <@ ARRAY\[([^\]]+)\]::text\[\]/u.exec(sql)?.[1];
    expect(check?.split(',').map((x) => x.trim().replace(/'/gu, ''))).toEqual([...AUTO_SEND_CATEGORIES]);
    // The page's file names the one home and never the gate (it would pull the send step into the browser).
    const ui = readFileSync('src/app/(protected)/suhbatlar/ai/agent-ui.tsx', 'utf8');
    expect(ui).toMatch(/from '@\/modules\/wms\/agent\/auto-categories'/u);
    expect(ui).not.toMatch(/agent\/auto-gate'/u);
    expect(ui).not.toMatch(/\['greeting', 'qualification', 'faq', 'status'/u);
  });

  it('a follow-up date is the one action that may ride along', () => {
    const input = eligible();
    input.draft.actionTypes = ['set_followup'];
    expect(autoVerdict(input).eligible).toBe(true);
    input.draft.actionTypes = ['set_followup', 'mute'];
    expect(autoVerdict(input).reasons).toEqual(['actions']);
  });

  it('the boundaries: 400 characters go, a chat off until now is on again, the day’s last press goes — and the model’s rating decides nothing (stage 1a)', () => {
    const at = eligible();
    at.draft.body = 'x'.repeat(400);
    expect(autoVerdict(at).eligible).toBe(true);
    // DELIBERATE EDIT (stage 1a §6.2): the model's own rating left the gate — a low one and a missing one go.
    for (const confidence of [0.3, 0, null]) {
      const low = eligible();
      low.draft.confidence = confidence;
      expect(autoVerdict(low), String(confidence)).toEqual({ eligible: true, reasons: [] });
    }
    const off = eligible();
    off.chat.offUntil = NOON;
    expect(autoVerdict(off).eligible).toBe(true);
    const day = eligible();
    day.pressedToday = 29;
    expect(autoVerdict(day).eligible).toBe(true);
  });

  it('no daily count (0148, his «7 chegara qoyma»): perDay null refuses nothing, however many went today', () => {
    const input = eligible();
    input.config.perDay = null;
    input.pressedToday = 10_000;
    expect(autoVerdict(input)).toEqual({ eligible: true, reasons: [] });
    // …while a number he typed still caps.
    input.config.perDay = 10_000;
    expect(autoVerdict(input).reasons).toEqual(['daily_cap']);
  });

  it('the night is the pump’s own: 22:00-08:00 Tashkent, judged at the moment the reply would go — of a class it bars', () => {
    // DELIBERATE EDIT (stage 1a §6.2): asked of a price his setting bars (`none`); talk is never barred (below).
    const at = (iso: string) => {
      const input = quote(eligible());
      input.nightPrices = 'none';
      input.at = new Date(iso);
      return autoVerdict(input).reasons;
    };
    expect(at('2026-11-11T16:59:00Z')).toEqual([]); // 21:59
    expect(at('2026-11-11T17:00:00Z')).toEqual(['night']); // 22:00
    expect(at('2026-11-12T02:59:00Z')).toEqual(['night']); // 07:59
    expect(at('2026-11-12T03:00:00Z')).toEqual([]); // 08:00
  });

  it('…and at the moment its card is queued: a reply written in the night’s last hold would go at 08:00, but its card arrives silently — refused «night» (the second check)', () => {
    const queued = (now: string, at: string) => {
      const input = calcSubmit(eligible());
      input.now = new Date(now);
      input.at = new Date(at);
      return autoVerdict(input).reasons;
    };
    expect(queued('2026-11-12T02:58:40Z', '2026-11-12T03:00:40Z')).toEqual(['night']); // 07:58:40 → 08:00:40
    expect(queued('2026-11-12T02:51:00Z', '2026-11-12T03:01:00Z')).toEqual(['night']); // a ten-minute hold
    expect(queued('2026-11-12T03:00:00Z', '2026-11-12T03:02:00Z')).toEqual([]); // 08:00 — the card rings
  });
});

describe('the money clause by OUTCOME (spec SPEC-P1-v2 §1.1, §1.4)', () => {
  const money = (patch: (i: AutoGateInput) => void) => {
    const i = quote(eligible());
    patch(i);
    return autoVerdict(i).reasons;
  };

  it('the estimate that answered with a price goes — the truck’s and the flight’s', () => {
    expect(money(() => undefined)).toEqual([]);
    expect(
      money((i) => {
        i.tools = [{ name: 'avia_estimate', ok: true, estimate: true }];
        i.draft.body = '30 kg yukingiz uchun Toshkentgacha taxminan 510 $. Boj va QQS alohida.';
        i.draft.ledger = [{ kind: 'money', origin: 'tool', tool: 'avia_estimate', role: 'total' }];
      }),
    ).toEqual([]);
    // Its rate as well as its total: «160 $/kub» is the tool's rate line.
    expect(money((i) => (i.draft.ledger = [...i.draft.ledger, { kind: 'money', origin: 'tool', tool: 'yolkira_estimate', role: 'rate' }]))).toEqual([]);
  });

  it('below the minimum (no price at all) is an ordinary reply — whether or not he ticked «Narx» (§1.4)', () => {
    for (const name of ['yolkira_estimate', 'avia_estimate']) {
      const input = eligible();
      input.draft.category = 'qualification';
      input.tools = [{ name, ok: true, estimate: false }];
      expect(autoVerdict(input), name).toEqual({ eligible: true, reasons: [] });
    }
  });

  it('a REFUSED estimate is money: the model’s price after it is nobody’s (MAP risk)', () => {
    for (const name of ['yolkira_estimate', 'avia_estimate']) {
      expect(money((i) => (i.tools = [...i.tools, { name, ok: false, estimate: false }])), name).toEqual(['money']);
      // …and with nothing priced at all.
      const input = eligible();
      input.config.categories = [...FOUR, 'price'];
      input.tools = [{ name, ok: false, estimate: false }];
      expect(autoVerdict(input).reasons, name).toEqual(['money']);
    }
  });

  it('own_balance is money whatever it answered — the customer’s debt stays his (⭐ MAP Q2)', () => {
    for (const ok of [true, false]) {
      expect(money((i) => (i.tools = [...i.tools, { name: 'own_balance', ok, estimate: false }])), String(ok)).toEqual(['money']);
    }
  });

  it('every money line must be an estimate tool’s total or rate: a balance, a fact, his answer, a line before 0148 — each refuses', () => {
    const line = (l: AutoGateInput['draft']['ledger'][number]) => money((i) => (i.draft.ledger = [...i.draft.ledger, l]));
    // A balance line (own_balance's) — its role and its tool are not an estimate's.
    expect(line({ kind: 'money', origin: 'tool', tool: 'own_balance', role: 'balance' })).toEqual(['money']);
    // A kb line (a fact's money never vouches, but a stored line that names kb is no tool's).
    expect(line({ kind: 'money', origin: 'kb', tool: null, role: 'total' })).toEqual(['money']);
    // His answer's figure (§2.2): never money that goes by itself — and it comes back to him besides.
    expect(line({ kind: 'money', origin: 'owner', tool: null, role: 'total' })).toEqual(['money', 'owner_figure']);
    // A line stored before 0148 names nobody.
    expect(line({ kind: 'money', origin: null, tool: null, role: null })).toEqual(['money']);
    // A line nothing vouched for (G1 blocks it too).
    expect(line({ kind: 'money', origin: null, tool: null, role: null })).toEqual(['money']);
    // The estimate's own tool, but read as a balance.
    expect(line({ kind: 'money', origin: 'tool', tool: 'yolkira_estimate', role: 'balance' })).toEqual(['money']);
  });

  it('the price act is HIS box: unticked, a quote is money; and the label never stands in for the box', () => {
    // DELIBERATE EDIT (stage 1a): the label refusal is gone — the price box alone keeps an unticked quote his.
    expect(money((i) => (i.config.categories = [...FOUR]))).toEqual(['money']);
    // Labelled «faq» by the model, the quote is still judged as price once the clause admits it.
    expect(money((i) => (i.draft.category = 'faq'))).toEqual([]);
    expect(
      money((i) => {
        i.draft.category = 'faq';
        i.config.categories = [...FOUR];
      }),
    ).toEqual(['money']);
  });

  it('a draft with an estimate and none stored (written before 0148) is refused — the press could not re-price it (§1.3)', () => {
    expect(money((i) => (i.draft.estimatesStored = false))).toEqual(['money']);
    // The tool's priced call alone is enough to ask for them, with no memory flag.
    expect(
      money((i) => {
        i.draft.hasEstimate = false;
        i.draft.estimatesStored = false;
      }),
    ).toEqual(['money']);
  });

  it('a call stored with NO estimate flag reads as a priced estimate — failing closed (`toolCallsOf`)', () => {
    const old = toolCallsOf([{ name: 'yolkira_estimate', ok: true, text: 'below_minimum: …' }]);
    expect(old).toEqual([{ name: 'yolkira_estimate', ok: true, estimate: true }]);
    // Such a draft carries no stored estimates: refused — and, read as priced, its reply quotes no figure of it.
    const input = eligible();
    input.config.categories = [...FOUR, 'price'];
    input.tools = old;
    expect(autoVerdict(input).reasons).toEqual(['money', 'money_unread']);
    // The flag as stored is read as stored — never from the text.
    expect(toolCallsOf([{ name: 'yolkira_estimate', ok: true, text: 'Taxminiy …', estimate: false }])[0]!.estimate).toBe(false);
    expect(toolCallsOf([{ name: 'avia_estimate', ok: true, text: 'below_minimum: …', estimate: true }])[0]!.estimate).toBe(true);
  });

  it('a rail chat’s price is his (§18.5): even an admitted quote is refused', () => {
    expect(money((i) => (i.draft.rail = true))).toEqual(['money']);
  });

  it('a currency named with no money line read is `money_unread` — the Persian «نهصد دلار» the readers could not see (§1.1)', () => {
    for (const body of ['هزینه حمل تقریباً نهصد دلار است', 'Air freight is about nine hundred dollars.', 'Narxi taxminan to‘qqiz yuz dollar.', '运费大约九百美元']) {
      const input = eligible();
      input.draft.body = body;
      expect(autoVerdict(input).reasons, body).toContain('money_unread');
    }
    // Bags and sums are no currency: «sumka», «summa».
    for (const body of ['Sumkalar uchun kub va kg ni yozing.', 'Umumiy summani hisoblab aytamiz.']) {
      const input = eligible();
      input.draft.body = body;
      expect(autoVerdict(input).reasons, body).toEqual([]);
    }
    // A quote whose currency IS a money line is no `money_unread`.
    expect(money(() => undefined)).toEqual([]);
  });

  it('…and the currency WORD alone is no price (0148 fix): the seeded payment answer and «narx dollarda» go by themselves, as at main', () => {
    // The review's regress finding: line 290 fired on `namesCurrency(body)` alone, so every one of these — figure-free,
    // no tool call, the first the seeded fact payment@1's own sentence — waited for his ✅ under «raqami o‘qilmadi».
    for (const body of [
      'Toʻlov yuk Toshkentga yetib kelganda, olishdan oldin soʻmda qilinadi; narx dollarda kelishiladi.',
      'To‘lov so‘mda qilinadi, narx dollarda kelishiladi.',
      'Оплата — в сумах по прибытии груза; цена согласуется в долларах.',
      'Narxni dollarda aytaman. Uch omborimizdan qaysi biriga yetkazasiz?',
      "To'lov so'mda yoki dollarda bo'ladi. Uch omborimizdan qaysi biri yaqin?",
      "Ikki yo'l bor: avia va avto, narxi dollarda.",
      'Есть два варианта: авто и авиа. Цена в долларах.',
      'Hi! Prices are in US dollars. Which of our three warehouses will your supplier deliver to?',
      'قیمت به دلار محاسبه می‌شود.',
      'Narxni kubiga dollarda aytaman. Yukingiz necha kub?',
      'Цена в долларах, оплата по прибытии.',
      'We quote in US dollars, per kilo for air and per cube for the truck.',
      // Fix pass 4: the currency OF a price per a unit states no amount («в долларах за куб», «in dollars per kg»), and a
      // Chinese sentence naming its currency with no amount is the same sentence in Chinese — pass 3 held every one.
      'Здравствуйте! Цены указаны в долларах за куб. Напишите объём и вес груза?',
      'Hello! Our rates are in dollars per kg for air. What is the weight?',
      '价格以美元计算，请告诉我货物的体积和重量。',
      '您好！运费在货物到达塔什干后、取货前以苏姆支付；价格以美元商定。',
      '我们收美元和人民币。',
    ]) {
      const input = eligible();
      input.draft.category = 'faq';
      input.draft.body = body;
      expect(autoVerdict(input).reasons, body).toEqual([]);
    }
    // …while a quantity beside the currency that no reader placed is still a price nobody read: spelled out with an
    // ending, a plural, a million, the vague «a few», a Chinese numeral, «one» — in the currency's OWN sentence.
    for (const body of [
      'Narxi yuzlab dollar.',
      'Narxi bir necha dollar.',
      'Примерно пару сотен долларов.',
      'Несколько долларов за кило.',
      'Штука баксов за всё.',
      'It will cost hundreds of dollars.',
      'A few dollars per kilo.',
      'هزینه حمل یک میلیون تومان است',
      'چند دلار برای هر کیلو.',
      '运费九百美元',
      '大概几美元一公斤。',
      'Kilosiga bir dollar.',
      // Fix pass 3 held every CHINESE sentence naming a currency; fix pass 4 narrows it to an amount beside the currency
      // — a run of numerals («兩萬美元», «一欧元») or an amount in characters that holds none: the half, the vague, the
      // approximators, a per-unit word right before it.
      '到塔什干的運費大概兩萬美元，不含關稅和增值稅。',
      '每公斤一欧元。',
      '每公斤半美元。',
      '每公斤美元出头。',
      '每公斤美元左右。',
      '每公斤若干美元。',
      '每公斤一些美元。',
      '运费多少美元都可以商量。',
      // …and a currency that IS its own amount (the check's nit): the article, the distributive «-dan», the half, the
      // slang noun, the per-unit right after it — no numeral at all, and a price all the same.
      'Hello! It is about a dollar per kilo.',
      'It is a dollar a kilo.',
      'Roughly a buck per kilo.',
      'Assalomu alaykum! Kilosi taxminan dollardan tushadi.',
      'Kilosi dollar-dollar yarim atrofida.',
      'Kilosiga dollar yarimdan.',
      'Здравствуйте! Выйдет примерно доллар за кило.',
      'Выйдет доллар с половиной за кило.',
      'Выйдет полтинник долларов.',
      'Выйдет стольник баксов.',
      'کیلویی حدود یه دلار.',
    ]) {
      const input = eligible();
      input.draft.body = body;
      expect(autoVerdict(input).reasons, body).toContain('money_unread');
    }
    // A numeral in ANOTHER sentence than the currency's is not its amount.
    const apart = eligible();
    apart.draft.body = 'Narxni dollarda aytaman. Ikki xil yo‘l bor.';
    expect(autoVerdict(apart).reasons).toEqual([]);
  });

  it('a PRICED run whose reply holds no figure of its estimate is `money_unread` — the price was not said, or nothing could read it (0148 fix)', () => {
    // The review's (b): the tool said 800 $, the reply «到塔什干的运费大概六百左右» — an EMPTY ledger; every clause
    // of the money split passed on the empty list, «到塔什干» satisfied the destination, and it was pressed.
    expect(money((i) => (i.draft.ledger = []))).toEqual(['money_unread']);
    // Measures alone are no quote either.
    expect(money((i) => (i.draft.ledger = i.draft.ledger.filter((l) => l.kind !== 'money')))).toEqual(['money_unread']);
    // The flag alone (`memory.hasEstimate`) asks it, and so does the priced call alone.
    expect(
      money((i) => {
        i.draft.ledger = [];
        i.tools = [];
      }),
    ).toEqual(['money_unread']);
    // Below the minimum nothing was priced: no figure is owed.
    const below = eligible();
    below.config.categories = [...FOUR, 'price'];
    below.draft.category = 'qualification';
    below.tools = [{ name: 'yolkira_estimate', ok: true, estimate: false }];
    expect(autoVerdict(below).reasons).toEqual([]);
  });

  it('a numeral no reader reads reliably refuses on its own — whatever else the reply is (0148 fix, `numeral_unread`)', () => {
    const plain = eligible();
    plain.draft.unreadNumeral = true;
    expect(autoVerdict(plain).reasons).toEqual(['numeral_unread']);
    expect(money((i) => (i.draft.unreadNumeral = true))).toEqual(['numeral_unread']);
    expect(AUTO_REFUSAL_WORDS.numeral_unread).toBe('javobda ieroglif bilan yozilgan son bo‘lishi mumkin — uni o‘qib bo‘lmadi');
  });

  it('his answer’s figure comes back to him whoever the ledger says vouched (0148 fix, `owner_figure` asked of the ANSWER)', () => {
    // The customer wrote «300 kg», he answered «300 kg dan kam yukni olmaymiz»: the reply's 300 is the CUSTOMER's
    // in the ledger (`sourceFor` names the first source that fits) — and was pressed.
    const input = eligible();
    input.draft.ledger = [{ kind: 'measure', origin: 'customer', tool: null, role: null }];
    expect(autoVerdict(input).reasons).toEqual([]);
    input.money.ownerFigure = true;
    expect(autoVerdict(input).reasons).toEqual(['owner_figure']);
    // …and a redraft quoting the TOOL's 800 $ where he said 700 $ carries no line of his at all.
    expect(money((i) => (i.money.ownerFigure = true))).toEqual(['owner_figure']);
    // A figure-free answer still goes.
    expect(money((i) => (i.money.ownerFigure = false))).toEqual([]);
  });

  it('an admitted quote never launders a complaint: «complaint» stays his, a status claim is still asked for its reading (0148 fix)', () => {
    // Before 0148 any money refused, so these never went; with «Narx» ticked the override judged every admitted
    // quote as `price` — and «Sizlar bilan sudlashaman … yo‘lkira qancha?» answered with the estimate was pressed.
    // DELIBERATE EDIT (stage 1a §6.2): the complaint is its own refusal now, and «other» / no label is free.
    expect(money((i) => (i.draft.category = 'complaint'))).toEqual(['complaint']);
    for (const label of ['other', null]) {
      expect(money((i) => (i.draft.category = label)), String(label)).toEqual([]);
    }
    // The kinds that go by themselves are judged as `price` once the clause admits the money, as before.
    for (const label of ['greeting', 'qualification', 'faq', 'price']) {
      expect(money((i) => (i.draft.category = label)), label).toEqual([]);
    }
    // «status»: the quote is admitted, the label is still the model's claim that it READ the cargo.
    expect(money((i) => (i.draft.category = 'status'))).toEqual(['status_unbacked']);
    expect(
      money((i) => {
        i.draft.category = 'status';
        i.tools = [...i.tools, { name: 'cargo_status', ok: true, estimate: false }];
      }),
    ).toEqual([]);
  });

  it('the quote’s own facts are asked only of a quote the clause admitted — a refused one is `money` alone', () => {
    const refused = (patch: (i: AutoGateInput) => void) =>
      money((i) => {
        i.tools = [...i.tools, { name: 'own_balance', ok: true, estimate: false }];
        patch(i);
      });
    expect(refused((i) => (i.money.unnamed = true))).toEqual(['money']);
    expect(refused((i) => (i.money.moved = true))).toEqual(['money']);
    expect(refused((i) => (i.money.tariffUnconfirmed = true))).toEqual(['money']);
    expect(refused((i) => (i.money.foreignDestination = true))).toEqual(['money']);
    expect(refused((i) => (i.draft.body = 'Taxminan 960 $.'))).toEqual(['money']);
  });

  it('«Toshkentgacha» in any of the six languages satisfies the destination (§1.8)', () => {
    for (const body of [
      '5 kub, 800 kg uchun Toshkentgacha taxminan 960 $',
      '5 куб, 800 кг — до Ташкента примерно 960 $',
      '5 куб, 800 кг учун Тошкентгача тахминан 960 $',
      'About $960 to Tashkent for 5 cbm, 800 kg',
      '5立方、800公斤运到塔什干大约960美元',
      '۵ متر مکعب، ۸۰۰ کیلو تا تاشکند حدود ۹۶۰ دلار',
    ]) {
      expect(
        money((i) => (i.draft.body = body)),
        body,
      ).toEqual([]);
    }
    expect(money((i) => (i.draft.body = '5 kub, 800 kg uchun Andijongacha taxminan 960 $'))).toEqual(['destination_unsaid']);
  });
});

describe('six languages (spec §4): the customer’s, never the model’s label', () => {
  const lang = (language: string | null, guess: AutoGateInput['draft']['customerLocale']) => {
    const input = eligible();
    input.draft.language = language;
    input.draft.customerLocale = guess;
    return autoVerdict(input).reasons;
  };

  it('each of the six goes when the customer confidently wrote it', () => {
    expect([...AUTO_LANGUAGES].sort()).toEqual(['en', 'fa', 'ru', 'uz', 'uz_cyrl', 'zh']);
    for (const l of AUTO_LANGUAGES) expect(lang(l, { locale: l, confident: true }), l).toEqual([]);
  });

  it('English, Persian and Chinese go ONLY on a confident guess of that very language', () => {
    for (const l of ['en', 'fa', 'zh']) {
      expect(lang(l, null), `${l} no guess`).toEqual(['language']);
      expect(lang(l, { locale: l, confident: false }), `${l} unconfident`).toEqual(['language']);
      expect(lang(l, { locale: 'uz', confident: true }), `${l} on uz`).toEqual(['language']);
    }
    // An Uzbek Latin customer and an English reply: G5 sees two Latin scripts and lets it through; the gate does not.
    expect(lang('en', { locale: 'uz', confident: true })).toEqual(['language']);
  });

  it('Uzbek and Russian go on a confident guess of that very language, or an unconfident one that LEANS on it', () => {
    // Fix pass 6 (the hunt #3) — corrected expectation: «today's rule» let an unconfident (or absent) guess pass every
    // uz / uz_cyrl / ru reply, and «Иудан Тошкентгача неча пул?» (an unconfident «ru») took a Russian reply by itself.
    // Where the rule cannot tell, it holds; a lean admits its own language only.
    for (const l of ['uz', 'uz_cyrl', 'ru']) {
      expect(lang(l, null), `${l} no guess`).toEqual(['language']);
      expect(lang(l, { locale: null, confident: false }), `${l} names no language`).toEqual(['language']);
      expect(lang(l, { locale: 'en', confident: false }), `${l} unconfident, other`).toEqual(['language']);
      expect(lang(l, { locale: l, confident: false }), `${l} unconfident, no lean`).toEqual(['language']);
      expect(lang(l, { locale: l, confident: false, leans: true }), `${l} leans on it`).toEqual([]);
      expect(lang(l, { locale: l, confident: true }), `${l} confident`).toEqual([]);
    }
    expect(lang('ru', { locale: 'uz_cyrl', confident: false, leans: true })).toEqual(['language']);
    // An Uzbek Cyrillic customer and a Russian reply: one script, refused on the confident guess.
    expect(lang('ru', { locale: 'uz_cyrl', confident: true })).toEqual(['language']);
    expect(lang('uz', { locale: 'en', confident: true })).toEqual(['language']);
    expect(lang('uz_cyrl', { locale: 'ru', confident: true })).toEqual(['language']);
  });

  it('a draft with no language is refused, as it always was', () => {
    expect(lang(null, { locale: 'uz', confident: true })).toEqual(['language']);
  });
});

describe('a reply the machine pressed is nobody’s decision — the gate never grades itself', () => {
  const stats = (over: Partial<StatsDraftRow>): StatsDraftRow => ({
    status: 'approved',
    kind: 'reply',
    edited: false,
    outboxStatus: 'sent',
    category: 'greeting',
    autoSent: false,
    ownerTriggered: false,
    ...over,
  });

  it('agentStats counts auto sends APART: never sentUnchanged, never decided, never the rate', () => {
    const s = agentStats([stats({}), stats({ status: 'rejected', outboxStatus: null }), stats({ autoSent: true }), stats({ autoSent: true })]);
    expect(s.autoSent).toBe(2);
    expect(s.sentUnchanged).toBe(1);
    expect(s.decided).toBe(2);
    expect(s.rate).toBe(0.5);
    expect(s.byCategory.greeting!.decided).toBe(2);
    expect(s.onTheWay + s.approvedNotSent).toBe(0);
  });

  it('…whatever the auto send became — on its way, failed — it is still the machine’s', () => {
    const s = agentStats([stats({ autoSent: true, outboxStatus: 'agent' }), stats({ autoSent: true, outboxStatus: 'failed' })]);
    expect(s.autoSent).toBe(2);
    expect(s.onTheWay).toBe(0);
    expect(s.approvedNotSent).toBe(0);
  });

  it('the calibration table and its verdicts leave the machine’s own presses out', () => {
    const row = (over: Partial<CalibrationDraftRow>): CalibrationDraftRow => ({
      ...stats({}),
      confidence: 0.9,
      blocked: false,
      needsOwner: false,
      warnings: 0,
      notes: 0,
      money: false,
      actions: [],
      ...over,
    });
    const rows = [row({}), ...Array.from({ length: 60 }, () => row({ autoSent: true }))];
    const cells = calibrationCells(rows);
    expect(cells.reduce((n, c) => n + c.decided, 0)).toBe(1);
    const greeting = categoryVerdicts(rows).find((v) => v.category === 'greeting')!;
    expect(greeting.decided).toBe(1);
    expect(greeting.proven).toBe(false);
    // The MEASURED four (calibration.ts): price is gated by the money clause, never measured as clean (0148) — and
    // so are the calculation and the VED price (0149, SPEC-P2-v2 §1.1): gated by what the reply does, not measured.
    expect([...AUTO_CATEGORIES, 'price', 'calc', 'calc_price'].sort()).toEqual([...AUTO_SEND_CATEGORIES].sort());
  });
});

describe('a calculation the machine lands by itself (SPEC-P2-v2 §1.1)', () => {
  it('a calc submit with every fact clear, «Hisoblatish» ticked, goes by itself', () => {
    expect(autoVerdict(calcSubmit(eligible()))).toEqual({ eligible: true, reasons: [] });
  });

  it('is judged as `calc` by its ACTION, whatever kind of reply the model labelled it — never as the label', () => {
    // (`status` is asked its own cargo reading beside — `status_unbacked` — whatever the act.)
    for (const label of ['price', 'qualification', 'faq', 'greeting']) {
      const i = calcSubmit(eligible());
      i.draft.category = label;
      expect(autoVerdict(i), String(label)).toEqual({ eligible: true, reasons: [] });
    }
    // …but a complaint stays his whatever it does (finding 8 — the arming words: «shikoyat har doim sizga qoladi»).
    // DELIBERATE EDIT (stage 1a §6.2): «other» and no label are free now — the act decides, not the label.
    const complaint = calcSubmit(eligible());
    complaint.draft.category = 'complaint';
    expect(autoVerdict(complaint)).toEqual({ eligible: false, reasons: ['complaint'] });
    for (const label of ['other', null, '']) {
      const i = calcSubmit(eligible());
      i.draft.category = label;
      expect(autoVerdict(i), String(label)).toEqual({ eligible: true, reasons: [] });
    }
    // …and with «Hisoblatish» unticked it is judged exactly as before: an action, refused.
    const off = calcSubmit(eligible());
    off.config.categories = [...FOUR];
    expect(autoVerdict(off).reasons).toEqual(['actions']);
    off.draft.category = 'qualification';
    expect(autoVerdict(off).reasons).toEqual(['actions']);
    // A label never names the kind: «calc» as the model's label, with no act behind it, is ordinary talk.
    const labelled = eligible();
    labelled.config.categories = [...FOUR, 'calc'];
    labelled.draft.category = 'calc';
    expect(autoVerdict(labelled)).toEqual({ eligible: true, reasons: [] });
  });

  it('only a draft whose ONE act is a calc submit (and a follow-up): with a mute, or two submits, it is an action', () => {
    const mute = calcSubmit(eligible());
    mute.draft.actionTypes = ['calc_submit', 'mute'];
    expect(autoVerdict(mute).reasons).toContain('actions');
    const two = calcSubmit(eligible());
    two.draft.actionTypes = ['calc_submit', 'calc_submit'];
    expect(autoVerdict(two).reasons).toContain('actions');
  });

  it('facts not read on a calc draft refuse every one (fails closed)', () => {
    const i = calcSubmit(eligible());
    i.calc = null;
    expect(autoVerdict(i).reasons).toEqual(['calc_identity', 'calc_foreign', 'calc_refused', 'calc_recent', 'calc_file_missing']);
  });

  it('`media` is not asked of a calc submit — the invoice goes to the VED — and is asked of every other draft', () => {
    const calc = calcSubmit(eligible());
    calc.burstMedia = true;
    expect(autoVerdict(calc)).toEqual({ eligible: true, reasons: [] });
    const reply = eligible();
    reply.burstMedia = true;
    expect(autoVerdict(reply).reasons).toEqual(['media']);
    // With «Hisoblatish» unticked a calc submit keeps today's media rule too.
    const off = calcSubmit(eligible());
    off.config.categories = [...FOUR, 'price'];
    off.burstMedia = true;
    expect(autoVerdict(off).reasons).toEqual(['actions', 'media']);
  });

  it('the five refusals say the spec’s words', () => {
    expect(AUTO_REFUSAL_WORDS.calc_identity).toBe('chat telefon bilan tasdiqlanmagan — hisoblatishni o‘zingiz yuboring');
    expect(AUTO_REFUSAL_WORDS.calc_foreign).toBe('bu boshqa sotuvchining mijozi yoki lidi');
    expect(AUTO_REFUSAL_WORDS.calc_refused).toBe('VED navbati bu hisoblatishni olmaydi (lid yopilgan yoki ochiq so‘rovlar to‘la)');
    expect(AUTO_REFUSAL_WORDS.calc_recent).toBe('14 kun ichida shu yuk uchun hisoblatish bor — ikkinchisini o‘zingiz yuboring');
    expect(AUTO_REFUSAL_WORDS.calc_file_missing).toBe('mijoz yuborgan fayl saqlanmagan — VED uni ko‘rmaydi');
  });
});
