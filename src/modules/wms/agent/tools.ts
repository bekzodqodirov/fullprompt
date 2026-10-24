import { and, eq, inArray } from 'drizzle-orm';
import { htmlToPlain } from '../../platform/telegram/format';
import type { ModelToolSpec } from '../../platform/ai/model';
import { db } from '../../platform/db/client';
import { warehouses } from '../../platform/db/schema';
import { balanceMessages, cargoMessages } from '../client-cabinet/bot-text';
import { cargoOverview, debtSummary } from '../client-cabinet/service';
import { FIELD_LABEL, missingFields, type CalcFacts, type CalcGoodsFact, type CalcSection } from '../calc/intake';
import { parseManualFacts } from '../calc/intake-manual';
import { freightFor } from '../calc/pricing';
import { tariffFor } from '../calc/tariff-read';
import { AVIA_RATE_LABEL } from './config';
import { AGENT_LIMITS } from './limits';
import { AGENT_LOCALES } from './locale';
import { aviaOrigin, namedOrigin, placesOf, quoteOrigin, type QuoteOrigin } from './origin';
import { customerSources, extractNumbers, factSources, type NumberSource } from './numbers';
import { warehouseSentencesText } from './policy';
import { siteEstimate } from './site-estimate';
import type { AgentContext, MeasureCandidate } from './context';
import type { KbHit } from './kb';

/**
 * The agent's tools — a CLOSED literal list (review leak-11). Nothing here
 * imports the staff assistant's toolset, the SQL runner, the bot's staff
 * lookup or the global search (a fence says so): under the owner's actor
 * those read ANY client, and «GS555 qayerda?» typed by one customer would be
 * answered about another.
 *
 * Every tool reads with the IDENTITY the server resolved for this chat
 * (`AgentContext.identity`) — the model passes no client id, no code and no
 * figure it could have invented. A money figure leaves a tool only as a
 * NumberSource of kind 'money' (G1), and only three tools make one: the
 * customer's own balance, the website's yo'lkira figure, and his avia rate
 * times the customer's kilos.
 */

export interface ToolEnv {
  ctx: AgentContext;
  /** Tashkent day, YYYY-MM-DD. */
  day: string;
  /** His avia rate, $/kg (`agent_config.avia_usd_per_kg`); null = avia is not quoted. */
  aviaUsdPerKg: number | null;
  kb: (query: string) => Promise<KbHit[]>;
  /** The places our China warehouses stand in (`ourChinaPlaces`) — asked only by a tool that needs the origin. */
  chinaPlaces: () => Promise<ReadonlySet<string>>;
}

/**
 * What the checklist found. No certificate (his 9, 2026-10-24: «kelib chiqish
 * sertifikati bor, biz o'zimiz olamiz»): the AI never asks about it.
 */
export interface ChecklistState {
  section: CalcSection;
  facts: CalcFacts;
  complete: boolean;
  /** A truck job from China or a place we have no warehouse in: priced from our warehouses, the factory leg extra (his third set «3»). */
  fromOurWarehouse: boolean;
}

export interface ToolOutcome {
  ok: boolean;
  /** What the model reads back. */
  text: string;
  sources: NumberSource[];
  /** Phones and links a used kb fact carries — allowed in the reply (G6). */
  allowedPhones?: string[];
  allowedUrls?: string[];
  usedFactIds?: string[];
  /** A yo'lkira figure is now in the sources (G11 applies). */
  estimate?: boolean;
  /** That figure is our China warehouses' price (his third set «3»): the reply says the condition and the factory leg. */
  fromOurWarehouse?: boolean;
  /** The answers of the kb facts the tool returned — their name words are the facts' (B9). */
  factTexts?: string[];
  /** The website and /admin/tarif disagree for this load (money-3). */
  tariffMismatch?: boolean;
  checklist?: ChecklistState;
  volume?: MeasureCandidate;
}

const obj = (properties: Record<string, unknown>, required: string[] = Object.keys(properties)) => ({
  type: 'object',
  properties,
  required,
  additionalProperties: false,
});

export const SECTIONS = ['yolkira', 'rastamojka', 'podklyuch'] as const;
export const CATEGORIES = ['greeting', 'status', 'faq', 'qualification', 'price', 'complaint', 'other'] as const;
export const NEXT_STEPS = ['qualify', 'quote', 'calc', 'address', 'close', 'wait'] as const;
export const ACTION_TYPES = ['calc_submit', 'set_followup', 'mute'] as const;

