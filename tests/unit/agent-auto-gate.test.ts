import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';
import {
  AUTO_LANGUAGES,
  AUTO_REFUSALS,
  AUTO_REFUSAL_WORDS,
  AUTO_SEND_CATEGORIES,
  MONEY_TOOLS,
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

/** The four kinds the layer shipped with — the stored row 0146 leaves as it found it (the price box ships unticked). */
const FOUR = ['greeting', 'qualification', 'faq', 'status'];

function eligible(): AutoGateInput {
  return {
    config: { armed: true, categories: [...FOUR], maxChars: 400, minConfidence: 0.8, perDay: 30 },
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
      category: 'greeting',
      language: 'uz',
      body: 'Assalomu alaykum! Qanday yordam bera olaman?',
      confidence: 0.9,
      ledger: [],
      hasEstimate: false,
      estimatesStored: false,
      rail: false,
      customerLocale: { locale: 'uz', confident: true },
    },
    tools: [],
    money: { unnamed: false, moved: false, tariffUnconfirmed: false, foreignDestination: false, ownerPersonal: false, answerStale: false },
    burstMedia: false,
    chat: { hasOwner: true, prospect: false, offUntil: null, humanUntil: null, muted: false },
    workAccount: true,
    at: NOON,
    now: NOON,
    streak: 0,
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
  warnings: (i) => (i.draft.warnings = 1),
  notes: (i) => (i.draft.notes = 1),
  actions: (i) => (i.draft.actionTypes = ['calc_submit']),
  money: (i) => (i.tools = [{ name: 'own_balance', ok: true, estimate: false }]),
  // A currency named and no money line read (a price spelled in words nothing here reads).
  money_unread: (i) => (i.draft.body = 'Narxni dollarda aytaman.'),
  estimate_unnamed: (i) => (quote(i).money.unnamed = true),
  estimate_moved: (i) => (quote(i).money.moved = true),
  tariff_unconfirmed: (i) => (quote(i).money.tariffUnconfirmed = true),
  foreign_destination: (i) => (quote(i).money.foreignDestination = true),
  destination_unsaid: (i) => (quote(i).draft.body = '5 kub, 800 kg yukingiz uchun taxminan 960 $. Boj va QQS alohida hisoblanadi.'),
  // A day count from HIS ✍️ answer — no money in it, and it still comes back to him.
  owner_figure: (i) => (i.draft.ledger = [{ kind: 'duration', origin: 'owner', tool: null, role: null }]),
  owner_personal: (i) => (i.money.ownerPersonal = true),
  answer_stale: (i) => (i.money.answerStale = true),
  category: (i) => (i.draft.category = 'complaint'),
  status_unbacked: (i) => (i.draft.category = 'status'),
  language: (i) => (i.draft.language = 'en'),
  media: (i) => (i.burstMedia = true),
  too_long: (i) => (i.draft.body = 'x'.repeat(401)),
  low_confidence: (i) => (i.draft.confidence = 0.79),
  stranger: (i) => (i.chat.hasOwner = false),
  prospect: (i) => (i.chat.prospect = true),
  chat_off: (i) => (i.chat.offUntil = new Date(NOON.getTime() + 60_000)),
  // His 🙋 «Suhbat meniki» and a chat the AI was muted in (final check): the chat is not the machine's to answer.
  human_active: (i) => (i.chat.humanUntil = new Date(NOON.getTime() + 60_000)),
  chat_muted: (i) => (i.chat.muted = true),
  not_work_account: (i) => (i.workAccount = false),
  night: (i) => (i.at = NIGHT),
  streak: (i) => (i.streak = 2),
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
      if (QUOTE_ONLY.has(code) || ['category', 'status_unbacked', 'money_unread', 'too_long'].includes(code)) continue;
      ONE_CHANGE[code](input);
    }
    input.draft.category = 'status';
    input.draft.body = `Narxni dollarda aytaman. ${'x'.repeat(400)}`;
    const out = autoVerdict(input);
    expect(out.eligible).toBe(false);
    expect(out.reasons).toEqual(AUTO_REFUSALS.filter((r) => r !== 'category' && !QUOTE_ONLY.has(r)));
    // …and a category outside the chosen set is the category's own refusal beside it.
    input.config.categories = ['greeting'];
    expect(autoVerdict(input).reasons).toEqual(AUTO_REFUSALS.filter((r) => !QUOTE_ONLY.has(r)));
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

  it('the five kinds ever, and only the ones he chose — «Narx» among them only when he ticked it', () => {
    for (const category of ['complaint', 'other', null]) {
      const input = eligible();
      input.draft.category = category;
      input.config.categories = ['greeting', 'qualification', 'faq', 'status', 'price', 'complaint', 'other'];
      expect(autoVerdict(input).reasons, String(category)).toEqual(['category']);
    }
    const unchosen = eligible();
    unchosen.config.categories = ['faq'];
    expect(autoVerdict(unchosen).reasons).toEqual(['category']);
    // A reply the model labelled «price» with no money in it: unticked, it is his; ticked, it goes.
    const label = eligible();
    label.draft.category = 'price';
    expect(autoVerdict(label).reasons).toEqual(['category']);
    label.config.categories = [...FOUR, 'price'];
    expect(autoVerdict(label)).toEqual({ eligible: true, reasons: [] });
  });

  it('the kinds have ONE home: the gate re-exports the pure module the page reads, and 0146’s CHECK says the same five', () => {
    expect(AUTO_SEND_CATEGORIES).toBe(ONE_HOME);
    expect([...AUTO_SEND_CATEGORIES]).toEqual(['greeting', 'qualification', 'faq', 'status', 'price']);
    const sql = readFileSync('src/modules/platform/db/migrations/0146_agent_full_p1.sql', 'utf8');
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

  it('the boundaries: 400 characters go, 0.80 goes, a missing confidence does not, a chat off until now is on again', () => {
    const at = eligible();
    at.draft.body = 'x'.repeat(400);
    at.draft.confidence = 0.8;
    expect(autoVerdict(at).eligible).toBe(true);
    const none = eligible();
    none.draft.confidence = null;
    expect(autoVerdict(none).reasons).toEqual(['low_confidence']);
    const off = eligible();
    off.chat.offUntil = NOON;
    expect(autoVerdict(off).eligible).toBe(true);
    const day = eligible();
    day.pressedToday = 29;
    day.streak = 1;
    expect(autoVerdict(day).eligible).toBe(true);
  });

  it('no daily count (0146, his «7 chegara qoyma»): perDay null refuses nothing, however many went today', () => {
    const input = eligible();
    input.config.perDay = null;
    input.pressedToday = 10_000;
    expect(autoVerdict(input)).toEqual({ eligible: true, reasons: [] });
    // …while a number he typed still caps.
    input.config.perDay = 10_000;
    expect(autoVerdict(input).reasons).toEqual(['daily_cap']);
  });

  it('the night is the pump’s own: 22:00-08:00 Tashkent, judged at the moment the reply would go', () => {
    const at = (iso: string) => {
      const input = eligible();
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
      const input = eligible();
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

  it('every money line must be an estimate tool’s total or rate: a balance, a fact, his answer, a line before 0146 — each refuses', () => {
    const line = (l: AutoGateInput['draft']['ledger'][number]) => money((i) => (i.draft.ledger = [...i.draft.ledger, l]));
    // A balance line (own_balance's) — its role and its tool are not an estimate's.
    expect(line({ kind: 'money', origin: 'tool', tool: 'own_balance', role: 'balance' })).toEqual(['money']);
    // A kb line (a fact's money never vouches, but a stored line that names kb is no tool's).
    expect(line({ kind: 'money', origin: 'kb', tool: null, role: 'total' })).toEqual(['money']);
    // His answer's figure (§2.2): never money that goes by itself — and it comes back to him besides.
    expect(line({ kind: 'money', origin: 'owner', tool: null, role: 'total' })).toEqual(['money', 'owner_figure']);
    // A line stored before 0146 names nobody.
    expect(line({ kind: 'money', origin: null, tool: null, role: null })).toEqual(['money']);
    // A line nothing vouched for (G1 blocks it too).
    expect(line({ kind: 'money', origin: null, tool: null, role: null })).toEqual(['money']);
    // The estimate's own tool, but read as a balance.
    expect(line({ kind: 'money', origin: 'tool', tool: 'yolkira_estimate', role: 'balance' })).toEqual(['money']);
  });

  it('the price act is HIS box: unticked, a quote is money; and the label never stands in for the box', () => {
    expect(money((i) => (i.config.categories = [...FOUR]))).toEqual(['money', 'category']);
    // Labelled «faq» by the model, the quote is still judged as price once the clause admits it.
    expect(money((i) => (i.draft.category = 'faq'))).toEqual([]);
    expect(
      money((i) => {
        i.draft.category = 'faq';
        i.config.categories = [...FOUR];
      }),
    ).toEqual(['money']);
  });

  it('a draft with an estimate and none stored (written before 0146) is refused — the press could not re-price it (§1.3)', () => {
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
    // Such a draft carries no stored estimates: refused.
    const input = eligible();
    input.config.categories = [...FOUR, 'price'];
    input.tools = old;
    expect(autoVerdict(input).reasons).toEqual(['money']);
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

  it('Uzbek and Russian keep today’s rule unless a confident guess says otherwise', () => {
    // Today's rule: an unconfident (or absent) guess lets uz / uz_cyrl / ru through.
    for (const l of ['uz', 'uz_cyrl', 'ru']) {
      expect(lang(l, null), `${l} no guess`).toEqual([]);
      expect(lang(l, { locale: 'en', confident: false }), `${l} unconfident`).toEqual([]);
    }
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
    // The MEASURED four (calibration.ts): price is gated by the money clause, never measured as clean (0146).
    expect([...AUTO_CATEGORIES, 'price'].sort()).toEqual([...AUTO_SEND_CATEGORIES].sort());
  });
});
