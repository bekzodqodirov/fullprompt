import { b, groupDigits, h, i } from '../../platform/telegram/format';
import { heroHtml, type Hero } from './celebrate-text';
import type { Standing } from './rating-math';

/**
 * The Saturday rating and the month's champion as words (0134) — PURE, so
 * every line is pinned by a test. Kub, kg and prixod counts only: the group is
 * read by every colleague, and kub is not money (the record's one safe figure
 * for a mixed room — no profit, no KPI dollars, no client).
 */

const MEDAL = ['🥇', '🥈', '🥉'];

/** Kub to two places, the way every staff surface prints it. */
export const kub = (m3: number) => groupDigits(Math.round(m3 * 100) / 100);
export const kgText = (kg: number) => groupDigits(Math.round(kg));

/** «▲ +3.1» / «▼ −0.4» against the person's own previous week; nothing when it did not move. */
export function deltaText(now: number, before: number | null): string {
  if (before === null) return ' 🆕';
  const d = Math.round((now - before) * 100) / 100;
  if (d === 0) return '';
  return d > 0 ? ` ▲ +${kub(d)}` : ` ▼ −${kub(-d)}`;
}

/** A ten-cell bar for the team goal — the only drawing a message can carry. */
export function goalBar(done: number, goal: number): string {
  const filled = Math.max(0, Math.min(10, Math.floor((done / goal) * 10)));
  return '▓'.repeat(filled) + '░'.repeat(10 - filled);
}

/** «11.10 18:00 — 18.10 18:00» in Tashkent (UTC+5, no daylight saving). */
export function windowLabel(from: Date, to: Date): string {
  const f = (d: Date) => {
    const t = new Date(d.getTime() + 5 * 3_600_000);
    const dd = String(t.getUTCDate()).padStart(2, '0');
    const mm = String(t.getUTCMonth() + 1).padStart(2, '0');
    const hh = String(t.getUTCHours()).padStart(2, '0');
    const mi = String(t.getUTCMinutes()).padStart(2, '0');
    return `${dd}.${mm} ${hh}:${mi}`;
  };
  return `${f(from)} — ${f(to)}`;
}

/** One seller's FTL for the separate, pointless line (0135, his 3b). */
export interface FtlLine {
  userId: string;
  name: string;
  m3: number;
  kg: number;
  receipts: number;
}

export interface RatingView {
  from: Date;
  to: Date;
  rows: (Standing & { hero: Hero; before: number | null })[];
  team: { m3: number; kg: number; receipts: number };
  teamBefore: number | null;
  goalM3: number | null;
  streaks: { name: string; weeks: number }[];
  records: { name: string; m3: number }[];
  unstamped: { m3: number; receipts: number };
  idleSellers: number;
  /** The week's FTL per seller — out of the ranking and the team's kub, named apart. */
  ftl: FtlLine[];
}

/** How many FTL lines the post names — the rest is a count. */
export const FTL_ROWS = 10;

/**
 * The FTL block (0135, his 3b «alohida qatorda … ochkosiz»): AFTER the team and
 * the goal, so «Jamoa:» is never read as including it; plain names, no rank,
 * no mention, kub-first like the ranked rows. «prixod» and not «mashina»: a week
 * counts cargo by its China receipt day, mostly before any truck exists.
 */
export function ftlBlock(rows: FtlLine[]): string[] {
  if (rows.length === 0) return [];
  const lines = [`🚛 ${b('FTL — butun mashina (ochkosiz):')}`];
  for (const row of rows.slice(0, FTL_ROWS)) {
    lines.push(h(`${row.name} — ${kub(row.m3)} kub · ${kgText(row.kg)} kg · ${row.receipts} prixod`));
  }
  if (rows.length > FTL_ROWS) lines.push(h(`… yana ${rows.length - FTL_ROWS} kishi`));
  return lines;
}

/** How many people the post lists by name — the rest is a count, and Telegram's 4096 is never near. */
export const RATING_ROWS = 20;

