# GSR LOGISTICS WMS — Architecture (Phase 1)

> Companion to [SPEC.md](./SPEC.md). Pre-implementation architecture: application structure first, then the full database schema. Ambiguity resolutions live in [DECISIONS.md](../DECISIONS.md).

---

## Application architecture

### A1. Repository layout

Single pnpm workspace containing one Next.js 15 App Router application plus small support packages. One deployable app — modularity lives in the `src/modules` folder structure, not in separate services (spec 2, 15 "no premature microservices").

```
gsr-erp/
├── pnpm-workspace.yaml
├── docker-compose.yml               # app, postgres, minio, backup cron (see A17)
├── DECISIONS.md / CHANGELOG.md
├── packages/
│   └── config/                      # shared eslint, tsconfig, prettier presets
└── apps/web/                        # the Next.js 15 app (only deployable)
    ├── drizzle/                     # generated SQL migrations (checked in)
    ├── public/                      # PWA icons, manifest, self-hosted static assets
    ├── assets/fonts/                # self-hosted UI fonts + CJK label font (NotoSansSC subset)
    ├── messages/                    # next-intl: ru.json, uz-Latn.json, zh-CN.json
    ├── e2e/                         # Playwright specs (mobile viewport first)
    └── src/
        ├── app/                     # App Router: routes ONLY, thin
        │   ├── (auth)/login/
        │   ├── (app)/               # authenticated shell: home, receipts, stock, plans,
        │   │   │                    # batches, scan/[mode], unclaimed, costs, reports, admin
        │   │   └── ...
        │   ├── api/
        │   │   ├── health/route.ts
        │   │   ├── sse/[channel]/route.ts
        │   │   ├── telegram/webhook/route.ts
        │   │   ├── sync/route.ts            # offline outbox batch endpoint
        │   │   └── attachments/[id]/route.ts # authz + direct byte streaming (local driver) / signed-URL redirect (S3)
        │   ├── manifest.ts / sw.ts          # PWA (Serwist)
        │   └── layout.tsx
        ├── modules/
        │   ├── platform/            # cross-module core (spec 4)
        │   │   ├── auth/            # sessions, argon2, rate-limit, devices, PIN re-lock
        │   │   ├── rbac/            # authorize(), permission tables, scoping
        │   │   ├── audit/           # audit writer + history-tab query API
        │   │   ├── users/ clients/ warehouses/ settings/
        │   │   ├── notifications/   # in-app center + Telegram dispatch rules
        │   │   ├── telegram/        # grammY bot, deep-link linking
        │   │   ├── files/           # S3 client, signed URLs, thumbnail jobs
        │   │   ├── events/          # typed event bus + events table + subscriber registry
        │   │   ├── jobs/            # pg-boss bootstrap, job type registry, handlers index
        │   │   ├── i18n/            # locale config, WH-local time/format utils
        │   │   ├── translation/     # TranslationProvider abstraction + dictionary cache
        │   │   ├── money/           # NUMERIC helpers, FX conversion, chargeable weight
        │   │   └── search/          # global search service (trigram queries)
        │   └── wms/
        │       ├── receiving/       # W1 wizard actions, receipt service, letter sequencer
        │       ├── lots-boxes/      # box lifecycle, movements, status machine
        │       ├── crates/          # W2
        │       ├── planning/        # W3: plans, versions, truck presets, agent Excel
        │       ├── batches/         # batch lifecycle, depart/arrive, manifest
        │       ├── scanning/        # W4/W5/W8 scan processing, idempotency, discrepancies
        │       ├── unclaimed/       # W7
        │       ├── costing/         # W9: cost entries, FX-dated conversion, allocation engine
        │       ├── documents/       # exceljs/pdf-lib builders (manifest, invoice, packing list, acts)
        │       ├── labels/          # LabelRenderer interface + PdfLabelRenderer
        │       └── reports/         # section 13 queries + XLSX export
        ├── db/
        │   ├── schema/              # Drizzle schema split per module (platform.ts, wms.ts)
        │   ├── client.ts            # drizzle instance
        │   └── seed.ts
        ├── lib/                     # framework glue: safe-action wrapper, sse helper, zod utils
        ├── components/              # shared UI (scanner shell, density badge, history tab, gallery)
        └── offline/                 # IndexedDB outbox, sync engine, sw registration client code
```

Per-module internal convention (enforced by ESLint import rules):

```
modules/<m>/<feature>/
  actions.ts      # server actions ("use server") — transport layer only
  service.ts      # business logic, transactions, event emission
  repo.ts         # Drizzle queries for this feature
  schemas.ts      # zod input/output schemas (shared with client forms)
  jobs.ts         # pg-boss handlers owned by this feature
  events.ts       # domain event types this feature emits
  components/     # feature UI
  __tests__/      # Vitest unit tests colocated
```

Cross-module rule: `wms` may import from `platform`; `platform` never imports from `wms`; future `crm`/`finance` import `platform` and subscribe to `wms` events — never call `wms` services directly.

DECISION: single Next.js app in `apps/web` with a tiny `packages/config`; no separate `packages/domain` yet — extraction is cheap later, and one app keeps M0–M6 velocity high.

### A2. Layering rules

```
Route handler / Server action  →  Service  →  Repo (Drizzle)  →  Postgres
        (transport)               (domain)      (persistence)
```

Enforced responsibilities per layer:

1. **Transport (actions.ts / route.ts)** — parse & validate input with **zod** (`schemas.ts`), resolve session, call `authorize()`, invoke exactly one service method, map errors to typed responses. No SQL, no business rules. A thin `defineAction()` wrapper in `lib/` standardizes: session load → zod parse → authorize → service call → error mapping, so every mutation gets all four steps by construction.
2. **Service (service.ts)** — owns the DB transaction. Inside one transaction: business rules and status-machine checks, repo writes, **audit_log write (before/after diff)**, `events` table insert. Domain event **dispatch to in-process subscribers happens after commit** (see A6). Services take a `ctx` object (`{ userId, warehouseIds, locale, tx }`) — never read cookies/headers themselves, so they are callable from actions, jobs, and the Telegram webhook alike.
3. **Repo (repo.ts)** — Drizzle queries only; no authz, no audit. Row-level scoping filters (warehouse, client) are applied here from parameters the service passes in.

Authz is checked in transport for coarse permission + scope, and re-checked in services only for state-dependent rules (e.g. "same-day edit by creator", spec 4.4). Audit writes are a service-layer helper (`audit.record(tx, …)`) so they share the mutation's transaction — a mutation and its audit row commit or roll back together (spec 4.3).

### A3. Auth design (spec 4.1)

- **Credentials:** phone/username + password, **Argon2id** (`@node-rs/argon2`, defaults: m=19 MiB, t=2, p=1).
- **Sessions:** opaque random 256-bit token, SHA-256 hash stored in `sessions` table (`user_id, token_hash, created_at, last_seen_at, expires_at, ip, user_agent, device_label`); httpOnly + Secure + SameSite=Lax cookie. 30-day sliding expiry: `expires_at` refreshed on activity. DB-backed sessions give the **device list** for free — profile screen lists sessions, "logout other devices" deletes all rows but the current one.
- **Rate limiting:** Postgres-backed counter table keyed by `(ip, account)`, 5 failures / 15 min, checked before Argon2 verification; generic error message. DECISION: rate-limit state in Postgres (no Redis in v1, consistent with pg-boss choice).
- **PIN re-lock (config `pin_relock`, off by default):** does not end the session. After N minutes idle the client overlays a lock screen; unlock POSTs the 4-digit PIN, verified against an Argon2id `pin_hash` on the user; 5 failures escalate to full re-login. Server marks the session `locked` so it can't be bypassed by skipping the UI.
- **Print helper JWT:** not built in v1; the `LabelRenderer` path uses the normal session. Seam kept per spec 3.

