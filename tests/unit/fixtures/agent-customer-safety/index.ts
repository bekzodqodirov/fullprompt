import { AVIA_DAYS_DEFAULT } from '@/modules/platform/settings/service';
import type { AgentLocale } from '@/modules/wms/agent/locale';
import type { ToolOutcome } from '@/modules/wms/agent/tools';
import cases1 from './cases.json';
import cases2 from './cases2.json';
import cases3 from './cases3.json';
import cases4 from './cases4.json';
import cases5 from './cases5.json';
import cases6 from './cases6.json';

/**
 * The 303 dangerous first replies of DECISIONS #1619 — written by the checkers on purpose, never seen from the model —
 * kept as they were measured (copied verbatim from docs/ai-toliq/corpora/customer-safety/, which is the design's
 * record). Stage 1a's kernel K1 judges each against the rules of its HEAD and commits the answer
 * (`agent-customer-safety-walls.ts`): a case held then must stay held by a wall 1a keeps, and the cases NO wall held
 * are the owner's question 82 before the gate is relaxed (STAGE-0-1A.md §4.1 «K1, as measured», §6.3).
 *
 * The files reuse ids (`k1` is a customs promise in cases.json and a bare kb figure in cases2.json), so a case is
 * named `<file>/<id>` here and everywhere the snapshot speaks of it.
 */
export interface SafetyCase {
  /** `<file>/<id>`, e.g. `cases2/k1`. */
  key: string;
  /** The corpus's context key: a language, or a language with the chat it was written for (`uzc`, `uza`, `uzm` …). */
  lang: string;
  cat: string;
  reply: string;
  /** The customer's language where it differs from the reply's (the `script` rows). */
  chatLang?: string;
  gloss?: string;
  tool?: string;
}

interface RawCase {
  id: string;
  lang: string;
  cat: string;
  reply: string;
  chatLang?: string;
  gloss?: string;
  tool?: string;
}

const FILES: ReadonlyArray<readonly [string, readonly RawCase[]]> = [
  ['cases', cases1],
  ['cases2', cases2],
  ['cases3', cases3],
  ['cases4', cases4],
  ['cases5', cases5],
  ['cases6', cases6],
];

export const SAFETY_CASES: readonly SafetyCase[] = FILES.flatMap(([file, rows]) =>
  rows.map((c) => ({ key: `${file}/${c.id}`, lang: c.lang, cat: c.cat, reply: c.reply, chatLang: c.chatLang, gloss: c.gloss, tool: c.tool })),
);

/**
 * The corpus's own controls: replies that are RIGHT and must go (the allowed «to'lov … yukni olishdan oldin», the
 * customer's own figures read back, a correct avia quote) or that the checkers wrote to stand where they stand. 1a
 * moves none of them in either direction, so they are never on the «open» list.
 */
export const isControl = (c: SafetyCase): boolean => c.cat === 'control' || c.cat === 'credit_p10_control';

/** The customer's lines a reply in each language answers — the reader corpus's own `LINES`, restated per language. */
const OPENING: Record<AgentLocale, readonly string[]> = {
  uz: ['Assalomu alaykum', 'yuk bor', 'narxi qancha', 'Xitoydan'],
  uz_cyrl: ['Ассалому алайкум', 'юк бор', 'нархи қанча', 'Хитойдан'],
  ru: ['Здравствуйте', 'есть груз', 'сколько стоит', 'из Китая'],
  en: ['Hello', 'I have cargo', 'how much', 'from China'],
  fa: ['سلام', 'بار دارم', 'قیمت چند است', 'از چین'],
  zh: ['你好', '我有货', '多少钱', '从中国'],
};

/** cases3 (`uzm`, `rum`, `enm`): a chat in which the CUSTOMER stated «5 kub … 800 kg» — 5 and 800 are his figures. */
const STATED: Partial<Record<AgentLocale, string>> = { uz: '5 kub, 800 kg', ru: '5 куб, 800 кг', en: '5 cbm, 800 kg' };

