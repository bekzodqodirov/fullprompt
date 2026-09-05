import { and, desc, eq } from 'drizzle-orm';
import { db } from '../../platform/db/client';
import { clients, dealStages, deals, leadStages, leads } from '../../platform/db/schema';
import { addActivity, createLead } from '../crm/service';
import { activeClientsByPhone } from '../client-cabinet/service';
import { logger } from '../../platform/logger';
import { intakeNoteText, itemFacts, type CalcFacts, type CalcSection } from './intake';
import { CalcError } from './service';

/**
 * Where a confirmed «Hisoblatish» lands (owner: «hammasi lead yoki ochilgan
 * kod bo'lsa bitimda kartochka bo'lsin»).
 *
 * The rule is his, and it is the honest one: a customer who already has a
 * code is an existing client, so their request belongs on a DEAL — beside
 * their other jobs, their money and their cargo. Somebody who does not is a
 * prospect, and a lead is exactly the card a prospect gets.
 *
 * Whatever it lands on, the AI's reading goes onto the card's lenta as a
 * note, with the sent files attached to it. The price is not touched here;
 * the calc clock is started from the card by whoever picks the VED person,
 * where the picker already lives (round 28).
 */

export interface IntakeTarget {
  kind: 'deal' | 'lead';
  id: string;
  /** For the confirmation message and the link. */
  label: string;
  /**
   * Did it reach the VED queue? The material and the card are saved either
   * way; a false here means the collector must send it from the card, and
   * saying so is the difference between an honest reply and a silent strand.
   */
  queued?: boolean;
  /** The queued request, when there is one — what the AI prefill works on. */
  requestId?: string | null;
  /**
   * WHY it did not reach the queue (audit A38).
   *
   * The refusal used to be logged and answered with one constant sentence —
   * «kartadan qo'lda yuboring» — which sends the collector to a door that
   * refuses for the SAME reason on the commonest cause there is (twenty open
   * requests). The code travels so the bot can say the sentence.
   */
  queueError?: string | null;
}

/** The client a typed code or phone names — exactly one, or nobody. */
export async function resolveIntakeClient(hint: {
  code?: string;
  phone?: string;
}): Promise<{ id: string; clientCode: string; name: string } | null> {
  if (hint.code) {
    const [row] = await db
      .select({ id: clients.id, clientCode: clients.clientCode, name: clients.name })
      .from(clients)
      .where(and(eq(clients.clientCode, hint.code.toUpperCase()), eq(clients.active, true)))
      .limit(1);
    if (row) return row;
  }
  if (hint.phone) {
    const matches = await activeClientsByPhone(hint.phone);
    // Ambiguity refuses, the rule the lead resolver and the card panel both
    // use: landing a quote on the wrong person's card is worse than asking.
    if (matches.length === 1) {
      const m = matches[0]!;
      return { id: m.id, clientCode: m.clientCode, name: m.name };
    }
  }
  return null;
}

/**
 * The deal a coded client's request joins: their newest OPEN one, or a new
 * one on the funnel's first open stage. Never a won or lost deal — those are
 * finished stories, and a new quote request is not part of them.
 */
export async function dealFor(
  client: { id: string; clientCode: string; name: string },
  section: CalcSection,
  actorId: string,
): Promise<IntakeTarget> {
  const [open] = await db
    .select({ id: deals.id, code: deals.code })
    .from(deals)
    .innerJoin(dealStages, eq(deals.stageId, dealStages.id))
    .where(and(eq(deals.clientId, client.id), eq(dealStages.kind, 'open')))
    .orderBy(desc(deals.createdAt))
    .limit(1);
  if (open) return { kind: 'deal', id: open.id, label: open.code };

  const { createDeal } = await import('../deals/service');
  const dealId = await createDeal(
    {
      clientId: client.id,
      title: `Hisoblatish — ${section}`,
      ownerId: actorId,
    },
    { actorId },
  );
  const [fresh] = await db
    .select({ code: deals.code })
    .from(deals)
    .where(eq(deals.id, dealId))
    .limit(1);
  return { kind: 'deal', id: dealId, label: fresh?.code ?? '—' };
}