export const TOOL_SPECS: ModelToolSpec[] = [
  {
    name: 'cargo_status',
    description:
      "Mijozning o'z yuklari: qayerda turibdi, nechta quti, kg, kub, taxminiy yetib kelish oralig'i. Faqat shu chat mijoziga tegishli kodlar (bir telefondagi kodlar ham). Kirish yo'q.",
    input_schema: obj({}),
  },
  {
    name: 'own_balance',
    description: "Mijozning o'z balansi (qarzi yoki ortiqcha to'lovi) va oxirgi to'lovlari — har kod bo'yicha. Kirish yo'q.",
    input_schema: obj({}),
  },
  {
    name: 'kb_search',
    description:
      "Kompaniya bilimlari: Xitoydagi qabul manzillari, Toshkent ombori, muddatlar, to'lov tartibi, taqiqlangan tovarlar, GS kod qanday ochiladi. Faqat shu yerdagi faktni fakt deb ayt.",
    input_schema: obj({ query: { type: 'string' } }),
  },
  {
    name: 'cargo_volume',
    description:
      "Qutilar soni va bitta qutining o'lchamlaridan (sm) umumiy kubni hisoblaydi. Har bir son mijozning O'Z xabarida yozilgan bo'lishi shart. Natijada «d1» kabi o'lchov havolasi qaytadi — yolkira_estimate uchun.",
    input_schema: obj({
      count: { type: 'number' },
      length_cm: { type: 'number' },
      width_cm: { type: 'number' },
      height_cm: { type: 'number' },
    }),
  },
  {
    name: 'yolkira_estimate',
    description:
      `Faqat yo'lkira (Xitoy → O'zbekiston, mashina) uchun saytdagi kalkulyator narxi. Raqam bermaysan: kontekstdagi o'lchov havolalarini (w1, v1, d1) berasan. Bojxona, QQS bu narxga kirmaydi. Mashina eng kamida ${AGENT_LIMITS.minShipment.m3} kub yoki ${AGENT_LIMITS.minShipment.kg} kg yuk oladi. Rad etsa — hisoblatishga yuborish kerak.`,
    input_schema: obj({ weight_ref: { type: 'string' }, volume_ref: { type: 'string' } }),
  },
  {
    name: 'avia_estimate',
    description:
      `Faqat avia (samolyot, Xitoy → O'zbekiston) yo'lkirasi: og'irlik × avia tarifi ($/kg). Raqam bermaysan: og'irlik havolasini (w1) berasan. Eng kamida ${AGENT_LIMITS.avia.minKg} kg. Muddat taxminan ${AGENT_LIMITS.avia.daysMin}-${AGENT_LIMITS.avia.daysMax} kun, reys bo'lsa ${AGENT_LIMITS.avia.daysMin} kun — va'da emas. Bojxona, QQS bu narxga kirmaydi.`,
    input_schema: obj({ weight_ref: { type: 'string' } }),
  },
  {
    name: 'calc_checklist',
    description:
      "Rastamojka yoki podklyuch (yoki yo'lkira) hisoblatish uchun nima yetishmasligini aytadi. Bo'lim mijoz aytmagan bo'lsa — section bo'sh qoldiriladi va bo'limni so'raysan, o'zing tanlamaysan. Tovar qatorlaridagi har bir son mijoz xabarida bo'lishi shart. Kelib chiqish sertifikatini kompaniya o'zi oladi — so'rama.",
    input_schema: obj({
      section: { type: 'string', enum: ['', ...SECTIONS] },
      goods: {
        type: 'array',
        items: obj({
          name: { type: 'string' },
          quantity: { type: ['number', 'null'] },
          weight_kg: { type: ['number', 'null'] },
        }),
      },
    }),
  },
  {
    name: 'compose_reply',
    description:
      "YAKUNIY javob — har run shu bilan tugaydi. reply_needed=false bo'lsa hech narsa yozilmaydi. Har bir son vositalardan yoki mijoz xabaridan bo'lsin. actions — faqat tasdiqlanganda bajariladi.",
    strict: true,
    input_schema: obj({
      reply_needed: { type: 'boolean' },
      reply_text: { type: 'string' },
      language: { type: 'string', enum: [...AGENT_LOCALES] },
      gloss_uz: { type: 'string' },
      category: { type: 'string', enum: [...CATEGORIES] },
      confidence: { type: 'number' },
      needs_owner: { type: 'boolean' },
      owner_question: { type: 'string' },
      next_step: { type: 'string', enum: [...NEXT_STEPS] },
      actions: {
        type: 'array',
        items: obj({
          type: { type: 'string', enum: [...ACTION_TYPES] },
          section: { type: 'string', enum: ['', ...SECTIONS] },
          cited_message_refs: { type: 'array', items: { type: 'string' } },
          date: { type: 'string' },
          note: { type: 'string' },
        }),
      },
      used_fact_ids: { type: 'array', items: { type: 'string' } },
      cited_message_refs: { type: 'array', items: { type: 'string' } },
    }),
  },
];

