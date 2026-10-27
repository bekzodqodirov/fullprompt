# Yo'ldagi yuk — planning cargo still on the road to the origin warehouse

Agreed 2026-10-27. The owner: «Plan berishda shunday imkoniyat hohlaymanki skladga kelayotgan yuklar ham
planga qoshish imkoniyati yani horgosga ywdan va har hil zavodlardan yuk kirib kelyabti hali yetib kelmagan
va horgos planda yoldagi yuklarni ham qoshish degan check bolsin shuni bosganda yoldagi yuklar ham tanlash
imkoniyati bolsin». His answers to the five questions: **«1 a 2 a 3 a 4 a 5 a»** — every one the ⭐:

1. **a** — «yo'lda» = cartons on a truck that has already DEPARTED towards this warehouse (`in_transit`, or
   `arrived` at the gate and not yet unloaded). A truck still loading at Yiwu does not count.
2. **a** — factory trips (zavod reysi) heading here are SHOWN as information only, not selectable: their cargo
   has no prixod, no cartons, no QR — nothing a plan line can name. Once received here they are ordinary stock.
3. **a** — the agent may approve the plan before the road cargo arrives. Approval reserves what stands on the
   shelf now; the road part is reserved onto THIS truck automatically the moment the inbound truck is unloaded
   here, and appears in the loader's list.
4. **a** — if this truck finishes loading before the road cargo arrives, that part is simply short
   («yuklanmadi»), as a short-loaded carton is today, and the cargo stays here for the next plan.
5. **a** — the checkbox is on every warehouse's plan, not only Horgos.

v1 of this design was judged by four lenses before code (34 objections, 5 blockers); this is v2, every
surviving objection absorbed. The ones that changed the shape are named where they landed.

## 1. The words