/** cases6 (`uza`, `rua`, `ena`, tool `avia20`): the customer asked the flight for 20 kg. */
const AIR_ASK: Partial<Record<AgentLocale, string>> = { uz: 'avia bilan 20 kg', ru: 'авиа 20 кг', en: 'by air 20 kg' };

/** The run behind cases6: the avia estimate for 20 kg at the tariff's 17 $/kg — 340 $ (critic-guard.md, the corpus note). */
const AVIA20: ToolOutcome = {
  ok: true,
  text: '',
  estimate: true,
  air: { kg: 20, origin: null },
  priced: { tool: 'avia_estimate', kg: 20, m3: null, zone: null, day: '2026-11-11', total: 340, rate: 17, unit: 'kg' },
  // As the avia tool writes them (tools.ts, the avia estimate): every source names the tool, or the gate cannot tell
  // an estimate's line from a figure nobody vouched for.
  sources: [
    { value: 340, kind: 'money', label: 'avia (tarif × kg)', origin: 'tool', tool: 'avia_estimate', currency: 'USD', role: 'total' },
    { value: 17, kind: 'money', label: 'avia tarifi', origin: 'tool', tool: 'avia_estimate', currency: 'USD', role: 'rate' },
    // The flight's days the tool writes are the run's own (stage 1a P7, `agent_avia_days`) — the shipped default here.
    { value: AVIA_DAYS_DEFAULT.min, kind: 'duration', label: 'avia muddati', origin: 'tool', tool: 'avia_estimate', mode: 'air' },
    { value: AVIA_DAYS_DEFAULT.max, kind: 'duration', label: 'avia muddati', origin: 'tool', tool: 'avia_estimate', mode: 'air' },
    { value: 20, kind: 'measure', label: 'mijoz #5', origin: 'tool', tool: 'avia_estimate' },
  ],
};

const LOCALE_OF: Record<string, AgentLocale> = { uz: 'uz', uzc: 'uz_cyrl', ru: 'ru', en: 'en', fa: 'fa', zh: 'zh' };

export interface SafetyChat {
  /** The language the reply is written in. */
  reply: AgentLocale;
  /** The customer's lines before it. */
  lines: readonly string[];
  /** What the run's tools answered. */
  outcomes: ToolOutcome[];
}

/**
 * The chat a case was written for. The corpus's `lang` is a CONTEXT key, not always a language (the dry run of
 * 2026-11-20 judged 37 rows in the wrong chat with `LINES[lang]` alone): `uzc` is Uzbek Cyrillic; a trailing `m` is a
 * chat where the customer stated his figures; a trailing `a` a chat whose run quoted the flight; `chatLang` is the
 * customer's language where the reply's differs from it (the `script` rows).
 */
export function chatOf(c: SafetyCase): SafetyChat {
  const base = /^(uz|ru|en)[ma]$/u.test(c.lang) ? c.lang.slice(0, 2) : c.lang;
  const reply = LOCALE_OF[base];
  if (!reply) throw new Error(`${c.key}: unknown lang ${c.lang}`);
  const customer = c.chatLang ? LOCALE_OF[c.chatLang] : reply;
  if (!customer) throw new Error(`${c.key}: unknown chatLang ${c.chatLang}`);
  const lines = [...OPENING[customer]];
  if (c.lang.endsWith('m') && c.lang.length === 3) return { reply, lines: [...lines, STATED[reply]!], outcomes: [] };
  if (c.lang.endsWith('a') && c.lang.length === 3) {
    if (c.tool !== 'avia20') throw new Error(`${c.key}: an avia chat with tool ${c.tool}`);
    return { reply, lines: [...lines, AIR_ASK[reply]!], outcomes: [AVIA20] };
  }
  return { reply, lines, outcomes: [] };
}
