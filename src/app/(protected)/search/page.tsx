import Link from 'next/link';
import { eq, sql } from 'drizzle-orm';
import { redirect } from 'next/navigation';
import { getTranslations } from 'next-intl/server';
import { db } from '@/modules/platform/db/client';
import {
  boxes,
  clients,
  receiptLots,
  receipts,
} from '@/modules/platform/db/schema';
import { getActor } from '@/modules/platform/rbac/authorize';

/**
 * Global search v1 (spec §12): client code/name, box short code, receipt no,
 * product zh/ru, and the combined `gs777-a` client+letter form.
 */
export default async function SearchPage({
  searchParams,
}: {
  searchParams: Promise<{ q?: string }>;
}) {
  const actor = await getActor();
  if (!actor) redirect('/login');
  const t = await getTranslations('search');
  const { q = '' } = await searchParams;
  const query = q.trim();

  let clientHits: { id: string; clientCode: string; name: string }[] = [];
  let receiptHits: { id: string; number: string | null }[] = [];
  let boxHits: { id: string; shortCode: string; status: string }[] = [];
  let lotHits: {
    id: string;
    letter: string | null;
    productNameZh: string;
    productNameRu: string | null;
    clientCode: string | null;
  }[] = [];

  if (query) {
    const like = `%${query}%`;

    // Combined client+letter form: gs777-a → client GS777, letter A (spec §12)
    const combined = query.toUpperCase().match(/^([A-Z]+\d+)-([A-Z]{1,2})$/);
    if (combined) {
      const [, code, letter] = combined;
      lotHits = await db
        .select({
          id: receiptLots.id,
          letter: receiptLots.letter,
          productNameZh: receiptLots.productNameZh,
          productNameRu: receiptLots.productNameRu,
          clientCode: clients.clientCode,
        })
        .from(receiptLots)
        .innerJoin(receipts, eq(receiptLots.receiptId, receipts.id))
        .innerJoin(clients, eq(receipts.clientId, clients.id))
        .where(sql`${clients.clientCode} = ${code} AND ${receiptLots.letter} = ${letter}`)
        .limit(10);
    }

    clientHits = await db
      .select({ id: clients.id, clientCode: clients.clientCode, name: clients.name })
      .from(clients)
      .where(sql`${clients.clientCode} ILIKE ${like} OR ${clients.name} ILIKE ${like}`)
      .limit(5);

    receiptHits = await db
      .select({ id: receipts.id, number: receipts.number })
      .from(receipts)
      .where(sql`${receipts.number} ILIKE ${like}`)
      .limit(5);

    boxHits = await db
      .select({ id: boxes.id, shortCode: boxes.shortCode, status: boxes.status })
      .from(boxes)
      .where(sql`${boxes.shortCode} ILIKE ${like}`)
      .limit(10);

    if (!combined) {
      lotHits = await db
        .select({
          id: receiptLots.id,
          letter: receiptLots.letter,
          productNameZh: receiptLots.productNameZh,
          productNameRu: receiptLots.productNameRu,
          clientCode: clients.clientCode,
        })
        .from(receiptLots)
        .innerJoin(receipts, eq(receiptLots.receiptId, receipts.id))
        .leftJoin(clients, eq(receipts.clientId, clients.id))
        .where(
          sql`${receiptLots.productNameZh} ILIKE ${like} OR ${receiptLots.productNameRu} ILIKE ${like}`,
        )
        .limit(10);
    }
  }

  const total = clientHits.length + receiptHits.length + boxHits.length + lotHits.length;

  return (
    <div className="space-y-4">
      <form method="get">
        <input
          type="search"
          name="q"
          defaultValue={query}
          placeholder={t('placeholder')}
          className="input"
          autoFocus
        />
      </form>

      {query && total === 0 && <p className="text-gray-500">{t('nothing')}</p>}

      {lotHits.length > 0 && (
        <section>
          <h2 className="mb-1 text-sm font-bold text-gray-500">{t('lotsGroup')}</h2>
          {lotHits.map((lot) => (
            <Link key={lot.id} href={`/stock?lot=${lot.id}`} className="card mb-1 block !p-3 hover:bg-gray-50">
              <span className="font-mono font-extrabold text-blue-800">
                {lot.clientCode ?? '❓'}-{lot.letter}
              </span>{' '}
              {lot.productNameZh} {lot.productNameRu && `(${lot.productNameRu})`}
            </Link>
          ))}
        </section>
      )}

      {clientHits.length > 0 && (
        <section>
          <h2 className="mb-1 text-sm font-bold text-gray-500">{t('clients')}</h2>
          {clientHits.map((client) => (
            <Link key={client.id} href={`/stock?client=${client.id}`} className="card mb-1 block !p-3 hover:bg-gray-50">
              <span className="font-mono font-extrabold text-blue-800">{client.clientCode}</span>{' '}
              {client.name}
            </Link>
          ))}
        </section>
      )}

      {boxHits.length > 0 && (
        <section>
          <h2 className="mb-1 text-sm font-bold text-gray-500">{t('boxesGroup')}</h2>
          {boxHits.map((box) => (
            <Link key={box.id} href={`/boxes/${box.id}`} className="card mb-1 block !p-3 font-mono hover:bg-gray-50">
              {box.shortCode}
            </Link>
          ))}
        </section>
      )}

      {receiptHits.length > 0 && (
        <section>
          <h2 className="mb-1 text-sm font-bold text-gray-500">{t('receipts')}</h2>
          {receiptHits.map((receipt) => (
            <Link key={receipt.id} href={`/receipts/${receipt.id}`} className="card mb-1 block !p-3 font-mono hover:bg-gray-50">
              {receipt.number}
            </Link>
          ))}
        </section>
      )}
    </div>
  );
}
