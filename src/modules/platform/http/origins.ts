/**
 * Web origins as a setting holds them (round 113's `lead_assign_origins`).
 *
 * Here and not beside the door that reads them, because the settings screen
 * must refuse a typo before it is stored (#472) and platform code may not
 * reach into `wms` — one definition of «an origin», two readers.
 */

/** An exact `https://host[:port]`: no path, no trailing slash — what a browser sends. */
export function isOrigin(value: string): boolean {
  try {
    const url = new URL(value);
    return url.protocol === 'https:' && url.origin === value;
  } catch {
    return false;
  }
}

/** The origins in a setting's text: whitespace or commas between them, junk dropped. */
export function parseOrigins(raw: string | null | undefined): string[] {
  return (raw ?? '')
    .split(/[\s,]+/)
    .map((part) => part.trim())
    .filter(Boolean)
    .filter(isOrigin);
}

/** Does the text hold ONLY origins? The settings screen asks before saving. */
export function originsSettingValid(raw: string): boolean {
  return raw
    .split(/[\s,]+/)
    .map((part) => part.trim())
    .filter(Boolean)
    .every(isOrigin);
}
