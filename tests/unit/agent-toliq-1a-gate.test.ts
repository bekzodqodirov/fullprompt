import { describe, expect, it } from 'vitest';
import {
  AUTO_REFUSALS,
  AUTO_REFUSAL_WORDS,
  EYE_ONLY_NOTES,
  EYE_ONLY_WARNINGS,
  autoClassOf,
  autoVerdict,
  nightBars,
  stopsMachine,
  type AutoClass,
  type AutoGateInput,
} from '@/modules/wms/agent/auto-gate';
import { countdownMayRide, holdSecFor } from '@/modules/wms/agent/auto-send';
import { ORDINARY_CATEGORIES, TICKED_CATEGORIES } from '@/modules/wms/agent/auto-categories';
import { AGENT_NIGHT_PRICES } from '@/modules/platform/settings/service';

/**
 * Stage 1a, P1 «To'siq» — the gate rule by rule (docs/ai-toliq/qurish/STAGE-0-1A.md §6.2, §7's first row), each on
 * BOTH sides: what a reply DOES decides (`autoClassOf`), never the model's opinion of itself.
 *  - the model's own rating, the ticked label and two replies in a row decide nothing any more;
 *  - a warning or a note stops the machine unless it only informs him (`stopsMachine`);
 *  - a complaint — the model's label or the burst's own words — stays his;
 *  - the night bars a CLASS by his setting (`nightBars`);
 *  - a photo is not asked of the code's own tayyor matn;
 *  - the language rule is today's for every MODEL reply, whatever its class; J19's one relaxation (a guess naming no
 *    language admits Uzbek) is the tayyor matn's alone (the merged-tree seam review, finding 4 — see below);
 *  - the hold is the class's (`holdSecFor`): talk its own setting (0 = at once), a price the layer's.
 */

const NOON = new Date('2026-11-11T07:00:00Z');
/** 23:00 Tashkent. */
const NIGHT = new Date('2026-11-11T18:00:00Z');

function talk(): AutoGateInput {
  return {
    config: { armed: true, categories: [...ORDINARY_CATEGORIES], maxChars: 400, perDay: null },
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
      body: 'Ha, Xitoydan olib kelamiz. Qanday yuk?',
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
    budgetLeft: null,
    sendingEnabled: null,
    listenerCurrent: null,
  };
}

/** A truck quote the money clause admits — «Narx» ticked. */
function quote(i = talk()): AutoGateInput {
  i.config.categories = [...i.config.categories, 'price'];
  i.draft.category = 'price';
  i.draft.body = '5 kub, 800 kg yukingiz uchun Toshkentgacha taxminan 960 $. Boj va QQS alohida hisoblanadi.';
  i.draft.ledger = [{ kind: 'money', origin: 'tool', tool: 'yolkira_estimate', role: 'total' }];
  i.draft.hasEstimate = true;
  i.draft.estimatesStored = true;
  i.tools = [{ name: 'yolkira_estimate', ok: true, estimate: true }];
  return i;
}

/** A VED answer's price the clause admits — «VED narxi» ticked. */
function vedPrice(i = talk()): AutoGateInput {
  i.config.categories = [...i.config.categories, 'calc_price'];
  i.draft.category = 'price';
  i.draft.body = 'VED javobi keldi: rastamojka 1 359 $ bo‘ladi.';
  i.draft.ledger = [{ kind: 'money', origin: 'tool', tool: 'calc_price', role: 'total' }];
  i.draft.calcPricesStored = true;
  i.tools = [{ name: 'calc_price', ok: true, estimate: false }];
  i.calcPrice = { unconfirmed: false, moved: false, foreign: false, media: false, ownerPriced: false, personOffer: false };
  return i;
}

/** A calculation sent to the VED — «Hisoblatish» ticked, every fact clear. */
function calc(i = talk()): AutoGateInput {
  i.config.categories = [...i.config.categories, 'calc'];
  i.draft.actionTypes = ['calc_submit'];
  i.draft.body = 'Hisoblatishga yubordim, javob kelishi bilan aytaman.';
  i.calc = { unproven: false, foreign: false, refused: false, recent: false, fileMissing: false };
  return i;
}

const go = (i: AutoGateInput) => autoVerdict(i);