### A4. RBAC implementation (spec 4.2, 16)

Data-driven tables: `roles`, `permissions` (seeded string keys like `receipt.create`, `plan.approve_record`, `audit.browse`), `role_permissions`, `user_roles`, `user_warehouses`. Section 16's matrix is the seed script for `role_permissions` — no capability if-statements scattered in code.

Single helper, called by the `defineAction()` wrapper and available to services:

```ts
authorize(ctx: AuthCtx, permission: PermissionKey, scope?: {
  warehouseId?: string;   // required for WH-scoped resources
  clientId?: string;      // required for client-scoped reads
}): Promise<void>  // throws ForbiddenError
```

Resolution order: (1) union of permissions from the user's roles; (2) if any of the user's roles is warehouse-scoped (`warehouse_manager`, `warehouse_operator`), `scope.warehouseId` must be in `user_warehouses`; (3) if the user's only relevant grant is the `sales_manager` "own view", `scope.clientId` must belong to a client whose `sales_manager_id` is the user. Roles carry a `scope_type` column (`none | warehouse | own_clients`) so scoping is data too. Permission set cached per-request (React `cache()`); UI hiding uses the same computed set but is cosmetic only — every mutation re-checks server-side.

### A5. Audit placement

Covered in A2: `audit.record()` runs inside the service transaction with before/after JSON diff, actor, warehouse context, ip/user-agent (passed via `ctx`). The app's DB role has INSERT+SELECT only on `audit_log` (revoked UPDATE/DELETE in migration). History-tab component queries `audit_log` by `(entity_type, entity_id)` and renders localized human-readable lines from the diff.

### A6. Domain events (spec 4.7)

- **Typed registry:** `modules/platform/events/registry.ts` declares each event name with a zod payload schema (`ReceiptConfirmed`, `BoxLabeled`, `CrateFormed`, `PlanApproved`, `BatchDeparted`, `BoxScannedOnLoad`, `BatchUnloaded`, `BoxIssued`, `UnknownCargoReceived`, `CostEntryAdded`, …). `emit()` is fully typed against the registry.
- **Persistence first:** the emitting service inserts the event row into `events` (`id, name, payload jsonb, actor_id, warehouse_id, created_at, processed_at`) **inside the business transaction** — the event exists iff the mutation committed.
- **Dispatch after commit:** a post-commit hook enqueues one pg-boss job per subscriber (`event.<name>.<subscriber>`), giving retry/backoff and admin visibility instead of fragile fire-and-forget in-process calls. Subscribers register at boot in `modules/*/subscribers.ts` (e.g. notifications subscribes to nearly everything per section 11; costing subscribes to `CostEntryAdded` for recompute). Future CRM/Finance modules add subscriber files without touching emitters.
- DECISION: subscriber delivery via pg-boss (transactional-outbox style) rather than pure in-process EventEmitter — same-process, no new infra, but survives crashes and is inspectable. The bus API stays in-process/typed as specced.

### A7. Job queue (pg-boss)

Job types (registry in `modules/platform/jobs/`): `telegram.send`, `file.thumbnail` (sharp 200px/800px), `excel.build` (agent file, manifest, invoice/packing drafts, stock report), `labels.build-pdf` (large batches only; small sets render inline), `cost.recompute` (per batch/receipt, idempotent), `digest.daily` (unclaimed aging + stale stock, cron per WH at 09:00 WH-local computed from warehouse timezone), `event.dispatch.*` (A6), `backup-verify` hooks.

Retry policy defaults: `retryLimit: 5`, exponential backoff (`retryDelay: 30s`, `retryBackoff: true`); `telegram.send` honors Telegram 429 `retry_after`. `cost.recompute` uses a singleton key per batch (`useSingletonQueue`) so bursts of FX edits collapse. Dead-lettered jobs surface in an **admin "Jobs" screen** (query pg-boss tables directly: state counts, failed list, payload, retry button) — satisfies "delivery status visible to admins" and the observability dashboard requirement without extra infra. Workers run in the same Node process as Next.js, started from `instrumentation.ts`.

### A8. Files (spec 4.8)

