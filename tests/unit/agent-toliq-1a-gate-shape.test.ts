import { describe, expect, it } from 'vitest';
import {
  AUTO_REFUSALS,
  AUTO_REFUSAL_WORDS,
  COMING_REFUSALS,
  COMING_REFUSAL_WORDS,
  EYE_ONLY_NOTES,
  EYE_ONLY_WARNINGS,
  RETIRED_REFUSALS,
  RETIRED_REFUSAL_WORDS,
  autoClassOf,
  autoVerdict,
  refusalWordOf,
  type AutoGateInput,
} from '@/modules/wms/agent/auto-gate';
import { autoRefusalWords } from '@/modules/wms/agent/auto-card';
import { noteCodesOf, systemAckOf, warningCodesOf } from '@/modules/wms/agent/auto-send';
import type { AgentContext, ChatMessage } from '@/modules/wms/agent/context';
import { validateActions, type ComposeReply } from '@/modules/wms/agent/run';
import type { ToolOutcome } from '@/modules/wms/agent/tools';
import { NOTE_CODES, type NoteCode } from '@/modules/wms/agent/types';

/**
 * Stage 1a's kernel, K5 + K6 (docs/ai-toliq/qurish/STAGE-0-1A.md §4.1, J5, J9, J19, J27): the gate reads a draft's
 * warnings and notes by CODE, and knows what a reply IS (`autoClassOf`) — the shape every package of the stage builds
 * on. BEHAVIOUR-NEUTRAL by design: every warning and every note still stops the machine here (P1 frees the eye-only
 * ones, with their own tests); what this file pins is the reading — a note stored without its code stops, a code is
 * never lost on the way, a price is never read as talk.
 */

const NOON = new Date('2026-11-11T07:00:00Z');

function eligible(): AutoGateInput {
  return {
    config: { armed: true, categories: ['greeting', 'qualification', 'faq', 'status'], maxChars: 400, perDay: null },
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
    budgetLeft: null,
    sendingEnabled: null,
    listenerCurrent: null,
  };
}

describe('the stored notes’ codes — ONE reading rule (K5)', () => {
  it('no notes → none, whatever else is stored beside them', () => {
    expect(noteCodesOf({ notes: [] })).toEqual([]);
    expect(noteCodesOf({})).toEqual([]);
    expect(noteCodesOf({ notes: [], noteCodes: 'buzilgan' })).toEqual([]);
  });

  it('notes with a code array of the same length → those codes', () => {
    expect(noteCodesOf({ notes: ['⏱ Mijoz 12 daqiqadan beri javob kutyapti', 'Bu chatda ochiq hisoblatish bor'], noteCodes: ['late', 'calc_open'] })).toEqual([
      'late',
      'calc_open',
    ]);
  });

  it('anything else is null — a draft written before 1a with notes and no codes is a machine stop', () => {
    expect(noteCodesOf({ notes: ['⏱ Mijoz 12 daqiqadan beri javob kutyapti'] })).toBeNull();
    expect(noteCodesOf({ notes: ['a', 'b'], noteCodes: ['late'] })).toBeNull();
    expect(noteCodesOf({ notes: ['a'], noteCodes: [7] })).toBeNull();
    expect(noteCodesOf({ notes: ['a'], noteCodes: 'late' })).toBeNull();
  });

  it('…and the gate refuses it as a note, while no notes at all go on', () => {
    const uncoded = eligible();
    uncoded.draft.noteCodes = null;
    expect(autoVerdict(uncoded)).toEqual({ eligible: false, reasons: ['notes'] });
    expect(autoVerdict(eligible())).toEqual({ eligible: true, reasons: [] });
  });
});

describe('the stored warnings by code (K6)', () => {
  it('one code per stored warning, in order; one that names none reads «?» — the count never drops', () => {
    expect(warningCodesOf([{ rule: 'G2', code: 'questions' }, { rule: 'G12', code: 'avia_maybe', detail: 'x' }])).toEqual(['questions', 'avia_maybe']);
    expect(warningCodesOf([{ rule: 'G2' }, null, 'questions'])).toEqual(['?', '?', '?']);
    expect(warningCodesOf(undefined)).toEqual([]);
    expect(warningCodesOf('buzilgan')).toEqual([]);
  });

  it('a warning the gate has never heard of stops the machine', () => {
    const i = eligible();
    i.draft.warningCodes = ['?'];
    expect(autoVerdict(i)).toEqual({ eligible: false, reasons: ['warnings'] });
  });
});

