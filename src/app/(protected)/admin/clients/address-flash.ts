/**
 * `?manzil=` on the client card — where the full form's mint sent the address
 * card when it did not go to the seller (0151). The address is typed by
 * anybody, so it is read as one of the closed set of outcomes or as nothing at
 * all: an unknown word draws no sentence. Pure and import-free, so the server
 * page and the client button share it.
 */
export const ADDRESS_FLASHES = ['presser', 'muted', 'nobody', 'failed'] as const;
export type AddressFlash = (typeof ADDRESS_FLASHES)[number];

export function addressFlashOf(raw: string | string[] | undefined | null): AddressFlash | null {
  return typeof raw === 'string' && (ADDRESS_FLASHES as readonly string[]).includes(raw) ? (raw as AddressFlash) : null;
}
