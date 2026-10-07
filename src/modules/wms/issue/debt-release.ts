import { companyMoneySight, SEES_ALL_MONEY_GRANTS, type MoneyActor } from '../finance/scope';

/**
 * «🔓 Qarzga yuk berildi» — the owner's D6a (2026-10-07): every release on
 * debt is told to the OWNER and the ACCOUNTANT in Telegram — who, which
 * client, how much debt, and the comment. It is the control that REPLACES the
 * request the owner took away from the warehouse manager in D2 («sklad mudiri
 * so'ramasdan beraversin»): he no longer asks, so the people who would have
 * been asked are told.
 *
 * Pure — no database — so the recipient list, the profile's checkbox and a
 * unit test all ask the same predicate of an actor they already hold (#166).
 */

/** His D6 words, «egasi va buxgalter» — people by job, so ROLES (#170). */
export const DEBT_RELEASE_AUDIENCE = ['super_admin', 'accountant'] as const;

/**
 * Exactly the codes `companyMoneySight` reads, for a reader that rebuilds a
 * holder's set from the editable grants (the recipient list) instead of from
 * a session — the `approvalRecipients` idiom, so the list asks the predicate
 * with what the predicate looks at and not a copy of the rule.
 */
export const DEBT_RELEASED_GRANT_CODES: readonly string[] = [...SEES_ALL_MONEY_GRANTS, 'finance.reports'];

/**
 * Does this person receive «qarzga yuk berildi»? Both halves, the evening
 * summary's shape (`readsOwnerSummary`):
 *
 *  - an audience ROLE — the owner (super_admin) or the accountant; not the
 *    admins, whom he did not name;
 *  - the company's money sight — the message carries a client's debt and
 *    links `/finance/qarzga-berilgan`, whose door IS `companyMoneySight`. A
 *    role holder whose grants were customised away from `finance.reports`
 *    reads no register on the screen, so the bot must not read it to him.
 *
 * ONE rule read by three places: the recipient list (issue/service.ts), the
 * profile's «Qarzga yuk berish» checkbox, and the unit test.
 */
export function receivesDebtReleased(actor: MoneyActor & { roles: readonly string[] }): boolean {
  return (
    actor.roles.some((role) => (DEBT_RELEASE_AUDIENCE as readonly string[]).includes(role)) &&
    companyMoneySight(actor) !== null
  );
}

export interface DebtReleasedInput {
  clientCode: string;
  clientName: string;
  warehouseCode: string;
  boxes: number;
  /** The gate's own stored figure — what blocked, i.e. what went out on debt. */
  blockingUsd: number;
  /** The part a deal «muddat» excused at the same release (printed when > 0). */
  deferredUsd: number;
  /** Who opened the gate: the counter's tick, or a recorded approval. */
  how: 'tick' | 'approval';
  /** The counter's answer for a tick (`counterDebtRelease`); null for an approval. */
  right: 'ledger' | 'warehouse' | null;
  /** Who pressed «Topshirish». */
  actorName: string;
  /** Who decided the approval; null for a tick. */
  deciderName: string | null;
  /** The tick's comment, or the request's reason — null only for a legacy row. */
  note: string | null;
  /** The decider's own optional words (an approval only). */
  decisionNote: string | null;
  appUrl: string;
}

const money = (usd: number) => `$${usd.toFixed(2)}`;

/**
 * The message, plain Uzbek (the `UnpricedIssued` sibling's convention — staff
 * texts are built where the context is, never bundle keys).
 *
 * It is only ever called when the gate opened over more than a cent, so a
 * figure at or under it is a caller's mistake and THROWS: the post-commit
 * catch logs it under `[debt-released]`, which is how «$0.00 qarz» never
 * reaches the owner's phone and never vanishes in silence either.
 */
export function debtReleasedText(input: DebtReleasedInput): string {
  if (!(input.blockingUsd > 0.009)) {
    throw new Error(`debtReleasedText: no debt to report (${input.blockingUsd})`);
  }
  const head = `🔓 Qarzga yuk berildi — ${input.clientCode}${input.clientName ? ` (${input.clientName})` : ''} · ${input.warehouseCode}`;
  const figures =
    `${input.boxes} karobka · qarz ${money(input.blockingUsd)}` +
    (input.deferredUsd > 0.009 ? ` · muddatli ${money(input.deferredUsd)}` : '');
  const reason = input.note && input.note.trim() ? input.note.trim() : '—';
  const lines =
    input.how === 'approval'
      ? [
          `Ruxsat: ${input.deciderName ?? '—'} (so‘rov) · berdi: ${input.actorName}`,
          `Sabab: ${reason}`,
          ...(input.decisionNote && input.decisionNote.trim() ? [`Qaror izohi: ${input.decisionNote.trim()}`] : []),
        ]
      : [
          `Ruxsat: ${input.actorName} (belgi${input.right === 'warehouse' ? ', o‘z skladi' : ''})`,
          `Izoh: ${reason}`,
        ];
  return [head, figures, ...lines, `${input.appUrl}/finance/qarzga-berilgan`].join('\n');
}