describe('the model’s own rating decides nothing (low_confidence left the gate)', () => {
  it('0.3, 0 and none go — and the code is in no list the gate can emit', () => {
    for (const confidence of [0.3, 0, null]) {
      const i = talk();
      i.draft.confidence = confidence;
      expect(go(i), String(confidence)).toEqual({ eligible: true, reasons: [] });
    }
    expect(AUTO_REFUSALS as readonly string[]).not.toContain('low_confidence');
  });
});

describe('a warning or a note stops the machine unless it only informs him — ONE predicate', () => {
  it('`questions` goes; `avia_maybe`, a short `fingerprint`, a one-word `staff_name` and a code nobody listed stop', () => {
    const w = (codes: string[]) => go(Object.assign(talk(), { draft: { ...talk().draft, warningCodes: codes } }));
    expect(w(['questions'])).toEqual({ eligible: true, reasons: [] });
    for (const code of ['avia_maybe', 'fingerprint', 'staff_name', 'a_code_minted_tomorrow', '?']) {
      expect(w([code]).reasons, code).toEqual(['warnings']);
      expect(w(['questions', code]).reasons, `questions + ${code}`).toEqual(['warnings']);
    }
  });

  it('the late note goes; `calc_open` and every other note stop; a pre-1a draft with notes and no codes stops', () => {
    const n = (codes: string[] | null) => go(Object.assign(talk(), { draft: { ...talk().draft, noteCodes: codes } }));
    expect(n(['late'])).toEqual({ eligible: true, reasons: [] });
    for (const code of ['calc_open', 'rail', 'tariff_mismatch', 'calc_recent']) expect(n([code]).reasons, code).toEqual(['notes']);
    expect(n(['late', 'calc_open']).reasons).toEqual(['notes']);
    expect(n(null).reasons).toEqual(['notes']);
  });

  it('the predicate itself, both lists', () => {
    expect([...EYE_ONLY_WARNINGS]).toEqual(['questions']);
    expect([...EYE_ONLY_NOTES]).toEqual(['late']);
    expect(stopsMachine('warning', 'questions')).toBe(false);
    expect(stopsMachine('warning', 'late')).toBe(true);
    expect(stopsMachine('note', 'late')).toBe(false);
    expect(stopsMachine('note', 'questions')).toBe(true);
  });
});

describe('the label is free; a complaint stays his', () => {
  it('«other», no label, a kind he never ticked — they go; «complaint» and the burst’s complaint stop', () => {
    for (const label of ['other', null, 'greeting', 'status-like']) {
      const i = talk();
      i.draft.category = label;
      expect(go(i), String(label)).toEqual({ eligible: true, reasons: [] });
    }
    const label = talk();
    label.draft.category = 'complaint';
    expect(go(label).reasons).toEqual(['complaint']);
    const words = talk();
    words.complaint = true;
    expect(go(words).reasons).toEqual(['complaint']);
    expect(AUTO_REFUSALS as readonly string[]).not.toContain('category');
    expect(AUTO_REFUSAL_WORDS.complaint).toBe('mijoz shikoyat yoki menejer so‘radi — sizga qoldi');
  });

  it('a complaint stays his whatever the reply does — a quote, a calculation', () => {
    const q = quote();
    q.draft.category = 'complaint';
    expect(go(q).reasons).toEqual(['complaint']);
    const c = calc();
    c.complaint = true;
    expect(go(c).reasons).toEqual(['complaint']);
  });

  it('none of the four ordinary kinds ticked, talk still goes; the three he ticks are the only boxes', () => {
    const i = talk();
    i.config.categories = ['price'];
    expect(go(i)).toEqual({ eligible: true, reasons: [] });
    expect([...TICKED_CATEGORIES]).toEqual(['price', 'calc', 'calc_price']);
  });
});

