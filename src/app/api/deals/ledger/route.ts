import { and, eq } from 'drizzle-orm';
import { NextResponse } from 'next/server';
import { z } from 'zod';
import { db } from '@/modules/platform/db/client';
import { deals } from '@/modules/platform/db/schema';
import { getActor } from '@/modules/platform/rbac/authorize';
import { ledgerDealsForClient } from '@/modules/wms/deals/service';
import { liveDeferralWhere } from '@/modules/wms/finance/service';

/**
 * The deals a client's money may name, for the three-cornered settlement
 * screen (U30) — the SAME list the kassa payment form offers
 * (`ledgerDealsForClient`: open ∪ decided in the last 60 days ∪ a live
 * deferral), fetched per pick because that screen chooses among ~1,700
 * clients and cannot render every client's deals up front.
 *
 * Gated like the screen and its action (`finance.manage`). Each row says
 * whether its deferral is LIVE by the gate's own predicate
 * (`liveDeferralWhere`), because that is the one deal the choice matters for:
 * the handover gate nets a deferral only against payments that name it.
 */
export async function GET(request: Request) {
  const actor = await getActor();
  if (!actor?.permissions.has('finance.manage')) {
    return NextResponse.json({ error: 'forbidden' }, { status: 403 });
  }
  const client = z.string().uuid().safeParse(new URL(request.url).searchParams.get('client'));
  if (!client.success) return NextResponse.json({ results: [] });
  const [rows, deferred] = await Promise.all([
    ledgerDealsForClient(client.data),
    db
      .select({ id: deals.id })
      .from(deals)
      .where(and(eq(deals.clientId, client.data), liveDeferralWhere())),
  ]);
  const live = new Set(deferred.map((row) => row.id));
  return NextResponse.json(
    {
      results: rows.map((row) => ({
        id: row.id,
        code: row.code,
        title: row.title,
        cargo: row.cargo,
        deferred: live.has(row.id),
      })),
    },
    { headers: { 'cache-control': 'private, no-store' } },
  );
}