describe('a tayyor matn is the code’s, only for a reason this build knows (K6, J27)', () => {
  it('voice, media and Pashto — and nothing else', () => {
    for (const reason of ['voice', 'media', 'pashto']) expect(systemAckOf({ system: reason })).toBe(true);
    for (const other of [undefined, '', 'sticker', 1, null]) expect(systemAckOf({ system: other })).toBe(false);
  });
});

describe('what a reply IS — `autoClassOf` fails CLOSED (K6, J5)', () => {
  const classOf = (patch: (i: AutoGateInput) => void) => {
    const i = eligible();
    patch(i);
    return autoClassOf(i);
  };

  it('a greeting, a follow-up beside it — talk', () => {
    expect(classOf(() => undefined)).toBe('talk');
    expect(classOf((i) => (i.draft.actionTypes = ['set_followup']))).toBe('talk');
  });

  it('one calculation sent to the VED — calc, whatever the model labelled it', () => {
    expect(classOf((i) => ((i.draft.actionTypes = ['calc_submit', 'set_followup']), (i.draft.category = 'price')))).toBe('calc');
  });

  it('a truck quote, a balance, a fact’s price, a refused estimate — price', () => {
    const quote = (i: AutoGateInput) => {
      i.draft.ledger = [{ kind: 'money', origin: 'tool', tool: 'yolkira_estimate', role: 'total' }];
      i.draft.hasEstimate = true;
      i.tools = [{ name: 'yolkira_estimate', ok: true, estimate: true }];
    };
    expect(classOf(quote)).toBe('price');
    expect(classOf((i) => (i.tools = [{ name: 'own_balance', ok: true, estimate: false }]))).toBe('price');
    expect(classOf((i) => (i.draft.ledger = [{ kind: 'money', origin: 'kb', tool: null, role: null }]))).toBe('price');
    expect(classOf((i) => (i.tools = [{ name: 'yolkira_estimate', ok: false, estimate: false }]))).toBe('price');
  });

  it('a price nobody read is a price: a currency beside a quantity, a numeral no reader reads', () => {
    expect(classOf((i) => (i.draft.body = 'Narxi bir necha dollar.'))).toBe('price');
    expect(classOf((i) => (i.draft.unreadNumeral = true))).toBe('price');
  });

  it('any act besides a follow-up is a price for the hold, the night and the language', () => {
    expect(classOf((i) => (i.draft.actionTypes = ['mute']))).toBe('price');
    expect(classOf((i) => (i.draft.actionTypes = ['calc_submit', 'calc_submit']))).toBe('price');
  });

  it('a VED answer’s price — calc_price; and beside a table price still calc_price (J5: the night bars it)', () => {
    const ved = (i: AutoGateInput) => {
      i.draft.ledger = [{ kind: 'money', origin: 'tool', tool: 'calc_price', role: 'total' }];
      i.draft.calcPricesStored = true;
      i.tools = [{ name: 'calc_price', ok: true, estimate: false }];
    };
    expect(classOf(ved)).toBe('calc_price');
    expect(
      classOf((i) => {
        ved(i);
        i.draft.ledger = [...i.draft.ledger, { kind: 'money', origin: 'tool', tool: 'yolkira_estimate', role: 'total' }];
        i.draft.hasEstimate = true;
        i.tools = [...i.tools, { name: 'yolkira_estimate', ok: true, estimate: true }];
      }),
    ).toBe('calc_price');
  });
});