/** The customer's own figures — every number they wrote, as values a tool input must match. */
function customerFigures(ctx: AgentContext): number[] {
  return customerSources(ctx.messages.filter((m) => m.direction === 'in').map((m) => ({ text: m.body, label: m.ref }))).map(
    (s) => s.value,
  );
}

const close = (a: number, b: number) => Math.abs(a - b) < 0.005;

/** Every input number must be one the customer wrote (money-2's rule for anything that is not a reference). */
function stated(ctx: AgentContext, values: readonly (number | null | undefined)[]): boolean {
  const figures = customerFigures(ctx);
  return values.every((v) => v === null || v === undefined || figures.some((f) => close(f, v)));
}

/**
 * A tool's own text read for its figures — every one of them the tool's word
 * (B3). A money figure of the balance is a BALANCE (K21), in the currency the
 * text writes it in — «+5 000 000 UZS (≈ 380 $)» is so'm and dollars, not two
 * dollar amounts (K16); one whose currency cannot be told vouches for nothing.
 */
function sourcesOf(text: string, label: string, money: boolean): NumberSource[] {
  return extractNumbers(text).map((f): NumberSource => {
    if (f.kind !== 'money') return { value: f.value, kind: f.kind, label, origin: 'tool' };
    if (!money || !f.currency) return { value: f.value, kind: 'customer_money', label, origin: 'tool' };
    return { value: f.value, kind: 'money', label, origin: 'tool', currency: f.currency, role: 'balance' };
  });
}

/**
 * The newest figure of a kind the customer stated (K21) — the checklist's
 * rule, «the newest statement wins»: a customer who wrote «3 kub, 400 kg» and
 * then «kechirasiz, 0.5 kub 60 kg ekan» means the second, and the tool took
 * any reference that existed, so the model could price the first. A stated
 * volume beats one computed from carton sizes, as in the checklist.
 */
function newestMeasure(ctx: AgentContext, kind: MeasureCandidate['kind']): MeasureCandidate | null {
  const of = ctx.measures.filter((m) => m.kind === kind);
  const stated = of.filter((m) => !m.ref.startsWith('d'));
  return (stated.length > 0 ? stated : of).at(-1) ?? null;
}

/**
 * A message that adds a SECOND load rather than correcting the first (fix
 * round): «yana Guanchjoudan 5 kub 800 kg bor, ikkalasiga narx?», «ещё одна
 * партия», «another 2 cbm», «还有一批». Its figures are a load of their own,
 * and the first stays priceable.
 */
const ADDS_A_LOAD =
  /(?<![\p{L}])(?:yana|tag['‘’ʻ]?in|qo['‘’ʻ]?shimcha|ikkinchi\p{L}*|ikkala\p{L}*|ikkisi\p{L}*|boshqa|яна|тағин|қўшимча|иккинчи\p{L}*|иккала\p{L}*|бошқа|ещ[её]|также|друг(?:ой|ая|ую|ие)|втор(?:ой|ая|ую)|оба|обе|another|also|additional|second|both|plus|دیگر|همچنین|دوم)(?![\p{L}])|还有|另外|另一|再来|第二|两批|هر\s+دو/iu;

/** …unless it says it is a correction: «yana» is also «again» — «Yana o'lchadim, kechirasiz, 0.5 kub ekan». */
const CORRECTS =
  /(?<![\p{L}])(?:kechirasiz|uzr|ekan|aslida|to['‘’ʻ]?g['‘’ʻ]?risi|xato|кечирасиз|экан|асли|извините|ошиб\p{L}*|точнее|sorry|actually|correction|mistake|ببخشید|اشتباه)(?![\p{L}])|на\s+самом\s+деле|抱歉|不好意思|其实|更正/iu;

function addsALoad(ctx: AgentContext, m: MeasureCandidate): boolean {
  const body = ctx.messages.find((x) => x.ref === m.messageRef)?.body ?? '';
  return ADDS_A_LOAD.test(body) && !CORRECTS.test(body);
}

