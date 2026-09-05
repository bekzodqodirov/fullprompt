/**
 * One box for a coordinate, because two decimal-degree boxes are not how a
 * person gets a point onto a screen.
 *
 * The owner is not a developer: what he has in his hand is what a map app put
 * on his clipboard — «41.311081, 69.240562», or a link. `coordField` (round
 * 100) is right for the warehouse form, where an admin types two numbers, and
 * wrong here: its `.replace(',', '.')` replaces only the FIRST comma, so a
 * pasted pair becomes «41.311081. 69.240562» and is refused.
 *
 * Pure, so the cases below are the test.
 */

export interface LatLon {
  lat: number;
  lon: number;
}

const PAIR = /(-?\d{1,3}(?:[.,]\d+)?)\s*[,;\s]\s*(-?\d{1,3}(?:[.,]\d+)?)/;

/**
 * Read a point out of whatever was pasted. Returns null for empty (which the
 * caller stores as NULL) and throws nothing — a refusal is the caller's word.
 * `false` means «there is text here and it is not a point», which must not be
 * confused with «the box is empty»: silently storing nothing for a typo is how
 * a warehouse ends up with a note whose pin never arrives.
 */
export function parseLatLon(raw: string): LatLon | null | false {
  const text = raw.trim();
  if (text === '') return null;

  // A maps URL carries the pair in one of a few well-known parameters. Try
  // those first: a Google link also contains a zoom («@41.31,69.24,17z») and a
  // Yandex one puts lon before lat, so the parameter name decides the order.
  const yandexPt = /[?&]pt=(-?\d+(?:\.\d+)?),(-?\d+(?:\.\d+)?)/.exec(text);
  if (yandexPt) return check(Number(yandexPt[2]), Number(yandexPt[1]));
  const yandexLl = /[?&]ll=(-?\d+(?:\.\d+)?),(-?\d+(?:\.\d+)?)/.exec(text);
  if (yandexLl) return check(Number(yandexLl[2]), Number(yandexLl[1]));
  const googleAt = /@(-?\d+(?:\.\d+)?),(-?\d+(?:\.\d+)?)/.exec(text);
  if (googleAt) return check(Number(googleAt[1]), Number(googleAt[2]));
  const googleQ = /[?&]q=(-?\d+(?:\.\d+)?),(-?\d+(?:\.\d+)?)/.exec(text);
  if (googleQ) return check(Number(googleQ[1]), Number(googleQ[2]));

  const pair = PAIR.exec(text);
  if (!pair) return false;
  return check(Number(pair[1]!.replace(',', '.')), Number(pair[2]!.replace(',', '.')));
}

function check(lat: number, lon: number): LatLon | false {
  if (!Number.isFinite(lat) || !Number.isFinite(lon)) return false;
  if (lat < -90 || lat > 90 || lon < -180 || lon > 180) return false;
  // 0°N 0°E is a real place in the Atlantic and nobody in this business means
  // it — round 100's own blocker, one form over.
  if (lat === 0 && lon === 0) return false;
  return { lat, lon };
}

/** What the box shows for a stored point. */
export function formatLatLon(lat: string | number | null, lon: string | number | null): string {
  if (lat === null || lon === null || lat === '' || lon === '') return '';
  return `${Number(lat)}, ${Number(lon)}`;
}
