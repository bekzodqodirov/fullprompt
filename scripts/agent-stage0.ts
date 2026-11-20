import 'dotenv/config';
import { pgClient } from '../src/modules/platform/db/client';
import { approxMicroUsd } from '../src/modules/platform/ai/model';
import { AGENT_SEAT_KEY } from '../src/modules/platform/settings/agent-seat';
import { addDays, calendarDay, tashkentDay, tashkentDayStart } from '../src/modules/platform/time/tashkent';
import {
  AUTO_LANGUAGES,
  AUTO_STRICT_LANGUAGES,
  CALC_PRICE_TOOL_NAME,
  MONEY_TOOLS,
  isCalcSubmitOnly,
  type AutoLedgerLine,
  type AutoToolCall,
} from '../src/modules/wms/agent/auto-gate';
import { isEstimateTool } from '../src/modules/wms/agent/auto-money';
import { censusDays, mediaWord, type CensusMessage } from '../src/modules/wms/agent/census';
import { currencyBesideQuantity } from '../src/modules/wms/agent/digits';
import { AGENT_LIMITS } from '../src/modules/wms/agent/limits';
import { draftWorthy } from '../src/modules/wms/agent/worthy';

/**
 * Stage 0 of the full AI seller (docs/ai-toliq/qurish/STAGE-0-1A.md §4.0 (b)) — the four numbers the
 * stage is decided by, measured on HIS server before a line of product code moves. READ-ONLY:
 *
 *   docker compose run --rm migrate pnpm exec tsx scripts/agent-stage0.ts verdicts [--day 2026-11-15] [--user <uuid>] [--night-prices table]
 *   docker compose run --rm migrate pnpm exec tsx scripts/agent-stage0.ts media    [--days 14] [--user <uuid>]
 *   docker compose run --rm migrate pnpm exec tsx scripts/agent-stage0.ts audience [--user <uuid>]
 *   docker compose run --rm migrate pnpm exec tsx scripts/agent-stage0.ts volume   [--days 14] [--user <uuid>]
 *
 * `verdicts` — the gate's stored refusals of one Tashkent day, and per draft what stage 1a would still
 * hold it for: the «9 tadan nechta» number of the page (a range when his ✏️ erased what an answer hangs on), and his
 * ticks and floors as stored.
 * `media` — how many customer bursts carry a photo, a file, a voice note, a medium nothing was stored for (a link
 * preview, a sticker), or nothing but those (the eyes and ears of stage 2 are sized by it). `audience` — who writes to the account. `volume` — a day's load.
 *
 * The whole run is ONE transaction opened READ ONLY — postgres refuses any write a bug could try — so
 * the first line it prints says so. The helpers live here and import only pure functions from src
 * (the census's own burst rule, `draftWorthy`, the gate's exported lists); nothing here sends or
 * enqueues. Not a package.json command on purpose (#1228): `migrate` is the image that carries tsx.
 */

const USAGE =
  'usage: pnpm exec tsx scripts/agent-stage0.ts <verdicts|media|audience|volume>\n' +
  '         [--day YYYY-MM-DD]   verdicts only — a Tashkent day (default 2026-11-15)\n' +
  '         [--night-prices none|table|all]  verdicts only — 1a\'s night rule to judge by (default: the stored\n' +
  '                              agent_night_prices, else table, the ⭐ of question 1)\n' +
  '         [--days N]           media, volume — 1-90 Tashkent days back from today (default 14)\n' +
  '         [--user <uuid>]      the account to read (default: the AI sotuvchi holder, agent_config.owner_user_id)';

const COMMANDS = ['verdicts', 'media', 'audience', 'volume'] as const;
type Command = (typeof COMMANDS)[number];

/** The seat's first production day (DECISIONS #1800): nine replies, all waited — the day the page asks about. */
const DEFAULT_DAY = '2026-11-15';

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/iu;

/** `agent_night_prices` (plan §3.3) — which price classes 1a lets go 22:00-08:00. Question 1; `table` is its ⭐. */
const NIGHT_PRICES = ['none', 'table', 'all'] as const;
type NightPrices = (typeof NIGHT_PRICES)[number];
const NIGHT_PRICES_STAR: NightPrices = 'table';
const isNightPrices = (v: unknown): v is NightPrices => (NIGHT_PRICES as readonly unknown[]).includes(v);

interface Args {
  cmd: Command;
  day: string;
  days: number;
  user: string | null;
  /** Only from the flag; null = read the stored setting, else the ⭐. */
  nightPrices: NightPrices | null;
}

/** A flag a command does not read is refused, not ignored: «--day» on `volume` would read like a filter that never ran. */
function parseArgs(argv: string[]): Args | null {
  const cmd = argv[0];
  if (!(COMMANDS as readonly string[]).includes(cmd ?? '')) return null;
  const args: Args = { cmd: cmd as Command, day: DEFAULT_DAY, days: 14, user: null, nightPrices: null };
  for (let i = 1; i < argv.length; i++) {
    const a = argv[i]!;
    if (a === '--day' && args.cmd === 'verdicts') {
      const d = calendarDay(argv[++i]);
      if (!d) return null;
      args.day = d;
    } else if (a === '--night-prices' && args.cmd === 'verdicts') {
      const v = argv[++i];
      if (!isNightPrices(v)) return null;
      args.nightPrices = v;
    } else if (a === '--days' && (args.cmd === 'media' || args.cmd === 'volume')) {
      const n = Number(argv[++i]);
      if (!Number.isInteger(n) || n < 1 || n > 90) return null;
      args.days = n;
    } else if (a === '--user') {
      const id = argv[++i] ?? '';
      if (!UUID.test(id)) return null;
      args.user = id.toLowerCase();
    } else {
      return null;
    }
  }
  return args;
}

type Q = Parameters<Parameters<typeof pgClient.begin>[1]>[0];

/** A table a database one migration behind does not have yet — said, never a crash. */
async function tableExists(q: Q, name: string): Promise<boolean> {
  const [row] = await q<{ ok: boolean }[]>`SELECT to_regclass(${`public.${name}`}) IS NOT NULL AS ok`;
  return row?.ok === true;
}

const pad = (v: string | number, n: number) => String(v).padStart(n);
const num = (v: unknown) => (v === null || v === undefined ? 0 : Number(v));
const show = (v: unknown) => (v === null || v === undefined ? 'NULL' : String(v));

/** At most `n` code points of a text on one line — never half an emoji (#1115's `clipText` lesson). */
function clip(text: string, n: number): string {
  const one = text.replace(/\s+/gu, ' ').trim();
  const chars = [...one];
  return chars.length <= n ? one : `${chars.slice(0, n).join('')}…`;
}

// ── the holder ─────────────────────────────────────────────────────────────────────────────────────────

/** `--user`, else the AI sotuvchi's holder as stored (the column `readAgentConfig` reads), read inside the transaction. */
async function accountOf(q: Q, user: string | null): Promise<string | null> {
  if (user) return user;
  if (!(await tableExists(q, 'agent_config'))) return null;
  const [row] = await q<{ owner: string | null }[]>`SELECT owner_user_id::text AS owner FROM agent_config WHERE id = 1`;
  return row?.owner ?? null;
}

// ── verdicts ───────────────────────────────────────────────────────────────────────────────────────────

/** The run's stored tool calls as the gate reads them — `auto-send.ts` `toolCallsOf` (:181), restated: that module presses. */
function toolCallsOf(raw: unknown): AutoToolCall[] {
  if (!Array.isArray(raw)) return [];
  return raw
    .filter((t): t is { name: unknown; ok: unknown; estimate?: unknown } => typeof t === 'object' && t !== null)
    .map((t) => ({
      name: typeof t.name === 'string' ? t.name : '',
      ok: t.ok === true,
      // A call stored before 0148 carries no flag and reads as a PRICED estimate (fails closed), as the gate reads it.
      estimate: typeof t.estimate === 'boolean' ? t.estimate : true,
    }));
}

/** The stored ledger as the gate reads it — `auto-send.ts` `ledgerLinesOf` (:193), restated for the same reason. */
function ledgerLinesOf(raw: unknown): AutoLedgerLine[] {
  if (!Array.isArray(raw)) return [];
  const str = (v: unknown) => (typeof v === 'string' ? v : null);
  return raw
    .filter((e): e is Record<string, unknown> => typeof e === 'object' && e !== null)
    .map((e) => ({ kind: str(e.kind) ?? '', origin: str(e.origin), tool: str(e.tool), role: str(e.role) }));
}

