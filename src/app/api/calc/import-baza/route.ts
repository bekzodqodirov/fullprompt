import { eq } from 'drizzle-orm';
import { db } from '@/modules/platform/db/client';
import { authorize, AuthError } from '@/modules/platform/rbac/authorize';
import { isQueryCanceled, isServerBehind } from '@/modules/platform/db/errors';
import { logger } from '@/modules/platform/logger';
import { basisConflicts } from '@/modules/wms/calc/basis';
import { onDate, ratesForCodes } from '@/modules/wms/calc/dictionaries';
import { isBazaBasis, type BazaBasis } from '@/modules/wms/calc/pricing';
import { customsImportBatches } from '@/modules/platform/db/schema';
import { BASIS_FOR_UNIT, isFullCode, suggestImportBaza, unitsForItem } from '@/modules/wms/customs/import-baza';
import { readPickerItem } from '@/modules/wms/customs/picker-item';
import { periodText } from '@/modules/wms/customs/import-stats';

/**
 * «Bu kod uchun importda nima bor?» — the picker behind the 📥 chip.
 *
 * It takes an ITEM id and, since 0125, at most one more word: the basis the
 * VED has CHOSEN on the screen (drafted, not yet saved). The name, the code,
 * the count, the weight and the volume are still read off the row itself —
 * by `readPickerItem`, the one read this route shares with the statistics
 * route so the two can never describe different rows (#513). A browser that
 * could pass its own search terms would be a free text search over the whole
 * customs dump behind a calc-screen door. The basis is a validated enum and
 * can only REORDER and LABEL what this row's code already holds — the price
 * a pick lands with is re-read from the file by `saveTable`, never taken
 * from here.
 *
 * The door is the workspace's own grant (`ved.docs`); this app has no
 * middleware, so every /api route states it (#721-726).
 *
 * Round 2 (docs/SAKKIZ-R2.md §7.4): a row coded by a HEADING lists the
 * heading's declarations, each with its own code. A «Tanlash» there RECODES
 * the row, so each candidate is judged by ITS OWN code's law — pickable and
 * «unit matches» alike (regression-7); judged by the heading's law, a
 * candidate the save would refuse would read as a fine choice. The heading
 * read runs under a statement ceiling, and a cancel is a sentence
 * («10 xonali kodni yozing»), never a hung dialog.
 */
export async function GET(request: Request) {
  try {
    await authorize('ved.docs');
  } catch (err) {
    if (err instanceof AuthError) return Response.json({ error: 'forbidden' }, { status: 403 });
    throw err;
  }

  const params = new URL(request.url).searchParams;
  const itemId = params.get('item') ?? '';
  if (!/^[0-9a-f-]{36}$/i.test(itemId)) return Response.json({ error: 'bad_item' }, { status: 400 });
  // Anything off the list is simply not a choice — the row's own answers.
  const drafted = params.get('basis');
  const draftedBasis: BazaBasis | null = isBazaBasis(drafted) ? drafted : null;

  try {
    const item = await readPickerItem(itemId, draftedBasis);
    if (!item) return Response.json({ error: 'not_found' }, { status: 404 });
    // No code, no question: the file is keyed on the code and a name search
    // across every declaration is not what he asked for.
    // WHY there is nothing to show is four different sentences, and the
    // screen used to have to guess from a null batch id — so on deploy
    // morning it told the admin to go and upload a quarter file, which is
    // exactly what he cannot do until the migration has run.
    if (!item.code) return Response.json({ state: 'no_code', candidates: [], batchId: null, total: 0 });

    let sug: Awaited<ReturnType<typeof suggestImportBaza>>;
    try {
      sug = await suggestImportBaza(
        {
          tnvedCode: item.code,
          name: item.name,
          units: item.units,
          weightPerUnitKg: item.perPiece,
        },
        // The picker lists more than the auto-fill ranks, and answers even
        // when the typed name is too short to score — «Лак» is a real
        // product. `named` adds C1's name-matched series, riding the same
        // scan (D4) — on a full code only.
        { picker: true, named: true },
      );
    } catch (err) {
      // A HEADING read over its ceiling (a full code has none). Never the
      // name in the log — it is the VED's customer's goods.
      if (isQueryCanceled(err) && !isFullCode(item.code)) {
        logger.warn({ code: '57014', heading: item.code }, '[calc] import-baza: heading timeout');
        return Response.json(
          { state: 'timeout', candidates: [], batchId: null, total: 0 },
          { headers: { 'cache-control': 'private, no-store' } },
        );
      }
      throw err;
    }
    if (!sug.batchId) {
      return Response.json({ state: 'no_batch', candidates: [], batchId: null, total: 0 });
    }
    // Which quarter he is choosing from. A batch whose period never parsed
    // falls back to its file name — the column is NOT NULL.
    const [batch] = await db
      .select({
        fileName: customsImportBatches.fileName,
        periodFrom: customsImportBatches.periodFrom,
        periodTo: customsImportBatches.periodTo,
      })
      .from(customsImportBatches)
      .where(eq(customsImportBatches.id, sug.batchId))
      .limit(1);
    // The law each candidate would bring with it: the row's own (its block,
    // with any typed override) for a candidate of the row's own code, the
    // BOOK's for any other — read on the pool, one query for every distinct
    // code the list holds.
    const otherCodes = [...new Set(sug.candidates.map((c) => c.tnvedCode))].filter((c) => c !== item.code);
    const book = otherCodes.length > 0 ? await ratesForCodes(otherCodes, onDate()) : new Map();
    const lawOf = (code: string): string | null =>
      code === item.code ? item.dutyUnit : (book.get(code)?.dutyUnit ?? null);
    return Response.json(
      {
        state: 'ok',
        // A declaration in a unit its code's law cannot hold (a pair unit on
        // a juft/litr/m² code) is LISTED — the VED should see the file has it
        // — but cannot be picked: it would land the row in a conflict. By
        // the CANDIDATE's law: the pick recodes the row to its code.
        candidates: sug.candidates.map((c) => {
          const law = lawOf(c.tnvedCode);
          const units = c.tnvedCode === item.code ? item.units : unitsForItem(item.row, law);
          return {
            ...c,
            lawUnit: law,
            unitMatches: units.includes(c.unit),
            pickable: !basisConflicts(law, BASIS_FOR_UNIT[c.unit]),
          };
        }),
        batchId: sug.batchId,
        total: sug.total,
        itemName: item.name,
        tnvedCode: item.code,
        lawUnit: item.dutyUnit,
        // What the row is looking for, in the basis vocabulary — the dialog
        // names it as an expectation, never as a fact about the row.
        wants: item.units.map((u) => BASIS_FOR_UNIT[u]),
        source: periodText(batch),
        // C1's second series. The dialog compares `batchId` with the stats
        // answer's and drops this series when a batch turned READY between
        // the two fetches (statsNamedStale).
        named: sug.named ?? null,
        namedState: sug.namedState ?? null,
        minSim: sug.minSim ?? null,
      },
      { headers: { 'cache-control': 'private, no-store' } },
    );
  } catch (err) {
    // Deploy morning: 0094's tables may not exist yet (#472). The picker
    // says «nothing», the screen keeps working, the number stays the VED's.
    if (isServerBehind(err)) {
      logger.error({ err }, '[calc] import-baza: server behind');
      return Response.json({ state: 'behind', candidates: [], batchId: null, total: 0 });
    }
    throw err;
  }
}