- **origin W** — the warehouse the plan's truck O leaves from.
- **road carton** of lot L for W — loose (`crate_id IS NULL`), `status = 'in_transit'`, riding
  `current_batch_id = I` where batch I has `dest_warehouse_id = W` and `status IN ('in_transit','arrived')`.
  ONE sentence (`planning/road.ts` `roadCartonSql`) for the editor's list, the submit, the approval and the
  loading screen. Crates on the road are not offered (a crate's row stays at its old warehouse until it lands,
  and a crate line takes «exactly this crate's boxes» — stated).
- **road part** of a plan line — how many of its `planned_box_count` the planner took from the road (frozen at
  submit, the promise's ceiling).
- **owed** — of an APPROVED line's road part, how many are still to be reserved onto O.
- **missed** — owed that O's loading ended without (4a). Never erased: it is what keeps the count door from
  asking for it again after «yuklash tugadi».
- **claim** — reserving one carton onto O against an owed line: the carton becomes `planned` on O with a
  `plan_approved` movement (`recordVerdict`'s exact shape, so `shelfBefore` and every give-back read it), owed
  goes down by one, and a `plan_road_claims` row records it.

## 2. Data (migration 0137 `plan_road`, ledger 138)

SIDE tables, never a column on `load_plan_lines` (#1381: the plan's lines are read whole-row by the approval,
the plan view and the agent sheet, and a column a server one migration behind lacks takes all three down):

- `plan_line_road (line_id PK → load_plan_lines ON DELETE CASCADE, road_box_count int > 0, road_owed int,
  road_missed int, created_at)` — one row per line that HAS a road part; no row = none (every existing line).
  CHECK `road_owed >= 0 AND road_missed >= 0 AND road_owed + road_missed <= road_box_count`. `road_owed` is 0
  until approval (a pending promise reserves nothing, objection counts#6/editor#3). Partial index `WHERE
  road_owed > 0`.
- `plan_road_claims (line_id → load_plan_lines ON DELETE CASCADE, box_id → boxes, inbound_batch_id → batches
  NULL, claimed_at, PK (line_id, box_id))` — which carton each claim took and off which truck (NULL = taken from
  the shelf at loading). Read by the give-back's arrival notice (§7), the plan view and the agent sheet.

`road_box_count <= planned_box_count` and «crate lines carry no road part» are the one writer's rules
(`submitPlan`); a CHECK cannot span two tables. `gsr_ai_reader` (0080, allowlist default-deny) is granted
NOTHING on either table (stated, the 0123/0135 precedent — the AI card's fence pins 0080's grant list).

**The probe.** `planRoadReady()` (ftlReady's shape: try/catch, «yes» remembered, `forgetPlanRoadReady()` for
the test) returns a branded `RoadOn` — `{ on: boolean }` minted only there. It is asked on the POOL by every
door BEFORE it opens its transaction (#714, the tx-pool fence) and passed as a REQUIRED argument to every body
that touches the tables: `landUnloadInput`, `resolveOneMissingInTx`, `loadScanInTx`, `planNumber`, the
finish/depart/cancel helpers, `submitPlan`, `recordVerdict`. Off = today's shape exactly, and the editor draws
no checkbox. A derived fence (`road-wire.test.ts`) asserts every caller of those bodies passes it.

## 3. One lock per origin

`roadLock(tx, W)` = `pg_advisory_xact_lock(hashtext('plan-road'), hashtext(W))`. Taken by:

- `recordVerdict`, once, BEFORE its first carton read, when the version has any road line;
- the landing hook, LAST (after the carton and the truck rows it already holds), and only when a live plan at W
  has a road line for the landed lot (a cheap unlocked EXISTS first — a landing of anything else takes no lock);
- the count door and the phone's load claim, right after the truck's loading lock and before any carton lock.

Why it cannot deadlock: the doors that take it first (approval, count door) then lock only SHELF cartons and
truck O's cartons, and the hook holds only cartons it is landing, whose committed version is `in_transit` — no
shelf predicate ever waits on them. Why it is needed (objection locks#1): without it an approval and a landing
of the same lot can each miss the other — the landing sees a pending plan and claims nothing, the approval
does not see the uncommitted carton on the shelf — and owed ends higher than the road holds, for good.

## 4. The editor (`/plans/new`)

- A checkbox **«🚚 Yo'ldagi yuklar ham»**, drawn only when `roadOn`, off by default (every spec's first-row
  selection and every warehouse's habit unchanged). Its state rides `?yol=1`, and a resubmit opens with it ON
  when the version has a road part (objection editor#0 — v1 silently lost the road part of a sent-back plan).
- On: the stock request carries `road=1` and the route returns ONE `lots` list in which every lot carries
  `available` (shelf, may be 0) and, when it has road cartons, `road: { free, trucks: [{ code, state, eta }] }`;
  a lot only on the road comes back in the full row shape (names, client/marking, photo, per-box kg/m³, check,
  receiptId) with `available: 0`, read from its receipt, not from cartons at W (editor#1). So Σ, the gauge,
  the check filter and the prune walk one array (the lot-check fence's `for (const lot of lots)`).
- `road.free` = road cartons of L for W − Σ `road_owed` of approved/loading plans at W (a pending plan reserves
  nothing — on the shelf or on the road). Floored at 0. Shelf and road read in ONE statement.
- The road half is computed in its own try/catch (`[plan-road]`): a failure returns `roadFailed: true` and the
  shelf list still arrives; the quiet re-read prunes road picks only against an answer whose road half came.
- Per row: ✓ keeps today's meaning (the SHELF); a separate «🚚 +M» tap adds the road part; the input clamps to
  shelf + (ticked ? road.free : 0). 📦 prints «count / shelf» with «+M🚚» beside it; «days» prints «—» for a
  road-only lot. Unticking clamps every pick to its shelf part and drops road-only picks, said in a one-line
  note, and is the user's act only — never the initial state of a resubmit.
- The truck line under a road lot: «🚚 +12 yo'lda · YW-123 · 29.10 – 31.10» (`formatEtaRange`), «darvozada»
  for a truck at the gate, «kechikmoqda» for one past its window; a `block whitespace-normal` line like the
  arrival line, so it never widens the code column at 360 px.
- Σ bar: «Σ 50 📦 (🚚 10)» so the gauge is not read as cargo standing here.
- Below the table, folded: «🏭 Zavoddan kelyapti (N)» — trip · client/marking · boxes · state (2a, read-only).
- The submit payload gains `road: boolean`. The editor sends `{lotId, boxCount}`; the SERVER splits shelf first.

## 5. Submit (`submitPlan`)

- `road: false` (or `roadOn` off): exactly today.
- `road: true`: a loose line may take up to `shelfFree + road.free`; `road_box_count = max(0, boxCount −
  shelfFree)`, written with `road_owed = 0`, `road_missed = 0`. Over that: `insufficient_stock` with the same
  `${lotId}:${free}` detail (free = shelf + road), and the editor prints the lot's code from it.
- No lock: a submit reserves nothing, exactly as the shelf part reserves nothing today.

## 6. Approval (`recordVerdict`)

- The verdict is a CLAIM: `UPDATE load_plan_versions … WHERE id = $1 AND agent_verdict IS NULL RETURNING`; zero
  rows → `verdict_already_recorded` (objection locks#5: two approvals of one plan made two trucks — a road-only
  line removed the accidental insufficient_stock backstop).
- With any road line: `roadLock(W)` first. Per loose line: reserve `min(planned, shelf available)` (lowest
  seq, as today); require `reserved >= planned − road_box_count` (the shelf part) — else today's
  `insufficient_stock`; `owed = planned − reserved`; require `owed <= road.free(L)` computed under the lock
  excluding nothing (this plan has no owed yet) — else `insufficient_stock` naming the lot with shelf + road.
- Road cartons that landed between submit and approval are on the shelf now and are simply reserved — owed
  shrinks by itself.

## 7. Claims — the landing hook and the loading-time claim

**The hook** `claimLandedForRoadTx(tx, road, W, landed, inboundBatchId, actorId)` — inside the landing
transaction, after the landing movement:

- Candidates: loose cartons THIS call put on W's shelf (whatever status they came from — a `found_here`
  carton comes from `missing_in_transit`), never `count_over` (those were taken from the inbound origin or
  minted, and `undoOver` must still find them on the shelf).
- Unlocked EXISTS first: a live plan at origin W (status `pending_agent`/`approved`/`loading`, its current
  version) with a road line for the lot. None → return, no lock.
- `roadLock(W)`, then per lot the owing lines — `road_owed > 0`, approved version = current, plan
  `approved`/`loading`, truck O `forming`/`loading` — oldest approval first. Each claim is `UPDATE
  plan_line_road SET road_owed = road_owed − k WHERE line_id = $ AND road_owed >= k RETURNING`; zero rows →
  re-read and try the next line (objection locks#6).
- Doors: `landUnloadInput` (the phone's sync, «Hammasini qabul qilish», the office lot count except
  `count_over`), `resolveOneMissingInTx`'s `found_here`, the stocktake's bulk «found» and the single found door
  (objection locks#3: a stocktake that lands a road carton without claiming it left owed over cargo standing
  here, and «yuklash tugadi» reporting «kelmadi» about cartons on the truck).

**A carton this truck already landed is never landed again by it** (objection locks#0, the blocker): a stale
phone scan of a carton the hook had reserved took the rogue branch and put it back on the shelf with
`undocumented_transfer`. `landUnloadInput` treats a member that has a landing movement off THIS truck into its
destination as already landed (`duplicate`), whatever it has become since.

**The loading-time claim** (self-healing, objection counts#1): a loose carton of an owed lot standing FREE on
W's shelf — however it got there — is claimed when it is loaded:

- the count door claims `min(owed, free)` of the lot before it computes (`claimFromShelfTx`), so its number is
  the plan's and no over-reason is asked for plan cargo;
- the phone's scan of such a carton claims it and loads it as plan cargo (no red confirm, no `added_on_spot`);
- the phone's scan of a carton still `in_transit` to W on a truck whose lot O owes answers `rejected
  road_not_landed` with the inbound truck's code — a sentence, «🚚 Bu karobka hali YW-123 da — avval tushirishda
  qabul qiling» — never `not_on_plan` (objection locks#4/deploy#6: at Horgos cartons go from truck to truck).
- the sync body lands before it loads (`syncScans` ingests unloads first): a landing never depends on a load,
  and one phone working both doors sends both in one body.

## 8. The doors that end O's loading move owed into missed FIRST

`finishLoading` and `cancelBatch` run `UPDATE plan_line_road SET road_missed = road_missed + road_owed,
road_owed = 0 … RETURNING` on O's current approved version, after O's truck lock and before reading O's
cartons. The plan-line row orders them against an in-flight landing: a landing that committed first left a
`planned` carton that `finishLoading` short-loads (4a); one that comes second finds nothing owed.

- `departBatch` refuses `road_owed_open` while anything is owed (beside `finish_loading_first`): «yuklash
  tugadi» is the one door that ends a loading, and the one that says what did not come (objection deploy#0).
- `finishLoading` reports `roadMissed` per lot to the PRESSER (the finish sentence), in the Telegram load
  summary («🚚 10 yo'ldan kelmadi»), and in its audit row.
- A claimed carton given back to `ready_for_pickup` (a collection warehouse) re-claims the arrival notice of
  the truck it landed off (`plan_road_claims.inbound_batch_id`, `claimArrivalNotice` — claim or re-arm):
  reserved onward in the landing's own transaction it was never «ready» and was never announced; back on the
  shelf it is (objection counts#7).

## 9. Readers

- **Count door** (`planNumber`, the panel's plans): `Σ planned − Σ (owed + missed)` — the part of the plan
  that can be on the truck, for the truck's whole life. After a finish «Hammasi» stays the shelf part and grow
  is 0 (counts#0, locks#2).
- **Loading snapshot** (`/api/batches/[id]/planned`): `roadOwed: [{ lotId, label, owed, trucks }]` and
  `roadCodes` — the codes of cartons a scan would claim (free on the shelf, or on an inbound truck), so the
  phone does not draw the red confirm for them. The loading screen prints «🚚 Yo'ldan kutilmoqda: GS777-A · 10
  karobka (YW-123)» above the list.
- **Batch card + board**: `batchLoadTotals` carries `roadOwed`; `cargoLineOf` is «rejasiz» only when nothing is
  planned AND nothing owed, «hammasi yuklandi» only when nothing is owed, and says «🚚 +N yo'ldan» (objection
  counts#3). The batch card prints the owed line beside «yuklash tugadi».
- **Plan view**: a line with a road part shows «🚚 N yo'ldan»; after approval «M kutilmoqda», «K keldi»,
  «J kelmadi».
- **Agent XLSX**: a line with a road part is TWO rows — the shelf part under its (standing) arrival block, the
  road part under «В пути / Yo'lda: <truck codes>», each with its own count and pro-rated kg/m³, block totals
  summing the split figures (objection counts#5). Before approval the road part is `road_box_count`; after,
  `road_owed` (what has landed is on the shelf and files under its arrival).
- **Batch register**: the short column adds Σ `road_missed`.
- **Annul**: a lot owed on an approved/loading plan blocks the annul (`box_on_active_plan`'s words).
- **AI card**: one TRAPS line — `planned_box_count` may include cartons promised from the road.

## 10. Stated, not built

- The road list counts a truck `arrived` at the gate as still on the road — `/arrivals`' rule. The /stock
  strip shows `in_transit` only (#694); the two answer different questions.
- At a hub (in_stock) the hook's reservation is invisible to the client (no hub notice exists). At a
  collection warehouse a reserved landed carton is going onward and is not announced as ready; §8 announces
  it if it comes back.
- Crates on the road are not offered (§1).
- An inbound truck rerouted away from W: its cartons never land here; O's line ends `missed` at «yuklash
  tugadi».
- A landing in the same instant as a plan's submit AND approval can miss the EXISTS pre-check (the window is a
  landing transaction; an approval is a person relaying an agent). The loading-time claim heals it.
