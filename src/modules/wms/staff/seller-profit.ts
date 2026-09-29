import { addDays, tashkentDayStart } from '../../platform/time/tashkent';
import type { CompanyMoneySight } from '../finance/scope';
import { sellerPerformanceAll } from '../crm/seller-report';
import { earnedOf, upsaleRows } from '../calc/upsale-service';

/**
 * «Hodimlar keltirgan foyda» (0117, his 9: «bizning dashboardda shu hodimlardan
 * kelgan foyda — upsale qilib qancha foyda berdi, yuk berib qancha foyda
 * berdi firmaga») — two numbers per seller, each the exported figure of the
 * report its link opens (#513), never a third calculation:
 *
 *  - «Yukdan foyda» = `sellerPerformanceAll`'s profit, i.e. /reports/sotuvchilar
 *    — the money on the clients whose card names the seller NOW (the report's
 *    money half; open point 4 put the receipt-day alternative to him);
 *  - «Upsale» = the upsale screen's own «earned» (`earnedOf`) over the offers
 *    the seller made in the period.
 *
 * The upsale is INSIDE the cargo profit (it is part of the price the client
 * was charged), so the two are never added — the card says so.
 *
 * Takes the `CompanyMoneySight` token as a REQUIRED argument (round B, O6):
 * a cost-derived profit per seller is company money, and the only way to hold
 * the token is to have asked `seesCompanyMoney`.
 */

export interface StaffProfitRow {
  sellerId: string | null;
  sellerName: string | null;
  cargoProfitUsd: number;
  upsaleUsd: number;
}

const round2 = (n: number) => Math.round(n * 100) / 100;

export async function staffProfit(
  period: { from: string; to: string },
  sight: CompanyMoneySight,
): Promise<{ rows: StaffProfitRow[]; upsaleTruncated: boolean }> {
  void sight;
  const [report, upsale] = await Promise.all([
    sellerPerformanceAll({
      from: tashkentDayStart(period.from),
      to: tashkentDayStart(addDays(period.to, 1)),
      dan: period.from,
      gacha: period.to,
    }),
    // Scope 'all' reads no actor id; the token above is the door. `earnedOf`
    // alone, so no paid-cargo walk (3a): the payable state is not read here.
    upsaleRows('all', '', { from: period.from, to: period.to, walk: 'skip' }),
  ]);
  const bySeller = new Map<string | null, StaffProfitRow>();
  for (const row of report.rows) {
    bySeller.set(row.managerId, {
      sellerId: row.managerId,
      sellerName: row.managerName,
      cargoProfitUsd: row.profitUsd,
      upsaleUsd: 0,
    });
  }
  for (const offer of upsale.rows) {
    const row = bySeller.get(offer.sellerId) ?? {
      sellerId: offer.sellerId,
      sellerName: offer.sellerName,
      cargoProfitUsd: 0,
      upsaleUsd: 0,
    };
    row.upsaleUsd = round2(row.upsaleUsd + earnedOf(offer));
    bySeller.set(offer.sellerId, row);
  }
  const rows = [...bySeller.values()]
    .filter((row) => row.cargoProfitUsd !== 0 || row.upsaleUsd !== 0)
    // Named sellers by the cargo profit (the upsale is inside it, never added);
    // the «—» cohort last, where the report draws it.
    .sort((a, b) => (a.sellerId === null ? 1 : b.sellerId === null ? -1 : b.cargoProfitUsd - a.cargoProfitUsd));
  return { rows, upsaleTruncated: upsale.truncated };
}
