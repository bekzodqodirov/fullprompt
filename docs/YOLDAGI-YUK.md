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

## 1. The words

- **origin W** — the warehouse the plan's truck O leaves from.
- **road carton** of lot L for W — a carton with `crate_id IS NULL`, `status = 'in_transit'`, riding
  `current_batch_id = I` where batch I has `dest_warehouse_id = W` and `status IN ('in_transit','arrived')`.
  ONE sentence (`planning/road.ts` `roadCartonSql`), read by the editor's list, the submit check and the
  approval. Crates on the road are NOT offered (a crate's row stays at its old warehouse until it lands, and a
  crate line takes «exactly this crate's boxes» — stated, not built).
- **road part** of a plan line — how many of its `planned_box_count` were promised from the road.
- **owed** — how many of the road part are still to be reserved onto O when they land.

## 2. Data (migration 0137 `plan_road`, ledger 138)

A SIDE table, never a column on `load_plan_lines` (#1381's rule: the plan's lines are read whole-row by the
approval, the plan view and the agent sheet, and a column a server one migration behind does not have takes all
three down with a 42703):

`plan_line_road (line_id uuid PK → load_plan_lines(id) ON DELETE CASCADE, road_box_count int, road_owed int,
created_at)` — one row per line that HAS a road part, none otherwise (no row = «no road part», which is every
existing line):

- `road_box_count` — the road part, frozen at submit (a FACT about the promise, never rewritten), `> 0`;
- `road_owed` — still to be reserved; set at approval, decremented by the landing reservation, zeroed by every
  door that ends O's loading. CHECK `0 <= road_owed <= road_box_count`. Partial index `WHERE road_owed > 0`.

`road_box_count <= planned_box_count` and «crate lines carry no road part» are the writer's rules (one writer,
`submitPlan`), since a CHECK cannot span the two tables.

A durable `road_owed` and not «plan number minus reserved», because the latter is also true after a person's
deliberate give-back (`short_loaded`, `load_removed`, a count dialled down) — a landing hook reading the
difference would quietly refill what somebody sent back.