/**
 * Words for the model when a reference it passed is not the customer's newest
 * of its kind; null when every one is. An older reference carrying the SAME
 * figure is no stale one — «40 kg», then «yana 40 kg avia bilan?» states one
 * weight twice, and the price is the same either way.
 *
 * «The newest statement wins» is about a CORRECTION (fix round): a pair
 * taken from one message is one load, and only a later message that is not a
 * second load supersedes it — «Ivudan 3 kub 300 kg», then «yana Guanchjoudan
 * 5 kub 800 kg bor, ikkalasiga narx?» are two loads, and the first was refused
 * as stale. A pair taken from TWO messages is still each its kind's newest, or
 * the weight of one load would be priced with the volume of the other.
 */
function staleRefs(ctx: AgentContext, given: readonly MeasureCandidate[]): string | null {
  const oneLoad = given.length === 1 || given.every((m) => m.messageRef === given[0]!.messageRef);
  for (const m of given) {
    const newest = oneLoad && !m.ref.startsWith('d') ? newestCorrection(ctx, m) : newestMeasure(ctx, m.kind);
    if (newest && newest.ref !== m.ref && !close(newest.value, m.value)) {
      return `${m.ref} eskirgan — mijozning eng oxirgi ${m.kind === 'weight' ? "og'irligi" : 'hajmi'} ${newest.ref} = ${newest.value} ${m.kind === 'weight' ? 'kg' : 'kub'} (${newest.messageRef}). Shu havolani ber.`;
    }
  }
  return null;
}

/** The newest stated figure of `m`'s kind that CORRECTS it — said after it, in a message that adds no load. */
function newestCorrection(ctx: AgentContext, m: MeasureCandidate): MeasureCandidate | null {
  const stated = ctx.measures.filter((x) => x.kind === m.kind && !x.ref.startsWith('d'));
  const after = stated.slice(stated.indexOf(m) + 1).filter((x) => !addsALoad(ctx, x));
  return after.at(-1) ?? null;
}

/**
 * Where the cargo starts, from what the customer wrote (origin.ts
 * `quoteOrigin`): one of our warehouses' cities, China or a place we do not
 * stand in (priced from our warehouses), a western hub, or not said. One set
 * of spellings for this tool, the checklist and the landing's zone.
 */
export function originZone(ctx: AgentContext, ours: ReadonlySet<string>): QuoteOrigin {
  return quoteOrigin(inboundText(ctx), ours);
}

/** Everything the customer wrote in the chat's window — where the places he named are read from. */
function inboundText(ctx: AgentContext): string {
  return ctx.messages.filter((m) => m.direction === 'in').map((m) => m.body).join('\n');
}

/**
 * The places our China warehouses stand in, from the warehouses table — the
 * company's own list of receiving points (his third set «3»: «skladlarimizdan
 * narxi»), never a second one typed here. Active rows only, and only the kinds
 * a customer's cargo is received at (an origin point; a hub like Kashgar, which
 * the seeded «qabul manzillari» fact names too): a closed point, or a customs
 * or distribution yard, is no warehouse a customer can send to.
 */
export async function ourChinaPlaces(): Promise<Set<string>> {
  const rows = await db
    .select({ name: warehouses.name, code: warehouses.code, address: warehouses.address })
    .from(warehouses)
    .where(and(eq(warehouses.country, 'CN'), eq(warehouses.active, true), inArray(warehouses.type, ['origin', 'hub'])));
  return placesOf(rows);
}

