import { and, eq, gte, inArray, ne } from 'drizzle-orm';
import { db } from '../../platform/db/client';
import { agentDrafts, agentOutbox, clients, users } from '../../platform/db/schema';
import { getSetting } from '../../platform/settings/service';
import { canLogInSql } from '../../platform/users/login';
import { tashkentDay, tashkentDayStart } from '../../platform/time/tashkent';
import type { AviaCargo, QuotedRoad } from './context';
import type { AgentLocale, ScriptName } from './locale';
import { airMentionIn, customerSources, urlsIn, type NumberSource, type TravelMode } from './numbers';
import { warehouseAddressTexts } from './kb';
import { GS_REMINDER } from './seed-kb';
import { addressAnchorsOf, checkAgentReply, checkOwnerReply, codeCandidatesIn, textFingerprint, type PolicyHit, type PolicyResult } from './policy';
import { AGENT_LIMITS } from './limits';

/**
 * The policy's inputs that are FACTS ABOUT THE WORLD (who else got this text,
 * which codes are in the book, who works here) — read fresh every time the
 * policy runs, at the draft AND again at ✅ (`decideDraft` re-runs it on the
 * stored body, leak-3). What the RUN learned (the tool figures, the facts it
 * used, the customer's script) is stored on the draft as `PolicyMemory` and
 * carried to the re-run unchanged.
 */

export interface PolicyMemory {
  language: AgentLocale;
  customerScript: ScriptName | null;
  sources: NumberSource[];
  allowedPhones: string[];
  allowedUrls: string[];
  mapUrls: string[];
  askedLocation: boolean;
  hasEstimate: boolean;
  /**
   * The estimate is our China warehouses' price (his third set «3») — the
   * reply must carry the condition and the factory leg. Optional: a memory
   * stored before it, and the 💵 draft's, have none, and none means no.
   */
  fromOurWarehouse?: boolean;
  /** The approved facts' name words (`nameWordsOf`, B9) — a colleague a fact names is the fact's. */
  factNameWords?: string[];
  /** The one road the customer asked about — a reply's day count naming none is that road's. Absent = none known. */
  askedMode?: TravelMode | null;
  /**
   * The draft carries an Uzbek translation (K29) — a Persian or Chinese
   * reply without one is blocked at the write AND at ✅. Absent (a memory
   * written before it, the 💵 draft's) reads as none.
   */
  hasGloss?: boolean;
  /** An avia quote and no truck's (his fourth set «2»): no China address in the reply. Absent = not one. */
  aviaOnly?: boolean;
  /** Avia was spoken of, the road not decided to be it (#1485): a China address in the reply warns. Absent = not spoken of. */
  aviaMentioned?: boolean;
  /** The Chinese characters of the facts the run read — a verbatim address is the fact's script (his fourth set). Absent = none. */
  quotableHan?: string;
  /** The road this run priced or asked (`quotedRoadOf`) — the next run's `lastQuote` (review R1). Absent = none. */
  quotedRoad?: QuotedRoad | null;
  /** The flight's cargo as the avia tool read it, when this run quoted one — what the follow-up's card names. */
  quotedAir?: AviaCargo | null;
  ownCodes: string[];
  /** The customer's own manager — the one staff name a reply may carry. */
  managerName: string | null;
  canary: string;
}

const MAP_URL = /yandex\.[a-z]+\/maps|maps\.app\.goo\.gl|google\.[a-z]+\/maps|2gis\./iu;

/** Split the approved links into the map ones (only when asked) and the rest. */
export function splitUrls(urls: readonly string[]): { mapUrls: string[]; allowedUrls: string[] } {
  const mapUrls = urls.filter((u) => MAP_URL.test(u));
  return { mapUrls, allowedUrls: urls.filter((u) => !MAP_URL.test(u)) };
}

const LOCATION_ASK = /qayer|manzil|lokatsiya|адрес|где\s|қаер|манзил|location|address|where|کجا|آدرس|地址|在哪/iu;

export function askedLocation(texts: readonly string[]): boolean {
  return texts.some((t) => LOCATION_ASK.test(t));
}

