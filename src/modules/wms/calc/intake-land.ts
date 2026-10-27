import { and, eq, sql } from 'drizzle-orm';
import { db } from '../../platform/db/client';
import { clients, dealStages, deals, leadStages, leads, users } from '../../platform/db/schema';
import { userPermissions } from '../../platform/rbac/authorize';
import { canLogInSql } from '../../platform/users/login';
import { writeAudit } from '../../platform/audit/service';
import { mayEditDealTerms } from '../deals/door';
import { addActivity, createLead, defaultStageId, insertActivityTx, insertLeadTx } from '../crm/service';
import {
  insertLeadAboutTx,
  leadAboutReady,
  lockLeadAboutTx,
  openAboutLeadTx,
} from '../crm/lead-about';
import { ftlReady } from '../ftl/service';
import { activeClientsByPhone } from '../client-cabinet/service';
import { logger } from '../../platform/logger';
import { intakeNoteText, landingItems, type CalcFacts, type CalcSection } from './intake';
import { bookLawsFor } from './book-laws';
import { recordAiPass } from './ai-cost';
import { queueCalcPrefill } from './prefill-queue';
import { dealTitleFor } from './deal-title';
import { CalcError, calcOpenRefusal } from './service';

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
   * A lead's OWNER — what decides whether the sender may open the card the ✅
   * links (`calcJobHrefFor`): the sender on a lead they created, the row's
   * owner on one a second request joined, null on a deal.
   */
  leadOwnerId: string | null;
  /**
   * Did it reach the VED queue? The material and the card are saved either
   * way; a false here means the collector must send it from the card, and
   * saying so is the difference between an honest reply and a silent strand.
   */
  queued?: boolean;
  /** The queued request, when there is one — what the AI prefill works on. */
  requestId?: string | null;
  /**
   * What the landing DID, for the ✅ (docs/UCH-BAND.md §2): a new deal, the
   * client's untouched new-client deal taken over, a NEW lead about a
   * colleague's client or that lead joined, a stranger's lead, or — on a
   * retried «Saqlash» — the card the earlier attempt already wrote.
   */
  outcome?: 'deal' | 'adopted' | 'about' | 'about_joined' | 'lead' | 'lead_joined' | 'retried';
  /** On a lead about a colleague's client: whose client it is, for the ✅. */
  about?: { clientCode: string; sellerName: string | null } | null;
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

/** The client's seller, if that person can log in (`canLogInSql`); else null. */
export async function clientSellerFor(clientId: string): Promise<string | null> {
  const [row] = await db
    .select({ id: clients.salesManagerId })
    .from(clients)
    .innerJoin(users, eq(users.id, clients.salesManagerId))
    .where(and(eq(clients.id, clientId), canLogInSql()))
    .limit(1);
  return row?.id ?? null;
}

/**
 * Whose deal a calc request mints (G2 a, 2026-10-07). His question was about
 * the VED sending: a sender who cannot work a deal's terms (the VED, warehouse
 * staff in the bot) hands the deal to the client's seller — or to nobody, and
 * the admin distributes it from the «Hammasi» board. A sender who can (seller,
 * logist, admin) keeps it, as today.
 *
 * ONE rule for both minting doors — the bot (`landIntake`) and the chat door
 * (`threadCalcSend`) — so they cannot disagree (#513). Both reads run on the
 * POOL and BEFORE `createDeal`'s transaction (#714); neither caller holds one.
 * The request itself stays the SENDER's (`requestedBy`), so the answer, the
 * hand-back task and «Javob berildi» still reach whoever asked.
 */
export async function calcDealOwnerFor(senderId: string, clientId: string): Promise<string | null> {
  const perms = await userPermissions(senderId);
  return mayEditDealTerms(perms) ? senderId : clientSellerFor(clientId);
}

/**
 * Where a coded client's request lands (his 2026-10-27: «Har so'rovga yangi
 * bitim. Boshqa sotuvchining mijozi bo'lsa, jo'natganning CRM'ida yangi lid
 * ochiladi»; his Q3 b: an admin or a logist sending is «a seller» too;
 * docs/UCH-BAND.md §2):
 *
 *   - a sender with a funnel (`crm.leads`) asking about a client whose seller
 *     is SOMEBODY ELSE → a LEAD in the sender's own funnel, about that client
 *     (6.8 b, §2.1);
 *   - otherwise → a NEW deal, owned by `calcDealOwnerFor` (G2 a): the sender
 *     when he works deal terms, else the client's seller, else nobody.
 *
 * Asked by permission codes, never role names (#170, deals/door.ts). Every
 * read runs on the POOL, before any transaction (#714).
 */