describe('the night bars a class by his setting (his 4 a)', () => {
  /** The class's sample draft, judged at 23:00 under each setting. */
  const SAMPLE: Record<AutoClass, () => AutoGateInput> = { talk, price: quote, calc_price: vedPrice, calc };
  /** Hand-written from §6.2 — never computed by the rule under test. */
  const BARRED: Record<AutoClass, Record<(typeof AGENT_NIGHT_PRICES)[number], boolean>> = {
    talk: { none: false, table: false, all: false },
    price: { none: true, table: false, all: false },
    calc_price: { none: true, table: true, all: false },
    calc: { none: true, table: true, all: true },
  };

  it.each(Object.keys(SAMPLE) as AutoClass[])('%s at 23:00 under none / table / all', (cls) => {
    for (const setting of AGENT_NIGHT_PRICES) {
      const i = SAMPLE[cls]();
      expect(autoClassOf(i)).toBe(cls);
      i.nightPrices = setting;
      i.at = NIGHT;
      i.now = NIGHT;
      expect(nightBars(cls, setting), `${cls} ${setting}`).toBe(BARRED[cls][setting]);
      expect(go(i), `${cls} ${setting}`).toEqual(BARRED[cls][setting] ? { eligible: false, reasons: ['night'] } : { eligible: true, reasons: [] });
      // …and by day, under any setting, none of them is held for the night.
      const day = SAMPLE[cls]();
      day.nightPrices = setting;
      expect(go(day), `${cls} ${setting} by day`).toEqual({ eligible: true, reasons: [] });
    }
  });

  it('a VED price beside a table price is judged as the VED price (J5): at 23:00 under «table» it waits', () => {
    const mixed = vedPrice();
    mixed.config.categories = [...mixed.config.categories, 'price'];
    mixed.draft.ledger = [...mixed.draft.ledger, { kind: 'money', origin: 'tool', tool: 'yolkira_estimate', role: 'total' }];
    mixed.draft.hasEstimate = true;
    mixed.draft.estimatesStored = true;
    mixed.tools = [...mixed.tools, { name: 'yolkira_estimate', ok: true, estimate: true }];
    mixed.draft.body = 'Rastamojka 1 359 $. 5 kub, 800 kg yukingiz uchun Toshkentgacha taxminan 960 $. Boj va QQS alohida hisoblanadi.';
    expect(go(mixed)).toEqual({ eligible: true, reasons: [] });
    mixed.at = NIGHT;
    expect(go(mixed).reasons).toEqual(['night']);
  });

  it('its word says the morning judges it again (J31) — never «yours to decide in the morning»', () => {
    expect(AUTO_REFUSAL_WORDS.night).toBe('tun — ertalab qayta tekshiriladi');
    expect(AUTO_REFUSAL_WORDS.night).not.toMatch(/o‘zingiz/u);
  });

  it('the second check: a barred class written in the night’s last hold waits — its card goes now, silently', () => {
    const c = calc();
    c.now = new Date('2026-11-12T02:58:00Z'); // 07:58
    c.at = new Date('2026-11-12T03:00:30Z'); // 08:00:30
    expect(go(c).reasons).toEqual(['night']);
    const t = talk();
    t.now = c.now;
    t.at = c.at;
    expect(go(t)).toEqual({ eligible: true, reasons: [] });
  });
});

describe('a photo is not asked of the code’s own tayyor matn', () => {
  it('the model’s reply to a burst with a photo waits; the system line that answers it does not', () => {
    const model = talk();
    model.burstMedia = true;
    expect(go(model).reasons).toEqual(['media']);
    const system = talk();
    system.burstMedia = true;
    system.draft.systemAck = true;
    expect(go(system)).toEqual({ eligible: true, reasons: [] });
  });
});

