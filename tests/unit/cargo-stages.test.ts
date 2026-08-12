import { describe, expect, it } from 'vitest';
import {
  CARGO_STAGES,
  cargoStage,
  isMovingStage,
  stageIndex,
  type StageBatch,
} from '@/modules/wms/client-cabinet/stages';
import { clientLabels, stageLabel } from '@/modules/platform/telegram/client-labels';
import { CLIENT_LOCALES } from '@/modules/platform/telegram/client-labels';

const CN_ORIGIN = { country: 'CN', type: 'origin' };
const CN_HUB = { country: 'CN', type: 'hub' };
const UZ_CUSTOMS = { country: 'UZ', type: 'customs' };
const NOWHERE = { country: null, type: null };

const truck = (over: Partial<StageBatch> = {}): StageBatch => ({
  originCountry: 'CN',
  destCountry: 'UZ',
  status: 'in_transit',
  checkpointKey: null,
  ...over,
});

describe('cargoStage — the owner’s ladder, derived', () => {
  it('walks his nine rungs in order', () => {
    // «htoyda qabul → htoy sklatdan yolga chiqdi → htoy qirgiz chegara
    // sklatda → sklatdan yuklandi eksport bolti → transitda / ozbga kirdi /
    // rastamojka → olib ketishingizga tayyor → olib ketdingiz».
    expect(cargoStage('in_stock', CN_ORIGIN, null)).toBe('cn_warehouse');
    expect(cargoStage('planned', CN_ORIGIN, null)).toBe('cn_loading');
    expect(cargoStage('loading', CN_ORIGIN, null)).toBe('cn_loading');
    expect(cargoStage('in_transit', NOWHERE, truck({ destCountry: 'CN' }))).toBe('cn_transit');
    expect(cargoStage('in_stock', CN_HUB, null)).toBe('hub');
    expect(cargoStage('loading', CN_HUB, null)).toBe('hub_loading');
    expect(cargoStage('in_transit', NOWHERE, truck())).toBe('export_transit');
    expect(cargoStage('in_transit', NOWHERE, truck({ checkpointKey: 'in_uz' }))).toBe('in_uz');
    expect(cargoStage('ready_for_pickup', UZ_CUSTOMS, null)).toBe('ready');
    expect(cargoStage('issued', UZ_CUSTOMS, null)).toBe('issued');
  });

  it('the operator’s pin outranks the schedule', () => {
    // A person who has seen the truck inside Uzbekistan knows more than any
    // corridor timing does.
    expect(cargoStage('in_transit', NOWHERE, truck({ checkpointKey: 'at_border' }))).toBe(
      'export_transit',
    );
    expect(cargoStage('in_transit', NOWHERE, truck({ checkpointKey: 'in_kg' }))).toBe(
      'export_transit',
    );
    expect(cargoStage('in_transit', NOWHERE, truck({ checkpointKey: 'in_uz' }))).toBe('in_uz');
  });

  it('a truck that has ARRIVED in Uzbekistan is «rasmiylashtirilmoqda», not «yo‘lda»', () => {
    for (const status of ['arrived', 'unloaded', 'closed']) {
      expect(cargoStage('in_transit', NOWHERE, truck({ status }))).toBe('in_uz');
    }
    // The Chinese leg deliberately has no equivalent: his ladder has no rung
    // for «reached Kashgar, nothing unloaded», and a box on a lorry is
    // honestly on the road.
    expect(cargoStage('in_transit', NOWHERE, truck({ destCountry: 'CN', status: 'arrived' }))).toBe(
      'cn_transit',
    );
  });

  it('an internal Uzbek leg is already in Uzbekistan', () => {
    expect(
      cargoStage('in_transit', NOWHERE, truck({ originCountry: 'UZ', destCountry: 'UZ' })),
    ).toBe('in_uz');
  });

  it('a box standing in Uzbekistan is ours until it is ready', () => {
    // Landed at a distribution warehouse by a direct receipt rather than an
    // unload: still here, still not the customer's.
    expect(cargoStage('in_stock', { country: 'UZ', type: 'distribution' }, null)).toBe('in_uz');
  });

  it('an unknown truck says «yo‘lda» and nothing it cannot support', () => {
    // No batch row readable: the wording of `export_transit` is true of any
    // road, and the service gives it no date because a date needs a
    // destination.
    expect(cargoStage('in_transit', NOWHERE, null)).toBe('export_transit');
    expect(isMovingStage('export_transit')).toBe(true);
    expect(isMovingStage('hub')).toBe(false);
    expect(isMovingStage('ready')).toBe(false);
  });

  it('every rung is ordered and none is a duplicate', () => {
    expect(new Set(CARGO_STAGES).size).toBe(CARGO_STAGES.length);
    for (let i = 1; i < CARGO_STAGES.length; i += 1) {
      expect(stageIndex(CARGO_STAGES[i]!)).toBeGreaterThan(stageIndex(CARGO_STAGES[i - 1]!));
    }
  });

  /**
   * The #163 anchor. `platform` may not import `wms`, so the label dictionary
   * cannot name the stage list and nothing inside either file can notice a
   * rung that was added without its three translations. This test sits
   * outside both and is the only thing that can.
   */
  it('every rung has a sentence in every language a client reads', () => {
    for (const locale of CLIENT_LOCALES) {
      const labels = clientLabels(locale);
      for (const stage of CARGO_STAGES) {
        const label = stageLabel(stage, labels);
        expect(label, `${stage} in ${locale}`).not.toBe(stage);
        expect(label.length).toBeGreaterThan(3);
      }
    }
  });
});
