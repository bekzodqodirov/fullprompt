import { sql } from 'drizzle-orm';
import { writeAudit, type AuditContext } from '../../platform/audit/service';
import { db } from '../../platform/db/client';
import { logger } from '../../platform/logger';
import { sellerlessChatSql } from '../../platform/clients/sellerless';
import { AGENT_SEAT_KEY } from '../../platform/settings/agent-seat';
import { getSetting, personaNameValid, SETTING_DEFAULTS, SETTINGS_AUDIT_ID, setSetting } from '../../platform/settings/service';
import { canLogInSql } from '../../platform/users/login';
import { reachableAt } from '../crm/site-assign-rules';
import { AgentConfigError, mayGovernAgent } from './config';

/**
 * Where a client with no seller of our own is pointed (stage 1a «Hajm», his 7 b): with `client_ai_contact` on, the
 * bot's «💬 Menejer», the Mini App's contact card and the pushes' manager door — all three through ONE read,
 * `managersFor` (wms/client-cabinet) — name the AI seat instead of the office.
 *
 * «No seller» is the per-CHAT predicate (`sellerlessChatSql`, J13), the one the office's broadcast asks too: a chat
 * holding a seller's code is that seller's customer and never sees the seat («sotuvchilarning o'z mijozlariga
 * aytilmaydi»). The seat is shown only while it holds the account the AI speaks from, and only with the handle
 * Telegram itself confirmed within the hour (round 113's rule, `reachableAt` with no typed fallback — a customer
 * who owes money must never be sent to a released name). Anything less: the office, as today.
 *
 * Light imports: `managersFor` is in the listener's closure (the bot's «💬 Menejer»), so this file is too.
 */

/** The persona's title as he worded it (his answer 1: «GSR sotuv menejeri <ism>») — the NAME is a setting. */
export const SEAT_TITLE = 'GSR sotuv menejeri';

/** What the customer reads for the seat: the title, then the persona's name when one is set. */
export function seatDisplayName(persona: string): string {
  const name = persona.trim();
  return name ? `${SEAT_TITLE} ${name}` : SEAT_TITLE;
}

export interface SeatContact {
  name: string;
  /** Never a phone: the AI's number is not a line anybody answers by voice. */
  phone: null;
  telegramUrl: string;
}

/**
 * The seat as this chat's contact, or null (the office stands). ONE statement on the pool — never inside a
 * transaction (#714); its callers are a bot press and the Mini App's open. A read that fails is null and logged:
 * the customer is pointed at the office, never shown an error.
 */
export async function seatContactFor(chatId: bigint, now: Date = new Date()): Promise<SeatContact | null> {
  let row: {
    shown: boolean | null;
    persona: string | null;
    seat_id: string | null;
    seat_live: boolean;
    holder_id: string | null;
    sellerless: boolean;
    tg_status: string | null;
    last_seen_at: string | Date | null;
    tg_username: string | null;
    tg_username_checked_at: string | Date | null;
  } | undefined;
  try {
    const rows = (await db.execute(sql`
      WITH seat AS (
        SELECT lower(value #>> '{}') AS id FROM settings WHERE key = ${AGENT_SEAT_KEY}
      )
      SELECT (SELECT value = 'true'::jsonb FROM settings WHERE key = 'client_ai_contact') AS shown,
             (SELECT value #>> '{}' FROM settings WHERE key = 'agent_persona_name') AS persona,
             (SELECT id FROM seat) AS seat_id,
             coalesce(${canLogInSql('su')}, false) AS seat_live,
             cfg.owner_user_id::text AS holder_id,
             ${sellerlessChatSql(sql`${chatId}::bigint`)} AS sellerless,
             t.status AS tg_status, t.last_seen_at, t.tg_username, t.tg_username_checked_at
        FROM (SELECT 1) one
        LEFT JOIN agent_config cfg ON cfg.id = 1
        LEFT JOIN users su ON su.id::text = (SELECT id FROM seat)
        LEFT JOIN tg_accounts t ON t.manager_user_id = cfg.owner_user_id
    `)) as unknown as NonNullable<typeof row>[];
    row = [...rows][0];
  } catch (err) {
    logger.warn({ err }, '[seat-contact] not read — the office stands');
    return null;
  }
  if (!row) return null;
  // No row is the setting's default — off, as it ships (his ⭐: switched on after stage 2).
  const shown = row.shown === null ? SETTING_DEFAULTS.client_ai_contact === true : row.shown === true;
  if (!shown || !row.sellerless) return null;
  if (!row.seat_id || !row.seat_live || row.holder_id?.toLowerCase() !== row.seat_id) return null;
  if (!row.tg_status) return null;
  const at = (v: string | Date | null) => (v === null ? null : new Date(v));
  const reach = reachableAt(
    {
      typedUsername: null,
      account: {
        status: row.tg_status,
        lastSeenAt: at(row.last_seen_at),
        username: row.tg_username,
        checkedAt: at(row.tg_username_checked_at),
      },
    },
    now,
  );
  if (!reach.ok) return null;
  // A stored name the shape refuses (typed into the table by hand) is no name, never a guess.
  const persona = row.persona && personaNameValid(row.persona) ? row.persona : '';
  return { name: seatDisplayName(persona), phone: null, telegramUrl: `https://t.me/${reach.username}` };
}

/** The setting as its readers use it: true only when stored as true; anything else is the default (off). */
export async function readClientAiContact(): Promise<boolean> {
  return (await getSetting('client_ai_contact')) === true;
}

/**
 * «AI raqamini ko'rsatish» on /suhbatlar/ai (his 7 b) — the super_admin ROLE (`mayGovernAgent`, as the seat itself:
 * who customers are pointed at is the company's choice, not the account's). Audited under the settings' entity id.
 */
export async function setClientAiContact(actor: { id: string; roles: readonly string[] }, on: boolean, ctx: AuditContext): Promise<boolean> {
  if (!mayGovernAgent(actor)) throw new AgentConfigError('forbidden');
  const before = await readClientAiContact();
  if (before === on) return on;
  await setSetting('client_ai_contact', on, actor.id);
  await writeAudit(db, ctx, {
    entityType: 'settings',
    entityId: SETTINGS_AUDIT_ID,
    action: 'update',
    before: { client_ai_contact: before },
    after: { client_ai_contact: on },
  });
  return on;
}