export type CardDecision =
  | { kind: 'deal'; ownerId: string | null }
  | { kind: 'about'; sellerId: string };

export async function calcCardFor(senderId: string, clientId: string): Promise<CardDecision> {
  const perms = await userPermissions(senderId);
  const seller = await clientSellerFor(clientId);
  if (perms.has('crm.leads') && seller !== null && seller !== senderId) return { kind: 'about', sellerId: seller };
  return { kind: 'deal', ownerId: mayEditDealTerms(perms) ? senderId : seller };
}

/**
 * A RETRIED landing: the card an earlier attempt already wrote this note on.
 * The card and its note commit together (`landCodedCard`), so «the note
 * exists» IS «its card exists» — and a retried «Saqlash» or a retried chat
 * press converges on that card instead of minting a second (judge conc-1).
 *
 * Fenced, because on the chat door the id is POSTED (judge conc-2): only the
 * sender's own note, on a deal of THIS client or a lead about it, is adopted;
 * any other note answers `foreign` and the caller refuses `note_taken`, so a
 * forged uuid cannot attach somebody else's note and its files.
 */
export async function cardOfNote(
  noteId: string,
  senderId: string,
  clientId: string | null,
): Promise<IntakeTarget | 'foreign' | null> {
  const aboutOn = await leadAboutReady();
  const rows = (await db.execute(sql`
    SELECT a.entity_type, a.entity_id::text AS entity_id, a.created_by::text AS created_by,
           d.client_id::text AS deal_client, d.code AS deal_code,
           l.name AS lead_name, l.owner_id::text AS lead_owner, l.phone AS lead_phone,
           ${aboutOn ? sql`(SELECT la.client_id::text FROM lead_about_client la WHERE la.lead_id = l.id)` : sql`NULL::text`} AS about_client
      FROM crm_activities a
      LEFT JOIN deals d ON a.entity_type = 'deal' AND d.id = a.entity_id
      LEFT JOIN leads l ON a.entity_type = 'lead' AND l.id = a.entity_id
     WHERE a.id = ${noteId}::uuid
  `)) as unknown as {
    entity_type: string;
    entity_id: string;
    created_by: string | null;
    deal_client: string | null;
    deal_code: string | null;
    lead_name: string | null;
    lead_owner: string | null;
    about_client: string | null;
  }[];
  const row = rows[0];
  if (!row) return null;
  if (row.created_by !== senderId) return 'foreign';
  if (row.entity_type === 'deal' && row.deal_code !== null && (clientId === null || row.deal_client === clientId)) {
    return { kind: 'deal', id: row.entity_id, label: row.deal_code, leadOwnerId: null, outcome: 'retried' };
  }
  if (row.entity_type === 'lead' && row.lead_name !== null && (clientId === null || row.about_client === clientId)) {
    return { kind: 'lead', id: row.entity_id, label: row.lead_name, leadOwnerId: row.lead_owner, outcome: 'retried' };
  }
  return 'foreign';
}

/** The ROOT request an earlier attempt opened on this note — a retry returns it instead of opening a second. */
export async function rootRequestOfNote(noteId: string): Promise<string | null> {
  const rows = (await db.execute(sql`
    SELECT id::text AS id FROM calc_requests
     WHERE note_id = ${noteId}::uuid AND supersedes_request_id IS NULL
     ORDER BY requested_at
     LIMIT 1
  `)) as unknown as { id: string }[];
  return rows[0]?.id ?? null;
}

/**
 * The round-111 deal a new client code opens by itself, recognised POSITIVELY
 * (judge deploy-5) — titled with the client's name, the client's first deal,
 * opened within five minutes of the code, owned by whoever this request
 * would make its owner — so a hand-made deal or a won lead's is never taken
 * for one. Read on the pool; `landCodedCard` claims it under its own lock
 * and re-checks that nothing has touched it.
 */
