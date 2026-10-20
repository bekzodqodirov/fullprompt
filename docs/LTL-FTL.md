# LTL / FTL — sborniy va butun mashina

Agreed 2026-10-20. His message: «bizni sohada LTL FTL degan narsalar bor biz odatda LTL boyicha ishlaymiz
va KPI sovrinlar shu LTL boyicha hsoblanadi agarda FTL bolsa bunga kpi yozilmaydi va olib kelgan yuki KPI ga
kirmaydi hozirgi gamificationda FTL va LTL birga qoshilib ketyabta va bizni sistemada LTL va FTL ni ajratish
imkoni yoq». Answers: **«3 b / qolgani sen aytgandek»** = 1a 2a **3b** 4a 5a 6a 7a. Migration **0135
`load_mode`** (ledger 136). Decisions #1416-#1425.

## His answers, as built

| # | Answer | What it means in the code |
|---|---|---|
| 1a | The mode lives on the DEAL; a prixod takes it; the prixod card corrects it | `deal_ftl` / `lead_ftl` / `receipt_load_mode`; inheritance at confirm, re-file and the deal's own change (`inheritSql`, one statement) |
| 2a | A seller marks his own FTL; only admin / logist / buxgalter take it back | `ftl/door.ts`: office = unscoped `plans.manage` ∨ `finance.reports`; a seller's mark reaches only cargo stamped to HIM |
| 3b | The weekly rating shows FTL on a separate line, no points | `ftlBlock` after «Jamoa», `/reyting`, the bot; an FTL-only seller is not «idle» |
| 4a | Celebrations still celebrate FTL, label it, keep it out of «bu oy» | `🚛 FTL — butun mashina`, no month line on an FTL win; the tally counts LTL wins only |
| 5a | Upsale unchanged | the filter is in the KPI's `stamped` scope only, never in `u_box` / `paidCargo` |
| 6a | Old FTL marked by hand; a PAID month is never recalculated | the freeze: a prixod whose KPI month is paid to its seller cannot change mode |
| 7a | One client fills a truck → «Bu FTL bo'lishi mumkin — tekshiring» to the logist | `FtlSuspected` after `departBatch` commits |

## The rules

- **No row = LTL.** The business runs on LTL, so the default is silence: nothing backfilled, every machine
  creator (bot intake, auto-deal, inbound adverts) writes LTL by construction.
- **Side tables, never columns** on leads / deals / receipts (#1381's reason): a declared column there is named by
  ~75 whole-row reads and would answer them 42703 one migration behind — receiving and the CRM down (#735).
- **A prixod inherits FTL** from its deal only when the deal is its client's, the mark may reach it (an office
  mark: every prixod; a seller's: only his own stamp), nobody pinned it by hand, and its month is not paid.
- **Nothing downgrades by accident.** A re-file to an LTL deal or a detach keeps the mode. FTL → LTL is the
  office's explicit decision; a deal's revert takes back exactly what THAT deal gave (`from_deal_id`).
- **The freeze (6a)** is a refusal, not a recount: KPI is netted (paid − earned), so letting a paid month move
  would claw it back from the next one. Floored at the first KPI month (older months carry no KPI money). Voiding
  the payout lifts it. The writers take the payout's own `kpi:<seller>` lock, sorted, before any receipt row.
- **The office hears a seller's own mark** (`FtlMarked`): dropping a light lot can LIFT a month's density band.
- **KPI = LTL** everywhere it is read (`KPI_LOAD`): /hodimlar, the payout, the paid part, profile «Bu oy»,
  /upsale's «Olib kelgan yuk (KPI)», the seller report's kub columns, the rating's points. FTL is shown beside
  each, never added in. Money (revenue, cost, profit, upsale) is untouched.
- **The hint** fires on every truck but a «davomi» — Yiwu → Kashgar included (it is the truck a whole-truck job
  leaves China on); a person with two codes on one phone is one owner; an all-unclaimed truck resolves its
  markings; it names only prixods that can still change, and never the same prixod twice.

## Stated, not built
- A prixod received at the warehouse with no deal is LTL until somebody links it; the first-cargo post reads
  the mode at send time, so it says FTL only when the prixod was already FTL.
- An office person who is also a seller can revert his own stamp (the owner's open «admins as sellers»
  question).
- Past rating weeks keep the figures they were posted with (nothing was FTL before this round).
- No board filter by mode, no FTL question in the bot's calc intake, no FTL in sales analytics.