type Guess = { locale: string | null; confident: boolean; leans?: boolean } | null;

/** `policy.memory.customerLocale` (policy-input.ts:75) — anything not shaped like it reads as «not stored». */
function guessOf(raw: unknown): Guess {
  if (typeof raw !== 'object' || raw === null) return null;
  const g = raw as { locale?: unknown; confident?: unknown; leans?: unknown };
  return {
    locale: typeof g.locale === 'string' ? g.locale : null,
    confident: g.confident === true,
    ...(typeof g.leans === 'boolean' ? { leans: g.leans } : {}),
  };
}

type DraftClass = 'talk' | 'price' | 'calc_price' | 'calc';

/**
 * Stage 1a's class of a draft (plan §4.1 K6 `autoClassOf`), from what is stored. `auto-gate.ts` `moneyVerdict`
 * (:484) is module-private, so its `present` / `calcPriced` / `estimateMoney` are restated here line for line over
 * the stored ledger, `memory.hasEstimate` and the run's tool calls — the PROXY the plan's «money-free» means. It
 * fails closed the way K6 does: any money present, a money word the gate could not read (`money_unread`,
 * `numeral_unread` as the gate stored them, or a currency beside a quantity in the words), or any act but a
 * follow-up makes the draft NOT talk.
 */
function classOf(input: {
  actionTypes: readonly string[];
  tools: readonly AutoToolCall[];
  ledger: readonly AutoLedgerLine[];
  hasEstimate: boolean;
  reasons: readonly string[];
  body: string;
}): DraftClass {
  if (isCalcSubmitOnly(input.actionTypes)) return 'calc';
  const calls = input.tools.filter((t) => (MONEY_TOOLS as readonly string[]).includes(t.name));
  const noPrice = (t: AutoToolCall) => isEstimateTool(t.name) && t.ok && !t.estimate;
  const lines = input.ledger.filter((l) => l.kind === 'money');
  const calcLine = (l: AutoLedgerLine) => l.origin === 'tool' && l.tool === CALC_PRICE_TOOL_NAME && l.role === 'total';
  const priced = input.hasEstimate || calls.some((t) => t.ok && t.estimate);
  const calcPriced = input.tools.some((t) => t.name === CALC_PRICE_TOOL_NAME && t.ok) || lines.some(calcLine);
  const present = lines.length > 0 || priced || calcPriced || calls.some((t) => !noPrice(t));
  const estimateMoney = priced || calls.some((t) => !noPrice(t)) || lines.some((l) => !calcLine(l));
  if (present && calcPriced && !estimateMoney) return 'calc_price';
  const unread = input.reasons.includes('money_unread') || input.reasons.includes('numeral_unread') || currencyBesideQuantity(input.body);
  if (present || unread) return 'price';
  if (input.actionTypes.some((a) => a !== 'set_followup')) return 'price';
  return 'talk';
}

/** A money line nobody vouched for as a VED total — a balance, a fact's price, a table figure. */
const ANY_MONEY_LINE: AutoLedgerLine = { kind: 'money', origin: null, tool: null, role: null };
/** A VED price's total (`calcLine` above). */
const VED_TOTAL_LINE: AutoLedgerLine = { kind: 'money', origin: 'tool', tool: CALC_PRICE_TOOL_NAME, role: 'total' };

/**
 * The classes a draft his ✏️ rewrote MAY have had. `submitOwnText` (decide.ts:1455-1462) keeps the AI's words in
 * `proposed_body` and leaves the memory and the notes as they were, but writes `ledger: []` over the policy — so
 * whether the AI's reply carried a money line is gone. `classOf` asks of the ledger only whether a money line is a
 * VED total and whether one is not, so every ledger the reply could have had lands on one of three: none, an ordinary
 * money line (a VED total beside it changes nothing — the reply is `price` either way), a VED total alone.
 */
function classesWithLedgerLost(input: Omit<Parameters<typeof classOf>[0], 'ledger'>): DraftClass[] {
  return [...new Set([[], [ANY_MONEY_LINE], [VED_TOTAL_LINE]].map((ledger) => classOf({ ...input, ledger })))];
}

const NEAR_LANGUAGES = ['uz', 'uz_cyrl', 'ru'];

/**
 * §6.2's `language` for a TALK draft: a confident read of that very language; an unconfident read of uz / uz_cyrl /
 * ru admits any of those three; no language shown (`locale === null`) admits uz only. Still held: no stored guess,
 * a confident mismatch, en / fa / zh without a confident read, a label outside the six.
 */
function talkLanguageAdmits(language: string | null, guess: Guess): boolean {
  const lang = language ?? '';
  if (!(AUTO_LANGUAGES as readonly string[]).includes(lang)) return false;
  if (guess === null) return false;
  if (guess.locale === null) return lang === 'uz';
  if (guess.confident) return guess.locale === lang;
  if ((AUTO_STRICT_LANGUAGES as readonly string[]).includes(lang)) return false;
  return NEAR_LANGUAGES.includes(guess.locale) && NEAR_LANGUAGES.includes(lang);
}

/** The late card's line (card.ts `lateNote`, :425) — the one note 1a lets through (K6 `EYE_ONLY_NOTES = ['late']`). */
const LATE_NOTE = /^⏱ Mijoz/u;

/** The one warning 1a lets through (K6 `EYE_ONLY_WARNINGS`), at the gate and at the press alike (§4.2 `:371`). */
const EYE_ONLY_WARNINGS: readonly string[] = ['questions'];
const eyeOnly = (codes: readonly string[]) => codes.length > 0 && codes.every((c) => EYE_ONLY_WARNINGS.includes(c));

/**
 * The calculation's card lines (calc-submit.ts:160 the 14-day line, calc-files.ts `missingFilesNote`): `run.ts`
 * (:568, :2005) appends them to the stored notes AFTER the gate judged — so they were never what `notes` refused,
 * and a late line beside them must not read as «another note». Only ever on a plan refused `calc_recent` /
 * `calc_file_missing`, which stay.
 */
const CALC_CARD_NOTES = [/^🧮 14 kun ichida shu chatdan hisoblatish bor/u, /^📎 .+ dagi .+ saqlanmagan — ✅ bossangiz faylsiz yuboriladi/u];
const gateNotesOf = (notes: readonly string[]) => notes.filter((n) => !CALC_CARD_NOTES.some((re) => re.test(n)));

/** §6.2's night by class: `calc` always barred, `calc_price` unless `all`, `price` only under `none`, `talk` never. */
function nightBars(cls: DraftClass, nightPrices: NightPrices): boolean {
  switch (cls) {
    case 'calc':
      return true;
    case 'calc_price':
      return nightPrices !== 'all';
    case 'price':
      return nightPrices === 'none';
    case 'talk':
      return false;
  }
}

/**
 * The reasons that would STILL hold the draft under 1a — removed: `low_confidence`, `streak` (its slot goes to the
 * loop detector, which nothing stored can judge), `category` (kept, as `complaint`, only on the complaint label),
 * `warnings` when every stored warning is `questions`, `notes` when every note the gate saw is the late line, `night`
 * for a class the chosen setting does not bar (§6.2), and `language` for a talk draft by §6.2. A machine press that
 * lost INSIDE its approval (`auto-send.ts` `pressOne`, :907-911) writes its code to `outcome` and leaves `reasons` as
 * the scheduling stored them (empty — it was admitted): that code is a reason too, `press:<code>`, kept unless it is
 * `auto_warning` over `questions` alone. A countdown that a person or the chat ended before the press — 'stopped'
 * (⏸, ✏️, ❌, 🙋, ✍️, 📝, a disarm: auto-send.ts :764, :1100-1105, config.ts :254, decide.ts :789) or 'gone'
 * (superseded :1078-1082, no longer pending :859, `not_live` :910) — is `held:<outcome>` for every class but talk:
 * 1a keeps `agent_auto_config.hold_sec` for them, so the same stop lands inside the same hold again. Talk goes at
 * once under 1a, before any stop could land, and is judged as before (the Eslatma says so). Nothing new is ADDED:
 * 1a's `loop` and complaint reader are not judged here.
 */