async function shellCandidate(clientId: string, ownerId: string | null): Promise<string | null> {
  const rows = (await db.execute(sql`
    SELECT d.id::text AS id
      FROM deals d
      JOIN clients c ON c.id = d.client_id
      JOIN deal_stages s ON s.id = d.stage_id
     WHERE d.client_id = ${clientId}::uuid
       AND s.kind = 'open'
       AND d.title = c.name
       AND d.owner_id IS NOT DISTINCT FROM ${ownerId}::uuid
       AND d.created_at BETWEEN c.created_at AND c.created_at + interval '5 minutes'
       AND NOT EXISTS (SELECT 1 FROM deals o WHERE o.client_id = d.client_id AND o.created_at < d.created_at)
     ORDER BY d.created_at
     LIMIT 1
  `)) as unknown as { id: string }[];
  return rows[0]?.id ?? null;
}

/**
 * The card AND its note, in ONE commit (judge conc-1): a new deal — or the
 * client's untouched new-client deal taken over — or a lead in the sender's
 * funnel about a colleague's client (joined when he already has one open).
 * Every pooled read happens first (#714).
 */
async function landCodedCard(input: {
  noteId: string;
  noteText: string;
  section: CalcSection;
  goodsNames: string[];
  senderId: string;
  client: { id: string; clientCode: string; name: string };
}): Promise<IntakeTarget> {
  const ctx = { actorId: input.senderId };
  const decision = await calcCardFor(input.senderId, input.client.id);
  const note = { id: input.noteId, kind: 'note' as const, note: input.noteText };

  if (decision.kind === 'about') {
    const [aboutOn, stageId, client, seller] = await Promise.all([
      leadAboutReady(),
      defaultStageId(),
      db.query.clients.findFirst({ where: eq(clients.id, input.client.id), columns: { phones: true } }),
      db.query.users.findFirst({ where: eq(users.id, decision.sellerId), columns: { fullName: true } }),
    ]);
    const sellerName = seller?.fullName ?? null;
    const phone = ((client?.phones as string[] | null) ?? [])[0] ?? '';
    const whose = `${input.client.clientCode} — ${sellerName ?? '—'}ning mijozi`;
    if (!aboutOn) logger.error({ clientId: input.client.id }, '[calc-intake] lead_about_client missing — the lead lands without its side row');
    return db.transaction(async (tx) => {
      // One lead about one client per sender: two first requests at once
      // serialise here and the second joins the first.
      await lockLeadAboutTx(tx, input.senderId, input.client.id);
      const open = aboutOn ? await openAboutLeadTx(tx, input.senderId, input.client.id) : null;
      if (open) {
        await insertActivityTx(tx, { ...note, entityType: 'lead', entityId: open.id }, ctx);
        return {
          kind: 'lead' as const,
          id: open.id,
          label: open.name,
          leadOwnerId: input.senderId,
          outcome: 'about_joined' as const,
          about: { clientCode: input.client.clientCode, sellerName },
        };
      }
      const lead = await insertLeadTx(
        tx,
        {
          name: `${input.client.name} (${input.client.clientCode})`,
          phone,
          note: `${whose} · Telegram: hisoblatish (${input.section})`,
          ownerId: input.senderId,
        },
        ctx,
        stageId,
      );
      if (aboutOn) await insertLeadAboutTx(tx, lead.id, input.client.id);
      await writeAudit(tx, ctx, {
        entityType: 'lead',
        entityId: lead.id,
        action: 'create',
        after: { name: lead.name, phone, stageId, aboutClient: input.client.clientCode },
      });
      await insertActivityTx(tx, { ...note, entityType: 'lead', entityId: lead.id }, ctx);
      return {
        kind: 'lead' as const,
        id: lead.id,
        label: lead.name,
        leadOwnerId: input.senderId,
        outcome: 'about' as const,
        about: { clientCode: input.client.clientCode, sellerName },
      };
    });
  }

  const title = dealTitleFor(input.section, input.goodsNames, { clientCode: input.client.clientCode, at: new Date() });
  const [shell, ftlOn] = await Promise.all([shellCandidate(input.client.id, decision.ownerId), ftlReady()]);
  const { createDealInTx } = await import('../deals/service');
  return db.transaction(async (tx) => {
    if (shell) {
      // The claim IS the title change: a second adopter blocked on this row
      // re-reads it after the first commits, finds the title moved (and the
      // note on the deal), takes 0 rows and mints its own (judge conc-5).
      const taken = (await tx.execute(sql`
        UPDATE deals d SET title = ${title}, updated_at = now()
          FROM clients c
         WHERE d.id = ${shell}::uuid AND c.id = d.client_id AND d.title = c.name
           AND d.quoted_amount IS NULL
           AND coalesce(d.discount_amount, 0) = 0
           AND d.deferred_at IS NULL
           AND NOT EXISTS (SELECT 1 FROM calc_requests r WHERE r.entity_type = 'deal' AND r.entity_id = d.id)
           AND NOT EXISTS (SELECT 1 FROM calc_offers o WHERE o.entity_type = 'deal' AND o.entity_id = d.id)
           AND NOT EXISTS (SELECT 1 FROM deal_lines l WHERE l.deal_id = d.id)
           AND NOT EXISTS (SELECT 1 FROM receipts rc WHERE rc.deal_id = d.id)
           AND NOT EXISTS (SELECT 1 FROM client_transactions t WHERE t.deal_id = d.id)
           AND NOT EXISTS (SELECT 1 FROM crm_activities a WHERE a.entity_type = 'deal' AND a.entity_id = d.id)
           AND NOT EXISTS (SELECT 1 FROM tasks k WHERE k.entity_type = 'deal' AND k.entity_id = d.id)
           ${ftlOn ? sql`AND NOT EXISTS (SELECT 1 FROM deal_ftl f WHERE f.deal_id = d.id)` : sql``}
        RETURNING d.id::text AS id, d.code
      `)) as unknown as { id: string; code: string }[];
      if (taken[0]) {
        await writeAudit(tx, ctx, {
          entityType: 'deal',
          entityId: taken[0].id,
          action: 'update',
          after: { title, adoptedBy: 'calc_request' },
        });
        await insertActivityTx(tx, { ...note, entityType: 'deal', entityId: taken[0].id }, ctx);
        return { kind: 'deal' as const, id: taken[0].id, label: taken[0].code, leadOwnerId: null, outcome: 'adopted' as const };
      }
    }
    const dealId = await createDealInTx(
      tx,
      { clientId: input.client.id, title, ownerId: decision.ownerId },
      ctx,
      { clientCode: input.client.clientCode, ownerId: decision.ownerId, ftlOn },
    );
    await insertActivityTx(tx, { ...note, entityType: 'deal', entityId: dealId }, ctx);
    const [fresh] = (await tx.execute(sql`SELECT code FROM deals WHERE id = ${dealId}::uuid`)) as unknown as { code: string }[];
    return { kind: 'deal' as const, id: dealId, label: fresh?.code ?? '—', leadOwnerId: null, outcome: 'deal' as const };
  });
}