describe('the refusal words of the stage — retired, coming, one home each (K6)', () => {
  it('the three the stage retires keep their words, and while they still stand in the gate the gate uses the same ones', () => {
    for (const code of RETIRED_REFUSALS) {
      expect(refusalWordOf(code)).toBe(RETIRED_REFUSAL_WORDS[code]);
      if ((AUTO_REFUSALS as readonly string[]).includes(code)) expect(AUTO_REFUSAL_WORDS[code as keyof typeof AUTO_REFUSAL_WORDS]).toBe(RETIRED_REFUSAL_WORDS[code]);
    }
  });

  it('the ones the stage adds have words now, and none stands in the gate before the package that gives it a fact', () => {
    for (const code of COMING_REFUSALS) {
      expect(refusalWordOf(code)).toBe(COMING_REFUSAL_WORDS[code]);
      expect(COMING_REFUSAL_WORDS[code]).not.toMatch(/^[a-z_]+$/u);
      expect(AUTO_REFUSALS as readonly string[]).not.toContain(code);
    }
    // `loop` moved with its fact (P2's detector): it stands in the gate now, with the one word J33 fixed, and in one list only.
    expect(AUTO_REFUSALS as readonly string[]).toContain('loop');
    expect(COMING_REFUSALS as readonly string[]).not.toContain('loop');
    expect(AUTO_REFUSAL_WORDS.loop).toBe('suhbat aylanib qoldi');
    expect(COMING_REFUSAL_WORDS.ready_text_unapproved).toBe('fors/xitoy tayyor matni hali tasdiqlanmagan');
  });

  it('a stored row naming one prints its words on the card, never «sababi noma’lum»', () => {
    expect(autoRefusalWords({ outcome: 'loop', reasons: ['loop'] })).toBe(AUTO_REFUSAL_WORDS.loop);
    // DELIBERATE EDIT (stage 1a P1): `complaint` got its fact and moved into the gate, its word with it.
    expect(autoRefusalWords({ outcome: 'streak,complaint', reasons: [] })).toBe(`${RETIRED_REFUSAL_WORDS.streak}; ${AUTO_REFUSAL_WORDS.complaint}`);
    expect(refusalWordOf('no_such_code')).toBeNull();
  });

  it('the eye-only lists the packages read: one warning, one note', () => {
    expect([...EYE_ONLY_WARNINGS]).toEqual(['questions']);
    expect([...EYE_ONLY_NOTES]).toEqual(['late']);
    expect(NOTE_CODES as readonly string[]).toContain('late');
  });
});

describe('the run’s notes leave `validateActions` with their codes, in step (K5)', () => {
  const at = new Date('2026-11-11T07:00:00Z');
  const m: ChatMessage = {
    ref: '#1',
    id: '00000000-0000-4000-8000-000000000001',
    tgMessageId: 1n,
    direction: 'in',
    media: null,
    fileName: null,
    sentAt: at,
    autoSent: false,
    editedAt: null,
    body: 'Yiwudan Toshkentga podklyuch, 0.4 kub 60 kg, kurtka 50 dona',
  };
  const ctx = (open: boolean): AgentContext => ({
    managerUserId: 'u',
    peerId: 1n,
    messages: [m],
    history: [m],
    anchor: m,
    burst: [m],
    lastOut: null,
    identity: { clientId: null, leadId: 'l', strength: 'lead', codes: [], customerName: null, managerName: null, cargoAllowed: false },
    storedLocale: null,
    customerScript: 'latin',
    measures: [],
    openCalcs: open ? [{ requestId: 'r', section: 'podklyuch', createdAt: at, status: 'open' }] : [],
    lastQuote: null,
    ruleDecision: null,
  });
  const compose = (actions: unknown[]): ComposeReply =>
    ({
      replyNeeded: true,
      replyText: 'Hisoblatishga yubordim.',
      language: 'uz',
      glossUz: '',
      category: 'qualification',
      confidence: 0.9,
      needsOwner: false,
      ownerQuestion: '',
      nextStep: 'calc',
      actions,
      usedFactIds: [],
      citedMessageRefs: [],
    }) as unknown as ComposeReply;
  const checklist = (weightKg: number, volumeM3: number): ToolOutcome => ({
    ok: true,
    text: '',
    sources: [],
    checklist: {
      section: 'podklyuch',
      facts: { fromCity: 'Yiwu', toCity: 'Toshkent', weightKg, volumeM3, goods: [{ name: 'kurtka', quantity: 50, weightKg: null }] },
      complete: true,
      fromOurWarehouse: false,
    },
  });
  const submit = { type: 'calc_submit', section: 'podklyuch', citedMessageRefs: ['#1'], date: '', note: '' };
  const followup = { type: 'set_followup', section: '', citedMessageRefs: [], date: '1999-01-01', note: 'x' };

  it('below the truck minimum, incomplete, a second open job, a bad date — each note with its own code', () => {
    const below = validateActions(compose([submit]), ctx(false), [checklist(60, 0.4)], at);
    expect(below.noteCodes).toEqual(['calc_below_minimum']);
    const incomplete = validateActions(compose([submit]), ctx(false), [], at);
    expect(incomplete.noteCodes).toEqual(['calc_incomplete']);
    const open = validateActions(compose([submit, followup]), ctx(true), [checklist(1200, 6)], at);
    expect(open.noteCodes).toEqual(['calc_open', 'followup_bad']);
    for (const r of [below, incomplete, open]) expect(r.noteCodes).toHaveLength(r.notes.length);
  });

  it('…into the run’s own array when it hands one in — the array every later note’s code follows into', () => {
    const run: NoteCode[] = [];
    const r = validateActions(compose([submit]), ctx(false), [], at, run);
    expect(r.noteCodes).toBe(run);
    expect(run).toEqual(['calc_incomplete']);
  });
});