export async function runTool(name: string, input: Record<string, unknown>, env: ToolEnv): Promise<ToolOutcome> {
  const { ctx } = env;
  const id = ctx.identity;
  switch (name) {
    case 'cargo_status':
    case 'own_balance': {
      if (!id.clientId) return { ok: false, text: "Bu chat hali mijoz kodiga bog'lanmagan — yuk va balans yo'q.", sources: [] };
      if (!id.cargoAllowed) {
        return { ok: false, text: "Bu chatning raqami mijoz kartasida yo'q — yuk va balansni Bekzodning o'zi aytadi.", sources: [] };
      }
      if (name === 'cargo_status') {
        const parts: string[] = [];
        for (const c of id.codes) {
          const lots = await cargoOverview(c.id);
          parts.push(cargoMessages({ clientCode: c.clientCode, name: '' }, lots, 'uz').map(htmlToPlain).join('\n'));
        }
        const text = parts.join('\n\n');
        return { ok: true, text, sources: sourcesOf(text, 'yuk holati', false) };
      }
      const entries = await Promise.all(id.codes.map(async (c) => ({ clientCode: c.clientCode, debt: await debtSummary(c.id) })));
      const text = balanceMessages(entries, 'uz').map(htmlToPlain).join('\n');
      return { ok: true, text, sources: sourcesOf(text, 'mijozning balansi', true) };
    }
    case 'kb_search': {
      const hits = await env.kb(String(input.query ?? ''));
      if (hits.length === 0) return { ok: true, text: "Bilimlarda topilmadi — o'zingdan aytma, needs_owner.", sources: [] };
      const text = hits.map((h) => `${h.ref}: ${h.answer}`).join('\n');
      return {
        ok: true,
        text,
        // A kb fact is never a MONEY source (money-9), and each is read alone (B2).
        sources: hits.flatMap((h) => factSources(h.answer, `bilim ${h.ref}`)),
        allowedPhones: hits.flatMap((h) => h.phones),
        allowedUrls: hits.flatMap((h) => h.urls),
        usedFactIds: hits.map((h) => h.id),
        factTexts: hits.map((h) => h.answer),
      };
    }
    case 'cargo_volume': {
      const n = Number(input.count);
      const l = Number(input.length_cm);
      const w = Number(input.width_cm);
      const h = Number(input.height_cm);
      if (![n, l, w, h].every((x) => Number.isFinite(x) && x > 0)) return { ok: false, text: "O'lchovlar to'liq emas.", sources: [] };
      if (!stated(ctx, [n, l, w, h])) {
        return { ok: false, text: "Bu sonlar mijoz xabarida yo'q — o'lchamlarni mijozdan so'ra.", sources: [] };
      }
      const m3 = Math.round(((n * l * w * h) / 1_000_000) * 1000) / 1000;
      const ref = `d${ctx.measures.filter((m) => m.ref.startsWith('d')).length + 1}`;
      const volume: MeasureCandidate = { ref, kind: 'volume', value: m3, messageRef: 'hisob' };
      ctx.measures.push(volume);
      return {
        ok: true,
        text: `${ref} = ${m3} kub (${n} quti × ${l}×${w}×${h} sm)`,
        sources: [{ value: m3, kind: 'measure', label: "mijoz o'lchamlaridan hisoblandi", origin: 'tool' }],
        volume,
      };
    }
    case 'yolkira_estimate':
      return yolkira(input, env);
    case 'avia_estimate':
      return avia(input, env);
    case 'calc_checklist':
      return checklist(input, env);
    default:
      return { ok: false, text: `Noma'lum vosita: ${name}`, sources: [] };
  }
}

/**
 * His Q7 ⭐: above these, or at an impossible density, the website's per-m³
 * figure is not a quote — the job goes to hisoblatish. The SMALL end is not
 * here any more: it is the company's own minimum (`AGENT_LIMITS.minShipment`,
 * his 2026-10-24 «eng kamida 1 kub yoki 100 kg»), which is not a reason to
 * calculate but a «we do not carry this».
 */
export const YOLKIRA_GUARDS = { maxM3: 100, maxKg: 20_000, minTotalUsd: 50, minDensity: 1 } as const;

/**
 * Cargo below BOTH halves of the truck's minimum (his «eng kamida 1 kub yoki
 * 100 kg»). Both figures must be KNOWN: a missing one is a question the
 * checklist asks, never a reason to refuse. One rule for the website figure,
 * the hisoblatish checklist and the ✅'s action check — «qabul qilmasin» is
 * about not taking the cargo, whichever door it would come through.
 */
export function belowTruckMinimumFacts(facts: Pick<CalcFacts, 'weightKg' | 'volumeM3'>): boolean {
  const kg = Number(facts.weightKg);
  const m3 = Number(facts.volumeM3);
  return kg > 0 && m3 > 0 && m3 < AGENT_LIMITS.minShipment.m3 && kg < AGENT_LIMITS.minShipment.kg;
}

/** The truck sections — a rastamojka-only job can be avia cargo and is not bound by it. */
export const TRUCK_SECTIONS: readonly CalcSection[] = ['yolkira', 'podklyuch'];

/** Below the truck's minimum: no figure — the minimum itself, as the reply's only numbers. */
function belowTruckMinimum(): ToolOutcome {
  const { m3, kg } = AGENT_LIMITS.minShipment;
  return {
    ok: true,
    text:
      `below_minimum: kompaniya mashina bilan eng kamida ${m3} kub yoki ${kg} kg yuk tashiydi — bu yuk ikkalasidan ham kam. ` +
      `Narx AYTMA. Mijozga uning tilida, xushmuomala qilib, eng kamida ${m3} kub yoki ${kg} kg dan qabul qilishimizni ayt.`,
    sources: [
      { value: m3, kind: 'measure', label: `avto minimal yuk (${m3} kub)`, origin: 'tool' },
      { value: kg, kind: 'measure', label: `avto minimal yuk (${kg} kg)`, origin: 'tool' },
    ],
  };
}

