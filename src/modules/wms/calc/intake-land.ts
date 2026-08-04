import { and, desc, eq } from 'drizzle-orm';
import { db } from '../../platform/db/client';
import { clients, dealStages, deals, leads } from '../../platform/db/schema';
import { addActivity, createLead } from '../crm/service';
import { activeClientsByPhone } from '../client-cabinet/service';
import { intakeNoteText, type CalcFacts, type CalcSection } from './intake';

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
async function dealFor(
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
  collectedBy: string;
  collectedByName: string;
  /** Resolved client, when the typed code or phone named exactly one. */
  client: { id: string; clientCode: string; name: string } | null;
  /** What staff typed as the customer's name when there is no code yet. */
  leadName: string;
  leadPhone: string | null;
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
      }),
    },
    { actorId: input.collectedBy },
  );

  return target;
}

/**
 * The lead this phone already has, so a prospect's second request joins the
 * card the first one made instead of minting a duplicate beside it. Matched
 * on the last nine digits, the same rule the client book uses — the number a
 * salesperson types is never formatted twice the same way.
 */
export async function openLeadForPhone(phone: string): Promise<{ id: string; name: string } | null> {
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
