/**
 * `?manzil=` on the client card — where the full form's mint sent the address
 * card when it did not go to the seller (0151). The address is typed by
 * anybody, so it is read as one of the closed set of outcomes or as nothing at
 * all: an unknown word draws no sentence. Pure and import-free, so the server
 * page and the client button share it.
 */
export const ADDRESS_FLASHES = ['presser', 'muted', 'nobody', 'unlinked', 'failed'] as const;
export type AddressFlash = (typeof ADDRESS_FLASHES)[number];

export function addressFlashOf(raw: string | string[] | undefined | null): AddressFlash | null {
  return typeof raw === 'string' && (ADDRESS_FLASHES as readonly string[]).includes(raw) ? (raw as AddressFlash) : null;
}

/** The `quick.*` sentence keys the address card's outcome is said in. */
export type AddressWord =
  | 'addressPresser'
  | 'addressMuted'
  | 'addressNobody'
  | 'addressNobodyUnlinked'
  | 'addressFailed'
  | 'addressSelfMuted'
  | 'addressSelfNobody';

/**
 * Which sentence a door says about where the address card went — TO the
 * person who pressed (review W-1): `self` when that person IS the code's
 * seller, which on the won dialog and the full form is the common case (a
 * seller winning his own lead, an admin leaving the picker empty), and a
 * third-person «Sotuvchi …» about his own switch reads as somebody else's
 * problem. `seller` (the usual way) says nothing. One rule for the won dialog
 * and the client card's flash (the «+» is always `self`).
 */
export function addressWordOf(outcome: string | null | undefined, self: boolean): AddressWord | null {
  switch (outcome) {
    case 'presser':
      return 'addressPresser';
    case 'muted':
      return self ? 'addressSelfMuted' : 'addressMuted';
    case 'nobody':
      return self ? 'addressSelfNobody' : 'addressNobody';
    case 'unlinked':
      // Never his own card (`cardRecipient` asks presser ≠ seller) — said
      // the second-person way anyway if it ever is.
      return self ? 'addressSelfNobody' : 'addressNobodyUnlinked';
    case 'failed':
      return 'addressFailed';
    default:
      return null;
  }
}