function reasonsLeft(input: {
  reasons: readonly string[];
  state: string | null;
  outcome: string | null;
  category: string | null;
  warningCodes: readonly string[] | null;
  notes: readonly string[] | null;
  cls: DraftClass;
  language: string | null;
  guess: Guess;
  nightPrices: NightPrices;
  /** The AI's own words reached the customer: approved with no text of his (`final_body` NULL). */
  aiWordsWent: boolean;
}): string[] {
  const left: string[] = [];
  for (const r of input.reasons) {
    if (r === 'low_confidence' || r === 'streak') continue;
    if (r === 'category') {
      if (input.category === 'complaint') left.push('complaint');
      continue;
    }
    if (r === 'warnings' && input.warningCodes !== null && eyeOnly(input.warningCodes)) continue;
    if (r === 'notes' && input.notes !== null) {
      const seen = gateNotesOf(input.notes);
      if (seen.length > 0 && seen.every((n) => LATE_NOTE.test(n))) continue;
    }
    if (r === 'night' && !nightBars(input.cls, input.nightPrices)) continue;
    if (r === 'language' && input.cls === 'talk' && talkLanguageAdmits(input.language, input.guess)) continue;
    left.push(r);
  }
  if (input.state === 'refused' && input.reasons.length === 0 && input.outcome) {
    // `code` or `code:detail` (sliced to 300 — a cut code list ends in a fragment that is not `questions`: kept).
    const [code = '', detail] = input.outcome.split(/:(.*)/su);
    if (!(code === 'auto_warning' && detail !== undefined && eyeOnly(detail.split(',')))) left.push(`press:${code}`);
  }
  // His ✅ during the countdown (`owner_send`, decide.ts :966 / auto-send.ts :764) — or ✏️ with nothing typed, then ✅
  // (the row keeps `owner_edit`, decide.ts :1035-1038) — sent the AI's own words: under 1a the hold ends in the same
  // press, so that is not a stop.
  const stoppedByHim = (input.state === 'stopped' || input.state === 'gone') && input.outcome !== 'owner_send' && !input.aiWordsWent;
  if (stoppedByHim && input.cls !== 'talk') left.push(`held:${input.outcome ?? input.state}`);
  return left;
}

type Judged = { kind: 'goes' } | { kind: 'held'; left: string[] } | { kind: 'unknown'; maybe: string[] };

/** Stands for a warning code his ✏️ erased that was not `questions` — any code `eyeOnly` does not let through. */
const ERASED_WARNING = '?';

/**
 * 1a's answer for one draft, from every reading of what his ✏️ erased. Not edited: one reading. Edited: the AI's
 * stored `reasons` are still the AI's (the verdict row is written in `createDraft`'s transaction, before any ✏️), but
 * `policy.warnings` is now HIS text's (`ownerPolicyFor`) and the ledger is empty — so `warnings` is judged both ways
 * (every erased code `questions`, or one that is not) and the class over `classesWithLedgerLost`. The readings are
 * ordered (talk's leftover ⊆ price's ⊆ calc_price's; `warnings` let through ⊆ kept), so their common part is the
 * smallest one's: empty everywhere → goes; something common → held by it; otherwise the answer hangs on what the edit
 * erased — UNKNOWN, counted on neither side.
 */
function judge(
  base: Omit<Parameters<typeof reasonsLeft>[0], 'cls' | 'warningCodes'>,
  classes: readonly DraftClass[],
  warningCodes: readonly (readonly string[] | null)[],
): Judged {
  const lefts = classes.flatMap((cls) => warningCodes.map((codes) => reasonsLeft({ ...base, cls, warningCodes: codes })));
  const union = [...new Set(lefts.flat())];
  if (union.length === 0) return { kind: 'goes' };
  const common = union.filter((r) => lefts.every((l) => l.includes(r)));
  return common.length > 0 ? { kind: 'held', left: common } : { kind: 'unknown', maybe: union };
}

function histogram(lists: readonly (readonly string[])[]): [string, number][] {
  const h = new Map<string, number>();
  for (const l of lists) for (const r of l) h.set(r, (h.get(r) ?? 0) + 1);
  return [...h.entries()].sort((a, b) => b[1] - a[1] || a[0].localeCompare(b[0]));
}

