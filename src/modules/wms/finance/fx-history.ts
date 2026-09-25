import { db } from '../../platform/db/client';
import { lockOwnersTx, reconcileFxResidueTx, type LegacyState } from './fx-residue';
import { legacyFxResidues, type LegacyFxRow } from './fx-legacy';

/**
 * The deploy morning's measurement and its one move (0103, design §5.5.8,
 * `pnpm fx-close-history`). The rule is the reconciler's own: a client's
 * history is the system's to close (`isAutomatic`), so the script only brings
 * forward what that client's next ledger write would do anyway — before the
 * warehouse opens, and with the owner having read the numbers first. Firms'
 * residues are NEVER applied here: #415 documented a hand close for them, and
 * a person closes them on «Kurs qoldiqlari».
 */

export interface FxHistoryPlan {
  clients: {
    byState: Record<LegacyState, { count: number; usd: number }>;
    /** P&L month → Σ of the P&L effect the `auto` closes would book (+ = gain). */
    months: Record<string, number>;
    firstChecks: LegacyFxRow[];
    autoClientIds: string[];
  };
  partners: { byState: Record<LegacyState, number> };
}

const emptyStates = () => ({ auto: { count: 0, usd: 0 }, hand: { count: 0, usd: 0 }, check: { count: 0, usd: 0 }, closable: { count: 0, usd: 0 } });

export async function fxHistoryPlan(): Promise<FxHistoryPlan> {
  const rows = await legacyFxResidues({ includeStaff: true });
  const byState = emptyStates();
  const months: Record<string, number> = {};
  const partners: Record<LegacyState, number> = { auto: 0, hand: 0, check: 0, closable: 0 };
  for (const row of rows) {
    if (row.ledger === 'partner') {
      partners[row.state] += 1;
      continue;
    }
    byState[row.state].count += 1;
    byState[row.state].usd = Math.round((byState[row.state].usd + row.residueUsd) * 100) / 100;
    if (row.state === 'auto') {
      const month = row.anchorDate.slice(0, 7);
      // A client row of −residue: its P&L effect is −residue (FX_PNL_SIGN.client = 1).
      months[month] = Math.round(((months[month] ?? 0) - row.residueUsd) * 100) / 100;
    }
  }
  return {
    clients: {
      byState,
      months,
      firstChecks: rows.filter((row) => row.ledger === 'client' && row.state === 'check').slice(0, 20),
      autoClientIds: [...new Set(rows.filter((row) => row.ledger === 'client' && row.state === 'auto').map((row) => row.ownerId))],
    },
    partners: { byState: partners },
  };
}

/**
 * One transaction per client, idempotent (a second run finds nothing to
 * write), audit actor null with `from: 'fx_history'`; the row's author is the
 * anchor's (the reconciler's rule — the ledger screens join the author).
 */
export async function applyFxHistory(plan: FxHistoryPlan): Promise<{ clients: number; rows: number }> {
  let written = 0;
  for (const clientId of plan.clients.autoClientIds) {
    const changes = await db.transaction(async (tx) => {
      await lockOwnersTx(tx, { clientIds: [clientId] });
      return reconcileFxResidueTx(tx, { clientIds: [clientId] }, { actorId: null }, 'fx_history');
    });
    written += changes.filter((change) => change.action === 'create').length;
  }
  return { clients: plan.clients.autoClientIds.length, rows: written };
}
