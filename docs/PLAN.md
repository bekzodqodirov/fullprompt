# GSR LOGISTICS WMS — Work Plan (M0–M6)

> Companion to [SPEC.md](./SPEC.md) and [ARCHITECTURE.md](./ARCHITECTURE.md). Milestone-by-milestone task breakdown, acceptance-test mapping, testing strategy, and open questions for the owner.

---

## STATUS — 2026-07-23

| Milestone | State | Shipped |
|---|---|---|
| M0 Platform foundation | ✅ done | auth, RBAC, audit, admin CRUDs, i18n ru/uz/zh, files+thumbnails, PWA, CI |
| M1 Receiving + labels + Telegram | ✅ done | single-window receiving (+5 owner feedback rounds), letter sequencer, label PDF (incl. unclaimed marking), translation, Telegram notify |
| M2 Stock ops | ✅ done | crates, stock XLSX, lost/found/void, WH-move, unclaimed return, daily digest |
| M3 Load planning & loading | ✅ done | plan editor (avg density, crates = 1 place, owner-managed trucks), agent loop (all photos in Excel), batch board, scanner + offline outbox, loading mode with crate contents |
| M4 Transfer receiving | ✅ done | unload mode, auto-transfer, missing-in-transit + resolutions, batch close, /transit |
| M5 Export & UZ side | ✅ done | INVOICE&PACKING LIST in the owner's real ka23 format (`ved_*` settings), ready_for_pickup, quick batch, issue mode + handover act PDF, pipeline |
| **M6 Costing, reports, polish** | **🔄 in progress** | see per-task marks below |

