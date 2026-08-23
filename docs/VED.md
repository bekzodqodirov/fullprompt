# VED module — agreed specification

Settled with the owner over 2026-08-13/22, in his own words and my questions.
This file exists so the answers survive: they were expensive to obtain and
every one of them changes what gets built. The implementing session should
read CLAUDE.md first (the map), then this file end to end, then the
"what already exists" section's source files BEFORE designing anything.

---

## The problem, as the owner described it

Sales managers leave a calc request (zapros) with full cargo information —
photos, PDF/Word/Excel files, kg, dimensions, volume, pickup city, anywhere
from 1 to 1000 goods at once. Today the VED worker does the whole calculation
in **Excel**: groups goods by TNVED code, sets the code, sets the **baza**
(customs valuation base) from memory or by searching the official base,
checks rates in an external program (**AIC calculator**), computes customs
(rastamojka), adds freight (yo'lkira) and other expenses (CCT/certificate
etc.), and hands the seller a landed price. The seller quotes the client,
sometimes with an upsale on top.

What the owner wants (his list, verbatim intent):

- know HOW the VED manager calculated and WHICH baza they took — per request;
- always see the prices currently being quoted for a product;
- after the batch arrives, see the ACTUAL rastamojka and other payments vs
  the calc;
- see the sellers' upsale (who added how much);
- cut calculation time; cut errors; add AI to strengthen control — "is the
  VED manager making mistakes or not".

## What already exists — REUSE, do not rebuild

| Piece | Where | State |
|---|---|---|
| Bot «Hisoblatish» intake (sections yolkira/rastamojka/podklyuch, files+photos+text, AI extraction, lands on lead/deal) | `wms/calc/intake*.ts`, `telegram/calc-intake.ts` | live (round 37) |
| AI TNVED grouping with confidence + estimated duty %, VED confirms into `saveLines` | `deals/goods-import.ts`, round 17 | live |
| TNVED memory base (previously assigned codes) | phase 1.5 assistant | live |
| Calc request + SLA clock (`calc_requests`, timed task, overdue sweep) | service/actions/jobs DELETED in rounds 46/84, TABLE and design remain | door closed — REOPEN, do not re-invent |
| Actual costs per batch/receipt (rastamojka, freight, CCT…), allocations, landed cost, dealProfit, quote-vs-reality | M6 + phase 5 | live |
| Lead quote columns (`quoted_amount/currency/volume_m3/weight_kg`) | migration 0062 | live |
| Deal quote + `quoted_at/quoted_by` stamps | phase 5 | live |
| Plan-density colour scale (kg/m³ concept) | round 12, migration 0040 | live |
| Cost types dictionary incl. seeded customs/CCT/freight codes | round 29 | live |

## The agreed laws

1. **AI is advisory, never load-bearing.** AI fills the first draft and
   flags; no key / no balance / refusal → the same screens work manually.
   Nothing AI writes reaches a client without the VED's explicit confirm.
   Every AI-filled cell carries a visible marker until the VED touches or
   confirms it, and BOTH the AI draft and the confirmed values are stored.
2. **The sealed price.** The price the VED sends lands on the card LOCKED:
   neither seller nor VED can change it. Only admin can; a change is audited
   AND notified to the owner. Corrections are new VERSIONS — nothing is
   overwritten.
3. **Quote validity = 1 month.** After that the card says "expired —
   recalculate".
