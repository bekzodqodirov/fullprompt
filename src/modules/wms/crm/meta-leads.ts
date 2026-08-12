import { createHmac, timingSafeEqual } from 'node:crypto';

/**
 * Meta (Instagram + Facebook) Lead Ads → the funnel.
 *
 * The owner's answers shaped this: his Instagram IS a business account linked
 * to the Facebook page, the adverts are run BOTH by him and by an agency, and
 * the leads go «navbat bilan hammaga». So the door has to accept lead forms it
 * has never been told about, from a page it does not own the adverts on, and
 * put every one of them into the rotation.
 *
 * Everything that can be decided without the network is decided HERE, pure and
 * unit-tested, because the route handler is the one part of this that cannot
 * be exercised in the container: it needs Meta's own signature over Meta's own
 * bytes. The route is a thin shell over these functions, the way
 * `staff-bot.ts` is to its grammy shell.
 */

export interface MetaConfig {
  appSecret: string;
  verifyToken: string;
  pageToken: string;
}

/**
 * The three secrets, from the server `.env` and nowhere else.
 *
 * Returns null unless ALL THREE are present, and the caller must 404 on null.
 * The reason is `undefined === undefined`: an unconfigured server comparing a
 * missing verify token against a missing query parameter would answer «yes,
 * that is me» to anybody who asked, and hand out a subscribed webhook.
 * Failing CLOSED here is the whole point of the function.
 */
export function metaConfig(
  env: Record<string, string | undefined> = process.env,
): MetaConfig | null {
  const appSecret = env.META_APP_SECRET?.trim();
  const verifyToken = env.META_VERIFY_TOKEN?.trim();
  const pageToken = env.META_PAGE_TOKEN?.trim();
  if (!appSecret || !verifyToken || !pageToken) return null;
  return { appSecret, verifyToken, pageToken };
}

/**
 * Does this body really come from Meta?
 *
 * Over the RAW bytes. `await request.json()` and re-serialising cannot work:
 * the HMAC is over what was sent, and JSON.stringify chooses its own spacing,
 * its own number formatting and its own key order.
 *
 * `timingSafeEqual` THROWS on a length mismatch, which a caller who forgot
 * would turn into a 500 — an unhandled crash is an oracle of its own, and Meta
 * reads a non-200 as «try again». Length is checked first, and every early
 * return is a plain false.
 */
export function verifyMetaSignature(raw: string, header: string | null, secret: string): boolean {
  if (!header) return false;
  const [algo, sent] = header.split('=');
  if (algo !== 'sha256' || !sent) return false;
  const expected = createHmac('sha256', secret).update(raw, 'utf8').digest('hex');
  if (sent.length !== expected.length) return false;
  return timingSafeEqual(Buffer.from(sent, 'utf8'), Buffer.from(expected, 'utf8'));
}

export interface LeadgenEvent {
  leadgenId: string;
  formId: string | null;
  pageId: string | null;
  adId: string | null;
  createdTime: number | null;
}

/**
 * The leadgen ids in a webhook body.
 *
 * Meta batches: one POST carries `entry[]`, each with `changes[]`, and a page
 * may send us comments and messages through the same subscription. Anything
 * that is not a `leadgen` change is dropped silently — a webhook that throws
 * on an unexpected field is a webhook that gets retried for ever.
 */
export function leadgenEventsFrom(body: unknown): LeadgenEvent[] {
  const out: LeadgenEvent[] = [];
  const entries = asArray(pick(body, 'entry'));
  for (const entry of entries) {
    for (const change of asArray(pick(entry, 'changes'))) {
      if (str(pick(change, 'field')) !== 'leadgen') continue;
      const value = pick(change, 'value');
      const leadgenId = str(pick(value, 'leadgen_id'));
      if (!leadgenId) continue;
      out.push({
        leadgenId,
        formId: str(pick(value, 'form_id')),
        pageId: str(pick(value, 'page_id')) ?? str(pick(entry, 'id')),
        adId: str(pick(value, 'ad_id')),
        createdTime: num(pick(value, 'created_time')),
      });
    }
  }
  return out;
}

export interface MetaLeadFields {
  name: string | null;
  phone: string | null;
  note: string | null;
  /** The unrecognised questions as PAIRS — the tarjimon's raw material. */
  fields: { key: string; value: string }[];
}

/**
 * Meta's `field_data` → the three things we actually need.
 *
 * The names come from whatever the advert's form was built with — his own, and
 * an agency's — so nothing may be assumed about them beyond the standard
 * prefixes Meta itself documents. A question we do not recognise is not thrown
 * away: it is written into the note, because «what did they ask for» is the
 * first thing the seller wants and the second thing the form was for — and
 * since round 97 it ALSO travels as a pair, so a mapped question can land as
 * a structured value beside its note line, never instead of it.
 */
export function mapFieldData(fieldData: unknown): MetaLeadFields {
  let name: string | null = null;
  let firstName: string | null = null;
  let lastName: string | null = null;
  let phone: string | null = null;
  const extras: string[] = [];
  const fields: { key: string; value: string }[] = [];

  for (const field of asArray(fieldData)) {
    const key = (str(pick(field, 'name')) ?? '').toLowerCase();
    const value = asArray(pick(field, 'values'))
      .map((v) => (typeof v === 'string' ? v : String(v ?? '')))
      .filter(Boolean)
      .join(', ')
      .trim();
    if (!value) continue;

    if (key === 'full_name' || key === 'name') name ??= value;
    else if (key === 'first_name') firstName ??= value;
    else if (key === 'last_name') lastName ??= value;
    else if (key.includes('phone')) phone ??= value;
    else if (key === 'email') extras.push(`email: ${value}`);
    else {
      extras.push(`${key}: ${value}`);
      fields.push({ key, value });
    }
  }

  const joined = [firstName, lastName].filter(Boolean).join(' ').trim();
  return {
    name: name ?? (joined || null),
    phone,
    note: extras.length ? extras.join('\n') : null,
    fields,
  };
}

/**
 * Is this Graph error worth retrying?
 *
 * A lead Meta will not give us — deleted, expired, or a page token that has
 * been revoked — must STOP, or the job retries every few minutes until
 * somebody notices the log. A rate limit or a five-hundred is the opposite: it
 * is our turn again in a moment.
 */
export function isPermanentGraphError(status: number, body: unknown): boolean {
  if (status === 429 || status >= 500) return false;
  const code = num(pick(pick(body, 'error'), 'code'));
  // 4 = application rate limit, 17 = user rate limit, 32 = page rate limit,
  // 613 = custom rate limit. Everything else in the 4xx range is about THIS
  // lead or THIS token and will not change by asking again.
  if (code !== null && [4, 17, 32, 613].includes(code)) return false;
  return status >= 400;
}

// --- the smallest possible shape readers ------------------------------------
// A webhook body is a stranger's JSON. Nothing below may throw on any input.

function pick(value: unknown, key: string): unknown {
  return value && typeof value === 'object' ? (value as Record<string, unknown>)[key] : undefined;
}
function asArray(value: unknown): unknown[] {
  return Array.isArray(value) ? value : [];
}
function str(value: unknown): string | null {
  if (typeof value === 'string' && value.trim()) return value.trim();
  if (typeof value === 'number') return String(value);
  return null;
}
function num(value: unknown): number | null {
  const n = typeof value === 'number' ? value : Number(value);
  return Number.isFinite(n) ? n : null;
}