/**
 * The card a coded client's request lands on, and its note — the bot and the
 * chat door alike (#513). Exported for the chat door; the bot reaches it
 * through `landIntake`.
 */
export async function landCodedRequest(input: {
  noteId: string;
  noteText: string;
  section: CalcSection;
  goodsNames: string[];
  itemCount: number;
  senderId: string;
  client: { id: string; clientCode: string; name: string };
}): Promise<IntakeTarget> {
  const prior = await cardOfNote(input.noteId, input.senderId, input.client.id);
  if (prior === 'foreign') throw new CalcError('note_taken');
  if (prior) return prior;
  // Refused BEFORE anything is minted (judge conc-9): on main a refusal after
  // the mint left an empty deal behind.
  const refused = await calcOpenRefusal(input.senderId, input.itemCount);
  if (refused) throw new CalcError(refused);
  return landCodedCard(input);
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
  /** The zone the seller chose on the AI podklyuch door («qayerdan?»). */
  freightZone?: string | null;
  /** What the intake's model call cost — recorded once the request exists. */
  usage?: { model: string; inputTokens: number; outputTokens: number } | null;
}): Promise<IntakeTarget> {
  // The note's text first — the book's law for the lines' codes is what its
  // «qatorlarda yetishmayapti» asks by (judge TT-5), a pooled read, so it is
  // done before any card is written.
  const laws = await bookLawsFor((input.facts.goods ?? []).map((g) => g.tnvedCode));
  const noteText = intakeNoteText({
    section: input.section,
    facts: input.facts,
    laws,
    steps: input.steps,
    collectedBy: input.collectedByName,
    fileCount: input.fileCount,
    material: input.material,
  });
  const items = landingItems(input.facts);

  // A coded client: a NEW card per request (his 2026-10-27), written with its
  // note in one commit, and found again through that note on a retry.
  let target: IntakeTarget;
  if (input.client) {
    target = await landCodedRequest({
      noteId: input.noteId,
      noteText,
      section: input.section,
      goodsNames: items.map((item) => item.name),
      itemCount: items.length,
      senderId: input.collectedBy,
      client: input.client,
    });
  } else {
    const prior = await cardOfNote(input.noteId, input.collectedBy, null);
    if (prior === 'foreign') throw new CalcError('note_taken');
    if (prior) {
      target = prior;
    } else {
      const refused = await calcOpenRefusal(input.collectedBy, items.length);
      if (refused) throw new CalcError(refused);
      // A prospect who asked before already has a card; a second request
      // belongs on it rather than beside it.
      const existing = input.leadPhone ? await openLeadForPhone(input.leadPhone) : null;
      if (existing) {
        target = { kind: 'lead', id: existing.id, label: existing.name, leadOwnerId: existing.ownerId, outcome: 'lead_joined' };
      } else {
        const lead = await createLead(
          {
            name: input.leadName,
            phone: input.leadPhone ?? '',
            note: `Telegram bot: hisoblatish (${input.section})`,
          },
          { actorId: input.collectedBy },
        );
        target = { kind: 'lead', id: lead.id, label: lead.name, leadOwnerId: lead.ownerId, outcome: 'lead' };
      }
      await addActivity(
        { id: input.noteId, entityType: target.kind, entityId: target.id, kind: 'note', note: noteText },
        { actorId: input.collectedBy },
      );
    }
  }

  // An earlier attempt already queued this very note: the job is in the
  // queue, and neither it nor the AI pass is opened twice (judge conc-13).
  const queuedBefore = await rootRequestOfNote(input.noteId);
  if (queuedBefore) return { ...target, queued: true, requestId: queuedBefore, queueError: null };

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
        // Through `landingItems`, so the weight a single-line job already
        // stated reaches the ITEM (labelled «umumiy (brutto)dan olindi») —
        // which is what lets the AI VED hodimi find a per-kg declaration for
        // it (docs/VED-IMPORT-AI §3) — and the line's unit, volume and pair
        // reach the door, which routes them (2026-10-09, judge TT-16: they
        // were dropped here, so an invoice's «500 м2» landed as 500 pieces).
        items: landingItems(input.facts),
        noteId: input.noteId,
        source: 'bot',
        hasMaterials: input.fileCount > 0,
        hasCertificate: input.hasCertificate ?? true,
        freightZone: input.freightZone ?? null,
      },
      { actorId: input.collectedBy },
    );
    queued = true;
    requestId = opened.id;
    if (input.usage) {
      await recordAiPass({
        requestId: opened.id,
        staffId: input.collectedBy,
        kind: 'intake',
        model: input.usage.model,
        inputTokens: input.usage.inputTokens,
        outputTokens: input.usage.outputTokens,
      });
    }
    // …and the AI VED hodimi is handed the job HERE rather than by the
    // caller. The bot did it from its own handler, so any second caller of
    // this landing would silently get no pass at all — the same asymmetry
    // that left the card form and the thread door unserved until this round.
    // Off the poller and out of this process, through pg-boss.
    await queueCalcPrefill({
      requestId: opened.id,
      staffId: input.collectedBy,
      section: input.section,
    });
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
 * card the first one made instead of minting a duplicate beside it — asked of
 * the advert landing's own rule (`inboundMatch`: last nine digits, an OPEN
 * stage, touched within the join window, exactly one), plus «not yet won
 * onto a code» (judge product-11 — it restated that rule and joined a LOST
 * lead too). A lead about a colleague's client is never joined by phone.
 */
export async function openLeadForPhone(
  phone: string,
): Promise<{ id: string; name: string; ownerId: string | null } | null> {
  const { inboundMatch } = await import('../crm/inbound');
  const hit = await inboundMatch(phone, { unboundOnly: true });
  if (!hit) return null;
  const [row] = await db.select({ name: leads.name }).from(leads).where(eq(leads.id, hit.id)).limit(1);
  return row ? { id: hit.id, name: row.name, ownerId: hit.ownerId } : null;
}