/**
 * The stage a request for a price belongs on, and whether this card may go
 * there (owner, round 83: «hisoblatish etapiga tushishi kerak»).
 *
 * FORWARD only, by `sort_order` — the cargo-trigger rule (#392), for the same
 * reason: a card already further down the funnel is somebody's work in
 * progress, and a machine dragging it backwards because a second request came
 * in would undo a person's decision. Nothing configured, or a stage that has
 * since been deleted or closed, means «leave it where it is».
 */
async function calcStageMove(
  board: 'lead' | 'deal',
  currentStageId: string | null,
): Promise<string | null> {
  const { getSetting } = await import('../../platform/settings/service');
  const wanted = await getSetting(board === 'lead' ? 'crm_calc_stage' : 'deal_calc_stage');
  if (!wanted) return null;

  const table = board === 'lead' ? leadStages : dealStages;
  const rows = await db
    .select({ id: table.id, sortOrder: table.sortOrder, kind: table.kind, active: table.active })
    .from(table);
  const target = rows.find((row) => row.id === wanted);
  if (!target || !target.active || target.kind !== 'open') return null;
  if (!currentStageId) return target.id;
  if (currentStageId === target.id) return null;
  const current = rows.find((row) => row.id === currentStageId);
  return current && current.sortOrder < target.sortOrder ? target.id : null;
}

/**
 * Land a confirmed intake: find or open the card, write the note with the
 * AI's working, and return where it went so the bot can link to it.
 *
 * The note id is MINTED BY THE CALLER and passed in — the bot pre-binds the
 * photos to it while they arrive, exactly as the receiving wizard pre-binds
 * lot photos before the receipt exists (#180's pattern). By the time this
 * runs the files are already in storage waiting for their note.
 */
