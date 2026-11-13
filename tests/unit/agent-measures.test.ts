import { describe, expect, it } from 'vitest';
import { measureCandidates, type AgentContext, type ChatMessage } from '@/modules/wms/agent/context';
import { runTool, type ToolEnv } from '@/modules/wms/agent/tools';

/**
 * docs/AI-SORAYDI.md §3.1 T16 — the AI sotuvchi reads a customer's figures
 * with the SAME readers as the bot (CR-4, review JB-16).
 *
 * `measureCandidates` hands the yo'lkira tool its weight and cube REFERENCES,
 * and the checklist builds the request's totals in the same loop — both
 * through `parseManualFacts`. Before this package the customer's «stul 20
 * karobka 60x40x50 300kg» was 50 300 kg to the agent, «iPhone 15 128 kg»
 * 15 128 kg (under the freight tool's 20 000 kg ceiling, so priceable), «har
 * biri 15 kg» the shipment's 15 kg, and «jami 5.9 cbm 507 kgs» nothing at all
 * (critic-agent.json) — and since «o‘zi yuborish» a tool-priced reply may go
 * with no press. An ambiguous figure or one package's figure gives NO
 * candidate: no reference the model could price from.
 *
 * Every expected reference below is written by hand.
 */

function msg(body: string, over: Partial<ChatMessage> = {}): ChatMessage {
  return {
    ref: '#1',
    id: '00000000-0000-4000-8000-000000000001',
    tgMessageId: 1n,
    direction: 'in',
    body,
    media: null,
    fileName: null,
    sentAt: new Date('2026-11-12T10:00:00Z'),
    autoSent: false,
    editedAt: null,
    ...over,
  };
}

/** The candidates of ONE inbound message, as `{ref, kind, value}`. */
const of = (body: string) => measureCandidates([msg(body)]).map(({ ref, kind, value }) => ({ ref, kind, value }));
const w = (value: number, n = 1) => ({ ref: `w${n}`, kind: 'weight', value });
const v = (value: number, n = 1) => ({ ref: `v${n}`, kind: 'volume', value });

function ctxWith(bodies: readonly string[]): AgentContext {
  const messages = bodies.map((body, i) => msg(body, { ref: `#${i + 1}`, tgMessageId: BigInt(i + 1) }));
  const last = messages.at(-1)!;
  return {
    managerUserId: 'u',
    peerId: 1n,
    messages,
    history: messages,
    anchor: last,
    burst: [last],
    lastOut: null,
    identity: { clientId: null, leadId: 'l', strength: 'lead', codes: [], customerName: null, managerName: null, cargoAllowed: false },
    storedLocale: null,
    customerScript: 'latin',
    measures: measureCandidates(messages),
    openCalcs: [],
    lastQuote: null,
    ruleDecision: null,
  };
}

const env = (ctx: AgentContext): ToolEnv => ({
  ctx,
  day: '2026-11-12',
  aviaUsdPerKg: 17,
  kb: async () => [],
  chinaPlaces: async () => new Set(['Yiwu', 'Guangzhou', 'Qashqar']),
});

describe('T16 — measureCandidates: a number is not welded onto its neighbour (T0)', () => {
  it('critic-agent.json: «…60x40x50 300kg» is 300 kg, never 50 300 — after a size the figure is read plainly', () => {
    expect(of('Assalomu alaykum, stul 20 karobka 60x40x50 300kg, qancha boladi?')).toEqual([w(300)]);
    for (const body of ['stul 20 karobka 60х40х50 300кг', 'stul 20 karobka 60*40*50 300 kg', '60x40x50 300kg']) {
      expect(of(body), body).toEqual([w(300)]);
    }
  });

  it('the client’s code is no thousands: «GS777 300 kg» and «GS 777 300 kg» are 300', () => {
    expect(of('GS777 300 kg')).toEqual([w(300)]);
    expect(of('GS 777 300 kg')).toEqual([w(300)]);
  });

  it('a figure with two readings gives no reference — «iPhone 15 128 kg» was 15 128 kg, priceable', () => {
    expect(of('iPhone 15 128 kg')).toEqual([]);
    expect(of('stul 20 300 kg')).toEqual([]);
    // Its cube still stands: 3 m³ is no grouped number.
    expect(of('Redmi 13 256 kg 3 kub')).toEqual([v(3)]);
  });

  it('what the weld never reached reads as it did: «1 200 kg», «jami 1 200 kg 5 kub»', () => {
    expect(of('1 200 kg')).toEqual([w(1200)]);
    expect(of('jami 1 200 kg 5 kub')).toEqual([w(1200), v(5)]);
  });
});

