import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';

/**
 * The revision clock's fence (VED 2.0 phase 3).
 *
 * The seal and both confirm doors COMPUTE on pool reads (#714 keeps
 * `loadWorkspace` out of transactions) and then compare `calc_requests.rev`
 * under FOR UPDATE — so the whole design rests on ONE invariant: every
 * mutator of a request's pricing state moves the clock. A door that forgets
 * is silent for ever: the seal's conflict check passes over numbers that
 * door just changed, and a version seals a workspace nobody was looking at.
 *
 * Source-shape on purpose, and DERIVED from the file's own export list: a
 * new exported function that is neither classified a MUTATOR nor an EXEMPT
 * reader turns this red, so the next door cannot be forgotten — the author
 * must say which it is (the tx-pool fence's discipline, one law over).
 */

const SRC = readFileSync('src/modules/wms/calc/workspace.ts', 'utf8');

/** Every exported function, with its body up to the next top-level export. */
function exportedBodies(): Map<string, string> {
  const out = new Map<string, string>();
  const re = /^export (?:async )?function (\w+)/gm;
  const hits: { name: string; start: number }[] = [];
  for (let m = re.exec(SRC); m; m = re.exec(SRC)) {
    hits.push({ name: m[1]!, start: m.index });
  }
  for (let i = 0; i < hits.length; i++) {
    const end = i + 1 < hits.length ? hits[i + 1]!.start : SRC.length;
    out.set(hits[i]!.name, SRC.slice(hits[i]!.start, end));
  }
  return out;
}

/** Doors that change what a seal would seal — each must lock the request row
 * (mutateRequest wraps lockRequestInTx + the bump; the table doors and the
 * seal open their own tx and call lockRequestInTx directly, with the bump
 * riding recountItemsInTx / the closing UPDATE). */
const MUTATORS = [
  'setFreightZone',
  'createGroup',
  'deleteGroup',
  'moveItemToGroup',
  'setGroupRates',
  'setItemBaza',
  'setRequestCertificate',
  'setFeeOverride',
  'pullBazasFromDictionary',
  'confirmGroup',
  'confirmAllGroups',
  'saveExtra',
  'deleteExtra',
  'applyProposal',
  'sealCalc',
  'saveTable',
  'deleteItem',
];

/** Exempt, each for a stated reason — a name here is a claim reviewed once,
 * not a hole. */
const EXEMPT: Record<string, string> = {
  guessZone: 'pure',
  // Round 112: the seal's gate, exported so «Готово» and the seal button ask
  // the same question. Reads the workspace it is handed, writes nothing.
  canSeal: 'pure',
  loadWorkspace: 'reader — it is the capture side of the clock',
  currentVersion: 'reader',
  currentSealFor: 'reader',
  recalcFromSealed: 'creates a NEW request from a CLOSED one; the closed subject is immutable',
  proposeGroups: 'its claim (ai_proposal_started_at CAS) is the serialization; the write lands via applyProposal, which locks',
  pullRatesFromDictionary: 'delegates its one write to setGroupRates, which locks',
  recordOffer: 'phase C — writes calc_offers against a SEALED version, not the open workspace',
  offersFor: 'reader',
  releaseOffer: 'offers, not the workspace',
  releasedOfferWhere: 'pure sql fragment',
  offerStandsSql: 'pure sql fragment',
  releasedPriceFor: 'reader',
  // Phase 4: the answer anchor is read off a COMPLETED request — the rev
  // clock guards the open workspace, and lockRequestInTx would refuse
  // `already_closed` here by design (recordOffer re-derives every admission
  // instead).
  lastAnswerAnchorFor: 'reader',
};

describe('every workspace mutator moves the revision clock', () => {
  const bodies = exportedBodies();

  it('every export is classified — an unclassified door is a decision nobody made', () => {
    const unclassified = [...bodies.keys()].filter(
      (name) => !MUTATORS.includes(name) && !(name in EXEMPT),
    );
    expect(unclassified).toEqual([]);
  });

  it.each(MUTATORS)('%s locks the request row', (name) => {
    const body = bodies.get(name);
    expect(body, `${name} vanished from workspace.ts — update the fence's list`).toBeTruthy();
    expect(
      /mutateRequest(<[^>]*>)?\(|lockRequestInTx\(/.test(body!),
      `${name} must run through mutateRequest() or call lockRequestInTx() in its own tx`,
    ).toBe(true);
  });

  it('the seal compares the captured rev under the lock', () => {
    const seal = bodies.get('sealCalc')!;
    expect(seal).toContain('locked.rev !== workspace.rev');
    // And bumps on close, so a second seal attempt or a late save conflicts.
    expect(seal).toContain('rev: sql`${calcRequests.rev} + 1`');
  });

  it('both confirm doors compare the rev their warnings were computed at', () => {
    for (const name of ['confirmGroup', 'confirmAllGroups']) {
      const body = bodies.get(name)!;
      expect(body, `${name} must refuse when the clock moved past its warnings`).toContain(
        'locked.rev !== warnings.rev',
      );
    }
  });

  it('the capture rides loadWorkspace’s FIRST query, never a later read', () => {
    // warningsNow returns the rev of the SAME loadWorkspace call — a capture
    // taken after the compute passes on a torn snapshot.
    expect(SRC).toMatch(/rev: w\?\.rev \?\? -1/);
  });
});