async function yolkira(input: Record<string, unknown>, env: ToolEnv): Promise<ToolOutcome> {
  const { ctx } = env;
  const refuse = (why: string): ToolOutcome => ({
    ok: false,
    text: `Saytdagi narxni aytib bo'lmaydi (${why}) — bu yukni hisoblatishga yuborish kerak (calc_checklist, section yolkira).`,
    sources: [],
  });
  const find = (ref: unknown, kind: MeasureCandidate['kind']) =>
    ctx.measures.find((m) => m.ref === String(ref ?? '').trim() && m.kind === kind) ?? null;
  const weight = find(input.weight_ref, 'weight');
  const volume = find(input.volume_ref, 'volume');
  if (!volume) return refuse("hajm havolasi yo'q");
  if (!weight) return refuse("og'irlik havolasi yo'q");
  // Only the customer's NEWEST figures (K21) — a corrected load is priced as corrected, never as first said.
  const stale = staleRefs(ctx, [weight, volume]);
  if (stale) return { ok: false, text: stale, sources: [] };
  const kg = weight.value;
  const m3 = volume.value;
  // The company's floor comes before every other question: below BOTH halves
  // nothing is accepted, whichever road it would take (his 2026-10-24).
  if (belowTruckMinimumFacts({ weightKg: kg, volumeM3: m3 })) return belowTruckMinimum();
  const origin = originZone(ctx, await env.chinaPlaces());
  if (origin === 'western') return refuse("Qashqar/Urumchi/Xorgos yo'nalishi saytda narxlanmagan");
  if (origin === 'unknown') return refuse("qayerdan jo'natilishi aytilmagan — so'ra");
  // China, or a Chinese place we do not stand in, is priced on the same column FROM our warehouses.
  const fromOurWarehouse = origin === 'our_warehouse';
  const g = YOLKIRA_GUARDS;
  if (!(kg > 0) || !(m3 > 0) || m3 > g.maxM3 || kg > g.maxKg || kg / m3 < g.minDensity) {
    return refuse('juda kichik yoki juda katta yuk');
  }
  const site = siteEstimate({ mode: 'truck', kg, m3, day: env.day });
  if (!site.ok) return refuse(site.reason);
  const e = site.estimate;
  if (e.total < g.minTotalUsd) return refuse("$50 dan kichik");

  // The website's figure must still be the list price the VED would charge
  // (money-3): the table he edits on /admin/tarif, today, China column.
  const list = freightFor(await tariffFor(env.day), { zone: 'cn', weightKg: kg, volumeM3: m3 });
  const same =
    list.ok &&
    Math.abs(list.band.priceUsd - e.rate) < 0.005 &&
    list.band.perKg === (e.unit === 'kg');
  if (!same) {
    return { ...refuse("sayt va /admin/tarif farq qiladi"), tariffMismatch: true };
  }
  const text =
    `Taxminiy yo'lkira (sayt kalkulyatori): ${e.total} $ — ${e.unit === 'kg' ? `${e.rate} $/kg` : `${e.rate} $/kub`}, ` +
    `zichlik ${e.densityKgM3 ?? '—'} kg/kub, ${m3} kub, ${kg} kg; muddat ${e.days[0]}-${e.days[1]} kun (va'da emas). ` +
    `Boj va QQS bu narxga KIRMAYDI.` +
    (fromOurWarehouse
      ? ` Mijoz faqat Xitoyni yoki omborimiz yo'q joyni aytdi — bu narx Xitoydagi OMBORIMIZDAN. Narxni aytsang, mijoz tilida ` +
        `ikkala jumla ham bo'lsin — har tilda aynan shu: ${warehouseSentencesText()}.`
      : '');
  return {
    ok: true,
    text,
    estimate: true,
    ...(fromOurWarehouse ? { fromOurWarehouse: true } : {}),
    sources: [
      // Dollars, and which is the load's price and which the price of one unit (K16, K21).
      { value: e.total, kind: 'money', label: "yo'lkira (sayt kalkulyatori)", origin: 'tool', currency: 'USD', role: 'total' },
      { value: e.rate, kind: 'money', label: "yo'lkira tarifi (sayt)", origin: 'tool', currency: 'USD', role: 'rate' },
      // The website's days are the TRUCK's — never a flight's figure.
      { value: e.days[0], kind: 'duration', label: 'sayt muddati', origin: 'tool', mode: 'road' },
      { value: e.days[1], kind: 'duration', label: 'sayt muddati', origin: 'tool', mode: 'road' },
      { value: m3, kind: 'measure', label: `mijoz ${volume.messageRef}`, origin: 'tool' },
      { value: kg, kind: 'measure', label: `mijoz ${weight.messageRef}`, origin: 'tool' },
      ...(e.densityKgM3 ? [{ value: e.densityKgM3, kind: 'measure' as const, label: 'zichlik (hisob)', origin: 'tool' as const }] : []),
    ],
  };
}