`planRoadReady()` (the `lotChecksReady` probe shape): every reader and writer of the table asks it first, and on
«no» (a deploy whose migration did not land, #472) runs today's shape — no road list, no hook, no road part. The
unload path in particular never names the table on an old schema; its probe is asked on the pool BEFORE the
landing transaction opens (#714) and handed in.

## 3. The editor (`/plans/new`)

- A checkbox **«🚚 Yo'ldagi yuklar ham»** above the list, off by default (every e2e spec's first-row
  selection and every warehouse's habit are unchanged). Its state rides the URL (`?yol=1`) so a refresh keeps it.
- On: the stock request carries `road=1` and the route ALSO returns `road` (a separate function
  `roadStock(W)` — `plannableStock` and its fences are untouched):
  - per lot: `roadFree` (road cartons minus what other live plans already promised from the road — §5) and its
    inbound trucks `[{ code, etaFrom, etaTo }]` (ETA from `trucksOnRoadRows`, printed as DAYS so the JSON's
    ETag does not change every millisecond);
  - `factoryTrips`: `incomingForWarehouses([W])` filtered to trips `on_road`/`arrived` — information only.
- The table: a lot that has road cartons shows a second line «🚚 +M yo'lda · YW-123 · ~29-31.10»; a lot that is
  ONLY on the road gets its own row marked 🚚. ONE row per lot (the selection stays `Map<lotId, count>`); the
  row's maximum = shelf + roadFree when the box is ticked, shelf alone when not. Unticking clamps every pick to
  its shelf count (and drops road-only picks) — said in a one-line note, never silently.
- The quiet re-read on tab return reads the same `road` and prunes against shelf + road.
- Below the table, folded: «🏭 Zavoddan kelyapti (N)» — trip code · client/marking · factory boxes · status.
- The submit payload gains `road: boolean` (the box's state). The editor sends only `{lotId, boxCount}` per line;
  the SERVER splits shelf first: `roadPart = max(0, boxCount − shelfFree)`.

## 4. Submit (`submitPlan`)

- `road: false` (or the column not there): exactly today — a line over the shelf is `insufficient_stock`.
- `road: true`: a line may take up to `shelfFree + roadFree(L)`; `road_box_count = max(0, boxCount − shelfFree)`.
  Over that: `insufficient_stock` with the same `${lotId}:${free}` detail (free = shelf + road).
- `roadFree(L)` = road cartons of L for W − Σ the road promises of OTHER live plans' current versions:
  `pending_agent`/`changes_requested` → their `road_box_count`, `approved`/`loading` → their `road_owed`. The
  plan being resubmitted is excluded (`ne(plans.id, input.planId)`), as the crate guard does.
- Read on `tx` (#714, the tx-pool fence).

## 5. Approval (`recordVerdict`)

Per loose line: reserve from the shelf as today, but take `min(planned, available)` and require
`reserved >= planned − road_box_count` (the shelf part) — short of that is today's `insufficient_stock`.
`road_owed = planned − reserved` (≤ `road_box_count` by the line above). Road cartons that landed between submit
and approval are on the shelf now and are simply reserved at approval — the owed part shrinks by itself.

## 6. The landing reservation (the hook)

`reserveRoadPlannedInTx(tx, landed, W, actorId)` — inside the landing transaction, after the landing movement:

- Candidates: cartons THIS landing moved from `in_transit` on the inbound truck (`toMove ∖ rogue`), loose
  (`crate_id IS NULL`), now on W's shelf. Never `count_over` cartons (taken from the origin or minted — `undoOver`
  must still find them on the shelf), never a rogue carton.
- Per lot, the plan lines at origin W owing that lot, on a plan `approved`/`loading` whose truck is
  `forming`/`loading`, oldest approval first. Each claim is ONE statement:
  `UPDATE plan_line_road SET road_owed = road_owed − k WHERE line_id = $line AND road_owed >= k RETURNING …` —
  the row lock IS the serialisation; no truck lock is taken (the count door holds the lot row and then the truck
  lock; taking O's truck lock here, after the lot's cartons, would close that cycle).
- Per claimed carton: `status = 'planned'`, `current_batch_id = O`, `current_warehouse_id = W` and ONE movement
  `cause 'plan_approved'`, `ref = (batch, O)`, `from = to = W`, `from_status = the shelf status it landed with` —
  exactly `recordVerdict`'s shape, so `shelfBefore`, the arrival ledger (`from IS DISTINCT FROM to`) and every
  give-back read it as they read an approval.
- Doors that call it: `landUnloadInput` (phone sync, «Hammasini qabul qilish», the office lot count except
  `count_over`) and `resolveOneMissingInTx`'s `found_here`. NOT the stocktake (`reconcileInventory`) nor a
  status restore — those land cartons with no truck and are stated.

## 7. The doors that end O's loading zero `road_owed` FIRST

`finishLoading`, `departBatch` and `cancelBatch` (O's truck lock is already their first statement) run
`UPDATE plan_line_road SET road_owed = 0 … RETURNING` on O's current approved version BEFORE reading O's
cartons. The plan-line row lock orders them against an in-flight landing: a landing that committed first left a
`planned` carton that `finishLoading` short-loads (4a: loading is over) and `departBatch` refuses as
`finish_loading_first` (today's rule); a landing that comes second finds nothing owed.

- `finishLoading` reports the road part that did not come: «🚚 Yo'ldan kelmadi: N» in the load summary and the
  audit row (`roadMissed`), per lot in the summary text.
- `cancelPlan` (before approval) needs nothing: no owed is set before approval.

## 8. Readers

- **Count door** (`planNumber`, the panel's `plans`): the plan number EXCLUDES what is still owed —
  `Σ planned_box_count − Σ road_owed` (a LEFT JOIN on the side table). Without it «Hammasi (50)» with 10 on the road asks for an over-reason and
  `growLotInTx` mints 10 cartons that then land as duplicates.
- **Loading snapshot** (`/api/batches/[id]/planned`): `roadOwed: [{ lotId, label, owed, trucks }]`; the loading
  screen prints one line «🚚 Yo'ldan kutilmoqda: GS777-A · 10 karobka (YW-123)» above the list, so nobody
  presses «yuklash tugadi» not knowing.
- **Plan view** (`/plans/[id]`): a line with a road part shows «🚚 N yo'ldan» and, after approval,
  «M kutilmoqda» while owed.
- **Agent XLSX**: a lot with a road part and no arrival HERE is filed under «В пути / Yo'lda: <truck codes>», not
  under «Принято на складе» (that would be a false sentence on a customs document). Lots without a road part
  keep today's blocks — the m3 assertions on «Принято на складе» stay.
- **Annul** (`receipts/annul.ts`): a lot owed on an approved/loading plan blocks the annul like a lot on a
  pending plan (`box_on_active_plan`), or the line waits for cargo that no longer exists — and the annul's own
  retirement of an emptied inbound truck never strands a line silently.
- **Board card** (`batches/board-view.ts` `cargoLineOf`, via `batchLoadTotals`): a forming truck whose plan is
  owed road cartons says «🚚 +N yo'ldan» and is never «rejasiz» / «hammasi yuklandi» while something is owed.
- **AI reader**: the new table is added to the `gsr_ai_reader` grant list the way `load_plan_lines` is
  (`ai-schema-card.test.ts` pins the list both ways).

## 9. Stated, not built

- The road list counts a truck `arrived` at the gate as still on the road — `/arrivals`' and the warehouse
  home's rule (`IN ('in_transit','arrived')`, cartons still `in_transit` on it). The /stock strip deliberately
  shows `in_transit` only (#694); the two answer different questions.
- At the destination of the road cargo, a carton reserved the moment it lands reads as the plan's cargo
  everywhere a planned carton does today: not in the handover list (a collection warehouse), «eksportga
  tayyorlanmoqda» in the cabinet at a hub, out of «yukingiz keldi». That is what approval does to shelf cargo
  today; the hook does nothing approval does not.
- The agent sheet re-downloaded after the road cargo lands files it under its real arrival truck instead of
  «Yo'lda» — the claim changed because the cargo moved, not because a column was nulled (#643's case).

- Crates on the road are not offered (§1).
- A stocktake that lands an inbound carton does not reserve it; the count door's «Hammasi» reserves it later.
- An inbound truck rerouted away from W: its cartons never land here, and the line ends short at «yuklash tugadi».
- The batch card's and the board's load figures count reserved cartons (as today), so the road part is visible
  on the plan view and the loading screen, not on the board.
- At a collection warehouse (Andijan) a reserved landed carton is not «ready» there, so the client's «yukingiz
  keldi» for that warehouse leaves it out — it is going on to the next warehouse, which says so when it lands.