4. **Upsale.** *(SHIPPED, phase D.)* Client price is entered by the seller on
   the card; upsale = client price − VED price, computed, never typed. Floor: client price ≥
   VED price (below-floor is admin-only). **ANY discount kills the upsale
   right** — a freight discount included (owner: «yolkiradan tushirganda ham
   upsale o'chsin»). Visibility: owner + accountant + the seller (own only).
   **VED never sees upsale.** Money flow: client pays the FULL sum (VED
   price + upsale) to the kassa; the accountant pays the upsale out to the
   seller — the cash screen must show both figures side by side.
5. **Baza is per-PRODUCT, not per-code**, versioned by validity period.
   One TNVED code can hold several products with different bazas. Baza
   changes roughly quarterly; values older than 3 months wear a stale ⚠;
   old calcs keep their period's value for ever. A **monthly** task opens
   for the VED to review the baza dictionary (owner: «har oyda»).
6. **Rates live in our dictionary and learn from corrections.** Entering a
   TNVED code auto-fills its rates; when the VED checks AIC calculator and
   corrects a rate, the correction is REMEMBERED. AIC calculator stays the
   external verification source — never scraped, never called.
7. **Lgota (exemption) is per-CALC**, decided by the VED each time (same
   code is sometimes exempt, sometimes not — duty exemption and tax
   exemption are separate flags); the dictionary remembers the last state
   as the offered default.
8. **Freight**: density = TOTAL kg ÷ TOTAL m³ of the whole request; band
   from the tariff table; price per m³, except density ≥1000 kg/m³ which is
   per kg. YW and GZ share one tariff; cargo arriving directly at Kashgar
   uses the Kashgar column. Client price is always TO TASHKENT (an Andijan
   reload is internal). No minimum charge — very small cargo gets only a
   warning. The VED may discount freight, but a below-tariff figure is
   FLAGGED and notified to the owner (and kills upsale, law 4).
9. **Request types**: full (podklyuch = rastamojka + yo'lkira + expenses),
   rastamojka-only, yo'lkira-only — clients sometimes buy one service.
   These map 1:1 onto the bot's existing sections.
10. **Price book guard.** The current selling price per product
    («monitor — 450 $/kub») is hand-maintained (admin/VED) and shown IN the
    workspace beside the last 5 real quotes, so underquoting and
    per-client price drift are visible at decision time. Sellers and VED
    can read the price history (sellers: prices only, no cost breakdown).
11. **Everything the seller submitted is shown to the VED AS-IS** — files,
    photos, forwarded messages, unabridged, beside the AI draft (owner's
    explicit ask).

## The freight tariff (owner's own table, USD)

Density (kg/m³) → price per m³; last row per kg:

| kg/m³ | YW/GZ | Kashgar |
|---|---|---|
| 1–100 | 110 | 70 |
| 101–150 | 130 | 85 |
| 151–200 | 160 | 100 |
| 201–250 | 180 | 115 |
| 251–300 | 200 | 130 |
| 301–350 | 230 | 150 |
| 351–400 | 260 | 170 |
| 401–450 | 280 | 180 |
| 451–500 | 290 | 190 |
| 501–700 | 300 | 195 |
| 701–999 | 320 | 200 |
| ≥1000 kg/m³ | 0.55 $/kg | 0.30 $/kg |

Editable in admin; edits keep history (an old calc reads its own tariff).

**The eleventh row is 701–999 by the owner's own correction (2026-08-23).**
As first written it was «700–900», which left 700 in two bands and 900-999 in
none — and each is real money (30 m³ at 950 kg/m³ is $9,600 or $15,675
depending on which way the gap is read). His three answers, asked with the
numbers attached:

1. 900-999 takes this row's price — «sen aytgandek».
2. The bands run consecutively: each starts where the one before it ended,
   plus one — «ketma ket qanday kelyabti shunga mosla». So 700 stays in
   «501–700», and the row after it begins at 701.
3. The step at 1000 stays a step, not a floor — «shunday qolsin».

The table now covers every whole kg/m³ from 1 upwards exactly once, which
`tests/unit/calc-pricing.test.ts` asserts against the very module the seed
writes from. The engine's `band_missing` / `band_ambiguous` refusals STAY:
they are about the tariff a person may edit tomorrow, and they are why a
future hole will be a visible refusal rather than a quietly cheaper invoice.

## The dictionaries (four)

1. **Product dictionary**: name → TNVED code + baza (+validity period,
   history kept, stale ⚠ after 3 months) + lgota default.
2. **Code dictionary**: TNVED → rate set (duty %, VAT %, …) + lgota flags;
   VED corrections remembered (law 6).
3. **Freight tariff**: the table above, editable, versioned.
4. **Selling price book**: TNVED code → current client price $/m³ or $/kg,
   hand-set; beside it the system shows the last real quotes.
   **SHIPPED in phase C, keyed on the CODE and not the product name** — a
   name does not normalise («Ayollar kurtkasi» / «куртка жен.» /
   «women's jacket» are one thing and three strings), while a code is
   written down and confirmed by a person before anything can be sealed
   against it. `calc_price_book` (tnved_code, effective_date) UNIQUE, read
   like `fx_rates` with **no earliest-row fallback**. It stores the CLIENT
   price and never the sealed floor.

## Screens and flows

- **Seller, phone-first (Telegram is the main door):**
  - Forwarding client messages to the bot = a request. AI extracts
    goods/kg/m³/city and asks ONLY for what is missing («Shahar qaysi?»).
    Confirm → VED queue. Voice notes are NOT transcribed (stated to the
    owner) — the seller adds a line of text.
  - On a card whose Telegram thread is in the CRM: a «Hisoblatishga
    yuborish» button — select messages, one tap, request minted from them.
  - Card form for office/Excel users: type, goods (manual / Excel import /
    files), city, kg, m³. 360 px first, as always.
  - A completeness checklist on the request (tovar ✓ · kg ✗ · …); the VED
    can bounce an incomplete request back with a reason.
  - The ANSWER returns to the seller's bot chat: price, breakdown,
    validity — plus a ready-to-forward client offer text.
- **VED queue**: open requests, deadlines, overdue red — reopen the round-28
  machinery (`calc_requests`), do not rebuild it.
- **VED workspace** (the Excel replacement): left = the submitted materials
  as-is; right = the calc table — AI-proposed groups, per group: code,
  baza (dictionary, stale ⚠), rates (dictionary, corrected-and-remembered),
  lgota checkboxes, rastamojka auto; below: freight (auto from density,
  discount possible with flag), CCT + other expense rows; totals as $/m³
  AND $/kg with rastamojka and yo'lkira shown separately. Sidebar: this
  product's history — past quotes, ACTUALS from arrived batches, current
  price-book price. AI warnings as banners. «Yuborish» = the seal (law 2).
- **Card (lead/deal)**: sealed VED price + versions + validity; seller's
  client-price field → upsale computed; one-tap client offer sheet
  (Telegram message / PDF, client's language).
- **Accountant**: both figures at cash intake (law 4).
- **Reports**: VED accuracy (calc vs batch actuals, per worker, monthly);
  upsale per seller; seller performance (period: kub / kg brought in,
  profit generated — deal profit machinery exists); suspicious-calcs list.

## Error control (three moments — the owner's «adashsa qanday bilamiz»)

1. **At confirm**: confirming OVER an AI warning is recorded; the owner has
   an "confirmed-over-warning" list.
2. **After sending**: AI re-reads confirmed calcs (price-book deviation,
   history deviation) → suspicious list to the owner, before any batch.
3. **At batch arrival**: automatic calc-vs-actual comparison — per request.
   **Per GROUP is impossible and was cut** (a group is a TNVED code, a
   receipt lot is a product name; nothing joins them). Per VED worker and the
   monthly accuracy report wait for E2's precondition: with one VED person,
   «Aziz: 23, 2 %» is a comparison table with one row.
   Plus: AI draft vs VED-confirmed stored separately (`ai_proposal`), so
   "blind confirm" is distinguishable from the VED's own error.

## Build phases (each ships alone, owner reviews live between phases)

- **A — Requests in order**: card form + upgraded bot flow into ONE VED
  queue; SLA clock reopened; completeness checklist; bounce-back.
- **B — VED workspace**: the calc table, dictionaries 1-3 born here,
  versions, the seal, validity, freight auto + discount flag.
- **C — Price base + offer sheet**: price book (dictionary 4), last-5,
  history search for sellers+VED, one-tap client offer, monthly
  dictionary-review task.
- **D — Upsale and money**: **SHIPPED 2026-08-23** (migration 0088).
  The upsale is DERIVED (client price − sealed floor) and never stored; only
  its permission (`approved_at`) and its payment (`payout_expense_id`) are
  facts. `payableOffersSql()` is the one home for five rules and `payUpsale`
  embeds it in its own claim rather than trusting the ids that were ticked.
  Below-floor locks the PROMISE and not the record. A released offer writes
  the client price onto the card — which is what every revenue surface reads
  — and `quoteLockedFor` had to follow it, or every later save on a quoted
  card would be refused for ever. The payout is an `expenses` row in a
  mandatory dedicated category with a server-derived amount. `/upsale` in two
  shapes. Decisions #785-787.
- **E1 — Fact control**: **SHIPPED 2026-08-23** (migration 0089). The
  comparison is **CUSTOMS ONLY** — `freight_usd` is our own list price and
  `cost_allocations.amount_usd` is what the road cost, so their difference is
  MARGIN and would have flagged every correct calculation for ever (measured:
  +78 % permanently on a 200 kg/m³ cn load). Freight gets a deterministic
  BAND CHECK at the arrived density instead. The join is new
  (`receipts.calc_request_id`), lives at the RECEIPT grain because a deal
  carries many of both, has ONE writer (`stampCalcLink`, called from
  `createReceipt`, `linkReceipt` and `sealCalculation`), and an `auto` link is
  a SUGGESTION that never scores anybody until a person confirms it. A ✅ now
  records what stood on the screen (`confirmed_warnings`, `confirm_via`) and
  the seal carries three counters away. Six refusals, ⚠ and a reason, never a
  $0. Two clocks: sealed-at for coverage and warnings, arrived-at + a settle
  window for the arithmetic. `/hisoblash/nazorat`, gated by its own
  `calcControlScopeFor` (owner/accountant = all, VED = own, seller = none).
  Decisions #796-800.
- **E2 — AI control**: the history-dependent suspicious rules, the per-worker
  ranking, the workspace sidebar's actuals column and the Telegram digest.
  **PRECONDITION, stated numerically**: ≥20 sealed versions with confirmed
  links and settled cargo, and a non-empty `calc_price_book`. The dictionaries
  ship empty, so today every one of those rules would be true of 100 % of
  groups and a digest would name every calculation every morning.
  **CUT from the module entirely and stated to the owner**: per-TNVED
  calc-vs-actual (a group is a CODE, a receipt lot is a NAME in zh/ru — they
  do not join, and names do not normalise) and the nightly AI pass
  (`gsr_ai_reader`'s allowlist cannot reach the tables, `ai_questions.user_id`
  is NOT NULL so a scheduled call is unauditable, and it is subtraction the
  arithmetic already does deterministically for ~$320/month).

## House rules that will bite here (read before building)

- No new permissions (#170): gate on `ved.docs`, existing finance/crm
  grants; upsale visibility follows the round-91 money-scope shapes.
- i18n ×4 for every string (#163); migrations: fetch main and read the
  journal tail FIRST (ten collisions already; next free number moves).
- Money pair-rules (#528): a discount, a payout, a void each have two
  sides — write both in one transaction.
- Server actions touching new schema must catch (#472-475).
- Verify at 360 px with screenshots; measure widest values (#400, round 88).
- The adversarial design review BEFORE code is the house method for a
  round this size; every phase needs red-proven tests and the full
  CI-order run.