describe('the language — today’s rule for every model reply (J19)', () => {
  /**
   * J19 ruled one relaxation for talk: a guess that names no language admits Uzbek. Measured against the reader corpus
   * BEFORE a line of it was written, it lets eleven dangerous rows go (a Russian customer writing in Latin letters,
   * an English one) — so for the MODEL's replies it is held (the contract's zero) and talk keeps today's rule. A price
   * keeps it whatever the talk rule becomes (`language_money` in the corpus pins that side). The tayyor matn has it
   * (the last case below).
   */
  const lang = (i: AutoGateInput, language: string, guess: AutoGateInput['draft']['customerLocale']) => {
    i.draft.language = language;
    i.draft.customerLocale = guess;
    return go(i).reasons;
  };

  it('talk and a price agree, case by case', () => {
    const cases: [string, AutoGateInput['draft']['customerLocale'], boolean][] = [
      ['uz', { locale: 'uz', confident: true }, true],
      ['ru', { locale: 'ru', confident: false, leans: true }, true],
      ['uz', { locale: null, confident: false }, false],
      ['uz', null, false],
      ['ru', { locale: 'uz_cyrl', confident: true }, false],
      ['en', { locale: 'en', confident: false }, false],
      ['fa', { locale: 'fa', confident: true }, true],
    ];
    for (const [language, guess, goes] of cases) {
      const want = goes ? [] : ['language'];
      expect(lang(talk(), language, guess), `talk ${language} ${JSON.stringify(guess)}`).toEqual(want);
      expect(lang(quote(), language, guess), `price ${language} ${JSON.stringify(guess)}`).toEqual(want);
    }
  });

  /**
   * The lead's ruling on the merged tree (finding 4): the eleven corpus rows that held the relaxation back are MODEL
   * replies, so it is given to the code's own Uzbek line alone — a first photo or voice note shows no language at all,
   * and its «write it as text» goes by itself. The model's reply to the same chat keeps today's rule byte for byte.
   */
  it('a guess naming no language admits the tayyor matn in Uzbek — and nothing else', () => {
    const tayyor = (language: string, guess: AutoGateInput['draft']['customerLocale']) => {
      const i = talk();
      i.draft.systemAck = true;
      i.draft.category = 'other';
      i.draft.body = 'Faylni oldim, lekin hozircha ocha olmayapman — kerakli ma’lumotni matn bilan yozib yuboring.';
      i.draft.confidence = null;
      return lang(i, language, guess);
    };
    const none = { locale: null, confident: false };
    expect(tayyor('uz', none)).toEqual([]);
    // The model's reply to the same silence: held, as today.
    expect(lang(talk(), 'uz', none)).toEqual(['language']);
    // A tayyor matn in another language on that guess: held — the relaxation names Uzbek alone.
    expect(tayyor('ru', none)).toEqual(['language']);
    expect(tayyor('uz_cyrl', none)).toEqual(['language']);
    // No guess stored at all (a draft written before 0148) says nothing either way: held.
    expect(tayyor('uz', null)).toEqual(['language']);
    // A guess that names a language keeps today's rule for the tayyor matn too.
    expect(tayyor('uz', { locale: 'ru', confident: true })).toEqual(['language']);
    expect(tayyor('ru', { locale: 'ru', confident: true })).toEqual([]);
    // …and the model's priced reply neither: the mark decides, never the class.
    expect(lang(quote(), 'uz', none)).toEqual(['language']);
  });
});

describe('the hold is the class’s (his 11 a: talk at once, a price 2 minutes with ⏸)', () => {
  const HOLDS = { talk: 0, price: 120 };

  it('talk takes its own; every price class the layer’s', () => {
    expect(holdSecFor('talk', HOLDS)).toBe(0);
    for (const cls of ['price', 'calc_price', 'calc'] as const) expect(holdSecFor(cls, HOLDS), cls).toBe(120);
    expect(holdSecFor('talk', { talk: 90, price: 120 })).toBe(90);
  });

  it('a reply with a money line is never talk — its hold is never 0 (K6: the class fails closed)', () => {
    expect(holdSecFor(autoClassOf(quote()), HOLDS)).toBe(120);
    expect(holdSecFor(autoClassOf(vedPrice()), HOLDS)).toBe(120);
    expect(holdSecFor(autoClassOf(calc()), HOLDS)).toBe(120);
    const balance = talk();
    balance.tools = [{ name: 'own_balance', ok: true, estimate: false }];
    expect(holdSecFor(autoClassOf(balance), HOLDS)).toBe(120);
  });

  it('a hold of 0 counts nothing down: it rides any copy of the chat’s card, rung or not, old or not', () => {
    const plan = { dueAt: NOON, holdSec: 0 };
    expect(countdownMayRide({ status: 'sent', sentAt: new Date(NOON.getTime() - 5 * 3_600_000), payload: { rang: false } }, plan)).toBe(true);
    expect(countdownMayRide({ status: 'failed', sentAt: null, payload: {} }, plan)).toBe(true);
    // …while a countdown still never rides a silent copy.
    expect(countdownMayRide({ status: 'sent', sentAt: NOON, payload: { rang: false } }, { dueAt: new Date(NOON.getTime() + 120_000), holdSec: 120 })).toBe(false);
  });
});

describe('two replies in a row are no rule any more (the loop detector takes the slot)', () => {
  it('a fifth machine reply in a row goes — the gate reads no count of them', () => {
    // There is no input to say «five in a row»: `streak` left the gate's shape with its reader (auto-send `autoStreak`,
    // fenced by agent-toliq-1a-wire). The chat that loops is P2's `loop`.
    expect('streak' in talk()).toBe(false);
    expect(AUTO_REFUSALS as readonly string[]).not.toContain('streak');
    expect(go(talk())).toEqual({ eligible: true, reasons: [] });
  });
});