export function ratingHtml(v: RatingView): string {
  const lines: string[] = [];
  lines.push(`🏆 ${b('Haftalik reyting')}`);
  lines.push(h(windowLabel(v.from, v.to)));
  lines.push('');
  if (v.rows.length === 0) {
    // With an FTL line below, «no cargo» would contradict it (0135).
    lines.push(v.ftl.length > 0 ? 'Bu hafta sborniy (LTL) yuk hali olib kelinmadi.' : 'Bu hafta hali yuk olib kelinmadi.');
  }
  for (const row of v.rows.slice(0, RATING_ROWS)) {
    const place = row.rank <= 3 ? MEDAL[row.rank - 1]! : `${row.rank}.`;
    const name = row.rank <= 3 ? heroHtml(row.hero) : h(row.hero.name);
    lines.push(
      `${place} ${name} — ${h(`${kub(row.m3)} kub · ${kgText(row.kg)} kg · ${row.receipts} prixod`)}${h(deltaText(row.m3, row.before))}`,
    );
  }
  if (v.rows.length > RATING_ROWS) lines.push(h(`… yana ${v.rows.length - RATING_ROWS} kishi`));
  lines.push('');
  const teamLine = `${kub(v.team.m3)} kub · ${kgText(v.team.kg)} kg · ${v.team.receipts} prixod`;
  const before =
    v.teamBefore === null ? '' : ` (o'tgan hafta ${kub(v.teamBefore)} kub${deltaText(v.team.m3, v.teamBefore)})`;
  lines.push(`${b('Jamoa:')} ${h(teamLine + before)}`);
  if (v.goalM3 && v.goalM3 > 0) {
    const pct = Math.floor((v.team.m3 / v.goalM3) * 100);
    lines.push(
      v.team.m3 >= v.goalM3
        ? `🎯 ${h(`Jamoa maqsadi ${kub(v.goalM3)} kub — bajarildi! ✅ ${goalBar(1, 1)}`)}`
        : `🎯 ${h(`Jamoa maqsadi: ${kub(v.team.m3)} / ${kub(v.goalM3)} kub — ${pct} % ${goalBar(v.team.m3, v.goalM3)}`)}`,
    );
  }
  const ftl = ftlBlock(v.ftl);
  if (ftl.length > 0) lines.push('', ...ftl, '');
  for (const s of v.streaks) lines.push(`🔥 ${h(`${s.name} — ${s.weeks} hafta ketma-ket 1-o'rinda!`)}`);
  for (const r of v.records) lines.push(`⭐ ${h(`${r.name} — shaxsiy rekord: ${kub(r.m3)} kub!`)}`);
  if (v.unstamped.receipts > 0) {
    lines.push(h(`Sotuvchisi yozilmagan yuk: ${kub(v.unstamped.m3)} kub (${v.unstamped.receipts} prixod)`));
  }
  if (v.idleSellers > 0) lines.push(h(`Bu hafta yuk olib kelmagan sotuvchilar: ${v.idleSellers} kishi`));
  lines.push('');
  lines.push(i(h("18:00 holati. Prixod orqa sana bilan kiritilsa, ekrandagi raqam biroz o'zgarishi mumkin.")));
  return lines.join('\n');
}

const MONTHS_UZ = [
  'Yanvar', 'Fevral', 'Mart', 'Aprel', 'May', 'Iyun',
  'Iyul', 'Avgust', 'Sentabr', 'Oktabr', 'Noyabr', 'Dekabr',
];

export function monthName(month: string): string {
  return `${MONTHS_UZ[Number(month.slice(5, 7)) - 1] ?? month} ${month.slice(0, 4)}`;
}

export function championHtml(v: {
  month: string;
  rows: (Standing & { hero: Hero })[];
  team: { m3: number; kg: number; receipts: number };
}): string {
  const lines: string[] = [`👑 ${b(h(`Oy chempioni — ${monthName(v.month)}`))}`, ''];
  const podium = v.rows.filter((r) => r.rank <= 3);
  if (podium.length === 0) lines.push("Bu oy yuk olib kelinmadi.");
  for (const row of podium) {
    lines.push(
      `${MEDAL[row.rank - 1]} ${heroHtml(row.hero)} — ${h(`${kub(row.m3)} kub · ${kgText(row.kg)} kg · ${row.receipts} prixod`)}`,
    );
  }
  lines.push('');
  lines.push(`${b('Jamoa oyi:')} ${h(`${kub(v.team.m3)} kub · ${kgText(v.team.kg)} kg · ${v.team.receipts} prixod`)}`);
  if (podium.length > 0) lines.push('Barakalla! 👏');
  return lines.join('\n');
}
