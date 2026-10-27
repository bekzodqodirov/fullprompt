import type { AiVedFreight } from './ai-reply';
import type { FreightBand, FreightResult } from './pricing';
import { freightRefusalText } from './prefill-reply';

/**
 * The road as the machine's reply prints it (docs/SAKKIZ-R2.md K4).
 *
 * `ZONE_ROUTE` and `aiFreight` moved here out of `prefill.ts`, and
 * `freightAnswerFor` is the seam round 2 builds on: one function decides what
 * the reply says about freight — the stored zone or a guessed one, the
 * request's m³ or the lines' Σ, and who can fix a refusal — so the customs
 * reply and the yolkira tariff reply cannot say two different things about
 * one road (#513).
 */

/** The owner's two zones, as a seller reads them — a new zone prints its code. */
export const ZONE_ROUTE: Record<string, string> = {
  cn: 'Xitoy → O‘zbekiston',
  kashgar: 'Qashg‘ar → O‘zbekiston',
  horgos: 'Horgos → O‘zbekiston',
};

/**
 * The road as the AI reply prints it (item 13): the LIST price with the band
 * that made it, so «$1,920» arrives with «180 kg/m³ · $160/m³ × 12 m³» and a
 * seller can check it against the tariff sheet on the wall.
 */
export function aiFreight(
  freight: FreightResult | null,
  measure: { weightKg: number | null; volumeM3: number | null },
): AiVedFreight {
  // Every refusal here is the engine's or a missing zone, and today one tail
  // answers them all — `freightAnswerFor` is where round 2 splits who fixes
  // which (§2.5).
  if (!freight) return { ok: false, refusal: freightRefusalText('zone_required'), tail: 'ved' };
  if (!freight.ok) return { ok: false, refusal: freightRefusalText(freight.reason), tail: 'ved' };
  const b = freight.band;
  const qty = b.perKg ? measure.weightKg : measure.volumeM3;
  const per = `$${b.priceUsd}/${b.perKg ? 'kg' : 'm³'}`;
  const times = qty === null ? per : `${per} × ${Number(qty.toFixed(3))} ${b.perKg ? 'kg' : 'm³'}`;
  return {
    ok: true,
    listUsd: freight.listUsd,
    routeLabel: ZONE_ROUTE[b.zone] ?? b.zone,
    bandText: `${freight.bandDensity} kg/m³ · ${times}`,
    zoneGuessed: false,
    zoneReadFrom: null,
    volumeFromLines: false,
    small: freight.small,
  };
}

/** Everything the freight answer may read — the workspace's figures, named. */
export interface FreightAnswerInput {
  hasFreight: boolean;
  /** Stored on the request. */
  freightZone: string | null;
  /** `Workspace.guessedZone` — priced zones only. */
  guessedZone: string | null;
  fromCity: string | null;
  /** The request's (brutto). */
  weightKg: number | null;
  /** The request's. */
  volumeM3: number | null;
  /** `Workspace.volumeFromLines` (K13). */
  volumeFromLines: boolean;
  /** Every item, grouped or not. */
  lines: readonly { volumeM3: number | null }[];
  /** `Workspace.freight` — the stored zone and the request's totals. */
  stored: FreightResult | null;
}

/**
 * What the reply says about the road, or null on a job that has none.
 *
 * K reproduces today exactly: the stored zone and the request's totals,
 * through `aiFreight`, and nothing guessed or summed — the tariff is unread
 * until round 2's P1 fills the body (§6.4).
 */
export function freightAnswerFor(
  input: FreightAnswerInput,
  /** The bands in force — unread in K; P1's body prices a guessed zone off them. */
  _tariff: readonly FreightBand[],
): AiVedFreight | null {
  return input.hasFreight ? aiFreight(input.stored, input) : null;
}
