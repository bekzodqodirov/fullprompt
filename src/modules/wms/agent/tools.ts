import { htmlToPlain } from '../../platform/telegram/format';
import type { ModelToolSpec } from '../../platform/ai/model';
import { balanceMessages, cargoMessages } from '../client-cabinet/bot-text';
import { cargoOverview, debtSummary } from '../client-cabinet/service';
import { FIELD_LABEL, missingFields, type CalcFacts, type CalcGoodsFact, type CalcSection } from '../calc/intake';
import { parseManualFacts } from '../calc/intake-manual';
import { freightFor } from '../calc/pricing';
import { tariffFor } from '../calc/tariff-read';
import { AGENT_LOCALES } from './locale';
import { customerSources, extractNumbers, type NumberSource } from './numbers';
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
 * NumberSource of kind 'money' (G1), and only two tools make one: the
 * customer's own balance and the website's yo'lkira figure.
 */

export interface ToolEnv {
  ctx: AgentContext;
  /** Tashkent day, YYYY-MM-DD. */
  day: string;
  kb: (query: string) => Promise<KbHit[]>;
}

export interface ChecklistState {
  section: CalcSection;
  facts: CalcFacts;
  certificate: 'bor' | 'yoq' | 'bilmaydi' | null;
  complete: boolean;
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
      "Faqat yo'lkira (Xitoy → O'zbekiston, mashina) uchun saytdagi kalkulyator narxi. Raqam bermaysan: kontekstdagi o'lchov havolalarini (w1, v1, d1) berasan. Bojxona, QQS bu narxga kirmaydi. Rad etsa — hisoblatishga yuborish kerak.",
    input_schema: obj({ weight_ref: { type: 'string' }, volume_ref: { type: 'string' } }),
  },
  {
    name: 'calc_checklist',
    description:
      "Rastamojka yoki podklyuch (yoki yo'lkira) hisoblatish uchun nima yetishmasligini aytadi. Bo'lim mijoz aytmagan bo'lsa — section bo'sh qoldiriladi va bo'limni so'raysan, o'zing tanlamaysan. Tovar qatorlaridagi har bir son mijoz xabarida bo'lishi shart.",
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
      certificate: { type: 'string', enum: ['', 'bor', 'yoq', 'bilmaydi'] },
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

function sourcesOf(text: string, label: string, money: boolean): NumberSource[] {
  return extractNumbers(text).map((f) => ({
    value: f.value,
    kind: f.kind === 'money' ? (money ? 'money' : 'customer_money') : f.kind,
    label,
  }));
}

const ORIGIN_OTHER = /kashg|qashq|кашг|қашқ|urumch|урумч|horgo|xorgo|хорго|喀什|乌鲁木齐|霍尔果斯/iu;
const ORIGIN_CN =
  /xitoy|хитой|китай|china|چین|中国|yiwu|иву|guangzhou|гуанчжоу|guanchjou|foshan|shenzhen|шэньчжэнь|shanghai|шанхай|beijing|пекин|ningbo|нинбо|义乌|广州|佛山|深圳|上海/iu;

/** Where the cargo starts, from what the customer wrote: China's coast, a western hub, or not said. */
export function originZone(ctx: AgentContext): 'cn' | 'other' | 'unknown' {
  const text = ctx.messages.filter((m) => m.direction === 'in').map((m) => m.body).join('\n');
  if (ORIGIN_OTHER.test(text)) return 'other';
  if (ORIGIN_CN.test(text)) return 'cn';
  return 'unknown';
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
        // A kb fact is never a MONEY source (money-9): a price lives in recordOffer, not in the kb.
        sources: hits.flatMap((h) => sourcesOf(h.answer, `bilim ${h.ref}`, false)),
        allowedPhones: hits.flatMap((h) => h.phones),
        allowedUrls: hits.flatMap((h) => h.urls),
        usedFactIds: hits.map((h) => h.id),
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
        sources: [{ value: m3, kind: 'measure', label: "mijoz o'lchamlaridan hisoblandi" }],
        volume,
      };
    }
    case 'yolkira_estimate':
      return yolkira(input, env);
    case 'calc_checklist':
      return checklist(input, env);
    default:
      return { ok: false, text: `Noma'lum vosita: ${name}`, sources: [] };
  }
}

/** His Q7 ⭐: below these, or above, the website's per-m³ figure is not a quote — the job goes to hisoblatish. */
export const YOLKIRA_GUARDS = { minM3: 0.1, maxM3: 100, maxKg: 20_000, minTotalUsd: 50, minDensity: 1 } as const;

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
  const zone = originZone(ctx);
  if (zone === 'other') return refuse("Qashqar/Urumchi/Xorgos yo'nalishi saytda narxlanmagan");
  if (zone === 'unknown') return refuse("qayerdan jo'natilishi aytilmagan — so'ra");
  const kg = weight.value;
  const m3 = volume.value;
  const g = YOLKIRA_GUARDS;
  if (!(kg > 0) || m3 < g.minM3 || m3 > g.maxM3 || kg > g.maxKg || kg / m3 < g.minDensity) {
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
    `Boj va QQS bu narxga KIRMAYDI.`;
  return {
    ok: true,
    text,
    estimate: true,
    sources: [
      { value: e.total, kind: 'money', label: "yo'lkira (sayt kalkulyatori)" },
      { value: e.rate, kind: 'money', label: "yo'lkira tarifi (sayt)" },
      { value: e.days[0], kind: 'duration', label: 'sayt muddati' },
      { value: e.days[1], kind: 'duration', label: 'sayt muddati' },
      { value: m3, kind: 'measure', label: `mijoz ${volume.messageRef}` },
      { value: kg, kind: 'measure', label: `mijoz ${weight.messageRef}` },
      ...(e.densityKgM3 ? [{ value: e.densityKgM3, kind: 'measure' as const, label: 'zichlik (hisob)' }] : []),
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
  if (!facts.fromCity && originZone(ctx) === 'cn') facts.fromCity = 'Xitoy';
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
  const certificate = (['bor', 'yoq', 'bilmaydi'] as const).find((c) => c === input.certificate) ?? null;
  const missing = missingFields(section, facts, new Map()).map((f) => FIELD_LABEL[f]);
  const needsCert = section !== 'yolkira';
  if (needsCert && certificate === null) missing.push("kelib chiqish sertifikati (bor / yo'q / bilmaydi)");
  const complete = missing.length === 0;
  const text = complete
    ? `To'liq. ${section}: ${JSON.stringify({ ...facts, certificate })}. Endi actions ichida calc_submit taklif qil va mijozga «hisoblatishga yubordim, javob kelishi bilan aytaman» de.`
    : `Yetishmaydi (hammasini BITTA raqamlangan xabarda so'ra, savol belgisi faqat oxirida): ${missing.map((m, i) => `${i + 1}) ${m}`).join('; ')}`;
  return {
    ok: true,
    text,
    sources: [],
    checklist: { section, facts, certificate, complete },
  };
}
