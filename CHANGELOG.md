# CHANGELOG

## Owner feedback round 3 — 2026-07-23

- **Photos fixed**: attachments are now streamed directly by the server instead of redirecting to an absolute URL — the redirect host could differ from the one the browser used (phone on LAN → `localhost` → broken images). Correct content type is set too.
- Receiving: per-line note field removed (only the receipt-level note remains); warehouse+client, general box photos, note, files and costs all live in ONE top panel.
- New: general box photos (receipt-level) with camera upload in receiving, shown in the stock list next to the product photo (amber border) — both open in a tap-to-zoom popup instead of navigating away.
- Russian translation no longer has its own column/field — it shows in parentheses under the Chinese name.
- "Need at least 1 photo" text replaced with a compact ⚠️ icon.
- Mixed-mode line entry order is now m³ first, then kg.

## UI cleanup — receive screen — 2026-07-23

- Receive page reorganized into three aligned panels on every screen size: client/warehouse card → product lines → note/files/costs card, with the sticky totals bar below. No more scattered blocks.
- Desktop table now fits the page without hidden horizontal scroll (per-line Σ totals and delete are visible); tighter column widths, compact cell inputs, wider page container.
- Client and bottom panels are rendered once and shared by both layouts (previously duplicated for desktop/mobile, which also produced duplicate element ids).
- Mobile keeps stacked cards with labeled dims grid; same visual language (cards, compact inputs) as desktop.

## M1.6 — Excel-style desktop entry, notes, receipt files — 2026-07-23

