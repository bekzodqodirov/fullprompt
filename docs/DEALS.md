# Bitim (deal) — agreed specification

Settled with the owner on 2026-07-26, in his own words and my questions. This
file exists so the answers survive: they were expensive to obtain and every
one of them changes what gets built.

---

## The problem, as the owner described it

The pain is NOT "there is no record of a job". It is the **gap between what was
quoted and what actually turned up**, and the fact that nobody sees it in time:

- Quoted 1 m³ / 100 kg → $200. The cargo arrives at the warehouse at **1.4 m³**.
  If the sales manager happens to notice, they re-price and call the client, who
  either agrees or takes the cargo back from the warehouse. If nobody notices,
  the cargo reaches Tashkent and **there is an argument about the price**.
- Clients sometimes ship with **no quote at all**; the price is worked out when
  it lands in Tashkent. This is the single biggest source of "it came out
  expensive" complaints.
- Cost prices rise after a quote; we ask for more; the client sometimes pays the
  difference and sometimes holds us to the agreed figure.
- A client sends 10 boxes, 9 arrive, 1 is late: **"I will pay when it is all
  here."**
- Cargo arrives damaged: today the whole conversation lives in Telegram, and the
  client pays less — or pays in full and says nothing.

Everything above is currently held in Excel and Telegram groups.

## What a deal is

One client's job, from "please price this" to "paid". It holds the QUOTE and the
REALITY side by side, which is the only thing that can close the gap above.

- **Lines.** Sometimes one item, often 2–4, sometimes a file with **50 goods**
  that the VED manager groups by TNVED into ~30 lines. A price may be set per
  line or as one total for the deal.
- **Usually one deal → one receipt**, but a shipment can be split (half today,
  half tomorrow), so the relationship is one-to-many.
- **Ownership changes hands**: sometimes one salesperson carries it end to end,
  sometimes different staff take different stages.

## Decisions

| # | Question | Answer |
|---|---|---|
| 1 | Deviation alert threshold | **Notify above 10 %, never block loading.** The percentage is a setting. |
| 2 | Who may re-price after reality differs | **Both** the sales manager and the VED manager |
| 3 | Client pays less after damage | **Reduce the deal amount (a discount).** Not a separate compensation expense — profit per deal has to stay honest |
| 4 | "I will pay when it all arrives" | Deferral on the DEAL — see below |
| 5 | When the quoting clock starts | **When the VED manager is given the task**, not when the client's message arrives |
| 6 | The 50-goods file | **Parse the spreadsheet AND let the TNVED assistant propose the grouping**; the VED manager confirms |
| 7 | Profit granularity | **Per deal.** Not per line |

> **2026-10-07 — his 17a supersedes the VED half of answers 2 and 3.** The deal
> card splits in two (`src/modules/wms/deals/door.ts`). The deal's TERMS —
> opening a deal, its stage, its owner, its quote and its DISCOUNT — are the
> seller's (`mayEditDealTerms` = `crm.leads` or `clients.manage`). The VED
> (`ved.docs` without a seller's grant) reads the card, writes a text note on
> a calc deal's lenta, and keeps the deal's POSITIONS (lines, TNVED codes, the
> per-line summa) and ALL prixod linking (link, move, detach — each audited
> under his name, G1 a). The re-pricing in answer 2 is now the seller's on the
> deal card; the VED's price door is the SEAL in the calc workspace, untouched
> (as is the seal's own discount). His deal board is a read-only slice (G3 a:
> deals with a calc request, open deals with a position lacking TNVED) and he
> cannot create deals (G4 a); the bot's «🧮 Hisoblatish» stays open to all
> staff. A deal the bot mints for a request sent by someone who cannot work a
> deal's terms opens in the CLIENT's seller's name, or ownerless for the admin
> to distribute (G2 a, `calc/intake-land.ts` `calcDealOwnerFor`); a seller who
> sends keeps his deal, as before.

### 4 — deferred payment, in detail

The deferral belongs to the DEAL, not to the client, and it is a decision with
an owner and an end — not a flag.

- On the client it would become permanent and everyone would forget it; that is
  how a debt gate dies. On the deal it is scoped to the job it was agreed for.
- It carries a **reason**, **who agreed it**, and an **end condition**.
- The natural condition here is self-resolving: **until every box of this deal
  has arrived**. The system already knows how many boxes belong to the deal and
  how many landed, so the deferral expires by itself when the last one does. A
  plain date is the alternative for cases that are not about missing boxes.
- The handover debt gate does not count a deferred charge as overdue, and the
  warehouse screen SAYS SO ("debt deferred — 1 box still expected") so the
  operator does not read an open gate as a bug.
- Granted by whoever holds `finance.debt_override` — the permission already
  exists and means exactly this. When the deferral expires unpaid, the client
  returns to the debtor list and the sales manager is nudged.

This is better than the existing one-click override at handover, which leaves no
reason and no end date.

## What the system will do that nobody asked for but everybody needs

**Price control.** When a receipt is confirmed, compare it against the deal:

1. **No deal at all** → the sales manager is told at once: "unquoted cargo from
   GS777: 1.4 m³, 180 kg — set a price." While it is still in China.
2. **Deal exists but reality differs by more than the threshold** → "quoted
   1.0 m³ / $200, actual 1.4 m³ / $280, +40 %."

The alert fires while the cargo is still in the Chinese warehouse — the moment
when the client can still say "then send it back". That is where the Tashkent
argument is prevented.

## Dependencies and consequences

- **Tasks come first.** Answer 5 measures the quote from the moment the VED
  manager is ASSIGNED, so the deal needs the task engine to exist. Phase 3
  before deals.
- **Answer 6c needs `ANTHROPIC_API_KEY` on the server.** Built to degrade
  cleanly: without the key the file still parses and the grouping is manual.
- **Answer 3a means a posted charge must be adjustable** after the fact, with a
  reason and an audit trail, and the deal's profit follows the adjustment.
- The deal supersedes `expected_arrivals` as the "cargo is coming" record for
  anything that was quoted; the simple promise row stays for cargo that was not.

## The board

The kanban board becomes the DEAL board, not the lead board.

A lead is someone who is not yet a client and is worked once; a deal is an
existing client's job and repeats — 1442 clients ship again and again. A funnel
filled with the same clients over and over stops being a funnel, and the
question a salesperson opens the app to answer is "which of my jobs is stuck",
not "who are my clients". Leads keep their own, much shorter, board; winning one
creates the client and its first deal in one tap.