**M6 progress:** done — FX rates (manual, per owner) ✅, allocation engine + recompute (§6.9 test green) ✅, cost capture on batch/receipt + batch cost sheet ✅, box landed cost ✅, warehouse capacity indicator (60%/80%, lives on /dashboard per owner) ✅, nightly local backups + `pnpm backup` ✅, **role-aware /dashboard** (fill, stock, in-transit, 24h receipts, unclaimed, aging, discrepancy flags) ✅, **/reports hub + top-3 reports with XLSX** (landed cost by client with per-lot drill-down, stock/aging, batch register with deviations + unit costs) ✅.
**M6 remaining:** digest polish (per-user mute, delivery-failure view), performance/3G pass, weekly restore-test script, README/ops runbook, full regression. *(Shipped 2026-07-23: inventory mode #12 — DECISIONS #93; ALL nine §13 reports + XLSX; sortable columns #13 — DECISIONS #96; cost-hygiene warning — DECISIONS #97; whole-app UI/UX sweep — grouped home, error/404 pages, back links, empty states, touch targets, pending states, scan feedback, audit-filter crash fix — DECISIONS #98–99.)*

---

## Work plan (M0–M6)

Conventions: task sizes are 0.5–2 dev-days each; tasks are in build order within a milestone. Acceptance tests reference spec §20 (⭐ = automated in CI). Each of the 20 scenarios is mapped to exactly one milestone — the milestone where the scenario can first pass end-to-end.

---

### M0 — Platform foundation ✅ DONE

**Goal:** Auth, users, RBAC, warehouses/clients admin, settings, audit core + history component, i18n scaffold, PWA shell, file pipeline, seed script, CI.
**Done when (spec):** admin creates a WH + client + operator on a phone; every change visible in the audit browser.

**Tasks:**

1. Repo scaffold: pnpm monorepo, Next.js 15 App Router, strict TS, ESLint/Prettier, `modules/platform` + `modules/wms` folder structure, docker-compose (app + postgres + minio), self-hosted fonts (no Google CDN).
2. Drizzle + migration pipeline; base schema: `users`, roles/permissions tables, `warehouses`, `clients`, `settings`, `audit_log`, `events`, `attachments`, `fx_rates` (table only), `letter_blacklist` (table only).
3. Auth: phone/username + password, Argon2id, httpOnly session cookies (30-day refresh), rate limiting (5/15min/IP+account), device list + "logout other devices", optional PIN re-lock behind config flag.
4. Data-driven RBAC: role→permission tables seeded from the §16 matrix, server-side permission guard on every mutation, warehouse-scoping for `warehouse_manager`/`warehouse_operator`.
5. Audit write path: before/after JSON diff, actor, WH context, IP, UA; DB app user with no UPDATE/DELETE grant on `audit_log`; in-process typed domain event emitter + `events` table.
6. Reusable **History tab** component (human-readable timeline) + admin-only global audit browser (basic filters: user, entity, date, WH).
7. Warehouses admin CRUD: code, name, country, type, timezone, batch prefix, letter-sequence state, active flag — fully data-driven (edge case 15 groundwork; edge case 16: all FKs by id, codes are labels only).
8. Clients admin CRUD: unique uppercase code with case-insensitive input, code format validated against the configurable `client_code_prefix` (`GS`+digits, spec §5.2/§17), phones, sales-manager binding, notes, active flag.
9. Users admin CRUD: roles, assigned warehouse(s), UI language, active; no self-registration.
10. Settings module: all §17 keys admin-editable; env config wiring.
11. i18n scaffold (`next-intl`, ru default / uz-Latn / zh-CN), header language switcher, per-user default; UTC storage + WH-local display helpers.
12. File pipeline: S3 signed URLs, client-side compression (≤300 KB), EXIF strip, `sharp` thumbnails (200/800 px) via pg-boss job, tap-to-zoom gallery component.
13. pg-boss setup + job dashboard, `/health`, pino structured logs, GlitchTip/Sentry-compatible error tracking.
14. PWA shell (installable, app-shell caching, splash) + role-aware Home screen with big-button shortcuts.
15. Seed script v1 + CI pipeline (typecheck, unit, Playwright smoke at 360×800).

**Acceptance tests:** none of the 20 §20 scenarios land here; M0 is gated by its "done when" demo plus CI smoke. (Audit infrastructure is exercised by test 17 in M1.)

**Seed data:** warehouses GZ/YW/UCH/KA/AND/TAS1/TAS2 with timezones; one user per role (`demo1234`), operators bound to WHs; 20 demo clients incl. `GS777` (sales manager Dilnoza), `GS102`, `GS205`; letter blacklist `AM`, `XU`; default settings; permission matrix.

**Demo script (phone):** Install the PWA. Log in as admin → create warehouse `TAS3` (Tashkent, `Asia/Tashkent`) → create client `GS900` bound to Dilnoza → create an operator assigned to YW → switch UI language ru→uz→zh → open audit browser and show all three creations with actor + diff. Log in as the new operator and confirm they see only YW-scoped screens.

---

### M1 — Receiving + labels + Telegram (go-live MVP) ✅ DONE

**Goal:** W1 wizard, letter sequencer, box generation, label PDF + reprint, dictionary + translation, unclaimed intake, edit rules + label reconciliation, `ReceiptConfirmed` Telegram, receipt list/detail, stock browser v1, global search v1.
**Done when (spec):** the GS777 demo receipt entered on a phone in < 3 min, labels print, Dilnoza gets the Telegram.

**Tasks:**

1. Schema: `receipts`, `receipt_lots`, `boxes`, `box_movements`, `product_dictionary`; receipt-number generator (`{WH}-IN-{YYMMDD}-{seq}`, per-WH per-day).
2. **Letter sequencer — tests first** (spec §24): ordering A…ZZ, blacklist skip, ZZ→A wrap with cycle_no, `SELECT … FOR UPDATE` concurrency, `letter_scope` config, optional I/O exclusion; then implementation. Blacklist admin screen. (Edge cases 12, 19, 20.)
3. Box short-code generator (`{WH}{YY}-{000000}`, per-WH-per-year, globally unique) + unit tests.
4. Wizard step Client: fuzzy autocomplete (`gs777`→`GS777`), client name + manager avatar confirmation; **unknown-code path** → unclaimed intake (`client=null`, photos mandatory) into per-WH Unclaimed pool (intake half of edge case 2).
5. Wizard step Lots: uniform/mixed dims modes, live volume/density/chargeable-weight computation with color badge, min-1-photo enforcement, supplier attachments, letter preview ("≈ D, E, F"). (Edge case 8.)
6. Translation pipeline: dictionary exact → fuzzy → pluggable API (config provider), cache into dictionary, never block on failure; `(Клавиатура)` inline display; dictionary admin (verify/merge/XLSX import).
7. Wizard step Extra costs: `cost_entries` scope=receipt capture (types from admin list, currency from the `currencies` table with CNY defaulted at China WHs per warehouse country, note, photo) — capture only, allocation deferred to M6. *(As built 2026-07-23: intake captures ONE total amount+currency stored under cost type `other` — per-type rows removed at the owner's request, DECISIONS #50; per-type entry/reclassification deferred to M6.)*
8. Review + Confirm: single transaction — assign letters, generate boxes + movements, emit `ReceiptConfirmed`; idempotent confirm (client UUID).
9. Offline draft autosave: IndexedDB after every field, survives app kill / connection loss, sync banner (edge case 13, receiving half).
10. Label renderer: 100×100 mm PDF per §7 (dominant client-code+letter, QR = short code only, WH-local date, `#UNKNOWN` variant), `LabelRenderer` interface, per-receipt/lot/box reprint with reprint audit.
11. Notifications engine v1: grammY bot, deep-link Telegram account linking, queued sends with retry + delivery status, in-app bell; rules: `ReceiptConfirmed` → sales manager, `UnknownCargoReceived` → logist + admins (§11).
12. Receipt list/detail: edit rules (creator same-WH-day, then manager/logist/admin), void with mandatory reason, **label reconciliation** on box-count change (orphaned/new labels), History tab wired. (Edge case 1.)
13. Stock browser v1: WH → client → lot → box, box timeline view.
14. Global search v1: trigram indexes, grouped results, `/` hotkey, < 300 ms target; recognizes the combined `client-code+letter` query form (`gs777-a` → GS777's lot A, spec §12).
15. Seed the canonical GS777 receipt (A/B/C) + GS102 receipt starting at D; mobile e2e for the 3-lot flow; 3-minute speed check on throttled 3G.

*As built after owner feedback rounds (M1.5–M1.6+, 2026-07-23, DECISIONS #39–55):* the stepper became a **single-window screen** — one compact header card (warehouse+client, one-line source note, single total cost, receipt-level general-box-photos + file buttons with inline thumbs) above the product lines (desktop spreadsheet table / mobile cards, dual-rendered); per-lot note and manual ru inputs removed from intake (ru shows in parentheses via the translation pipeline); stock browser shipped as an Excel-like table with product + general photos opening a `LightboxImg` overlay; local-driver attachments stream bytes directly.

**Acceptance tests:** 1⭐, 2⭐, 3⭐, 4⭐, 5⭐, 6, 7, 8⭐, 17.

**Seed data:** canonical GS777 receipt (化妆品→A, 键盘→B, 鼠标 mixed→C), GS102 receipt starting at D; product dictionary entries for the three demo products; seeded `currencies` (CNY/USD/UZS). (**DECISION:** spec §18's header says the full seed ships with M1, but the batch and cost/FX seed items require M3/M6 schema; the seed script grows with each milestone — receipt items at M1, batches at M3, cost entries + FX at M6 — so every milestone demo has exactly the data it needs.)

**Demo script (phone):** As YW operator, run a full receipt: type `gs777`, add 3 lots (one mixed-mode), snap photos, watch `键盘 (Клавиатура)` appear, confirm — under 3 minutes. Print labels via RawBT to the thermal printer; verify `GS777-A` readable from 2–3 m and QR scans. Check Dilnoza's phone for the Telegram. Then edit lot weight 25→28 kg and show the History tab diff. Enter one receipt with a fake client code and show it landing in the Unclaimed pool. Kill the app mid-wizard, reopen, show the draft survived.

---

### M2 — Stock ops ✅ DONE

**Goal:** Crates (W2), box timeline, voids, wrong-WH receipt move, unclaimed resolution, stale/unclaimed digests, stock report XLSX.
**Done when:** *(not stated in spec)* **DECISION:** done when a crate can be built/dissolved with its own label, an unclaimed receipt can be assigned or returned, a receipt can be moved between WHs, and the stock XLSX exports — all audited and demoed on a phone.

**Tasks:**

1. `crates` schema + crate code generator; Crate builder: select/scan boxes, "Logist approved" checkbox + note, one-client-per-crate validation with clear error, measured final dims/weight, photos. (Edge case 9.)
2. Crate label variant (contents count, `КАРКАС/ЯЩИК` marker) + reprint.
3. Crate-resolution service (crate scan ⇒ member boxes) as a shared primitive for M3–M5 scan modes; crate dissolution (audited).
4. Crating cost entry (type `crating`) linked to receipt/client (capture only).
5. Box status admin flows: `lost` / `void` with reason, manager-only; surfaced in stock browser until resolved. (Edge case 11.)
6. Wrong-WH receipt move: manager moves a whole receipt between warehouses with correcting `box_movements`. (Edge case 15.)
7. Unclaimed resolution: **Assign to client** (reprint labels with new code, notify sales manager, dual-actor audit) + **Return to sender** (handover record → `issued`, reason `returned_to_sender`). (Resolution half of edge case 2.) *(Assign-to-client shipped early in M1.5 — `assignReceiptClient`; M2's remaining scope is the return-to-sender handover flow.)*
8. Scheduled digests: unclaimed > N days + stale-stock, daily 09:00 WH-local via pg-boss cron, Telegram to logist + admin.
9. `exceljs` export infra + Stock report XLSX (current filter applied), stored as attachment.

**Acceptance tests:** 9.

**Seed data:** no new §18 items; add one demo unclaimed receipt and one demo crate to keep the demo self-contained (**DECISION:** minor seed extension beyond §18 for demoability).

**Demo script (phone):** Build a crate from 5 GS777 boxes (tick "Logist approved"), print the crate label, open the crate and see contents. Dissolve it; check audit. Open Unclaimed pool → assign the fake-code receipt from M1's demo to `GS205`, reprint labels showing `GS205`, confirm the sales manager Telegram. Mark one box `lost` with a reason as manager. Move a receipt from YW to GZ and show the corrected movements. Export stock XLSX and open it on the phone.

---

### M3 — Load planning & loading ✅ DONE

**Goal:** Truck presets, plan editor with live gauges + partial counts, versioning + agent approval loop, agent Excel with photos, batch creation + vehicle info, Loading mode (scan, offline outbox, not-on-plan / sticker-lost / duplicate handling), finish-loading deviations, depart + actual manifest, SSE.
**Done when:** *(not stated)* **DECISION:** done when a plan goes draft→v2 approved→batch→scanned load→departed with the actual manifest generated, demoed with a real phone camera scanning printed labels.

**Tasks:**

1. Schema: `batches` (+ per-WH batch code sequence), `load_plans`, plan versions, `load_plan_lines`, `scan_events`, `truck_presets` + presets admin.
2. Plan editor: selection table of `in_stock` lots (client+letter, product, kg/m³, density badge, days-in-stock, photo popover), filters, FIFO sort, **partial box counts**, sticky live footer with kg/m³ progress bars, over-capacity red-but-no-block. (Edge cases 5-prep, 10.)
3. Plan version state machine (`draft→pending_agent→approved|changes_requested→…`), immutable version snapshots, manual agent-verdict recording (comment + screenshot attachment); `PlanChangesRequested`/`PlanApproved` → logist notification rules (§11). (Edge case 7.)
4. Agent approval XLSX with embedded photo thumbnails (exceljs job), stored on the plan version.
5. Approve → batch creation (code e.g. `KA-014`) + `planned` reservation preventing double-planning.
6. Vehicle registration on batch card: plate, driver name/phone, truck photos.
7. Scanner core component: `BarcodeDetector` + `@zxing/browser` fallback + USB/BT HID input, continuous mode, < 300 ms local feedback (vibrate/beep/flash), crate-scan expansion via M2 service.
8. Offline scan outbox: IndexedDB queue, client-generated idempotency UUIDs, server-side dedupe, background sync, visible sync banner. (Edge cases 13 scan-half, 14.)
9. Loading mode screen: running counter `137/220`, per-lot progress, duplicate-scan soft warning, heavy-first sort hint.
10. Not-on-plan flow: red alert, `Load anyway` + reason → `added_on_spot` flag + instant Telegram; logist live-adds lots to the plan; SSE pushes plan/progress updates to the loading phone. (Edge case 6.)
11. Sticker-lost flow: search client+letter → unscanned boxes → mark `manual (sticker lost)` + photo → offer reprint. (Edge case 3, load side.)
12. Finish loading: discrepancy summary — `short_loaded` remainder stays in stock + report + notify (edge case 5); `added_on_spot` list; actual vs plan totals.
13. Depart (logist/manager): batch + boxes → `in_transit`, origin stock decremented, `BatchDeparted` event, **actual manifest XLSX** generated for VED/destination.
14. Batch board kanban (Forming / Loading / In transit / Arrived / Closed) with vehicle/docs/costs tabs.
15. Seed + tests: presets, `YW-001` departed with 50 of lot B, `KA-001` in approval loop; automate 10/11/18.

**Acceptance tests:** 10⭐, 11⭐, 12, 15, 18, 19. (**DECISION:** test 19's final clause — crate cost *allocation* — can only compute once the M6 engine exists; M3 passes the scan-counts-all-18 and cost-capture clauses, and test 19 is re-run in full in the M6 regression suite.)

**Seed data:** truck presets "13.6m tent 90 m³ / 24 t" and "17.5m 130 m³ / 28 t"; batch `YW-001` YW→KA departed with partial load (50 of B); `KA-001` KA→AND in approval loop.

**Demo script (phone/tablet):** As logist on a tablet, build a YW→KA plan: check lot A, take 50 of B's 100, watch the gauges fill; export the agent Excel and open it — photos embedded. Record "changes_requested: remove mice", edit, resubmit v2, approve → batch appears. On the phone, enter truck plate + driver, start Loading mode, scan real printed labels — feel the vibration, watch the counter. Scan a box from another client → red screen → load anyway with reason → logist's phone buzzes. Use "Stikersiz yuk" for one box. Turn on airplane mode, scan 3 boxes, reconnect, verify no duplicates. Finish loading → deviation summary shows the 50 short-loaded. Depart → download the actual manifest XLSX.

---

### M4 — Transfer receiving ✅ DONE

**Goal:** Unload mode (W5), auto-transfer of rogue boxes, missing-in-transit lifecycle, batch close, discrepancy reports, KA hub dashboard.
**Done when:** *(not stated)* **DECISION:** done when unloading YW-001 at KA reconciles a rogue box and a missing box exactly per §6.5, demoed by scanning on a phone.

**Tasks:**

1. Unload mode on incoming batch (reuses M3 scanner core **and offline outbox** — unload scanning fully functional offline per §15): on-manifest scan → `in_stock` at this WH; crate scans accepted.
2. **Auto-transfer** of not-on-manifest-but-known boxes: move to THIS warehouse regardless of recorded location, flag `undocumented_transfer`, correcting movement, logist Telegram. (Edge case 4.)
3. Unknown QR at unload → unknown-cargo mini-intake (form + photo → this WH's Unclaimed pool).
4. Sticker-damaged manual identify at unload (reuse M3 flow). (Edge case 3, unload side.)
5. Finish unload reconciliation: `missing_in_transit` flags (box stays `in_transit`, alerts) + resolution actions "found at origin" / "found here (late scan)".
6. Batch close: arrival timestamp, status `unloaded`/`closed`; cost entries attachable to closed batches (capture; recompute comes in M6 — edge case 17 capture-side).
7. KA hub dashboard + In-transit / Missing-in-transit report; `BatchArrived/Unloaded` and `MissingInTransit`/`UndocumentedTransfer` notification rules.

**Acceptance tests:** 13⭐, 14.

**Seed data:** no new §18 items; seed batch `YW-001` (from M3) arrives at KA in the demo itself.

**Demo script (phone):** At "KA", open incoming `YW-001`, start Unload mode, scan the boxes in. Scan a box that was never load-scanned (simulating loaders skipping the scanner) → accepted, flagged `undocumented_transfer`, logist notified; open its timeline and show the correcting movement. Leave one manifest box unscanned, finish unload → it flags `missing_in_transit`; resolve it as "found at origin" and watch it return to YW stock. Close the batch; check the KA dashboard and discrepancy report.

---

### M5 — Export & UZ side ✅ DONE

**Goal:** VED invoice/packing list generators, customs arrival, distribution "quick batch", ready-for-pickup + client-notify drafts, Issue mode with receiver capture + handover act, sales-manager pipeline view.
**Done when:** *(not stated)* **DECISION:** done when an export batch produces both VED drafts, arrives at AND, clients' cargo turns `ready_for_pickup`, and a partial handover completes on a phone.

**Tasks:**

1. Invoice draft generator (xlsx): configurable header/consignee/stamp block, rows from actual manifest, editable prices/descriptions; versioned storage on batch, "sent to agent" flag + date.
2. Packing list draft generator (xlsx): rows per lot/crate, pieces/kg/m³, totals, truck plate; same storage. VED docs screen (W6).
3. `ready_for_pickup` transition on unload at `customs`/`distribution` WH + auto-drafted per-client arrival summary.
4. **Quick batch** mode: internal AND→TAS / TAS1→TAS2 transfers — create batch + scan-load/unload with no approval loop.
5. Client-notify drafts: `ReadyForPickup`/`BatchArrived` Telegram to sales managers with per-client summary + "Share" button producing uz/ru client message template.
6. Issue mode: select client → `ready_for_pickup` list → scan-out (box or crate, reusing the scanner core + offline outbox — issue scanning works offline per §15) → receiver name/phone + optional photo/signature scribble → `issued`; partial pickup leaves remainder; `BoxIssued` notify; "debt OK" checkbox slot (no logic).
7. Handover act PDF (optional per issue).
8. Sales-manager pipeline view (received → in transit → arrived → issued for own clients).

**Acceptance tests:** 20.

**Seed data:** no new §18 items; the KA→AND export batch (`KA-001` approved during the M3/M4 demos) carries the demo forward.

**Demo script (phone):** As VED, open the export batch → generate invoice + packing list drafts, tweak a price, mark "sent to agent". Unload the batch at AND (W5 flow) → GS777's boxes flip to `ready_for_pickup`; Dilnoza gets the Telegram and taps "Share" to see the ready client message in uz. Run a quick batch AND→TAS1 with scan-load. At TAS1, open Issue mode for GS777, scan out 30 of 90 boxes, capture receiver name + phone + signature scribble, confirm — 60 remain, Dilnoza notified; download the handover act PDF. As Dilnoza, open the pipeline view.

---

### M6 — Costing, reports, polish 🔄 IN PROGRESS

**Goal:** Cost entries + FX + allocation engine (tested with the worked example), all §13 reports, dashboards, digests, performance pass, backups, audit browser filters, docs.
**Done when:** *(not stated)* **DECISION:** done when acceptance test 16 passes automated, all 9 reports export, the 3G budget is met, and the restore test script succeeds.

**Tasks:**

1. FX rates admin (dated manual rates) + cost types admin; batch-scope cost entry UI (any currency → USD by dated rate), attachments. *(Note: since DECISIONS #50, receiving-time costs are captured as a single `other`-type total — this task must also add receipt-scope per-type entry/reclassification so the M6 cost-type breakdowns are meaningful.)*
2. **Allocation engine — tests first**: pure function over all five bases (weight/volume/chargeable/boxes/direct), the §6.9 worked example (box P = 90 CNY-equiv; box Q differs), per-entry dated USD conversion; then implementation.
3. Idempotent recompute job triggered on any cost or FX edit, fully audited. (Edge cases 17, 18 — late costs on closed batches and rate corrections both flow through this path.)
4. Cost reports: batch cost sheet (entries + per-kg/per-m³ unit cost), landed cost by client/lot and by batch, unclaimed-cost warnings (departed > N days with 0 costs).
5. Remaining §13 reports + XLSX export: receipts journal, batch register with deviations, in-transit / missing-in-transit, **unclaimed cargo**, client cargo history (full journey), staff activity (from audit), label reprint log.
6. Role-aware dashboards with recharts charts (spec §3): admin/logist (stock, in-transit, today's receipts, unclaimed, aging, discrepancies), WH staff (own WH + tasks), sales manager (client pipeline).
7. Notification digest polish: per-user mute settings, admin delivery-failure view.
8. Performance & UX pass: 3G P75 < 3 s budget, list virtualization > 100 rows, thumbnails-first audit, CN-access checklist (no external CDNs, < 5 s from CN), high-contrast check for bright warehouse light on all operator screens (§15).
9. Reliability: nightly `pg_dump` to object storage (30-day retention), weekly restore-test script, bucket versioning.
10. Admin audit browser advanced filters; `README` + ops runbook; full-suite regression incl. re-running test 19 with allocation live.
11. **Warehouse capacity indicator** (owner request, feedback round 5): optional `capacity_m3` per warehouse (admin-editable); occupied m³ from in-stock boxes; fill-percentage bar on the dashboard/home that goes yellow→red as the warehouse fills so the logist sees when to ship.
12. **Inventory / stocktake mode** (owner request, feedback round 5): warehouse staff scan every box in the warehouse; a reconciliation screen shows (a) boxes recorded elsewhere but scanned here → move here with a correcting movement, (b) boxes expected here but not scanned → manual confirm list (mark found/lost); full audit trail; XLSX report of discrepancies.
13. **Sortable table columns** (owner request, feedback round 5): click-to-sort headers on the big tables (stock browser, receipts journal, batch board lists) — server-side via URL params so sorting composes with filters and pagination.

**Acceptance tests:** 16⭐ (plus full regression of 1–15, 17–20).

**Seed data:** cost entries + FX rates matching the §6.9 worked example (YW-001 freight 10,000 CNY / GZ-001 leg / KA-001 freight 40,000 CNY).

**Demo script (phone/desktop):** Enter KA-001 freight cost 40,000 CNY with today's FX rate; open box P's card → landed cost 90 CNY-equiv in USD, box Q shows a different figure; edit the FX rate and watch both recompute (with audit). Open the batch cost sheet and per-client landed cost report; export to XLSX. Browse the dashboard as admin, then as Dilnoza. On the phone over throttled 3G, load the stock browser and confirm it feels fast. Run the restore-test script and show it green.

---

### Dependencies & critical path

**Critical path:** M0 (auth/RBAC/audit/files) → M1 (letter sequencer + boxes are prerequisites for everything downstream) → M3 (scanner core + scan_events + batches) → M4 (unload reuses the scanner) → M5 (issue reuses the scanner; VED needs M3's actual manifest) → M6 (allocation needs scan_events history from M3–M5 to know which boxes rode which batches). M2 is the only slack: crates and unclaimed-resolution can overlap with early M3, **but** the crate-resolution service (M2 task 3) must land before M3 task 7 (scanner core expands crate scans), and exceljs infra (M2 task 9) is reused by M3's agent Excel. The three shared primitives to get right early: the scanner component (M3, reused in M4/M5), the notification engine (M1, rules added every milestone), and exceljs/PDF generation (M1–M2, reused through M6). Cost *capture* is deliberately spread across M1/M2/M4 with computation deferred to M6 — no milestone blocks on the allocation engine.

### Edge-case coverage map (spec §14)

| # | Edge case | Milestone | Implementing feature (task) |
|---|-----------|-----------|------------------------------|
| 1 | Operator typo after confirm | M1 | Edit rules + label reconciliation (M1-12) |
| 2 | Unknown client code | M1 → M2 | Unclaimed intake (M1-4); assign/return resolution (M2-7) |
| 3 | Sticker lost/damaged | M3 / M4 | Manual identify + reprint at load (M3-11) and unload (M4-4) |
| 4 | Loaders load without scanning | M4 | Auto-transfer of rogue boxes at unload (M4-2) |
| 5 | Truck too small (short-load) | M3 | Finish-loading `short_loaded` flow (M3-12) |
| 6 | Truck has spare room | M3 | On-spot additions + logist live plan edit via SSE (M3-10) |
| 7 | Agent rejects part of plan | M3 | Plan versioning + re-approval loop (M3-3) |
| 8 | Mixed/odd boxes | M1 | Lot "mixed" dims mode (M1-5) |
| 9 | Fragile goods | M2 | Crate builder + crate-level tracking + crating cost (M2-1..4) |
| 10 | Cargo split across trucks | M3 | Partial plan lines (M3-2); per-box batch history keeps M6 costs correct |
| 11 | Box physically vanishes | M2 | `lost` status, manager-only, reported (M2-5) |
| 12 | Two operators receive simultaneously | M1 | Transactional letter sequencer with row lock (M1-2) |
| 13 | Offline warehouse | M1 / M3 | Receipt draft autosave (M1-9); offline scan outbox (M3-8) |
| 14 | Duplicate/late scan sync | M3 | Client UUID idempotency + server dedupe (M3-8) |
| 15 | Wrong-warehouse receipt | M2 | Manager receipt move with correcting movements (M2-6) |
| 16 | Client code renamed/merged | M0 | FKs by id, codes as labels (M0-7/8 data model) |
| 17 | Batch cost arrives weeks later | M6 | Costs on closed batches (captured M4-6) + recompute job (M6-3) |
| 18 | FX rate corrected | M6 | Dated rates + idempotent recompute (M6-1/3) |
| 19 | ZZ letter reached | M1 | Sequencer wrap + cycle_no (M1-2) |
| 20 | Blacklisted letter combos | M1 | Sequencer blacklist skip + admin list (M1-2) |

### Acceptance-test → milestone summary

| Milestone | Scenarios (⭐ = automated) |
|-----------|---------------------------|
| M0 | — (gated by done-when demo + CI smoke) |
| M1 | 1⭐ 2⭐ 3⭐ 4⭐ 5⭐ 6 7 8⭐ 17 |
| M2 | 9 |
| M3 | 10⭐ 11⭐ 12 15 18 19 (19's allocation clause re-verified in M6 — see DECISION) |
| M4 | 13⭐ 14 |
| M5 | 20 |
| M6 | 16⭐ + full regression |

---

## Testing & quality strategy

Test pyramid: many fast pure-function unit tests (Vitest) for the business rules the owner cares most about (letters, costing, codes, math), a thin layer of DB-backed integration tests for transactional invariants, and a small set of Playwright e2e flows at the mobile viewport for the starred acceptance scenarios that are inherently UI/multi-step. Spec 24 mandates test-first for the letter sequencer and cost allocator — those suites are written before their implementations.

### 1. Unit tests (Vitest, pure functions, no DB)

All four target modules are implemented as pure functions/classes (`modules/wms/domain/*`) precisely so they are unit-testable without Postgres. Concurrency behavior that requires real row locking is covered in integration tests (see §2); the unit layer tests the sequencing *logic* against an injected in-memory state.

**Suite `letter-sequencer.test.ts`** (spec 5.3, acceptance 1–4)

| Test | Assertion |
|---|---|
| `orders A..Z then AA..ZZ` | `next('A')='B'`, `next('Z')='AA'`, `next('AZ')='BA'`, `next('ZY')='ZZ'`; full 702-step sequence snapshot |
| `continues across receipts` (⭐1) | state after `C` → two new lots get `D`, `E` |
| `skips blacklisted combos` (⭐2) | with blacklist `[AM, XU]`: `next('AL')='AN'`, `next('XT')='XV'`; consecutive blacklist entries all skipped |
| `admin-extended blacklist respected` | blacklist is a parameter, not a constant — adding `AB` at runtime skips it |
| `ZZ wraps to A and bumps cycle_no` (⭐3) | `next('ZZ') = {letter:'A', cycle_no: n+1}`; letters render identically regardless of cycle |
| `blacklisted first letter after wrap` | if `A` were blacklisted, wrap lands on `B` (guards the wrap+skip interaction) |
| `optional I/O exclusion` | with `exclude_ambiguous_letters=true`, `H`→`J`; default off → `H`→`I` |
| `multi-lot allocation is contiguous` | confirming a 3-lot receipt from state `C` yields exactly `[D,E,F]` in lot order |
| `concurrency via parallel confirms` | two allocators sharing one serialized state source (mutex-simulated) never emit the same letter; N=100 parallel confirms → 100 distinct letters in sequence order. *(Logic-level check; the real `SELECT … FOR UPDATE` guarantee is integration test I-2.)* |

**Suite `cost-allocation.test.ts`** (spec 6.9, acceptance 16)

| Test | Assertion |
|---|---|
| `spec 6.9 worked example` (⭐16, named `worked_example_box_P_and_Q`) | YW-001 freight 10,000 CNY / 10,000 kg + KA-001 40,000 CNY / 20,000 kg; box P (30 kg) landed cost = 30 + 60 = 90 CNY-equivalent; box Q (same KA-001, arrived via GZ-001 with different rate) gets a different total |
| `basis: weight` | share = box_kg / Σ batch kg × entry USD amount |
| `basis: volume` | share by m³ |
| `basis: chargeable` | share by `max(kg, m³×167)` per box, factor injectable |
| `basis: boxes` | equal split per box count |
| `basis: direct_to_client` | full amount to the named client's boxes only; boxes of other clients on the batch get 0 |
| `FX-dated conversion` | two CNY entries on different dates with different `fx_rates` convert independently; changing a rate changes only entries dated to it |
| `journey summation` | box landed cost = receipt-scope shares + Σ shares of every batch it rode (uses P's two-leg journey) |
| `recompute idempotency` | running allocation twice over identical inputs yields byte-identical results; editing one entry and recomputing changes only affected boxes |
| `rounding invariant` | Σ per-box shares = entry total to the cent (largest-remainder distribution). **DECISION:** spec is silent on cent rounding; allocate with largest-remainder so totals always reconcile — record in DECISIONS.md |
| `empty/zero guards` | entry on a batch with 0 kg total (weight basis) → error/unallocated flag, never NaN |

**Suite `code-generators.test.ts`** (spec 5.2)

- Receipt no: `YW-IN-260722-003` format; seq resets per WH per day; date rendered in WH-local timezone (a UTC instant near midnight Shanghai lands on the correct local date).
- Box short code: `YW26-000123` — zero-padded 6 digits, per-WH-per-year sequence, year rollover `YW26`→`YW27` restarts sequence; **DECISION:** year = WH-local year at generation time.
- Crate code: `CR-KA26-00012` — 5-digit pad, same per-WH-per-year rule.
- Batch code: `YW-001` — per-origin-WH sequence, 3-digit pad, custom admin prefix respected.
- Round-trip: every generated code parses back to its components (needed by scan resolution).

**Suite `weight-density.test.ts`** (spec 4.6, acceptance 5)

- ⭐5 named test `uniform_lot_math`: 10 × (50×50×50 cm, 25 kg) ⇒ volume 1.25 m³, weight 250 kg, density 200 → green badge.
- Volume formula `L×W×H/1,000,000 × count`, NUMERIC(12,4) precision (no float drift on e.g. 33×33×33).
- Chargeable weight `max(kg, m³×167)` both branches; factor configurable.
- Density badge thresholds: boundary values 199.99/200/300/400 map 🔵/🟢/🟠/🔴 per spec ("heavy ≥ 400", "light < 200"); thresholds injectable. **DECISION:** boundaries inclusive on the lower edge of each named band (200–300 green includes 200, 300–400 orange includes 300, ≥400 red).
- Mixed mode: density from entered totals directly; zero-volume guard.

### 2. Integration tests (Vitest + real Postgres, transaction-per-test)

Run against a disposable Postgres (Testcontainers locally, service container in CI), migrations applied, minimal fixtures via factories (§4).

| ID | Test | Invariant proven |
|---|---|---|
| I-1 | Receipt confirmation transaction | one `confirm()` call atomically: assigns letters, creates N `boxes` with sequential short codes, writes `box_movements`, inserts `ReceiptConfirmed` into `events`, flips status `draft→confirmed`. Failure injected mid-way (e.g. FK violation on a lot) rolls back everything — no letters consumed, no boxes created |
| I-2 | Concurrent confirm (⭐4, the real test) | two confirms executed in parallel connections against the same YW row; `SELECT … FOR UPDATE` serializes them; resulting letters are disjoint and contiguous. Also: voiding a receipt does not return letters |
| I-3 | Plan reservation | approving plan v_n sets selected boxes to `planned`; a second plan cannot select the same boxes (partial counts: 50 of 100 reserved, other 50 remain selectable — ⭐10 data layer); cancelling the plan releases reservations |
| I-4 | Scan idempotency | inserting two `scan_events` with the same `client_event_uuid` results in one row / one movement (unique constraint + upsert path); replaying an offline outbox of 20 events twice yields exactly 20 events (edge cases 13–14, acceptance 18 data layer) |
| I-5 | Auto-transfer on rogue unload scan (⭐13 data layer) | box recorded `in_stock` at YW, unload-scanned on a KA-bound batch at KA ⇒ box `current_warehouse_id=KA`, `in_stock`, flag `undocumented_transfer`, correcting `box_movements` row with cause `auto-transfer`, `UndocumentedTransfer` event emitted |
| I-6 | Audit immutability | app DB role gets a Postgres error on `UPDATE`/`DELETE` against `audit_log` (spec 4.3) |
| I-7 | Recompute job idempotency (DB level) | running the allocation job twice produces identical stored per-box costs; FX rate edit triggers changed values only for affected entries |

### 3. E2E (Playwright, 360×800 mobile viewport default; desktop project only for plan editor)

E2E covers only what unit/integration cannot: full user flows through the real UI. Mapping of the starred acceptance scenarios:

| ⭐ Scenario | Level | E2E flow (if e2e) |
|---|---|---|
| 1 Letters continue | unit + integration (I-1/I-2); letter *display* checked incidentally in E2E-1 | — |
| 2 Blacklist skip | unit only | — |
| 3 ZZ wrap | unit only (state seeded to `ZZ` is impractical via UI) | — |
| 4 Concurrent confirm | integration (I-2) | — |
| 5 Uniform lot math | unit; live-computed values also asserted in E2E-1 | — |
| 8 Telegram on receipt | integration-ish: assert a queued pg-boss job addressed to Dilnoza's chat id with correct lot summary (Telegram API mocked); E2E-1 asserts the in-app notification appears | — |
| 10 Partial plan | **E2E-2** (desktop project): create plan YW→KA, set 50 of lot B's 100, gauges show Σkg/Σm³ %, approve, verify 50 boxes `planned` / 50 `in_stock` in stock browser | ✅ |
| 11 Not-on-plan scan | **E2E-3** (mobile): Loading mode with camera mocked (inject scan codes via test hook / keyboard-wedge input path), scan on-plan box → counter increments; scan foreign box → red "Rejada yo'q!" → "Load anyway" + reason → flagged `added_on_spot` in finish summary | ✅ |
| 13 Rogue box at unload | **E2E-4** (mobile): Unload mode, scan a box recorded at YW → accepted, warning shown; box timeline shows auto-transfer correction; (server behavior already proven in I-5, e2e proves the UX) | ✅ |
| 16 Landed cost example | unit (worked example) + I-7; **E2E-5** (smoke): open batch cost sheet for seeded KA-001, assert per-kg unit cost figure renders | ✅ (thin) |

Plus two flows not starred but load-bearing:

- **E2E-1 — Receiving happy path (mobile, the M1 smoke test):** login as YW operator → New Receipt wizard → client `gs777` autocompletes to GS777 → add uniform lot (10×50×50×50 @25 kg, assert live 1.25 m³ / 250 kg / green badge) → photo upload (fixture file) → confirm → assert letters shown, label PDF download triggered, receipt in list.
- **E2E-6 — Offline outbox (acceptance 18):** Loading mode → `context.setOffline(true)` → 3 scans queue with sync banner → back online → synced once, no duplicates.

Camera scanning is not driven through a real camera in CI: the scanner component exposes the HID/manual-entry input path (spec 3 already requires keyboard-wedge support), and e2e drives that. **DECISION:** e2e scan simulation uses the HID input path rather than mocking `BarcodeDetector` — it exercises the same downstream code and is deterministic.

### 4. Test data / fixtures strategy

- **Factories, not seed reuse, for unit + integration.** Small typed factory functions (`makeWarehouse()`, `makeClient()`, `makeReceiptWithLots()`, `makeBatchWithCosts()`) with sensible defaults and overrides, living in `modules/*/test/factories.ts`. Each integration test builds only what it needs inside its own transaction — no ordering coupling, parallel-safe.
- **The seed script is itself under test.** One integration test runs the full seed (spec 18) and asserts the canonical GS777 receipt (letters A/B/C, next = D) and the 6.9 cost figures exist. This keeps seed and spec example from drifting.
- **E2E runs against the seed**, because the spec makes seed data the demo contract ("Done when the GS777 demo receipt…"). E2E setup = fresh DB + migrate + seed per run; tests that mutate state use dedicated seed clients (`GS205`+) to avoid cross-test interference.
- Shared constants (worked-example numbers, density thresholds) live in one fixtures module imported by unit tests, seed script, and e2e assertions — single source of truth for the magic numbers.

### 5. CI pipeline (GitHub Actions)

| Stage | Runs on | Notes |
|---|---|---|
| 1. Typecheck (`tsc --noEmit`, strict) | every push + PR | fail fast, no services |
| 2. Lint + format check (ESLint, Prettier) | every push + PR | parallel with stage 1 |
| 3. Unit tests (Vitest) | every push + PR | pure, no services, < 1 min budget |
| 4. Integration tests (Vitest + `postgres:16` service container) | every PR + main | migrations applied in step; also verifies migrations run clean from zero |
| 5. E2E smoke (Playwright, chromium, mobile project) | every PR + main | E2E-1 always; full e2e suite (E2E-2..6) on main and nightly — spec 15 asks for "e2e smoke" in CI, so PRs stay fast |
| 6. Build (`next build`) + Docker image build | PR (build only) / main (build + image) | image push on main only |

Stages 1–3 gate 4–6; 4 and 5–6 run in parallel after. Nightly scheduled job: full e2e + seed-from-scratch + (from M6) the weekly restore-test script dry run.

### 6. Definition of Done — every milestone (M0–M6)

A milestone is done only when all of:

1. **Tests green:** all unit + integration + e2e suites pass in CI, including the new suites this milestone introduces (per spec: M1 must land the letter-sequencer suite; M6 the allocation suite with the 6.9 named test; the starred scenarios reachable at that milestone are automated).
2. **Seed updated and runs from zero:** `pnpm seed` on an empty DB produces the spec-18 dataset covering the milestone's features; the seed integration test passes.
3. **CHANGELOG.md entry** written for the milestone (spec 0); any interpretation calls appended to **DECISIONS.md**.
4. **Mobile check:** every new operational screen manually verified at 360×800 (no horizontal scroll, ≥48 px targets) and the milestone's e2e flows pass in the 360×800 Playwright project; owner demos on a real Android phone before approval (spec 0).
5. **Migrations checked in** and applied cleanly by CI stage 4 from an empty database.

Per-milestone test focus: M0 → auth/RBAC integration + I-6 audit immutability; M1 → letter suite, code-generator suite, weight/density suite, I-1/I-2, E2E-1; M2 → crate constraints (one client per crate) integration; M3 → I-3, I-4, E2E-2/3/6; M4 → I-5, E2E-4; M5 → issue/handover integration + partial pickup; M6 → cost-allocation suite, I-7, E2E-5, performance pass.

---

## Open questions for the owner

*(Status 2026-07-23 (evening): Q1 ANSWERED — owner supplied a bot token, DECISIONS #26. Q2 ANSWERED — LibreTranslate default with a pluggable provider, DECISIONS #25. Q4 ANSWERED — owner uploaded the real ka23 invoice file; all requisites (sender/seller/consignee/transport/delivery/customs post) captured as editable `ved_*` settings, DECISIONS #89. Q5 ANSWERED — recommended wording accepted. Q3 (hosting/VPS) is the ONLY one still open — deferred until dev wraps; the app currently runs on the owner's Windows machine via `pnpm start` / `start:https`.)*

1. **Do you already have a Telegram bot (token) we can use, or should we create a new bot now?**
   *Why it matters:* M1's "done" criterion includes a real Telegram message to the sales manager; dev can run against a stub, but the M1 demo on a phone needs a live bot.
   *Recommended answer:* Create a fresh bot via @BotFather today (2 minutes); dev uses a test bot until then.

2. **Which zh→ru translation provider should we use, and can you obtain the API key (billing may need a card)?**
   *Why it matters:* Provider choice affects config and cost; DeepL has no ru target restrictions but limited zh handling nuances, Yandex is cheap and strong for ru, Google needs a GCP account. The flow never blocks without it, but M1 acceptance test 6 needs a working key.
   *Recommended answer:* Yandex Translate (good zh→ru quality, simple pricing); keep the provider pluggable as specced.

3. **When will the VPS be available, and do you approve a Hong Kong region (e.g., Alibaba/Tencent HK) at roughly $20–40/month?**
   *Why it matters:* Development proceeds locally regardless, but the China-access requirement (page load < 5 s from GZ/YW without VPN) can only be verified on real HK/SG hosting, ideally before M1 goes live to warehouses.
   *Recommended answer:* Order an Alibaba Cloud HK instance during M0–M1 so M1 can be field-tested from a China warehouse.

4. **What company details go on customs documents and labels: exact legal name, address, logo, and the usual consignee/buyer block for invoices?**
   *Why it matters:* Invoice/packing-list templates (W6) and the label footer print these; placeholders work for dev, but VED documents handed to the export agent must carry real data before M5.
   *Recommended answer:* Send a sample of one real invoice + packing list you use today; we replicate its header/consignee layout as the template defaults.

5. **At Andijan (AND), may sales managers be notified "cargo ready for pickup" immediately at truck unload, or only after customs clearance is finished?**
   *Why it matters:* The system does not track customs clearance in Phase 1; if clients are pinged at unload but customs takes days, managers get premature "come pick up" prompts. This changes when the `ReadyForPickup` notification fires.
   *Recommended answer:* Notify at unload but word the AND message template as "arrived, undergoing clearance — we will confirm pickup"; a one-tap manual "cleared — notify now" button can be added if needed.