export async function landIntake(input: {
  noteId: string;
  section: CalcSection;
  facts: CalcFacts;
  steps: string[];
  fileCount: number;
  /** The seller's typed/forwarded text, verbatim — law 11's unabridged half. */
  material?: string[];
  collectedBy: string;
  collectedByName: string;
  /** Resolved client, when the typed code or phone named exactly one. */
  client: { id: string; clientCode: string; name: string } | null;
  /** What staff typed as the customer's name when there is no code yet. */
  leadName: string;
  leadPhone: string | null;
  /** The seller's certificate answer (the AI-rastamojka door's one toggle). */
  hasCertificate?: boolean;
}): Promise<IntakeTarget> {
  const target = input.client
    ? await dealFor(input.client, input.section, input.collectedBy)
    : await (async (): Promise<IntakeTarget> => {
        // A prospect who asked before already has a card; a second request
        // belongs on it rather than beside it.
        const existing = input.leadPhone ? await openLeadForPhone(input.leadPhone) : null;
        if (existing) return { kind: 'lead', id: existing.id, label: existing.name };
        const lead = await createLead(
          {
            name: input.leadName,
            phone: input.leadPhone ?? '',
            note: `Telegram bot: hisoblatish (${input.section})`,
          },
          { actorId: input.collectedBy },
        );
        return { kind: 'lead', id: lead.id, label: lead.name };
      })();

  await addActivity(
    {
      id: input.noteId,
      entityType: target.kind,
      entityId: target.id,
      kind: 'note',
      note: intakeNoteText({
        section: input.section,
        facts: input.facts,
        steps: input.steps,
        collectedBy: input.collectedByName,
        fileCount: input.fileCount,
        material: input.material,
      }),
    },
    { actorId: input.collectedBy },
  );

  // The collected job goes into the VED queue — the bot and the card form are
  // two doors into ONE queue (docs/VED.md, phase A). Fenced for the same
  // reason as the stage move below, and BEFORE it because the queue is the
  // promise and the stage is the decoration: on a stale schema or a refused
  // insert the note and its files still stand on the card, and the caller is
  // told which half failed rather than «nothing saved» about work that was.
  let queued = false;
  let queueError: string | null = null;
  let requestId: string | null = null;
  try {
    const { openCalcRequest } = await import('./service');
    const opened = await openCalcRequest(
      {
        entityType: target.kind,
        entityId: target.id,
        section: input.section,
        fromCity: input.facts.fromCity ?? null,
        toCity: input.facts.toCity ?? null,
        weightKg: input.facts.weightKg ?? null,
        volumeM3: input.facts.volumeM3 ?? null,
        // Through `itemFacts`, so the weight a single-line job already
        // stated reaches the ITEM — which is what lets the AI VED hodimi
        // find a per-kg declaration for it (docs/VED-IMPORT-AI §3).
        items: itemFacts(input.facts).map((good) => ({
          name: good.name,
          quantity: good.quantity,
          weightKg: good.weightKg,
          tnvedCode: good.tnvedCode,
          note: good.note,
        })),
        noteId: input.noteId,
        source: 'bot',
        hasMaterials: input.fileCount > 0,
        hasCertificate: input.hasCertificate ?? true,
      },
      { actorId: input.collectedBy },
    );
    queued = true;
    // Handed back so the bot can hand the job to the AI VED hodimi — the
    // prefill runs OFF the poller, against this id (docs/VED-IMPORT-AI §3).
    requestId = opened.id;
  } catch (err) {
    logger.error({ err, kind: target.kind, id: target.id }, '[calc-intake] queue open failed');
    queueError = err instanceof CalcError ? err.code : 'server_behind';
  }

  // …and the card moves to the hisoblatish stage, through the SAME move the
  // board's buttons use — so the audit row, the stage event and any phase-7
  // rule watching «entered this stage» all fire exactly as if a person had
  // dragged it. Fenced: a funnel misconfiguration must never lose the note
  // that was just written, which is the part the bot promised to save.
  try {
    await moveToCalcStage(target, input.collectedBy);
  } catch (err) {
    logger.error({ err, kind: target.kind, id: target.id }, '[calc-intake] stage move failed');
  }

  return { ...target, queued, requestId, queueError };
}

async function moveToCalcStage(target: IntakeTarget, actorId: string): Promise<void> {
  if (target.kind === 'lead') {
    const [row] = await db
      .select({ stageId: leads.stageId })
      .from(leads)
      .where(eq(leads.id, target.id))
      .limit(1);
    const to = await calcStageMove('lead', row?.stageId ?? null);
    if (!to) return;
    const { moveLead } = await import('../crm/service');
    await moveLead(target.id, to, '', { actorId });
    return;
  }
  const [row] = await db
    .select({ stageId: deals.stageId })
    .from(deals)
    .where(eq(deals.id, target.id))
    .limit(1);
  const to = await calcStageMove('deal', row?.stageId ?? null);
  if (!to) return;
  const { moveDeal } = await import('../deals/service');
  await moveDeal(target.id, to, { actorId });
}

/**
 * The lead this phone already has, so a prospect's second request joins the
 * card the first one made instead of minting a duplicate beside it. Matched
 * on the last nine digits, the same rule the client book uses — the number a
 * salesperson types is never formatted twice the same way.
 */
export async function openLeadForPhone(
  phone: string,
): Promise<{ id: string; name: string } | null> {
  const digits = phone.replace(/\D/g, '').slice(-9);
  if (digits.length < 7) return null;
  const rows = await db
    .select({ id: leads.id, name: leads.name, phone: leads.phone, clientId: leads.clientId })
    .from(leads)
    .orderBy(desc(leads.createdAt))
    .limit(500);
  const hit = rows.find(
    (r) => !r.clientId && (r.phone ?? '').replace(/\D/g, '').slice(-9) === digits,
  );
  return hit ? { id: hit.id, name: hit.name } : null;
}