/**
 * Avia (his 2026-10-24: «Avia hozir kg uchun 17$ dan», «avia uchun 1kg
 * minimum», «2-5 kun ichida … reysimiz bolsa 2 kun»): the customer's own
 * kilos, by REFERENCE, times the rate on /suhbatlar/ai. The rate is a money
 * source, the total is one, the days are duration sources — and an estimate,
 * so G11 asks for «taxminan» and «boj, QQS alohida» exactly as on the truck.
 * No rate set = avia is not quoted: refused, and the model asks him.
 *
 * His third set, «1b / 2b» (2026-10-24): NO upper weight bound, and the price
 * is the ACTUAL kilos × the rate — a volume the chat stated never enters it.
 * The review's volumetric refusal (the website's air calculator bills
 * max(kg, m³ × 200)) is gone with that answer.
 */
async function avia(input: Record<string, unknown>, env: ToolEnv): Promise<ToolOutcome> {
  const { ctx } = env;
  const rate = env.aviaUsdPerKg;
  if (rate === null || !(rate > 0)) {
    return {
      ok: false,
      text: "Avia narxi hozir belgilanmagan — narx AYTMA: needs_owner=true, owner_question'da Bekzoddan avia narxini so'ra.",
      sources: [],
    };
  }
  const weight = ctx.measures.find((m) => m.ref === String(input.weight_ref ?? '').trim() && m.kind === 'weight') ?? null;
  if (!weight) return { ok: false, text: "Og'irlik havolasi yo'q — mijozdan yukning og'irligini (kg) so'ra.", sources: [] };
  // The customer's newest kilos only (K21), as on the truck.
  const stale = staleRefs(ctx, [weight]);
  if (stale) return { ok: false, text: stale, sources: [] };
  const kg = weight.value;
  const { minKg, daysMin, daysMax } = AGENT_LIMITS.avia;
  if (!(kg >= minKg)) {
    return {
      ok: true,
      text: `below_minimum: avia eng kamida ${minKg} kg dan qabul qilinadi. Narx AYTMA — mijozga uning tilida shuni ayt.`,
      sources: [{ value: minKg, kind: 'measure', label: `avia minimal yuk (${minKg} kg)`, origin: 'tool' }],
    };
  }
  const total = Math.round(kg * rate * 100) / 100;
  // His third set «3» is the flight's too (K32): cargo that starts at «Xitoy» or a Chinese city we do not
  // stand in flies from OUR warehouse, and the reply says so — the condition and the factory leg — as the
  // truck's does. Kashgar and Urumqi are no refusal here: his rate is one figure from wherever we load it.
  // A flight whose start nobody said is priced from our warehouse too (fix round): «Avia 30 kg qancha?»
  // went out with no condition, and the customer could read it as a pickup from his factory. The truck
  // asks instead, because its price differs by where it starts; his avia rate does not.
  const origin = aviaOrigin(inboundText(ctx), await env.chinaPlaces());
  const fromOurWarehouse = origin !== 'warehouse';
  return {
    ok: true,
    text:
      `Taxminiy avia yo'lkira: ${total} $ (${kg} kg × ${rate} $/kg). Yetib borishi taxminan ${daysMin}-${daysMax} kun, ` +
      `reys bo'lsa ${daysMin} kun — va'da emas. Boj va QQS bu narxga KIRMAYDI.` +
      (fromOurWarehouse
        ? ` ${origin === 'unknown' ? "Mijoz qayerdan jo'natishini aytmadi" : "Mijoz faqat Xitoyni yoki omborimiz yo'q joyni aytdi"} — ` +
          `bu narx Xitoydagi OMBORIMIZDAN. Narxni aytsang, mijoz tilida ` +
          `ikkala jumla ham bo'lsin — har tilda aynan shu: ${warehouseSentencesText()}.`
        : ''),
    estimate: true,
    ...(fromOurWarehouse ? { fromOurWarehouse: true } : {}),
    sources: [
      { value: total, kind: 'money', label: 'avia (tarif × kg)', origin: 'tool', currency: 'USD', role: 'total' },
      { value: rate, kind: 'money', label: AVIA_RATE_LABEL, origin: 'tool', currency: 'USD', role: 'rate' },
      { value: daysMin, kind: 'duration', label: 'avia muddati', origin: 'tool', mode: 'air' },
      { value: daysMax, kind: 'duration', label: 'avia muddati', origin: 'tool', mode: 'air' },
      { value: kg, kind: 'measure', label: `mijoz ${weight.messageRef}`, origin: 'tool' },
    ],
  };
}