async function verdicts(q: Q, args: Args): Promise<number> {
  if (!(await tableExists(q, 'agent_auto_verdicts')) || !(await tableExists(q, 'agent_drafts'))) {
    console.log("agent_auto_verdicts jadvali yo'q (0145 dan oldingi baza) — o'qiladigan qaror yo'q.");
    return 0;
  }
  const from = tashkentDayStart(args.day).toISOString();
  const to = tashkentDayStart(addDays(args.day, 1)).toISOString();
  const rows = await q<
    {
      draft_id: string;
      manager: string;
      at: string;
      eligible: boolean;
      reasons: string[] | null;
      state: string | null;
      outcome: string | null;
      kind: string;
      status: string;
      category: string | null;
      language: string | null;
      confidence: string | null;
      body: string;
      own_body: string | null;
      edited: boolean;
      warnings: unknown;
      notes: unknown;
      ledger: unknown;
      customer_locale: unknown;
      has_estimate: boolean;
      actions: unknown;
      tool_calls: unknown;
    }[]
  >`
    SELECT v.draft_id::text AS draft_id, v.manager_user_id::text AS manager,
           to_char(v.created_at AT TIME ZONE 'Asia/Tashkent', 'HH24:MI') AS at,
           v.eligible, v.reasons, v.state, v.outcome,
           d.kind, d.status, d.category, d.language, d.confidence::text AS confidence,
           -- The AI's words, never his: the gate judged them (the verdict row precedes any ✏️), and 1a is asked about
           -- what the AI would send. His text is printed beside it, not judged.
           coalesce(d.proposed_body, '') AS body, d.final_body AS own_body, d.final_body IS NOT NULL AS edited,
           d.policy -> 'warnings' AS warnings, d.policy -> 'notes' AS notes, d.policy -> 'ledger' AS ledger,
           d.policy -> 'memory' -> 'customerLocale' AS customer_locale,
           coalesce(d.policy -> 'memory' ->> 'hasEstimate', 'false') = 'true' AS has_estimate,
           d.actions, r.tool_calls
      FROM agent_auto_verdicts v
      JOIN agent_drafts d ON d.id = v.draft_id
      LEFT JOIN agent_runs r ON r.id = d.run_id
     WHERE v.created_at >= ${from}::timestamptz AND v.created_at < ${to}::timestamptz
       ${args.user ? q`AND v.manager_user_id = ${args.user}::uuid` : q``}
     ORDER BY v.created_at, v.draft_id`;

  // 1a's night rule hangs on a setting K3 adds (§3.3): a stored row is his answer to question 1, no row reads as the
  // default — `table`, the ⭐ — exactly as `getSetting` reads a key with no row. The flag asks «what if he answers so».
  const [storedNight] = await q<{ v: string | null }[]>`SELECT value #>> '{}' AS v FROM settings WHERE key = 'agent_night_prices'`;
  const nightPrices: NightPrices = args.nightPrices ?? (isNightPrices(storedNight?.v) ? storedNight.v : NIGHT_PRICES_STAR);
  const nightFrom = args.nightPrices
    ? '--night-prices'
    : isNightPrices(storedNight?.v)
      ? 'saqlangan'
      : storedNight
        ? `⭐ — saqlangan «${show(storedNight.v)}» o'qilmadi`
        : "⭐ — saqlanmagan";

  const accounts = histogram(rows.map((r) => [r.manager]));
  console.log(
    `O'zi yuborish qarorlari — ${args.day} (Toshkent kuni): ${rows.length} ta qoralama` +
      (accounts.length > 0 ? ` · hisob: ${accounts.map(([a, n]) => `${a} (${n})`).join(', ')}` : ''),
  );
  console.log(`1a tungi qoidasi: agent_night_prices = ${nightPrices} (${nightFrom})`);

  const judged = rows.map((r) => {
    const reasons = (r.reasons ?? []).filter((x): x is string => typeof x === 'string');
    const actionTypes = Array.isArray(r.actions)
      ? (r.actions as { type?: unknown }[]).map((a) => (typeof a?.type === 'string' ? a.type : '?'))
      : [];
    const warningCodes = Array.isArray(r.warnings)
      ? (r.warnings as { code?: unknown }[]).map((w) => (typeof w?.code === 'string' ? w.code : '?'))
      : null;
    const notes = Array.isArray(r.notes) ? (r.notes as unknown[]).map((n) => (typeof n === 'string' ? n : '')) : null;
    const facts = { actionTypes, tools: toolCallsOf(r.tool_calls), hasEstimate: r.has_estimate === true, reasons, body: r.body };
    // His ✏️ (decide.ts `submitOwnText`, :1455-1462) wrote his text's warnings over the AI's and emptied the ledger:
    // the stored ones say nothing about the AI's reply, so the edited readings are taken instead (`judge`).
    const edited = r.edited === true;
    // The erased ledger can move the answer only when the gate wrote `money` (a line no tool vouched for): every vouched
    // line came from a tool call `classOf` reads anyway, so without `money` the class is exact on an empty ledger.
    const classes = !edited
      ? [classOf({ ...facts, ledger: ledgerLinesOf(r.ledger) })]
      : reasons.includes('money')
        ? classesWithLedgerLost(facts)
        : [classOf({ ...facts, ledger: [] })];
    const warningReadings = edited && reasons.includes('warnings') ? [EYE_ONLY_WARNINGS, [ERASED_WARNING]] : [warningCodes];
    const guess = guessOf(r.customer_locale);
    const verdict = judge(
      {
        reasons,
        state: r.state,
        outcome: r.outcome,
        category: r.category,
        notes,
        language: r.language,
        guess,
        nightPrices,
        aiWordsWent: r.status === 'approved' && r.own_body === null,
      },
      classes,
      warningReadings,
    );
    return { r, reasons, warningCodes, edited, classes, guess, verdict };
  });

  console.log("\nSaqlangan sabablar (gate yozgan paytdagi; bir qoralamada bir nechta bo'lishi mumkin):");
  const stored = histogram(judged.map((j) => j.reasons));
  if (stored.length === 0) console.log('  —');
  for (const [r, n] of stored) console.log(`  ${r.padEnd(22)} ${pad(n, 4)}`);
  // `eligible` is the SCHEDULING's word and is never rewritten: a draft admitted then refused at its press keeps it.
  const eligibleThen = judged.filter((j) => j.r.eligible).length;
  console.log(`  rejalashtirishda ruxsat olgan: ${eligibleThen} / ${rows.length}`);
  const states = histogram(judged.map((j) => [j.r.state ?? 'rad (rejalashtirishda)']));
  if (states.length > 0) console.log(`  holatlar: ${states.map(([s, n]) => `${s} ${n}`).join(' · ')}`);

  const count = (kind: Judged['kind']) => judged.filter((j) => j.verdict.kind === kind).length;
  const goes = count('goes');
  const held = count('held');
  const unknown = count('unknown');
  const n = rows.length;
  // A range, never a guess: an edited draft whose answer hangs on what the ✏️ erased sits on neither side.
  const span = (lo: number) => (unknown === 0 ? `${lo}` : `${lo}–${lo + unknown}`);
  console.log(
    `\n1a dan keyin: o'zi ketardi ${span(goes)} / ${n} · baribir kutardi ${span(held)} / ${n}` +
      (unknown > 0 ? ` · tahrirlangan — noma'lum: ${unknown} ta (hech qaysi tomonga qo'shilmadi)` : ''),
  );
  // A countdown whose card never reached a screen (auto-send.ts `deferForCard`: outcome 'unseen', re-deferred every
  // minute) is the seat's staff chat not being read — the one thing 1a's price hold and his ⏸ stand on.
  const unseen = judged.filter((j) => j.r.outcome === 'unseen').length;
  if (unseen > 0) {
    console.log(`  ⚠️ ${unseen} tasining kartasi hech kimning ekraniga yetmagan (unseen) — AI raqamining hodim boti ulanganini tekshiring`);
  }
  // Talk goes at once under 1a, so today's stop during the hold does not count against it — but the stop was his
  // word on THAT reply, and the number must not hide it.
  const talkStopped = judged.filter(
    (j) =>
      j.verdict.kind === 'goes' &&
      (j.r.state === 'stopped' || j.r.state === 'gone') &&
      j.r.outcome !== 'owner_send' &&
      !(j.r.status === 'approved' && j.r.own_body === null) &&
      j.classes.every((c) => c === 'talk'),
  ).length;
  if (talkStopped > 0) {
    console.log(`  shundan ${talkStopped} tasi bugun kutish paytida to'xtatilgan yoki almashtirilgan suhbat javobi (Eslatmaga qarang)`);
  }
  const leftHist = histogram(judged.map((j) => (j.verdict.kind === 'held' ? j.verdict.left : [])));
  if (leftHist.length > 0) {
    console.log('Kutishga qoladigan sabablar (aniq kutganlar):');
    for (const [r, c] of leftHist) console.log(`  ${r.padEnd(22)} ${pad(c, 4)}`);
  }

  console.log('\nHar bir qoralama:');
  for (const j of judged) {
    const conf = j.r.confidence === null ? '—' : j.r.confidence;
    const guess = j.guess === null ? "taxmin yo'q" : `mijoz: ${j.guess.locale ?? '?'}${j.guess.confident ? ' (aniq)' : j.guess.leans ? ' (moyil)' : ' (taxmin)'}`;
    console.log(
      `  ${j.r.at}  ${j.r.draft_id}  ${j.r.kind}/${j.r.status}  turi: ${j.r.category ?? '—'}  til: ${j.r.language ?? '—'} (${guess})  ishonch: ${conf}  sinf: ${j.classes.join(' yoki ')}  holat: ${j.r.state ?? '—'}${j.r.outcome ? ` (${j.r.outcome})` : ''}`,
    );
    console.log(`      saqlangan: ${j.reasons.length > 0 ? j.reasons.join(', ') : '—'}`);
    if (j.warningCodes && j.warningCodes.length > 0) {
      console.log(`      ogohlantirishlar${j.edited ? " (✏️ matningizniki — AI javobiniki o'chgan)" : ''}: ${j.warningCodes.join(', ')}`);
    }
    const v = j.verdict;
    const stoppedTalk =
      v.kind === 'goes' && (j.r.state === 'stopped' || j.r.state === 'gone') && j.r.outcome !== 'owner_send' && !(j.r.status === 'approved' && j.r.own_body === null)
        ? ` (bugun kutishda: ${j.r.outcome ?? j.r.state})`
        : '';
    console.log(
      `      → ${
        v.kind === 'goes'
          ? `o'zi ketardi${stoppedTalk}`
          : v.kind === 'held'
            ? `baribir kutardi: ${v.left.join(', ')}`
            : `tahrirlangan — noma'lum: ✏️ AI javobining ${j.reasons.includes('money') ? "pul qatorlari va ogohlantirishlarini" : 'ogohlantirishlarini'} o'chirgan; kutsa — ${v.maybe.join(', ')}`
      }`,
    );
    console.log(`      javob (AI): «${clip(j.r.body, 60)}»`);
    if (j.r.own_body !== null) console.log(`      ✏️ sizning matningiz: «${clip(j.r.own_body, 60)}»`);
  }
  console.log(
    `\nEslatma: \`night\` §6.2 bo'yicha sinfga qarab, agent_night_prices = ${nightPrices} bilan olindi; narxli javobning\n` +
      "`language`i bugungi qoida bilan saqlanganicha qoldi (1a uni o'zgartirmaydi). 1a qo'shadigan ikki yangi sabab — `loop`\n" +
      "va shikoyat o'quvchisi — hisoblanmadi: ular faqat qo'shadi, shu tomondan «o'zi ketardi» yuqori chegara.\n" +
      "Hamma joyda AI yozgan javob baholandi. ✏️ bilan tahrirlangan qoralamada AI javobining ogohlantirishlari sizning\n" +
      "matningiznikiga almashgan (va pul qatorlari o'chgan — bu faqat `money` sababi bor joyda muhim); natija shunga\n" +
      "bog'liq bo'lsa — «tahrirlangan — noma'lum»,\n" +
      "ikki tomonga ham qo'shilmadi, shuning uchun yuqoridagi son oraliq.\n" +
      "Bosishda rad etilganlar (`press:…`) qanday yozilgan bo'lsa qoldi (faqat `auto_warning` — `questions`ning o'zi —\n" +
      "olib tashlandi); suhbat javobi 1a da kutmaydi, shuning uchun unga bosishda yozilgan rad tegmasligi mumkin — bunday\n" +
      "qatorlarda son past bo'lishi mumkin.\n" +
      "Kutish paytida to'xtatilgan (⏸ ✏️ ❌ 🙋 ✍️ 📝, o'chirish) yoki almashtirilgan qoralama: narxli sinf 1a da ham shu\n" +
      "kutishni kutadi, to'xtatish yana bo'lardi — `held:<sabab>` bilan kutganlar qatorida. Suhbat javobi (talk) esa 1a da\n" +
      "darhol ketadi — to'xtatishga vaqt qolmasdi — shuning uchun «o'zi ketardi»da qoldi; lekin to'xtatish sizning shu\n" +
      "javobga bergan so'zingiz edi: qatorda «bugun kutishda: …» deb, yuqorida soni bilan ko'rsatildi.",
  );

  await storedSettings(q);
  return 0;
}