describe('T16 — measureCandidates: totals in the trade’s words (T1, T14)', () => {
  it('critic-agent.json: «jami 5.9 cbm 507 kgs» and «G.W. 1,136.5 kg, 7.19 CBM» gave nothing; both figures now', () => {
    expect(of('jami 5.9 cbm 507 kgs')).toEqual([w(507), v(5.9)]);
    // «1,136.5» — comma groups AND a decimal point: one number, 1136.5.
    expect(of('G.W. 1,136.5 kg, 7.19 CBM')).toEqual([w(1136.5), v(7.19)]);
  });

  it('label-first only after an unambiguous label with «:» (JN-21): «MEAS: 5.92 CBM», «G.W.: 507» — never «G.W. 507» or «Net: 4500»', () => {
    expect(of('MEAS: 5.92 CBM')).toEqual([v(5.92)]);
    expect(of('G.W.: 507')).toEqual([w(507)]);
    expect(of('G.W. 507')).toEqual([]);
    expect(of('Net: 4500')).toEqual([]);
  });

  it('a tonne is 1000 kg: critic-agent.json’s «yuk 2 tonna 12 kub» gave the cube only', () => {
    // 2 × 1000 = 2000 kg.
    expect(of('yuk 2 tonna 12 kub')).toEqual([w(2000), v(12)]);
  });
});

describe('T16 — measureCandidates: one package’s or one piece’s figure is no reference (T4)', () => {
  it('critic-agent.json: «har biri 15 kg» was the shipment’s 15 kg — now no weight at all', () => {
    expect(of('stul 20 karobka, har biri 15 kg, 60x40x50 sm')).toEqual([]);
    expect(of('20 ta karobka 60*40*50 sm har biri 15 kg')).toEqual([]);
  });

  it('a tail, a piece’s mark: «15 kg/ctn», «0.12 cbm/ctn», «Telefon 300 dona, har biri 0.2 kg»', () => {
    expect(of('stul 15 kg/ctn')).toEqual([]);
    expect(of('stul 0.12 cbm/ctn')).toEqual([]);
    expect(of('Telefon 300 dona, har biri 0.2 kg')).toEqual([]);
  });

  it('a per-package figure beside a total leaves the total: «20 karobka, har biri 15 kg, jami 300 kg»', () => {
    expect(of('20 karobka, har biri 15 kg, jami 300 kg')).toEqual([w(300)]);
  });
});

describe('T16 — the review’s own finds reach the agent the same way (typed-break-1, -3, -6)', () => {
  it('a label-first figure with a per-package tail is no reference — «G.W.: 15/ctn» priced 255 $ of avia for a 300 kg cargo', () => {
    expect(of('Yiwudan, stullar 20 karobka, G.W.: 15/ctn, MEAS: 0.12/ctn')).toEqual([]);
    expect(of('毛重: 15/箱, 体积: 0.12/箱')).toEqual([]);
  });

  it('a pack’s grams and a carton’s «each» are no weight: «Choy 500 gr 200 karobka», «Chair 20 ctns, 15 kg each»', () => {
    expect(of('Choy 500 gr 200 karobka')).toEqual([]);
    expect(of('Kofe 250 gr')).toEqual([]);
    expect(of('Chair 20 ctns, 15 kg each')).toEqual([]);
    expect(of('Jacket 300 pcs, 20 ctns, carton weight 22.5 kg')).toEqual([]);
  });

  // Review figures-cbm-rate-as-total: the customer's own price question
  // handed the agent a reference of 1 m³ — beside «300 kg» the pair the
  // yo'lkira tool prices (300 kg / 1 m³ is a rate's base, not his cargo).
  it('a rate’s base and a condition are no reference: «1 cbm narxi qancha?», «10 cbm dan ko‘p bo‘lsa chegirma»', () => {
    expect(of('1 cbm narxi qancha?')).toEqual([]);
    expect(of('Mening yukim 300 kg, 1 kub narxi qancha?')).toEqual([w(300)]);
    expect(of("10 cbm dan ko'p bo'lsa chegirma bormi?")).toEqual([]);
    expect(of('сколько стоит 1 куб?')).toEqual([]);
    // A request for twelve cubes names its cube.
    expect(of('12 kub narxi qancha?')).toEqual([v(12)]);
  });

  // Review seams-1: the footer's weight was the agent's cube reference.
  it('a weight’s figure in a footer is no cube reference: «G.W. 710 CBM 3.8»', () => {
    expect(of('G.W. 710 CBM 3.8')).toEqual([]);
    expect(of('G.W.: 710 CBM 3.8')).toEqual([w(710)]);
    expect(of('TOTAL QTY 980 CBM 3.8')).toEqual([]);
    // Check seams-1: after another field's figure too — no 710 cube reference.
    expect(of('N.W. 650 G.W. 710 CBM 3.8')).toEqual([]);
    expect(of('QTY 980 G.W. 710 CBM 3.8')).toEqual([]);
    expect(of('Мест 60 брутто 710 куб 3.8')).toEqual([]);
  });

  it('…and the yo’lkira tool, handed the chat, finds no weight to price: the checklist asks it', async () => {
    const out = await runTool(
      'calc_checklist',
      { section: 'yolkira', goods: [] },
      env(ctxWith(['Yiwudan Toshkentga, stullar 20 karobka, G.W.: 15/ctn, MEAS: 0.12/ctn'])),
    );
    expect(out.checklist?.facts).toMatchObject({ weightKg: null, volumeM3: null });
  });
});

