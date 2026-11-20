import { sql } from 'drizzle-orm';
import { db } from '../../platform/db/client';
import { logger } from '../../platform/logger';
import { notifyStaffTelegram } from '../../platform/notifications/staff';
import { quietHour } from '../../platform/telegram/send';
import { addDays, tashkentDay, tashkentDayStart } from '../../platform/time/tashkent';
import { AUTO_REFUSALS, COMING_REFUSALS, RETIRED_REFUSALS, refusalWordOf } from './auto-gate';
import { NO_DRAFT_WORDS } from './calc-loop';
import { agentAutoReady, agentToliq1aReady, readAgentConfig } from './config';
import { designated } from './designations';
import type { Ineligible } from './eligibility';
import { unansweredLines } from './liveness';
import { agentPageReaders, agentPageUrl } from './signals';
import { capWordOf } from './today';

/**
 * The morning line (stage 1a §4.5, his «a morning line names every held reply and why»): at 08:40 Tashkent, to the
 * «rahbar va o‘rinbosar» pair, what the AI did YESTERDAY — its replies, how many went by themselves, the rest each
 * under ONE reason (its first in the gate's own order), the customers' lines it wrote no reply to, the caps the day
 * tripped, the customers still waiting with nothing answered and nothing coming, and the evening marks left undone.
 * Counts only, never a customer's words, name or phone (leak-13), so the people he chose read it whatever chats they
 * may open. «tasdiq kutdi», never «sizni kutdi» (J17): the deputy reads it too, and the replies did not wait for him.
 */

/** The order a draft's first reason is taken in: the gate's own, then the stage's new codes, then the retired ones. */
export const MORNING_REASON_ORDER: readonly string[] = [...new Set<string>([...AUTO_REFUSALS, ...COMING_REFUSALS, ...RETIRED_REFUSALS])];

/**
 * The morning line's own nouns — short, because a line of «3 — …» reads on a phone; every gate code missing here is
 * said in the card's own words (`refusalWordOf`, the ONE map of the gate's words), so the loop is «suhbat aylanib
 * qoldi» here as on the card and the notice (J33). The last rows are the morning's own states of a reply that was
 * judged ready and did not go.
 */
const MORNING_WORDS: Readonly<Record<string, string>> = {
  media: 'rasm, ovoz yoki fayl',
  money: 'narx yoki pul',
  needs_owner: 'AI savol berdi',
  complaint: 'shikoyat',
  language: 'til aniq emas',
  night: 'tun',
  blocked: 'qoida to‘xtatdi',
  not_armed: 'o‘zi yuborish yoqilmagan',
  // A reply the machine pressed, judged ready, that did not reach the customer (a ❌ «Bekor qilish», 🙋, Telegram).
  not_sent: 'tasdiqlandi, lekin Telegramga ketmadi',
  stopped_owner: 'qo‘lda hal qilindi',
  stopped_pause: '⏸ bilan to‘xtatildi',
  stopped_disarmed: 'o‘zi yuborish o‘chirildi',
  gone: 'mijoz yana yozdi yoki suhbat o‘zgardi',
  waiting: 'hali kutmoqda',
  no_verdict: 'o‘zi yuborish ko‘rmagan',
  unknown: 'boshqa sabab',
};

/** A reason code in the morning's words — never a code, never empty. */
export function morningWordOf(code: string): string {
  return MORNING_WORDS[code] ?? refusalWordOf(code) ?? MORNING_WORDS.unknown!;
}

/** Why a line got no draft — the `draftWorthy` reasons, which share `agent_runs.error` with eligibility's. */
const NO_DRAFT_EXTRA: Readonly<Record<string, string>> = {
  media_only: 'faqat rasm yoki fayl',
  voice_only: 'ovozli xabar',
  pashto: 'pushtu tilida',
  bot_question: '«botmisiz?» savoli',
  closing: 'xayrlashuv yoki rahmat',
  empty: 'bo‘sh xabar',
};

/** A no-draft run's reason in words: the loop in its one word (J33), eligibility's own words, the burst's. */
export function noDraftWordOf(code: string): string {
  if (code === 'loop') return refusalWordOf('loop') ?? MORNING_WORDS.unknown!;
  if (Object.hasOwn(NO_DRAFT_WORDS, code)) return NO_DRAFT_WORDS[code as Ineligible];
  return NO_DRAFT_EXTRA[code] ?? MORNING_WORDS.unknown!;
}

/** One reply draft of the day, with its verdict (0145) and its outbox row. */
export interface MorningDraftRow {
  verdict: { eligible: boolean; reasons: readonly string[]; state: string | null; outcome: string | null } | null;
  outbox: string | null;
}

/**
 * The ONE reason a reply is counted under — or `went`. Pure. A reply the machine pressed and that reached the
 * customer went by itself; a refusal is its FIRST code in `MORNING_REASON_ORDER` (a reason this build does not know
 * comes after every known one); a person's decision, a ⏸, a disarm, a chat that moved on and one still waiting are
 * the morning's own states.
 */