/** His ticks and floors exactly as stored — a NULL printed as NULL, with the constant it falls back to beside it. */
async function storedSettings(q: Q): Promise<void> {
  // A moment as a Tashkent wall clock, rendered by postgres: the shared client hands timestamps back as raw text
  // (drizzle's driver makes their parser transparent), so a Date is never assumed here.
  const tk = (col: string) => q.unsafe(`to_char(${col} AT TIME ZONE 'Asia/Tashkent', 'YYYY-MM-DD HH24:MI') AS ${col}`);
  console.log("\nSaqlangan sozlamalar (qanday turgan bo'lsa; vaqtlar Toshkent bo'yicha):");
  let owner: string | null = null;
  if (await tableExists(q, 'agent_config')) {
    const [c] = await q<
      {
        mode: string;
        owner: string | null;
        session_exclusive_at: string | null;
        started_at: string | null;
        human_pause_min: number;
        daily_draft_cap: number;
        daily_token_cap: number;
        avia_usd_per_kg: string | null;
      }[]
    >`SELECT mode, owner_user_id::text AS owner, ${tk('session_exclusive_at')}, ${tk('started_at')}, human_pause_min,
             daily_draft_cap, daily_token_cap, avia_usd_per_kg::text AS avia_usd_per_kg
        FROM agent_config WHERE id = 1`;
    if (c) {
      owner = c.owner;
      console.log(
        `  agent_config: mode=${c.mode} · egasi=${show(c.owner)} · sessiya tasdig'i=${show(c.session_exclusive_at)} · ` +
          `boshlangan=${show(c.started_at)} · odam pauzasi=${c.human_pause_min} daq · kunlik qoralama=${c.daily_draft_cap} · ` +
          `kunlik token=${c.daily_token_cap} · avia $/kg=${show(c.avia_usd_per_kg)}`,
      );
    } else {
      console.log("  agent_config: qator yo'q");
    }
  } else {
    console.log("  agent_config: jadval yo'q");
  }

  const [seat] = await q<{ v: string | null }[]>`SELECT value #>> '{}' AS v FROM settings WHERE key = ${AGENT_SEAT_KEY}`;
  const seatId = seat?.v ?? null;
  console.log(`  AI o'rni (settings ${AGENT_SEAT_KEY}): ${show(seatId)} · egasi shu o'rinmi: ${seatId !== null && owner !== null && seatId.toLowerCase() === owner ? 'ha' : "yo'q"}`);

  if (owner && (await tableExists(q, 'tg_accounts'))) {
    const accs = await q<{ status: string; work_account: boolean; last_seen_at: string | null }[]>`
      SELECT status, work_account, ${tk('last_seen_at')} FROM tg_accounts WHERE manager_user_id = ${owner}::uuid`;
    if (accs.length === 0) console.log("  egasining Telegram akkaunti: ulanmagan (qator yo'q)");
    for (const a of accs) console.log(`  egasining Telegram akkaunti: holat=${a.status} · «Ish raqami»=${a.work_account ? 'ha' : "yo'q"} · oxirgi ko'rinish=${show(a.last_seen_at)}`);
  }

  if (await tableExists(q, 'agent_auto_config')) {
    const [a] = await q<
      {
        armed_at: string | null;
        hold_sec: number;
        per_day: number | null;
        max_chars: number;
        min_confidence: string;
        categories: string[];
        disarmed_at: string | null;
        disarm_reason: string | null;
      }[]
    >`SELECT ${tk('armed_at')}, hold_sec, per_day, max_chars, min_confidence::text AS min_confidence, categories, ${tk('disarmed_at')}, disarm_reason
        FROM agent_auto_config WHERE id = 1`;
    if (a) {
      console.log(
        `  agent_auto_config: yoqilgan=${a.armed_at ? `ha (${a.armed_at})` : "yo'q"} · turlar={${a.categories.join(',')}} · ` +
          `kutish=${a.hold_sec} s · min ishonch=${a.min_confidence} · kuniga=${a.per_day === null ? 'NULL (cheklanmagan)' : a.per_day} · ` +
          `max belgi=${a.max_chars} · o'chirilgan=${show(a.disarmed_at)}${a.disarm_reason ? ` (${a.disarm_reason})` : ''}`,
      );
    } else {
      console.log("  agent_auto_config: qator yo'q (hech qachon yoqilmagan)");
    }
  } else {
    console.log("  agent_auto_config: jadval yo'q");
  }

  if (await tableExists(q, 'agent_send_caps')) {
    const [s] = await q<{ day_cap: number | null; hour_cap: number | null; tariff_confirmed_at: string | null }[]>`
      SELECT day_cap, hour_cap, ${tk('tariff_confirmed_at')} FROM agent_send_caps WHERE id = 1`;
    const cap = (v: number | null | undefined, fallback: number) => (v === null || v === undefined ? `NULL (doimiy ${fallback})` : String(v));
    console.log(
      `  agent_send_caps: kunlik=${cap(s?.day_cap, AGENT_LIMITS.perDay)} · soatlik=${cap(s?.hour_cap, AGENT_LIMITS.perHour)} · ` +
        `«Tarif to'g'ri» bosilgan=${show(s?.tariff_confirmed_at)}${s ? '' : " (qator yo'q)"}`,
    );
  } else {
    console.log("  agent_send_caps: jadval yo'q");
  }

  // Plan §4.2: a chat a «botmisiz?» took off the layer keeps out until its off_until — no screen clears it at HEAD.
  if (await tableExists(q, 'agent_auto_chats')) {
    const off = await q<{ reason: string; n: number }[]>`
      SELECT reason, count(*)::int AS n FROM agent_auto_chats WHERE off_until > now() GROUP BY reason ORDER BY reason`;
    const bot = off.find((o) => o.reason === 'bot_question')?.n ?? 0;
    console.log(
      `  «botmisiz?» sababli o'zi yuborishdan chiqarilgan chatlar (muddati hali o'tmagan): ${bot}` +
        (off.length > 0 ? ` · hamma sabab bo'yicha: ${off.map((o) => `${o.reason} ${o.n}`).join(', ')}` : ''),
    );
  }
}

// ── the census's messages and bursts (media, volume) ───────────────────────────────────────────────────

interface StageMessage extends CensusMessage {
  /** Tashkent hour, `HH`. */
  hour: string;
  /** The customer's own auto-replier wrote it (tg_message_flags.auto_sent). */
  autoSent: boolean;
}

/**
 * The census script's query (scripts/agent-census.ts) on the transaction: the account's stored lines from
 * `since`, deleted-for-both-sides left out, each with its first attachment read through `mediaWord` — the run's
 * own media words. `peersBefore` = chats that already had a line before `since` (deleted or not: the chat existed).
 */
async function loadMessages(q: Q, owner: string, since: string): Promise<{ messages: StageMessage[]; peersBefore: Set<string> }> {
  const rows = await q<
    {
      peer_id: string;
      direction: string;
      body: string | null;
      has_media: boolean;
      content_type: string | null;
      file_name: string | null;
      day: string;
      hour: string;
      auto_sent: boolean | null;
    }[]
  >`
    SELECT m.peer_id::text AS peer_id, m.direction, m.body, m.has_media,
           a.content_type, a.file_name,
           to_char(m.sent_at AT TIME ZONE 'Asia/Tashkent', 'YYYY-MM-DD') AS day,
           to_char(m.sent_at AT TIME ZONE 'Asia/Tashkent', 'HH24') AS hour,
           f.auto_sent
      FROM tg_messages m
      LEFT JOIN LATERAL (
        SELECT content_type, file_name FROM attachments
         WHERE entity_type = 'tg_message' AND entity_id = m.id
         ORDER BY created_at LIMIT 1) a ON true
      LEFT JOIN tg_message_flags f ON f.message_id = m.id
     WHERE m.manager_user_id = ${owner}::uuid
       AND f.deleted_at IS NULL
       AND m.sent_at >= ${since}::timestamptz
       AND m.sent_at <= now()
     ORDER BY m.peer_id, m.sent_at, m.tg_message_id`;
  const before = await q<{ peer_id: string }[]>`
    SELECT DISTINCT peer_id::text AS peer_id FROM tg_messages
     WHERE manager_user_id = ${owner}::uuid AND sent_at < ${since}::timestamptz`;
  return {
    messages: rows.map((r) => ({
      peerId: r.peer_id,
      direction: r.direction === 'out' ? 'out' : 'in',
      body: r.body,
      media: mediaWord(r.content_type, r.file_name, r.has_media),
      day: r.day,
      hour: r.hour,
      autoSent: r.auto_sent === true,
    })),
    peersBefore: new Set(before.map((b) => b.peer_id)),
  };
}