- Desktop (md+ viewport): product lines are now a real spreadsheet-style table — one row per lot, tab through cells like Excel (product zh/ru, boxes, dims, note, photos, live totals) — matches the owner's request to enter receipts "like filling an Excel sheet" on a computer.
- Mobile: unchanged stacked-card layout (kept mobile-friendly per owner's request).
- Replaced the "pieces" (shtuk) field with a free-text **note** per line (owner's Kashgar file uses remarks like "loader miscounted", not a pieces count) — schema column swap (pieces_count/packaging_type → note), service/edit/UI updated.
- Added **receipt-level file attachments** (any type — invoice, packing list, supplier docs, not just box photos) via a shared AttachmentsPanel component, persisted in the draft so they survive reload; shown on the receipt detail page too.
- Costs + notes are no longer hidden behind a collapsed accordion — attachments, costs, and the source note are all visible together in one open section, as requested.
- Fixed a missing i18n key (receive.attachments) caught during visual verification.
- e2e updated for the responsive layout (scoped locators to the visible container) and extended to cover the new note field end-to-end.

## M1.5 — Owner feedback round — 2026-07-23

- Single-window receiving (owner's request): client + Excel-style product lines + collapsed costs + sticky totals/confirm on one screen; no more stepper.
- Excel-like stock table (mirrors the owner's Kashgar file): photo thumbnail, code+letter, product zh(ru), boxes, kg/box, Σkg, m³, density badge, pieces, WH, date; warehouse + text filters; totals row.
- Lot fields from the real file: pieces count and packaging type (optional).
- Unclaimed cargo now captures the marking written on boxes; labels print MARKING-letter instead of #UNKNOWN; assign-to-client (or change-client) action notifies the new client's sales manager.
- Lot editing after confirm per spec 4.4: operator same warehouse-day, manager/logist/admin anytime; box-count changes do label reconciliation (new labels to print / labels to destroy listed); structural fields lock once boxes are in motion.
- Client code validation relaxed to any 2–10 alphanumerics (real codes are 444/555/GS277); auto-generation still uses the GS prefix.
- Fixes: server no longer dies permanently if the DB is briefly unreachable at boot (workers retry in background); wizard uses uuid lib instead of crypto.randomUUID (which is missing on non-HTTPS LAN origins — phone testing over Wi-Fi); photo thumbnails retry with the original variant on error.
- e2e updated: single-window receipt flow + unclaimed-marking intake (5/5 green).

## M1 — Receiving + labels + Telegram — 2026-07-22

- Client code auto-generation: empty code on create ⇒ next sequential code for the configured prefix (advisory-lock protected); manual duplicates still rejected (owner's request).
- Schema: receipts, receipt_lots, boxes, box_movements, product_dictionary, cost_types, cost_entries, counters; trigram indexes for search.
- Letter sequencer (spec 5.3): pure A…ZZ logic with blacklist skip, ZZ→A wrap + cycle_no, optional I/O exclusion — 10 unit tests; transactional assignment under warehouse row lock with a concurrency integration test (acceptance tests 1–4).
- Code generators: receipt numbers ({WH}-IN-{YYMMDD}-{seq}, per-WH-local-day) and box short codes ({WH}{YY}-{000000}, per-WH-year) via lock-safe counters.
- W1 receiving wizard (mobile stepper Client→Lots→Costs→Review→Confirm→Print): fuzzy client autocomplete, unknown-code → unclaimed intake, uniform/mixed lots with live volume/density badge/chargeable weight (acceptance test 5), min-1-photo with client-side compression, letter preview, extra costs with CNY default at CN warehouses, localStorage draft autosave surviving app kill.
- Confirm transaction: letters + boxes + movements + ReceiptConfirmed/UnknownCargoReceived event in one transaction, idempotent by client-generated receipt UUID.
- Label PDF (spec §7): 100×100 mm, dominant client-code+letter, QR = short code, WH-local date, #UNKNOWN variant, embedded subset CJK font (Noto Sans SC); per-receipt/lot/box reprint with audit.
- zh→ru translation pipeline: dictionary exact → trigram fuzzy → pluggable API (LibreTranslate default), cached back into the dictionary; never blocks receiving.
- Notifications: event fan-out to in-app rows + Telegram via pg-boss with retry; grammY bot with /start deep-link account linking from the profile; ReceiptConfirmed → sales manager, UnknownCargoReceived → logist+admins.
- Screens: receipt list/detail (void with reason, per-lot reprint, History tab, photos), stock browser WH→client→lot→box with full box timeline, unclaimed pool, global search incl. the combined gs777-a form.
- Seed: canonical GS777 receipt (化妆品→A 250 kg/1.25 m³, 键盘→B, 鼠标 mixed→C), GS102 → D, cost types, dictionary entries — idempotent.
- Tests: 34 unit/integration + 4 Playwright mobile e2e (incl. the full receiving flow with photo upload and PDF check).

## M0 — Platform foundation — 2026-07-22

- Next.js 15 + strict TypeScript scaffold; pnpm workspace; Tailwind; docker-compose (app/postgres/minio/backup) for deploys.
- Drizzle schema + migrations: users, sessions, login_attempts, RBAC tables, warehouses (with letter-sequencer state), clients, settings, currencies, fx_rates, letter_blacklist, audit_log (append-only, DB-level immutability trigger + revoked grants), events, notifications, telegram_links, attachments; pg_trgm + trigram indexes.
- Auth: phone/username + Argon2id, httpOnly 30-day rolling sessions in Postgres, 5/15min rate limiting, device list + "logout other devices".
- Data-driven RBAC seeded from the §16 matrix; single `authorize()` server-side gate with warehouse scoping.
- Audit write path (changed-fields before/after diff) on every mutation; reusable History tab; admin global audit browser with filters; domain-event emitter + events table.
- Admin CRUDs: warehouses, clients (code validated against `client_code_prefix`), users (roles + warehouse binding); settings editor for all §17 keys.
- i18n: next-intl with ru/uz/zh-CN catalogs, per-user locale, header switcher.
- Files: storage abstraction (S3/MinIO + signed local-disk dev driver), upload API, sharp 200/800px thumbnails via pg-boss, photo gallery component.
- PWA: manifest + icons + Serwist app-shell caching; role-aware Home with big-button shortcuts; high-contrast UI, no horizontal scroll at 360px.
- Observability: pino logs, `/health`, pg-boss started via instrumentation hook.
- Seed: 7 warehouses, 11 users (one per role, `demo1234`), 20 clients (GS777→Dilnoza), currencies, blacklist AM/XU, settings, permission matrix.
- Tests: 15 unit (audit diff, RBAC matrix, client-code format) + 3 Playwright mobile e2e (login guard, admin CRUD + audit flow, warehouse-scope isolation); GitHub Actions CI (typecheck, lint, unit, migrate+seed, build, e2e).

## Planning stage — 2026-07-22

- Added `docs/SPEC.md` — the Phase 1 WMS build specification (single source of truth).
- Added `docs/ARCHITECTURE.md` — application architecture + complete PostgreSQL/Drizzle schema design for all milestones.
- Added `docs/PLAN.md` — M0–M6 task breakdown, acceptance-test mapping, edge-case → milestone table, testing strategy, and open questions for the owner.
- Added `DECISIONS.md` — 24 pre-implementation ambiguity resolutions.
- No application code yet — implementation starts with M0 after owner approval.
