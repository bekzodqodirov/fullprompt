import { and, eq, gte, inArray, ne } from 'drizzle-orm';
import { db } from '../../platform/db/client';
import { agentOutbox, clients, users } from '../../platform/db/schema';
import { getSetting } from '../../platform/settings/service';
import { canLogInSql } from '../../platform/users/login';
import { tashkentDay, tashkentDayStart } from '../../platform/time/tashkent';
import type { AgentLocale, ScriptName } from './locale';
import { customerSources, urlsIn, type NumberSource } from './numbers';
import { checkAgentReply, checkOwnerReply, codeCandidatesIn, textFingerprint, type PolicyResult } from './policy';

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

/** Distinct OTHER peers that got the same fingerprint from the agent in 24 h, and the link counts (G10). */
async function sendCounts(managerUserId: string, peerId: bigint, body: string, strip: string[]) {
  const since = new Date(Date.now() - 24 * 3_600_000);
  const rows = await db
    .select({ peerId: agentOutbox.peerId, body: agentOutbox.body, sentAt: agentOutbox.sentAt })
    .from(agentOutbox)
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
    if (r.peerId !== peerId && (r.sentAt ?? new Date()) >= since && textFingerprint(r.body, strip) === fp) peers.add(String(r.peerId));
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
  const [bookCodes, staffNames, counts, codePrefix] = await Promise.all([
    bookCodesIn(input.body),
    staffNamesExcept(input.memory.managerName, input.managerUserId),
    sendCounts(input.managerUserId, input.peerId, input.body, input.strip),
    getSetting('client_code_prefix'),
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
  });
}

/** His own ✏️ text — only what would be refused anyway blocks (§17.6). */
export async function ownerPolicyFor(body: string, ownCodes: string[]): Promise<PolicyResult> {
  const [bookCodes, codePrefix] = await Promise.all([bookCodesIn(body), getSetting('client_code_prefix')]);
  return checkOwnerReply({ body, ownCodes, bookCodes, codePrefix: String(codePrefix ?? '') });
}