interface Burst {
  peerId: string;
  day: string;
  lines: StageMessage[];
  lastOutAsked: boolean;
  /** The chat's first burst — and the chat began inside the window (no line of it before `since`). */
  first: boolean;
}

/**
 * The bursts, split by `censusDays`' own rule (census.ts:42): the customer's lines since our last out row, dated by
 * the LAST line, judged against whether our last line asked. `censusDays` hands back only per-day counts, so the
 * split is restated — and checked against it below: a census that moved its rule turns this into an error, never
 * into two different pilots (#513).
 */
function burstsOf(messages: readonly StageMessage[], peersBefore: ReadonlySet<string>): Burst[] {
  const byPeer = new Map<string, StageMessage[]>();
  for (const m of messages) {
    const list = byPeer.get(m.peerId) ?? [];
    list.push(m);
    byPeer.set(m.peerId, list);
  }
  const asks = (body: string | null) => /[?؟？]\s*$/u.test((body ?? '').trim());
  const out: Burst[] = [];
  for (const [peerId, list] of byPeer) {
    let lines: StageMessage[] = [];
    let lastOut: StageMessage | null = null;
    let seen = 0;
    const close = () => {
      if (lines.length === 0) return;
      out.push({
        peerId,
        day: lines[lines.length - 1]!.day,
        lines,
        lastOutAsked: lastOut ? asks(lastOut.body) : false,
        first: seen === 0 && !peersBefore.has(peerId),
      });
      seen += 1;
      lines = [];
    };
    for (const m of list) {
      if (m.direction === 'out') {
        close();
        lastOut = m;
      } else {
        lines.push(m);
      }
    }
    close();
  }
  const census = new Map(censusDays(messages).map((d) => [d.day, d.bursts]));
  const mine = new Map<string, number>();
  for (const b of out) mine.set(b.day, (mine.get(b.day) ?? 0) + 1);
  for (const day of new Set([...census.keys(), ...mine.keys()])) {
    if ((census.get(day) ?? 0) !== (mine.get(day) ?? 0)) {
      throw new Error(`burst split disagrees with censusDays on ${day}: ${mine.get(day) ?? 0} vs ${census.get(day) ?? 0}`);
    }
  }
  return out;
}

async function windowOf(q: Q, args: Args): Promise<{ owner: string; since: string; fromDay: string } | null> {
  const owner = await accountOf(q, args.user);
  if (!owner) {
    console.error('AI sotuvchi egasi saqlanmagan (Suhbatlar → AI sotuvchi → Sozlamalar) — --user <uuid> bering.');
    console.error(USAGE);
    return null;
  }
  const fromDay = addDays(tashkentDay(), -(args.days - 1));
  return { owner, since: tashkentDayStart(fromDay).toISOString(), fromDay };
}

// ── media ──────────────────────────────────────────────────────────────────────────────────────────────

interface MediaCount {
  bursts: number;
  photo: number;
  file: number;
  voice: number;
  other: number;
  mediaOnly: number;
  voiceOnly: number;
}

const ZERO_MEDIA: MediaCount = { bursts: 0, photo: 0, file: 0, voice: 0, other: 0, mediaOnly: 0, voiceOnly: 0 };

/**
 * One burst into the counts. Photo = 'photo'; file = 'document' — a file the listener STORED (an invoice, a sheet, a
 * clip: `mediaOf` reads every stored type that is neither image nor audio as one); voice = 'voice' or 'audio' —
 * `draftWorthy` counts the two together (`voice_only`). Other = 'other', its own column and never a file: Telegram
 * said the line carries media and nothing was stored beside it (census.ts `mediaWord` — `has_media` with no
 * attachment), because `tgMediaPlan` (telegram-import.ts :583-690) keeps photos, voice and audio, and files storage
 * accepts, and nothing else — a link preview, a sticker, a location, a contact, a round video, a file over the cap or
 * of a refused type. Stage 2's eyes have no bytes to read there. Media-ONLY = the burst holds no words at all:
 * `draftWorthy`'s own `media_only` / `voice_only`, so «only media» is what the worker sees, whatever the column.
 */
function addBurst(c: MediaCount, b: Burst): MediaCount {
  const kinds = new Set(b.lines.map((l) => l.media));
  const verdict = draftWorthy(
    b.lines.map((l) => ({ text: l.body, media: l.media })),
    b.lastOutAsked,
  );
  const only = !verdict.worthy && (verdict.reason === 'media_only' || verdict.reason === 'voice_only');
  return {
    bursts: c.bursts + 1,
    photo: c.photo + (kinds.has('photo') ? 1 : 0),
    file: c.file + (kinds.has('document') ? 1 : 0),
    voice: c.voice + (kinds.has('voice') || kinds.has('audio') ? 1 : 0),
    other: c.other + (kinds.has('other') ? 1 : 0),
    mediaOnly: c.mediaOnly + (only ? 1 : 0),
    voiceOnly: c.voiceOnly + (only && verdict.reason === 'voice_only' ? 1 : 0),
  };
}

const mediaRow = (c: MediaCount) =>
  `${pad(c.bursts, 6)} ${pad(c.photo, 5)} ${pad(c.file, 5)} ${pad(c.voice, 5)} ${pad(c.other, 7)} ${pad(c.mediaOnly, 6)} (${c.voiceOnly})`;

async function media(q: Q, args: Args): Promise<number> {
  const w = await windowOf(q, args);
  if (!w) return 2;
  const { messages, peersBefore } = await loadMessages(q, w.owner, w.since);
  const bursts = burstsOf(messages, peersBefore);
  const all = new Map<string, MediaCount>();
  const first = new Map<string, MediaCount>();
  let total = ZERO_MEDIA;
  let totalFirst = ZERO_MEDIA;
  for (const b of bursts) {
    all.set(b.day, addBurst(all.get(b.day) ?? ZERO_MEDIA, b));
    total = addBurst(total, b);
    if (b.first) {
      first.set(b.day, addBurst(first.get(b.day) ?? ZERO_MEDIA, b));
      totalFirst = addBurst(totalFirst, b);
    }
  }
  console.log(`Mijoz bo'laklaridagi media — hisob ${w.owner}, ${w.fromDay} dan ${args.days} kun (Toshkent)`);
  console.log("bo'lak = bizning oxirgi xabarimizdan keyingi mijoz xabarlari (census qoidasi); «faqat media (ovoz)» = so'zsiz bo'laklar, qavsda faqat ovozlilari");
  console.log(
    "fayl = saqlangan hujjat (invoys, jadval, video…); boshqa = Telegram media degan, lekin hech narsa saqlanmagan: havola, stiker,\n" +
      "joylashuv yoki kontakt, dumaloq video, juda katta yoki saqlanmaydigan turdagi fayl — AI uni o'qiy olmaydi",
  );
  console.log(`\nkun          — hamma bo'laklar ————————————————————————  — yangi chatning 1-bo'lagi ————————————————————`);
  console.log(`             bo'lak  rasm  fayl  ovoz  boshqa  faqat-media   bo'lak  rasm  fayl  ovoz  boshqa  faqat-media`);
  for (const day of [...all.keys()].sort()) {
    console.log(`${day}  ${mediaRow(all.get(day)!)}   ${mediaRow(first.get(day) ?? ZERO_MEDIA)}`);
  }
  console.log(`${'jami'.padEnd(10)}  ${mediaRow(total)}   ${mediaRow(totalFirst)}`);
  console.log(
    `\n«yangi chat» = bu oynadan oldin bitta ham xabari bo'lmagan chat (${totalFirst.bursts} ta); ` +
      `oynadan oldin boshlangan chatlarning birinchi bo'lagi bu yerda ko'rinmaydi.`,
  );
  return 0;
}