- **Storage:** MinIO on the VPS (S3 API), one private bucket, versioning on. `attachments` table: `id, entity_type, entity_id, kind, s3_key, mime, size, width/height, thumb keys, uploaded_by`.
- **Upload path:** client compresses images with `browser-image-compression` (target ≤ 300 KB) and strips EXIF → requests a presigned PUT from a server action (authz on the target entity) → uploads direct to MinIO → confirms; confirmation enqueues `file.thumbnail` (sharp, 200px & 800px WebP).
- **Reads:** `/api/attachments/[id]?variant=` checks authz, then — local driver — streams the bytes directly with the correct Content-Type (an absolute-URL redirect broke when the browser reached the app via a LAN IP: the phone was redirected to `localhost`; DECISIONS #52), or — S3 — 302s to a short-lived (10 min) presigned GET URL. No public bucket. Lists always render thumbnails first; tap-to-zoom (`LightboxImg` overlay) loads the 800px then original.

### A9. i18n (next-intl)

- Locales `ru` (default), `uz-Latn`, `zh-CN`. DECISION: no locale URL prefix — locale is per-user (profile) with cookie fallback, resolved in `i18n/request.ts`; operational URLs stay short and shareable.
- Messages in `/messages/{locale}.json`, namespaced by module/feature (`platform.auth.*`, `wms.receiving.*`) so translators work per screen; CI check asserts key parity across the three files. No hardcoded strings (ESLint rule on JSX text).
- **WH-local time utils** in `modules/platform/i18n/time.ts`: `formatInWarehouse(dateUtc, warehouse, fmt)` using the warehouse's IANA timezone — used by UI, labels, digests scheduling, and receipt-number/day rules ("same warehouse-day" edit window is computed in WH tz). DB stores UTC only.

### A10. PWA & offline (spec 3, 6.1, 6.4, 15)

- **Service worker:** Serwist. Precache app shell (layout, fonts, icons, core JS/CSS); runtime caching: stale-while-revalidate for static, network-first with cache fallback for reference data (clients list, product dictionary, settings); mutations are never cached.
- **IndexedDB outbox** (`src/offline/`), two stores:
  - `receipt_drafts` — the W1 wizard autosaves the full draft object after every field change (survives app kill). Draft submits go through the outbox like any mutation.
  - `outbox` — queued mutations: `{ uuid, type: 'scan'|'receipt_confirm'|…, payload, createdAt, attempts, status }`. Every scan event carries a client-generated **UUID v4** (`client_event_uuid`).
- **Sync engine:** flush on `online` event, SW Background Sync, and app foreground; POSTs batches to `/api/sync`. Server dedupes on the unique `client_event_uuid` index in `scan_events` — replays return the original result (idempotent, edge case 14). Entries are removed only after a 2xx with per-item ack.
- **Conflict rules:** scans are append-only facts, so "conflicts" are business outcomes, not merge problems — a late-synced load scan for an already-departed batch is accepted and lands in the discrepancy/reconciliation flow (W5 auto-transfer logic is the ultimate reconciler, per the owner's reality rule). Receipt drafts are single-author; DECISION: last-write-wins on one's own draft, no cross-device draft merging in v1.
- **UI:** persistent status banner (online / offline / syncing / N pending); scan feedback is always local-first (<300 ms: vibrate/beep/counter update from local state, server confirmation async).

### A11. SSE

`/api/sse/[channel]` route handler (Node runtime, `ReadableStream`), channels like `batch:{id}:loading` and `plan:{id}`. In-process pub/sub bridged from domain events/service calls (single app container, so no cross-instance bus needed — DECISION: acceptable for v1 scale). Events: scan counted, counters, plan line live-added by logist, not-on-plan alerts. Client uses `EventSource` with auto-reconnect + `Last-Event-ID`; on reconnect the client refetches a snapshot then resumes the stream (SSE is a hint layer, snapshot is truth). Heartbeat comment every 25 s to keep proxies open.

### A12. Label rendering (spec 7)

```ts
interface LabelRenderer {
  renderBoxLabels(boxes: BoxLabelData[]): Promise<{ bytes: Uint8Array; mime: string }>;
  renderCrateLabel(crate: CrateLabelData): Promise<{ bytes: Uint8Array; mime: string }>;
}
```

v1 implementation `PdfLabelRenderer` (pdf-lib): 100×100 mm page per box; absolute-position layout per section 7 (WH code + local date + receipt no top; client code+letter ~22 mm extra-bold dominant; product zh(ru); box i/N + weight + dims; QR ≥ 32×32 mm with quiet zone + short-code text + brand). QR via `qrcode` lib rendered to PNG and embedded (payload = short code string only). **CJK:** self-hosted subsetted Noto Sans SC embedded with `@pdf-lib/fontkit` from `assets/fonts/` — no network fetch at render time (China-safe); Cyrillic/Latin from a self-hosted Inter/Noto subset. Reprints call the same renderer and are audited. A future `TsplLabelRenderer` implements the same interface without touching callers.

### A13. Excel generation (exceljs)

`modules/wms/documents/`: one builder per document (section 9) sharing helpers for headers, totals rows, and **embedded photo thumbnails** — `workbook.addImage()` with the 200px thumbnail fetched from MinIO, anchored to the row with fixed row height (~60 px). Builders run in `excel.build` pg-boss jobs (photo embedding is slow); output stored as an immutable versioned attachment on the entity, user notified via bell/SSE when ready. Templates' configurable header/consignee/stamp blocks read from `settings`.

### A14. Telegram (grammY)

- Bot runs **webhook mode** at `/api/telegram/webhook` (secret token header verified) — no long-polling process to babysit.
- **Deep-link linking (spec 4.5):** profile "Connect Telegram" → server action creates a one-time code (15 min TTL) → opens `t.me/<bot>?start=<code>` → `/start` handler matches the code, stores `telegram_links(user_id, chat_id)`, confirms in both UIs.
- **Sends:** only via `telegram.send` jobs (payload: `chat_id`, i18n message key + params rendered server-side in the recipient's UI language, optional photo file_ids, deep link back into the app). Delivery status stored on the notification row; failures visible in admin Jobs screen. Bot has no commands beyond `/start` in Phase 1 (client bot is Phase 2).

### A15. Translation service (spec 8)

```ts
interface TranslationProvider { translate(text: string, from: 'zh', to: 'ru'): Promise<string>; }
```

Implementations: `DeepLProvider`, `YandexProvider`, `GoogleProvider`, `NullProvider`; selected by `settings.translation_provider` + env keys. Lookup pipeline in `modules/platform/translation/service.ts`: exact `product_dictionary` hit → trigram fuzzy suggestion → provider call with a short timeout (~3 s) → cache result into dictionary as `verified=false`, bump `usage_count`. Any failure returns empty — the wizard never blocks (spec 8). Admin curation UI (verify/merge/XLSX import) sits in the admin area.

### A16. Observability (spec 15)

- **pino** structured logs (JSON to stdout; request id, user id, warehouse id bound via AsyncLocalStorage); pretty transport in dev.
- **GlitchTip** (self-hosted, Sentry SDK-compatible) via `@sentry/nextjs` with `SENTRY_DSN`; client + server + job-handler error capture. DECISION: GlitchTip in the same docker-compose rather than SaaS Sentry — keeps error data on the VPS and avoids CN reachability concerns.
- `/api/health`: checks DB round-trip, MinIO head-bucket, pg-boss worker heartbeat; used by Docker healthcheck + uptime monitor.
- Job dashboard: the admin Jobs screen from A7 (pg-boss state tables).

### A17. Deployment (spec 3, 15)

docker-compose on one VPS, **HK or SG region reachable from mainland CN** (e.g. Alibaba/Tencent HK); test checklist: page load from a CN warehouse < 5 s.

| Service | Notes |
|---|---|
| `app` | Next.js standalone build; runs web + pg-boss workers + SSE in one process; healthcheck `/api/health` |
| `caddy` | TLS termination (HTTPS only), reverse proxy, SSE-safe (no response buffering) — DECISION: Caddy for zero-config certs |
| `postgres` | Postgres 16, volume-backed |
| `minio` | private bucket, versioning on |
| `backup` | cron container: nightly `pg_dump` → MinIO (30-day retention) + weekly restore-test script |
| `glitchtip` | error tracking (optional profile) |

Env vars (spec 17): `DATABASE_URL`, `S3_ENDPOINT`, `S3_ACCESS_KEY`, `S3_SECRET_KEY`, `S3_BUCKET`, `S3_REGION`, `TELEGRAM_BOT_TOKEN`, `TELEGRAM_WEBHOOK_SECRET`, `TRANSLATE_API_PROVIDER`, `TRANSLATE_API_KEY`, `SENTRY_DSN`, `APP_URL`, `SESSION_SECRET`, `NODE_ENV`.

China-access constraints baked into the build: all fonts/assets self-hosted from `public/` and `assets/fonts/` (zero Google Fonts/CDNs/analytics), no third-party client-side scripts, images served via the app's MinIO (same region), CI check that greps the built client bundle for blocked-domain references.

---

## Database schema

Drizzle-ORM-oriented PostgreSQL 16 schema for all of Phase 1 (M0–M6). All tables live in the `public` schema (pg-boss creates and owns its own `pgboss` schema). Extensions required: `pg_trgm`, `citext` (optional; see conventions).

### 0. Global conventions

| Topic | Convention |
|---|---|
| **Primary keys** | **DECISION:** UUIDv7, app-generated (Drizzle `$defaultFn(() => uuidv7())`) for all *entity* tables — time-ordered so B-tree locality is fine, safe to mint offline (idempotency, PWA outbox), no coordination across future modules. **`bigint generated always as identity`** for pure append-only log tables where rows are never referenced from outside the DB module (`audit_log`, `events`, `box_movements`, `cost_allocations`, `login_attempts`) — cheaper and naturally ordered. |
| **Timestamps** | `created_at timestamptz NOT NULL DEFAULT now()` on every table; `updated_at timestamptz NOT NULL DEFAULT now()` on mutable tables, maintained by the app (Drizzle `$onUpdate`). **DECISION:** no DB triggers for `updated_at` — one write path (the app) keeps behavior visible and testable. All timestamps UTC; warehouse-local rendering is a display concern. |
| **Soft delete / void** | Nothing is hard-deleted. Reference data (`warehouses`, `clients`, `users`, `truck_presets`, `cost_types`) uses `active boolean NOT NULL DEFAULT true`. Documents (`receipts`, `cost_entries`, boxes via status) are **voided**: `voided_at timestamptz`, `voided_by uuid`, `void_reason text` — all three set together (CHECK). The only physical deletes: expired `sessions`, old `login_attempts`, and `cost_allocations` rows replaced during recompute. |
| **Enums** | **DECISION: `text` columns + `CHECK` constraints, not native pg enums.** Native enums make adding/removing/renaming values a migration headache (`ALTER TYPE` limitations, no value removal) and buy nothing over a CHECK. TypeScript union types in the Drizzle schema give compile-time safety; the CHECK gives DB-level safety; changing a CHECK is a plain `ALTER TABLE`. |
| **Money / units** | Per spec 4.6: kg `NUMERIC(12,3)`, m³ `NUMERIC(12,4)`, cm `integer`, money `NUMERIC(14,2)` + `varchar(3)` currency, FX rates `NUMERIC(18,8)`, allocation shares `NUMERIC(14,6)` (extra precision so per-box shares sum cleanly). |
| **FK rule** | Every FK gets an index (listed in §7) unless it is the leading column of the PK. All FKs are `ON DELETE RESTRICT` (nothing is deleted anyway); `ON DELETE CASCADE` only on pure join tables (`role_permissions`, `user_roles`, `user_warehouses`). |

---

### 1. Platform core (M0)

#### `users`
| Column | Type | Null | Default / notes |
|---|---|---|---|
| id | uuid | NO | PK, uuidv7 |
| phone | text | NO | UNIQUE; login identifier |
| username | text | YES | UNIQUE (alternative login) |
| full_name | text | NO | |
| password_hash | text | NO | Argon2id |
| quick_pin_hash | text | YES | 4-digit PIN re-lock (feature-flagged) |
| locale | text | NO | `'ru'`; CHECK IN (`ru`,`uz`,`zh-CN`) |
| active | boolean | NO | `true` |
| created_at / updated_at | timestamptz | NO | |

#### `sessions`
| Column | Type | Null | Notes |
|---|---|---|---|
| id | uuid | NO | PK |
| user_id | uuid | NO | FK → users |
| token_hash | text | NO | UNIQUE (sha256 of cookie token) |
| ip | inet | YES | |
| user_agent | text | YES | |
| device_label | text | YES | for "logout other devices" list |
| expires_at | timestamptz | NO | 30-day rolling |
| last_seen_at | timestamptz | NO | now() |
| revoked_at | timestamptz | YES | |
| created_at | timestamptz | NO | |

#### `login_attempts` (rate limiting, 5 / 15 min / IP+account)
`id bigint identity PK`, `identifier text NOT NULL` (phone/username), `ip inet NOT NULL`, `success boolean NOT NULL`, `created_at timestamptz NOT NULL`. Pruned by a daily job. Index `(identifier, ip, created_at)`.

#### `roles`, `permissions`, `role_permissions`, `user_roles`, `user_warehouses`
- `roles`: `id uuid PK`, `code text NOT NULL UNIQUE` (`super_admin`…`viewer`, seed per spec 4.2), `name text NOT NULL`, `is_system boolean NOT NULL DEFAULT true`.
- `permissions`: `id uuid PK`, `code text NOT NULL UNIQUE` (dotted, e.g. `receipt.create`, `plan.approve_record`, `cost.enter_batch` — one per row of the matrix in spec §16), `description text`.
- `role_permissions`: `role_id uuid FK`, `permission_id uuid FK`, `PRIMARY KEY (role_id, permission_id)`, CASCADE.
- `user_roles`: `user_id`, `role_id`, `PRIMARY KEY (user_id, role_id)`, CASCADE.
- `user_warehouses`: `user_id`, `warehouse_id`, `PRIMARY KEY (user_id, warehouse_id)`, CASCADE — warehouse scoping for `warehouse_manager`/`warehouse_operator`.

#### `settings`
`key text PRIMARY KEY`, `value jsonb NOT NULL`, `updated_by uuid FK → users`, `updated_at timestamptz NOT NULL`. One row per key from spec §17 (`letter_scope`, `chargeable_weight_factor`, `density_thresholds`, …). Seeded with defaults; typed accessor layer in code.

#### `audit_log` (append-only — see §8 for immutability)
| Column | Type | Null | Notes |
|---|---|---|---|
| id | bigint identity | NO | PK |
| actor_id | uuid | YES | FK → users; NULL = system/job |
| entity_type | text | NO | e.g. `receipt`, `box`, `load_plan` |
| entity_id | uuid | NO | |
| action | text | NO | `create`,`update`,`void`,`status_change`,`scan`,`label_print`,`export`,`login`,… |
| before | jsonb | YES | changed fields only |
| after | jsonb | YES | changed fields only |
| warehouse_id | uuid | YES | FK → warehouses (context) |
| ip | inet | YES | |
| user_agent | text | YES | |
| created_at | timestamptz | NO | `now()` |

**DECISION:** label prints and exports are audit rows (`action='label_print'` with label list in `after`), not a separate table — report #9 ("label reprint log") is a filtered audit query.

#### `events` (domain events, in-DB outbox)
`id bigint identity PK`, `type text NOT NULL` (`ReceiptConfirmed`, `BatchDeparted`, …), `payload jsonb NOT NULL`, `entity_type text`, `entity_id uuid`, `actor_id uuid`, `occurred_at timestamptz NOT NULL DEFAULT now()`, `processed_at timestamptz`. Written in the same transaction as the mutation; a pg-boss worker polls unprocessed rows and fans out to notification rules. Partial index on `processed_at IS NULL`.

#### `notifications`
**DECISION:** one row per (event, recipient, channel) — the in-app bell and Telegram delivery share the table.
| Column | Type | Null | Notes |
|---|---|---|---|
| id | uuid | NO | PK |
| user_id | uuid | NO | FK → users |
| event_id | bigint | YES | FK → events |
| channel | text | NO | CHECK IN (`in_app`,`telegram`) |
| type | text | NO | event type / digest key |
| payload | jsonb | NO | rendered title/body/deep-link/share-text |
| status | text | NO | `'pending'`; CHECK IN (`pending`,`sent`,`failed`,`muted`) |
| sent_at | timestamptz | YES | |
| error | text | YES | last failure (visible to admins) |
| read_at | timestamptz | YES | in-app only |
| created_at | timestamptz | NO | |

Per-user mute settings live in `settings`-style JSON on the user? **DECISION:** `users` gets no extra column; mutes stored as `notification_mutes jsonb` in `payload`-free table — simplest: a `settings` key per user is overkill, so store `muted_types text[]` column on `telegram_links` for Telegram and a `muted_types text[]` on users for in-app. (Record in DECISIONS.md; alternative: tiny `notification_prefs` table.)

#### `telegram_links`
`id uuid PK`, `user_id uuid NOT NULL UNIQUE FK → users`, `telegram_chat_id bigint UNIQUE`, `link_code text UNIQUE` (one-time deep-link code), `status text NOT NULL DEFAULT 'pending'` CHECK IN (`pending`,`linked`,`revoked`), `linked_at timestamptz`, `created_at`.

#### `attachments` (polymorphic, all entities)
| Column | Type | Null | Notes |
|---|---|---|---|
| id | uuid | NO | PK |
| entity_type | text | NO | `receipt`,`receipt_lot`,`crate`,`batch`,`plan_version`,`cost_entry`,`client`,`handover`,`scan_event` |
| entity_id | uuid | NO | |
| kind | text | NO | CHECK IN (`photo`,`document`,`generated`) |
| doc_type | text | YES | for generated: `agent_approval`,`manifest`,`invoice_draft`,`packing_list`,`handover_act`,`labels`,`stock_report` |
| file_name | text | NO | |
| mime_type | text | NO | |
| size_bytes | bigint | NO | |
| storage_key | text | NO | UNIQUE (S3 key) |
| thumb_200_key / thumb_800_key | text | YES | photos only |
| uploaded_by | uuid | YES | FK → users; NULL = system-generated |
| deleted_at | timestamptz | YES | soft delete; generated files never deleted (immutable archive) |
| created_at | timestamptz | NO | |

Index `(entity_type, entity_id)`.

#### `product_dictionary`
`id uuid PK`, `zh text NOT NULL UNIQUE`, `ru text`, `uz text`, `usage_count integer NOT NULL DEFAULT 0`, `verified boolean NOT NULL DEFAULT false`, `source text NOT NULL DEFAULT 'manual'` CHECK IN (`manual`,`api`,`import`), `created_at/updated_at`.

#### `currencies`
`code varchar(3) PRIMARY KEY` (ISO-4217 style, uppercase), `name text NOT NULL`, `active boolean NOT NULL DEFAULT true`, timestamps. Seed: `CNY`, `USD`, `UZS` (spec 4.6 — extensible via admin). Money columns elsewhere reference this table (`FK → currencies`). UI default for cost entry currency: `CNY` at warehouses with `country = 'CN'`, else `USD`/`UZS` per warehouse country.

#### `fx_rates`
`id uuid PK`, `from_currency varchar(3) NOT NULL FK → currencies`, `to_currency varchar(3) NOT NULL FK → currencies`, `rate numeric(18,8) NOT NULL CHECK (rate > 0)`, `rate_date date NOT NULL`, `entered_by uuid NOT NULL FK`, `created_at/updated_at`, `UNIQUE (from_currency, to_currency, rate_date)`. Editing a rate triggers allocation recompute (§6).

#### `truck_presets`
`id uuid PK`, `name text NOT NULL`, `max_kg numeric(12,3) NOT NULL CHECK (> 0)`, `max_m3 numeric(12,4) NOT NULL CHECK (> 0)`, `active boolean NOT NULL DEFAULT true`, timestamps.

#### `letter_blacklist`
`combo text PRIMARY KEY` CHECK (`combo = upper(combo) AND char_length(combo) BETWEEN 1 AND 2`), `added_by uuid FK`, `created_at`. Seed: `AM`, `XU`.

#### `cost_types`
`id uuid PK`, `code text NOT NULL UNIQUE` (`crating`,`freight`,`agent_fee`,`customs`,`unload`,`other` seeded), `name text NOT NULL`, `default_scope text` CHECK IN (`receipt`,`batch`) NULL, `sort_order integer NOT NULL DEFAULT 0`, `active boolean NOT NULL DEFAULT true`, timestamps.

---

### 2. Warehouse & client registry

#### `warehouses`
| Column | Type | Null | Notes |
|---|---|---|---|
| id | uuid | NO | PK |
| code | text | NO | UNIQUE; CHECK `code = upper(code)` (`GZ`,`YW`,`KA`,`TAS1`…) |
| name | text | NO | |
| country | varchar(2) | NO | `CN` / `UZ` |
| type | text | NO | CHECK IN (`origin`,`hub`,`customs`,`distribution`) |
| timezone | text | NO | IANA name |
| batch_prefix | text | NO | defaults to `code` |
| address | text | YES | used in client pickup message templates |
| active | boolean | NO | `true` |
| created_at / updated_at | timestamptz | NO | |

Letter sequence state is **not** stored here (see `letter_states`, §5) to keep the hot lock row narrow.

#### `clients`
`id uuid PK`, `client_code text NOT NULL UNIQUE` CHECK (`client_code = upper(client_code)`), `name text NOT NULL`, `phones jsonb NOT NULL DEFAULT '[]'`, `sales_manager_id uuid FK → users`, `messenger_note text` (telegram/wechat), `notes text`, `active boolean NOT NULL DEFAULT true`, `created_by uuid FK`, timestamps. Case-insensitive lookup done by uppercasing input in the app.

---

### 3. Receiving

#### `receipts`
| Column | Type | Null | Notes |
|---|---|---|---|
| id | uuid | NO | PK (minted client-side for offline drafts) |
| number | text | NO | UNIQUE, `YW-IN-260722-003`; assigned at first server save |
| warehouse_id | uuid | NO | FK → warehouses |
| client_id | uuid | YES | FK → clients; **NULL = unclaimed** |
| status | text | NO | `'draft'`; CHECK IN (`draft`,`confirmed`,`voided`) |
| received_at | timestamptz | NO | shown in WH-local time |
| source_note | text | YES | "who delivered" |
| created_by | uuid | NO | FK → users |
| confirmed_at / confirmed_by | timestamptz / uuid | YES | |
| voided_at / voided_by / void_reason | | YES | all-or-none CHECK |
| created_at / updated_at | timestamptz | NO | |

Unclaimed pool = `client_id IS NULL AND status = 'confirmed'` (partial index). Wrong-WH move = update `warehouse_id` + correcting `box_movements` + audit (receipt `number` keeps its original WH prefix — **DECISION:** numbers are immutable labels, never re-issued).

#### `receipt_lots`
| Column | Type | Null | Notes |
|---|---|---|---|
| id | uuid | NO | PK |
| receipt_id | uuid | NO | FK → receipts |
| warehouse_id | uuid | NO | FK; denormalized from receipt for the letter-uniqueness constraint |
| letter | text | YES | NULL until confirm; CHECK (`letter = upper(letter)`) |
| cycle_no | integer | YES | set with letter |
| product_name_zh | text | YES | |
| product_name_ru | text | YES | never blocks flow |
| box_count | integer | NO | CHECK (> 0) |
| dims_mode | text | NO | CHECK IN (`uniform`,`mixed`) |
| length_cm / width_cm / height_cm | integer | YES | uniform mode; CHECK (> 0) when set |
| weight_per_box_kg | numeric(12,3) | YES | uniform mode |
| total_weight_kg | numeric(12,3) | NO | entered (mixed) or computed (uniform) |
| total_volume_m3 | numeric(12,4) | NO | ditto |
| chargeable_weight_kg | numeric(12,3) | NO | `max(kg, m³×factor)` — factor **snapshotted at confirm** |
| created_at / updated_at | timestamptz | NO | |

- Density is computed on read (`total_weight_kg / total_volume_m3`) — not stored, thresholds are configurable display logic.
- **Letter uniqueness (defense-in-depth on top of the transactional sequencer):** `UNIQUE (warehouse_id, letter, cycle_no) WHERE letter IS NOT NULL` (partial unique index). Valid under both `LETTER_SCOPE` modes (globally-unique letters are trivially per-WH unique).
- Photos/attachments: `attachments(entity_type='receipt_lot')`; ≥1 photo enforced in app at confirm.

#### `boxes` (the atomic tracked unit)
| Column | Type | Null | Notes |
|---|---|---|---|
| id | uuid | NO | PK |
| short_code | text | NO | UNIQUE, `YW26-000123` — QR payload |
| lot_id | uuid | NO | FK → receipt_lots |
| seq_in_lot | integer | NO | UNIQUE (lot_id, seq_in_lot) |
| status | text | NO | CHECK IN (`in_stock`,`planned`,`loading`,`in_transit`,`ready_for_pickup`,`issued`,`lost`,`void`) |
| status_reason | text | YES | required for `lost`/`void` (CHECK) |
| current_warehouse_id | uuid | YES | FK; NULL while `in_transit`/after `issued` |
| current_batch_id | uuid | YES | FK → batches; set from load scan until unload |
| crate_id | uuid | YES | FK → crates |
| weight_kg | numeric(12,3) | NO | effective per-box (uniform: per-box value; mixed: total/count) — frozen at confirm, basis for allocation |
| volume_m3 | numeric(12,4) | NO | ditto |
| chargeable_kg | numeric(12,3) | NO | ditto |
| label_printed_at | timestamptz | YES | last print |
| damaged | boolean | NO | `false` |
| missing_in_transit | boolean | NO | `false`; set at batch close, cleared on resolution |
| handover_id | uuid | YES | FK → handovers (set when issued) |
| created_at / updated_at | timestamptz | NO | |

**DECISION:** `crated` is not a status — crate membership is `crate_id IS NOT NULL`, orthogonal to the logistics status (spec 5.5's `in_stock ⇄ crated` maps to setting/clearing `crate_id`). **DECISION:** `received` and `in_stock` are merged — a box exists only after receipt confirm, at which point it is in stock.

#### `crates`
`id uuid PK`, `code text NOT NULL UNIQUE` (`CR-KA26-00012`), `warehouse_id uuid NOT NULL FK`, `client_id uuid NOT NULL FK` (one client per crate, enforced also in app on add-box), `status text NOT NULL DEFAULT 'active'` CHECK IN (`active`,`dissolved`), `length_cm/width_cm/height_cm integer`, `weight_kg numeric(12,3)` (measured after packing), `logist_note text` (the "logist approved" confirmation note), `built_by uuid NOT NULL FK`, `dissolved_at timestamptz`, `dissolved_by uuid`, timestamps.

---

### 4. Planning, batches, movement

#### `batches`
| Column | Type | Null | Notes |
|---|---|---|---|
| id | uuid | NO | PK |
| code | text | NO | UNIQUE, `YW-001` |
| origin_warehouse_id / dest_warehouse_id | uuid | NO | FKs; CHECK (origin ≠ dest) |
| type | text | NO | CHECK IN (`transfer`,`export`,`distribution`) |
| status | text | NO | CHECK IN (`forming`,`loading`,`in_transit`,`arrived`,`unloaded`,`closed`,`cancelled`) — `arrived` = truck at destination, `unloaded` = finish-unload reconciled (spec 6.5), `closed` = final |
| vehicle_plate / driver_name / driver_phone | text | YES | entered when truck arrives |
| departed_at / arrived_at / closed_at | timestamptz | YES | |
| sent_to_agent_at | date | YES | VED "sent to agent" checkbox (export batches) |
| created_by | uuid | NO | FK |
| created_at / updated_at | timestamptz | NO | |

Docs (manifest, invoice, packing list — versioned) and truck photos are `attachments(entity_type='batch')`.

#### `load_plans`
`id uuid PK`, `origin_warehouse_id uuid NOT NULL FK`, `dest_warehouse_id uuid NOT NULL FK`, `batch_id uuid FK → batches` (set on approval; UNIQUE), `truck_preset_id uuid FK`, `max_kg numeric(12,3)`, `max_m3 numeric(12,4)` (preset snapshot or custom), `target_date date`, `status text NOT NULL DEFAULT 'draft'` CHECK IN (`draft`,`pending_agent`,`changes_requested`,`approved`,`loading`,`completed`,`cancelled`), `current_version_no integer NOT NULL DEFAULT 0`, `created_by uuid NOT NULL FK`, timestamps. "Quick batch" mode (UZ internal transfers) creates a batch without a plan — `batch_id` on plans is nullable-until-approved, batches without any plan are legal.

#### `load_plan_versions` (immutable snapshots)
`id uuid PK`, `plan_id uuid NOT NULL FK`, `version_no integer NOT NULL`, `UNIQUE (plan_id, version_no)`, `submitted_at timestamptz NOT NULL`, `submitted_by uuid NOT NULL FK`, `total_boxes integer NOT NULL`, `total_kg numeric(12,3) NOT NULL`, `total_m3 numeric(12,4) NOT NULL`, `agent_verdict text` CHECK IN (`approved`,`changes_requested`) NULL, `agent_comment text`, `verdict_recorded_by uuid`, `verdict_recorded_at timestamptz`, `created_at`. Generated agent Excel = attachment on the version. Rows never updated after verdict.

#### `load_plan_lines`
`id uuid PK`, `version_id uuid NOT NULL FK → load_plan_versions`, `lot_id uuid NOT NULL FK → receipt_lots`, `planned_box_count integer NOT NULL CHECK (> 0)`, `planned_kg numeric(12,3) NOT NULL`, `planned_m3 numeric(12,4) NOT NULL`, `UNIQUE (version_id, lot_id)`. Partial-lot selection = `planned_box_count < lot.box_count` remainder. On approval the app reserves N concrete boxes of the lot (`status='planned'`, `current_batch_id` set) — **DECISION:** reservation picks lowest `seq_in_lot` unscanned boxes; actual identity is fixed at scan time anyway.

#### `scan_events`
| Column | Type | Null | Notes |
|---|---|---|---|
| id | uuid | NO | PK |
| client_event_uuid | uuid | NO | UNIQUE — offline idempotency; server ignores duplicates via `ON CONFLICT DO NOTHING` |
| box_id | uuid | NO | FK → boxes |
| crate_id | uuid | YES | FK; set when the scan was a crate scan (one crate scan fans out to one row per member box, same `client_event_uuid` + box suffix — **DECISION:** fan-out rows get derived UUIDs `uuid5(client_event_uuid, box_id)`) |
| batch_id | uuid | YES | FK; NULL for issue scans |
| handover_id | uuid | YES | FK → handovers; issue scans only |
| type | text | NO | CHECK IN (`load`,`unload`,`issue`) |
| method | text | NO | CHECK IN (`qr`,`manual`,`crate`) |
| manual_reason | text | YES | CHECK (`method <> 'manual' OR manual_reason IS NOT NULL`) — e.g. `sticker_lost` |
| added_on_spot | boolean | NO | `false` — not-on-plan load |
| undocumented_transfer | boolean | NO | `false` — rogue box at unload |
| scanned_by | uuid | NO | FK → users |
| scanned_at | timestamptz | NO | client-side capture time |
| created_at | timestamptz | NO | server receive time |

CHECK: `(type = 'issue') = (handover_id IS NOT NULL)` and `(type <> 'issue') = (batch_id IS NOT NULL)`.

#### `box_movements` (append-only timeline)
| Column | Type | Null | Notes |
|---|---|---|---|
| id | bigint identity | NO | PK |
| box_id | uuid | NO | FK → boxes |
| from_status / to_status | text | YES/NO | |
| from_warehouse_id / to_warehouse_id | uuid | YES | |
| from_batch_id / to_batch_id | uuid | YES | |
| from_crate_id / to_crate_id | uuid | YES | |
| cause | text | NO | CHECK IN (`receipt`,`plan_reserve`,`plan_release`,`load_scan`,`depart`,`unload_scan`,`auto_transfer`,`crate`,`uncrate`,`issue`,`return_to_sender`,`edit`,`receipt_move`,`lost`,`void`,`manual_fix`) |
| ref_type / ref_id | text / uuid | YES | receipt / scan_event / batch / handover |
| actor_id | uuid | YES | FK → users; NULL = system |
| created_at | timestamptz | NO | |

#### `handovers` (issue / return-to-sender act)
`id uuid PK`, `warehouse_id uuid NOT NULL FK`, `client_id uuid FK` (NULL for unclaimed return-to-sender), `type text NOT NULL` CHECK IN (`client_pickup`,`returned_to_sender`), `receiver_name text NOT NULL`, `receiver_phone text`, `debt_ok boolean NOT NULL DEFAULT false` (Phase 3 hook slot, no logic), `note text`, `created_by uuid NOT NULL FK`, `created_at`. Photo/signature scribble and handover-act PDF = attachments; issued boxes linked via `boxes.handover_id` + `scan_events`.

---

### 5. Sequences & counters

All human-readable codes come from two small tables, never from pg sequences (pg sequences are non-transactional and can't be scoped per WH/day/year cleanly).

#### `counters` — generic gapless-enough counters
| Column | Type | Notes |
|---|---|---|
| warehouse_id | uuid NOT NULL | FK → warehouses |
| counter_type | text NOT NULL | CHECK IN (`receipt_day`,`box_year`,`crate_year`,`batch`) |
| period_key | text NOT NULL | `receipt_day`: `'260722'` (WH-local date); `box_year`/`crate_year`: `'26'` (WH-local year); `batch`: `''` |
| value | integer NOT NULL DEFAULT 0 | last issued value |
| **PK** | | `(warehouse_id, counter_type, period_key)` |

Acquisition (atomic, concurrency-safe, one statement):
```sql
INSERT INTO counters (warehouse_id, counter_type, period_key, value)
VALUES ($1, $2, $3, 1)
ON CONFLICT (warehouse_id, counter_type, period_key)
DO UPDATE SET value = counters.value + 1
RETURNING value;
```
Called inside the same transaction that creates the receipt/box/crate/batch. `period_key` computed from the **warehouse's timezone**. Gaps are acceptable (a rolled-back confirm burns numbers) — codes are labels, not accounting sequences.

#### `letter_states` — letter sequencer state (spec 5.3)
| Column | Type | Notes |
|---|---|---|
| id | uuid PK | |
| scope | text NOT NULL | CHECK IN (`warehouse`,`global`) |
| warehouse_id | uuid | FK; NOT NULL iff scope=`warehouse` (CHECK) |
| next_index | integer NOT NULL DEFAULT 0 | 0-based position in the `A…Z,AA…ZZ` sequence (0=`A`, 701=`ZZ`) |
| cycle_no | integer NOT NULL DEFAULT 1 | bumps on `ZZ`→`A` wrap |
| updated_at | timestamptz NOT NULL | |

- `UNIQUE (warehouse_id) WHERE scope = 'warehouse'`; `UNIQUE (scope) WHERE scope = 'global'` (at most one global row).
- Confirm transaction: `SELECT … FOR UPDATE` on the relevant row (per `settings.letter_scope`) → for each lot: advance `next_index`, **skipping blacklisted combos** (and optionally `I`/`O` singles) by re-advancing, wrapping 702→0 with `cycle_no + 1` → write `letter`+`cycle_no` to the lot → update the state row. Two concurrent confirms serialize on the row lock (acceptance test #4).
- Switching `LETTER_SCOPE` to `global` creates the global row starting fresh at `A`/cycle 1 — **DECISION:** no attempt to merge per-WH positions; mark it in DECISIONS.md.
- The row is separate from `warehouses` so the lock never blocks unrelated warehouse reads/edits.

---

### 6. Landed cost (M6)

#### `cost_entries`
| Column | Type | Null | Notes |
|---|---|---|---|
| id | uuid | NO | PK |
| scope | text | NO | CHECK IN (`receipt`,`batch`) |
| receipt_id | uuid | YES | FK; CHECK: exactly one of receipt_id/batch_id set, matching scope |
| batch_id | uuid | YES | FK |
| cost_type_id | uuid | NO | FK → cost_types |
| amount | numeric(14,2) | NO | CHECK (> 0), original currency |
| currency | varchar(3) | NO | |
| cost_date | date | NO | selects the FX rate |
| fx_rate | numeric(18,8) | NO | snapshot of rate used (re-snapshotted on recompute) |
| amount_usd | numeric(14,2) | NO | `amount × fx_rate` at last compute |
| allocation_basis | text | NO | CHECK IN (`weight`,`volume`,`chargeable`,`boxes`,`direct_to_client`) |
| direct_client_id | uuid | YES | FK → clients; CHECK: NOT NULL iff basis=`direct_to_client` |
| note | text | YES | |
| entered_by | uuid | NO | FK |
| voided_at / voided_by / void_reason | | YES | |
| created_at / updated_at | timestamptz | NO | |

#### `cost_allocations` (allocation results — box landed-cost storage)
| Column | Type | Notes |
|---|---|---|
| id | bigint identity | PK |
| cost_entry_id | uuid NOT NULL | FK → cost_entries |
| box_id | uuid NOT NULL | FK → boxes |
| basis_qty | numeric(14,6) NOT NULL | the box's weight/volume/chargeable/1 at compute time |
| total_basis_qty | numeric(14,6) NOT NULL | denominator snapshot (whole batch/receipt) — makes each row self-explaining |
| amount_usd | numeric(14,6) NOT NULL | this box's share |
| computed_at | timestamptz NOT NULL | |
| **UNIQUE** | | `(cost_entry_id, box_id)` |

**Recompute strategy** (idempotent pg-boss job, keyed per `cost_entry_id`):
1. Triggers: cost entry create/edit/void; `fx_rates` edit (enqueue every non-voided entry with matching currency + date); batch membership change after the fact (late `missing_in_transit` resolution, late unload scan → enqueue all entries of that batch).
2. Job, in one transaction: re-resolve FX (`fx_rate`, `amount_usd` on the entry) → determine member boxes (batch scope: boxes with a `load`-type scan on that batch, minus unresolved `missing_in_transit`; receipt scope: all non-void boxes of the receipt; `direct_to_client`: that client's boxes on the batch/receipt) → `DELETE FROM cost_allocations WHERE cost_entry_id = $1` → insert fresh shares (largest-remainder rounding so shares sum exactly to `amount_usd`). Voided entries end with zero allocation rows.
3. A box's landed cost = `SUM(amount_usd)` over its allocations — exposed as view **`box_landed_costs`** (`box_id, total_usd, entry_count, last_computed_at`). **DECISION:** no cached `landed_cost_usd` column on `boxes` in v1; at ≤ 200k boxes the aggregate over an indexed `box_id` is fast, and one storage location avoids staleness bugs. Revisit for Phase 3.
4. Every recompute writes an `audit_log` row on the cost entry (old/new `amount_usd`, box count).

---

### 7. Indexes

Unique constraints listed above are indexes too and not repeated.

**FK / hot-path B-tree:**
- `sessions (user_id)`, partial `sessions (token_hash) WHERE revoked_at IS NULL` (covered by UNIQUE — keep just the UNIQUE)
- `clients (sales_manager_id)`
- `receipts (warehouse_id, received_at DESC)`, `receipts (client_id)`, `receipts (created_by)`
- `receipt_lots (receipt_id)`, `receipt_lots (warehouse_id)`
- `boxes (lot_id)`, `boxes (crate_id)`, `boxes (handover_id)`, `boxes (current_batch_id) WHERE current_batch_id IS NOT NULL`, `boxes (current_warehouse_id, status)`
- `crates (warehouse_id)`, `crates (client_id)`
- `batches (origin_warehouse_id)`, `batches (dest_warehouse_id)`, `batches (status)`
- `load_plans (batch_id)`, `load_plans (origin_warehouse_id)`, `load_plan_versions (plan_id)`, `load_plan_lines (version_id)`, `load_plan_lines (lot_id)`
- `scan_events (batch_id, type)`, `scan_events (box_id)`, `scan_events (handover_id)`, `scan_events (scanned_by, scanned_at)` (staff-activity report)
- `box_movements (box_id, id)`
- `cost_entries (batch_id)`, `cost_entries (receipt_id)`, `cost_entries (currency, cost_date)` (FX-recompute fan-out)
- `cost_allocations (box_id)`, `cost_allocations (cost_entry_id)`
- `handovers (client_id)`, `handovers (warehouse_id)`
- `attachments (entity_type, entity_id)`
- `audit_log (entity_type, entity_id, id)`, `audit_log (actor_id, created_at)`, `audit_log (warehouse_id, created_at)`, `audit_log (created_at)`
- `notifications (user_id, created_at DESC)`, `events (entity_type, entity_id)`

**Partial (status hot sets):**
- `receipts (warehouse_id) WHERE status = 'draft'`
- `receipts (warehouse_id, received_at) WHERE client_id IS NULL AND status = 'confirmed'` — unclaimed pool + aging digest
- `boxes (current_warehouse_id) WHERE status = 'in_stock'` — stock browser / plan editor
- `boxes (current_warehouse_id) WHERE status = 'ready_for_pickup'` — issue mode
- `boxes (current_batch_id) WHERE status = 'in_transit'`
- `boxes (id) WHERE missing_in_transit` — discrepancy report
- `notifications (user_id) WHERE read_at IS NULL` — bell badge
- `notifications (status) WHERE status IN ('pending','failed')` — admin delivery view
- `events (id) WHERE processed_at IS NULL` — outbox poller

**Trigram GIN (global search, spec §12 — `pg_trgm`):**
- `clients` — `gin (client_code gin_trgm_ops)`, `gin (name gin_trgm_ops)`
- `receipt_lots` — `gin (product_name_zh gin_trgm_ops)`, `gin (product_name_ru gin_trgm_ops)`
- `product_dictionary` — `gin (zh gin_trgm_ops)`, `gin (ru gin_trgm_ops)` (autocomplete fuzzy match)
- `boxes` — `gin (short_code gin_trgm_ops)` (substring search on scratched/partial codes; exact scan lookup uses the UNIQUE B-tree)
- `receipts` — `gin (number gin_trgm_ops)`
- `batches` — `gin (code gin_trgm_ops)`, `gin (vehicle_plate gin_trgm_ops)`, `gin (driver_phone gin_trgm_ops)`
- `crates` — `gin (code gin_trgm_ops)`

**DECISION:** global search is a per-type `UNION ALL` of trigram-accelerated queries (limit N per type, grouped client-side) — no materialized search table in v1; the < 300 ms @ 100k-boxes budget is comfortably met by trigram indexes at this scale. The query parser special-cases the combined `client-code+letter` form (spec §12: `gs777-a`): input matching `^<prefix><digits>-<letters{1,2}>$` is split and resolved as client `GS777` + lot letter `A` via `receipt_lots (letter)` joined on the client's receipts, in addition to the generic trigram pass.

---

### 8. Audit-log immutability

Three DB roles, created in the first migration:

| Role | Grants |
|---|---|
| `gsr_owner` | owns all objects; used **only** by migrations (`drizzle-kit migrate` runs with this role's `DATABASE_URL`) |
| `gsr_app` | runtime role in the app's `DATABASE_URL`. Table-level: `SELECT/INSERT/UPDATE` on normal tables (no `DELETE` except `sessions`, `login_attempts`, `cost_allocations`); on **`audit_log`: `SELECT, INSERT` only** — `UPDATE`, `DELETE`, `TRUNCATE` explicitly revoked |
| `gsr_readonly` | optional, for ops/BI: `SELECT` everywhere |

Belt-and-braces: a `BEFORE UPDATE OR DELETE` trigger on `audit_log` that raises an exception (protects even against accidental owner-role sessions; documented that a superuser can still bypass — that is the trust boundary).

**How the app writes it:** a thin repository/service wrapper — every mutating service call runs `db.transaction(async tx => { …mutation…; await audit(tx, {actor, entity, action, before, after, warehouseCtx}); await emit(tx, event?) })`. Audit row and domain mutation commit or roll back **together**; `before/after` contain only changed fields (computed by the wrapper via shallow diff). Request middleware supplies actor/IP/UA context. No code path mutates domain tables outside the wrapper (enforced by lint rule + the fact that raw `db` isn't exported to modules).

---

### 9. Drizzle notes

- One schema file per module: `modules/platform/schema.ts`, `modules/wms/schema.ts`; cross-module FKs import table objects (platform never imports wms).
- CHECK constraints via Drizzle `check()`; the few things Drizzle can't express (partial unique indexes, trigram GIN, role grants, the audit trigger, the `counters` upsert) live in hand-written SQL inside generated migration files — checked in, never edited after apply.
- All status/type unions declared once in `modules/*/constants.ts` and reused for both the CHECK constraint string and the TS type.
- Seed script (spec §18) is idempotent (`ON CONFLICT DO NOTHING` keyed by natural codes) so it can re-run in CI and demo resets.