export function morningReasonOf(row: MorningDraftRow): string {
  const v = row.verdict;
  if (!v) return 'no_verdict';
  switch (v.state) {
    case 'pressed':
      return row.outbox === 'sent' ? 'went' : 'not_sent';
    case 'stopped':
      return v.outcome === 'pause' ? 'stopped_pause' : v.outcome === 'disarmed' ? 'stopped_disarmed' : 'stopped_owner';
    case 'gone':
      return 'gone';
    case 'waiting':
    case 'pressing':
      return 'waiting';
    default: {
      // Refused at the scheduling (no state) or at the press: the gate's reasons, else the press's own code.
      const codes = v.reasons.length > 0 ? v.reasons : (v.outcome ?? '').split(',').map((c) => c.split(':')[0]!.trim()).filter(Boolean);
      if (codes.length === 0) return 'unknown';
      const rank = (c: string) => {
        const i = MORNING_REASON_ORDER.indexOf(c);
        return i < 0 ? MORNING_REASON_ORDER.length : i;
      };
      return [...codes].sort((a, b) => rank(a) - rank(b))[0]!;
    }
  }
}

export interface Counted {
  code: string;
  n: number;
}

/** What the line is made of — every number a count the database answered. */
export interface MorningFacts {
  /** Yesterday, `YYYY-MM-DD` (Tashkent). */
  day: string;
  /** The AI's reply drafts written yesterday. */
  drafts: number;
  /** …of which the machine pressed and the customer got. */
  went: number;
  /** The rest, by their one reason, largest first. */
  waited: Counted[];
  /** Customers' lines the AI wrote no reply to, by why (eligibility, the burst), largest first. */
  notDrafted: Counted[];
  /** Lines a daily cap stopped, by cap. */
  caps: Counted[];
  /** Customers whose newest line, written since yesterday's start, nobody answered and nothing will (liveness). */
  unanswered: number;
  /** Evening samples older than 48 h with no mark; null one migration behind 0151. */
  unmarkedSamples: number | null;
}

function counted(map: Map<string, number>): Counted[] {
  return [...map.entries()].map(([code, n]) => ({ code, n })).sort((a, b) => b.n - a.n || a.code.localeCompare(b.code));
}

/** A line a customer wrote this recently is not «javobsiz» yet: the run is still on its way. */
export const MORNING_UNANSWERED_AFTER_MS = 10 * 60_000;

/**
 * The facts of one Tashkent day for the agent's ACCOUNT (its holder — the account the AI speaks from) — four
 * statements on the pool.
 */
export async function morningFacts(day: string, holderId: string, now: Date): Promise<MorningFacts> {
  const from = tashkentDayStart(day).toISOString();
  const to = tashkentDayStart(addDays(day, 1)).toISOString();
  const autoReady = await agentAutoReady();
  const drafts = autoReady
    ? await db.execute<{ eligible: boolean | null; reasons: string[] | null; state: string | null; outcome: string | null; verdict: boolean; outbox: string | null }>(sql`
        SELECT v.eligible, v.reasons, v.state, v.outcome, (v.draft_id IS NOT NULL) AS verdict, o.status AS outbox
          FROM agent_drafts d
          LEFT JOIN agent_auto_verdicts v ON v.draft_id = d.id
          LEFT JOIN agent_outbox o ON o.draft_id = d.id
         WHERE d.manager_user_id = ${holderId}::uuid AND d.kind = 'reply' AND d.created_at >= ${from}::timestamptz AND d.created_at < ${to}::timestamptz`)
    : await db.execute<{ eligible: boolean | null; reasons: string[] | null; state: string | null; outcome: string | null; verdict: boolean; outbox: string | null }>(sql`
        SELECT NULL::boolean AS eligible, NULL::text[] AS reasons, NULL::text AS state, NULL::text AS outcome, false AS verdict, o.status AS outbox
          FROM agent_drafts d
          LEFT JOIN agent_outbox o ON o.draft_id = d.id
         WHERE d.manager_user_id = ${holderId}::uuid AND d.kind = 'reply' AND d.created_at >= ${from}::timestamptz AND d.created_at < ${to}::timestamptz`);
  const waited = new Map<string, number>();
  let went = 0;
  for (const r of drafts) {
    const reason = morningReasonOf({
      verdict: r.verdict ? { eligible: r.eligible === true, reasons: r.reasons ?? [], state: r.state, outcome: r.outcome } : null,
      outbox: r.outbox,
    });
    if (reason === 'went') went += 1;
    else waited.set(reason, (waited.get(reason) ?? 0) + 1);
  }
  // A customer's burst is one line here, however many attempts its anchor was asked on.
  const runs = await db.execute<{ outcome: string; error: string | null; n: number }>(sql`
    SELECT outcome, error, count(DISTINCT (peer_id, anchor_tg_message_id))::int AS n
      FROM agent_runs
     WHERE manager_user_id = ${holderId}::uuid AND trigger = 'inbound' AND outcome IN ('refused', 'capped')
       AND created_at >= ${from}::timestamptz AND created_at < ${to}::timestamptz
     GROUP BY outcome, error`);
  const notDrafted = new Map<string, number>();
  const caps = new Map<string, number>();
  for (const r of runs) {
    const into = r.outcome === 'capped' ? caps : notDrafted;
    into.set(r.error ?? 'unknown', (into.get(r.error ?? 'unknown') ?? 0) + Number(r.n));
  }
  const unanswered = await unansweredLines(
    holderId,
    { from: new Date(from), to: new Date(now.getTime() - MORNING_UNANSWERED_AFTER_MS), workingHours: false },
    now,
  );
  let unmarkedSamples: number | null = null;
  if (await agentToliq1aReady()) {
    // Older than 48 h: a sample of day D is drawn at 20:10, so the first morning past two days is D + 3.
    const [row] = await db.execute<{ n: number }>(sql`
      SELECT count(*)::int AS n FROM agent_samples
       WHERE manager_user_id = ${holderId}::uuid AND mark IS NULL AND day <= ${addDays(tashkentDay(now), -3)}::date`);
    unmarkedSamples = Number(row?.n ?? 0);
  }
  return { day, drafts: drafts.length, went, waited: counted(waited), notDrafted: counted(notDrafted), caps: counted(caps), unanswered: unanswered.length, unmarkedSamples };
}