// ── audience ───────────────────────────────────────────────────────────────────────────────────────────

async function audience(q: Q, args: Args): Promise<number> {
  const owner = await accountOf(q, args.user);
  if (!owner) {
    console.error('AI sotuvchi egasi saqlanmagan (Suhbatlar → AI sotuvchi → Sozlamalar) — --user <uuid> bering.');
    console.error(USAGE);
    return 2;
  }
  // A chat belongs to whatever its NEWEST stored line names (client OR lead — tg_messages' CHECK, wms.ts:2480):
  // a won lead's chat moves to the client. The seller is the client's `sales_manager_id`, a lead's `owner_id`.
  const rows = await q<
    { peer_id: string; is_client: boolean; seller: string | null; has_phone: boolean; in30: boolean; in90: boolean; we_first: boolean }[]
  >`
    WITH peers AS (
      SELECT m.peer_id, max(m.sent_at) AS last_in
        FROM tg_messages m
        LEFT JOIN tg_message_flags f ON f.message_id = m.id
       WHERE m.manager_user_id = ${owner}::uuid AND m.direction = 'in' AND f.deleted_at IS NULL
       GROUP BY m.peer_id
    ), bound AS (
      SELECT DISTINCT ON (m.peer_id) m.peer_id, m.client_id, m.lead_id
        FROM tg_messages m JOIN peers p ON p.peer_id = m.peer_id
       WHERE m.manager_user_id = ${owner}::uuid
       ORDER BY m.peer_id, m.sent_at DESC, m.tg_message_id DESC
    ), opener AS (
      SELECT DISTINCT ON (m.peer_id) m.peer_id, m.direction
        FROM tg_messages m JOIN peers p ON p.peer_id = m.peer_id
       WHERE m.manager_user_id = ${owner}::uuid
       ORDER BY m.peer_id, m.sent_at, m.tg_message_id
    )
    SELECT p.peer_id::text AS peer_id,
           b.client_id IS NOT NULL AS is_client,
           (CASE WHEN b.client_id IS NOT NULL THEN c.sales_manager_id ELSE l.owner_id END)::text AS seller,
           CASE WHEN b.client_id IS NOT NULL
                THEN EXISTS (SELECT 1 FROM jsonb_array_elements_text(
                               CASE WHEN jsonb_typeof(c.phones) = 'array' THEN c.phones ELSE '[]'::jsonb END) ph
                              WHERE btrim(ph) <> '')
                ELSE coalesce(btrim(l.phone), '') <> '' END AS has_phone,
           p.last_in >= now() - interval '30 days' AS in30,
           p.last_in >= now() - interval '90 days' AS in90,
           o.direction = 'out' AS we_first
      FROM peers p
      JOIN bound b ON b.peer_id = p.peer_id
      JOIN opener o ON o.peer_id = p.peer_id
      LEFT JOIN clients c ON c.id = b.client_id
      LEFT JOIN leads l ON l.id = b.lead_id`;

  type Cell = { n: number; seller: number; self: number; none: number; in30: number; in90: number; phone: number; weFirst: number };
  const zero = (): Cell => ({ n: 0, seller: 0, self: 0, none: 0, in30: 0, in90: 0, phone: 0, weFirst: 0 });
  const cells = { mijoz: zero(), lid: zero(), jami: zero() };
  for (const r of rows) {
    for (const c of [r.is_client ? cells.mijoz : cells.lid, cells.jami]) {
      c.n += 1;
      if (r.seller === null) c.none += 1;
      else if (r.seller === owner) c.self += 1;
      else c.seller += 1;
      if (r.in30) c.in30 += 1;
      if (r.in90) c.in90 += 1;
      if (r.has_phone) c.phone += 1;
      if (r.we_first) c.weFirst += 1;
    }
  }
  console.log(`Kim yozadi — hisob ${owner}: kamida bitta kiruvchi xabari bor chatlar (butun tarix, o'chirilganlar hisobga olinmagan)`);
  console.log('\n        chatlar  sotuvchisi bor  sotuvchi=shu hisob  sotuvchisiz  30 kunda yozgan  90 kunda yozgan  kartada telefon  biz birinchi yozganmiz');
  for (const [label, c] of Object.entries(cells)) {
    console.log(
      `${label.padEnd(6)}  ${pad(c.n, 7)}  ${pad(c.seller, 14)}  ${pad(c.self, 18)}  ${pad(c.none, 11)}  ${pad(c.in30, 15)}  ${pad(c.in90, 15)}  ${pad(c.phone, 15)}  ${pad(c.weFirst, 22)}`,
    );
  }
  console.log(
    "\nmijoz/lid = chatning eng yangi xabari qaysi kartaga bog'langan; sotuvchi = mijozning sales_manager_id, lidning owner_id;\n" +
      "«kartada telefon» = mijozning phones ro'yxati yoki lidning phone maydoni bo'sh emas; «biz birinchi yozganmiz» = chatning\n" +
      "eng birinchi saqlangan xabari bizniki.",
  );
  return 0;
}

// ── volume ─────────────────────────────────────────────────────────────────────────────────────────────

function median(xs: readonly number[]): number {
  if (xs.length === 0) return 0;
  const s = [...xs].sort((a, b) => a - b);
  const mid = Math.floor(s.length / 2);
  return s.length % 2 === 1 ? s[mid]! : (s[mid - 1]! + s[mid]!) / 2;
}

const joined = (m: Map<string, number> | undefined) =>
  m && m.size > 0 ? [...m.entries()].sort((a, b) => b[1] - a[1] || a[0].localeCompare(b[0])).map(([k, v]) => `${k} ${v}`).join(', ') : '—';

function bump(map: Map<string, Map<string, number>>, day: string, key: string, n: number): void {
  const inner = map.get(day) ?? new Map<string, number>();
  inner.set(key, (inner.get(key) ?? 0) + n);
  map.set(day, inner);
}

