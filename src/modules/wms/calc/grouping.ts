/**
 * Turning a model's proposal into draft groups (docs/VED.md phase B, law 1).
 * Pure — the model call itself lives in `tnved/service.ts` and this file
 * decides what may be done with its answer.
 *
 * Two jobs. The first is BATCHING: `proposeGoodsGrouping` refuses more than
 * 200 goods and a calculation may carry a thousand, so a big consignment is
 * asked for in slices — and every slice numbers its items from zero, which is
 * the positional-zip shape (#171) with money on the end. Adding each batch's
 * offset back is the whole of `mergeProposals`.
 *
 * The second is REFUSING TO LOSE CARGO. An item no group claimed is not an
 * item that costs nothing; it is an item nobody has classified, and it
 * becomes its own group at the lowest confidence so it is on the screen
 * demanding an answer.
 */

export interface ProposedGroup {
  tnved_code: string;
  name_ru: string;
  item_indexes: number[];
  confidence: 'high' | 'medium' | 'low';
  reasoning: string;
  duty_rate_pct: number | null;
}

export interface DraftGroup {
  label: string;
  tnvedCode: string | null;
  itemSeqs: number[];
  confidence: 'high' | 'medium' | 'low';
  /** The model's ESTIMATE of the duty. Recorded on the group, multiplied by nothing. */
  aiDutyPct: number | null;
  aiProposed: boolean;
  note: string | null;
}

/** How many goods one model call may carry (`proposeGoodsGrouping`'s own cap). */
export const AI_BATCH_SIZE = 200;

/** `[{offset, count}]` covering `total` items in slices of at most `size`. */
export function planBatches(total: number, size = AI_BATCH_SIZE): { offset: number; count: number }[] {
  if (total <= 0 || size <= 0) return [];
  const out: { offset: number; count: number }[] = [];
  for (let offset = 0; offset < total; offset += size) {
    out.push({ offset, count: Math.min(size, total - offset) });
  }
  return out;
}

/**
 * Fold the batches back into one proposal over the whole list.
 *
 * A batch that failed is passed as `null` and simply contributes nothing —
 * eight hundred goods classified and two hundred left for the manager beats
 * a thousand goods left for the manager because one call timed out.
 *
 * Groups carrying the SAME code are merged across batches, because the same
 * product split across two slices must not become two customs lines. The
 * merged group keeps the WORST confidence of its parts: a code the model was
 * sure about in one batch and unsure about in another is a code to look at.
 */
export function mergeProposals(
  batches: { offset: number; groups: ProposedGroup[] | null }[],
  itemSeqs: number[],
): DraftGroup[] {
  const byCode = new Map<string, DraftGroup>();
  const loose: DraftGroup[] = [];
  const claimed = new Set<number>();

  for (const batch of batches) {
    for (const g of batch.groups ?? []) {
      const seqs: number[] = [];
      for (const local of g.item_indexes) {
        const seq = itemSeqs[batch.offset + local];
        // An index past the end of the batch's own slice is the model
        // mis-counting, not a new item: drop it rather than claim a stranger.
        if (seq === undefined || claimed.has(seq)) continue;
        claimed.add(seq);
        seqs.push(seq);
      }
      if (seqs.length === 0) continue;

      const code = g.tnved_code.trim();
      const draft: DraftGroup = {
        label: g.name_ru.trim() || code || '—',
        tnvedCode: code || null,
        itemSeqs: seqs,
        confidence: g.confidence,
        aiDutyPct: g.duty_rate_pct,
        aiProposed: true,
        note: g.reasoning.trim() || null,
      };

      // A blanked code (the invalid-code path) is not a key: two unrelated
      // unclassified groups must not merge into one because both are empty.
      if (!code) {
        loose.push(draft);
        continue;
      }
      const seen = byCode.get(code);
      if (!seen) {
        byCode.set(code, draft);
        continue;
      }
      seen.itemSeqs.push(...seqs);
      seen.confidence = worstOf(seen.confidence, draft.confidence);
    }
  }

  const groups = [...byCode.values(), ...loose];

  // Whatever no group claimed is still cargo.
  const orphans = itemSeqs.filter((seq) => !claimed.has(seq));
  for (const seq of orphans) {
    groups.push({
      label: '—',
      tnvedCode: null,
      itemSeqs: [seq],
      confidence: 'low',
      aiDutyPct: null,
      aiProposed: false,
      note: null,
    });
  }

  return groups;
}

const RANK = { high: 3, medium: 2, low: 1 } as const;
const worstOf = (a: DraftGroup['confidence'], b: DraftGroup['confidence']) =>
  RANK[a] <= RANK[b] ? a : b;

/**
 * A group's quantity, from the items it holds.
 *
 * Mixed units mean no quantity — 3 rolls and 40 pieces is 43 of nothing, and
 * a customs value multiplied by that number is wrong in a way nobody would
 * catch. The screen shows a blank, the VED types kilograms or splits the
 * group, and the baza refusal keeps the seal shut until one of those happens.
 */
export function groupQuantity(
  items: { quantity: number | null; unit: string | null }[],
): { quantity: number | null; unit: string | null } {
  const units = new Set(items.map((i) => (i.unit ?? '').trim().toLowerCase()).filter(Boolean));
  if (units.size > 1) return { quantity: null, unit: null };
  const withQty = items.filter((i) => i.quantity !== null);
  if (withQty.length === 0) return { quantity: null, unit: [...units][0] ?? null };
  return {
    quantity: round3(withQty.reduce((sum, i) => sum + (i.quantity ?? 0), 0)),
    unit: [...units][0] ?? null,
  };
}

/** Σ of a measure over a group's items — null when not one item carries it. */
export function groupMeasure(values: (number | null)[]): number | null {
  const present = values.filter((v): v is number => v !== null);
  if (present.length === 0) return null;
  return round3(present.reduce((a, b) => a + b, 0));
}

const round3 = (n: number) => Math.round(n * 1000) / 1000;