/** Nothing happened and nothing waits: no line is sent (an agent switched off does not greet him every morning). */
export function morningEmpty(f: MorningFacts): boolean {
  return f.drafts === 0 && f.notDrafted.length === 0 && f.caps.length === 0 && f.unanswered === 0 && (f.unmarkedSamples ?? 0) === 0;
}

const groupsOf = (list: readonly Counted[], word: (code: string) => string) => list.map((g) => `${g.n} — ${word(g.code)}`).join(', ');

/**
 * The line, as one recipient reads it. Pure. «… javobdan … o‘zi ketdi», «… tasdiq kutdi: n — sabab», the lines it
 * wrote nothing to, every cap the day tripped by name (the token cap as the loop guard it is — never a budget, §4.6),
 * «Javobsiz», the undone marks; the page's link last (the drain's «↗️ Ochish») only for a recipient the page admits.
 */
export function morningLine(f: MorningFacts, withPage: boolean): string {
  const date = `${f.day.slice(8, 10)}.${f.day.slice(5, 7)}`;
  const lines: string[] = [];
  const waitedN = f.waited.reduce((s, g) => s + g.n, 0);
  if (f.drafts === 0) lines.push(`🌅 AI sotuvchi, kecha (${date}): javob yozilmadi.`);
  else {
    lines.push(
      `🌅 AI sotuvchi, kecha (${date}): ${f.drafts} javobdan ${f.went} tasi o‘zi ketdi.` +
        (waitedN > 0 ? ` ${waitedN} tasi tasdiq kutdi: ${groupsOf(f.waited, morningWordOf)}.` : ''),
    );
  }
  const notDraftedN = f.notDrafted.reduce((s, g) => s + g.n, 0);
  if (notDraftedN > 0) lines.push(`Javob yozilmagan xabarlar: ${notDraftedN} (${groupsOf(f.notDrafted, noDraftWordOf)}).`);
  if (f.caps.length > 0) lines.push(`⛔ Chegara tugadi: ${f.caps.map((g) => `${capWordOf(g.code)} — ${g.n} ta xabar`).join(', ')}.`);
  lines.push(`Javobsiz: ${f.unanswered}.`);
  if (f.unmarkedSamples !== null && f.unmarkedSamples > 0) lines.push(`Belgilanmagan tekshiruv: ${f.unmarkedSamples} ta.`);
  if (withPage) lines.push(agentPageUrl());
  return lines.join('\n');
}

/**
 * The 08:40 job. Never at night (a late run of the schedule waits for the next morning), never for an agent with no
 * account, never an empty line. Outside any transaction: `designated()` reads the pool.
 */
export async function sendMorningLine(now: Date = new Date()): Promise<number> {
  if (quietHour(now)) return 0;
  const config = await readAgentConfig();
  if (!config?.ownerUserId) return 0;
  const facts = await morningFacts(addDays(tashkentDay(now), -1), config.ownerUserId, now);
  if (morningEmpty(facts)) return 0;
  const recipients = await designated('supervisor');
  const readers = await agentPageReaders(recipients, config);
  for (const userId of recipients) {
    await notifyStaffTelegram({ userIds: [userId], type: 'AgentMorning', text: morningLine(facts, readers.has(userId)) });
  }
  logger.info({ day: facts.day, drafts: facts.drafts, went: facts.went, recipients: recipients.length }, '[agent] morning line');
  return recipients.length;
}