async function volume(q: Q, args: Args): Promise<number> {
  const w = await windowOf(q, args);
  if (!w) return 2;
  const { messages, peersBefore } = await loadMessages(q, w.owner, w.since);
  const bursts = burstsOf(messages, peersBefore);
  const days = new Set<string>();

  const inbound = new Map<string, number>();
  const autoReplies = new Map<string, number>();
  const chats = new Map<string, Set<string>>();
  const hours = new Map<string, Map<string, number>>();
  for (const m of messages) {
    if (m.direction !== 'in') continue;
    days.add(m.day);
    inbound.set(m.day, (inbound.get(m.day) ?? 0) + 1);
    if (m.autoSent) autoReplies.set(m.day, (autoReplies.get(m.day) ?? 0) + 1);
    const set = chats.get(m.day) ?? new Set<string>();
    set.add(m.peerId);
    chats.set(m.day, set);
    bump(hours, m.day, m.hour, 1);
  }
  // Turns per chat: a turn is one customer burst; counted per chat on the day the burst is dated.
  const turns = new Map<string, Map<string, number>>();
  for (const b of bursts) {
    days.add(b.day);
    bump(turns, b.day, b.peerId, 1);
  }

  const dayExpr = (col: string) => q.unsafe(`to_char(${col} AT TIME ZONE 'Asia/Tashkent', 'YYYY-MM-DD')`);
  const runs = new Map<string, Map<string, number>>();
  const capped = new Map<string, Map<string, number>>();
  const drafts = new Map<string, Map<string, number>>();
  const presses = new Map<string, number>();
  const sends = new Map<string, Map<string, number>>();
  const tokens = new Map<string, { input: number; output: number; cacheRead: number; cacheWrite: number; micro: number; unpriced: number }>();

  if (await tableExists(q, 'agent_runs')) {
    for (const r of await q<{ day: string; outcome: string; error: string | null; n: number }[]>`
      SELECT ${dayExpr('created_at')} AS day, outcome, CASE WHEN outcome = 'capped' THEN error END AS error, count(*)::int AS n
        FROM agent_runs
       WHERE manager_user_id = ${w.owner}::uuid AND created_at >= ${w.since}::timestamptz
       GROUP BY 1, 2, 3`) {
      days.add(r.day);
      bump(runs, r.day, r.outcome, r.n);
      if (r.outcome === 'capped') bump(capped, r.day, r.error ?? '—', r.n);
    }
    for (const r of await q<
      { day: string; model: string | null; runs: number; input: number; output: number; cache_read: number; cache_write: number }[]
    >`
      SELECT ${dayExpr('created_at')} AS day, model, count(*)::int AS runs,
             sum(input_tokens)::float8 AS input, sum(output_tokens)::float8 AS output,
             sum(cache_read_tokens)::float8 AS cache_read, sum(cache_write_tokens)::float8 AS cache_write
        FROM agent_runs
       WHERE manager_user_id = ${w.owner}::uuid AND created_at >= ${w.since}::timestamptz
       GROUP BY 1, 2`) {
      const t = tokens.get(r.day) ?? { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, micro: 0, unpriced: 0 };
      const row = { inputTokens: num(r.input), outputTokens: num(r.output), cacheReadTokens: num(r.cache_read), cacheWriteTokens: num(r.cache_write) };
      t.input += row.inputTokens;
      t.output += row.outputTokens;
      t.cacheRead += row.cacheReadTokens;
      t.cacheWrite += row.cacheWriteTokens;
      // A group whose model has no price (or none recorded) counts its runs as unpriced, never as $0 (model.ts:135).
      const micro = r.model === null ? (row.inputTokens + row.outputTokens + row.cacheReadTokens + row.cacheWriteTokens > 0 ? null : 0) : approxMicroUsd([{ model: r.model, ...row }]);
      if (micro === null) t.unpriced += r.runs;
      else t.micro += micro;
      tokens.set(r.day, t);
    }
  }
  if (await tableExists(q, 'agent_drafts')) {
    for (const r of await q<{ day: string; kind: string; n: number }[]>`
      SELECT ${dayExpr('created_at')} AS day, kind, count(*)::int AS n
        FROM agent_drafts
       WHERE manager_user_id = ${w.owner}::uuid AND created_at >= ${w.since}::timestamptz
       GROUP BY 1, 2`) {
      days.add(r.day);
      bump(drafts, r.day, r.kind, r.n);
    }
  }
  if (await tableExists(q, 'agent_auto_verdicts')) {
    for (const r of await q<{ day: string; n: number }[]>`
      SELECT ${dayExpr('pressed_at')} AS day, count(*)::int AS n
        FROM agent_auto_verdicts
       WHERE manager_user_id = ${w.owner}::uuid AND state = 'pressed' AND pressed_at >= ${w.since}::timestamptz
       GROUP BY 1`) {
      days.add(r.day);
      presses.set(r.day, r.n);
    }
  }
  if (await tableExists(q, 'agent_outbox')) {
    for (const r of await q<{ day: string; status: string; n: number }[]>`
      SELECT ${dayExpr('queued_at')} AS day, status, count(*)::int AS n
        FROM agent_outbox
       WHERE manager_user_id = ${w.owner}::uuid AND queued_at >= ${w.since}::timestamptz
       GROUP BY 1, 2`) {
      days.add(r.day);
      bump(sends, r.day, r.status, r.n);
    }
  }

  const censusBursts = new Map(censusDays(messages).map((d) => [d.day, d.bursts]));
  console.log(`Kunlik yuk — hisob ${w.owner}, ${w.fromDay} dan ${args.days} kun (Toshkent)`);
  const sum = { inbound: 0, autoReplies: 0, bursts: 0, drafts: 0, presses: 0, input: 0, output: 0, cacheRead: 0, cacheWrite: 0, micro: 0, unpriced: 0 };
  const sumRuns = new Map<string, number>();
  const sumSends = new Map<string, number>();
  for (const day of [...days].sort()) {
    const perChat = [...(turns.get(day)?.values() ?? [])];
    const peak = [...(hours.get(day)?.entries() ?? [])].sort((a, b) => b[1] - a[1] || a[0].localeCompare(b[0]))[0];
    const t = tokens.get(day) ?? { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, micro: 0, unpriced: 0 };
    const draftCount = [...(drafts.get(day)?.values() ?? [])].reduce((a, b) => a + b, 0);
    console.log(
      `\n${day}  kiruvchi ${inbound.get(day) ?? 0} qator (shundan mijozning avto-javobi ${autoReplies.get(day) ?? 0}) · ` +
        `${censusBursts.get(day) ?? 0} bo'lak · ${chats.get(day)?.size ?? 0} chat · bo'lak/chat median ${median(perChat)}, max ${Math.max(0, ...perChat)} · ` +
        `eng band soat ${peak ? `${peak[0]}:00 (${peak[1]} qator)` : '—'}`,
    );
    console.log(`    runlar: ${joined(runs.get(day))}`);
    if (capped.has(day)) console.log(`    capped sabablari: ${joined(capped.get(day))}`);
    console.log(`    qoralamalar: ${draftCount} (${joined(drafts.get(day))}) · mashina bosgan: ${presses.get(day) ?? 0} · yuborishlar: ${joined(sends.get(day))}`);
    console.log(
      `    tokenlar: kirish ${t.input} · chiqish ${t.output} · kesh o'qish ${t.cacheRead} · kesh yozish ${t.cacheWrite} · ` +
        `≈ ${t.micro} µ$ ($${(t.micro / 1_000_000).toFixed(2)})${t.unpriced > 0 ? ` · narxsiz run ${t.unpriced}` : ''}`,
    );
    sum.inbound += inbound.get(day) ?? 0;
    sum.autoReplies += autoReplies.get(day) ?? 0;
    sum.bursts += censusBursts.get(day) ?? 0;
    sum.drafts += draftCount;
    sum.presses += presses.get(day) ?? 0;
    sum.input += t.input;
    sum.output += t.output;
    sum.cacheRead += t.cacheRead;
    sum.cacheWrite += t.cacheWrite;
    sum.micro += t.micro;
    sum.unpriced += t.unpriced;
    for (const [k, v] of runs.get(day) ?? []) sumRuns.set(k, (sumRuns.get(k) ?? 0) + v);
    for (const [k, v] of sends.get(day) ?? []) sumSends.set(k, (sumSends.get(k) ?? 0) + v);
  }
  const allChats = new Set(messages.filter((m) => m.direction === 'in').map((m) => m.peerId));
  console.log(
    `\njami (${days.size} faol kun): kiruvchi ${sum.inbound} qator (avto-javob ${sum.autoReplies}) · ${sum.bursts} bo'lak · ${allChats.size} chat · ` +
      `runlar: ${joined(sumRuns)} · qoralamalar ${sum.drafts} · mashina bosgan ${sum.presses} · yuborishlar: ${joined(sumSends)}`,
  );
  console.log(
    `     tokenlar: kirish ${sum.input} · chiqish ${sum.output} · kesh o'qish ${sum.cacheRead} · kesh yozish ${sum.cacheWrite} · ` +
      `≈ ${sum.micro} µ$ ($${(sum.micro / 1_000_000).toFixed(2)})${sum.unpriced > 0 ? ` · narxsiz run ${sum.unpriced}` : ''}`,
  );
  console.log(
    "\nbo'lak/chat = shu kuni sanalgan bo'laklar bir chatda nechta (navbatlar); runlar va tokenlar shu hisobniki (agent_runs.manager_user_id);\n" +
      "yuborishlar agent_outbox.queued_at kuni bo'yicha; ≈ $ — ro'yxat narxi, javob berilgan chaqiruvlar (model.ts).",
  );
  return 0;
}

// ── main ───────────────────────────────────────────────────────────────────────────────────────────────

async function main(): Promise<number> {
  const args = parseArgs(process.argv.slice(2));
  if (!args) {
    console.error(USAGE);
    return 2;
  }
  // ONE transaction, READ ONLY twice over: postgres.js opens it `BEGIN read only` (the money-suspects precedent) and
  // the first statement says it again; then the server is asked, and a transaction that is not read-only runs nothing.
  return pgClient.begin('read only', async (q) => {
    await q`SET TRANSACTION READ ONLY`;
    const [ro] = await q<{ transaction_read_only: string }[]>`SHOW transaction_read_only`;
    if (ro?.transaction_read_only !== 'on') throw new Error('fence: the transaction is not read-only — nothing was read');
    console.log('READ-ONLY, hech narsa yozilmadi');
    switch (args.cmd) {
      case 'verdicts':
        return verdicts(q, args);
      case 'media':
        return media(q, args);
      case 'audience':
        return audience(q, args);
      case 'volume':
        return volume(q, args);
    }
  });
}

main()
  .then((code) => {
    process.exitCode = code;
  })
  .catch((err: unknown) => {
    console.error(err instanceof Error ? err.message : err);
    process.exitCode = 1;
  })
  .finally(() => void pgClient.end());
