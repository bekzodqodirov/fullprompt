import { sql, type SQL } from 'drizzle-orm';
import { canLogInSql } from '../users/login';

/**
 * «Sotuvchisi yo'q» — a client CHAT nobody of ours answers as its seller (stage 1a, his 7 b; judge J13). ONE
 * predicate, asked by the office's broadcast (`noManager`, platform/broadcast) and by the cabinet's «💬 Menejer»
 * (`managersFor`, wms/client-cabinet), so the two can never name different people:
 *
 *   no code linked to this chat — the link `linked`, the client active — has a seller who can log in
 *   (`sales_manager_id` NULL, or a person `canLogInSql` refuses: a leaver, a payroll-only row).
 *
 * Per CHAT, never per code row (#267: three codes on one phone are one person). A person routinely holds several
 * codes on one chat (#407), usually all with one seller and sometimes not: a chat holding a seller's code AND a
 * sellerless one is that seller's customer, and his «sotuvchilarning o'z mijozlariga aytilmaydi» forbids pointing it
 * at another number — the per-row reading the plan first wrote (`c.sales_manager_id IS NULL` before `DISTINCT ON`)
 * admitted exactly that chat. And ONE meaning of «no seller»: the broadcast once read only NULL while the cabinet
 * also dropped a leaver, so a departed seller's customers were left out of the message and then shown the AI's
 * number by the bot.
 *
 * `chat` is the SQL expression of the chat id in the caller's own row (`ctl.telegram_chat_id`, or a bound bigint).
 * The aliases are this fragment's own (`sl`, `sc`, `su`) so it never binds to the caller's tables (#128). Pure: no
 * handle, safe inside a transaction.
 */
export function sellerlessChatSql(chat: SQL): SQL<boolean> {
  return sql<boolean>`NOT EXISTS (
    SELECT 1
      FROM client_telegram_links sl
      JOIN clients sc ON sc.id = sl.client_id
      JOIN users su ON su.id = sc.sales_manager_id
     WHERE sl.telegram_chat_id = ${chat}
       AND sl.status = 'linked'
       AND sc.active
       AND ${canLogInSql('su')}
  )`;
}
