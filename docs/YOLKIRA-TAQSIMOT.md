# Yo'lkira tarifi bo'yicha taqsimlash — the spec as agreed (his answers of 2026-10-14)

The draft this replaces (researched 2026-10-13, six questions sent) is kept in git history at commit 1e23f85.


His answers, verbatim: «1a 2c 3a 4a 5a 6 1kub 10kgdan kam tpgri keladgan bolsa ogohlantirsin, qolgani 1kub uchun 100 kgdan kam tarifda ketaversin».
On the twin-threshold question (Sarflar): «Buni ozing togri deb bilgandek qilaver». It stays at ⭐ a, 1 % / 3 days, untouched by this round.

Base: `origin/main` 9483ab5 (PR #119 Sarflar merged). Branch `claude/gsr-logistics-wms-phase1-o8h4en`.
Migration **0132** (journal idx 132, `when` 1785190000111, tag `0132_cost_freight_basis`), so the ledger must reach **133**. DECISIONS continue at **#1364**.
Before minting, run `git fetch origin main` and re-read the tail of `_journal.json` and DECISIONS (#605/#1040).

Every line reference below was checked at 9483ab5.

---

## 0. The answers, as decisions

| Q | His answer | What it means here |
|---|---|---|
| 1 | a | The grain is each CLIENT's whole cargo on the truck. Unclaimed cargo is its own group per PRIXOD. Each group gets one combined density and one tariff row. Inside a group the share is split by m³. |
| 2 | **c** (the draft recommended a) | Every warehouse gets a tariff column, written by a person. A truck takes the column of its ORIGIN warehouse (`batches.origin_warehouse_id`; there is no `from_warehouse_id`). There is no per-bill picker. The column is never inferred. A warehouse with no column written means freight is refused for its trucks, in words that name the warehouse. |
| 3 | a | When a bill is saved, the zone and its bands as of the bill's `cost_date` are copied into a side table, together with where they came from. Later /admin/tarif edits and later warehouse-column edits never move a saved bill. |
| 4 | a | Batch scope only: the truck's Xarajatlar tab and /accounting/sarflar/kiritish. It is preselected for the freight cost type(s). For customs codes it is hidden, and the server refuses it. |
| 5 | a | Old bills stay as they are. Each live truck bill gets a re-basis door that previews every client's before→after and only then changes the basis. It never touches amount, payer, kassa, partner or merge. |
| 6 | his rule | See §1.4. A priced group under **10 kg/m³** means the bill is saved but NOT split, with a ⚠ that names the group and its lots, lightest first. Fixing the lot re-splits the bill by itself. A group at ≥10 kg/m³ whose density is below the column's lowest band floor is priced at the column's LOWEST band. Bands above are read as the tariff says, and the per-kg top band stays per kg. |
| twin | «o'zing» | The twin alarm stays at 1 % / 3 days (Sarflar `TWIN_FX_PCT`, `TWIN_FX_DAYS`). This round does not touch it. |

---

## 1. The rule — what a share is

### 1.1 The set
Which boxes share a bill does not change. `scopeBoxIds` (costing/service.ts:895) decides it. For a non-customs batch bill that is `riderFilter(batchId)` minus void boxes (service.ts:998-1010). The basis only weights the boxes inside that set.

The batch branch's non-customs query gets a name of its own, `truckRiderBoxIds(batchId, handle)`, exported from service.ts. `scopeBoxIds` and the preview (§7) both call it, so the preview is drawn over the recompute's own set.

### 1.2 Groups
- The set's cartons are grouped by `receipts.client_id`.
- A carton whose receipt has `client_id IS NULL` goes into the group `r:<receipt_id>`, one per prixod.
- Group labels:
  - a client group uses the client code;
  - an unclaimed group uses `unclaimed_marking`, or failing that the receipt number.
- A claim (`assignReceiptClient`, receipts/edit.ts:909-911) already calls `recomputeForLots`, so a claimed prixod folds into its client's group with no code of its own.
- Phone-sibling codes (444/555/777) are SEPARATE groups. The grain is `client_id`. This is stated, not solved.

### 1.3 Stable per-box measures (used by freight only; weight/volume/chargeable keep boxDims' totals ÷ box_count unchanged)
Per box, read from the lot:
- **uniform lot with all four of `box_length_cm`, `box_width_cm`, `box_height_cm`, `box_weight_kg` non-null**:
  - grams = `box_weight_kg` × 1000. This is exact, because the column is numeric(12,3).
  - cm³ = L·W·H, an integer.
- **any other lot** (mixed, or a legacy uniform lot with NULL dims):
  - grams = `total_weight_kg`×1000 ÷ `box_count`;
  - cm³ = `total_volume_m3`×1e6 ÷ `box_count`.
  - These are exact rationals: both totals are fixed-scale numerics, so T×10^scale is an integer.
- The mode is decided by `dims_mode` and the four non-nulls together, never by whether dims are present alone. A mixed lot may carry dims (receipts/service.ts:70).

Group sums are taken in **exact rational arithmetic (BigInt numerator/denominator)**:
- the group's Σgrams and Σcm³;
- the whole density **d = roundHalfUp(1000·Σg / Σcm³)**.

This is the same rounding as `bandDensityOf` (`Math.round` is half-up for positive numbers), but it is computed without float noise. That fixes:
- the 40³ cm / 63.968 kg carton: exactly 999.5, so 1000 at EVERY count (the float sum flipped 999↔1000 with n, scout data);
- the 21 cm / 9.256 kg carton: 999.46, so 999 at every n (totals-based flipped into the per-kg band at n=2).

`bandDensityOf`, `bandFor` and `freightFor` stay **byte-identical**. The calc, the seal, E1 and the bot do not move. The draft's 1e-6 pre-round of `bandDensityOf` is DROPPED.

The raw density, a float Σkg/Σm³, is used only as the multiplier on a per-kg band (§1.5).

### 1.4 His rule 6 — the order inside one group
`FREIGHT_LIGHT_BELOW = 10` is an exported constant in `costing/freight-split.ts`. It is not a setting:
- A setting would be a pool read inside the recompute tx (#714), or else it would have to be frozen anyway.
- The value IS frozen into each bill's copy as `light_below` (§3), so changing the constant later moves only new saves (3a's principle).

**Step 0, before any group (M3/E1):** an EMPTY pool (no measures at all, after the `direct_to_client` client filter) is `{kind:'nothing'}`, for every basis. This is judged before the copy, the customs flag or any group is read (§9.6), so a held reason can never stand in for «no cargo» (the void guard depends on it, §6.7).

For each group (EVERY group is judged; the verdict collects all of them, E8):
1. Any box measure that is non-finite, a cm³ ≤ 0 or grams < 0 gives `measure_missing`. It names the lot(s) whose box measure fails. The whole bill is HELD (§6).
2. If `d < copy.light_below` the reason is `too_light`, and the bill is HELD.
   - A bill with both a measure-missing group and a light group is HELD with BOTH lists (§6.1), measure first, so fixing one lot leaves a ⚠ naming the other.
   - A LOT whose own density is below `light_below` inside a group that is ≥ `light_below` does not hold anything (the fixed reading: the group is the grain). It is named as a non-blocking info line in the preview and the fold (`freightLightLot`, §6.2, M8).
   - The comparison is on the WHOLE density, the number every screen prints. So 9.49→9 warns and 9.5→10 does not. Both are pinned with literals.
   - Σgrams = 0 with Σcm³ > 0 gives d = 0, which is `too_light`. The sentence says «0 kg/kub».
3. `lowest` = the copy's band with the smallest `minDensity`. The copy is a `bandsAsOf` set, deduplicated on `zone|minDensity`, so `lowest` is unique. **If `d < lowest.minDensity`, the group is priced at `lowest`** («1 kub uchun 100 kgdan kam tarifda ketaversin»).
   - On his seeded columns both lowest floors are 1 ≤ 10, so this clamp never fires today.
   - It matters only for a column he types with a higher first floor.
4. Otherwise `bandFor(copy.bands, zone, d)`, unchanged.
   - A copy cannot have a gap, because the save refuses one (§5).
   - A `band_missing`/`band_ambiguous` from a hand-corrupted copy gives `copy_invalid`, and the bill is HELD.

The <10 check runs BEFORE any band lookup. Without that ordering, a density of 5 would land in [1,100].

### 1.5 Value and box weight
- Group rate per m³: **r = band.perKg ? band.priceUsd × densityRaw : band.priceUsd**. It is left unrounded.
- The group value V = r × Σm³. On a per-kg band that is price × Σkg.
- Box freight weight = r × (that box's stable m³). Summed over the group this is V, and inside the group the bill splits by m³.
- `allocateEntry`'s largest remainder (engine.ts:62) splits the bill by these weights, so client share = bill × V_c / ΣV.
- Only the RATIOS between bands matter. The list level carries margin (calc/actuals.ts:9-17) and cancels out.

### 1.6 Worked anchors (literal, pinned in the pure test)
- His example on the seeded Xitoy (cn) column:
  - A is 2 m³ at 600 kg/m³ (band 501-700, $300); B is 1 m³ at 160 kg/m³ ($160).
  - Values: A = 600, B = 160. A $350 bill splits **276.32 / 73.68**.
  - On the Qashqar column (A $195, B $100) the same cargo gives **278.57 / 71.43**.
- The two-lot client on cn: one lot of 1 m³ at 100 kg/m³ and one of 1 m³ at 1100 kg/m³, together 600 kg/m³ → $600 (per-lot it would be $715). With B at 1 m³ priced $100 on a column where that is the price, the split is 300.00/50.00. The anchor uses a private column whose rows give exactly 300 and 100.
- Light: client C with 3 m³ and 1 kg gives d = 0, so the bill is HELD.
  - The ⚠ lists C's lots lightest first.
  - Changing C's lot to 300 kg re-splits the bill by itself.

---

## 2. The warehouse column (2c)

### 2.1 Table
The table is `warehouse_tariff_columns`, a SIDE table, created by 0132 (§10).
- 50 `db.query.warehouses` reads in 28 files plus 4 `select().from(warehouses)` take every column. A new column on `warehouses` would 42703 nearly every page one migration behind.
- Compose does wait for `migrate` (docker-compose.yml:71). Even so, a restored dump, a half-applied ledger, `up --no-deps` or #472's morning still put new code on an old schema.
- Shape: `warehouse_id` PK FK `warehouses` ON DELETE CASCADE (it is derived configuration of the warehouse), `tariff_zone text`, `updated_at`. A missing row means «—».
- Named `tariff_zone`, never bare `zone`. In warehouse code «zone» already means the TIME zone (`warehouses.timezone`, spend-date.ts:13).
- Zone validation is the tariff writer's own rule and nothing more: `tariff_zone <> '' AND tariff_zone = lower(btrim(tariff_zone))` (what `saveTariffBand`, dictionaries.ts:547, and `normaliseZone` produce; JS `trim()` strips a superset of `btrim`'s whitespace, so the equality holds for any value the writer made). There is **no length cap** (DS2): `saveTariffBand` has none and `calc_freight_tariffs.zone` is unbounded `text`, so a cap here would 23514 a legal 65-character zone into an error page. It is NOT the draft's regex for the same reason.

### 2.2 Module (placement vs platform↛wms)
New file `src/modules/wms/costing/tariff-column.ts`. It imports only `platform/db/client`, `platform/db/schema`, `platform/audit/service` (types) and `calc/tariff-read` (§9.1). It never imports `calc/dictionaries` or `calc/service`.

```ts
// costing/tariff-zone-field.ts — PURE, zero imports (the form's reader, unit-tested with literals)
export function normaliseZone(raw: string): string            // trim + lowercase
export function readTariffZoneField(fd: FormData): undefined | null | string   // §2.5

// costing/tariff-column.ts
export async function tariffColumnOf(warehouseId: string, handle: Db | Tx = db): Promise<string | null>
export async function mappableZones(stored: string | null): Promise<{ zone: string; priced: boolean }[]>
  // tariffZoneNames() (every zone in calc_freight_tariffs, any date) ∪ KNOWN_TARIFF_ZONES ∪ stored, sorted;
  // priced = in tariffZoneNames()
export async function setTariffColumnInTx(tx: Tx, warehouseId: string, zone: string | null): Promise<void>
  // null → DELETE; else validated against mappableZones (pre-read by the caller) → UPSERT
```
- Callers:
  - the warehouse admin actions and the [id] page, which are in `src/app` and may import wms;
  - costing's pre-tx save and re-basis reads.
- No platform module touches it.
- `tariffColumnOf` takes a handle only so that tx-pool's rule is satisfied if it is ever called in a tx. **The recompute never calls it** (fenced, §11).

### 2.3 Probe
New file `src/modules/wms/costing/freight-ready.ts`, `freightTablesReady()`. It is the `lotChecksReady` idiom (receipts/lot-check-ready.ts):
- a `to_regclass` check on BOTH 0132 tables, wrapped in try/catch;
- it caches TRUE only;
- it runs on the pool and is called ONLY pre-tx (render, action pre-flight). The tx-pool fence covers this.

### 2.4 The form
`/admin/warehouses/[id]` and `/new`, both under `admin.warehouses.manage`. That is the grant that edits warehouses today; it is seeded to super_admin/admin only.
- `warehouse-form.tsx` gains a `<select name="tariffZone" data-testid="wh-tariff-zone">` with:
  - first option `value=""` reading `warehouses.tariffZoneNone` («— tanlanmagan»);
  - then `mappableZones(stored)`. Each option is labelled with **the same words /admin/tarif prints**: `calc.zones.<z>` when `t.has` it, else the raw code (admin/tarif/page.tsx:58). One vocabulary for one code on both screens is a change from the draft's «Xitoy ustuni» words, which no bundle has. Here a person maps a warehouse onto the column he reads on /admin/tarif.
  - A zone with NO row in `calc_freight_tariffs` at all (a `KNOWN_TARIFF_ZONES` member such as `horgos` that nobody priced, or a stored zone whose rows are gone) gets the suffix `warehouses.tariffZoneUnpriced` «(narx yo‘q)» (SP-10). Mapping HOR onto it is allowed, and the suffix says why freight would still be refused. `mappableZones` returns `{ zone, priced: boolean }[]` for this; `priced` = the zone is in `tariffZoneNames()`.
- The stored zone is ALWAYS in the options, even when no tariff row has it any more. Otherwise `defaultValue` falls to «—» and an unrelated capacity edit silently clears the column (#171, #616-619).
  - Production reaches «stored but in neither set» only through a code change (a zone dropped from `KNOWN_TARIFF_ZONES`): `calc_freight_tariffs` has no delete door. It is still pinned behaviourally (§11, T8), because the [id] page passing the wrong stored value is the realistic way the same #171 silence happens.
- **The form holds its inputs on a refusal** (#463, SP-10). Today `warehouse-form.tsx` is uncontrolled under `useActionState`, so React's post-action reset already throws away every typed field on `code_exists`. `WarehouseFormState` gains `values?: WarehouseFormValues` (the parsed post echoed back on every refusal), and every input's `defaultValue` reads `state.values?.x ?? initial?.x`, with the form `key`ed on a counter the state bumps so the new defaults take. This covers the two new refusals and the old `code_exists`/`validation`.
- Hint under the select (`warehouses.tariffZoneHint`): «Shu skladdan chiqqan mashina xarajati tarifning qaysi ustuni nisbatida bo‘linadi. Bo‘sh qolsa, bu sklad mashinalarida «yo‘lkira tarifi bo‘yicha» usuli ishlamaydi.»
- The select is rendered only when `freightTablesReady()`. When it is not rendered, the field is ABSENT from the post.
- `WarehouseFormValues` gains `tariffZone: string | null`. The [id] page reads it with `tariffColumnOf(wh.id)`, inside the probe.
- The select stays optional. m0-smoke submits `main form button[type=submit]`.first(), and the select is inside that one form.

### 2.5 The actions (admin/warehouses/actions.ts)
- `parseForm` reads `tariffZone` through ONE pure reader, `readTariffZoneField(fd): undefined | null | string`, exported from `tariff-column.ts`'s pure sibling `costing/tariff-zone-field.ts` (zero imports; the `coordField`/`checkbox` idiom of this same actions file, T8). It keeps **«absent» separate from «''»**:
  - `!fd.has('tariffZone')` → `undefined` = «leave the mapping alone» (a stale page, or a server one migration behind);
  - `''` or whitespace only → `null` = delete;
  - otherwise `normaliseZone(...)` (`' CN '` → `'cn'`).
  - Unit-tested with those four literals (§11). The source fence keeps only what behaviour cannot reach.
- The zone is NOT in `warehouseSchema`'s spread to `toValues`. It is split out like `updatedAt` (#502), so `diffFields` never sees a key the warehouses row lacks, and drizzle's set never carries it.
- Update:
  1. pre-read on the pool: `before`, the duplicate-code check, `beforeZone = tariffColumnOf(id)` (inside the probe), and `zones = mappableZones(beforeZone)`;
  2. a posted zone (a string) not among `zones` → `{ error: 'zone_unknown', values }`;
  3. ONE `db.transaction`: `UPDATE warehouses`; if the field was present and changed, `setTariffColumnInTx`; `writeAudit(tx, …)` with the diff of `{...before, tariffZone: beforeZone}` vs `{...values, tariffZone: posted ?? beforeZone}`.
  - Today it is update → audit with no tx (actions.ts:130-139). This is the first time it is atomic.
  - `redirect()` stays OUTSIDE any try/catch (NEXT_REDIRECT).
  - A 42P01/42703 → `server_behind`, by `isServerBehind`.
- Create: insert, then mapping if non-empty, then audit, all in one tx. The `after` carries `tariffZone`.
- `WarehouseFormState.error` widens to `'validation' | 'code_exists' | 'zone_unknown' | 'server_behind'`. The form renders a literal map. The keys `warehouses.errZoneUnknown` and `warehouses.errServerBehind` go into all four bundles.
- New `warehouses.*` keys, all ×4: `tariffZoneLabel` «Yo‘lkira tarifi ustuni» (the select's own label, SP-10), `tariffZoneNone`, `tariffZoneHint`, `tariffZoneUnpriced`, `errZoneUnknown`, `errServerBehind`.
- `AUDIT_FIELD_LABELS.tariffZone` → `audit.fields.tariffZone` ×4. The history prints the stored CODE («cn → kashgar»), not the zone words: `AUDIT_FIELD_REFS` resolves uuids only, and the codes are short lowercase words. Stated (SP-10).
- The toggle-active action is untouched. **A deactivated origin keeps its column.** A truck's origin never changes: `origin_warehouse_id` is written only by the two INSERTs (planning/service.ts:350, batch-actions-server.ts:357), and reroute moves `dest_warehouse_id` only (reroute.ts:187). So an inactive warehouse's old trucks still read their column. The [id] page of an inactive warehouse is still reachable, so the column can still be edited there.
- **Renamed** warehouse: labels follow the name. The zone is the mapping's, and saved bills keep their copy.
- **Column edited later**: saved bills keep their copy (3a). New bills and re-bases read the new column. The re-basis preview names both the bill's frozen column and the one it would freeze now (§8).

---

## 3. Tariff day and the freeze (3a)

- The tariff day is the bill's `cost_date`.
- At save and at re-basis, the following are read **on the POOL, before any transaction** (#714):
  - the origin's column (`tariffColumnOf`);
  - `bandsAsOf(tariffHistory(), cost_date)` filtered to that zone. There is no earliest-row fallback.
- These are copied into `cost_entry_tariffs`, one row per freight bill:
  - `warehouse_id`: the origin the column came from;
  - `tariff_zone`;
  - `tariff_from`: the newest `effective_date` among the copied rows, used for the label «2026-01-01 tarifi»;
  - `light_below`: `FREIGHT_LIGHT_BELOW` at save;
  - `bands`: jsonb `[{min, max|null, price, perKg}]`.
- The copy is INSERTed inside `addCostEntry`'s existing short tx, after the truck `FOR SHARE` (service.ts:313) and the cost INSERT (service.ts:320), through `replaceFreightCopyInTx(tx, entryId, draft)` (§9.8). So the bill and its copy commit together or not at all.
- **freight-copy.ts is the table's only home** (T5/DS1). It holds the one reader and the one writer; no other file names `cost_entry_tariffs`/`costEntryTariffs` (fenced, §11):
  - `replaceFreightCopyInTx(tx, entryId, draft: FreightCopyDraft | null)`: DELETE the entry's row, then INSERT when `draft` is non-null (with the finite check). The create path and the re-basis door both call it.
  - `freightCopiesFor(entryIds: string[], handle = db): Promise<Map<string, FreightCopy | 'missing' | 'invalid'>>`: one `inArray` read (DS7). `freightCopyFor(id, h)` is a one-element call to it, so list renders read every copy on the page in ONE statement, never one per bill (#432).
  - **The basis ⇔ copy pairing** (a freight bill has exactly one row, any other bill none, after every writer) rests on those two functions plus the count assertion in §11. `cost_entry_tariffs.cost_entry_id` is the PK, so a freight→freight replace that skipped its DELETE fails loudly with 23505; the silent case (freight→weight leaving a stale row) is what the assertion pins.
- **Recompute, the void guard, the explanation and the breakdown read ONLY the copy**:
  - through their own handle;
  - only when `allocation_basis = 'freight'` (a fenced conditional, §11);
  - never `calc_freight_tariffs` and never `warehouse_tariff_columns`.
- That makes all of these no-ops for a saved bill: an /admin/tarif same-date overwrite (dictionaries.ts:567), a back-dated row, a moved floor (a new `zone|minDensity` key) and a warehouse column change.
- `freightCopiesFor` validates the copy on read: every number finite, price > 0, min ≥ 0, max null or ≥ min, perKg boolean, `light_below` an integer. Any failure gives `'invalid'`, so the bill is HELD with `copy_invalid`. The table's CHECKs admit NaN in jsonb. A copy row is read ONLY when the entry's basis is `'freight'`; a stray row on a non-freight bill is never read, so it can never feed a verdict or a token.
- The writer refuses non-finite bands before the INSERT (#777's NaN lesson).
- A bill dated before his first tariff row (`OWNER_TARIFF_FROM` 2026-01-01 on a seeded server) has no bands, so the save refuses `freight_zone_unpriced`, naming the date (§5). Stated.

---

## 4. Where it is offered and when it is preselected (4a)

- **Offered** on batch scope only. Concretely that is the CostPanel when `scope === 'batch'`: the truck's Xarajatlar tab (xarajatlar/page.tsx:122) and /kiritish (desk.tsx:122).
- **Not offered** on:
  - receipt, crate or pickup panels;
  - the per-prixod grid, which stays `'weight'` (service.ts:2371). Its freight-type column header gains a muted line, `costing.gridFreightHint`: «Tarif bo‘yicha bo‘lish — yuqoridagi «＋» formasidan». `GridCostType` gains `code`;
  - the receive wizard;
  - the crating fee.
- **Freight types**: a new setting `freight_tariff_cost_type_codes`, default `'["freight"]'` (the seeded «Дорога / Yo'lkira», scripts/seed.ts:157), parsed in a zero-import leaf `costing/freight-codes.ts`, the `customs-codes.ts` shape. It is read on the pool at render only, by `costPanelOptions`. Its description goes into all four bundles (settings tripwire).
  - It decides PRESELECTION only. The freight basis is allowed on any non-customs batch type: «boshqa turlar og‘irlik bo‘yicha qoladi» is the default, not a lock.
- **Customs types** (`calc_customs_cost_type_codes`, default `["customs"]` only) have the option HIDDEN, and the service refuses it (`freight_on_customs`, #531).
- **Basis state in CostPanel** (cost-panel.tsx:209-213 today): `basis` plus a new `basisTouched` flag.
  - `offeredBases(scope, typeFlags, offer, typeId)` lives in `costing/freight-split.ts` (pure; DS6 — every VALUE the `'use client'` panel imports has a named pure home, and the shared shapes live in a pure `costing/freight-types.ts` imported with `import type`, fenced §11):
    - non-batch: the five old ones;
    - batch: the five plus `'freight'` unless the chosen type is customs.
    - When `offer.status !== 'ready'`, or there is no usable version for the typed date, the freight `<option>` is `disabled`.
    - **The reason line (SP-5).** It is drawn under the select ONLY when the chosen type is in `typeFlags.freightTypeIds`, the one case where the untouched default would have been `'freight'` and the person needs to know why it is not. For any other non-customs type the disabled option carries a short fact in its own label, «(ustun yozilmagan)» / «(narx yo‘q)» / «(server yangilanmagan)», and no line. The line is a FACT, `costing.freightOffNoColumn`: «{warehouse} skladiga yo‘lkira tarifi ustuni yozilmagan — og‘irlik bo‘yicha bo‘linadi.» (and the other statuses' facts, `freightOffUnpriced`/`freightOffProblem`/`freightOffServerBehind`, each with the §5 params). The «Rahbariyat … tanlasin» ORDER stays only in the save-time refusal, where somebody actually asked for freight. A warehouse deliberately left without a column therefore costs a bill of another type nothing.
    - The «Skladni ochish →» / «Tarifni ochish →» links (§5) open with `target="_blank" rel="noopener"`, so /kiritish's in-memory `CostKept` (desk.tsx:47) survives, and the warehouse form's list redirect (actions.ts:139) does not matter.
    - **Usable version for a date.** The browser holds at most 20 versions (§7.2). A typed date older than the oldest held version is NOT «unpriced»: the panel treats it as «unknown — saqlang, server tekshiradi» (`costing.freightVersionUnknown`), keeps the option enabled when the offer is ready, and the server's `prepareFreightCopy` answers (E9). Only a date before the zone's FIRST effective date (which the offer carries as `firstFrom`) is «unpriced» in the browser.
  - Untouched default:
    - if the chosen type is a freight type AND the offer is ready AND the typed date has a usable version (from ≤ date and no problem) → `'freight'`;
    - else the scope default (`'weight'`).
  - On a type change or a date change while untouched → re-derive the default.
  - If touched and the current basis is no longer offered or enabled (freight → a customs type, or freight → a date with no usable version) → fall back to the scope default, set `basisTouched=false`, and print one line, `costing.freightDropped` {reason}.
  - **Kept basis on /kiritish** (`CostKept`, desk.tsx:122-130):
    - a kept basis other than `'freight'`/`'direct_to_client'` starts TOUCHED, exactly today's carry-over;
    - a kept `'freight'` starts UNTOUCHED, so the rule re-derives it for the new truck and type. A kept freight never follows onto a truck whose origin has no column.

---

## 5. Refusals at save — tariff CONFIGURATION only (each a sentence)

`CostError` gains params: `constructor(public readonly code: string, public readonly params?: Record<string, string | number>)`. It MOVES to a zero-import leaf `costing/errors.ts` and service.ts re-exports it, so no caller changes and freight-copy.ts never imports service.ts (DS5).

**Forwarding is structural, not remembered (T9):**
- ONE helper in costs/actions.ts, `costRefusal(err: CostError): CostActionResult` = `{ ok: false, error: err.code, ...(err.params ? { params: err.params } : {}) }`. Every `instanceof CostError` catch returns it: add (actions.ts:146), the grid (:218), void (:326), the merge door (:391) and the new rebase action. No catch writes `error: err.code` by hand (fenced §11).
- The panel helper takes the WHOLE result: `payerErrorText(res: { error?: string; params?: Record<string, string | number> }, t)`. A call site therefore cannot forget the params; the type carries them.

- The pure checker is `columnProblem(bands): null | {kind:'unpriced'} | {kind:'gap', from, to | null} | {kind:'overlap', at}`, in `costing/freight-split.ts`.
- It works on the whole-number sets a band covers, [ceil(min), floor(max)] or [ceil(min), ∞):
  - empty sets are dropped;
  - the rest are sorted by ceil(min);
  - the next set must start at the previous floor(max)+1 (else gap or overlap);
  - exactly one open set, and it must be last. A closed top gives `{gap, from: floor(maxTop)+1, to: null}`.
- **Nothing below the lowest floor is a gap**: [light_below, lowest floor) is clamped and (0, light_below) warns. This is the draft's `freight_tariff_gap`, re-aimed at his rule 6.
- It is O(n log n), with no integer scan, so a typed floor of 99,999,999 costs nothing.

| code | params | uz sentence (`costing.<key>`) |
|---|---|---|
| `freight_batch_only` | — | `errFreightBatchOnly`: «Yo‘lkira tarifi bo‘yicha bo‘lish faqat mashina (partiya) xarajatida bor.» |
| `freight_on_customs` | — | `errFreightOnCustoms`: «Rastamojka tarif bo‘yicha bo‘linmaydi — u deklaratsiya bo‘yicha hisoblanadi. Boshqa usulni tanlang.» |
| `freight_no_column` | `warehouse` | `errFreightNoColumn`: «{warehouse} skladiga yo‘lkira tarifi ustuni yozilmagan. Rahbariyat sklad sozlamasida ustunni tanlasin.» |
| `freight_zone_unpriced` | `warehouse`, `column`, `date` | `errFreightUnpriced`: «{warehouse} skladining ustuni — {column}. {date} sanasida bu ustunda narx yo‘q. Rahbariyat tarifga shu sanagacha narx yozsin.» |
| `freight_tariff_gap` | `column`, `from`, `to` | `errFreightGap`: «{column} ustunida {from}–{to} kg/kub uchun narx yo‘q. Rahbariyat tarifni to‘ldirsin.» |
| `freight_tariff_top` | `column`, `from` | `errFreightTop`: «{column} ustunida {from} kg/kub va undan og‘ir yuk uchun narx yo‘q (eng yuqori qator yopiq). Rahbariyat tarifni to‘ldirsin.» |
| `freight_tariff_overlap` | `column`, `at` | `errFreightOverlap`: «{column} ustunida {at} kg/kub ikki qatorga tushadi. Rahbariyat tarifni tuzatsin.» |
| `freight_changed` | `column`, `from` | `errFreightChanged`: «Ko‘rganingizdan keyin tarif yoki sklad ustuni o‘zgardi — endi {column}, {from} tarifi. Yangi bo‘linishni ko‘rib, qayta saqlang.» |
| `server_behind` | — | `errServerBehind`: «Server hali yangilanmagan — yo‘lkira tarifi bo‘yicha bo‘lish hozircha ishlamaydi. Boshqa usul bilan saqlang yoki keyinroq urinib ko‘ring.» |

**What the person saw is what is frozen (M6).** When the panel posts basis `'freight'` it also posts a hidden `freightSeen` = `copyDigest(draft)` of the version its preview used: sha256 hex over (warehouseId, zone, tariffFrom, the bands in canonical order, lightBelow). The digest is ONE function, `copyDigest(draft)` in freight-copy.ts (node `crypto`), run at render over each offered version (carried as `FreightVersion.digest`, §7.2, so the browser only echoes a string) and at save over `prepareFreightCopy`'s draft. If the server's draft digests differently (a remap, a same-date band overwrite, a back-dated row between render and save), the action refuses `freight_changed` naming the NEW column and tariff date, the panel keeps every typed input (it already does for the twin warning) and `router.refresh()` redraws the preview. An ABSENT `freightSeen` (a hand-built call, a test calling the service) is not checked: the service-level door stays `prepareFreightCopy`. Cargo boarding between render and save is NOT part of the digest and stays stated (§13).

Notes on the params:
- `{warehouse}` = «CODE — name».
- `{column}` = the zone's words, the same `calc.zones` / raw-code rule as §2.4. **The panel resolves it.** The server sends the CODE as `column`, and the panel maps it through `t.has` before formatting. The same resolution is used in §7.

The fix links are drawn by the panel, never by the server's text:
- `freight_no_column` gets «Skladni ochish →» to `/admin/warehouses/<id>` only when `offer.mayFixColumn` (`admin.warehouses.manage`);
- the gap/top/overlap/unpriced codes get «Tarifni ochish →» to `/admin/tarif` only when `offer.mayFixTariff` (`admin.dictionaries.manage`).
The two grants are separate on /admin/roles, so each link asks its own.

**Order** in `addCostEntryAction` (actions.ts:80-150):
1. door (unchanged);
2. `payerRefusal`;
3. **`prepareFreightCopy(parsed.data)`**, NEW, wrapped in try → `costRefusal`; then the `freightSeen` compare (`freight_changed`);
4. `twinsForCost`/`mustWarn`;
5. `addCostEntry`.

Nobody is asked «Baribir saqlash?» about a save that would then be refused. `addCostEntry` calls `prepareFreightCopy` AGAIN in its own pre-tx section: one home, and a hand-built call through any door is covered. The tariff is ~24 rows, so the double read is cheap.

**Lagging server.** The action's catch adds:
- `isServerBehind(err)` → `server_behind`;
- `violatedCheck(err) === 'cost_entries_basis_check'` → `server_behind`, by NAME (the 0125 `WIDENED_*_CHECKS` idiom, calc/basis.ts).
- `prepareFreightCopy` asks `freightTablesReady()` first and throws `server_behind` itself.
- The **re-basis action's catch carries the same three mappings** (DS1). A re-basis TO freight on a lagging db is stopped earlier by the probe inside `prepareFreightCopy`; a non-freight re-basis never touches the copy table (§8.2), so it works one migration behind. 0132 runs inside drizzle's one migration transaction, so the widened CHECK cannot exist without the tables; the 23514 and 42P01 mappings are belt-and-braces against a hand-built call, never an error page.
- **No 0132 CHECK is reachable on legal input** (DS2): every one of them restates a rule its writer enforces first (`normaliseZone`, `columnProblem`'s `unpriced`, the finite check, the constant). That is pinned by a test, not assumed (§11).

**Lot DATA never refuses the money.** The bill is written, the recompute runs after commit, and a HELD verdict comes back as `{ ok: true, unsplit }` (§6).

---

## 6. Fail closed, made visible

### 6.1 The verdict
`recomputeEntry` returns `Promise<RecomputeVerdict | null>` (service.ts:1039; today `void`):
```ts
export type FreightHeld =
  | { reason: 'cargo'; measureMissing: HeldLot[]; tooLight: HeldGroup[] }   // ≥1 list non-empty (E8):
      // measureMissing = every lot whose box measure fails; tooLight = every group under light_below,
      // lightest first. Both lists are collected over ALL groups and both are printed, measure first.
  | { reason: 'copy_missing' | 'copy_invalid' | 'on_customs' };
export type RecomputeVerdict =
  | { kind: 'split' }
  | { kind: 'nothing' }        // EMPTY base (any basis) / zero-weight base (old bases only) — money on no box
  | { kind: 'held'; held: FreightHeld }
  | { kind: 'unconverted' };
interface HeldGroup { key: string; label: string; m3: number; kg: number; density: number; lots: HeldLot[] }
interface HeldLot { lotId: string; receiptId: string; label: string; m3: number; kg: number; density: number }
```
- A HELD bill writes **no shares at all**: never weight 0, never a silent fallback. It is the existing DELETE-then-no-INSERT state (service.ts:1113).
- `on_customs` covers a type that becomes customs AFTER the bill was saved (he widens the setting). The base would switch to `declaredFilter`, so the freight bill fails closed until it is re-based.
- In this spec «held `too_light`» means `held.reason === 'cargo'` with `tooLight` non-empty, and «held `measure_missing`» means `measureMissing` non-empty.
- A NON-empty zero-weight freight group is `too_light` (the d = 0 anchor), never `nothing`: only an empty base short-circuits (§1.4 step 0).
- `addCostEntry` returns **the inserted row with the verdict attached**: `return Object.assign(entry, { verdict })`, typed `typeof entry & { verdict: RecomputeVerdict | null }` (DS4/E7). Every existing caller reads only row fields and is untouched: `addGridCell` (service.ts:2361), the ~33 test assignments (`const entry = await addCostEntry(…)` then `entry.id`, e.g. cost-kassa:67, m2-stock-ops:279/350/408/554, accounting, partners, money-doors, sarflar) and the helpers that RETURN its result (count-money:231, truck-riders:194, truck-riders-leg:183, the `cost()` helpers in direct-cost-client:151 and void-resplit:173, twins' `ReturnType<typeof addCostEntry>`). `addCostEntryAction` captures the result (today it discards it) and reads `.verdict`. A `{ entry, verdict }` wrapper would have turned ~25 test files red under `pnpm typecheck` and into `id === undefined` → UNDEFINED_VALUE under vitest alone (#661).
- `addCostEntryAction` returns `{ ok: true, unsplit?: UnsplitView }` when the verdict is HELD.

### 6.2 The words (`costing.*`, ×4)
- `freightHeldLight`: «⚠ Hisob saqlandi, lekin mashina yukiga bo‘linmadi: {group} yuki {m3} kub · {kg} kg → {density} kg/kub — 1 kub uchun 10 kg dan kam.»
  - It is followed by the group's lots, one per line, LIGHTEST first, each «{lot} · {density} kg/kub» and linked to `/receipts/<id>` (the receipt door is asked per link).
  - Then `freightHeldFix`: «Lot to‘g‘rilangach hisob o‘zi bo‘linadi.»
  - Several light groups: all are listed, capped at 5, then «+N».
  - The «10» in the sentence is `{limit}` from the copy's `light_below`, never a literal in the bundle.
- `freightHeldMeasure`: «⚠ Hisob saqlandi, lekin bo‘linmadi: {lot} lotining hajmi yoki og‘irligi yozilmagan. Lotni to‘g‘irlang.»
- `freightHeldCopy`: «⚠ Bu hisobning tarif nusxasi yo‘q yoki buzilgan — «Bo‘lish usuli» tugmasi bilan qayta bo‘ling.»
- `freightHeldCustoms`: «⚠ Bu xarajat turi endi rastamojka — tarif bo‘yicha bo‘linmaydi. «Bo‘lish usuli» tugmasi bilan boshqa usulni tanlang.»
- A `cargo` verdict with both lists prints `freightHeldMeasure` lines first, then `freightHeldLight`, then one `freightHeldFix` (E8).
- `freightLightLot` (non-blocking, M8): «ⓘ {lot} lotining o‘zi {density} kg/kub — 1 kub uchun {limit} kg dan kam. Guruh og‘irroq, shuning uchun hisob bo‘lindi; o‘lchamni tekshiring.» Printed in the preview and the fold for every lot under `light_below` inside a group that split. It holds nothing, is not counted by `noShareSql`, and is not a chip on the row.
- **The reason → key map is a literal** (SP-10): `const HELD_KEY: Record<'copy_missing' | 'copy_invalid' | 'on_customs', 'freightHeldCopy' | 'freightHeldCustoms'>` in freight-errors.ts (`copy_missing` and `copy_invalid` share one sentence). Never a template string (`freightHeld${…}`), which the i18n-keys fence cannot read (#163).
- **Every count sentence is ICU plural in ru** (`{n, plural, one {…} few {…} many {…} other {…}}`; uz/en/zh `other` only is enough where the bundle has no plural forms today, matched to how the bundle already writes counts). This covers `freightHeldMore` «+{n}», `costSigmaUnsplit`, `pricingUnsplit`, `pricingUnsplitCarried`, `balUnpricedFreightHeld` and the todo.
- **Every new key, by name** (all `costing.*` unless noted, ×4 locales; the i18n-keys fence reads literal `t('…')` calls, so each is called literally): `bases.freight`, `freightOffNoColumn`, `freightOffUnpriced`, `freightOffProblem`, `freightOffServerBehind`, `freightOptNoColumn`, `freightOptUnpriced`, `freightOptServerBehind` (the disabled option's own short label), `freightVersionUnknown`, `freightDropped`, `freightColumnLine` (§7.3), `freightPreviewHeld` «Saqlanadi, lekin bo‘linmaydi:», `freightRowLine1`, `freightRowLine2`, `freightRowLine2Money`, `freightRowPerKg`, `freightHeldLight`, `freightHeldLot`, `freightHeldMeasure`, `freightHeldCopy`, `freightHeldCustoms`, `freightHeldFix`, `freightHeldMore`, `freightLightLot`, `freightLabel`, `freightHow` «Qanday bo‘lindi?», `freightFromDims` «(o‘lchamdan)», `freightBandLine` (Narx tab), `costUnsplitChip`, `costSigmaUnsplit`, `gridFreightHint`, the §5 `err*` keys, the §8 `err*`/labels; `batchCard.todoUnsplit`; `pricing.unsplit`, `pricing.unsplitCarried`, `pricing.carriedIncomplete`; `profit.unsplitHeading`; `accounting.balUnpricedFreightHeld`; the §2.4 `warehouses.*` keys; `audit.fields.allocationBasis`/`tariffZone`/`tariffFrom`; `settings.descriptions.freight_tariff_cost_type_codes`.

### 6.3 Where the ⚠ shows
1. **Post-save note**, OUTSIDE the form like `TwinGapNote` (cost-panel.tsx:380), because the truck-tab form closes on success. The component is `FreightHeldNote`.
2. **The bill row**, persistent. `costEntriesFor` (service.ts:2024) gains `hasShare: EXISTS(SELECT 1 FROM cost_allocations …)`, an expression with no join to the new table. A converted freight row with `!hasShare` gets the ⚠ chip `cost-unsplit` and the reason from `explainFreightBills` (§7).
   - `CostEntryView` gains REQUIRED `freight: FreightRowView | null`, so the two batch mapping sites (xarajatlar/page.tsx:103, kiritish/page.tsx:70) and the three others (receipts :733, crates :136, zavod :244) all fail to compile until they say `null` or fill it.
3. **The Xarajatlar Σ line** (`batchCostSheet`, service.ts:2073, which sums ENTRIES) gains the suffix «· shundan {usd} bo‘linmagan» under whole sight. The two screens then disagree in words instead of silently.
4. **Truck card «Qolgan ishlar»**: a todo `batch-todo-unsplit`, to the xarajat tab. It is drawn behind `costDoor` (mayOpenBatchCosts), the door of what it links to.
   - The Todo shape renders `label` then a bold `count` (batch-card.tsx:152-158, :635-636), so the label is a NOUN PHRASE with no number in it, `batchCard.todoUnsplit` «Bo‘linmagan xarajat», and the count is the shape's own (SP-10). A `{n}` in the label would print the number twice.
   - **The count is under the reader's own sight** (SP-6): `unsplitCountFor(batchId, sight: CostSight)` with `sight` REQUIRED (#790: an optional sight fails open) = `noShareSql(ce) AND (sight.ownOnly IS NULL OR ce.entered_by = sight.ownOnly)`, with `sight = costSightFor(actor)`, the same sight `batchCostSheet` is given on that card. The VED (ownOnly) is told about his OWN held bills, which he can see and re-base on the tab, and never about a colleague's, which the tab would show him only as «🔒 N ta boshqa xarajat» (#420's dead end).
   - The warehouse operator who would fix the lot does not get it, because the Todo shape links only to tabs (batch-card.tsx:152) and the tab would bounce him. The xarajat readers see the lot names and links; the logist, who reads this card, holds `receipts.edit` unscoped and can fix the lot. Stated.
5. **Pricing page** (full sight only, as its other cost reads are, pricing/page.tsx:119):
   - **This truck's bills**: a line `pricing-unsplit` beside «kurs yo‘q» (:590): «⚠ {usd} xarajat bu mashina yukiga bo‘linmagan — Xarajatlar →». The link is asked by `mayOpenBatchCosts`.
   - **Bills on the cargo's OTHER legs** (SP-1). The page's cost is landed cost over the whole road (`landedAllocationsSql`): «shu reysgacha» is an earlier internal leg's allocations, «keyingi yo‘l» a later non-bearing leg's. A held bill on such a leg has no allocations, so its money silently leaves this page's tannarx, and the prevUsd/laterUsd lines just shrink or vanish (pricing/page.tsx:557-570, :663-667 print them only when > 0.009). New `carriedUnsplitBills(batchId)` in costing/service.ts, built on the fence's OWN CTEs (`carriageCtesSql`'s `rides` and `mx`), so the warning and the tannarx cannot disagree (#513):
     - over this truck's non-given members `m`, every OTHER truck `eb` the fence would read for those cartons: earlier legs `eb.departed_at <= m.at AND (m.prev_at IS NULL OR eb.departed_at > m.prev_at)`, later legs `m.upto IS NOT NULL AND eb.departed_at > m.at AND eb.departed_at <= m.upto` (the fence's two clauses, verbatim) — found through the boxes' `rides`, because a held bill has no allocation to join through;
     - joined to that truck's batch-scope bills that are `noShareSql(ce)` OR `ce.voided_at IS NULL AND ce.amount_usd IS NULL` (unconverted — the same pre-existing hole, closed in the same read);
     - returned per feeding truck: `{ batchId, code, leg: 'prev' | 'later', usd | null, clientIds }` (the clients = that truck's rides ∩ this truck's members, joined to `receipts.client_id`).
   - One `pricing-unsplit-carried` line per feeding truck, `pricing.unsplitCarried`: «⚠ {code} mashinasining {usd} xarajati yukka bo‘linmagan — {leg} tannarxda yo‘q» ({leg} = the page's own «shu reysgacha»/«keyingi yo‘l» words), linked only when `mayOpenBatchCosts` allows it for THAT truck.
   - In the per-client cell, when that client's cartons rode such a truck, print «{prevLegs}: ⚠ to‘liq emas» (or the laterLegs twin, `pricing.carriedIncomplete`) instead of hiding the line.
   - ~~`pricing-open-cargo` is suppressed for a later leg whose bill exists but is held.~~ REVERSED by the build's review: the sentence stays — the figure still grows (when that bill splits), and it is the only word about cartons that never rode that leg; the `pricing-unsplit-carried` line names the held bill itself.
6. **Attention row `unallocated`** (attention.ts:387-396), which links today to a tracked-only table (profit/page.tsx:59):
   - one truck → `/batches/<id>/xarajatlar`;
   - several → `/accounting/profit?view=batch&bolinmagan=1&from&to`. The profit page's batch view, with `bolinmagan=1`, lists EVERY trip with `unallocatedUsd > 0.009`, tracked or not, under a heading `profit.unsplitHeading`.
7. **The Balans** (M1). A held bill has no allocations, so it leaves the U03 line «narxi hali yozilmagan yukka sarflangan» (`w_alloc`, reports.ts:2006) and lands in `w_nobox` (reports.ts:2116), whose sentence `balUnpricedNoBox` says the money belongs to a «found-back truck cell» and tells the reader to VOID it. For a held freight bill both halves are false, and the cure reverses the kassa or firm money — exactly what §6.7 refuses to tell finance to do.
   - `unpricedCargoMoney`'s `w_cost` carries `cost_entries.allocation_basis` (the column exists today, so no 42703 one migration behind and no join to a new table). `w_nobox`'s non-pickup part splits into `freight_n`/`freight_usd` (basis `'freight'`, the only basis that can HOLD) and `other_n`/`other_usd` (everything else, unchanged).
   - `UnpricedCargoMoney` gains `freightUnsplit: LeftOut`, passed through `companyBalance` beside `noBox`.
   - Its sentence follows `balUnpricedPickup`'s honest shape and gives NO void advice, `accounting.balUnpricedFreightHeld`: «{count} ta yo‘lkira xarajati (${usd}) tarif bo‘yicha mashina yukiga bo‘linmagan — lot to‘g‘rilangach yoki «Bo‘lish usuli» bilan qo‘shiladi, shungacha Sof holatni kamaytirib turadi; bekor qilmang.» Under the page's existing sight it links to the attention row's destination (one truck → its xarajat tab, several → profit `bolinmagan=1`), asked by `mayOpenBatchCosts`.
   - The figure is the WHOLE held bill, an upper bound: `w_nobox` cannot know which share would have sat on unpriced cartons, so a held bill on fully priced cargo is listed too. A freight bill whose base is truly empty (`nothing`) lands here as well, and the words are true of it. Both stated.
   - `balUnpricedNoBox` keeps its void advice for every other basis.

### 6.4 One fragment
`noShareSql(ce: SQL)` lives in costing/service.ts: `ce.voided_at IS NULL AND ce.amount_usd IS NOT NULL AND NOT EXISTS (SELECT 1 FROM cost_allocations ca WHERE ca.cost_entry_id = ce.id)`. It is used by:
- `profitByBatch.unallocatedUsd` (reports.ts:1327);
- the nightly `orphaned` net's first clause (service.ts:1213);
- the pricing ⚠, `carriedUnsplitBills`, the Σ suffix, and the todo count through `unsplitCountFor(batchId, sight)` (the fragment AND the sight clause, one function, §6.3.4).

The Balans split (§6.3.7) keys on `allocation_basis = 'freight'` inside `w_nobox`, which already has the no-allocation clause; it does not need the fragment.

`clientProfitGaps` (reports.ts:1600) keeps its own «amount − Σ allocated > 0.005». That is a different question (money not reaching a client), and a comment names the difference.

### 6.5 What heals it
- Every door that changes a lot already re-splits every cost touching the lot (`costEntriesTouchingLots`, void-guard.ts:20): `editLot` (edit.ts:455), growth, the claim, voids and the rider doors.
- **`editLot`'s gate is WIDENED (T3).** Today it re-splits only when the ROUNDED stored totals move or labels print/destroy (edit.ts:457-459). That was right while every basis read totals ÷ box_count. Freight reads a uniform lot's box dims directly (§1.3), and `computeLotTotals` stores round4(L·W·H·n/1e6), so a dims correction worth less than ~50/n cm³ per box leaves `total_volume_m3` unchanged while freight's cm³ moves (n = 1: 10×10×10 → 9×11×10 stores 0.0010 both times; 1000 → 990 cm³). It can even flip rule 6 with totals unchanged (one 0.020 kg box, 22×12×8 → 21×10×10: stored 0.020 / 0.0021 both times, density 9 → 10, held → split). The nightly net looks only for no-share bills, so a stale complete split would never heal.
  - The condition becomes `result.labelsToPrint > 0 || result.labelsToDestroy.length > 0 || totalsChanged || measureChange`, using the `measureChange` editLot already computes (edit.ts:221-228: the uniform lot's four dims + box weight, the mixed lot's totals). That also covers a legacy uniform lot whose NULL dims are being filled in, which flips `stableMeasure` from totals to dims. `dims_mode` is not editable here, so it needs no term.
  - §6.5's claim is now «every lot door re-splits on any MEASURE change», and a source fence pins `measureChange` in the gate (§11).
- The nightly `orphaned` net (cost-recompute.ts:52) retries any no-share bill. It is idempotent and cheap.

### 6.6 What does NOT change
The internal-leg «xarajat yozilmagan» (client-cargo.ts:337, pricing-internal-no-costs) stays an EXISTENCE check. The bill IS written, and the ⚠ surfaces above name the split. This is a change from the draft, which would have printed «not written» about a written bill.

### 6.7 The void guard (answer 6's consequence)
`costOrphanedByVoid` (void-guard.ts:153) asks «did it split before, does it split after». Under answer 6, a void that drops one group below 10 kg/m³ would turn into a warehouse refusal (`shared_cost_orphaned`) with words telling finance to void the truck's money, while the cargo is still there.

Rule:
- The guard judges by **`homed(v) = v.kind !== 'nothing'`**. A HELD freight bill is homed: the bill is named by §6.3.
- So a void that makes a freight bill HELD is ALLOWED and the ⚠ appears.
- A void that leaves NO cargo (`nothing`) is refused exactly as today.
- **This depends on the ORDER inside `costPool` (M3/E1, §9.6):** emptiness is judged before the copy, the customs flag or any group. Otherwise a freight bill whose type was later added to `calc_customs_cost_type_codes` (base = `declaredFilter`, judged `on_customs`) would answer «held, homed» about an EMPTY base after its last declared carton is voided, and the guard would let the money stay on an empty truck — the very U20 the guard exists to refuse. The same order makes `recomputeEntry` and the bill-row ⚠ say «no cargo» (not «re-base it») about a bill with no cargo.
- Weight/volume/… keep today's verdicts: `nothing` ≡ allocateEntry returned [].
- Pinned both ways (§11), including an `on_customs` bill losing its last carton → `shared_cost_orphaned`.

---

## 7. Explanation and preview, by sight

### 7.1 Money sight
`freightMoneySight(perms) = pricingSight(perms, false) === 'full'` (finance/pricing-view.ts:21: `finance.manage && !moneyHidden('results')`). It is ONE predicate, in `costing/freight-offer.ts`, used by:
- the preview;
- the explanation;
- the re-basis preview.

`internal` cannot change a 'full' answer, so passing false is exact. It is NOT `seesCompanyMoney`: /kiritish's door admits `clients.manage` holders without `finance.manage` (finance/scope.ts:280). Pinned.

- **full**: per group, the share of the typed amount in the typed currency, and the list rate $/kub.
- **everyone else**, the VED included (#791): band and % only.

### 7.2 The offer — `freightOffer(actor, batchId)`
`freightOffer` lives in `costing/freight-offer.ts` and is called by `costPanelOptions` (cost-entry.ts:157) only when `mayEnter` and `scope=batch`. Its result goes into the panel as REQUIRED prop `freight: FreightOffer | null`. Receipt/crate/pickup sites pass `null`. The /kiritish object literal (kiritish/page.tsx:68) and desk `PanelProps` fail to compile until they are filled: a free fence.
```ts
export type FreightOffer =
  | { status: 'server_behind' }
  | { status: 'no_column'; warehouse: WhLabel; mayFixColumn: boolean; typeFlags: TypeFlags }
  | { status: 'ready'; warehouse: WhLabel; zone: string; money: boolean;
      mayFixColumn: boolean; mayFixTariff: boolean; typeFlags: TypeFlags;
      firstFrom: string;                         // the zone's FIRST effective date (E9)
      versions: FreightVersion[] };              // newest first, at most 20
type TypeFlags = { freightTypeIds: string[]; customsTypeIds: string[] };
type FreightVersion = { from: string; digest: string;     // copyDigest of this version's draft (M6)
                        problem: ColumnProblem | null; split: SplitView | null };
type SplitView = { kind: 'split'; groups: GroupView[] } | { kind: 'held'; held: FreightHeld } | { kind: 'nothing' };
type GroupView = { key: string; label: string; m3: number; density: number;
                   band: { min: number; max: number | null; perKg: boolean };
                   share: number;                 // unrounded 0..1
                   ratePerM3?: number };          // only when money
```
How it is built:
- Everything is read on the POOL; it is a render.
- The tables are probed first: when they are missing the status is `server_behind`, and the option is disabled with that sentence. It never throws, so neither page white-screens one migration behind.
- Then: origin (code, name) + `tariffColumnOf`; `tariffHistory()`; the zone's distinct effective dates (cap 20, plus `firstFrom`); per date, ONE pure constructor `copyDraft(zone, bandsAsOf(history, date), FREIGHT_LIGHT_BELOW, warehouseId)` (freight-split.ts, E9) — the same constructor `prepareFreightCopy` uses, so dedupe, the finite check and `columnProblem` cannot differ between the preview and the save (#513); and, when there is no problem, **`costPool`** with that draft as the copy over `truckRiderBoxIds(batchId)` + `boxMeasures` (the measures read ONCE per render, not once per version).
- That is the SAME pure path as the recompute, never `batchLots` (lots.ts:181 rounds to 0.1 kg / 0.001 m³), and never a second call shape of `splitFreight`.
- **The types' home** (DS6): `FreightOffer`, `FreightVersion`, `SplitView`, `GroupView`, `FreightHeld`, `HeldGroup`, `HeldLot`, `RecomputeVerdict`, `UnsplitView`, `FreightRowView` and `RebasePreview` are declared in the pure `costing/freight-types.ts` and re-exported from where they are produced. The `'use client'` CostPanel imports them with `import type` only, and its VALUE imports (`ALLOCATION_BASES`, `offeredBases`, `splitCents`, `bandText`, `FREIGHT_ERROR_PARAMS`, `HELD_KEY`) come only from engine.ts, freight-split.ts and freight-errors.ts. A value import from service.ts / freight-offer.ts / freight-copy.ts would pull postgres into the client bundle (#276); fenced (§11).

### 7.3 Browser
- The panel picks the newest version with `from ≤ typed cost_date`:
  - none → the `freight_zone_unpriced` sentence before save;
  - a problem → its sentence;
  - held → «Saqlanadi, lekin bo‘linmaydi:» + the §6.2 lines;
  - split → rows.
- **Above the rows, the column it splits by** (SP-9), `costing.freightColumnLine`: «{warehouseCode} ustuni: {column} · {tariffFrom} tarifi». 2c's known cost (a KA truck carrying Yiwu cargo on the kashgar column) is exactly what the accountant should read BEFORE saving, not only on the saved row.
- Each row is two lines at 360 px (each line `min-w-0 break-words`, the row `w-full`):
  - line 1: «{label} · {m3} kub · {density} kg/kub»;
  - line 2: `bandText(band, …)` + «· {pct} %», plus «· {amount} {currency}» under money.
- **One band formatter** (SP-8): `bandText(band: { min, max, perKg, price }, { money: boolean })` in freight-split.ts, pure, used by the preview, the fold, the Narx band line and the re-basis preview, so the four can never word one band two ways (#513). A closed band prints «501–700 qatori» (money: «501–700 · $300/kub»); a per-kg band «1000+ qatori (kg bo‘yicha)» (money: «1000+ · $0.55/kg») — never a «$605/kub» that /admin/tarif nowhere prints (admin/tarif/page.tsx:56-62 shows `$0.55 / kg`). Pinned with both literals.
- Under a split, every lot under `light_below` inside a group that split gets its `freightLightLot` info line beneath its group's row (M8).
- Amounts are `splitCents(parseTypedMoney(amount), shares)` (pure, freight-split.ts): the largest remainder in cents, so the column adds up to the bill. Pinned with 350 → sums to 350.00.
- Non-blocking. The twin warning stays the only blocking confirm.
- testids: `freight-preview`, `freight-row-<key>`, `freight-held`.

### 7.4 After save — `explainFreightBills(entries, actor)`
- It runs only for the given entries with basis `'freight'`. On a lagging db none can exist, because the old CHECK refuses the value.
- It explains EACH bill over ITS OWN truck (`truckRiderBoxIds(entry.batchId)`) and its own frozen copy, never over the page's truck. That is what makes it safe for the Narx tab (E6, below).
- Cost is bounded (DS7): ONE `freightCopiesFor(ids)` read for every listed bill, and the base + `boxMeasures` read ONCE per distinct `batchId` (every freight bill on a truck shares `truckRiderBoxIds(batchId)`), then `costPool` per bill in memory. A truck tab with three freight bills is three statements, not nine.
- The $ printed always comes from `cost_allocations`, never from the re-run. If a recompute lags, the band line can be one event stale. Stated.
- **Cents add up (M7).** Each client's allocation sum is 4-decimal; rounded independently, a $100.00 bill over three equal groups (33.3334 / 33.3333 / 33.3333) prints 33.33 ×3 = 99.99 under a header reading $100.00, while the preview (`splitCents`) adds up. The fold and the freight band lines round the per-group allocation sums to the BILL's cents with the largest remainder, `roundPreservingTotal` (staff/stamp-split.ts:208, the stamp reader's idiom). Pinned with the three-way $100 literal.
- **Bill row label** (replaces `{date} · {basis}` for freight, cost-panel.tsx:329): «{date} · yo‘lkira tarifi bo‘yicha · {warehouseCode} ustuni: {column} · {tariffFrom} tarifi» (`costing.freightLabel`).
- **Fold** `<details data-testid="cost-freight-how">` «Qanday bo‘lindi?» on the row: the groups, two-line rows as in §7.3, with $ from allocations under money and % otherwise.
- **Narx tab** (full only): `batchClientCostBreakdown` (service.ts:2408) adds `CASE WHEN ce.allocation_basis = 'freight' THEN ce.id END AS freight_entry_id` to its select and GROUP BY (service.ts:2422). A freight part then prints «{source} · {typeName} · tarif {bandText} · ${usd}» (`costing.freightBandLine`; `{source}` is the part's own `eb.code`, the truck that billed it) from the explain map keyed (entryId, clientId), with a link to the xarajat tab of THAT truck, asked by `mayOpenBatchCosts`.
  - **The map is built from the breakdown's OWN distinct non-null `freight_entry_id`s, not from this truck's entry list (E6).** The breakdown reads `landedAllocationsSql`, so it carries «shu reysgacha» parts (an earlier internal leg — the agreed YW→KA method, with YW → cn the suggested first mapping, so that leg's yo'lkira bill preselects freight) and «keyingi yo'l» parts, both OTHER trucks' entries. The page pool-reads those entry rows and hands them to `explainFreightBills`, which explains each on its own truck and copy, so the line reads «YW-001 · Yo‘lkira · tarif 501–700 · $…» with YW's band.
  - **A missing (entryId, clientId) key never throws**: it prints today's plain line «{source} · {typeName} · ${usd}». Causes: a held bill, a recompute lag, a bill on a truck the reader may not open. The $ is still the allocations'.
  - Cost: one `costPool` per distinct freight bill on the page, on the pool, never in a tx.
  - Two freight bills on one truck stay two lines.
  - Non-freight parts group exactly as today (NULL key).
- Unclaimed groups appear per prixod in the preview and the fold. The pricing page keeps ONE unclaimed bucket (pricing-view.ts:184). Stated.

---

## 8. The re-basis door (5a)

**Where**: truck bills only — **batch-SCOPE rows** of the truck Xarajatlar tab and the /kiritish panel (E2). `costEntriesFor({batchId})` also returns the per-prixod grid's receipt-scope cells stamped with the truck (service.ts:2002, `eq(costEntries.batchId, …)`), and those get NO button: `CostEntryView` gains REQUIRED `rebasable: boolean`, set to `entry.scope === 'batch'` at the two batch mapping sites (xarajatlar/page.tsx:103, kiritish/page.tsx:70) and `false` at the three others. The button `cost-rebase` «Bo‘lish usuli ✎» is drawn when `rebasable && canAdd` (= `mayEnterBatchCost`). Receipt/crate/pickup bills and the grid's cells get none, because freight cannot exist there and the grid stays weight (§4).

**UI (SP-9).** The re-basis block and the «Qanday bo‘lindi?» fold are `w-full` (basis-full) children BELOW the row's chips; the row stays `flex flex-wrap` (cost-panel.tsx:315) and nothing is squeezed beside the 🗑.
- ✎ opens a select `cost-rebase-basis` over `offeredBases('batch', typeFlags, offer, entry.costTypeId)` for THIS bill's type, minus `direct_to_client` (freight disabled with the §4 fact when not offered), then «Ko‘rish» → the preview `cost-rebase-preview` → «Shu usulda saqlash» `cost-rebase-save`.
- Measured at 360×800 with the longest zone words and a ≥40-character unclaimed marking (§11).

**Action**: `rebaseCostAction({ entryId, basis, seen? })` in costs/actions.ts, so it is inside the refusal fence's file set. The service is `costing/rebase.ts`:

1. **Door**:
   - pool-read the entry (`already_voided` / `not_found`) and its truck;
   - `entry.scope !== 'batch'` → `rebase_batch_only` (E2; scope has no edit door, so the pool check is enough and is not repeated under the lock);
   - `authorize('costs.enter_batch', { warehouseId: origin })`;
   - `mayEnterBatchCost` → `cancelled`;
   - `costSightFor(actor).ownOnly` and not the enterer → `cost_not_yours` (the void's rule).
   - A merged, kassa-paid or firm-paid bill is ALLOWED: none of its money moves. Stated and pinned.
2. **Targets**: `ALLOCATION_BASES` minus `direct_to_client` (`rebase_direct`).
   - Leaving `direct_to_client` clears `client_id`.
   - `freight` runs `prepareFreightCopy` **built from the entry ROW itself** (its own scope, batchId and `cost_date`) and the origin's CURRENT column; all §5 refusals apply, and `freight_batch_only` stays the belt.
   - Same basis and, for freight, the same copy digest (`copyDigest`) → `rebase_same`. This compares basis and copy only; that is why the save DELETEs the shares in its own tx (step 4), or a failed recompute could never be retried through this door.
   - **The copy is touched only when freight is on either side (DS1).** `freightCopyFor` is read for the from-part only when `fromBasis === 'freight'` (else the literal `'none'`), and `replaceFreightCopyInTx` is called only when `fromBasis === 'freight' || toBasis === 'freight'`. A weight→volume or boxes→weight re-basis touches only `cost_entries` and `cost_allocations`, so it works on a database one migration behind (no 42P01). The from side needs no probe (a freight bill can exist only after 0132); the to side is probed inside `prepareFreightCopy`. Both conditionals are pinned verbatim (§11).
3. **Preview** (no `seen`), or **refusal with a fresh preview** (a `seen` that is present but stale, T4):
   - BEFORE = the bill's current allocations grouped by client key (client, or `r:` + receipt for unclaimed);
   - AFTER = `costPool` over the current base on the pool.
   - Rows: «{label} · {beforePct} % → {afterPct} %», with «${before} → ${after}» under `freightMoneySight` (both columns rounded to the bill's cents with `roundPreservingTotal`, M7). Band words through `bandText`.
   - An unconverted bill shows % only and «kurs yo‘q — hali bo‘linmagan».
   - For freight it also prints «Ustun: {column} ({warehouse}) · {tariffFrom} tarifi». When the bill is already freight and its frozen column differs: «hozir: {oldColumn} → yangi: {newColumn}».
   - A HELD after-state is shown with the §6.2 lines and is allowed: the person sees it before saving.
   - `seen` = sha256 hex of (entryId, fromBasis, fromCopy digest | 'none', toBasis, toCopy digest | 'none', sorted after-pcts to 0.01). This is the twin idiom (twins.ts:1058, read from the RAW input as `/^[0-9a-f]{64}$/`).
   - No `seen` → `{ ok: false, rebase: RebasePreview }`. A present but stale `seen` (a remap, a band overwrite, a carton boarding) → `{ ok: false, error: 'rebase_changed', rebase: <fresh preview> }`, so the `errRebaseChanged` words («… yuk, tarif yoki sklad ustuni …») are what the person reads, with the new column already in the preview.
4. **Save** (seen matches the recomputed token):
   - ONE tx: `SELECT … FROM cost_entries WHERE id = $1 FOR UPDATE`, entry first, the recompute's lock order;
   - **`voided_at IS NOT NULL` under the lock → `already_voided`** (E2), BEFORE the token compare: a void that committed between preview and save writes no UPDATE, no copy and no `update` audit on a voided cost (`recomputeEntry` guards the same race, «a void that committed first wins»);
   - re-read the basis and (for a freight from-side only) the copy on tx and compare with the token's from-part. A mismatch (a concurrent re-basis) → `rebase_changed` with a fresh preview;
   - **`DELETE FROM cost_allocations WHERE cost_entry_id = $1`** (E3), before the basis UPDATE: if the post-commit recompute then fails, the bill reads as no-share, which `noShareSql`, the nightly `orphaned` net and every ⚠ surface already name, instead of keeping the OLD basis's shares under the new label (a stale complete split matches none of the net's five clauses, service.ts:1213-1229, and `rebase_same` would then refuse the retry);
   - `UPDATE cost_entries SET allocation_basis = $2[, client_id = NULL]` (no `.returning()` naming every column);
   - `replaceFreightCopyInTx(tx, id, draft | null)` when freight is on either side (step 2); rebase.ts never names the table;
   - `writeAudit(tx, { entityType: 'cost_entry', action: 'update', before: { allocationBasis, tariffZone?, tariffFrom? }, after: {…} })`.
   - After commit: `recomputeEntry`, whose verdict is returned (a held note if any). It is wrapped in the edit.ts:466-482 idiom: on error, log `[cost-rebase]` and `enqueue(JOB_RECOMPUTE_COSTS, { costEntryId })` (the worker already takes `{ costEntryId }`), with an inner catch whose comment names the nightly `orphaned` net as the last net. The action then returns `{ ok: true, pending: true }`, never an error: the basis change has committed.
   - Revalidates `/batches/<id>`, `/batches/<id>/xarajatlar`, `/batches/<id>/pricing`, `/accounting/sarflar/kiritish`.
   - The action's catch is `costRefusal` + the §5 lagging-server mappings (`isServerBehind`, `violatedCheck(err) === 'cost_entries_basis_check'` → `server_behind`), pinned in freight-wire.test.ts.
5. It **never touches** amount, currency, amount_usd, fx_rate_used, partner_id, account_*, the merge or the partner charge. That is why it exists: a void refuses merged costs, needs finance for kassa-paid ones, re-posts firm debt and re-converts dollars (service.ts:706-812, 150-208).
6. Words (`costing.*`, ×4):
   - `errRebaseChanged`: «Ko‘rganingizdan keyin nimadir o‘zgardi (yuk, tarif yoki sklad ustuni). Yangi hisobni ko‘rib, qayta saqlang.»
   - `errRebaseSame`: «Bu hisob allaqachon shu usul va shu tarif bilan bo‘lingan.»
   - `errRebaseDirect`: ««To‘g‘ridan-to‘g‘ri klientga» usuliga bu tugma bilan o‘tib bo‘lmaydi — hisobni bekor qilib qayta kiriting.»
   - `errRebaseBatchOnly`: «Bu katak prixod jadvalidan — usulini prixod jadvalida emas, mashina xarajatida tanlang.»
   - `rebasePending`: «Usul saqlandi; bo‘linish navbatga qo‘yildi — bir daqiqada yangilanadi.»
   - Labels: `rebaseButton`, `rebasePreviewTitle` «Kimga qancha tushadi: hozir → yangi», `rebaseShow` «Ko‘rish», `rebaseSave` «Shu usulda saqlash», `rebaseUnconverted` «kurs yo‘q — hali bo‘linmagan», `rebaseColumn`, `rebaseColumnMoved`.
7. The **create audit** also gains `allocationBasis` (and `tariffZone`, `tariffFrom` for freight). Today it records neither (service.ts:346). `AUDIT_FIELD_LABELS` gains `allocationBasis`, `tariffZone` and `tariffFrom` (`audit.fields.*` ×4).
8. **The button is the per-bill convenience; the ROLLBACK is a script** (DS3). If the reason for going below 0132 is this release's own cost UI, a button inside that UI is no tool at all, and nothing lists the live freight bills. `scripts/freight-to-weight.ts` (`pnpm freight-to-weight`): dry run by default, printing every live freight bill (truck code, cost type, amount, current shares); with `--apply` it re-bases each to `'weight'` through the SAVE half of `costing/rebase.ts` (not the preview/seen half): the same entry `FOR UPDATE`, the shares DELETE, `replaceFreightCopyInTx(tx, id, null)`, an audit row with actor null and `reason: 'rollback'`, and the post-commit `recomputeEntry`. Run as `docker compose run --rm migrate pnpm freight-to-weight [--apply]` (one-off scripts go through `migrate`, round 84), so it needs neither the app container nor CostPanel. The procedure is §10.

---

## 9. Engine and wiring — files, functions, signatures

### 9.1 Calc leaf moves (no behaviour change)
- `bandsAsOf` moves to `calc/pricing.ts`, which is pure, zero imports (pricing.ts:1).
- `tariffFor`, `tariffHistory` and the new `tariffZoneNames()` move to a NEW leaf `calc/tariff-read.ts`, which imports only `platform/db/client`, `platform/db/schema`, `drizzle-orm` and `./pricing` (types). It does NOT import `CalcError` or `../tnved/service`. Those two edges (dictionaries.ts:5-6) are what reach `costing/service` through `calc/service → crm → platform/clients → client-cabinet → finance → costing`.
- `calc/dictionaries.ts` re-exports all three, so `calc/actuals.ts:42` and the other importers are untouched.

### 9.2 Engine (`costing/engine.ts`)
```ts
export const ALLOCATION_BASES = ['weight','volume','chargeable','boxes','direct_to_client','freight'] as const;
export type AllocationBasis = (typeof ALLOCATION_BASES)[number];
export interface AllocBox { …; freightWeight: number }   // REQUIRED
function weightOf(box, basis) { switch (basis) {
  case 'weight': …; case 'volume': …; case 'chargeable': …;
  case 'boxes': case 'direct_to_client': return 1;
  case 'freight': return box.freightWeight;
  default: { const never: never = basis; throw new Error(`basis ${String(never)}`); } } }
```
- In `allocateEntry`, for `'freight'`: any weight non-finite or ≤ 0 → `[]`. This is a belt; `costPool` HOLDs before it gets there.
- The `tests/unit/cost-allocation.test.ts` `box()` helper gains `freightWeight: 0`. `pnpm typecheck` types tests.

### 9.3 One vocabulary
- `costEntrySchema.allocationBasis = z.enum(ALLOCATION_BASES)` (service.ts:124) means no copy.
- CostPanel's `BASES` (cost-panel.tsx:64) is deleted. The panel imports `ALLOCATION_BASES`/`AllocationBasis` from engine.ts, which is pure, so a client component may import it. `CostKept.basis: AllocationBasis`.
- The remaining copies are the schema CHECK (wms.ts:736-739, now including `'freight'`) and 0132's CHECK. They are pinned by the fence (§11).
- `costing.bases.freight` ×4: «yo‘lkira tarifi bo‘yicha» / «по тарифу дороги» / «按运费价目表» / «by the freight tariff».

### 9.4 Measures — `boxMeasures(ids, handle: Db | Tx = db)` (replaces boxDims, service.ts:832)
- It is one read, ordered by box id. It selects boxId, clientId, clientCode, receiptId, receiptNumber, unclaimedMarking, lotId, lotSeq, productNameRu/Zh, dimsMode, the four box dims (strings for the numerics), boxCount and both totals (strings).
- It returns today's `weightKg`/`volumeM3` (totals ÷ box_count, UNCHANGED for the old bases) plus the raw lot fields.
- `boxDims` is deleted. Its two callers move to `loadPoolInputs`.
- The label columns (client code, receipt number, marking, names) come through LEFT JOINs only: an inner join on `clients` would drop every unclaimed carton from every basis's base, which `truck-riders.integration.test.ts:816-882` (an unclaimed lot `lu` on a weight bill) already turns red.

### 9.5 Pure split — `costing/freight-split.ts` (imports only `../calc/pricing`)
```ts
export const FREIGHT_LIGHT_BELOW = 10;
export interface FreightCopy { zone: string; tariffFrom: string; lightBelow: number; warehouseId: string;
                               bands: FreightBand[] }            // zone stamped on each band for bandFor
export function stableMeasure(m: BoxMeasure): { grams: Frac; cm3: Frac } | null   // §1.3
export function freightGroups(measures: BoxMeasure[]): FreightGroupIn[]           // §1.2, BigInt sums
export function wholeDensity(grams: Frac, cm3: Frac): number | null              // roundHalfUp, exact
export function splitFreight(groups: FreightGroupIn[], copy: FreightCopy):
  { ok: true; groups: PricedGroup[]; weights: Map<boxId, number> } | { ok: false; held: FreightHeld }
  // PricedGroup carries `lightLots: HeldLot[]` — lots under lightBelow inside a group that split (M8)
  // held = { reason:'cargo', measureMissing, tooLight } collected over ALL groups (E8)
export function copyDraft(zone: string, bands: TariffRow[], lightBelow: number, warehouseId: string):
  { ok: true; draft: FreightCopyDraft } | { ok: false; problem: ColumnProblem | { kind: 'not_finite' } }
  // the ONE constructor: dedupe on zone|minDensity, the finite check, columnProblem (E9).
  // prepareFreightCopy and freightOffer both call it.
export function columnProblem(bands: FreightBand[]): ColumnProblem | null        // §5
export function splitCents(amount: number, shares: number[]): number[]           // preview cents
export function bandText(band: FreightBand, opts: { money: boolean }): BandText  // §7.3, SP-8
export function offeredBases(scope: CostScope, flags: TypeFlags, offer: FreightOffer | null,
                             typeId: string | null): AllocationBasis[]           // §4, DS6
```
- `freight-split.ts` imports only `../calc/pricing` and `./engine` (both pure) and `import type` from `./freight-types`.

### 9.6 One pool — `costing/pool.ts` (pure; imports engine + freight-split)
```ts
export type PoolVerdict =
  | { kind: 'split'; shares: AllocShare[]; groups?: PricedGroup[] }   // groups: freight only (preview/fold read them)
  | { kind: 'nothing' } | { kind: 'held'; held: FreightHeld };
export function costPool(
  entry: { allocationBasis: AllocationBasis; clientId: string | null; amountUsd: number },
  measures: BoxMeasure[], factor: number,
  freight: { copy: FreightCopy | 'missing' | 'invalid'; customs: boolean } | null,
): PoolVerdict
export const homed = (v: PoolVerdict) => v.kind !== 'nothing';
```
- **The order is a rule (M3/E1), stated in a comment in `costPool` and pinned:**
  1. after the `direct_to_client` client filter, `measures.length === 0` → `{kind:'nothing'}` for EVERY basis, before the `freight` argument is read at all (so before copy_missing, copy_invalid, on_customs, measure_missing and too_light). This equals today's `allocateEntry([])`;
  2. only then, for freight: `freight === null` or copy `'missing'` → `copy_missing`; `'invalid'` → `copy_invalid`; `customs` → `on_customs`;
  3. then `splitFreight` (held `cargo`, or the weights);
  4. then `allocateEntry`. For freight only, an `allocateEntry` `[]` over a NON-empty base maps to held `cargo` with `measureMissing` naming every lot, so the ⚠ word is right (it is not a safety need: `nothing` there would already make the void guard refuse).
- `allocateEntry` is called **only here** (fenced).
- The preview (§7.2) calls `costPool` with a nominal `amountUsd: 1` and reads `groups` for its shares; the shares themselves are only the recompute's.

### 9.7 The loader (service.ts)
```ts
export async function loadPoolInputs(entry: CostEntryRow, ids: string[], handle: Db | Tx = db) {
  const measures = await boxMeasures(ids, handle);
  if (entry.allocationBasis !== 'freight') return { measures, freight: null };   // fenced conditional
  return { measures, freight: {
    copy: await freightCopyFor(entry.id, handle),
    customs: (await customsCostTypeIds(handle)).includes(entry.costTypeId) } };
}
```
- `customsCostTypeIds` MOVES to a leaf `costing/customs-ids.ts` (it already takes a handle; it imports only the db, the schema and `calc/customs-codes.ts`), re-exported from service.ts so no caller changes. `CostError` moves to `costing/errors.ts` (§5). freight-copy.ts, tariff-column.ts and freight-ready.ts import the leaves and NEVER `./service`, so no static cycle exists inside costing for a later top-level `extends CostError` to crash on at module load (DS5). Fenced (§11); service.ts's own `await import('./void-guard')` is the existing cycle-breaker and stays.
- `recomputeEntry` (service.ts:1110-1135): `ids` → `loadPoolInputs(entry, ids, tx)` → `costPool` → INSERT the shares on `split`, and return the verdict.
- `costOrphanedByVoid` (void-guard.ts:166-182): `splits(ids)` becomes `homed(costPool(...await loadPoolInputs(entry, ids, tx)))`. It keeps the before/after structure.

### 9.8 Copy I/O — `costing/freight-copy.ts`
- `prepareFreightCopy(input): Promise<FreightCopyDraft | null>`. Pool, pre-tx. Null when the basis is not freight. Otherwise it runs the §5 checks in table order, with the probe first:
  1. scope;
  2. customs ids;
  3. origin via `batches` read;
  4. `tariffColumnOf`;
  5. `tariffHistory` + `bandsAsOf`;
  6. `copyDraft` (dedupe, the finite check, `columnProblem` — the constructor the offer also uses, E9);
  7. each `ColumnProblem` kind maps to its code through a LITERAL `throw new CostError('freight_tariff_gap', { … })` per kind, never a table-computed code (T9: the refusal fence reads literal first arguments).
- `replaceFreightCopyInTx(tx, entryId, draft: FreightCopyDraft | null)`: DELETE, then INSERT when non-null (§3). The ONE writer; the create path and the re-basis door call it.
- `freightCopiesFor(entryIds, handle = db): Promise<Map<string, FreightCopy | 'missing' | 'invalid'>>`, one `inArray` read; `freightCopyFor(entryId, handle)` = its one-element call. It validates (§3) and is the ONLY reader of `cost_entry_tariffs` (fenced).
- `copyDigest(draft | FreightCopy): string` (node `crypto`, sha256 hex over the canonical fields; §5's `freightSeen`, §8's `seen`, `rebase_same`).

### 9.9 Action result
`CostActionResult` (actions.ts:39) gains:
- `params?: Record<string, string | number>`;
- `unsplit?: UnsplitView`;
- `rebase?: RebasePreview`;
- `pending?: true` (a re-basis whose post-commit recompute was queued, §8.4).

### 9.10 Panel map
- `PAYER_ERRORS` gains the §5 and §8 codes (plain string keys, so the fence regex still reads them).
- `payerErrorText(res: { error?: string; params?: Record<string, string | number> }, t)` takes the WHOLE action result (T9) and formats with the params, after resolving `params.column` through `calc.zones`/raw (§5). Every call site in cost-panel.tsx (:291, :304 today, and the rebase block) passes the result object.
- `costRefusal(err)` in costs/actions.ts is the only way a `CostError` becomes a result (§5).
- `FREIGHT_ERROR_PARAMS` is a literal `Record<code, readonly string[]>` in `costing/freight-errors.ts` (pure). It is fenced (§11).

### 9.11 Settings
- `freight_tariff_cost_type_codes: '["freight"]'` goes into the settings DEFAULTS (settings/service.ts, beside :164), with a comment saying why.
- The description goes into all four bundles.

---

## 10. Migration 0132 — exact SQL

File `src/modules/platform/db/migrations/0132_cost_freight_basis.sql`:
```sql
-- 0132 — yo'lkira tarifi bo'yicha taqsimlash (docs/YOLKIRA-TAQSIMOT.md; his 1a 2c 3a 4a 5a 6, 2026-10-14).
-- Additive only. A sixth allocation basis; the warehouse's tariff column (2c) and each freight bill's frozen
-- copy of the tariff it was split by (3a) are SIDE tables, so a database one migration behind fails only a
-- freight write (42P01 → server_behind) and every other cost and warehouse read keeps working.
-- gsr_ai_reader (0080, allowlist default-deny) is granted NOTHING on either new table.
ALTER TABLE "cost_entries" DROP CONSTRAINT "cost_entries_basis_check";
--> statement-breakpoint
ALTER TABLE "cost_entries" ADD CONSTRAINT "cost_entries_basis_check"
  CHECK ("allocation_basis" IN ('weight', 'volume', 'chargeable', 'boxes', 'direct_to_client', 'freight'));
--> statement-breakpoint
CREATE TABLE "warehouse_tariff_columns" (
  "warehouse_id" uuid PRIMARY KEY REFERENCES "warehouses"("id") ON DELETE CASCADE,
  "tariff_zone" text NOT NULL,
  "updated_at" timestamptz NOT NULL DEFAULT now(),
  CONSTRAINT "warehouse_tariff_columns_zone_check"
    CHECK ("tariff_zone" <> '' AND "tariff_zone" = lower(btrim("tariff_zone")))
);
--> statement-breakpoint
CREATE TABLE "cost_entry_tariffs" (
  "cost_entry_id" uuid PRIMARY KEY REFERENCES "cost_entries"("id") ON DELETE CASCADE,
  "warehouse_id" uuid NOT NULL REFERENCES "warehouses"("id"),
  "tariff_zone" text NOT NULL,
  "tariff_from" date NOT NULL,
  "light_below" integer NOT NULL,
  "bands" jsonb NOT NULL,
  "created_at" timestamptz NOT NULL DEFAULT now(),
  CONSTRAINT "cost_entry_tariffs_zone_check"
    CHECK ("tariff_zone" <> '' AND "tariff_zone" = lower(btrim("tariff_zone"))),
  CONSTRAINT "cost_entry_tariffs_light_check" CHECK ("light_below" BETWEEN 1 AND 1000),
  CONSTRAINT "cost_entry_tariffs_bands_check"
    CHECK (jsonb_typeof("bands") = 'array' AND jsonb_array_length("bands") >= 1)
);
```
- **Every CHECK here restates a writer-side rule (DS2)**, so none is reachable on legal input: the zone CHECK is exactly what `normaliseZone`/`saveTariffBand` produce (no length cap — the tariff has none); the bands CHECK only says «a non-empty array», which `copyDraft`'s `unpriced` refuses first (no band-count cap — `columnProblem` counts nothing, and a contiguous 60-band private column is legal); `light_below BETWEEN 1 AND 1000` comes from the constant. Pinned by a test (§11), not assumed.
- The basis CHECK is strictly wider, so it needs no backfill. It was created in 0002_shiny_the_hand.sql:55 and never widened since.
- `cost_entry_tariffs.cost_entry_id` is ON DELETE CASCADE, like `cost_allocations` (wms.ts:796). About ten integration cleanups `db.delete(costEntries)`, and with NO ACTION the first one that touched a freight bill would 23503.
- `warehouse_id` on the copy has no action: a warehouse with a truck cannot be deleted anyway, because the batch's FK blocks it first.

Alongside the SQL:
- Journal entry: `{"idx":132,"version":"7","when":1785190000111,"tag":"0132_cost_freight_basis","breakpoints":true}`.
- Drizzle declarations in `platform/db/schema/wms.ts`, beside `lot_checks`: `warehouseTariffColumns` and `costEntryTariffs`, plus the widened `cost_entries_basis_check`. Only queries that touch the new tables fail one migration behind.
- `migration-journal.test.ts` (`when` order, no holes, no `SELECT 1;` placeholder body) must stay green.
- `ai-schema-card.test.ts` needs no change: it reads 0080's GRANT. Check it.

**Deploy:**
1. take a verified non-zero backup;
2. `docker compose build migrate`, then `up -d --build`;
3. count `drizzle.__drizzle_migrations` = **133**. If it is short, read the migrate container's own output.
4. **Then he writes each warehouse's column** on Boshqaruv → Skladlar → <sklad> → «Yo‘lkira tarifi ustuni». It ships EMPTY on purpose. Until he does, «yo‘lkira tarifi bo‘yicha» is disabled — under a yo‘lkira type with the fact line «… ustuni yozilmagan — og‘irlik bo‘yicha bo‘linadi», under any other type only in the option's own label — and «og‘irlik bo‘yicha» stays the default.

**Rollback below 0132 — an ordered procedure (DS3).** Older code's `weightOf` ends in `default: return 1` (engine.ts:45-56), so it re-splits a `'freight'` row equally by box count with no word; the nightly `orphaned` net (cost-recompute.ts:55, clause 1 at service.ts:1213) picks up exactly the HELD freight bills this design creates, so the FIRST night re-splits them all; and its missing `costing.bases.freight` key throws at render (#163) on every cost card listing one. So:
1. `docker compose stop app` — closes the window in which a new freight bill could be saved after the sweep;
2. take a verified non-zero backup;
3. `docker compose run --rm migrate pnpm freight-to-weight` (dry run — read the list), then the same with `--apply` (§8.8);
4. the precondition: `SELECT count(*) FROM cost_entries WHERE allocation_basis = 'freight' AND voided_at IS NULL` must read **0**;
5. only then `git checkout <older>` and rebuild.
- The same precondition line goes into `docs/UPDATE.md` «Agar biror narsa buzilsa» (:152), so the owner's own rollback procedure carries it.
- The re-basis button is the per-bill convenience; the script is the rollback, and it works when this release's cost UI is what broke.

---

## 11. Fences and tests (every red proof by STRING EDIT, never `git checkout` — #430/#726/#742/#873)

### Unit — pure, literal anchors (#1116)

**`tests/unit/freight-split.test.ts`:**
- his example on the seeded cn column, 276.32/73.68, and kashgar 278.57/71.43. Red proof: weight by m³ instead of `freightWeight`;
- the two-lot client gets a combined $600, not $715. Red proof: group per lot;
- per-kg band: 1100 kg/m³ → rate = 0.55 × density;
- unclaimed cargo grouped per prixod, two `r:` keys. Red proof: group by client_id alone, which merges them;
- 40³ cm / 63.968 kg at n = 1, 2, 3, 32, 33, 50, 100 → band 1000+ every time. Red proof: float sums;
- 21 cm / 9.256 kg at n = 1, 2, 3, 33 → band 701-999 every time. Red proof: totals-based measure;
- 4×4×3 cm, n = 1 is priceable (per-kg band). Red proof: totals-based measure → `measure_missing`;
- **his rule 6**: whole density 9.49 → `too_light`, 9.5 → priced. Red proof: compare the raw density;
- d = 0 (3 m³, 0 kg) → `too_light`;
- Σcm³ = 0 → `measure_missing` naming the lot;
- the ⚠ lists lots lightest first;
- **two reasons at once (E8)**: client X's lot with no measure + client Y's group at 5 kg/m³ → held `cargo` with BOTH lists (measure first); fix X's lot → still held, naming Y. Red proof: return on the first failing group;
- **a light lot inside a heavy group (M8)**: A = 20 m³ at 200 kg/m³ plus a 100 kg lot typed as 50 m³ (2 kg/m³) → A's group 59 kg/m³ SPLITS, and `lightLots` names the 2 kg/m³ lot. Red proof: drop `lightLots`;
- clamp: a private column whose lowest floor is 50 and a group at 20 kg/m³ → the lowest band. Red proof: delete the clamp branch → `copy_invalid`;
- the seeded columns never clamp at d ≥ 10;
- `light_below` is read from the COPY. Red proof: read the constant;
- `splitCents(350, shares)` sums to exactly 350.00;
- `bandText` (SP-8): «501–700 qatori» / «501–700 · $300/kub», and the per-kg «1000+ qatori (kg bo‘yicha)» / «1000+ · $0.55/kg». Red proof: print `price × density` per kub;
- `copyDraft` (E9): the same rows give the same draft and digest in both callers (one function — a differential over two call shapes would restate it);
- `columnProblem`:
  - seeded cn/kashgar → null;
  - closed top → `{gap, from:1000, to:null}`;
  - a 900-999 hole → `{gap, 900, 999}`;
  - a 700 overlap → `{overlap, 700}`;
  - a fractional 100.5 floor;
  - a lowest floor of 50 → null (the clamp covers [10,50));
  - an empty band list → `unpriced`;
  - a contiguous 60-band private column → null (DS2: no band-count cap).

**`tests/unit/cost-pool.test.ts`:**
- held → no shares;
- `homed` (held is homed, nothing is not);
- **the order (M3/E1)**: `measures = []` × freight ∈ {null, copy `'missing'`, copy `'invalid'`, `customs: true`, a valid copy} → `nothing` EVERY time. Red proof: move the empty check below the copy/customs checks;
- freight with copy `'missing'` over ONE measure → `copy_missing`; with `customs` over one measure → `on_customs` (each case carries at least one measure, so the test cannot pin the wrong order);
- weight/volume/chargeable/boxes/direct produce exactly today's shares. This is a differential against a FROZEN COPY of today's `allocateEntry` call (in the test file), over the same pure measures.

**`tests/unit/tariff-zone-field.test.ts`** (T8): `readTariffZoneField` with literals — absent → `undefined`; `''` → `null`; `'  '` → `null`; `' CN '` → `'cn'`. Red proof: read absent as `''` (`?? ''`).

**Existing tests to keep green:** `calc-pricing.test.ts:172,195` (bandDensityOf and bandFor unchanged — proof the calc did not move) and `cost-allocation.test.ts` (helper updated).

### Unit — fences (source shape, comments stripped first, #725)

**`tests/unit/allocation-basis-vocabulary.test.ts`** (NOT `basis-vocabulary.test.ts`, which is the BAZA fence):
- `ALLOCATION_BASES` = the wms.ts CHECK list = 0132's CHECK list;
- 0002's list ⊂ the const;
- service.ts uses `z.enum(ALLOCATION_BASES)`;
- cost-panel.tsx declares no basis list of its own;
- `costing.bases.<b>` exists for each b in all four bundles (#163).

**`tests/unit/freight-wire.test.ts`:**
- `allocateEntry(` appears only in pool.ts (and engine.ts's definition);
- no file under `src/modules/wms/costing/**` imports `calc/dictionaries` or `calc/service`;
- **one home for the copy table (T5/DS1)**: `cost_entry_tariffs` / `costEntryTariffs` appears only in freight-copy.ts, the schema and the migration — rebase.ts and the script are named among the files that must NOT; `replaceFreightCopyInTx(` appears inside rebase.ts's save transaction;
- rebase.ts's copy read sits behind the verbatim `fromBasis === 'freight'` and its copy write behind the verbatim `fromBasis === 'freight' || toBasis === 'freight'` (#1224: `false &&` stays green under a looser match);
- service.ts's `recomputeEntry` body, pool.ts and void-guard.ts never name `calc_freight_tariffs`, `tariff-read`, `tariffFor`, `tariffHistory`, `tariffColumnOf` or `warehouse_tariff_columns`;
- `loadPoolInputs` reads the copy only after `allocationBasis !== 'freight'` returns. This is pinned verbatim;
- `costEntriesFor` joins nothing new;
- in `addCostEntryAction`, `prepareFreightCopy(` comes BEFORE `twinsForCost(` (index order);
- the add AND the rebase actions' catches name `cost_entries_basis_check` and `isServerBehind`;
- **editLot's re-split gate names `measureChange`** (T3);
- **no static cycle (DS5)**: freight-copy.ts, tariff-column.ts, freight-ready.ts, customs-ids.ts and errors.ts do not import `./service`;
- **client bundle (DS6)**: cost-panel.tsx has no non-`type` import from `costing/{service,freight-offer,freight-copy,tariff-column,freight-ready,rebase,customs-ids}`;
- **0132's CHECK text** contains no `length(` and no `BETWEEN 1 AND` on `bands` (DS2);
- warehouse actions: `readTariffZoneField(` is the only reader of `tariffZone`, the zone is not in `toValues`, and the update runs in `db.transaction`. (The «stored zone is offered» half is BEHAVIOURAL now, below.)
- **the reason line (SP-5)**: the CostPanel draws the freight reason line only under `freightTypeIds.includes(` the chosen type.

**`tests/unit/cost-refusals.test.ts`, WIDENED:**
- the regex becomes `/new CostError\('([a-z_]+)'[,)]/`, harvested over every file under `src/modules/wms/costing/**`;
- the `return '…';` and `error: '…'` harvests stay on the ACTION files only (costs/actions.ts), so pure helpers' own string returns (`freightCopyFor`'s `'missing'`/`'invalid'`) are never harvested as form codes (T9);
- every code newly surfaced from the existing costing files is added to `NOT_FROM_THE_FORM` with its reason, in the same commit, and the `toHaveLength(5)` moves to the counted new number.

**`tests/unit/freight-errors.test.ts`:**
- for each code in `FREIGHT_ERROR_PARAMS`, the bundle message's `{placeholders}` in all four locales equal the list exactly;
- **non-vacuity (T9)**: each code in `FREIGHT_ERROR_PARAMS` is found at ≥ 1 literal `new CostError('<code>', {` site, and that site's keys equal the list. A computed code (`new CostError(PROBLEM_CODE[k], …)`) turns this red without touching the existing, already-worded ternary at service.ts:579;
- **forwarding (T9)**: costs/actions.ts contains no `error: err.code`, and its count of `instanceof CostError` equals its count of `costRefusal(err)`; cost-panel.tsx calls `payerErrorText(` only with a result object;
- **behavioural**: for each freight code, `payerErrorText` with sample params through next-intl `createTranslator` over each of the four bundles, with an `onError` that THROWS → no FORMATTING_ERROR, the output contains the warehouse/column value and not the key. A missing ICU value is otherwise a silent fallback (#925);
- `HELD_KEY` is a literal record whose values all exist in the four bundles.
- Red proofs: the rebase catch written as `{ ok: false, error: err.code }`; one freight throw written as `new CostError(code, params)`; a bundle message missing `{warehouse}`.

**`tests/unit/tx-pool.test.ts`** stays green: every new handle-taking reader defaults to `db` and is passed `tx`, and no `getSetting`, `tariffFor` or probe call sits inside a tx body.

**`tests/unit/audit-fields.test.ts`:** the labels for `allocationBasis`, `tariffZone` and `tariffFrom`.

**`tests/unit/freight-sight.test.ts`:**
- `freightMoneySight` over the seeded role matrix (behavioural, #790): accountant/admin true; VED, logist and seller false;
- a `clients.manage` holder without `finance.manage` → false.

### Integration — `tests/integration/freight-basis.integration.test.ts`
Setup:
- a PRIVATE origin warehouse W and **every private zone under ONE run prefix** (T10): `t_<counter><run>_main`, `_alt`, `_gap` (counter at the FRONT, #598). `_main` has tariff rows dated D: 1-100 $110, 101-500 $200, 501-999 $300, 1000+ $0.55/kg; `_alt` is the remap target; `_gap` carries the deliberate hole for test 6;
- **`beforeAll` sweeps earlier runs' leftovers** matching the file's OWN narrow pattern `^t_[0-9a-z]+_(main|alt|gap)$` out of `calc_freight_tariffs` and `warehouse_tariff_columns`, so a killed run heals on the next one (#713). Dating D in the past does not help: `tariffFor(onDate())` takes the newest row on or before today, so any past-dated zone is in force in the staff bot's zone keyboard, the workspace select and podklyuch's validation — only deletion removes it;
- the mapping W→`_main` via `setTariffColumnInTx`;
- a truck from W with riders for client A (two lots), B, one unclaimed prixod U, and a **private DRIFT lot** (T2): a uniform 4×4×3 cm carton (or a 21 cm / 9.256 kg one) whose stored `total_volume_m3` (round4) differs from dims × count — the shape production holds and the old «all fixtures agree» rule avoided.
- The cleanup is a final TEST, never `afterAll` (#57/#824), in ONE transaction: delete `warehouse_tariff_columns` rows whose `tariff_zone LIKE 't\_<run>\_%' ESCAPE '\'` and W's own row; delete the file's freight cost entries (the copies cascade); delete `calc_freight_tariffs` rows `WHERE zone LIKE 't\_<run>\_%' ESCAPE '\'`; DEACTIVATE W (never delete — audit FK). Then assert in the database that no zone with the run prefix is left in either table.
- The rebase and VED cases press the ACTION under the session stand-in (`vi.mock('@/modules/platform/auth/session', … getSessionUser: async () => session.user)` plus `next/cache` `revalidatePath` and `platform/jobs/boss` `enqueue` mocks — batch-reroute.integration.test.ts:11-24's idiom), so `authorize` and `ownOnly` run for real (#531).

Tests:
1. Save a freight bill → literal shares per group, the copy row written, and the create audit carries `allocationBasis` + `tariffZone`. The result still has `.id` AND `.verdict` (DS4).
2. Freeze: after the save, same-date overwrite a band, add a back-dated row, and remap W to `_alt` → `recomputeEntry` → shares unchanged. Red proof: `costPool` reads the live tariff/mapping.
3. Light: add a client C lot at 5 kg/m³ → the verdict is held `too_light` naming C's lots lightest first, zero shares, and `noShareSql` counts it. `editLot` C to 50 kg/m³ → split again with no other call.
   - **3b, dims-only heal (T3)**: client C2's one-box uniform lot of 0.020 kg at 22×12×8 (stored 0.0021 m³, d = 9) → held; `editLot` to 21×10×10 (still 0.020 / 0.0021, d = 10) → split with no other call; the lot's stored totals are asserted UNCHANGED, so the test cannot pass through the totals branch. Red proof: restore the totals-only gate.
4. Void guard, both ways:
   - voiding the heavy lot of client D (D's group drops <10) is ALLOWED, and the bill becomes held. Red proof: `homed` → `kind === 'split'`;
   - voiding the truck's only cargo is refused `shared_cost_orphaned` exactly as today;
   - **an `on_customs` bill losing its last declared carton (M3/E1)**: a freight bill saved, then its type's code added to `calc_customs_cost_type_codes` (snapshot the setting first and restore it in the final TEST — it is configuration, #183) → the recompute is held `on_customs`; voiding the last declared carton is refused `shared_cost_orphaned`, and `recomputeEntry` on the emptied base returns `nothing`. Red proof: the pool-order edit.
5. A claim of U folds it into A's group. Red proof: none needed; the claim already re-splits, and the test pins the fold.
6. Refusals with params: no column → `freight_no_column` {warehouse}; a date before D → `freight_zone_unpriced`; the `_gap` column → `freight_tariff_gap`; a customs type → `freight_on_customs`; a receipt scope → `freight_batch_only`; a 100-character zone mapped and priced → the save SUCCEEDS (DS2). Each runs through `prepareFreightCopy` (#531). Plus the action with a stale `freightSeen` → `freight_changed` naming `_alt` (M6). Red proof: skip the digest compare.
7. Re-basis (pressing `rebaseCostAction`):
   - **(a) remap (T4)**: preview a weight bill, remap W to `_alt`, save with the old `seen` → `error === 'rebase_changed'` with a fresh preview naming `_alt`; in the database the basis is still weight, no copy row, allocations unchanged. Red proof: accept any 64-hex `seen`;
   - **(b) concurrent from-part change (T4)**: a second connection opens a tx and `SELECT … FROM cost_entries WHERE id = $1 FOR UPDATE`; `rebaseCostAction` with a fresh, valid `seen` blocks on its own lock (observed through `pg_stat_activity` `wait_event_type = 'Lock'`, polled on the POOL — #873's observer); the holder UPDATEs `allocation_basis` to volume and commits → `rebase_changed`, the holder's basis stands. Red proof: delete the in-tx re-read and compare;
   - fresh preview → save → basis freight, the copy written, the audit before/after; amount, amount_usd, partner charge and account fields byte-identical;
   - **voided between preview and save (E2)** → `already_voided`, zero new `update` audit rows, no copy row;
   - **a stamped grid cell (E2)** → `rebase_batch_only`, basis and audit unchanged;
   - **a failed recompute (E3)**: make `recomputeEntry` throw once after a weight→freight save → the bill reads `hasShare = false` and `recomputeAll({ orphaned: true })` heals it. Red proof: drop the shares DELETE → the old weight shares stay, invisible to every clause;
   - **a non-freight re-basis touches no copy (DS1)**: weight→volume leaves `cost_entry_tariffs` unqueried (a spy on the copy module, or the source conditional above);
   - a merged/kassa bill rebases with its money untouched;
   - `rebase_same`; `rebase_direct`; the VED on a colleague's bill → `cost_not_yours` (red proof: strip the `ownOnly` clause).
   - **The pairing (T5)**: after create(freight), create(weight), weight→freight, freight→weight and freight→freight (W remapped to `_alt`), `count(cost_entry_tariffs WHERE cost_entry_id = e) = (allocation_basis = 'freight' ? 1 : 0)`, and a voided freight bill keeps its one row. Red proof: skip the DELETE when `draft === null`. freight→freight needs none (the PK turns a skipped DELETE into 23505).
8. Recompute verdict through `addCostEntry` → the action returns `unsplit`. An empty-base held-shaped bill → `explainFreightBills` prints «no cargo», not the copy/customs sentence.
9. **The drift lot (T2)**: (a) `boxMeasures` on its boxes returns `weightKg`/`volumeM3` equal to the literal totals ÷ box_count, and the raw dims as the stored strings; (b) a VOLUME bill on that truck splits by literal shares that follow the TOTALS (red proof: derive `volumeM3` from dims); (c) a FREIGHT bill lands in the band the DIMS give (4×4×3 n = 1 is priced, not held; red proof: drop the dims from the select or the `dims_mode` check).
10. **Two trucks (E6, SP-1)**: cargo rides an INTERNAL truck T1 from W (both ends CN — W→a private second CN warehouse K) carrying a freight-basis bill on W's column, then an export truck T2 from K.
    - T2's Narx breakdown carries T1's part with T1's band (computed from T1's riders and copy) and no crash. Red proof: build the explain map from `costEntriesFor(T2)`.
    - A 1 kg / 3 m³ lot on T1 HOLDS T1's bill → `carriedUnsplitBills(T2)` reports T1, its amount and the light client; fixing the lot clears it and prevUsd carries the money.
    - The mirror: a held later UZ-leg bill appears as «keyingi yo‘l». Red proof: drop the `m.upto` window clause.
11. **The Balans (M1)**: one unpriced client on a light lot and a kassa-paid freight bill → `lineUsd` excludes the bill, `freightUnsplit.usd` = the bill, `noBox.count` = 0; fix the lot → `lineUsd` gains the share and `freightUnsplit` returns to 0. Red proof: drop the basis filter → `noBox` gets the bill back.
12. **The todo under sight (SP-6)**: an accountant's held bill → `unsplitCountFor(batch, costSightFor(ved))` = 0, for the accountant 1; the VED's own held bill → 1 for him.
13. **Old bases did not move (T2)** — a READ-ONLY differential, no writes: for every live non-freight entry in the database, shares from a frozen copy of today's `boxDims` + `allocateEntry` equal shares from `loadPoolInputs` + `costPool`. (Stored `cost_allocations` are NOT the oracle: riders and lots changed after other files wrote them, and `recomputeAll` would rewrite their rows.) Run once against a shaped copy of production as well, the #1251/#1290 way, and record the count.
14. **Rollback script (DS3)**: one split and one held freight bill → `freight-to-weight --apply` → both weight, shares Σ = amount_usd, an audit row with `reason: 'rollback'`, no copy row. Red proof: drop the copy DELETE, or the recompute.

The fixtures cover uniform+dims, uniform with NULL dims, mixed, AND the drift lot.

### e2e — `tests/e2e/m9zzzc-yolkira-tarif.spec.ts` + `yolkira-tarif-fixture.ts`
It sorts after m9zzzb-sarflar. **seed-demo does NOT write any mapping**: m9zzzb enters a yo'lkira bill and must keep today's weight default.

`fitsThePhone(page)` is copied locally from m9zzzb-sarflar.spec.ts:52-59 (T7): `clientWidth` toBe 360 AND `scrollWidth` ≤ `clientWidth`. Equality with 360 alone is always true under mobile emulation (#1241's own reason for the oracle) and can catch nothing. Where a row sits inside an `overflow-x-auto` container, also `el.scrollWidth <= el.clientWidth` on the row (the m9zzz-ved-bitim.spec.ts:80 shape).

The spec, as admin:
1. On the YW warehouse page, choose the cn column in `wh-tariff-zone` and save (the real door). `fitsThePhone` with the select drawn.
2. Fixture truck from YW with A (2 m³, 600 kg/m³), B (1 m³, 160 kg/m³) and an unclaimed prixod whose marking is ≥ 40 characters with no break opportunity (a fixture that cannot reach the failing width is evidence about the fixture, #576/#642).
3. Xarajatlar ＋ → the type is yo'lkira and the basis select reads `freight` (preselect); the column line reads «YW ustuni: …».
4. Amount 350 → `freight-row-*` reads 78.95 % / 21.05 % and 276.32 / 73.68. `fitsThePhone` with the preview rendered.
5. Save → the row label carries «yo‘lkira tarifi bo‘yicha» → open `cost-freight-how`, `fitsThePhone` → the Narx tab breakdown band line, `fitsThePhone`.
6. **#171 behaviourally (T8)**: reopen /admin/warehouses/<YW>; `wh-tariff-zone` reads `cn`; change ONLY the address and save; the database's YW mapping row still says `cn`. Red proof: the [id] page passing `tariffZone: null` (or the select losing its `defaultValue`) — NOT the options list, because cn is a seeded zone and would stay offered (#166).
7. **Final TEST**: set the column back to «—» through the form, and verify in the database that the row is gone (#183).

The HELD list and the re-basis preview are not on this spec's path: they are measured in the build-step screenshots at 360×800 (stated, not claimed as covered by the e2e).

Run without `CI=1`, `fuser -k 3000/tcp` first. Seed once, vitest, then Playwright without re-seeding (CI's order).

---

## 12. Build order — one commit each, gates after each (`pnpm lint && pnpm typecheck && pnpm test`, each gate's OWN marker grepped, never `| tail` — #803/#917)

1. **Leaf moves**: `bandsAsOf` → pricing.ts; `calc/tariff-read.ts` (`tariffFor`, `tariffHistory`, `tariffZoneNames`); dictionaries re-exports. No behaviour change, and every calc test is green.
2. **Migration 0132**: SQL + journal + drizzle declarations + the widened schema CHECK. Fresh `gsr_ci` migrate → count 133.
3. **Engine vocabulary**: `ALLOCATION_BASES`, exhaustive `weightOf`, `freightWeight`, zod via the const, the panel's `BASES` deleted, `costing.bases.freight` ×4, the `cost-allocation.test.ts` helper, `allocation-basis-vocabulary.test.ts` (red proof: drop 'freight' from the CHECK).
4. **Pure split**: `freight-types.ts` (the shared shapes, DS6), `freight-split.ts` (stableMeasure, freightGroups, wholeDensity, splitFreight with both held lists and `lightLots`, `copyDraft`, columnProblem, splitCents, `bandText`, `offeredBases`, `FREIGHT_LIGHT_BELOW`), `tariff-zone-field.ts`, `freight-split.test.ts` + `tariff-zone-field.test.ts` with every red proof in §11.
5. **One pool**: the leaves `costing/errors.ts` (`CostError` + params) and `costing/customs-ids.ts`, both re-exported from service.ts (DS5); `boxMeasures` (boxDims deleted, LEFT JOINs), `truckRiderBoxIds`, `freight-copy.ts` (`freightCopiesFor`/`freightCopyFor`, `replaceFreightCopyInTx`, `copyDigest`), `pool.ts` `costPool`/`homed` with the stated ORDER, `loadPoolInputs`, `recomputeEntry` → verdict, the void guard via `homed`, editLot's gate widened with `measureChange`, `cost-pool.test.ts`, `freight-wire.test.ts` (pool/copy/recompute/cycle halves). Integration tests 2, 3b, 4, 9 and 13.
6. **Warehouse column**: `tariff-column.ts`, `freight-ready.ts`, form select («(narx yo‘q)» suffix) + `readTariffZoneField` + both actions in one tx + audit + error states + `state.values` (the form holds its inputs) + i18n ×4 + `AUDIT_FIELD_LABELS.tariffZone`, the warehouse half of the wire fence. Measure the form at 360 px.
7. **Save path**: `prepareFreightCopy` (via `copyDraft`, literal throw per problem kind), the copy INSERT in addCostEntry's tx, the row + `verdict` return (`Object.assign` — the ~33 test call sites and the returning helpers stay untouched; `pnpm typecheck` is the proof), the action's preflight before the twins + the `freightSeen` compare, `costRefusal` at every catch, the `server_behind` mapping, `CostActionResult.params/unsplit`, `payerErrorText(res, t)`, the §5 keys ×4, `freight-errors.ts` + `HELD_KEY` + its fence, the cost-refusals widening, the create audit's basis. Integration tests 1, 3, 6, 8.
8. **Panel**: the `freight-codes.ts` setting + description ×4, `freightOffer`, `costPanelOptions` → `freight`, REQUIRED `freight` on CostPanel and `CostEntryView` (all five sites), `offeredBases`/`basisTouched`/the kept rule, the reason line only under a freight type + `target="_blank"` fix links, `firstFrom` and the «unknown» old date, the column line, preview rows via `bandText` + `freightLightLot`, the hidden `freightSeen`, `FreightHeldNote`, `costEntriesFor.hasShare`, `explainFreightBills`, the row label + ⚠ + «Qanday bo‘lindi?», the grid header line, `freight-sight.test.ts`. Screenshots at 360×800 and 1280×900.
9. **Re-basis door**: `costing/rebase.ts` (batch scope only, `already_voided` under the lock, the shares DELETE, the conditional copy I/O, the enqueue on a failed recompute), `rebaseCostAction` (catch = `costRefusal` + lagging-server mappings), `CostEntryView.rebasable`, the UI below the row, the audit labels, integration test 7. Then `scripts/freight-to-weight.ts` + `pnpm freight-to-weight` on the save half, integration test 14, and the `docs/UPDATE.md` precondition line.
10. **⚠ surfaces**: `noShareSql` (profitByBatch + the orphaned net), the Σ suffix, the pricing `pricing-unsplit` line + `carriedUnsplitBills` (`pricing-unsplit-carried`, the per-client «⚠ to‘liq emas»; the open-cargo words STAY, reversed in review), the `batch-todo-unsplit` todo through `unsplitCountFor(batch, sight)`, the attention href + profit `bolinmagan=1`, the Balans `freightUnsplit` split + `balUnpricedFreightHeld`, `batchClientCostBreakdown`'s freight entry key + the map from the breakdown's own ids + the band line (`roundPreservingTotal`). Integration tests 10, 11, 12.
11. **e2e** m9zzzc + fixture. Run the full CI-order on a FRESH gsr_ci: seed once, vitest, then Playwright without re-seeding.
12. **Docs**:
    - `docs/YOLKIRA-TAQSIMOT.md` — his answers at the top, the questions turned into decisions, this spec's §§1-13;
    - DECISIONS #1364+ (re-read the tail first);
    - a CHANGELOG entry in Uzbek, including the «9 skladga ustun yozing» chore and the «eski hisoblar o‘zgarmaydi — tugma bilan o‘tkazasiz» line;
    - CLAUDE.md state with ledger 133.

---

## 13. Honest limits

- **The money effect is UNMEASURED.**
  - The shaped copies hold 4,000 of 4,026 lots at 166.67 kg/m³ with NULL dims, and every bill is on weight, so every basis reads a 0 difference there.
  - He should run the read-only query (scratchpad `prod-readonly-measure.sql`) on his server.
  - The direction: today's default is WEIGHT, and weight → tariff moves cost from dense goods to light goods.
- **It ships empty.**
  - Nine warehouses have no column, so the freight basis is disabled with a sentence until he writes them. Suggested: YW and GZ → cn, KA → kashgar.
  - Uzbek warehouses (AND→TAS internal legs) need a column of their own, or their trucks stay on weight. That is his call, and leaving one unmapped costs nothing: other cost types show no line at all, and a yo'lkira bill shows the fact «… og‘irlik bo‘yicha bo‘linadi» (SP-5). It goes into the owner reply as a deploy-time choice, not a design question.
- **2c's cost.** A KA-origin truck carrying cargo received in Yiwu is split on the kashgar column, while the VED priced that cargo on cn.
  - The two columns are near-proportional, 1.53-1.60 on every per-m³ band.
  - At the per-kg step they are not (cn 1.72× against kashgar 1.5× from 999 to 1000+).
  - So dense cargo is weighted differently depending on which warehouse the truck left from.
- **Fail-closed is the whole bill.**
  - One light group (<10 kg/m³) puts every client on that truck at zero freight tannarx until the lot is fixed, and margins look higher meanwhile.
  - It is named on the bill row, the Σ line, the truck todo (under the reader's own sight), this truck's pricing page AND the pricing page of every truck whose tannarx it feeds as «shu reysgacha»/«keyingi yo‘l», the attention row and the Balans.
  - **Sof holat is LOWER by the unpriced cargo's share of a held bill until it re-splits** (M1): the bill leaves the U03 line and the Balans names it in `balUnpricedFreightHeld` (an upper bound: the whole bill), with no void advice.
  - The warehouse operator who fixes lots is not told on the truck card.
- **Stable measures cover uniform lots with all four dims only.**
  - A mixed lot's totals ÷ box_count drifts slightly on about 97 % of QR-siz grows (simulated), so near a band edge it can still re-band.
  - A legacy uniform lot with NULL dims uses totals.
  - A crate's own volume is ignored: carton m³ comes from the lot, as in every other reader.
- **The freight m³ differs from the rest of the app.** Freight's per-box m³ for dims lots is not the `total ÷ box_count` every other reader uses (riderLoad, stamp-revenue, the pricing page), so inside-client percentages can differ from the revenue side's m³ shares in the 4th decimal.
- **Preview ≠ save** when a carton boards between render and save. A TARIFF or COLUMN change between render and save is refused `freight_changed` (M6), so the frozen copy is always the one the person saw.
- **The cost split and the calc/E1 may band a small or edge lot differently, by design (E10).** The calc and E1 compute density from the lot TOTALS in floats (`total_volume_m3` is numeric(12,4)); the split uses dims and exact sums. Example: 2 × 21 cm / 9.256 kg has totals 18.512 kg / 0.0185 m³, so E1 reads 1000.6 → 1001 (the per-kg band) while the split reads 999 ($320/m³). E1's «cargo arrived at N kg/m³» can therefore differ from the Narx band line on such a lot. The fold prints the split's density with «(o‘lchamdan)» for a dims lot, so the mismatch explains itself.
- **A held `on_customs` freight bill is invisible to E1's customs actual** until it is re-based: a converted batch entry that allocated nothing is deliberately skipped there (calc/actuals.ts:470-476).
- **A light LOT inside a heavy group does not hold the bill** (the group is his grain); it is named as a non-blocking ⓘ line (M8). A mistyped m³ averaged into a heavy client therefore moves real money between clients with a line, not a hold.
- **#783 is partly closed.** The grain is the client's cargo on THIS truck, not the VED's job. A consignment split over trucks, or two quotes on one truck, gets a blended band.
- **His 999→1000 step** (cn $320/m³ → $0.55/kg, +72 %) is kept as his tariff. An exact 999.5 kg/m³ is 1000 (half-up, the number the screen prints), consistently at every count.
- **A re-basis reads the warehouse's CURRENT column and the tariff as of the BILL's date.** To apply a new price to an old truck, the tariff row must be dated on or before that bill's `cost_date`. A bill dated before his first row cannot use this basis.
- **The basis ⇔ copy pairing is not a DB CHECK.** It spans two tables and rests on freight-copy.ts's one writer (`replaceFreightCopyInTx`) plus the integration count assertion (§11, T5); `costPool` holds with `copy_missing` when the copy is absent, and a stray row on a non-freight bill is never read.
- **Old bills keep their basis** (no backfill). A month can mix shapes in seller profit and deal profit until he re-bases chosen bills.
- **The threshold** `light_below` = 10 is frozen per bill. Changing `FREIGHT_LIGHT_BELOW` later moves only new saves and re-bases.
- **The calc is untouched by construction.** `bandFor`, `freightFor` and `bandDensityOf` are byte-identical, and the cost split's exact density lives in costing.
- **What stays the same**:
  - the per-prixod grid's yo'lkira cells stay weight;
  - pickup (factory truck), receipt and crate costs are untouched;
  - the twin alarm stays at 1 %/3 days;
  - KPI, upsale, the P&L, cash, ledgers and the cabinet do not move, and for a truck's own bills «Partiya foydasi» is conserved. Only the client and lot rows move — and the Balans's Sof holat while a bill is held (above).
- **Not verifiable here**: production warehouse codes and names, which zones he has priced, and whether he has dated tariff edits since 2026-01-01.

---

## Changes from the draft (for the record)

- **Q2: c replaces a.** The per-bill picker, «ustun: Xitoy ✎» and localStorage are gone. Instead there is the warehouse side table, the origin warehouse, a refusal naming the warehouse, the admin form select, and the origin + zone frozen into the copy.
- **Q6: his threshold replaces the draft's a.**
  - Under 10 kg/m³ (the whole number printed) the bill is HELD, and the ⚠ names the group and its lots lightest first.
  - From 10 up to the lowest floor, the group is clamped to the LOWEST band.
  - `light_below` is frozen into the copy.
- **`bandDensityOf` is NOT changed.** Instead the cost split uses exact BigInt sums.
- **The void guard** judges by `homed`, so a HELD bill does not refuse a warehouse void.
- **Gap check**: `columnProblem` is interval-based and starts at the lowest floor. The closed top and overlaps have their own codes.
- **Zone words** are /admin/tarif's own `calc.zones` words with a raw-code fallback, instead of a new «Xitoy ustuni» vocabulary that no bundle has.
- **Fence names and file sets corrected**: `allocation-basis-vocabulary.test.ts`; `cost-refusals.test.ts` widened; a params fence added.
- **Corrections to the draft's facts**: `origin_warehouse_id`, not `from_warehouse_id`. SARFLAR has landed, so the preflight goes before the twin check and the copy is INSERTed inside the existing short tx. `ON DELETE CASCADE` on the copy.
- **Re-basis** is batch bills only, with no zone argument (it re-reads the origin's column). `direct_to_client` is refused as a target, and merged/kassa/firm bills are allowed.
- **The internal-leg «xarajat yozilmagan»** stays an existence check (the draft would have printed «not written» about a written bill).
- **One basis vocabulary**: the zod enum and the panel import the const, leaving two copies (the schema CHECK and the 0132 CHECK), both fenced.

---

## Judge findings absorbed

Confirmed objections (21):
- money/M1, defect — §6.3.7 (new surface 7): `w_cost` carries `allocation_basis`, `w_nobox` splits `freightUnsplit` out of `noBox`, `balUnpricedFreightHeld` with no void advice and a link to the attention destination; §13 states Sof holat falls while a bill is held; integration test 11.
- money/M3, defect (blocker for the void guard) — §1.4 step 0, §6.7, §9.6: costPool judges an EMPTY pool as `nothing` before the copy/customs/groups; pure test over every freight argument × `[]`; integration test 4c (an `on_customs` bill losing its last declared carton → `shared_cost_orphaned`).
- engine/E1, defect — same fix as M3 (one rule, §9.6 order steps 1-4; a freight `allocateEntry` `[]` over a non-empty base maps to held `measureMissing`).
- deploy/DS1, defect — §8.2/§8.4: the copy is read only for a freight from-side and written only when freight is on either side, through `replaceFreightCopyInTx`; the rebase catch maps `isServerBehind` + `cost_entries_basis_check`; fences pin both conditionals and the catch.
- tests/T5, defect — same writer: `replaceFreightCopyInTx` in freight-copy.ts (§3, §9.8), rebase.ts never names the table (fenced), the basis ⇔ copy count assertion after five transitions (§11 test 7).
- deploy/DS2, defect — §2.1, §10: the zone length cap and the 50-band cap are dropped; every 0132 CHECK restates a writer rule; a 100-char zone and a 60-band column are pinned as legal; a fence refuses `length(`/`BETWEEN 1 AND` on bands.
- deploy/DS3, defect — §8.8, §10: `scripts/freight-to-weight.ts` (dry run / `--apply`, run through `migrate`) on the save half of rebase.ts; an ordered rollback procedure with `stop app` first and the `count = 0` precondition, also written into docs/UPDATE.md; integration test 14.
- deploy/DS4, defect — §6.1: `Object.assign(entry, { verdict })`; the ~33 test call sites and the returning helpers are named and untouched; §12 step 7.
- screen/SP-1, defect — §6.3.5: `carriedUnsplitBills` on the fence's own `rides`/`mx` windows names held (and unconverted) bills on earlier/later legs on the bearing truck's Narx page, per-client «⚠ to‘liq emas», open-cargo words suppressed for an existing held bill; integration test 10 (both directions, red proof on the `m.upto` clause).
- screen/SP-5, defect — §4: the reason line only under a freight type, worded as a fact; other types get a short option label; the fix links open in a new tab; §13 states unmapped warehouses cost nothing; fenced.
- screen/SP-6, defect — §6.3.4: `unsplitCountFor(batch, sight)` with sight REQUIRED; integration test 12.
- engine/E2, defect — §8: `rebasable` = scope 'batch' on CostEntryView, `rebase_batch_only` in the door, `already_voided` under the FOR UPDATE before the token compare, `prepareFreightCopy` built from the entry row; integration test 7.
- engine/E3, defect — §8.4: the shares DELETE inside the rebase tx + the edit.ts catch/enqueue idiom + `pending: true`; integration test 7 with a red proof.
- engine/E6, defect — §7.4: the Narx explain map is built from the breakdown's own `freight_entry_id`s, each explained on its own truck and copy; a missing key prints the plain line; integration test 10.
- tests/T2, defect — §11: a private drift lot (stored round4 totals ≠ dims × count) pinned three ways (loader, volume bill, freight band); a READ-ONLY old-vs-new differential over every live non-freight entry, plus one run on a shaped copy (stored allocations rejected as the oracle).
- tests/T3, defect — §6.5: editLot's gate adds `measureChange` (already computed at edit.ts:221-228); integration test 3b with stored totals asserted unchanged; fenced.
- tests/T4, defect — §8.3 (a present-but-stale `seen` → `rebase_changed` + fresh preview) and §11 test 7 split into (a) remap and (b) a held-connection concurrent change; the VED case presses the action under the session stand-in.
- tests/T7, defect — §11 e2e: `fitsThePhone` (clientWidth 360 AND scrollWidth ≤ clientWidth) at the select, the preview, the fold and the Narx line, with a ≥40-char marking; the HELD list and re-basis preview stated as screenshot-only.
- tests/T8, defect — §2.5 `readTariffZoneField` (pure, four literals), `mappableZones` behavioural pin, e2e step 6 (address-only save keeps the mapping; red proof on the [id] page's stored value, not on the options).
- tests/T9, defect — §5/§9.10: `costRefusal(err)` at every catch, `payerErrorText(res, t)`, literal throws per problem kind, non-vacuity + forwarding fences, a behavioural createTranslator check with a throwing `onError`, the `return '…'` harvest scoped to action files.
- tests/T10, defect — §11 setup: one run prefix for every private zone, a narrow-pattern sweep in `beforeAll`, a one-tx final cleanup asserting no prefixed zone is left.

Nits accepted (13 of 14):
- money/M6 — `freightSeen` = `copyDigest` of the shown version, `freight_changed` on a mismatch (§5, §7.2 `FreightVersion.digest`, test 6).
- money/M7 — fold, band lines and the re-basis preview round per-group sums to the bill's cents with `roundPreservingTotal` (§7.4, §8.3).
- money/M8 — `lightLots` on a split group and the non-blocking `freightLightLot` line; the hold rule unchanged (§1.4, §6.2, §7.3, §13, pure test).
- deploy/DS5 — `CostError` → `costing/errors.ts`, `customsCostTypeIds` → `costing/customs-ids.ts`, both re-exported; no-`./service` fence (§5, §9.7).
- deploy/DS6 — `costing/freight-types.ts` for shapes, named pure homes for every panel value import, a client-bundle fence (§4, §7.2, §9.5).
- deploy/DS7 — `freightCopiesFor(ids)` one read; base + measures once per truck in `explainFreightBills` (§3, §7.4, §9.8).
- screen/SP-8 — one `bandText` formatter for preview, fold, Narx line and re-basis preview (§7.3, pure test).
- screen/SP-9 — the re-basis block and fold are `w-full` below the row; the select/preview/save testids; the column line above the preview (§7.3, §8 UI).
- screen/SP-10 — every new key named (§2.5, §6.2), ru plurals, todo label as a noun phrase, `HELD_KEY` literal, the warehouse form holds its inputs (`state.values`), «(narx yo‘q)» on unpriced zones. PARTIAL: history prints the zone CODE, stated (§2.5).
- engine/E7 — same as DS4.
- engine/E8 — `FreightHeld` `cargo` carries both `measureMissing` and `tooLight`, collected over all groups, measure printed first (§6.1, §1.4, pure test).
- engine/E9 — one `copyDraft` constructor shared by the save and the offer, the offer runs `costPool`; a date older than the 20 held versions is «unknown — server decides», `firstFrom` carried (§4, §7.2, §9.5).
- engine/E10 — stated in §13 (calc/E1 vs split banding on an edge lot, with the 21 cm literal; a held `on_customs` bill invisible to E1's customs actual), plus the fold's «(o‘lchamdan)».

## Rejected

- money/M9 (nit, a one-group bill should split anyway) — re-opens the fixed reading of 6 («a priced group under 10 kg/m³ → saved but NOT split»), which the lead closed. The hold is also the visible signal that the lot's m³ is wrong, and the same m³ drives that client's per-kub price; the money lands once the lot is fixed, and every held surface names it meanwhile.
- money/M2 (refuted) — agreed with the refutation for (b) carriage moving money between trucks (designed, his 2a) and (c) the band line computed on the wrong truck (§7.4 explains each bill on its own truck). Part (a), a held internal-leg bill invisible on the export truck's Narx page, was CONFIRMED separately as SP-1 and is absorbed there.
- money/M4 (refuted) — the tariff audit rows rebuild any outgoing copy, and per-client shares have never been a historical record; his Q5 «a» text accepted it.
- money/M5 (refuted) — a reassignment moves the shares before the save anyway; the binding CAS is the from-part.
- screen/SP-2 (refuted) — the preview warns inside the form before save, and the row ⚠ persists on /kiritish's own list.
- screen/SP-3 (refuted) — the logist reads every held surface and holds unscoped `receipts.edit`.
- screen/SP-4 (refuted) — the per-bill door is his 5a; a bulk move is the 5c he declined; the option is disabled with a reason until a column exists.
- screen/SP-7 (refuted) — the money flag is derived inside freight-offer.ts from the actor; the new $ surfaces sit inside reads already gated and fenced.
- engine/E4 (refuted) — the spec never said inner join, and truck-riders.integration.test.ts:816-882 already turns red on it. One sentence pointing at that test was added to §9.4; no design change.
- engine/E5 (refuted) — the logist (and admins) who read the ⚠ hold `receipts.void`; steering a <10 group to «Bo‘lish usuli» would hide the data error his «ogohlantirsin» exists to surface.
- tests/T1 (refuted) — the whole-density rule (9.49 → warn, 9.5 → priced) is the deliberate, stated reading, consistent with `bandDensityOf` and his own loose «100 kgdan kam» for a band that holds 100; the clamp is pinned in the pure test and any storage failure is caught by test 1.
- tests/T6 (refuted) — the final-TEST restore is the suite's rule; m9zzzb does not read the basis, the fixture's groups split, and a private ACTIVE warehouse left by a failed run would be worse.