/** The customer's own figures as sources — what lets «5 kub» be repeated back. */
export function customerNumberSources(messages: readonly { direction: string; body: string; ref: string }[]): NumberSource[] {
  return customerSources(
    messages.filter((m) => m.direction === 'in').map((m) => ({ text: m.body, label: `mijoz ${m.ref}` })),
  );
}

/**
 * The book is asked about every spelling G6 judges — «ГС778» and «GS۷۷۸» as
 * well as «GS778» (P3, leak-7): a code the lookup never saw cannot be found
 * foreign by the policy, however it is written.
 */
async function bookCodesIn(body: string): Promise<Set<string>> {
  const candidates = codeCandidatesIn(body);
  if (candidates.length === 0) return new Set();
  const rows = await db.select({ code: clients.clientCode }).from(clients).where(inArray(clients.clientCode, candidates));
  return new Set(rows.map((r) => r.code));
}

async function staffNamesExcept(managerName: string | null, accountUserId: string): Promise<string[]> {
  // A colleague NOW (`canLogInSql`, 0120) — the login rule every staff list asks. The account's own
  // person is the persona and no colleague: «Hozir Bekzod akaga yetkazaman» is the spec's own
  // escalation line (§6), and since one word of a colleague's name warns (P3) it would warn on every one.
  const rows = await db
    .select({ name: users.fullName })
    .from(users)
    .where(and(canLogInSql(), ne(users.id, accountUserId)));
  return rows.map((r) => r.name).filter((n) => n && n !== managerName);
}

/**
 * The words a stored row's fingerprint leaves out — ITS customer's codes and
 * name, read off the draft it was approved from (final review K1). Every row
 * was fingerprinted with THIS chat's names, so ten customers greeted by name
 * with one address sentence kept ten different names in ten fingerprints and
 * the same-text fuse never tripped. A draft that stored none leaves nothing out.
 */
export function stripOfDraftPolicy(policy: unknown): string[] {
  const p = (policy ?? {}) as { memory?: { ownCodes?: unknown }; card?: { customerLabel?: unknown } };
  const codes = Array.isArray(p.memory?.ownCodes) ? p.memory.ownCodes.filter((c): c is string => typeof c === 'string') : [];
  const label = typeof p.card?.customerLabel === 'string' ? p.card.customerLabel : '';
  // «GS777, GS778 · Bobur Aliyev» / «Lid: Bobur» — the label's words; «Lid:» is the same word in every lead's.
  const words = label.split(/[\s,·]+/u).filter((w) => w !== '' && w !== 'Lid:');
  return [...new Set([...codes, ...words])];
}

/** Distinct OTHER peers that got the same fingerprint from the agent in 24 h, and the link counts (G10). */
async function sendCounts(managerUserId: string, peerId: bigint, body: string, strip: string[]) {
  const since = new Date(Date.now() - 24 * 3_600_000);
  const rows = await db
    .select({ peerId: agentOutbox.peerId, body: agentOutbox.body, sentAt: agentOutbox.sentAt, policy: agentDrafts.policy })
    .from(agentOutbox)
    .leftJoin(agentDrafts, eq(agentDrafts.id, agentOutbox.draftId))
    .where(
      and(
        eq(agentOutbox.managerUserId, managerUserId),
        inArray(agentOutbox.status, ['agent', 'sending', 'sent', 'unknown']),
        gte(agentOutbox.queuedAt, new Date(Date.now() - 7 * 86_400_000)),
      ),
    );
  const fp = textFingerprint(body, strip);
  const peers = new Set<string>();
  let urlsToChat7d = 0;
  let urlsToday = 0;
  const dayStart = tashkentDayStart(tashkentDay());
  for (const r of rows) {
    const hasUrl = urlsIn(r.body).length > 0;
    if (hasUrl && r.peerId === peerId) urlsToChat7d += 1;
    if (hasUrl && (r.sentAt ?? new Date()) >= dayStart) urlsToday += 1;
    // Each stored row folded with ITS OWN customer's names and codes (K1).
    if (r.peerId !== peerId && (r.sentAt ?? new Date()) >= since && textFingerprint(r.body, stripOfDraftPolicy(r.policy)) === fp) {
      peers.add(String(r.peerId));
    }
  }
  return { fingerprintPeers: peers.size, urlsToChat7d, urlsToday };
}