async function checklist(input: Record<string, unknown>, env: ToolEnv): Promise<ToolOutcome> {
  const { ctx } = env;
  const section = String(input.section ?? '') as CalcSection | '';
  if (section === '') {
    return {
      ok: true,
      text: "Mijoz faqat yo'lkirani so'rayaptimi yoki bojxona bilan (rastamojka / podklyuch)? Bo'limni o'zing tanlama — so'ra.",
      sources: [],
    };
  }
  const inbound = ctx.messages.filter((m) => m.direction === 'in' && m.body);
  // The newest statement of each total wins: a customer who corrects «5 kub»
  // to «6 kub» means six.
  const facts: CalcFacts = { fromCity: null, toCity: null, weightKg: null, volumeM3: null, goods: [] };
  for (const m of inbound) {
    const f = parseManualFacts(m.body);
    if (f.fromCity) facts.fromCity = f.fromCity;
    if (f.toCity) facts.toCity = f.toCity;
    if (Number(f.weightKg) > 0) facts.weightKg = Number(f.weightKg);
    if (Number(f.volumeM3) > 0) facts.volumeM3 = Number(f.volumeM3);
  }
  const dims = ctx.measures.filter((m) => m.ref.startsWith('d'));
  if (!(Number(facts.volumeM3) > 0) && dims.length > 0) facts.volumeM3 = dims[dims.length - 1]!.value;
  // The place the customer NAMED, when the route parser found none — so the
  // landing can choose a podklyuch zone the way the bot's buttons do
  // (`zoneForOrigin`); a bare «Xitoy» names no zone of its own.
  const origin = originZone(ctx, await env.chinaPlaces());
  if (!facts.fromCity) facts.fromCity = namedOrigin(inbound.map((m) => m.body).join('\n'))?.place ?? null;
  if (!facts.fromCity && (origin === 'warehouse' || origin === 'our_warehouse')) facts.fromCity = 'Xitoy';
  // A truck job that starts at none of our warehouses is priced FROM them (his
  // third set «3»): the landing takes the China column and tells the VED the
  // factory leg is extra.
  const fromOurWarehouse = TRUCK_SECTIONS.includes(section) && origin === 'our_warehouse';
  // The company does not carry it by truck — so it is not collected for the
  // VED either: «hisoblatishga yubordim» would be accepting the cargo.
  if (TRUCK_SECTIONS.includes(section) && belowTruckMinimumFacts(facts)) {
    return { ...belowTruckMinimum(), checklist: { section, facts, complete: false, fromOurWarehouse } };
  }
  const goodsIn = Array.isArray(input.goods) ? (input.goods as Record<string, unknown>[]) : [];
  const goods: CalcGoodsFact[] = [];
  for (const g of goodsIn) {
    const name = String(g.name ?? '').trim();
    if (!name) continue;
    const quantity = g.quantity === null || g.quantity === undefined ? null : Number(g.quantity);
    const weightKg = g.weight_kg === null || g.weight_kg === undefined ? null : Number(g.weight_kg);
    if (!stated(ctx, [quantity, weightKg])) {
      return { ok: false, text: `«${name}» qatoridagi son mijoz xabarida yo'q — so'ra, o'zingdan qo'yma.`, sources: [] };
    }
    goods.push({ name, quantity, weightKg });
  }
  facts.goods = goods;
  // No certificate question (his 9): the company obtains it itself.
  const missing = missingFields(section, facts, new Map()).map((f) => FIELD_LABEL[f]);
  const complete = missing.length === 0;
  const text = complete
    ? `To'liq. ${section}: ${JSON.stringify(facts)}. Endi actions ichida calc_submit taklif qil va mijozga «hisoblatishga yubordim, javob kelishi bilan aytaman» de.` +
      (fromOurWarehouse ? " Yuk omborimiz yo'q joydan: narx Xitoydagi omborimizdan hisoblanadi, zavoddan omborgacha olib kelish alohida — VEDga shunday yoziladi." : '')
    : `Yetishmaydi (hammasini BITTA raqamlangan xabarda so'ra, savol belgisi faqat oxirida): ${missing.map((m, i) => `${i + 1}) ${m}`).join('; ')}`;
  return {
    ok: true,
    text,
    sources: [],
    checklist: { section, facts, complete, fromOurWarehouse },
  };
}