describe('T16 — the references count per kind across the chat, and the agent’s own lines are not the customer’s', () => {
  it('two inbound messages: w1 and v1, each naming its message; an outbound line is read by nobody', () => {
    const messages = [
      msg('jami 5 kub', { ref: '#1' }),
      msg('300 kg bo‘ladi', { ref: '#2', direction: 'out' }),
      msg('507 kgs', { ref: '#3' }),
    ];
    expect(measureCandidates(messages)).toEqual([
      { ref: 'v1', kind: 'volume', value: 5, messageRef: '#1' },
      { ref: 'w1', kind: 'weight', value: 507, messageRef: '#3' },
    ]);
  });
});

describe('T16 — the checklist’s loop reads the totals with the same readers', () => {
  it('the welded weight is 300, a per-package one none, «cbm»/«kgs» both — the facts the VED is handed', async () => {
    const facts = async (body: string) => {
      const out = await runTool('calc_checklist', { section: 'yolkira', goods: [] }, env(ctxWith([body])));
      return out.checklist?.facts;
    };
    expect(await facts('stul 20 karobka 60x40x50 300kg Yiwudan Toshkentga')).toMatchObject({ weightKg: 300 });
    expect(await facts('stul 20 karobka, har biri 15 kg, Yiwudan Toshkentga')).toMatchObject({ weightKg: null });
    expect(await facts('jami 5.9 cbm 507 kgs, Yiwudan Toshkentga')).toMatchObject({ weightKg: 507, volumeM3: 5.9 });
    expect(await facts('stul 20 300 kg, Yiwudan Toshkentga')).toMatchObject({ weightKg: null });
  });
});

describe('T16 — cargo_volume computes through the kernel (sizeCube)', () => {
  it('20 cartons of 60 × 40 × 50 sm: 0.6 × 0.4 × 0.5 = 0.12 m³ each, × 20 = 2.4 m³', async () => {
    const ctx = ctxWith(['20 karobka, har biri 60x40x50 sm']);
    const out = await runTool('cargo_volume', { count: 20, length_cm: 60, width_cm: 40, height_cm: 50 }, env(ctx));
    expect(out.ok).toBe(true);
    expect(out.text).toBe('d1 = 2.4 kub (20 quti × 60×40×50 sm)');
    expect(out.volume).toEqual({ ref: 'd1', kind: 'volume', value: 2.4, messageRef: 'hisob' });
  });

  it('rounds the kernel’s way, half-up on the decimal: 7 × (10.5 × 10.5 × 10.5 sm = 0.001157625 m³) = 0.008103375 → 0.008', async () => {
    const ctx = ctxWith(['7 quti 10.5x10.5x10.5 sm']);
    const out = await runTool('cargo_volume', { count: 7, length_cm: 10.5, width_cm: 10.5, height_cm: 10.5 }, env(ctx));
    expect(out.volume?.value).toBe(0.008);
  });

  it('a size the customer typed in millimetres vouches for its sides in centimetres: 600 mm = 60 sm', async () => {
    // The policy's number reader takes «600x400x500 mm» for one figure (600);
    // the kernel's size reader gives the three sides, 60 × 40 × 50 sm.
    const ctx = ctxWith(['20 karobka, 600x400x500 mm']);
    const out = await runTool('cargo_volume', { count: 20, length_cm: 60, width_cm: 40, height_cm: 50 }, env(ctx));
    expect(out.volume?.value).toBe(2.4);
  });

  it('keeps its `stated()` check: sides the customer never wrote are refused, never computed', async () => {
    const ctx = ctxWith(['20 karobka bor']);
    const out = await runTool('cargo_volume', { count: 20, length_cm: 60, width_cm: 40, height_cm: 50 }, env(ctx));
    expect(out.ok).toBe(false);
    expect(out.volume).toBeUndefined();
  });
});