/** The full policy over a MACHINE reply, with the world read now. */
export async function policyFor(input: {
  managerUserId: string;
  peerId: bigint;
  body: string;
  memory: PolicyMemory;
  /** Names and codes of THIS customer — stripped from the fingerprint. */
  strip: string[];
}): Promise<PolicyResult> {
  const [bookCodes, staffNames, counts, codePrefix, addresses] = await Promise.all([
    bookCodesIn(input.body),
    staffNamesExcept(input.memory.managerName, input.managerUserId),
    sendCounts(input.managerUserId, input.peerId, input.body, input.strip),
    getSetting('client_code_prefix'),
    // Read now, not remembered: the address he corrects this morning is the one an older draft's ✅ refuses.
    // …and whenever the reply itself speaks of the flight (#1486): the warning reads the reply too.
    input.memory.aviaOnly === true || input.memory.aviaMentioned === true || airMentionIn(input.body)
      ? warehouseAddressTexts()
      : Promise.resolve([]),
  ]);
  return checkAgentReply({
    body: input.body,
    language: input.memory.language,
    customerScript: input.memory.customerScript,
    numberSources: input.memory.sources,
    removeWhole: [],
    ownCodes: input.memory.ownCodes,
    bookCodes,
    codePrefix: String(codePrefix ?? ''),
    allowedPhones: input.memory.allowedPhones,
    allowedUrls: input.memory.allowedUrls,
    mapUrls: input.memory.mapUrls,
    askedLocation: input.memory.askedLocation,
    staffNames,
    // The words of the customer's own name (the codes in `strip` carry digits): greeting him is not naming a colleague.
    customerNames: input.strip.filter((s) => /\p{L}/u.test(s) && !/\d/u.test(s)),
    canary: input.memory.canary,
    ...counts,
    hasEstimate: input.memory.hasEstimate,
    fromOurWarehouse: input.memory.fromOurWarehouse === true,
    factNameWords: input.memory.factNameWords ?? [],
    askedMode: input.memory.askedMode ?? null,
    hasGloss: input.memory.hasGloss === true,
    aviaOnly: input.memory.aviaOnly === true,
    aviaMentioned: input.memory.aviaMentioned === true,
    quotableHan: input.memory.quotableHan ?? '',
    // The GS reminder rides inside every warehouse's fact and is nobody's address.
    warehouseAddress: addressAnchorsOf(addresses, [GS_REMINDER]),
  });
}

/**
 * His own ✏️ text — only what would be refused anyway blocks (§17.6).
 *
 * The 💵 price reply is a fixed template, the one AI text certain to be the
 * same to every customer once its digits fold away — and the owner subset has
 * no G10 (final review K3). Given the chat (`sameText`), the same-text count
 * is asked and said as a WARNING on the card: five quotes a day are his
 * ordinary work, and a block at three peers would stop it.
 */
export async function ownerPolicyFor(
  body: string,
  ownCodes: string[],
  // REQUIRED, null included: the card's G10 warning is counted only where a
  // caller names the chat, and an optional argument is one a new caller forgets.
  sameText: { managerUserId: string; peerId: bigint; strip: string[] } | null,
): Promise<PolicyResult> {
  const [bookCodes, codePrefix, counts] = await Promise.all([
    bookCodesIn(body),
    getSetting('client_code_prefix'),
    sameText ? sendCounts(sameText.managerUserId, sameText.peerId, body, sameText.strip) : null,
  ]);
  const result = checkOwnerReply({ body, ownCodes, bookCodes, codePrefix: String(codePrefix ?? '') });
  const warning = sameTextWarning(counts?.fingerprintPeers ?? 0);
  return warning ? { ...result, warnings: [...result.warnings, warning] } : result;
}

/** The G10 fingerprint as a warning — the same number of peers the machine's block counts. */
export function sameTextWarning(fingerprintPeers: number): PolicyHit | null {
  return fingerprintPeers > AGENT_LIMITS.fingerprintPeers
    ? { rule: 'G10', code: 'fingerprint', detail: String(fingerprintPeers) }
    : null;
}

