import { and, asc, eq, inArray } from 'drizzle-orm';
import { db } from '@/modules/platform/db/client';
import { clients, deals, tgMessages, users } from '@/modules/platform/db/schema';
import type { Actor } from '@/modules/platform/rbac/authorize';
import type { AuditContext } from '@/modules/platform/audit/service';
import { tgViewerFor } from '../crm/conversations';
import { threadClientFor } from '../crm/conversations';
import { CalcError, openCalcRequest } from './service';
import { CALC_SECTIONS, intakeNoteText, missingFields, type CalcFacts, type CalcSection } from './intake';
import { parseManualFacts } from './intake-manual';
import { analyzeIntake } from './intake-ai';
import { dealFor } from './intake-land';

/**
 * «Hisoblatishga yuborish» from a CRM Telegram thread (docs/VED.md, the
 * seller-flow line; owner 2026-08-25: «yaxshi, qilib bersang kerak»).
 *
 * Select messages, one tap, a calc request in the ONE queue — the third door
 * beside the bot and the card form. Everything the browser posts is treated
 * as a forged post (#514): the message ids are re-loaded under the tg
 * viewer's own fence, the entity is re-proved, the section is validated, and
 * the MATERIAL is always rebuilt server-side from the rows — never taken
 * from the browser (law 11: the words themselves go onto the card).
 *
 * Files are deliberately NOT copied onto the note: a second attachment row
 * over the same storage key would let either row's delete take the other's
 * bytes. The material names how many files sit in the chat, and the VED —
 * whose `ved.docs` grant IS the supervision view (round 33) — opens the
 * thread. STATED CUT.
 */
export type ThreadCalcEntity =
  | { kind: 'client'; id: string }
  | { kind: 'lead'; id: string }
  | { kind: 'deal'; id: string };

export interface ThreadMaterial {
  /** The seller's and the customer's words, labeled, in sent order. */
  lines: string[];
  fileCount: number;
  clientId: string | null;
}

/**
 * Load the selected messages under the reader's own fence and turn them into
 * material. Refuses — never trims — when any posted id fails the fence: a
 * request landed with silently missing material would read as complete.
 */
export async function threadMaterial(
  actor: Actor,
  entity: ThreadCalcEntity,
  messageIds: string[],
): Promise<ThreadMaterial> {
  const ids = [...new Set(messageIds)].filter(Boolean);
  if (ids.length === 0) throw new CalcError('empty');
  if (ids.length > 200) throw new CalcError('too_many');
  const viewer = tgViewerFor(actor);

  let clientId: string | null = null;
  let where;
  if (entity.kind === 'lead') {
    where = eq(tgMessages.leadId, entity.id);
  } else {
    if (entity.kind === 'deal') {
      const deal = await db.query.deals.findFirst({ where: eq(deals.id, entity.id) });
      if (!deal?.clientId) throw new CalcError('not_found');
      clientId = deal.clientId;
    } else {
      clientId = entity.id;
    }
    // The thread may live under a phone-sibling GS code (round 32) — the
    // fence must ask the code that HOLDS the chat, exactly as the panel does.
    const threadClient = await threadClientFor(clientId, viewer);
    if (!threadClient) throw new CalcError('not_found');
    where = eq(tgMessages.clientId, threadClient);
  }

  const rows = await db
    .select({
      id: tgMessages.id,
      body: tgMessages.body,
      direction: tgMessages.direction,
      hasMedia: tgMessages.hasMedia,
      managerUserId: tgMessages.managerUserId,
    })
    .from(tgMessages)
    .where(
      and(
        inArray(tgMessages.id, ids),
        where,
        // Round 20's fence, verbatim: own account, or the supervision view.
        viewer.all ? undefined : eq(tgMessages.managerUserId, viewer.id),
      ),
    )
    .orderBy(asc(tgMessages.sentAt), asc(tgMessages.id));

  // Refuse, never trim: fewer rows than ids means at least one id is not
  // this thread's or not this reader's.
  if (rows.length !== ids.length) throw new CalcError('not_yours');

  // Whose words: the customer's lines say so, a manager's line carries the
  // NAME when a supervision viewer's selection can span two colleagues'
  // threads — the note is the shared lenta, and an unlabeled weld would put
  // one manager's sentence in another's mouth.
  const managerIds = [...new Set(rows.filter((r) => r.direction !== 'in').map((r) => r.managerUserId))];
  const names = new Map<string, string>();
  if (managerIds.length > 0) {
    const nameRows = await db
      .select({ id: users.id, name: users.fullName })
      .from(users)
      .where(inArray(users.id, managerIds));
    for (const n of nameRows) names.set(n.id, n.name);
  }

  const lines: string[] = [];
  let fileCount = 0;
  for (const row of rows) {
    if (row.hasMedia) fileCount += 1;
    const body = (row.body ?? '').trim();
    if (!body) continue;
    const who = row.direction === 'in' ? 'Mijoz' : (names.get(row.managerUserId) ?? 'Biz');
    lines.push(`${who}: ${body}`);
  }
  if (fileCount > 0) lines.push(`(${fileCount} ta fayl suhbatda — kartadagi chat panelida)`);
  return { lines, fileCount, clientId };
}

export interface ThreadCalcPreview {
  facts: CalcFacts;
  steps: string[];
  missing: string[];
  lines: number;
  fileCount: number;
}

