/**
 * «Is this whole truck ONE client's cargo?» (0135, the owner's 7a: «bitta
 * mijozning yuki bitta mashinani to'liq egallasa, tizim logistga «Bu FTL
 * bo'lishi mumkin — tekshiring» deb yozsin»). PURE — the hint's whole
 * decision, pinned by a unit test; the reads that feed it live in `hint.ts`.
 *
 * One OWNER, which is a PERSON and not a code:
 *  - every claimed lot belongs to one client — or to clients that are one
 *    person by phone (`samePerson`: one customer holding 444/555/777 is
 *    ordinary practice, #407; without this a seller could split a whole truck
 *    over two codes and the hint would never fire);
 *  - an unclaimed lot is the owner's only when its MARKING is his
 *    (`markingOf` — «GS500MANIKEN» is GS500's, round 98's convention); any
 *    other unclaimed cargo is a second owner, and no hint;
 *  - a truck carrying ONLY unclaimed cargo resolves its markings to client
 *    codes (`markingOwner`) and hints when they all name one client — a whole
 *    truck that arrives under a marking and is claimed after it left must not
 *    slip past the one check a seller's incentive has.
 * No size floor: «Qarorni baribir odam qiladi» — the hint prints the sizes.
 */

export interface SoleLot {
  clientId: string | null;
  clientCode: string | null;
  marking: string | null;
}

export interface SoleOwnerInputs {
  /** Same person by phone (the cabinet's last-nine rule), asked only of two different claimed clients. */
  samePerson: (a: string, b: string) => boolean;
  /** Does this marking belong to this client code (`markingOfCode`)? */
  markingOf: (marking: string, code: string) => boolean;
  /** The ONE client a marking names by its code prefix, or null when none or several. */
  markingOwner: (marking: string) => { clientId: string; clientCode: string } | null;
}

/** The owner's client ids (one or more codes of one person), or null when the truck is not one owner's. */
export function soleOwnerOf(lots: readonly SoleLot[], io: SoleOwnerInputs): string[] | null {
  if (lots.length === 0) return null;
  const claimed = new Map<string, string>();
  for (const lot of lots) if (lot.clientId) claimed.set(lot.clientId, lot.clientCode ?? '');
  const unclaimed = lots.filter((lot) => !lot.clientId);

  if (claimed.size === 0) {
    let owner: string | null = null;
    for (const lot of unclaimed) {
      const named = lot.marking ? io.markingOwner(lot.marking) : null;
      if (!named) return null;
      if (owner !== null && owner !== named.clientId) return null;
      owner = named.clientId;
    }
    return owner === null ? null : [owner];
  }

  const ids = [...claimed.keys()];
  // One person: every code shares a phone with the first one's group — a
  // chain (A~B, B~C) counts, so this is a connected-group test, not pairwise.
  const group = new Set([ids[0]!]);
  let grew = true;
  while (grew) {
    grew = false;
    for (const id of ids) {
      if (group.has(id)) continue;
      if ([...group].some((member) => io.samePerson(member, id))) {
        group.add(id);
        grew = true;
      }
    }
  }
  if (group.size !== ids.length) return null;

  const codes = [...claimed.values()].filter(Boolean);
  for (const lot of unclaimed) {
    if (!lot.marking || !codes.some((code) => io.markingOf(lot.marking!, code))) return null;
  }
  return ids;
}
