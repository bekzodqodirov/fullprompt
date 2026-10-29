/**
 * How often his ✅ means «the machine was right» (review fit-10) — the number
 * spec §11's phase-2 gate reads («≥ 90 % over ≥ 50»), so it must not flatter.
 *
 * A draft ends in seven statuses and only some are DECISIONS. A superseded
 * one (the customer wrote again) and an expired one (nobody pressed anything
 * in 24 h) say nothing about the reply's quality, so they are printed BESIDE
 * the rate and never enter it: a rate over only the drafts he chose to touch
 * would be a rate over the easy ones. A ✏️ that rewrote the text is NOT an
 * approval — counting «edited» as approved would hide a full rewrite — and his
 * own answer (🙋, or a reply from his phone) is a refusal of the draft in all
 * but name. So:
 *
 *   rate = sentUnchanged ÷ (sentUnchanged + sentEdited + rejected + answeredHimself)
 *
 * «Sent» is the reply that LEFT: an approved row whose send was cancelled
 * (the kill switch, a newer message, the night) or failed is his decision but
 * not a delivered one, so it is counted apart too — as is one still on its
 * way. A price reply (`kind = 'price'`) is HIS typed price rendered by code,
 * not the model's words, and stays out of the rate (printed beside).
 *
 * Pure: the page reads the rows, this counts them, a unit test pins it.
 */

export interface StatsDraftRow {
  status: string;
  kind: string;
  /** He typed his own text (`final_body` is set). */
  edited: boolean;
  /** The approved reply's outbox status, or null when there is none. */
  outboxStatus: string | null;
  category: string | null;
}

export interface StatsCounts {
  sentUnchanged: number;
  sentEdited: number;
  rejected: number;
  answeredHimself: number;
  /** The denominator: the four above. */
  decided: number;
  /** sentUnchanged ÷ decided, or null when nothing was decided yet. */
  rate: number | null;
}

export interface AgentStats extends StatsCounts {
  superseded: number;
  expired: number;
  /** Still pending or being edited. */
  live: number;
  /** Approved, the reply not yet out (held to its step clock, or sending). */
  onTheWay: number;
  /** Approved, and the send was cancelled, failed, expired or ended unknown. */
  approvedNotSent: number;
  /** His typed prices, decided — never in the rate. */
  price: number;
  byCategory: Record<string, StatsCounts>;
}

const ON_THE_WAY = new Set(['agent', 'sending']);

function emptyCounts(): StatsCounts {
  return { sentUnchanged: 0, sentEdited: 0, rejected: 0, answeredHimself: 0, decided: 0, rate: null };
}

function finish(c: StatsCounts): StatsCounts {
  const decided = c.sentUnchanged + c.sentEdited + c.rejected + c.answeredHimself;
  return { ...c, decided, rate: decided > 0 ? c.sentUnchanged / decided : null };
}

type Bucket = 'sentUnchanged' | 'sentEdited' | 'rejected' | 'answeredHimself';

export function agentStats(rows: readonly StatsDraftRow[]): AgentStats {
  const total = emptyCounts();
  const byCategory: Record<string, StatsCounts> = {};
  let superseded = 0;
  let expired = 0;
  let live = 0;
  let onTheWay = 0;
  let approvedNotSent = 0;
  let price = 0;

  const add = (row: StatsDraftRow, bucket: Bucket) => {
    total[bucket] += 1;
    const key = row.category ?? 'other';
    const c = (byCategory[key] ??= emptyCounts());
    c[bucket] += 1;
  };

  for (const row of rows) {
    if (row.status === 'pending' || row.status === 'editing') {
      live += 1;
      continue;
    }
    if (row.status === 'superseded') {
      superseded += 1;
      continue;
    }
    if (row.status === 'expired') {
      expired += 1;
      continue;
    }
    if (row.kind === 'price') {
      price += 1;
      continue;
    }
    if (row.status === 'rejected') add(row, 'rejected');
    else if (row.status === 'taken_over') add(row, 'answeredHimself');
    else if (row.status === 'approved') {
      if (row.outboxStatus === 'sent') add(row, row.edited ? 'sentEdited' : 'sentUnchanged');
      else if (row.outboxStatus === null || ON_THE_WAY.has(row.outboxStatus)) onTheWay += 1;
      else approvedNotSent += 1;
    }
  }

  return {
    ...finish(total),
    superseded,
    expired,
    live,
    onTheWay,
    approvedNotSent,
    price,
    byCategory: Object.fromEntries(Object.entries(byCategory).map(([key, c]) => [key, finish(c)])),
  };
}