/**
 * Step one: read the selection. The AI gets a short leash — this is an
 * interactive press, not the bot's fire-and-answer-later chat — and its
 * absence degrades to the manual parser exactly as the bot's flow does.
 */
export async function threadCalcAnalyze(
  actor: Actor,
  input: { entity: ThreadCalcEntity; section: CalcSection; messageIds: string[] },
): Promise<ThreadCalcPreview> {
  const material = await threadMaterial(actor, input.entity, input.messageIds);
  const text = material.lines.join('\n');
  const manual = parseManualFacts(text);
  const ai = await analyzeIntake({
    section: input.section,
    text,
    fileCount: material.fileCount,
    timeoutMs: 20_000,
  });
  // Typed/manual facts win over read ones, the bot's own rule.
  const facts: CalcFacts = {
    fromCity: manual.fromCity ?? ai?.facts.fromCity ?? null,
    toCity: manual.toCity ?? ai?.facts.toCity ?? null,
    weightKg: manual.weightKg ?? ai?.facts.weightKg ?? null,
    volumeM3: manual.volumeM3 ?? ai?.facts.volumeM3 ?? null,
    goods: (ai?.facts.goods?.length ? ai.facts.goods : manual.goods) ?? [],
  };
  return {
    facts,
    steps: ai?.steps ?? [],
    missing: missingFields(input.section, facts),
    lines: material.lines.length,
    fileCount: material.fileCount,
  };
}

/** What the browser may claim about the cargo — its own request, sanitized. */
function cleanFacts(raw: CalcFacts | null | undefined, material: string): CalcFacts {
  if (!raw) return parseManualFacts(material);
  const num = (v: unknown) =>
    typeof v === 'number' && Number.isFinite(v) && v >= 0 && v < 1_000_000 ? v : null;
  const str = (v: unknown, cap: number) =>
    typeof v === 'string' && v.trim() ? v.trim().slice(0, cap) : null;
  return {
    fromCity: str(raw.fromCity, 80),
    toCity: str(raw.toCity, 80),
    weightKg: num(raw.weightKg),
    volumeM3: num(raw.volumeM3),
    goods: (Array.isArray(raw.goods) ? raw.goods : []).slice(0, 1000).flatMap((g) => {
      const name = str(g?.name, 200);
      if (!name) return [];
      return [
        {
          name,
          quantity: num(g?.quantity),
          tnvedCode: str(g?.tnvedCode, 10),
          note: str(g?.note, 300),
        },
      ];
    }),
  };
}

/**
 * Step two: land it. The material is REBUILT from the rows (the browser's
 * copy is never trusted); the posted facts are the requester's own claim —
 * the same standing a typed card form has — and are sanitized, never
 * believed about anyone else. `note_taken` on the pre-minted note id is the
 * double-press fence: a retried confirm refuses instead of minting twice.
 */
export async function threadCalcSend(
  actor: Actor,
  input: {
    entity: ThreadCalcEntity;
    section: CalcSection;
    messageIds: string[];
    noteId: string;
    facts?: CalcFacts | null;
    steps?: string[] | null;
  },
  ctx: AuditContext,
): Promise<{ kind: 'deal' | 'lead'; id: string; queued: boolean }> {
  if (!CALC_SECTIONS.includes(input.section)) throw new CalcError('bad_section');
  const material = await threadMaterial(actor, input.entity, input.messageIds);
  const text = material.lines.join('\n');
  const facts = cleanFacts(input.facts, text);
  const steps = (Array.isArray(input.steps) ? input.steps : [])
    .filter((s): s is string => typeof s === 'string' && s.trim().length > 0)
    .slice(0, 20)
    .map((s) => s.slice(0, 300));

  let target: { kind: 'deal' | 'lead'; id: string };
  if (input.entity.kind === 'lead') {
    target = { kind: 'lead', id: input.entity.id };
  } else if (input.entity.kind === 'deal') {
    target = { kind: 'deal', id: input.entity.id };
  } else {
    // The client card names no job — the bot's own rule lands it: the
    // newest OPEN deal, or a fresh one.
    const client = await db.query.clients.findFirst({
      where: eq(clients.id, input.entity.id),
      columns: { id: true, clientCode: true, name: true, active: true },
    });
    if (!client || !client.active) throw new CalcError('not_found');
    const landed = await dealFor(client, input.section, actor.id);
    target = { kind: landed.kind, id: landed.id };
  }

  const note = intakeNoteText({
    section: input.section,
    facts,
    steps,
    collectedBy: actor.fullName ?? actor.id,
    fileCount: 0,
    material: material.lines,
    via: 'suhbatdan',
  });

  await openCalcRequest(
    {
      entityType: target.kind,
      entityId: target.id,
      section: input.section,
      fromCity: facts.fromCity ?? null,
      toCity: facts.toCity ?? null,
      weightKg: facts.weightKg ?? null,
      volumeM3: facts.volumeM3 ?? null,
      items: (facts.goods ?? []).map((g) => ({
        name: g.name,
        quantity: g.quantity ?? null,
        tnvedCode: g.tnvedCode ?? null,
        note: g.note ?? null,
      })),
      note: { id: input.noteId, text: note },
      source: 'card',
      hasMaterials: material.fileCount > 0,
    },
    ctx,
  );
  return { ...target, queued: true };
}
