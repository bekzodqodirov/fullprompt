import 'dotenv/config';
import { sql } from 'drizzle-orm';
import { db, pgClient } from '../src/modules/platform/db/client';
import { tashkentDay, tashkentDayStart } from '../src/modules/platform/time/tashkent';
import { readAgentConfig } from '../src/modules/wms/agent/config';
import { censusDays, mediaWord, type CensusMessage } from '../src/modules/wms/agent/census';

/**
 * How many drafts the AI sotuvchi pilot would produce (review fit-14, his
 * Q17 ⭐) — READ-ONLY, writes nothing:
 *
 *   docker compose run --rm migrate pnpm exec tsx scripts/agent-census.ts
 *   docker compose run --rm migrate pnpm exec tsx scripts/agent-census.ts --days 30
 *   docker compose run --rm migrate pnpm exec tsx scripts/agent-census.ts --user <uuid>
 *
 * Per Tashkent day, on the agent owner's account (or `--user`): the customer
 * bursts in client/lead chats, split by `draftWorthy` — the worker's own
 * first question — and the distinct strangers the tray holds as «pending».
 * The numbers go into the go-live message. Not a package.json command on
 * purpose (#1228).
 */

const USAGE = 'usage: pnpm exec tsx scripts/agent-census.ts [--days N (1-90, default 14)] [--user <uuid>]';

function parseArgs(argv: string[]): { days: number; user: string | null } | null {
  let days = 14;
  let user: string | null = null;
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i]!;
    if (a === '--days') {
      const n = Number(argv[++i]);
      if (!Number.isInteger(n) || n < 1 || n > 90) return null;
      days = n;
    } else if (a === '--user') {
      const id = argv[++i] ?? '';
      if (!/^[0-9a-f-]{36}$/iu.test(id)) return null;
      user = id;
    } else {
      return null;
    }
  }
  return { days, user };
}

async function main(): Promise<number> {
  const args = parseArgs(process.argv.slice(2));
  if (!args) {
    console.error(USAGE);
    return 2;
  }
  const config = await readAgentConfig();
  const owner = args.user ?? config?.ownerUserId ?? null;
  if (!owner) {
    console.error('No agent owner is configured (Suhbatlar → AI sotuvchi → Sozlamalar) — pass --user <uuid>.');
    console.error(USAGE);
    return 2;
  }
  const since = tashkentDayStart(tashkentDay(new Date(Date.now() - (args.days - 1) * 86_400_000)));

  const rows = await db.execute<{
    peer_id: string;
    direction: string;
    body: string | null;
    has_media: boolean;
    content_type: string | null;
    file_name: string | null;
    day: string;
  }>(sql`
    SELECT m.peer_id::text AS peer_id, m.direction, m.body, m.has_media,
           a.content_type, a.file_name,
           to_char(m.sent_at AT TIME ZONE 'Asia/Tashkent', 'YYYY-MM-DD') AS day
      FROM tg_messages m
      LEFT JOIN LATERAL (
        SELECT content_type, file_name FROM attachments
         WHERE entity_type = 'tg_message' AND entity_id = m.id
         ORDER BY created_at LIMIT 1) a ON true
      LEFT JOIN tg_message_flags f ON f.message_id = m.id
     WHERE m.manager_user_id = ${owner}
       AND f.deleted_at IS NULL
       AND m.sent_at >= ${since.toISOString()}::timestamptz
     ORDER BY m.peer_id, m.sent_at, m.tg_message_id`);
  const messages: CensusMessage[] = rows.map((r) => ({
    peerId: r.peer_id,
    direction: r.direction === 'out' ? 'out' : 'in',
    body: r.body,
    media: mediaWord(r.content_type, r.file_name, r.has_media),
    day: r.day,
  }));
  const days = censusDays(messages);

  const strangers = await db.execute<{ day: string; n: number }>(sql`
    SELECT to_char(created_at AT TIME ZONE 'Asia/Tashkent', 'YYYY-MM-DD') AS day, count(DISTINCT peer_id)::int AS n
      FROM tg_chat_rules
     WHERE manager_user_id = ${owner} AND decision = 'pending'
       AND created_at >= ${since.toISOString()}::timestamptz
     GROUP BY 1 ORDER BY 1`);
  const strangersBy = new Map(strangers.map((s) => [s.day, Number(s.n)]));
  const [pendingNow] = await db.execute<{ n: number }>(sql`
    SELECT count(DISTINCT peer_id)::int AS n FROM tg_chat_rules
     WHERE manager_user_id = ${owner} AND decision = 'pending'`);

  console.log(`AI sotuvchi census — account ${owner}, last ${args.days} days (Tashkent), read-only`);
  console.log('day         bursts  worthy  greeting-only  not-worthy (by reason)           new strangers');
  const allDays = [...new Set([...days.map((d) => d.day), ...strangersBy.keys()])].sort();
  let bursts = 0;
  let worthy = 0;
  let strangerTotal = 0;
  for (const day of allDays) {
    const d = days.find((x) => x.day === day) ?? { day, bursts: 0, worthy: 0, greetingOnly: 0, notWorthy: {} };
    const reasons = Object.entries(d.notWorthy)
      .map(([k, v]) => `${k} ${v}`)
      .join(', ');
    const s = strangersBy.get(day) ?? 0;
    bursts += d.bursts;
    worthy += d.worthy;
    strangerTotal += s;
    console.log(
      `${day}  ${String(d.bursts).padStart(6)}  ${String(d.worthy).padStart(6)}  ${String(d.greetingOnly).padStart(13)}  ${(reasons || '—').padEnd(31)}  ${String(s).padStart(13)}`,
    );
  }
  const n = Math.max(1, allDays.length);
  console.log(
    `total: ${bursts} bursts, ${worthy} worth a draft (≈ ${(worthy / n).toFixed(1)}/day over ${allDays.length} active days); ` +
      `${strangerTotal} new strangers; ${Number(pendingNow?.n ?? 0)} strangers pending on the tray now.`,
  );
  return 0;
}

main()
  .then((code) => {
    process.exitCode = code;
  })
  .catch((err: unknown) => {
    console.error(err);
    process.exitCode = 1;
  })
  .finally(() => void pgClient.end());
