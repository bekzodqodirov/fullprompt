# GSR LOGISTICS — orientation

Read this first. `DECISIONS.md` (100 KB) and `CHANGELOG.md` (95 KB) are the full
record and are too big to read cold; this file is the map to them.

## What this is

A warehouse + CRM + accounting system for **GSR LOGISTICS**, a China →
Uzbekistan cargo consolidation company. ~20 staff. **It is live** on the
owner's Contabo VPS with real cargo and real money in it.

Cargo flows: a client's goods reach a Chinese warehouse (Yiwu, Guangzhou) →
receipt + per-box QR labels → loaded onto a truck (a *batch*) → customs →
an Uzbek warehouse (Tashkent, Andijan) → handed to the client.

## Who you are talking to

The owner, **Bekzod**. He writes in Uzbek — **reply in Uzbek, always**. He is
not a developer: explain in terms of his business (mijoz, prixod, partiya,
sklad, kub, tannarx), never in terms of tables and functions. He answers
precisely when asked precise questions, so ask numbered ones and offer options.

He decides scope. If you think a request is wrong, say so in a sentence, then
build what he asked for.

## Hard rules

- **Never** put an API key or bot token in chat, in the repo, or in a commit.
  They live only in the gitignored server `.env`, entered by him.
- **Never** run `docker compose down -v` (it deletes the volumes).
- **Never** write the model identifier into a commit message, PR, code comment
  or any pushed artifact. Chat replies only.
- Take a verified non-zero backup before every production update.
- Work on the branch you were told to; commits end with the `Co-Authored-By`
  and `Claude-Session` trailers used throughout the history.
- Don't open `AskUserQuestion` dialogs and don't schedule check-ins — ask in
  plain Uzbek text.

## Stack

Next.js 15.5 App Router · strict TS · pnpm · PostgreSQL 16 + Drizzle ·
next-intl · Tailwind (CSS-variable tokens) · pg-boss · Playwright + Vitest.
`output: 'standalone'`, served by `scripts/start-standalone.mjs`.

- `src/modules/platform/**` — auth, rbac, audit, db, files, i18n, settings,
  notifications, telegram, **fields** (custom fields)
- `src/modules/wms/**` — receipts, boxes, crates, planning, scanning, costing,
  finance, accounting, crm, reports, tnved, tracking
- **`platform` must never import `wms`.**

## Commands

```
pnpm db:migrate         # hand-written SQL migrations
pnpm db:seed            # idempotent; reference data, demo only on a fresh db
pnpm lint && pnpm test  # 385 tests
pnpm typecheck          # tsc --noEmit — the ONLY thing that types tests/
pnpm build && pnpm e2e  # 44 e2e
```

## Verification ritual (follow it, it catches real bugs)

1. Postgres dies between turns:
   `su postgres -c "/usr/lib/postgresql/16/bin/pg_ctl -D /var/local/pg/data -l /var/local/pg/log -o '-k /tmp' start"`
2. `gsr_dev` = the owner's real imported data. `gsr_ci` / `gsr_test` = throwaway.
3. Before e2e: **`fuser -k 3000/tcp`** — `pkill -f start-standalone` does not
   free the port and you will test stale code for an hour.
4. Run e2e **without `CI=1`** locally: `CI=1` selects a headless shell binary
   this container does not have.
5. **Reproduce CI's order before pushing**: seed once, run vitest, then run
   Playwright *without re-seeding*. CI uses ONE database for both. This is how
   the field tests leaking definitions was found — after CI went red.
6. **`pnpm typecheck` before every push.** `next build` types `src/` only, so a
   widened union that breaks a TEST's narrowing is green locally and red in CI
   (#591). Vitest transpiles without checking, so the tests pass too.

## Footguns that have cost real time

- **A missing i18n key throws at RENDER time**, in every locale. Four locales:
  `ru` (default), `uz`, `zh-CN`, `en`. Locale tests must anchor on a source of
  truth outside the bundles — comparing bundles to each other cannot catch a key
  missing from all four (DECISIONS #163).
- **No segment-level `loading.tsx` under `(protected)`** (DECISIONS #98).
- **Drizzle renders columns unqualified in a single-table select**, so
  `${table.col}` inside a correlated subquery binds to the SUBQUERY's table.
  Write `${table}.column` (#128).
- **`x.id IN (SELECT …)` as a JOIN predicate is a table scan per row** — 28.7 s
  → 0.36 s when joined through `box_movements` (#152). Batch membership is a
  JOIN through `box_movements`, never a subquery in a join predicate.
- **A `Date` interpolated into a raw `sql` fragment reaches postgres.js untyped**
  and it refuses to send it. Bind an ISO string with `::timestamptz` (#156).
- **A JS array bound into a raw `sql` fragment** does not become a postgres
  array. Use `inArray`/`notInArray`, or `sql.join`.
- **A dependency may fetch ITSELF from a CDN at runtime.**
  `browser-image-compression` builds a Web Worker that `importScripts` the
  library from `cdn.jsdelivr.net` on every photo — 12.7 s of silence here, and
  unreachable in the Chinese warehouses where the cargo is received (#664).
  Pinned by `tests/unit/vendored-lib.test.ts`: the copy in `public/vendor/`
  must be byte-identical to the installed package, and `compress-photo.ts`
  must be the ONLY importer. Sweep the built bundle for foreign hosts before
  adding any browser library: `grep -rhoE "https://[a-z.]+/" .next/static/`.
- **Tailwind only compiles classes it can literally see** — a colour class built
  at runtime does not exist. Hence lookup maps like `STAGE_CLASS`.
- **Playwright file names carry the run order** and sort lexicographically, so
  `m10-` lands between `m1-` and `m2-`. One worker, one shared database:
  **state a spec leaves behind is the next spec's input** (#154). Configuration
  left behind (a field, a role, a stage) is worse than data — it changes what
  every screen renders (#183).
- **An `addInitScript` stand-in for something the page also loads is a race,
  not a fixture** — the page's own script assigns over it. Serve the script
  instead (`page.route(...).fulfill`). This container cannot reach the public
  internet and the CI runner can, so that race resolves DIFFERENTLY in the two
  places: green here, red there (#278).
- **A server action's request body is capped at 1 MB** by default. Anything
  file-shaped needs a route handler, not an action (#291).
- **A disabled checkbox posts nothing**, so on a replace-all form it reads as
  "remove". Re-post locked values as hidden inputs (#171).
- Migrations are hand-written SQL + an entry in `meta/_journal.json`. Drizzle
  wraps **all pending migrations in one transaction**, so `CREATE INDEX
  CONCURRENTLY` is impossible and a failure rolls everything back.

## Where the truth lives

| Question | File |
|---|---|
| Why is it built this way? | `DECISIONS.md` — 489 numbered entries, newest last |
| What shipped and when? | `CHANGELOG.md` — newest first, written in Uzbek for the owner |
| What is a deal? | `docs/DEALS.md` — the agreed spec, not yet built |
| The VED module | `docs/VED.md` — agreed 2026-08-22; **phase A SHIPPED**, B-E open |
| Roadmap / status | `docs/PLAN.md` |
| Deployment | `docs/DEPLOY.md` |
| Client chat into the CRM | `docs/TELEGRAM-CRM.md` |
| The Frappe study / UX programme | `docs/CRM-UX.md` — agreed 2026-08-04; batches 1-4 COMPLETE; 5 in progress |

## State — 2026-08-23

**VED phases A and B are on this branch** (`docs/VED.md`; migrations **0085**
and **0086** — the ledger must reach **87**).

Phase B is the workspace that replaces the Excel. A price on the screen is a
DRAFT (recomputed from the dictionaries every render); a price in
`calc_versions` is a FACT (written once, carrying the tariff row and every
rate that made it); **the seal is the one door between them**. Three
dictionaries born here, all versioned by `effective_date` and read like
`fx_rates` — with **no earliest-row fallback**, because a missing baza means
nobody has ever priced this product. Baza + rates live at
`/hisoblash/lugatlar` under `ved.docs` (a `ved_manager` cannot open ANY
`/admin/*` page); the freight tariff lives at `/admin/tarif` under
`admin.dictionaries.manage`, so the person giving the discount cannot move
the list price it is measured against.

The engine (`calc/pricing.ts`, pure) **never returns a number it had to
invent** — every entry point answers `{ok}` or `{ok:false, reason}`, and the
screen prints ⚠ + the reason, never `$0`. The priced unit is the **ITEM**
(one TNVED code holds several products with different bazas). His tariff lives in
`calc/tariff-seed.ts` (one home for the seed AND the fence, #513) and is now
CONTIGUOUS by his own answers — «700–900» became **701–999**, so 700 stays in
«501–700» and 900-999 takes the $320 row; a unit test walks every whole
density 1..1500 in both zones and asserts exactly one band claims each. The
lookup still **refuses** a hole (`band_missing`) and an overlap
(`band_ambiguous`), because that is a property of the tariff a person edits
tomorrow, not of today's data. The band is looked up by a WHOLE
kg/m³, or an ordinary 100.4 falls between «1–100» and «101–150» and is
covered by neither. The seal is one transaction whose UPDATE RETURNS the
version number; there is **no re-open** — a correction is a NEW request
(`supersedes_request_id`), which is also what an expired quote needs. The
sealed price is written onto the card and LOCKED: both ✏️ forms lose their
quote inputs and `updateLead`/`updateDeal` refuse a changed one, with the
locked branch re-posting the values as hidden inputs (#171). **The model
proposes words and can never reach a number**: `rate_source`/`baza_source`
allow `'dictionary'|'typed'` and there is no `'ai'`, every group must be
confirmed by a person, and `tests/unit/ai-advisory.test.ts` pins all three
fences. Decisions **#752-760**. Phase A's typed «Bajarildi» deliberately
STAYS — the dictionaries ship empty, so on deploy morning nothing can be
sealed at all.

**1799 unit/integration + 166 e2e green** on a fresh `gsr_ci` in CI's order
(vitest, then Playwright without re-seeding); screenshots at 360×800 and
1280×900, document width equal to the viewport at both. m8-crm's two desktop
drag tests failed once in an earlier full run and passed alone and in the
next two full runs — recorded as a flake, not diagnosed.

**His three tariff answers arrived the same night** («1 sen aytgandek / 2
ozing togirla ketma ket qanday kelyabti shunga mosla / 3 shunday qolsim») and
are built: 900-999 → the $320/$200 row, bands run consecutively (each starts
at the previous one's top plus one), the 1000 step stays a step. Recorded as a
SEED correction and not a dated superseding row, because 0086 has never
deployed and the seed writes only into an empty table. Decision **#761**.

**Phases C-E are open**: the client-facing offer sheet, upsale (which reads
`calc_versions.discount_usd`), and calc-vs-actual (which reads the whole
`breakdown` snapshot).

## State — 2026-08-22

**VED phase A is on this branch** (`docs/VED.md`, migration **0085** — the
ledger must reach **86**): the calculation request became a JOB with its own
section/route/kg/kub/goods/materials, the bot and the card form land in ONE
queue at `/hisoblash`, the round-28 clock is reopened with its overdue sweep,
the checklist is the bot's own `missingFields`, a bounce-back needs a typed
reason and the finish records the ANSWER (amount + note, pushed to the
seller). Assignment moved from the seller to the QUEUE (fewest-open-first
over `ved.docs`), and 0052's «one open request per card» index is DROPPED —
a card may carry several jobs. Decisions **#748-751**: the attachment gate
widened for lead notes a request points at (the blocker three reviewers found
independently), `isServerBehind` now knows `42703` as well as `42P01`, and
`ved.docs` is stated as a four-power bundle for the owner to split when he
wants a calc-only person. 1739 unit/integration + 161 e2e green on a fresh
gsr_ci in CI's order; screenshots at 360 and 1280. **Phases B-E are open**:
the workspace and its four dictionaries, the price book, upsale, and the
calc-vs-actual control.

## State — 2026-08-13

`main` is the trunk and **everything is merged into it** — PR #1 = rounds
1-55; #3 = 56-69; #4 = the truck-marker follow-up; #5 = the calls round;
#6 = rounds 70-71; #7 = the calls day-one fixes; #13 = round 74 (capacity);
#14 = rounds 75-76; #15 = round 77; #19 = round 79's card work; #17 = rounds 78-79 (the Telegram ↔ CRM loop);
#20 = round 81's two login holes; #22 = round 83 (ads intake, the drain lock,
demo data out of the seed); #24 = round 85 (the S3 backup); #26 = round 86
(automation rules); #25 = round 87 (the funnel's second door, built by the
OTHER session); #28 = the VPS move's three defects; #30 = the seller's money
scope and the split thread; #31 = the history's place, the logout door and the
agent sheet by truck; #32 = the tray's door, the connect-time week and the
calls selector (all four the OTHER session); #33 = rounds 94-95 (the honest
«javob kutmoqda», then files/reply/forward/share); **#34 = the Meta go-live
docs, the taqsimot and the tarjimon** (the OTHER session's rounds 96-97);
#39 = round 99 (the timeline redesigned after the owner's rejection —
dated journey from `box_movements` + the named road bar); **#36 = the OTHER
session's analytics round** (`/crm/tahlil`, `lost_reasons`, its 0078);
**#40 = the OTHER session's round 100** (his 14-item list's fixes, the
staff+client merged bot keyboard 13A, warehouse lat/lon = its
`0079_warehouse_coords`); **#45 = rounds 103-106** (client codes, the backup
round, the full audit, its open tail — merged AND deployed 2026-08-18,
ledger 83). This branch carries **round 100 (this session) —
the AI yordamchi** (his «sistemamizga AI ulay olamizmi», answers: both
tiers, both surfaces, no client-facing AI, read-only v1): tier 1 for every
staff member = a tool loop over the SAME scoped functions the screens use
(`platform/ai/tools.ts` — botLookup/globalSearch/composeMyDayText, actor
threaded, toolset built per actor); tier 2 for the super_admin/admin ROLE
adds `run_sql` under the **`gsr_ai_reader` Postgres role** (0080: allowlist
default-deny, column-grants minus password/secret columns, four probed
fences, everything on the ONE `.begin` connection — the module `db` runs
UNFENCED, red-proven) plus `cash_flow`/`company_balance` tools, because
money from raw columns is confidently wrong (#701). Surfaces: the staff
bot's text fallback (free lookup first — `codeCandidates` — then the model;
strangers never reach it, and 13A's cabinet buttons next() BEFORE it) and
`/ai` (menu entry only when the key is configured). `ai_questions` = the
audit AND the atomic daily cap (`ai_daily_limit`, 40). Tier 1 runs
claude-sonnet-5, tier 2 claude-opus-5. Found by the review, fixed here:
`botLookup`'s balance line had never learned round 91's money scope (#702).
**His server needs the NEW `ANTHROPIC_API_KEY` in `.env`** (the old one is
burned) — without it everything deploys and the assistant honestly says
«sozlanmagan». PR #41 (this round) is MERGED and **DEPLOYED — he confirmed
81 on 2026-08-13 evening, put the NEW key in, and confirmed the assistant
ANSWERS LIVE («ishlayabti»)** — the AI round is fully in production on both
surfaces.
**Round 101 — the pre-go-live audit** (his «avval audit qilib chiq …
hamma uje ishlatishni boshlaydi ertada»): six lenses, verify-to-refute,
**six confirmed defects, all fixed** (#705-709). The two leaks: the partner
screens + the partner-receipt attachment branch had never learned round
91's money scope (a seller read the whole creditor ledger by URL), and
`handovers/[id]/act` + `batches/[id]/manifest` gated on a LOGIN alone while
their four siblings gated on permission + warehouse. The availability one
is the AI round's own: grammy's poller is SEQUENTIAL and the handler
AWAITED the model, so one admin's question froze every customer's cabinet
for 20-120 s (10 min on a hang — `new Anthropic()` had no timeout); the
answer now dispatches off the middleware and the call carries a 60 s
deadline. Plus: a transient Telegram 429 permanently DROPPED a «yukingiz
keldi» (settled `failed`, and `dueArrivalNotices` reads only `pending`) —
now transient-vs-permanent with a 5-attempt budget; login is verify-then-
throttle (a wrong-guess lockout no longer refuses the owner's correct
password); and the AI daily cap is a real lock — MEASURED, 10 parallel asks
against a limit of 3 granted all ten before the fix. Red proofs ×6, two of
which first stayed GREEN and were re-anchored (#709). No migration.
1580 unit/integration + 155 e2e green on a fresh db in CI's order.

**Round 102 — the first two reports from the floor** (#710-712, the day the
whole staff started). (1) «Bugun qo'ng'iroq» filled up and never emptied:
`followUps` had NO stage filter, so a lead moved to won/lost kept its date
and stayed for ever — and every advert lead arrives booked for TODAY, so the
pile grew by itself. Three parts, two of them his call: the list joins
`lead_stages` and takes `kind='open'` (the bug); a real stage MOVE clears
the follow-up («bosqichni o'zgartirgan zahoti avtomatik tushsin»); and every
day-screen row carries «✓ Bajarildi» / «Ertaga» (`setFollowUp`, ownership
re-derived server-side — the row arrived as an id in a form post). Overdue
OPEN leads deliberately STAY, his answer: late work must not hide.
(2) Photo upload slow in the Chinese warehouses: the interesting theory
(thumbnails silently missing → the serve path falls back to full-size) was
REFUTED by one query on his data — **401 of 406 photos have thumbnails** —
and the real cause was the `for` loop that uploaded 10-20 photos one at a
time from China to Europe. `components/pooled.ts` runs four at once; all
three wizard upload paths use it. Red proofs ×4, one of which first stayed
GREEN because the two lead fixes mask each other (#711 — the fixture now
writes the closed stage directly, which is also what production's existing
rows look like). No migration. 1587 unit/integration + 155 e2e green on a
fresh db in CI's order; one unnamed failure in the first full run did not
recur in the re-run or in three repeats of the touched files.

**Round 103 — the client-code review** (#714-716, his «yangi klientga kod
berishni korib chiq hatolik ketmayabtimi»). The generator itself is SOUND
and that is a finding: the 50-gap main-sequence rule, the lowercase prefix,
a prefix ending in a digit, regex metacharacters, leading zeros, and «a code
is never reused, inactive clients included» all hold — verified, not assumed.
The defects were around it. **The serious one is not about codes at all:**
`createClient` called `getSetting('client_code_prefix')` from INSIDE its
transaction, and `getSetting` runs on the module `db`, i.e. the POOL — so a
transaction already holding one of the ten connections asked for an
eleventh. **MEASURED: 9 simultaneous creates finished in 121 ms, 12 never
returned, `pg_stat_activity` showing exactly ten backends parked on `begin`
/ ClientRead** — a permanent, unrecoverable freeze of the WHOLE app (the
pool is every page's), not a slowdown. One line moved up eleven. Swept
`src/`: the only instance in all 25 files that open a transaction, so the
tripwire `tests/unit/tx-pool.test.ts` guards the RULE (every transaction
body × every pooled name) rather than the function; source-shape on purpose
— a behavioural test for a deadlock takes its own vitest worker down.
Second: the advisory lock serialises the generator against ITSELF (10 at
once → 10 distinct codes; lock stripped → only 2 of 10 survive), but a
MANUAL code takes no lock, so the auto path could lose to it and tell
somebody who typed nothing «bu kod band» — it retries (3) and takes the
next free number, while a TYPED code that is taken is still refused, because
retrying there hands a person a different code from the one on the carton.
Proven deterministically with a held-open second connection, not a burst.
Third: `updateClientAction` had no 23505 catch — a rename race was a white
page (#472's rule). No migration. 1616 unit/integration + **155 e2e all
green** on a fresh gsr_ci in CI's order. TEST LESSON (#716): the race file's first version
re-read the prefix setting at the top of EVERY test, so the «original» it
restored was its own `ZZR` — caught by reading the database after the run,
not by an assertion; snapshot once in `beforeAll`.
**Round 104 — the backup round** (#717-720, his «systemani toliq audit qil,
backup olishni systemasini oylab chiq, rasimlar va hamma back up google
drivega back olamiz»). **THE HEADLINE: the off-site backup had never run
once.** `runBackup` shells out to `pg_dump`; the app image is `node:22-slim`
with no postgres client, so every night = ENOENT → alarm → thrown job, and
`runOffsiteBackup` sits BEHIND that in the same function. Whichever
destination was configured, nothing has ever left the machine. The alarm was
silent too: `sendPendingTelegram` settles a notification as **`muted` with
«telegram not linked»** for an admin with no linked staff chat. The compose
`backup` service (postgres:16) HAS been taking a good dump all along, into
the same volume. Fix, deliberately WITHOUT a Dockerfile change (an
apt.postgresql.org dependency on deploy morning is #472's trap, and it cannot
be tested from this container): `runBackup` ADOPTS a dump written in the last
26 h when it cannot take its own, and names which happened; that also gives
`ops/backup.sh` the alarm it never had — if IT stops, no fresh dump is found
and the failure is raised. `ops/backup.sh` also refuses to prune when its own
dump comes out under 4 KB. **OBJECTS: migration 0081** `backup_objects`
(key + DESTINATION as the PK, so a new destination reads «nothing there
yet»); `backup/objects.ts` copies originals only (thumbnails are derived —
`pnpm restore-objects --thumbs` rebuilds them), holds **2 GB back for the
dump** and alarms rather than crowding it out, verifies the size the
destination reports BEFORE writing the ledger row, and is bounded by a wall
clock so the first night does not run until morning. `pnpm backup-objects` /
`pnpm restore-objects` for the backfill and the recovery; a `BackupPanel` on
/admin so the state is visible without a log. **The jam (#719):** the first
version stopped a run when a batch all failed, so ONE attachment whose bytes
are gone blocked every photograph behind it for ever — found because my own
three test photos never moved in a database holding 100 such rows; the window
now skips past the failures. **The fence (#720):** `tests/unit/tx-pool.test.ts`
now DERIVES the pooled set from the code and follows calls — the audit's
availability lens found `submitPlan` calling `availableByLot()` on the pool
inside its transaction (#714's total freeze, in the warehouse's plan path,
AND a correctness bug: the stock check answered from a connection holding
none of the transaction's locks). Two red proofs stayed GREEN first — a
parameterised handle left the function out of the set, and a generic
signature (`getSetting<K …>`) hid it entirely — so the fence is anchored on
names it must find. 1613 unit/integration green on a fresh gsr_ci.
Ledger must reach **82** (now **83** — round 106's 0082). **Owner still has to: put the Drive credentials in
`.env` (docs/BACKUP.md, publish BEFORE minting the token), decide the 15 GB
question (Google One 100 GB ~$2/mo, or the S3 bucket from round 85), and keep
a copy of `.env` off the server — `TG_SESSION_KEY` is what decrypts the
managers' Telegram sessions.**

**Round 105 — the full-system audit** (#721-726, his «systemani toliq audit
qil … hatoliklar yoqligini oylab analyz qb chiq»). Sixty agents, seven lenses,
every finding given a SKEPTIC and a REPRODUCER and kept only if neither could
refute it: **26 candidates → 19 confirmed, all fixed.** (The five backup
findings read REFUTED in the run because the verifiers read the tree after
round 104 had landed.) CARGO: `editLot` on a VOIDED receipt minted brand-new
live boxes and offered to print their labels — the structural lock reads «no
ACTIVE box has left in_stock» and on a voided receipt the active list is
EMPTY, so `[].some()` passed it (#723); one `lost` or `void` carton blocked
voidReceipt / moveReceipt / returnUnclaimedToSender FOR EVER, so
`splitForCorrection` gives all three the same three sets and leaves terminal
boxes strictly alone (#722); and the unload screen never took back a mark the
server refused — a queue flushed after «Tushirish tugadi» read 150/150 all
green while those cartons were recorded missing, and the fix needed the SERVER
to start naming the refused code first, or it would have done nothing (#724).
MONEY: the client CARD still asked the pre-round-91 money question (a seller
read any customer's balance, reachable by clicking from /suhbatlar);
`cost_allocations.client_id` never followed `assignReceiptClient`, so claimed
unclaimed cargo showed revenue with no cost and vanished from
`landedCostByClient`; a recurring template with a wrong-currency till aborted
the WHOLE monthly run part-way, every month — now refused at save and
per-template caught, with «N tasi o'tmadi» on screen. ACCESS: `/transit` was
gated on a login alone; the other three batch documents checked permission and
not warehouse — all four go through one `guardBatchDocument` now.
AVAILABILITY: **#714's shape a third time** — `confirmReceipt` →
`priceControlOnReceipt(tx)` → `getSetting` on the pool, in the warehouse's
busiest button; and the hisoblatish AI analysis was still awaited on the
sequential bot poller with an Anthropic client built with no timeout.
INTEGRITY: three uncaught 23505/22P02 white pages (`5..` in a number filter,
a duplicate dictionary name, a duplicate field label). **The fence itself
grew twice**: `tx-pool.test.ts` now closes the pooled set TRANSITIVELY and
strips comments first — my own sentence «ONE function for all four…» minted a
pooled function called `for` and every loop in `src/` counted as calling it
(#725). TWO red proofs stayed green before it worked, and #726 records the
worse mistake: I undid one with `git checkout` and took two uncommitted fixes
with it, which is exactly what #430 forbids. 1630 unit/integration + **155
e2e all green** on a fresh gsr_ci in CI's order. Still OPEN from the audit and
stated to him: the tg-listen container holds a pool connection per account,
`sendPendingTelegram` has no claim (a double send is possible if two drains
overlap), a db blip after a successful send can still lose the thread's copy,
and four second-pass candidates the completeness critic named (/map is open to
any login; deactivated staff keep getting notifications; expected-arrival
actions check permission but not warehouse; the in-transit report counts by
the live pointer).

**Round 106 — the audit's open tail** (#727-730, his «ha tuzat» on the
stated-open list). **Migration 0082** (`notify_claim` — `claimed_at` +
'sending' in the status CHECK; count must reach **83**). The drain has a
CLAIM: one `UPDATE … WHERE id IN (SELECT … FOR UPDATE SKIP LOCKED)
RETURNING`, ten-minute reclaim for a dead drain's rows (attempt counted,
terminal at the cap) — measured, two exhaustive claimers overlap on 0 rows,
600 with the clause stripped. The two double-send SOURCES are dead too:
`startBoss`'s registrations are NAMED with a per-process done-set (the old
«registration is idempotent» comment was false — `boss.work` mints a worker
per call), and `enqueue` is a SENDER (`ensureListening()` = boss.start + a
queue upsert) so tg-listen no longer boots the fleet — which was also
running the nightly backup in a container with no backups volume.
Deactivated staff leave EVERY recipient list (`usersWithPermission`/
`usersWithRoles` ask `users.active`; delivery settles queued rows as
`muted / user deactivated` — user_roles survives deactivation BY DESIGN, so
the filter lives in the lists). `takeListenerLock` holds every account's
advisory lock on ONE shared reserved connection (per-account reservations
would have eaten the pool of ten by the 10th manager, silently); in-process
exclusivity restated as a held-keys set because advisory locks are
reentrant per session. tg-listen's `unsettled` CARRIES the echo, built
BEFORE `markSent` — a db blip between the two writes used to lose the
thread's only copy of a reply the customer already has. The batch-reader
door is ONE list (`wms/batches/read-door.ts`) with four consumers —
/transit, /trucks, /map, search — /map's per-client stock scoped like the
stock screen, trucks by two ends, nav items promising exactly the door's
list (spelled out in nav.ts, platform must not import wms; unit fence pins
the two lists). Expected-arrival services take the writer's scope and
refuse `wrong_warehouse` judged by the ROW. `inTransitBatches` counts
`batch_departed` movements, not the live pointer (#440's last consumer —
a half-unloaded truck drained 180 → 0 on the report). Red proofs ×6;
TEST LESSON (#730): a claim test on a shared queue claims to EXHAUSTION and
restores the foreign rows it parked, or it asserts about strangers (#713).

**Round 107 — the owner's six answered items** (#731-738, his answers
«1b / 2a har biriga / 3 / 4 ha yetarli / 5 sen aytgandek lekin kompakt /
6 faqat ekranda»; the four bigger designs were judged by a 12-agent
adversarial workflow BEFORE code and fourteen decisions were overturned —
every one recorded). **Migration 0083** `expense_requests` (count must reach
**84**). (1) The quick «+» client modal stays OPEN on the minted code — big
mono banner + copy + card link (`QuickClientResult.code`); a `CopyChip`
joined the client card's h1. (2) **Winning a lead is a ceremony**: `winLead`
subsumes convertLead (mint OR attach-by-typed-CODE with the name echoed back
before anything is written — the attach has no undo; client written onto the
lead FIRST so a retry mints nothing twice; ALWAYS a deal carrying the lead's
quote with per-column null mapping — `Number(null)` is a $0 quote; manager =
lead.ownerId or round 91 hides the client from its winner) and every other
door refuses `convert_required`: moveLead (internal `viaConvert` NO action
exposes), updateLead (change-gated), createLead born-won, deleteStage into a
closed target, the bulk bar (won options dropped; «har biriga» = bulk-to-won
refused). `leadFormStages` drops won from LEAD pickers only — deals keep
their plain won move (m9v). A re-win opens a SECOND deal deliberately
(confirm names it); won-without-client legacy leads keep the ConvertForm
door. WonDialog ends in the item-1 banner; m8 rewired; won-law.test.ts pins
the wiring. (3) `priceControlOnReceipt`'s no-deal branch SPLIT: open deals
exist → new `UnlinkedCargo` («biriktiring», naming codes), none →
UnquotedCargo; the prixod staff text carries «bitimga biriktirilmagan» /
«bitimi yo'q — narxlatib qo'ying» via `dealLinked === false` strictly (old
events render unchanged, #688). (4) **Admin home dashboard**
(`admin-dashboard.tsx`): Pul/Yuk/Savdo/Signallar off the screens' own
exported functions; EXCLUSIVE with role flows (both-hats admin keeps the
working home, stated); isAnalyst ROLE + each block's DESTINATION permission;
`salesSnapshot`'s month counts moved to the closed_at clock (it disagreed
with tahlil); open-deals sum FILTERS USD + names the other-currency count;
zaxira = three states (sozlanmagan/bor/OLINMAGAN); `notificationProblemCount`
excludes by-design muted; m9p's tile fence scoped to new `home-tiles` testid.
(5) **Rasxod xabari**: fold on /receive (summa+izoh+chek, photos pre-bound
#180, authorize AT the posted warehouse #514) → event to finance.expenses
holders minus the reporter → queue panel on /accounting/expenses where
«Kiritish» CLAIMS (`WHERE status='open'` — one press wins), a refusal
releases, a crash shows as ⚠ done-with-nothing, voidExpense RE-OPENS the
request (#528 pair). STATED: finance.expenses = buxgalter/admin today; the
logist gets it only if he grants the role «Xarajatlar» on /admin/roles,
which opens the whole expense book — his call. (6) **/stock's yashik
layer**: `crateStock` — member = crate_id + the page's four statuses +
`current_warehouse_id = crates.warehouse_id` (round 31's short-loaded
member red-proven), gated `crates.manage` (every crate surface is; /stock
is a bare login), overflow ⚠ compares values AS PRINTED (numeric strings,
#663), q never reaches the strip, «faqat ekranda» — no Telegram, no XLSX.
Process notes (#738): `pnpm typecheck | tail` reports TAIL's exit code —
two red gates slipped into commits before being caught; a warehouse an
audited action touched can only be DEACTIVATED in cleanup (audit_log FK).

**Round 108 — the third speed round** (#740-742, his «sistema sekin
ishlayabti … ayniqsa crmda»). **Migration 0084** (count must reach **85**).
The slowness was QUEUEING, not any screen: measured on a clone, /crm renders
in 130 ms alone and every statement is under 0.4 ms warm, but the ONE Node
process saturates — 16 concurrent requests = p50 1,070 ms, his sentence
reproduced. What fed the concurrency all day: every open card with a
Telegram panel re-rendered its WHOLE page every 10 s (every 2 s while
`pendingFor` returned rows — and that includes `failed`, which only a human's
✕ clears, so ONE bad reply pinned a tab at half a heavy render per second
FOR EVER); `chatBadges` sorted the entire `tg_messages` table per board
render for a supervision viewer (74.5 ms disk-spill → 1.5 ms index-only);
`activeClientsByPhone` hydrated the whole client book per call per tick;
and the notifications reclaim scanned 680k rows every minute. Fixes: the
**chat pulse** (`/api/chat/pulse` + `ChatPulse` — a token of indexed counts
computed behind the pages' OWN fences, `router.refresh()` only on change,
2 s beat kept for queued/sending only, 120 s floor for what no token sees;
judged by three lenses before code and carrying their six corrections —
`edited_at`, the late-attachment pair, per-status outbox counts +
`max(queued_at)`, the server-evaluated stuck bucket, the account-state word,
and a server-computed BASELINE prop), `chatBadges(viewer, clientIds)`
bounded to the drawn cards, a last-SEVEN-digit SQL prefilter (a strict
superset of `phonesMatch`'s last-nine rule, so JS stays the arbiter), and
two partial indexes. Proven live: a SQL-inserted message reached an open
thread in 4.1 s with no navigation. **#430 broken a THIRD time** (#742): a
red proof reverted with `git checkout` took the round's own uncommitted fix
with it; every later proof used paired `replace()` edits.

**Round 109 — his three items** (#743-746). NO migration (85 stands).
(1) **The dashboard was invisible to him** because round 107 mounted it in
the ELSE of `buildHomeFlow` — and any admin who also carries a working role
HAS a flow, which is how his own accounts are set up («bir admin va
sotuvchi»). Both now: the day's work above, the company below;
`home-dashboard.test.ts` is source-shape (the only behavioural oracle needs
a role grant every later spec would inherit, #183). (2) **A crate is a
PLACE on both screens** — `components/crate-rows.tsx`, one list for /stock
AND the truck card: code · client · «1 mesta» · the crate's OWN m³/kg, with
what is inside on a small second line; over-capacity crates sort FIRST (his
«ogohlantirish spiskani tepasida tursa»), and the rows stay OUTSIDE the
screens' Σ or every crated cube doubles on a number the tannarx reads.
`batchCrates` takes membership from `batchMemberFilter` (#440 — an unloaded
truck's boxes point at nothing, and round 31's short-loaded member must not
ride a truck it missed); gated `crates.manage` like every crate surface.
(3) **The road is DOWNLOADED once** (his «B»): `pnpm fetch-road-geometry`
writes `tracking/road-geometry.ts` — 8 legs, ~12 KB, simplified at 0.02°,
and the running app never calls a routing service; `road(key)` falls back to
the hand-drawn corridor, so the file is an improvement and never a
dependency. Border legs fetched SEPARATELY (no engine drives through a
closed post) and the wait pinned to the ROAD's last point, or the stationary
leg creeps across the border. MY MISTAKE, recorded: the first fetch used a
hand-typed Irkeshtam 0.95° off the app's own, so the Chinese leg stopped
80 km short — endpoints now copied verbatim from map-data's `P` block and
fenced (every leg starts/ends within 0.15° of its named place; the China
corridor never climbs above 43.5°N = his «urumchiga kirmaydi»). A truck
booked China → Uzbekistan in ONE batch is composed of the same legs
(`cnLeg` + `ka2uzLegs`) instead of a straight line, and gains the three
checkpoint segments. Marker work: the warehouse count badge anchors to its
icon, and the SVG fallback finally draws the same cab-and-trailer Leaflet
has had since round 98. **NOTE for the next map round: which renderer he
sees depends on the SERVER** — with `.data/basemap/corridor.pmtiles` absent
the page draws the SVG schematic (round 98 told him to fetch it on the new
VPS; never confirmed). Both renderers read the same `routePoints`.
1705 unit/integration + 157 e2e green on a fresh gsr_ci in CI's order.
**Round 109b — his report AFTER the deploy** (#747): «mashinalar iconkasini
ozgartirmabsan va mashinalar iconi bn soni alohida turibti, skladlarniki
yaxshi chiqibti» — the last clause is the diagnosis (#476). The warehouse
read right because 109's badge fix wrapped its icon in an inline-block span;
the truck had none, and **Tailwind's preflight sets `svg {display:block}`**,
so in the marker's 80 px `text-align:center` box the label centred as TEXT
while the lorry stayed at the left edge — and the label being a BLOCK above
it pushed the icon out of Leaflet's anchored box. MEASURED in a browser: the
lorry was drawn **24 px left and 18 px below its own coordinate**. Now the
label is `position:absolute`, the svg sits in the icon's own 38×28 box, and
`iconSize`/`iconAnchor` agree — re-measured, every marker's centre equals its
point exactly. The ICON is a lorry SILHOUETTE (round 98's was a rounded
SQUARE with a 12 px truck inside, which at map scale reads as a square),
facing left because the corridor runs right-to-left, white halo, drawn
identically in BOTH renderers. `tests/unit/map-markers.test.ts` pins the
shared path, the absolute label and the three numbers. CONSEQUENCE: a
just-departed truck stands ON its origin warehouse and takes the tap
(deliberate — Leaflet's zIndexOffset 1000), so m9c now picks a pin
`elementFromPoint` says is free instead of `.first()`.

Latest migration: **0084** (`speed_round` — two partial `notifications`
indexes + `tg_messages.edited_at`; count must reach **85**);
0083 (`expense_requests` — the rasxod xabari queue;
count must reach **84**;
0082 `notify_claim`, 0081 `backup_objects` — round 104/106, count 83;
0080 `ai_assistant` — `ai_questions`,
`v_client_balance_usd` + its equivalence test, the `gsr_ai_reader` role and
its allowlist; **renumbered from 0079 on merge, the ELEVENTH collision** —
the other session's `0079_warehouse_coords` took the same number AND the
same `when` 1785190000048 and merged first, so mine moved to `when` …049;
count must reach **81**;
0079 `warehouse_coords` — the OTHER session's lat/lon on warehouses;
0078 `sales_analytics` — the OTHER session's `lost_reasons` dictionary
and `closed_at` on leads+deals; count 79;
0077 `batch_customs_cleared` — `batches.customs_cleared_at`,
the «rastamojka tugadi» tap, additive and nullable so NULL reads «nobody has
said»;
0076 `client_notices` — the claim ledger behind «one
«yukingiz keldi» per customer per truck»: kind + ref, one row per (client,
kind, ref_type, ref_id), pending until the window closes or `finishUnload`
releases it;
0075 `board_order` — where the owner put a card in its
column, on `leads` AND `deals`, backfilled from the order the board showed the
day it deployed; **renumbered from 0073 on merge, the NINTH collision** — the
other session took 0073 `inbound_routing` and 0074 `lead_field_map` with the
same `when`, so mine also had to move its timestamp, not just its name;
0074 `lead_field_map` — the tarjimon, `lead_intakes.fields` and the routes'
kub window; 0073 `inbound_routing` — `users.inbound_rota` backfilled from the
role flag, plus `inbound_routes`;
0072 `tg_reply_forward` — which message a reply quotes,
and who a message was forwarded from; 0071 `tg_chat_reads` — how far a manager
has read a Telegram dialog, so «javob kutmoqda» can stop lying;
0070 `tg_history_backfill` — the connect-time week's stamp; 0069 `warehouse_quick_batch` — a per-warehouse
switch for unplanned trucks; 0068 `inbound_webhook` — a per-source key for every
platform's own lead form; 0067 `automation_v2` — rule conditions, time triggers
and `automation_fires`; 0066 `inbound_leads` was the ads round;
0065 `tg_chat_lead` — a tray rule may point at a lead;

0064 `tg_lead` was the work-account switch, lead-owned chats and the hashed
peer index; 0063 `call_lead`, 0062 `lead_quote`, 0061 `call_dedup_by_user`,
0060 `call_recorder` and 0059 `reply_templates` are the calls track's). Every
numbered phase is shipped; rounds 56-69 + the calls round + its day-one
fixes were built by ANOTHER session and are on main — read
`docs/CRM-UX.md` before touching lists, search, bulk or quick-create. The
driver app **still needs its v1.3 APK released**
(Actions → driver-apk → artifact → Admin → Haydovchi ilovasi), and the
calls round needs its FIRST APK published the same way (Actions →
calls-apk → artifact → Admin → Qo'ng'iroq ilovasi).

**DEPLOYED — 2026-08-10.** The year-long gap is closed. The owner moved
production to a bigger Contabo VPS (**169.58.150.226**, 4 vCPU / 8 GB) and
deployed `main` onto it in one evening, walked through step by step in chat.
What the move proved and cost is in `docs/DEPLOY.md`; the three code defects it
uncovered are #632-634.

State on the live server: migrations **69** (0068 the tail), 328 clients,
27 users, 7 warehouses, 704 tg messages, 67 call logs, 308 attachments;
Let's Encrypt certificates for `gsrwms.uz` AND `www.gsrwms.uz`; two Telegram
manager accounts came across **still `active` with their sessions intact**,
which is the `.env`/`TG_SESSION_KEY` copy having been done right (the third,
`+998900071900`, was `signed_out` by the manager himself on 08-08, before the
move). **The old server is kept with `app` stopped as the rollback** — do not
let it be deleted for a week, and note its dump is the only off-box copy until
the S3 backup is switched on.

NOT confirmed in chat before the session ended, and worth asking him: the
`tg-listen` log after the move, the MinIO object count old-vs-new, and whether
a call recording and a receipt photo actually PLAY/OPEN in the browser. The
database rows are there; rows do not prove bytes.

**HIS SERVER IS AT 84** (he confirmed «84 chiqdi» on 2026-08-19 after PR
#47 — round 107). **Round 108's PR #48 is MERGED and NOT YET DEPLOYED: his
next deploy must land migration 0084 and the ledger must read 85.** Round
109 mints none, so 85 covers both.
Before that: **83 — everything through rounds 103-106
(PR #45, merged and deployed 2026-08-18 evening, he confirmed «83 chiqdi»;
migrations 0081 `backup_objects` + 0082 `notify_claim`). The tg-listen
container was rebuilt in the same deploy. Trap (1) was hit a FOURTH time on
the way: his `git pull` answered «up to date» and the count stayed 81,
because the PR was still open — verified `merged: false` via the API, merged
it for him, and the next pull carried the 85 files.** Before that: both
sessions' round 100 and the AI round landed 2026-08-13 evening at **81**.
The trail there: PR #36 (tahlil + lost reasons + filters, migration 0078)
merged and deployed the same morning, confirmed **79** by counting
`drizzle.__drizzle_migrations`. Getting there hit trap (1) twice more in one
morning: he merged #37 believing it carried the tahlil round, deployed, and
looked for the lost-reasons panel that lives only on PR #36; then pulled and
re-deployed AGAIN with #36 still unmerged (a fully-cached `docker build` is
the tell — no new code arrived) — and the third confusion was pressing into
the already-merged #35's page, where the purple «Merged» badge reads like a
button that was pressed. An unmerged PR's screens do not exist on
production, however green its CI is; the walk that works is Pull requests →
the OPEN one → Merge → then pull. The same evening `main` took the other
session's round 100 (PR #40, migration 0079) and the AI round (PR #41,
0080), he deployed again and the count landed at **81** — the first deploy
of this whole week with no trap hit.

**Three deploy traps, all hit in two days, all the same mistake one step
apart — the count is the only thing that catches any of them.**
(1) Rounds 96-97: he pulled while the branch was UNMERGED, and `git pull` on
production takes `main`. **Telling him to deploy is telling him to merge
first.** (2) The command is `docker compose build migrate app`, never
`build app`: `migrate` is a SEPARATE image (`target: build`), so rebuilding
only the app leaves the migration runner on yesterday's code. (3) Round 98:
he pulled BEFORE the merge landed — same trap as (1), one step later — and got
76 back. Re-pulling and re-running fixed it. The `migrate` service is
`restart: 'no'`, so a failure there leaves the app up on the old schema with
NOTHING on screen; the fix is to read that container's own output, not to
trust «tugadi». Always end a deploy by counting the ledger.
The same week, in chat, **Meta Lead Ads went live in production**: correct page
subscribed, app published, permanent token (`expires_at: 0`) in the server
`.env`, a test lead landed in the funnel end-to-end — the road and its traps
are `docs/ADS.md` §3 and DECISIONS #659.

**Deploy note, still true for the next one:** migrations must reach the journal
length (**85** on `main` since round 108; his server was at 84 on
2026-08-19) —
the client book, the stock table and `/o/<code>` read
`list_views` at RENDER with no catch, so a half-applied deploy shows those
three the error page (round 52's failure, wider). Check
`drizzle.__drizzle_migrations`; fix with `docker compose run --rm migrate`.
**A restored dump carries the OLD server's schema and ledger**, so the
migration step after a restore is not optional and its count will NOT match
the source server.

Phases **0/1/2/3/4/5/6/7/8** shipped (roles, custom fields, tasks+calendar, deals),
plus the access/clutter pass (`MENU_BY_ROLE` #194, `rbac/scope.ts` #199,
per-page guards #198, card scoping #200, `canActOnTask` #201). A 14-subsystem
audit on 2026-07-26 confirmed 30 defects; its findings are the work queue.

Round 9 (this round) — all on the branch, **deployed up to the print sheet**:
- **Scanner, twice.** A refused scan no longer counts as loaded (#221-223) —
  and then the refusal ITSELF was wrong: `onPlan` demanded `status='planned'`,
  so a crate carrying one already-`loading` box came back "not on plan" and the
  red confirm killed the scanner under it (#244-247). Loading stopped in the
  warehouse. **Both halves were my own changes.**
- **Printing.** Share sheet for AirPrint/RawBT (#224-226), then the phone's own
  print dialog on an HTML sheet (#232-243) — the geometry is now stated once
  (`labels/geometry.ts`) and drawn twice, which also fixed `#UNKNOWN` printing
  across the client code on unclaimed cargo (#241).
- **The build banner** (#229-231): the app tells a phone it is showing
  yesterday's screen. Three rounds were lost to "deployed or cached?".
- **Scan-path speed** (#248-250): the snapshot was re-downloaded after EVERY
  scan (~300 KB on a quick batch); now on the 15 s tick only. Two indexes,
  migration 0032 — measured on his data: 40 ms → 1.2 ms, and a 9.6 s cold case
  gone. A 350 ms flush debounce was tried and REJECTED by the e2e (#249).
- **Money** (#251): a deferral that had been PAID went on excusing an unrelated
  debt, opening the handover gate with no override and nothing in the audit log.
- **pg-boss latch** (#252): `bossStarted` was set before the nine worker
  registrations, so one throwing killed the rest — including the nightly backup
  — and the retry then RESOLVED, so the error stopped being logged.
- **Off-site backup to Google Drive** (#253-261): OAuth + `drive.file`, size
  verified against Google's own answer, prune only after a good upload.
  **Built, not switched on — needs his 15-minute setup (`docs/BACKUP.md`).**
  Found on the way: two backup systems that could not see each other, the app's
  dumps landing in a container thrown away on every deploy, `ops/backup.sh`
  missing `--no-owner`, and `JOB_SEND_TELEGRAM` with no schedule of its own.

Round 10 — **the client-facing side**, his six asks, on the branch and NOT yet
deployed:
- **"Yuk keldi" the moment it reaches CHINA** (#262-263), three languages
  (#264-266), the client book first on the home screen (#270). The client's
  language is a NULLABLE `clients.locale` — additive, because production holds
  the whole client base and he said not to touch it (#266). Found on the way:
  one message per LINK ROW instead of per chat (#267), the Telegram response
  never read so a client who had BLOCKED the bot looked reachable (#268), and
  two staff RUSSIAN strings on a path only customers reach (#269).
- **The Mini App** (#271-277) — `/cabinet`, opened from the chat menu button.
  Cubes, kilos, count, photos, balance, history; three tabs over ONE fetch.
  The whole of its security is `verifyInitData` (#271-272), the identity is the
  CHAT and never a client id from the request (#273), photographs are fetched
  with the signed header rather than by URL (#274). The menu button is set per
  chat, in the client's language, never as the bot's default (#275).
  **Deliberately absent: where the truck is** — his instruction, until every
  client can see their own cargo on a real map.
- The build step earned its place again: a locale constant dragged
  `next/headers` into the client bundle; typecheck and dev were both happy
  (#276).
- **The cabinet e2e passed here and failed in CI** (#278): its fake
  `window.Telegram` was installed with `addInitScript` and then overwritten by
  the real `telegram-web-app.js` — which this container cannot reach and the
  runner can. The spec now SERVES the script (`route.fulfill`) instead of
  racing it.
- **The big button and the design pass** (#279-281, owner: "buttonga urg'u ber
  … glavniy katta button" + "UI UX designni maksimal darajada yaxshila"): a
  full-width INLINE `web_app` button on the arrival message, under the cargo
  list and at linking, with the corner button kept for the client who returns
  with no message to scroll back to. The screen is drawn as part of Telegram —
  its theme, its back button, its haptics — with a to-scale stage bar, a
  per-stage palette that is the one thing NOT taken from the theme, a photo
  lightbox, and skeletons instead of the word "loading".

- **The driver fleet went silent on the domain move** (#282-284): the APK
  carried the old `sslip.io` host as a COMPILE-TIME constant, so every paired
  phone lost the server at once, with nothing on the driver's screen to say so.
  Fixed forward (APK 1.2 → `gsrwms.uz`) and the recovery that needs no phones
  touched is keeping the old name served — README states all three steps a
  domain move needs. The APK is now handed out at **public `/driver`** with a
  QR, published from **Admin → Haydovchi ilovasi**; storage is the record, and
  the upload is validated by content (ZIP magic), not by filename.

- **Cancelling a batch / plan** (#285-288, owner's test batches left in
  production): `cancelled` was in the schema since M3 and understood by the
  board, the map and every report — it simply had no action that could reach
  it. Soft, never a hard delete: **10,588 `box_movements` rows** point at a
  batch through `ref_type`/`ref_id` with NO foreign key, so a delete would
  orphan them in silence. Refused once departed, or with a live cost or charge,
  or with a box that has moved on; boxes go back to stock with a movement row,
  the plan goes with the batch, the driver's phone is revoked. An adversarial
  pass over it before shipping found three more (#289-290): a revoked phone was
  answered 401 and so retried for ever (410 is the only answer that stops it —
  latent since the driver app shipped), open tasks on the batch stayed open,
  and `batchRegister` had no status filter at all.

- **Client conversations into the CRM, phase 1** (#292-294, owner: "95 foiz
  telegramda gaplashamiz"). He chose the user-account route with the risks
  stated. History import only: `pnpm tg-import` logs in with a code the manager
  types, reads, exits — **no session is stored anywhere** and there is no code
  path that sends. Only chats matching the client book are kept, enforced by
  `tg_messages.client_id NOT NULL`. Everything it decides is pure and unit
  tested; the gramjs glue is a thin shell. Test accounts: Bekzod, Siroj.
  **Phase 2 shipped** (#296-298): `/suhbatlar` — one row per client, last
  message, and a "waiting on us" mark when the client spoke last; the thread
  reads forwards, the card panel stays newest-first. Gated on `crm.leads` /
  `clients.manage` with its own per-page check. Ran on his own account: 394
  dialogs, 13 clients, 5,191 messages — the 122 "no phone" were his PERSONAL
  chats, correctly left out, so the filter did its job. Phases 3-4 (live
  receive, reply) not started; Siroj deliberately not connected yet. The panel
  is also on the DEAL and LEAD cards (#299-301) and gates ITSELF — a deal card
  is open to `ved.docs`, so an ungated panel there would have handed the customs
  manager every sales conversation.

Round 11 — the per-role home pass, started where the owner said ("skladchi
ekranidan boshla"): any warehouse-scoped actor now gets a workflow home —
receive as the hero, then arrivals / loading / handover rows with live scoped
counts (`wms/home/flow.ts`, #346); everyone else keeps the tiles. Next role
to be agreed with the owner.

Round 12 — the owner's 15-point feedback list (his message with four
screenshots; all decisions answered). Batch 1 SHIPPED (#347-352): density
recoloured to his scale (150/250/450, migration 0040 — the light band wore
the brand red), `/admin` hub of buttons, collapsible sidebar, ••• sheet
closes on route change, scanner asks 1080p + torch (iPhone Safari was
decoding a 640×480 stream — the German server was innocent), cost-types
CRUD, funnel cross-doors + «Bitim ochish» on won leads. Batches queued as
tasks #78 (item 9: arrivals kub/kg + prefill + deterministic auto-close +
diff notify to the arrival's author) and #79 (the big redesign: amoCRM-style
card with sticky right info panel + full-height kanban (3), global right
dock for tasks+card chat (5+7), in-map popups with unified markers (12),
cabinet linking via Telegram request_contact (13), chat with photos +
Enter-send composer (15)).

Batch 2 SHIPPED (#353): promises carry kg/m³ (migration 0041), «Qabul
qilish» on a promise opens /receive prefilled and the confirm closes exactly
that promise; a difference (any box delta, >5 % kg/m³) tells the promise's
author in Telegram, never the receiver.

Batch 3 part 1 SHIPPED (#354): `CardCols` gives deal/lead/client cards the
amoCRM shape — lenta wide+tall on the left, sticky self-scrolling 24rem
facts rail on the right, phone keeps facts-first stacking from the same
DOM; the kanban desktop board owns the viewport with full-height sunken
columns that scroll internally (no page scrollbar).

Batch 3 part 2 SHIPPED (#355-356): the DOCK — an app-bar 💬 on every page
opening a right drawer (bottom sheet on phones) with the conversations
list+thread (reply in place, Enter-send) and the /bugun tasks (one-tap
finish); cards declare their client via a hidden `data-dock-client` marker
so the drawer opens straight into that thread; portal to body because the
header's backdrop-filter traps fixed descendants. Notes take FILES
(pre-bound to a client-minted crm_activity id, rendered on the lenta);
the lead card's contact log folded into a rail Panel; cards now state the
honest Telegram status (not-linked vs somebody-else's, named).

Batch 3 COMPLETE (#357-359): in-map popups shared by both renderers +
unified Leaflet badge (12); cabinet self-links via request_contact — the
Telegram-verified own-number, created_by nullable (migration 0042), staff
link flow kept as fallback (13); incoming chat PHOTOS downloaded by the
listener (photos-only, 10 MiB pre-checked cap, inline sharp thumbnails —
enqueue() would start the worker fleet in the listener container) and
rendered in thread/lenta/dock (15). Deferred by design: tg-import media
backfill, sending photos (outbox is body-only by CHECK). The activity form
also moved into a folded rail Panel and notes take files (owner's mid-round
asks).

Round 13 — the audit-defect round (#360-369), owner's order «2 ha tekshir»
(photos-to-Drive is ON HOLD by his «1 tohtab tur»). All ten remaining audit
defects fixed, each with a test SHOWN to fail without its fix: voided costs
out of P&L/cash-flow/profit (deltas, plus the crash-orphaned-allocation case),
payments name their cash box (form only — `account_id` existed since 0020,
historical NULLs stay "not yet placed"), handover act paginates (50-box act =
2 pages, rows verified ON page 2), customs docs read `batchMemberFilter` not
the live pointer, receipt void refused once any box left the shelf (FOR
UPDATE + `VoidError`), checkbox field parses the real `['off','on']` wire
shape, `/pipeline` gated on `reports.own_clients`, `/api/health` really
probes db+storage+jobs (`ping()` NOT via the ensureBucket latch; the probe
never calls `startBoss`), Postgres tuned via compose `command:` flags (unit
tripwire pins the block incl. the `postgres` first token; applies on
container RECREATE — off-hours, backup first, halve values on a 2 GB box),
and attachment reads get `decideAttachmentRead` in LOG-ONLY mode
(`wms/attachments/access.ts`, `[attachment-authz]` lines in docker logs;
the flip to 404 is a separate owner-approved change AFTER reading the logs).
No migration in this round. NOT yet demonstrated: a route-level spy test on
the warn line itself — the predicate is unit-tested and the serve-path is
exercised by the whole e2e suite.

Round 14 — the owner's item 3 (#370-372, «davom et va iloji bolsa mobile
friendly crm qilib ber kanban viewparni»). The phone board is a snap-swipe
carousel: full-width sunken columns (cards scroll inside, page does not),
sticky chip strip under the h-14 app bar, scroll position owns the active
chip (600 ms guard while a chip tap's smooth scroll is in flight); move
buttons stay — touch drag refused again. One file (`components/kanban.tsx`),
both boards inherit; the m8 e2e now asks the COLUMNS whether a card moved
(all stages are in the DOM). Composers unified in `components/composer.ts`:
fine pointer Enter=send / Shift+Enter=newline, coarse pointer newline-only
(button sends) via `(pointer: coarse)` + `useSyncExternalStore`; all three
autogrow, resize-none; note box deliberately keeps no-Enter-send. E2E RULE:
mobile project emulates touch — specs must press the send button, never
type Enter. `viewportFit: 'cover'` + `pb-safe` on the four focus-mode
action bars. PHOTO SEND (item 15's second half, migration 0043): composer
📎 pre-binds ONE photo (≤10 MiB, the incoming cap) to a minted `tg_outbox`
group id; `queueReply` verifies own-upload/kind/size and caption ≤1024
(refused, never truncated); the listener `sendFile`s, writes the echo row
ITSELF and claims the photo onto it (`recordSentPhoto`; Telegram's echo =
no-op replay; `wasSentWithPhoto` stops re-downloading own bytes); missing
bytes → permanent 'photo_missing'; `deleteAttachment` maps the new FK to
'in_use'; cancel keeps the photo row. The `tg_outbox` authz branch shipped
in the same commit as the allowlist entry. No albums by design. NOT tested
live against Telegram (no network here): the send path's gramjs call is
covered by rules-tests + the queue/claim/echo integration suite, and the
first real photo send should be watched in docker logs.

Round 15 — the owner's item 4 (#373-374, «buni ham qil»). All four working
roles now wake to a workflow home: ONE resolver (`wms/home/role-flows.ts`
`buildHomeFlow`, narrowest job wins, warehouse scope beats all, admin/
super_admin deliberately keep tiles — m9o's tripwire). Sales = calls hero
(followUps) + funnel/waiting-chats/debtors/open-deals; logist = verdict
queue hero + warehouseFlowCounts reused UNSCOPED + /transit + cost-missing;
accountant = /accounting hero + receivables (warn >60d) + THIS-month
unplaced payments (month-bounded on purpose) + recurring-due (mirrors
generateRecurring's idempotence predicate; a VOIDED posting counts as due
again — tested) + cost-missing via /dashboard (his /batches gate bounces).
Suppressed-tile list rides on the flow (`flow.hrefs`). New testids
`{logist,sales,acc}-flow-*`; e2e m9s (3 tests, m9o's discipline: digits +
testids, arrival-promise count moved and moved back). Batch card adopted
CardCols: header block (h1 FIRST — m9m reads `h1.first()`; STATUS_CLASS
literal colour map; pair code; stage actions) stays ABOVE the grid (rail
renders first on phones), main = contents/loaded-boxes/costs, rail =
VED/vehicle/driver/tracking/pricing/tasks/fields. Zero testid changes —
every m3/m4/m5/m9/m9m batch-card assertion passed untouched. New i18n keys
×4: home.flowPlansPending/flowUnassignedPayments/flowRecurringDue.

Round 16 — stage 5 begins (#375-376): **phase 4 mentions** — notes stay
plain text; `MentionTextarea` dropdown inserts the CANONICAL full name and
the server re-finds names (`crm/mentions.ts`, longest-name-first spans,
word boundaries, duplicate names → both); the named person gets
`MentionedInNote` INSTEAD of the thread copy (one message); contact-log
path pings only mentions; hand-typed partials match nobody; self-mentions
dropped; delivery is Telegram-only — stated to the owner, no in-app bell.
**Phase 6 approvals** — `issue_approvals` (migration 0044, additive):
who asked / who decided / why / until when + the debt SNAPSHOT as a
CEILING; the gate demands approved AND unexpired AND amount-covered in one
`FOR UPDATE SKIP LOCKED` select, consumes AFTER the handover insert (FK,
same tx — the one-step draft was refused by the FK itself, caught by the
new test); one live request per (client, warehouse); single-shot decision;
TTL setting `debt_approval_ttl_hours` (24) read at decision time;
deciders = `usersWithPermission('finance.debt_override')` from the
editable grants; debtOk checkbox STAYS for holders; `/approvals` screen +
issue-screen banner (ask button / pending / granted-until). Both new event
types in MUTE_GROUPS.alerts, MentionedInNote beside InternalNote — the
mutes tripwire reads `buildRecipients` itself. e2e m9t (mentions dropdown
in the browser); the approvals browser half deliberately has no e2e —
integration-proven through the same functions the buttons call.

Round 17 — the deal open items (#377-378), owner OK'd AI for the customs
side («rastamojkani hisoblash guruxlash uchun AI ishlatsang boladi»).
**Discount form** finally writes the 0030-era columns: mandatory reason,
audited, 0 clears (audited), controlled inputs (React resets a form when
its action returns — the refused save must not eat the amount), gate =
deal-write list (re-pricing's power, not finance.manage), charge prefill
subtracts it, ledger untouched (void+re-post is finance's corrected path).
**dealProfit** (per deal, never per line): non-void deal charges − the
boxes' cost_allocations shares (costEntries.voidedAt belt-and-braces per
#360, proven red without it); batch-priced money on the deal's trucks is a
LABELLED separate line, never pro-rated; panel gated `finance.reports`;
migration 0045 = client_transactions.deal_id partial index. **50-goods
import**: pure header-detection (`deals/goods-import.ts`, ru/uz/zh/en
keys, volume claimed before weight, line TOTAL beats unit price, «Итого»
dropped, headerless → first-text-cell rows); route handler (#291), 5 MB /
500 rows, content-validated; memory-first codes, then
`proposeGoodsGrouping` (claude-opus-5, structured output) proposes groups
with confidence + ESTIMATED duty % (advisory, never persisted); one bad
code is blanked+demoted, not fatal; no key/refusal → manual mode (what CI
e2e m9u proves — no key there); nothing writes until the VED manager
confirms into the existing replace-all saveLines; LinesForm keyed by
content so the server-side replace shows. First live grouping should be
watched in docker logs (needs server ANTHROPIC_API_KEY).

Round 18 — phase 7 automation rules (#379-380). No elaborated spec existed
(the two words in the plan were the whole agreement) — v1 designed and
STATED to the owner as reversible: rule = trigger (lead/deal ENTERS stage,
or 1 of 10 curated events — audit-only types not offered) → action
(create_task with assignee STRATEGY owner/actor/fixed + dueDays +
priority, entity-linked; or notify userIds with card link).
`LeadStageChanged`/`DealStageChanged` emitted from EVERY stage write path
(move/edit/convert — the edit forms were silent second paths); engine runs
in processPendingEvents per event, per-rule try/catch, structurally cannot
cascade (actions emit no events); task author = rule author; AutomationRule
respects mutes (operations group); gate `admin.settings.manage` (no new
permission — #170 seed-skip); stage ids un-FK'd; fire_count on the list.
Migration 0046. /admin/rules + hub tile. crm+bitimlar action run() helpers
now kick JOB_PROCESS_EVENTS. Deferred, stated: time triggers, conditions,
{placeholders}. Found on the way (#380): processPendingEvents drained only
50 events/minute (now bounded batch-drain 40×50); attachment-access had
left a QUEUED tg_outbox row since round 13 that outbox's claimNext would
claim — latent because vitest orders files by DURATION CACHE, so adding
any file can reshuffle; cleaned at source. VITEST RULE: leftover state in
integration files is worse than in Playwright — the order is not even
lexical. e2e m9v deletes its rule (a rule is CONFIGURATION, #183).

Round 19 — phase 8 custom entities (#381-382), the LAST «mukammal» item.
An object invented on /admin/entities (label + who-may-edit as FOUR choices,
`WRITE_CHOICES` — «everyone» = empty list = any signed-in staff) is a
`custom_entities` row (`is_custom`, `label`, `write_permissions`; migration
0047 also adds `custom_records`: name/note/active, FK entity_code, soft
deactivate only). `entities/service.ts` `resolveEntity` is THE single door
(registry first, then active custom rows) and every registry consumer now
asks it: saveField, field actions, fields/tasks panels, createTask,
aboutLabels (names records via `recordNames`), automation linkableEntity,
attachment authz. Codes MINTED `x_`+time36+noise (FK/URL for life; prefix
reserves the namespace); audit ids = uuidv5(code) under a fixed NS because
audit_log.entity_id is uuid. Generic UI at `/o` (index tiles, list with the
phase-2 field columns/filters reused from admin/clients, card = name/note +
CustomFieldsPanel + TasksPanel + HistoryTab); nav `/o` added to ALL curated
menus (the warehouse fence in nav-relevance.test went 8→9/11→12 and SAYS
so); /admin hub tile; gate `admin.dictionaries.manage` (no new permission,
#170). THE near-miss: `syncEntityRegistry` deactivates codes not in
ENTITY_SPECS — exactly what an owner row is; the WHERE now demands
`is_custom = false`, proven by stripping the guard and watching the seed
kill the row (#166). Tasks route x_ codes to `/o/<code>/<id>`. e2e m9w
deactivates its type at the end (a type is CONFIGURATION, #183). Cut from
v1, stated: lookup fields AT custom entities, Telegram deep links to
records, per-record chat.

Round 20 — the owner's leak report (#383-384, «nega superadmindan ulangan
telegram account chatlari hamma accountga korinyabti»). The schema and the
WRITE path were per-account from birth (`manager_user_id NOT NULL`,
replyAccountFor = own account only); every READ ignored the column. Now a
Telegram conversation is PRIVATE to the manager whose account holds it —
`listConversations(viewerId,…)`, `conversationFor(clientId, viewerId,…)`,
`conversationCount(viewerId)`, `pendingFor(clientId, viewerId)`, the
lenta's two tg branches (`clientFeed(clientId, viewerId, opts)` — viewer
REQUIRED, not an option, so no caller can forget), both dock routes, the
sales home waiting-chats count, and the card thread panel. Shared lenta
sources (cargo/money/notes) stay company-wide; `conversationManagers`
names deliberately stay (who talks ≠ what was said). NOBODY exempt incl.
super_admin — a supervision view is a stated, reversible widening away.
Attachment authz: `enforce` flag on `AttachmentAccessDecision`; ONLY the
tg_message/tg_outbox branches set it (permission AND own-account; outbox
also queuedBy) and the route 404s on it — everything else stays log-only
per #369. Three leak tests (crm list/thread, feed, photo authz) each
SHOWN red with its guard stripped (#166, string-edit never git checkout).
No migration. E2E note: m9n/m9r tolerate scoping because integration
leftovers carry manager = first seeded user (the owner) and m9n already
asserts the empty state when rows vanish.

Round 21 — the owner's three follow-ups the same day (#385-387). (1)
SUPERVISION: `tgViewerFor(actor)` → `{id, all}`, `all` = super_admin ROLE
(not a permission — #170); every tg read takes the viewer (list names each
row's managers via array_agg; thread/dock/pendingFor/photo-authz widen the
same way; `seesAllTgChats` in access.ts); replying stays own-account only.
Red-proof: `all` branch stripped → supervision asserts red. (2) SPLIT:
clientFeed dropped its two tg branches AND the viewer param (lenta =
shared record again: notes/cargo/money); `TelegramThread` (was dead code)
resurrected on client/deal/lead cards under the lenta, rewired onto
conversationFor(viewer); TelegramReply moved out of the lenta into the
chat panel; feed tests pin the ABSENCE (client with a tg row whose lenta
must not show it). (3) CONNECT: `crm/telegram-connect.ts` — in-memory
pending gramjs login per user (TTL 10 min, config checked BEFORE a code
is wasted, always actor's own account), `/suhbatlar/ulash` (phone → code
→ 2FA password; controlled inputs), `pnpm tg-listen` with no arg is now a
SUPERVISOR: scans tg_accounts every 60 s, starts listeners for accounts
it isn't holding, skips signed_out, 5-min backoff on failed starts;
compose command dropped `--tg $TG_LISTEN_PHONE`. e2e m9x proves the
honest not_configured refusal (CI has no TELEGRAM_API_ID). NOT live-tested
against Telegram (no network here): watch the first real connect in
docker logs.

Round 22 — the queued Telegram leftovers (#388). Migration 0048
(manager-led index for the round-20 scoped reads). PURGE of an excluded
chat's stored rows+photos: `purgeExcludedChat` (exclude-only, audited
counts, storage best-effort after db rows; tg_outbox deliberately kept),
«chat-purge» button with confirm on /suhbatlar/qaysi excluded rows via
`excludedLeftovers` counts. TEST LESSON: the refusal test first looked up
an included rule and skipped itself when none existed — a conditional
test proves nothing; mint the fixture unconditionally. EDITS: listener
EditedMessage → `applyEdit` (UPDATE-only = the privacy proof: an edit in
an unkept chat cannot create a row). `tg-import --media [n]`: photos for
kept history via pure `mediaBackfillPlan` (media, no attachment, newest
first, cap default 50/chat — capped BECAUSE photos-to-Drive is still on
hold and MinIO has no off-site copy). Deferred: purge has no e2e (the
predicate+action are integration-proven; a browser press needs seeded tg
config, #183).

Round 23 — warehouse scoping as a roles COLUMN (#389), the deferred
access item that was never blocked on the seller logins. Migration 0049;
`getActor` reads the column via exported `loadUserRoles`; seed stamps the
flag ONLY on INSERT of shipped roles (screen owns it after birth — the
grants_customised lesson); /admin/roles checkbox through `setRoleScoped`
with the own-role guardrail (unticking your own role's scope =
self-widening); WAREHOUSE_SCOPED_ROLES stays as the seed bootstrap +
tripwire anchor. Red-proof: column read stripped → invented-role test red.

Round 24 — home feedback (#390): «1 qatorda 1 button o'xshamabti».
FlowHero deleted; every hero (warehouse receive, logist plans, sales
today, accountant money, tile-home first action) is now an ordinary
FlowRow/Tile with the SAME testid (m9o/m9s untouched). The /bugun task
strip deliberately stays (alert, not a door). Icon pass = kill in-screen
duplicates: arrivals→clock, approvals→check, my-clients→user, /o→menu,
pipeline→report; flow rows transit→map, debtors/receivables/costs→wallet,
recurring→calendar. No migration.

Round 25 — the owner's 6-item list, items 1-4 (#391): exclude-from-chat
now purges too (excludeAndPurgeChat; confirm states it); `AutoRefresh`
(router.refresh, 10 s, visible-tab only) on the thread screen kills the
stale «navbatda» bubble and shows incoming live; `codesSharingPhones` in
the thread header (all active codes on shared phones, own first);
`chatBadges(viewer)` puts 💬/💬! on lead+deal kanban cards, viewer-scoped
per #383. Item 5 (PWA web-push) was then PARKED by the owner («hozircha
telegram ham tursin» — Telegram stays, per-user mutes already exist);
item 6 became round 26.

Round 26 — the owner's item 6 (#392-394, «6 ha zor bo'lardi»): a deal
follows its linked cargo through the funnel. `deal_stages.cargo_trigger`
(migration 0050, nullable/additive; seeded stages carry none) names one of
FIVE states = the five warehouse events: received/departed/arrived/ready/
handed. Engine: `deals/auto-stage.ts` resolves event→deals (receiptId
directly; batch+handover through `box_movements` per #152; ReadyForPickup
client-filtered) and `applyCargoTrigger` (in service.ts) moves FORWARD only
(sortOrder), open deals only, never into lost (a lost needs a person's
written reason), always THROUGH `moveDeal` — audit + DealStageChanged +
phase-7 rules hear it. `linkReceipt` of a confirmed receipt counts as
'received' (linking is where the owner starts). Platform hook: dynamic
`await import` in `processEventBatch` beside `runAutomationRules`, own
try/catch (the boss.ts crossing pattern). **BatchUnloaded was declared
since M4 + offered as a rule trigger since round 18 and emitted NOWHERE**
— `finishUnload` now emits it; owner told any existing rule on it goes
live. First deal-stage EDITOR: `/bitimlar/etaplar` (⚙ on the board), gate
`crm.manage` (#170), mirrors the lead editor incl. in-tx needs_open/
needs_won; refuses trigger-on-lost. e2e: none that creates stages (#183 —
integration-proven through the same functions). Red-proofs ×3 (#166):
forward-only strip, kind-guard strip, hook stub (5 event tests red, link
test green). Test file drains pending events BEFORE minting trigger
stages — its stages are CONFIGURATION while they exist.

Round 27 — the owner's split-shipment rule (#395), his design verbatim:
first part drives the early stages, and before «topshirildi» the deal
parks at a **«qisman topshirildi»** stage until everything is handed.
`handed` REDEFINED = every box of the deal's cargo issued (safe: round 26
never deployed, no trigger configured anywhere); new trigger value
`handed_partial` (migration 0051 widens the CHECK) is only ever a TARGET
— on BoxIssued, `dealFullyIssued(dealId)` (lost/void out of the
denominator, ≥1 real issue required — the deferral's lesson) splits deals
between the two targets. Single-shipment deals skip the partial stop;
no partial stage configured = deal waits at its column. Red-proof: split
stripped → partial test red. i18n: triggerHandedPartial ×4, triggerHanded
re-worded «to'liq».

Round 28 — the owner's hisoblash SLA (#396-397, his three answers: measure
request→SAVED, sotuvchi picks the VED person, deadline by item count).
(A) Hour-level tasks NEEDED NO MIGRATION — due_at was timestamptz + all_day
since phase 3; the form gained an optional time input + hidden
`getTimezoneOffset` field, `parseDue(raw, tzOffsetMin)` converts the
typist's WALL CLOCK to the instant (Tashkent −300 → 14:00 = 09:00Z; the
UTC server alone would store timed deadlines 5 h late); timed tasks render
on the reader's clock and go red at their minute; Telegram prints
Asia/Tashkent; all-day convention untouched; dock route sends formatDue.
(B) `calc_requests` (migration 0052; one open per card via partial unique
index): `requestCalc` (assignee must hold ved.docs from editable grants,
refuses duplicates) opens a priority-1 TIMED task via createTask
(`calcDueMinutes` = min(30×items, 120)); the clock stops when the WORK
lands — `saveLines` → completeCalcForDeal (dyn import, fenced) closes
request+task; leads close via completeTask → completeCalcForTask (platform
→wms dyn import); 5-min sweep `registerCalcWorker` flags lateness ONCE
(`overdue_notified_at`) to requester+super_admins, never the assignee;
'CalcOverdue' in MUTE_GROUPS.alerts. UI: CalcPanel on deal+lead cards
(banner when open, red when late), `/reports/hisoblash` (gate
reports.all_warehouses, per-VED done/avg/max/on-time/open + live queue).
ROUTES gained `deal:` (task about-links). e2e note: task form kept
testid task-due as type=date; new task-due-time beside it. Red-proof:
saveLines hook stripped → clock-stop test red. m3 e2e flaked once on the
first full run, green alone and on the full re-run.

Round 29 — the accountant's pains (#398-399, owner's answers: rastamojka
per PRIXOD in Excel columns, batch-money screen = the 4 things, no cash
shifts). NO migration. (1) **Receipt-cost GRID** on the batch card
(`receipt-cost-grid.tsx`, main column under costs): rows = the batch's
receipts (`batchReceiptRows` via batchMemberFilter #152), columns = the
owner's active cost types; one save → `addReceiptCostsBulk` → ordinary
scope-receipt `addCostEntry` per cell (audited/FX/allocated — engine can't
tell grid from form); membership RE-PROVED server-side (red-proof:
strip → foreign-receipt test red); already-entered sums under cells via
`receiptCostMatrix`. LESSON: grid's currency select briefly shared
`aria-label="currency"` with CostPanel — m9's strict locator refused; an
aria-label is an API (now "grid currency"). (2) **Pricing page = partiya
moliyasi**: + per-client OVERALL balance (labelled honestly — payments are
account money, not truck money) + ledger links; pricingTitle re-worded ×4.
(3) **Payments register** `/finance/reestr` (`paymentsRegister`, period
filter, kassa column, `buildPaymentsXlsx` via /api/accounting/payments —
gate finance.view NOT finance.reports: who paid ≠ margin), acc-flow row
`acc-flow-payments`, /finance header link; writing stays on the client
ledger (search → card). METHOD told to owner: internal legs' freight goes
on the ORIGIN batch (YW 30$/kub on YW-001), never blended onto the export
batch; shared customs costs on the export batch basis 'weight'.
Same-day follow-ups (#400): per-client «prevLegs» split (totalUsd −
batchUsd) + `batchClientCostBreakdown` details element (press, not hover)
on the batch-money screen; grid columns seeded by fixed code
(customs/zatamojka/cct/freight — screen owns after birth); grid restyled
Excel-wise (borders, zebra, per-column totals ×2). THE FIND: the seeded
«Растаможка / Rastamojka» name overflowed the 360px viewport on
/admin/cost-types → mobile Chrome ZOOMED THE WHOLE PAGE OUT → every click
coordinate shifted → m9p 60s-intercept loop; diagnosed by
elementsFromPoint probe (innerWidth 373 ≠ viewport 360), fixed with
flex-wrap on the card header + add-button moved above the list. LESSON:
any row wider than the mobile viewport rescales the entire screen —
Playwright coordinate mismatch = suspect page zoom first. Also: a stale
`pgboss.version.maintained_on` (>10 min, no server running) makes
/api/health 503 and Playwright's webServer time out — local-only state;
fresh db or `UPDATE pgboss.version SET maintained_on = now()` clears it.

Round 30 — the owner's «3 dagi ishlarni boshlaymiz» (#401). (a) VED home
flow: `vedFlowCounts` (own open calc requests + late count; departed
batches with `sent_to_agent_at IS NULL`; TNVED-less lines on open deals);
`kind: 'ved'` in buildHomeFlow AFTER sales (both-hats person lives the
funnel); testids ved-flow-{hero,docs,tnved}; m9s 4th test (user 0004);
i18n home.flowDocsPending/flowTnvedMissing ×4. (b) Attachment ENFORCE
flip: `decideAttachmentRead` wrapper stamps enforce on every coded deny;
`unmapped` deliberately stays log-only (legacy free-form types = old real
files; warn line is their inventory); red-proof: stamp stripped → 3
refusal tests red. (c) Deal-stage editor completed: `reorderDealStages` +
`deleteDealStage` (move-first, in-tx open/won law), DealStageTools on
/bitimlar/etaplar, testid delete-deal-stage; editor test restores order
(#154 — the funnel's order is CONFIGURATION). Yashik parking LIFTED by
the owner («unda shu yashikni ham tuzat») — adversarial crate audit
launched (load/lifecycle/money lenses), findings fixed in round 31.

Round 31 — the yashik audit round (#402-406). 20 candidates → 11 CONFIRMED
by per-finding adversarial verify; ALL fixed, each red-proven by string-
strip (#166). MONEY: createCrate now recomputes the crating entry after
commit (was amount_usd NULL + zero allocations for ever — unanimous find);
crate scope reads `crate_packed` movements, NOT live crate_id (dissolve/
issue erased allocations on the next sweep); crate costs correctable
(costEntrySchema scope 'crate', CostPanel on crate card, gate
costs.enter_receipt at crate wh, void branch + revalidate in costs
actions). SCAN: stray-crate re-scan crashed on `values([])` (empty toLoad
→ 500 → outbox jammed FOR EVER, #221's failure mode reintroduced) — now
'duplicate' with strays still named; scan_events written only for boxes
the scan MOVED; addedOnSpot is per-BOX (`isSpot`) — flags/cause/event/
alert only for real strays; same empty-values crash found by the new test
in dissolveCrate (memberless crate — receipt-void emptied it). RULE: any
values(list.map(…)) behind a filter needs the empty guard. UNLOAD: crate
fan-out accepts ONLY members that rode THIS batch (short-loaded member
kept crateId and was TELEPORTED to dest — client told cargo arrived that
sat in Yiwu, immediately issuable); left-behind NAMED in ack.notArrived;
reality-wins stays for single-box scans; crates.warehouseId follows landed
boxes (frozen-at-origin crate was unplannable/undissolvable at dest);
landing retires journey flags (added_on_spot/missing rode onto later
manifests); manifest reads THIS batch's load events (crate column + ⚠
survive reprint after handover); origin inventory lists only present-here
members, drops empty crates. GUARDS: crate on a second open plan refused
at submit (`crate_on_another_plan` + i18n ×4; the old failure killed the
agent's VERDICT with bare insufficient_stock); receipt-void and lot-edit
shrink clear crateId (void ghost jammed the crate for ever); client change
on crated cargo refused (`boxes_crated`, assign form → useActionState +
receipts.assignCrated ×4). 8 new tests (m2×3, m3×3 — the confirm-scan
test loads planned+stray in ONE scan or isSpot doesn't bite, m4×2). No
migration. Verify rejections worth keeping: crate dims label-only and
«1 place» plan-granularity are DESIGN, not defects.

Round 32 — the owner's empty-card report (#407): a person's several GS
codes share one phone, the import pinned each chat to the code the phone
matched, and TelegramThread asked for the CARD's exact client — the deal
on the sibling code showed nothing while /suhbatlar held the chat.
`threadClientFor(clientId, viewer)`: exact client first, else the ONE
phone-sibling holding a thread (activeClientsByPhone), ambiguity refuses
(the lead resolver's rule); panel names the sibling code, links and
REPLIES onto the code that holds the chat; viewer scoping unchanged.
Red-proof: sibling branch stripped → crm sibling test red. NEXT AGREED:
the staff-side Telegram bot round («endi telegram botni mukammal
qilishimiz kerak hodimlar ishlashi uchun») — proposals sent, his picks
awaited.

Round 33 (part 1) — his answers arrived (#408): rank-and-file stays
own-account; SUPERVISION widened to `seesAllTg` = super_admin | admin
role | ved.docs GRANT (editable, #170 — reason: calc files land in
whichever manager's chat). Every tg door asks ONE predicate: `canReadTg`
on thread panel + /suhbatlar pages + dock routes + app-bar 💬;
/suhbatlar in ved menu + nav item permissions += ved.docs; photo authz
seesAllTgChats = alias of seesAllTg. Replying stays own-account.
Red-proof: both new clauses stripped → predicate + photo tests red.
APPROVED for next batches: all 6 staff-bot items (task-complete buttons,
bot lookup, morning plan, approval buttons, unanswered-client reminder,
load/unload summary) + AI calc intake (client sends files/photos/texts →
AI analyzes + completeness verdict → manager confirms → lands in the
lead's hisoblash section). Design sent; batches to build next.

Round 34 — his three answers (#409). (1) SHIPPED: `threadManagers` chips
on card panel + /suhbatlar/[clientId] (`?hodim=` filter);
`conversationFor(clientId, viewer, limit, managerId?)` honors managerId
ONLY under viewer.all (red-proof: unconditional param → sneaky test red);
names stay shared, content stays scoped. (2) AI intake REDESIGNED by him:
staff opens the BOT, «Hisoblatish» mode, forwards files/photos/texts +
client info; result = card on the lead (or deal if coded client) whose
lenta carries AI's TNVED codes/grouping steps. (3) All bot batches YES;
hisoblash has THREE sections: yo'lkira / rastamojka / podklyuch;
rastamojka+podklyuch: AI checks cargo completeness (kg, kub, tovar nomi);
yo'lkira: from-city/to-city/kub/kg/tovar checked, accepted with a
confirmation; bot entry = separate STAFF and CLIENT buttons. Clarifying
questions sent (podklyuch scope, freight tariff table, who may use
hisoblatish, client-button scope); batches to build on his answers.

Round 35 (batch A) — his four answers (podklyuch = rastamojka+yo'lkira
combined; the bot COLLECTS, staff quote; hisoblatish for all staff;
client button = cabinet only) → staff bot batch A SHIPPED (#410):
`telegram/staff-bot.ts` (decisions, integration-tested) +
`staff-handlers.ts` (grammy shell, registered BEFORE the cabinet, next()
for foreign chats). Two-door /start (entry buttons e:s/e:c); staff
phone-link via verified contact vs ACTIVE users (staffPhonesMatch —
platform-local restatement, no wms import), chat_taken refusal;
TaskAssigned carries «✅ Bajarildi» (buttonsFor at SEND time in
sendPendingTelegram; notifyStaffTelegram grew `extra` → taskId), two-step
result capture (in-memory TTL pendings), completeTask under the chat's
honest actor; DebtApprovalRequested carries Ruxsat/Yo'q — permission
checked IN the bot (chat id ≠ session); «📋 Bugun» button serves
composeMyDayText (extracted from the tasks digest — push and pull say
the same words). Red-proofs: permission gate + chat_taken stripped →
tests red. NOT live-tested against Telegram (watch first real press in
docker logs). Batches B (lookup, unanswered reminder, load summary) and
C (hisoblatish AI intake) next.

Round 36 (batch B) — three items, one rule: the bot may know only what
the person already knows (#411). LOOKUP `wms/bot/lookup.ts` (client code
/ box / crate CR- / batch), reached by dynamic import from
`lookupFromBot`; `botActorFor(chatId)` = getActor WITHOUT a session
(perms union + scope from the roles COLUMN + assigned warehouses); every
branch asks `inScope` (in-transit box judged by its batch's TWO ends) and
the balance line needs finance.view/manage. UNANSWERED: migration 0053
adds `tg_messages.reminded_at` + partial index; `unansweredChats` =
DISTINCT ON (client, manager) newest row, direction 'in', unmarked, older
than `unanswered_reminder_minutes` (setting, 30, 0 = off); marked after
sending so ONE silence reports ONCE; 5-min worker `JOB_UNANSWERED`;
'ClientWaiting' in MUTE_GROUPS.alerts. SUMMARIES: finishLoading /
finishUnload → notifyStaffTelegram to `usersWithPermission('plans.manage')`
(now exported from notifications/service), AFTER the tx, exceptUserId =
the presser; 'LoadFinished'/'UnloadFinished' in MUTE_GROUPS.operations
(routine news, not alarms). Red-proofs ×3: money gate, box scope check,
reminded_at filter. Batch C (hisoblatish AI intake) next.

Round 37 (batch C) — «Hisoblatish», the last approved bot item (#412).
Flow: 🧮 button → section (yolkira/rastamojka/podklyuch) → client hint →
material (text + photos/documents) → «Bo'ldi» → analyse → review →
«Tasdiqlash». `wms/calc/intake.ts` holds the PURE decisions
(REQUIRED_FIELDS per section — rastamojka wants no route, podklyuch =
both; zero counts as missing; summary + lenta-note text; parseClientHint);
`intake-manual.ts` reads typed kg/kub/route and WINS over the model;
`intake-ai.ts` = claude-opus-5 structured output, extracts + explains,
never prices, returns null on no-key/refusal; `intake-land.ts` lands it
— coded client → newest OPEN deal (or a new one), stranger → lead,
second request from the same phone joins the first card, ambiguous phone
refuses. Collection state = in-memory 30-min TTL (`telegram/calc-intake.ts`),
files stored on arrival pre-bound to the minted crm_activity note id
(#180); a bot restart mid-collection loses the typed text — stated.
Calc clock NOT started here: the VED picker lives on the card (round 28).
Red-proofs ×2: rastamojka route requirement, ambiguous-phone resolve.
LESSON: JS `\b` is ASCII-only, so «120кг» never matched — negative
lookahead + `u` flag (caught by the test, not by reading).

Round 38 — the owner's split-shipment question («bitimga 2-3 ta prixodni
qanday biriktiraman») exposed a one-way door (#413): both linking paths
(receive wizard, deal card) only ADD, and the deal card offers
`unlinkedReceipts`, so a prixod on the WRONG bitim vanished from every
picker — `linkReceipt(id, null)` existed since birth with no button.
`DealLink` on the receipt card: current deal as a link, picker of the
client's open deals + ALWAYS the deal it is on (won/lost included — the
open list would hide the mistake), empty option detaches. Gate
`canWriteDeal` (deal-write list, not a warehouse permission). Service
untouched. STATED: detaching does NOT walk the funnel stage back — a
stage is a person's record. New i18n `receipts.deal`/`dealNone` ×4;
`deals.unlink` finally has a caller. Red-proof: panel deleted → m9h red
at `receipt-deal-pick` on a fresh db. No migration.

Round 39 — kontragentlar, his money round (#415, «transportlarni qarzga
olamiz … hisobini oladigan qilaolamizmi»). The ledger had ONE counterparty
(the client); trucks on credit, customs paid from another firm's account,
Chinese rent+salaries settled through the transport company, and the two
cash buyers were all costs with no creditor. Migration 0054 (additive):
`partner_types` (editable incl. «Boshqa»), `partners` (optional client
link, ONE account per client), `partner_transactions` (charge / receipt /
payment / offset / adjust) + nullable `partner_id` on cost_entries,
expenses and client_transactions + `customs_partner_id`/`customs_by_client`
on batches. THE RULE: a cost and a debt are different facts — naming a
partner on a cost writes a `charge` POINTING AT the cost row (P&L reads
costs, partner screen reads debts, neither counts the other); paying is
money moving, not a second cost; voiding either side voids the other. DB
`CHECK ((type IN ('receipt','payment')) = (account_id IS NOT NULL))` keeps
the cash-flow honest. A partner-settled expense DROPS its account_id.
`receipt` is the cash buyers' first leg (som in, we owe dollars, residue =
rate gain, closed by a signed `adjust`). THREE-CORNERED SETTLEMENT
(`/kontragentlar/hisob`): two SEPARATE amounts/currencies — his words, the
firm states its own rate — gap printed, never averaged; proof (file or
note) mandatory and the file must be the actor's own upload. Batch card:
customs firm (or «mijoz o'z firmasi bilan») + an attachments panel (batch
had none). Gates: read finance.view, write finance.manage (his answer);
warehouse never sees it. New attachment types `batch` + `partner_transaction`
(allowlist + authz branches). Red-proofs ×4 (cost→charge link, expense's
dropped cash box, proof requirement, paired void). e2e m9y RETIRES its
partner at the end — while active it adds a payer picker to every cost and
expense form (#183). NOT built, stated: opening balances (he does not know
the totals yet).

Rounds 40-42 — the counterparty round's own follow-ups: money reports
taught about partner receipts/payments (`accountBalances`, `cashFlow`,
new `companyBalance` + `/accounting/balance`), `/kontragentlar` opened to
moliya/VED/buxgalter/admin, per-receipt customs (migration 0055) so a
client clearing their own cargo inside a shared truck is recordable, a
payer picker on receipt/crate/batch cost forms and on expenses. Then the
layout bug that cost three rounds (#419): `.input` carries `w-full` and
beats a plain `w-24`, `shrink-0` then forbids the box to give the row
back — the amount field collapsed to a sliver and only the owner's
SCREENSHOT found it. Two process lessons, both mine: a UI change shipped
without ever being looked at in a browser is a change nobody has checked,
and when a user says «tuzatilmagan» after the server is proven current,
ask for the screenshot FIRST.

Round 43 — «boshqa 2 tasiniyam korib chiq», done the way round 42 was not:
opened at 360x800, screenshotted, looked at. **Item 3 was invisible** —
per-prixod customs was a `<details>` nested inside the collapsed VED panel,
two taps deep with nothing on either fold to say it existed (#420).
Rastamojka now has its own panel whose BADGE names the firm and counts the
prixods answering for themselves. Three controls were rendering unreadably
narrow, all the same shape (#421): the customs picker read «Ка», the cost
form's basis read «по», the attach tile's label hung outside its card. Each
gets its own line. The per-row save button appears only when the answer has
changed (#422). Item 2 was correct and reachable all along (#423) — verified
by logging in AS the warehouse operator, not by reading the gate.

Round 44 — an adversarial audit of everything rounds 39-43 touched, four
lenses, per-finding verification: **17 defects, all mine, all from that
week** (#424). Four about money: voiding the CLIENT half of a settlement
left the partner offset live for ever (#425); a cash box in any currency
but USD/UZS was worth zero, with a comment claiming the opposite (#426); a
partner-named cost with no FX rate wrote the firm's name and no debt, and
the rate arriving later did not repair it (#427); retiring a counterparty
dropped its debt from the register but not the balance sheet, and hid the
only door back to its card — same one level up for a hidden partner TYPE
(#428). Plus: `adjust` printed the opposite sign to the balance it made,
the ledger table rescaled the whole phone, a counterparty could never be
renamed though `savePartner`'s update branch had always existed, the
expense form asked for a cash box it then discarded, `common.confirm`
existed in no bundle (#429). THREE TRIPWIRES because three had shipped
before under another name (#430): `style-cascade.test.ts` (a bare width on
`.input`), `i18n-keys.test.ts` (a literal `t('…')` key in no bundle — the
fourth instance of #163), and the rule that **a red proof is undone by a
string edit, never `git checkout`** — doing so here reverted the
uncommitted fix along with the strip. m9y now settles before retiring,
which is the truer demonstration anyway (#431).

Round 45 — the SPEED round (#432-436, owner «tezlikni hal qil»), measured
on a clone of his real data before anything was changed. All 22 main
screens timed: worst server time 313 ms, no query over 200 ms. COUNTING
round trips instead of timing them found the real thing — `/accounting`
issued **1,564 queries for one screen** (`/accounting/balance` 1,611):
`accountBalances()` was six queries per cash box, he keeps 86, and three
panels each asked for the same list. Now five grouped aggregates + a JS
join wrapped in React `cache()` (the `getActor` memo): **1,564/193 ms →
23/44 ms**, balance **1,611/186 ms → 31/53 ms**. Everything else issues
20-70 distinct queries, none over 30 ms — the database is no longer the
story. `log_min_duration_statement=200` added to the compose block (pinned
by the pg-tuning tripwire). What was actually slow was SILENCE: App Router
shows the old screen for the whole Germany→Uzbekistan round trip, so
`NavProgress` starts a 2 px line on the CLICK and ends it on the URL
change, invisible for the first 140 ms so a prefetched page draws nothing.
It cost three rebuilds to a trap worth knowing: a `<Suspense>` boundary
(which `useSearchParams()` forces) hydrates LATE, so the component rendered
while its effects had not run and the click listener was never attached —
the fix was to drop both navigation hooks and watch `location.href` on the
tick it already runs. Also: never key an effect on `useSearchParams()`
itself (new object every render); key it on `.toString()`. e2e m9z asserts
both halves — a bar on a held-back navigation, none on an instant one.
E2E LESSON: `page.route('**/x')` matches no URL with a query string and
App Router asks for `/x?_rsc=…`; and aborting the prefetch makes Next fall
back to a FULL browser navigation, which tears the React tree down and
takes the bar with it.

Round 46 — the owner's 14-point list, the six items that needed no answer
(#440-446). **3 — a truck reads like a shelf:** contents is now the stock
table (photo/code/tovar/📦/kg/m³ + Σ), membership via `batchMemberFilter`
NOT the live pointer — landing nulls `current_batch_id`, so an arrived
batch had been showing «Σ 0» exactly when he looks (red-proven in m4);
kg/m³ are a SHARE of the lot (`onBatch / lot.boxCount`); count keeps the
plan while planned>0, plain cargo count after; column names borrowed from
the `stock` namespace, empty truck gets the sentence with no table.
**4** — stock thumbnails 56→80 px; the sidebar got its OWN scrollbar
(`max-h-[calc(100dvh-3.5rem)] overflow-y-auto` — `sticky` pins but gives
no height, so the menu could only be reached by scrolling the page, which
took the menu with it). **5+12a** — `CalcPanel`/`CalcForm`/
`/reports/hisoblash` DELETED; `calc_requests`, `requestCalc`, the clock,
the sweep and both clock-stop hooks KEPT and still tested, so nothing in
the browser can open a request now — stated to him, VED home's calc queue
will read zero until a door goes back. **7** — «Где машина» is a `Panel`;
m3 now opens `batch-where-panel` before pressing a checkpoint pin
(collapsing something is a behaviour change, not a style one). **13** —
the receive wizard's deal picker needs `canWriteDeal`; the warehouse
cannot know which job cargo belongs to and round 38 put a picker on the
receipt CARD for whoever can. Verified as round 42/43 taught: screenshots
at 360×800 (and 1280×600 for the sidebar), logged in AS the YW operator.
Awaiting his answers: 1 (driver app dying after ~2 h), 6, 8, 9, 10, 11,
12b, 14. Item 2 he closed himself.

Round 47 — his answers to round 46's open items (#447-457). **6 —** a finished
lead leaves the BOARD, never the database: closed columns show the newest 20
(`CLOSED_ON_BOARD`), the header keeps the true total (`closedLeadCounts` /
`closedDealCounts`, scoped as the board is), footer «+N · show all» →
`?arxiv=1`; two queries now (`openOnly` + `closedOnly`), which also fixed a
latent 300-row cap that could have pushed OPEN leads off a busy funnel; deals
board given the same treatment unasked and stated. Red-proof: an OPEN lead
created LAST appears in the won slice with the kind filter stripped.
**8 —** `/batches/[id]/xarajatlar`, the cost grid on its own viewport; the
card keeps a door labelled «12 × 6». **9 —** «kutilayotgan yuklar» off the
warehouse home AND both warehouse menus; the trucks heading here ride on the
batches row instead; the ROUTE and its permissions untouched (a menu decision
is not an access decision); m9o's live-number proof now creates+cancels a
quick batch out of YW. **10 —** route legs carry their own points and `build`
DERIVES the spans (they were hand-written indices), then the corridor learned
the road: Hexi between Lanzhou and Hami, Toksun/Korla/Kuqa around the Tian
Shan, Wuqia to Irkeshtam, Sary-Tash + Gulcha on the M41, Kokand + Angren over
Kamchik. Red-proof 1.475° at Korla. `tracking-engine.test` stopped hard-coding
`points[1]` for the border. **11 —** «Свои списки» off every menu and the
/admin hub; `/o`, `/admin/entities` and both tables untouched; nav tripwire
9→7, 12→10. **12 —** `/reports/vazifalar`: late/due-today/done-today/open,
a 14-day opened-vs-closed bar pair, a per-person table ordered LATE FIRST,
the undated pile, and the ten longest-overdue BY NAME. **Days are UTC days**
on purpose — `parseDue` stores all-day as 23:59:59.999Z and `/bugun` measures
against `endOfToday()`; moving the convention has to move both. `aboutHref`
exported from tasks/view rather than copied. **14 —** the compose service is
`tg-listen` behind the `telegram` profile; the «navbatda» report is still
unexplained and needs those logs. No migration in this round.

Round 48 — his item 14, diagnosed from the server's own logs (#458-462).
The listener's container had lost DNS for the database
(`getaddrinfo EAI_AGAIN postgres`, repeating, for days) while everything else
kept working. `pump()` called `sendMessage` then `markSent` and treated a
failure of the SECOND as a failure of the first: the row sat in `sending`
while the screen read «navbatda» — and with the db merely blinking, the same
path would have marked a DELIVERED message failed and sent it to the customer
twice. Now: everything after the network call is bookkeeping — a successful
send with a failed `markSent` becomes an in-process `unsettled` fact, retried
every tick, nothing else claimed until it lands; a db error anywhere else
RELEASES the claim (the message never left); `isDbUnreachable` extracted
beside `isPermanentSendError` and tested so a Telegram refusal is never
re-queued as a blip. **The alarm for a dead database cannot be a row in the
database** — after a minute of consecutive failures the listener writes to the
manager's own Telegram **Saved Messages** (`client.sendMessage('me', …)`),
once per outage, with the fix command, and «baza qaytdi» when it clears; this
is the only alerting path here that needs nothing but a socket.
`outboxLabel(status, claimedSince, now)` adds **stuck** (in flight > 5 min) —
not failed, not queued, «check Telegram», in warn colour. Red-proofs ×2.
His command failed because the service is `tg-listen` behind the `telegram`
profile: `docker compose --profile telegram logs -f tg-listen`. No migration.

Round 49 — «ishlamadi, qued turibti va habar yo'q bo'lib qolyabti» (#463-466).
His logs after the round-48 restart: DNS fixed, and underneath it
**`401: SESSION_REVOKED`** — Telegram had ended his account's session.
`isPermanentSendError` did not list it, so the listener called it retryable and
knocked every 3 s until each reply burned 3 attempts (4 rows `failed`); the
HEARTBEAT kept being written (the socket was fine, only the AUTH was dead) so
`bridgeState` said «live», `canQueue` passed, and the box went on taking
dictation. **A heartbeat proves the process is alive, not the account.**
`isSessionDead` is now its own predicate — deliberately NOT folded into
`isPermanentSendError`: that one is a fact about the RECIPIENT and kills one
message, this is a fact about US → mark the account `signed_out` (screen goes
red, box becomes «log in again», queueing refuses), `stop(why, 'signed_out')`
the listener, RELEASE the claim so the reply goes out after he reconnects.
The alarm rides the BOT, not the user account — round 48's Saved-Messages
alarm would have gone nowhere. RULE: an alarm about a component must never
depend on that component; this system's two alarms need opposite carriers.
Second bug in the same report, found by reading: the thread's compose box
threw the typed text away on a REFUSAL — React resets an uncontrolled form
after a form Action, and the box also called `reset()` under a comment
claiming the opposite. Now `preventDefault` + no `action` prop + verdict read
first, as the dock's composer always did. Third appearance of that shape
(#377, #419): **a form that can be refused must hold its inputs.** No
migration. OWNER ACTION: reconnect at /suhbatlar/ulash.

Round 50 — «telegramga ulash bor, endi undan chiqishni qo'sh» (#467-468).
A log-out button that would have been a lie in three places, so all three
were made true: `disconnectAccount` NULLs `session_enc` (**migration 0056**
relaxes the NOT NULL — a disabled row must not keep a credential that reads
a person's whole Telegram); the supervisor's `scan()` now STOPS listeners
whose phone left the listenable set (it only ever started, so the button
would have taken effect at the next container restart); and `stop()` takes a
`logOutOfTelegram` flag so the session ends INSIDE Telegram too — the
listener is the only process holding a live connection, so it is the only
place `auth.logOut` can happen. Queued replies are FAILED with the reason
(round 49 released them for a reconnection; that is right when Telegram
killed the session and wrong when the manager chose to leave); conversations
and the account row stay. The confirm names all four consequences instead of
asking «are you sure». Red-proof: the session wipe stripped → the integration
test reads back `v1.x.y.z` instead of null.

Round 51 — «chatni qo'shmaslik … oson bosilib ketmaydigan joyga» (#469-471).
«Stop taking this chat» had sat under the compose box since round 22, on
every screen showing a conversation — a thumb from «Send», on the strip a
keyboard shoves about, and since round 25 the action PURGES what is stored.
Now a ⋯ menu in the thread HEADER (`components/chat-menu.tsx`, native
`<details>`, gated by `replyAccountFor`); off the cards entirely. Reaching it
is open → press → confirm. New tripwire `tests/unit/chat-controls.test.ts`:
telegram-reply/reply-box/dock must mention neither `TelegramStopTaking` nor
`excludeChatAction` — source-shape, because both components always WORKED and
the defect was adjacency. The popover anchors to the header ROW, not the ⋯:
`right-0` on the button put its left edge off-screen at 360 px once the
header wrapped — caught in a screenshot, invisible to every test.

Round 52 — «disconnect qilmoqchi bo'lganimda shunday chiqyabti» (#472-475).
His «Something went wrong» was **the code deployed without migration 0056**:
`session_enc` still NOT NULL → the disconnect's UPDATE throws → 500 → a digest
on screen. Reproduced by putting a db back into the 0055 shape and pressing
the real button. Fixes: `disconnectAction` CATCHES and returns a coded
refusal the button renders in words (the real error goes to the log under
`[tg-disconnect]`); the button no longer assumes success. RULE for ~40 server
actions: **an action touching a schema this release changed must catch** —
the one machine where the schema is behind is production on deploy morning.
DEPLOY.md now says how to check (`drizzle.__drizzle_migrations` count) and fix
(`docker compose run --rm migrate`) — the `migrate` service is `restart: 'no'`,
so a failed migration leaves the app up on the old schema with no trace.
Also shipped from the 4-lens adversarial sweep of the send path (44
candidates, 1 survived, and the verifier proved it explains NEITHER symptom —
the sweep's real value was confirming the write path sound and pointing at the
drain): `/api/dock/thread` never learned round 32's `threadClientFor`, so a
sibling-code card showed the chat in the panel and «no chat» in the dock, and
the dock posted the card's raw id. Both doors ask one resolver now;
`tests/unit/chat-controls.test.ts` says they must.

Round 53 — the real one (#476-479). His screenshot: «habar telegramdan
ketyabti ammo bizning chatda ko'rinmayabti — RASIM KORINDI HABAR KORINMADI».
The asymmetry IS the bug. **Telegram does not echo a message sent on the same
connection**, and the listener IS that connection: `recordSentPhoto` wrote the
`tg_messages` row itself for photos (to avoid re-downloading its own bytes,
not for correctness) while TEXT was left to arrive back through NewMessage —
its own comment stated the assumption. So a text reply reached the customer,
`markSent` flipped the row to 'sent', the «navbatda» bubble vanished with it,
and nothing was ever stored. Outgoing messages typed on his PHONE always
appeared (those genuinely are updates), which hid it. Now `recordSent`
(attachment optional) is called for EVERY send; the unique
(manager, peer, tg_message_id) index keeps a later real echo a no-op — that
protection was always the reason the photo path worked. Red-proof: restore
the photo-only guard → the text test reads back an empty thread. Also
`dismissFailed` + a ✕ on failed bubbles (his three SESSION_REVOKED boxes had
sat at the top of a conversation for a day with nothing able to clear them);
own-account only, audited, refuses anything not `failed`. LESSON: rounds
48-52 each fixed something real and none was his bug, because each reasoned
from a symptom. **When a user reports two things and one WORKS, the working
one is the control group and the difference is the defect.**

Round 54 — «rasimlar cho'zinchoq bo'lib ko'rinmay qolyabti» (#480-481).
His photos rendered as ~18px vertical strips while the same page measured
80×80 locally: a large Android font scale widens the nowrap columns past the
stock table's width, and the layout takes the difference from the photo
column, because the browser stylesheet's `img { max-width: 100% }` makes a
"fixed" thumbnail's MINIMAL width zero. Crush reproduced headlessly (cell
forced to 60px → 60×80, his «cho'zinchoq»; 80×80 with the fix). ONE class in
ONE component: `LightboxImg` puts `max-w-none` on the thumbnail + `shrink-0`
on its wrapper — the photo's width IS its minimum, the table grows and
scrolls instead, every caller (stock, batch contents, receive, plans, feed,
chat) fixed at once; the overlay keeps `max-w-full` (filling the screen is
its job). Guard in `style-cascade.test.ts` — the third cascade rule after
`.input w-full` and the page-zoom rescale.

Round 55 — the owner's item 1, the driver app (#482-486, «2 soatdan keyin
ishlamay qoldi … hech qanday notification ko'rsatmasin, telda yo'qdek»).
WHY 2 h: v1.2's schedule was an AlarmManager CHAIN re-armed by the service
at each cycle's end — process killed + Android 12+ refusing the background
FGS start = alarm consumed, nobody re-arms, dead until a human opens the
app; the first unattended alarm is one interval after pairing. v1.3 (APK
versionCode 4): schedule = PERSISTED periodic JobScheduler job (`Schedule`/
`TrackJob`, no chain, survives reboots); TrackingService is now per-CYCLE
(stops itself, notification exists only the 1-2 min a cycle takes); FGS
start refused → the job degrades instead of dying (drains queue + last
known position — `Uploader` shared drain); BootReceiver touches only
JobScheduler; POST_NOTIFICATIONS REMOVED from manifest+setup chain, so
Android 13+ shows NO notification at all (stated: older Android cannot go
fully invisible). Battery exemption is now doubly load-bearing (Doze AND
the FGS background-start permission) — README says so. SERVER: silent-truck
alarm (round 49's rule, an alarm about a phone cannot live on the phone) —
`tracking/silent.ts`, 30-min sweep, paired+unrevoked device on IN-TRANSIT
batch quiet past FRESH_MINUTES (the map's own constant) → 'TruckSilent'
(MUTE_GROUPS.alerts) to plans.manage ONCE per silence; stamp =
`silent_notified_at` (migration 0057), cleared by the next position.
Red-proofs ×3; the integration file closes its trips in afterAll (a quiet
paired leftover IS a silent truck to the e2e server's sweep, #154). NOT
verifiable here: the APK runs on no machine I have — CI builds it, the
first real 1.3 trip is the proof (watch the batch card's device row).

Round 56 — the Frappe-CRM study (#488-489, owner: «frappe crm bor shuni
organib chiq … ishlatish oson UI da bolishini hohlayman»). ANALYSIS ONLY —
no code, no migration. Three-lens inventory of `/home/user/frappe-crm`
(`develop` @ 2025-01-06). Verdict, told to the owner and APPROVED by him:
do NOT install it (own stack — MariaDB + 8-11 processes + ~2 GB beside
ours; zero translation files; FLAT permissions — every seller sees every
deal; AGPL §13 — **ideas yes, code NEVER copied out of that repo**); port
its ease-of-use layer natively instead. Where we are already ahead, stated:
deal money (their Deal has NO amount field), lost reason (they have none),
in-app custom fields, automation rules, cargo funnel, Telegram depth,
measured SLA (theirs stops on a manual dropdown), reports (their dashboard
is a stub), 4 locales vs 0. The programme is **docs/CRM-UX.md** — five
approved batches: (1) lists = saved views + quick filters + any-column
sort + column chooser + current-view XLSX (rbac-scoped, never a raw dump);
(2) speed = `/search` WIDENED (it exists — spec §12 — but knows no
leads/deals/batches/kontragent/phones) + Ctrl+K + quick-create modals +
bulk actions THROUGH moveLead/moveDeal so audit+rules fire; (3) inline
edit on card rails (a refusal keeps the typed value); (4) desktop-only
kanban DnD via `(pointer: fine)` — touch keeps buttons (owner refused
touch drag twice), stage COLOURS already exist (`crm/stage-color.ts`);
(5) dark mode (print routes stay light) + Telegram canned replies
({ism}/{kod}) + polish. Corrected en route: my own «global search yo'q»
claim was wrong — /search shipped with spec §12; a "we lack X" claim
needs a grep first. THREE questions await his answer (public views
admin-only? / bulk-lost with reason? / shared+personal templates? —
recommendations in the doc are the default if he says «boshla»). Batch 1
starts on his go.

Round 57 — **UX batch 1, the lists** (#490-491, owner: «tavsiyalaring
bo'yicha boshla» = all three questions answered yes). A saved view is a NAME
for the address bar and nothing else: `list_views` (migration 0058) stores the
screen's own query string, applying it is a LINK, so it is shareable, opens in
a tab, walks with the back button and is carried by the export for free — and
a screen that grows a filter next month is savable with no code. `user_id`
NULL = published to the company (admin only, his answer); `is_default` is
personal by construction (CHECK + partial unique index per person+screen);
`normalizeQuery` sorts keys, drops empty boxes and drops the control params so
a view cannot re-save itself. Columns became DATA (`platform/lists/columns.ts`
`ColumnDef`, custom fields join the same list as `cf_<uuid>`): `visibleColumns`
is the one gate — a permissioned column is dropped even when the URL names it,
the link column cannot be turned off, an unknown key is DROPPED (a view
outlives the field it names). Both exports learned the same set — a sheet
carrying a column the screen hid is a leak with a filename. Screens: clients
(views + picker + export, card grid retired for one table), stock (same;
STOCK_COLUMNS in `wms/inventory/columns.ts`), `/o/<code>` (views only, screen
key `o:<code>`). Red-proofs ×3 (permission drop, publish gate, default-clear).
FOUND AT 360 px, all mine: the picker's `<details>` stayed open across its own
navigation and swallowed the next tap; the view menu anchored to the ⋯ pushed
the document to 487 px and mobile Chrome zoomed the PAGE out (#400's mechanism,
#471's mistake repeated — `relative` belongs on the ROW); the stock search
collapsed to ~50 px (#419's cascade, third costume). E2E LESSON:
`browser.newPage()` in `afterAll` has neither baseURL nor login, so the
cleanup silently did nothing and left a saved view that redirects the next
spec — cleanup is a final TEST now, proven by finding the row in the database.
m9e's `getByLabel(city)` now scopes to `custom-filters`: the picker names
every column too. NOT green here: m1×2, m2×1, m9h — all the photo-upload path,
all identical with this round's changes stashed (no image service in this
container; m9h cascades off m1's receipt).

Round 58 — **UX batch 2, first half: the search** (#492-494, owner «2-bosqichni
boshlayver»). READING `/search` first found the real story: its whole guard was
`if (!actor) redirect('/login')` and its four queries had NO scoping — a Yiwu
operator could find a Tashkent box and anyone could page the client book, since
spec §12. The bot's rule («a read wider than the screens is a back door»,
`wms/bot/lookup.ts`) is now the search's: `wms/search/service.ts` asks each
group its own screen's question — warehouseScope on receipts/lots, boxes by
`inScope` on the box OR its batch's TWO ends (transit belongs to no warehouse),
the funnel's ownership rule for leads+deals, the batch screen's five-permission
door, `finance.view` for partners — and a group the actor lacks is NOT QUERIED
rather than filtered. `SearchHit` has no money field, tested structurally.
Widened to leads/deals/batches/partners/phone→client. Red-proofs ×3.
**⌘K palette** (`components/search-palette.tsx`): portal (header's
backdrop-blur, dock's lesson), 220 ms debounce with stale-answer guard, closes
on pathname, Escape. THE CLICK: wrapping the app-bar `<Link>` in
`onClick={preventDefault}` did NOTHING — Next's Link handles the click on the
anchor first, so the icon navigated and the panel never opened;
**`onClickCapture`** is the only phase that can win (Link skips its work when
already default-prevented). The Link stays underneath = the no-JS door, and
`/search` renders the same hits from the same function. `/api/search` is
`private, no-store`. BROKE + FIXED: m9z-nav-progress measured the bar through
that very search link — now the tab bar's `/bugun`, with `:visible` (the
sidebar renders the same href first and is `hidden md:block`). The ⌘K spec
passed alone and failed in the full suite (listener attached by an effect) —
it retries with `toPass()`. TEST LESSON, learned twice this round: a test that
passes because the thing under test never appeared proves nothing. NOTED, not
chased: every page logs one React #418 hydration warning, with and without
this round's changes — pre-existing, wants its own round. **Batch 2 second
half (quick-create modals + bulk actions) is next.**

Round 59 — **UX batch 2c, bulk actions** (#495-496). Ticks on lead and deal
cards (`kanban.tsx` grows an optional `selection` prop — a prop, not internal
state, because only the screen knows what «assign» means; `SelectBox` stops
propagation AND prevents default, since the desktop card IS the anchor and
carries the drag handlers). `BulkBar` (`components/list/bulk-bar.tsx`) over
the board. Actions loop inside ONE `run()` — one authorize, one revalidate,
one rules kick — but the WRITE stays per row through `moveLead`/`moveDeal`/
`setLeadOwner`, the only paths that audit and emit the stage events phase-7
and the cargo-trigger listen to. Answers COUNTS («19 done, 1 refused»); a
refusal never abandons the rest; the selection clears only on a clean run.
New `setLeadOwner` — narrow on purpose (`updateLead` replaces every field)
with a no-op guard so a sweep does not write twenty empty audit rows. Lost
reason still mandatory through the bulk path. Owner assign is offered only
under `crm.leads.view_all`; deals get no bulk assign by design. Red-proofs
×2. FOUND IN A SCREENSHOT: `if (count === 0) return null` unmounted the bar
at the moment it had an answer — it now survives on `count || result`; and
both buttons said «Apply» (now «Ko'chirish» / «Biriktirish»). E2E LESSONS:
the funnel renders BOTH board shapes into the DOM (CSS toggles them), so
specs scope to `funnel-mobile` or every card is found twice; the lost column
is chosen by `option[data-kind="lost"]`, never by position, because the owner
names his own funnel; `audit_log` refuses DELETE by database rule, so a spec
cleans up leads and events and LEAVES the audit trail. **Batch 2b
(quick-create modals) is the one piece of batch 2 still open.**

Round 60 — **UX batch 2b, quick create; batch 2 COMPLETE** (#497-499). The
design was reviewed by three adversarial lenses BEFORE any code, and three
load-bearing assumptions died: (a) the option lists had no home — the layout
cannot afford four queries per render (#432's lesson) and the codebase refuses
a definitions JSON route on purpose, so they were DELETED: `leadSchema` needs
only a name, stage falls back to the first, owner to the presser, an empty
client code means «mint the next». **Two boxes, zero queries.** (b) the
«required custom field → full page» branch enforced NOTHING —
`validateValues` skips an ABSENT key, so a modal with no `cf_` inputs lands a
clean record; replaced by an unconditional «Batafsil →» link, with the card's
panel still refusing the next save. (c) the three existing create actions
CANNOT be called from a button: `redirect()` inside an action invoked from an
onClick rejects with NEXT_REDIRECT and an async handler has no boundary —
hence `quickCreateLeadAction` / `quickCreateClientAction` returning
`{ ok, id, name, error }` (the `CrateActionResult` shape). Also caught in
review: `ClientFormState` has no `ok` field, so `res.ok` would have called
every success a failure. Behaviour: it STAYS on the page (a jump is the
interruption the button avoids), leaves one dismissible «Qo'shildi: …» line
with a link, and refuses to discard a dirty form on a backdrop tap or Escape —
never on a route change, where the page underneath has gone.
`components/ui/overlay.tsx` extracted (portal + backdrop + Escape +
close-on-route with a REASON); the scaffold existed three times and Escape
worked in one. THE MEASUREMENT: adding the «+» silently squeezed every app-bar
icon from 44 px to **33 px** at 360 px — no overflow, no page rescale, no test
red. The language select (60 px, set-once) moved to `/profile` on phones
(`sm:hidden` / `hidden sm:inline-flex`), and everything is back at 44 px.
RULE: `flex` without `shrink-0` protects the layout, never the controls —
only a measurement says they became unusable.

Round 61 — **UX batch 3 part 1, the lead card's facts** (#500-501). The
design was reviewed first and came back UNSOUND on two of three lenses: «a
fact in the rail becomes editable» described NO card — the lead rail carried
no read-only facts at all (phone/company/source/owner/next-call lived inside
a FOLDED ✏️ form), the client rail's facts ARE a form, and the deal rail's
only facts are the deliberately un-editable quote-vs-actual block. So the
round shipped the half that was missing: `LeadFacts` at the top of the lead
rail, with `InlineField` (`components/inline-field.tsx`) on name/phone/
company/note. Interaction copied from the batch card's per-prixod customs
picker — press the value → it becomes a box → SAVE appears only once
something differs; NOT autosave-on-blur (twice refused here; a phone has no
Escape). `wms/crm/inline.ts` `patchLead`: an ALLOWLIST (stage = a move,
owner = a handover, nextActionAt = a PAIR with its note — all refused),
a no-op guard (the funnel orders by `updated_at`), and a `diffFields` audit.
THE HAZARD, fixed: every inline field is ALSO in the ✏️ form, whose inputs
are uncontrolled — correcting a phone inline then pressing Save there put
the old number back. The form is now keyed on `lead.updatedAt` (the LinesForm
precedent), and m9ze presses that exact sequence. Red-proofs ×2. E2E LESSON:
reach the card by the URL captured at creation, never through the funnel —
the board is capped and every earlier spec adds leads to the first column.
**Deal and client cards are part 2.**

Round 62 — **UX batch 3 part 2, the history** (#502-505, owner «1 ozing togri
deb bilganingni qil»). The approved item («collapse repeated changes in the
lenta») was FALSE — `clientFeed` has carried no field changes since round 21;
they live in the History tab — so it was re-aimed there and STATED. Reading
that tab first found the round's real work: **`updateLead` writes NINE columns
and audited a hard-coded THREE** (name/stageId/ownerId, no `diffFields`, no
guard), so a phone/company/source/note/next-call correction through the ✏️ form
left NO trace while the same correction made inline did — and every save wrote
a row whose before equalled its after. `updateDeal` = same, 2 of 8. Both now
diff their real value set, with `updatedAt` SPLIT OUT of it first (a fresh Date
never equals the stored one → `diffFields` would never return null). **`"200.00"
≠ "200"**: `amountChanged` string-compared the form's number against postgres's
full-scale numeric, so `quotedAt`/`quotedBy` were re-stamped on EVERY deal save
— fix a title, own the quote; `canonical()` through `Number()` fixes the stamp
and the `amount: 200.00 → 200` audit line together. `groupHistory`
(`platform/audit/history.ts`): one actor, both `update`, ≤10 min apart → one
entry with the NET per field; never across actors, never a null actor, never a
create/void/scan; **every row survives in a fold with its own time**; a run
netting to EMPTY is not merged (a count over a blank box reads as a broken
screen); badge counts lines on screen, fold counts rows. `visibleChanges` drops
before===after for EVERY row, alone or merged, or one row would read
differently depending on its neighbours. `AUDIT_FIELD_LABELS` translates the
recorded columns ×4 (unknown column prints its own name); runtime key →
anchored by `tests/unit/audit-fields.test.ts`, the fourth instance of #163.
**The lead card gained the History panel it never had.** Red-proofs ×5. No
migration. E2E LESSON: a failed test costs Playwright its worker and the next
test re-imports the spec with module state reset — `goto('')` then lands
quietly on the HOME page and every locator times out blaming the wrong thing;
m9ze asserts `cardUrl` before using it. Also: a bare `ol li` matches the change
lines nested inside each folded row — count by testid.

Round 63 — **UX batch 3 part 3; batch 3 COMPLETE** (#506-508, owner «2 ha
kerak»). Inline edit on the DEAL and CLIENT cards, each with its own
allowlist. Deal = `title` + `note` only (`wms/deals/inline.ts`): the QUOTE
(amount/volume/weight/currency) carries `quoted_at`/`quoted_by`, and a
one-field patch would skip or forge that stamp — #503 had just shown the
cost; stage = a move, owner = a handover, client = whose job it is. Client =
`phones` + `notes` + `salesManagerId` (`platform/clients/inline.ts`, its own
`ClientPatchError`); the CODE stays in the form (identity on every label, act
and payment). `phones` is jsonb, split from one line as the form always did;
the manager is the first PICKER an inline field has had — `options` +
`display` on `InlineField` (the box holds an id, the reader sees a name), the
empty option is a REAL answer, and the id is checked against `users` before
it is written (a picker's bad value is a forged post, and the FK would refuse
it unreadably). Both facts blocks render only for whoever may WRITE — adding
the manager and the internal notes to the read-only client view would be an
access change in a layout change's clothes. **THE REGRESSION, mine, one round
old:** round 61 keyed the WHOLE `LeadForm` on `updated_at`, which remounts it
after every save and resets `useActionState` — the «✅ Saved» line vanished
and nothing asked, until the same key on `DealForm` failed **m9v-automation**
on `toContainText('✅')`. Fix = key the contested INPUTS
(`key={`title-${revision}`}`), never the form; all three forms take a
`revision` prop; a refused save now keeps every typed input for free
(`updated_at` does not move). m9ze asserts the ✅ so the silent version cannot
return. E2E RULE: a spec whose subject is SEEDED data must put it back, and
the restore must be a TEST (round 57's `afterAll` lie) — m9zf captures and
restores both records; note that a restore written after the fact restores
what it FOUND, so the local db had to be rebuilt before this round counted as
verified. Red-proofs ×3. No migration. **CI caught one thing this container
structurally cannot** (#509): m9h reads the deal title back with a bare
`getByText`, and the title is now on that card TWICE (the h1 and the editable
fact) — strict mode refuses. It never ran here, because m9h dies earlier at
the receipt picker, cascading off m1's photo upload. **RULE: the four
known-failing specs (m1×2, m2×1, m9h) make everything AFTER their failure
point unverified locally** — "fails for the known reason" is not "has nothing
to say", and a change touching the receipt, deal or client cards needs CI to
confirm. Fixed by scoping to the h1, and verified by measuring the claim
instead of the spec: bare locator → 2 elements on a real deal card, scoped
→ 1.

Round 64 — **UX batch 4 part 1, the pointer split** (#510-512, owner «4
bosqichni boshla»). An inventory BEFORE any code found batch 4's headline item
— desktop card DnD — **already built** since #133 (`DragBoard`, hand-written
Pointer Events, ghost, edge-scroll, optimistic through moveLead/moveDeal, e2e
mouse drag). docs/CRM-UX.md had read «Kanban deliberately refuses drag today»,
mistaking `draggable={false}` + `onDragStart` preventDefault (the ENABLERS —
a native anchor drag fires `pointercancel`) for a refusal: **the fourth false
«we lack X» claim** in this programme. THE REAL DEFECT underneath: the shape a
viewer gets is decided by **width alone** (`md`, 768 px) and the drag armed a
250 ms hold + `navigator.vibrate` for every non-mouse pointer — so a tablet in
portrait had the touch drag the owner refused TWICE. Now `pointerType ===
'mouse'` and nothing else; `(pointer: fine)` deliberately REFUSED (it answers
about the PRIMARY pointer, so a touchscreen laptop reports fine and keeps
dragging by hand). THE TRAP the review caught: the guard must come BEFORE
`start.current` is armed, or a finger leaves a live origin and the drag starts
on the next 8 px with NO hold — worse than before. Consequence handled (#511):
the move controls lived in the phone view, so a mouse-only drag left a tablet
on a board it could not move anything on — the ⋯ is on the desktop card too
and the sheet was LIFTED to `KanbanBoard` (one sheet, both shapes); ungated on
purpose, because a machine answering `fine` to the media query and «not a
mouse» to the event would otherwise get neither door. REFUSALS (#512): `onMove`
was typed `{ok: boolean}` so both screens dropped the service's code —
`useMoveErrors` (literal map, #163) now names all five, carrying BOTH
spellings (`reason_required` / `lost_reason_required`); `bulk-bar.tsx`'s
opposite comment was REWRITTEN rather than left to disagree (a sweep's rows
are still on screen to retry, a dragged card has no second chance). New
`common.moveErrors.*` ×4; `crm.dragHint` reworded ×4 (the hold is gone).
Tests: `tests/unit/kanban-pointer.test.ts` (source-shape, incl. the ORDER of
the guard and the origin) + an e2e that dispatches a touch-typed pointer
sequence — red-proven by stripping both guards and watching the card move. No
migration.

Round 65 — **UX batch 4 part 2, board filters; batch 4 COMPLETE** (#513-515,
owner «4 bosqichni boshla» + «1 menimcha togri» on the money question). Both
boards read `q` + `hodim` beside `scope`/`arxiv`. THE RULE (#513): one exported
predicate per module (`leadTextWhere`, `dealTextWhere`) pushed into the rows
AND into `closedLeadCounts`/`closedDealCounts` — filter the cards only and a
column matching two jobs prints «+143 · show all» (round 47's promise,
inverted). In SQL, never over the fetched array: open is capped at 300 and
closed at 20, so a JS filter would answer «not found» about the newest twenty.
Needles are the global search's `likeNeedle`/`parseQuery`, so the board finds
what ⌘K finds (phone by last 9 digits; deals also by CLIENT CODE, which is why
`closedDealCounts` gained the clients join). #514: four board links were
LITERAL strings and each dropped the filter — `hrefWith(current, patch)` now
builds them; `hodim` is read only under `crm.leads.view_all` and IGNORED
otherwise (a URL param is a forged post), options from `salesManagerOptions()`
never from the loaded rows. #515: the board's height is `calc(100dvh-19rem)`
so anything above it must declare its cost — `--board-extra` (one line, or two
with the picker). VERIFIED BY MEASURING against a stashed baseline: all three
cases returned to the same board bottom to the pixel. The same measurement
found a PRE-EXISTING defect: `/bitimlar` rendered a 389 px document in a 360 px
screen because its header actions carry `shrink-0`, which refuses to narrow so
the box never reaches a width it could wrap at — #400's page-rescale. Fixed
with `flex-wrap` minus `shrink-0` + the cross-board door reduced to its icon on
phones. New `crm.filterClear` ×4. Red-proof: unshare the predicate from the
counts → the agreement test goes red. No migration. **Batch 4's last item —
per-user card fields — is the only thing left, and the owner has answered its
one blocking question: the deal AMOUNT stays visible to everyone, so the
setting is show/hide per person and NOT a permission.**

Round 66 — **UX batch 4 part 3; batch 4 COMPLETE** (#516-518, owner «1 menimcha
togri» = the amount stays open to everyone). A ☰ in each board's header opens a
`<details>` of checkboxes: which lines a CARD carries, per person.
`platform/lists/card-fields.ts` holds the specs (lead ×7, deal ×6 incl. the
`volume` the owner asked for and the board never had) and `visibleCardFields`,
the one gate — mirroring batch 1's `visibleColumns`. THE RULE that makes it
safe: `null` (nobody chose) is **today's set**, not everything and not nothing,
so an untouched browser renders exactly the card that shipped — which is also
why `volume` is OFF by default. An EMPTY choice survives distinctly from no
choice (`lead=` vs absent). The card's IDENTITY (lead name, deal code+title) is
not in the specs at all: most of the browser suite finds a board card by its
text, so a hideable name would put every one of those specs one cookie away
from red. NOT a permission (#516) — `/bitimlar` is gated by `canWriteDeal` with
NO finance gate, so attaching `finance.view` to the amount would have TAKEN
money from every seller who reads it today; the owner was asked and said keep
it open. Storage = a COOKIE following `platform/theme` (server-read, so no
flash; nothing in the db for the next spec to inherit, #183). Rejected and why:
a `list_views` row costs two queries per render on the sales team's home board
plus a bare-visit redirect, and leaves CONFIGURATION behind; `localStorage`
cannot be server-rendered. Cost stated: per browser, so phone and desktop can
differ — like the theme and the sidebar. The parser survives a hand-edited
cookie (unknown board, missing `=`, truncated tail). Menu is absolute, so
CLOSED it costs the board no height — e2e measures the board does not move when
it opens. Red-proofs ×2 (default→everything; empty choice dropped on parse).
`PageHeader` actions got `relative` so a popover anchors to the ROW (#471,
round 57). No migration. NOTE: /bitimlar's header wraps to two lines at 360 px
for `crm.manage` holders only — they get a fourth button — costing 56 px of
board; measured and accepted.

Round 67 — **UX batch 5 part 1, canned Telegram replies** (#519-523, owner
«5 bosqichni boshla»). A `reply_templates` row (**migration 0059**) whose
`user_id` is a person (mine) or NULL (the company's) — `list_views`'s column
exactly, and publishing asks `admin.settings.manage` (#170, no new code); the
checkbox is a REQUEST and the service checks again; editing/deleting somebody
else's is a refusal. `{ism}`/`{kod}` are filled on the SERVER at the moment a
composer is rendered for a known client (`templatesFor`), so the stored text
stays a template and the browser is never told a customer's name to write a
greeting; the dock fills against the id `threadClientFor` RESOLVED, so both
composers say the same words. A placeholder the caller said nothing about is
LEFT ALONE (≠ an empty value, which blanks itself). The ⚡ picker INSERTS,
never replaces (#377/#419/#463's fourth hat). Screen: `/suhbatlar/shablonlar`
+ a header door. THREE things only measurement or a browser found: the hint
string renders `{ism}` literally, so it needs the ICU escape `'{'ism'}'` or
next-intl prints the KEY in all four locales — the i18n tripwire checks
existence, not validity (#520); `.input` carries `min-h-12`, so a bare
`min-h-24` textarea came back three lines (#519's cousin, #521 — tripwire
extended, `h-28` is the idiom); and the ⚡ took the typing box **128 → 76 px**
at 360 px, so «Yuborish» becomes ➤ below `sm` and the box measures **138 px**,
wider than before (#522). The panel opens `left-0`, not `right-0` — a control
110 px from the edge would put half of it off-screen (#471's third outing).
TEST LESSON (#523): a red proof that turns a REFUSAL into a success leaves the
row behind, so a refusal-shaped file sweeps by run-scoped TITLE, never by
collected ids — three orphans were found by the next spec's locator matching
two. NOT provable here: the picker inside a live composer (CI has no Telegram
account, the same reason m9x can only prove the refusal).

Round 67b — **the CI failure round 67 caused, and the sweep it earned**
(#524-525). CI went red on `inline-edit.integration.test.ts`, a file this
round never touched: it writes three `update` audit rows for one lead, reads
them back with **no ORDER BY** and asserts on `rows.at(-1)`. The new test file
added rows and rollback churn and tipped it over. MEASURED on real data: of
the 1,166 entities with more than one `audit_log` row, **210 already come back
out of insertion order** — `audit_log` takes no DELETEs but plenty of
ROLLED-BACK inserts, and autovacuum frees those slots for later rows. Also:
the local suite runs on a long-lived database whose physical layout is nothing
like CI's fresh one. A four-lens sweep for the same shape (unordered read →
positional access) over `src/` + `tests/`: 7 candidates, **4 confirmed**.
(a) **login** (#525) — `or(phone, username)` + `limit(1)` is not unique
because the two columns are unique SEPARATELY; fail-closed (the session only
ever follows the hash that validated), so the symptom is a colleague refused
with the RIGHT password at random. `findUserByIdentifier` asks twice and the
**phone wins**, stated. RED-PROOF LESSON: the first fixture inserted the phone
holder first and passed WITH the defect — a non-deterministic bug does not
fail on demand, so the fixture must make the broken version deterministic
(username holder inserted first, assertion repeated ×10).
(b) **`clientsForChat`** — `chatLocale` takes the FIRST client with a language,
so a broker chat could answer in a different language between two presses;
ordered by oldest link. Cosmetic: everything that could show wrong data
consumes that list as a SET.
(c) **`m3-planning`'s `makeLot`** — callers read the array positionally and
`recordVerdict` reserves the LOWEST `seq_in_lot`, so a reordered read would
plan one box and scan another. Ordered by seq.
Refuted, worth recording: client-history's `findFirst` (client_code is
uniquely indexed + `[A-Z0-9]{2,10}` on every write path), `staffByPhone`
(matches on `phone`, `notNull().unique()`), the plan's crate-conflict read
(multi-row but consumed as a set).

Round 68 — **the second speed round** (#526-527, owner «qotyabti, ayniqsa
crmda bitim bilan» + «pullar hisob kitobi togri yuritilyabtimi audit qil»).
Round 45's method rerun on his data: the deals board issued ~120 statements
per render — `dealsNeedingAttention` ran `dealReality` PER OPEN DEAL
(2 aggregates each) plus a `findFirst` per priced deal for the quotedWeightKg
that `listDeals` didn't carry. Serial awaits, linear in his deal count = the
freeze he reported. Now `dealRealitiesFor(dealIds)` = ONE pair of
`GROUP BY deal_id` aggregates (absent deal → zero object); `listDeals` grew
`quotedWeightKg`; the client card's deals panel rides the same function.
Measured: /bitimlar 120 → **17 statements**. RULE (#432 restated): a per-row
aggregate on a list screen must be one grouped query — a list's length is the
business growing. **The real PHONE freeze was /stock** (#527): ~450 rows ×
photo ≈ 10,000 DOM nodes, `domInteractive` **4.8 s** at 4× CPU throttle,
server innocent (165 ms / 28 queries), no test red. Fix pages the RENDER not
the fetch: query+sort+Σ+XLSX still cover the whole filtered set, `<tbody>`
shows 120 rows, prev/next are plain links, `page` joined `CONTROL_PARAMS`
(a saved view must not store a position). Measured after: **989 ms / 2,696
nodes**. REJECTED with reasons: `content-visibility:auto` (ignored on
table-internal boxes), SQL LIMIT/OFFSET (the JS sort over derived columns
would sort each page separately — #513's lie in pagination's clothes).
MEASUREMENT NOTE: count statements by grepping `execute`, not `duration:` —
parse/bind lines inflate the naive count ~3×. The money AUDIT ran as a
4-lens adversarial workflow the same day — findings in round 69.

Round 69 — **the money audit** (#528-533, owner «pullar hisob kitobi togri
yuritilyabtimi audit qil»). Four-lens adversarial workflow (client money /
partner money / costs-tannarx / reports), per-finding verify-to-refute: 21
candidates, 20 confirmed ≈ 15 distinct, 1 refuted. THE PATTERN: nearly every
live bug was a PAIR RULE enforced in one direction only (#528). Fixed, each
red-proven: **voidPartnerTx** on a derived charge now unlinks the cost/expense
payer in-tx — before, any recompute RESURRECTED the cancelled debt under the
original enterer's name; chargeForCost now re-prices a live charge when the
cost was re-priced (FX drift); voidCostEntry became ONE transaction (#529).
**voidReceipt** refuses `receipt_has_costs` (money first, #288's rule; cascade
rejected — a warehouse button must not void money); the engine's receipt scope
excludes void boxes and lot-edit shrink recomputes immediately (#530). **The
deferral gate hole** (#531): #251's netting joins on client_transactions.
deal_id and NO form could write it — dead code on real data, gate open on
stale sums; payment form gained the deal select, action parses it, service
refuses a foreign deal, `payment-deal-wire.test.ts` pins both wire halves
source-shape. RULE (3rd appearance): a service-level test of a form-fed path
proves the service, not the system. **Reports** (#532): grid customs now
STAMP their batch (attribution not scope) so profitByBatch sees them
(historical rows stay unattributed, stated); profitByClient = union of both
sides; companyBalance keeps retired tills with money (⚠ row); payments XLSX
kassa matches its screen; `notLaterLeg` stops «shu reysgacha» reading the
future. **Gates** (#533): account_currency_mismatch at all three money doors;
recurring slot gained WAREHOUSE (two rents, one category — second never
posted, home counter mirrors the fix); paymentsRegister total aggregated
in SQL + «newest N of M» on screen and file; grid hint marks unconverted
cells «≈ $0 ⚠». No migration. e2e note: the grid test now mints a REAL
batches row (the stamp's FK) — in_transit + departedAt, route check needs
two warehouses.

Round 70 (calls track, parallel session) — **qo'ng'iroq yozuvi** (#534-538,
owner's five answers: client-book
only / read like Telegram / from install day / iPhone planned-not-built /
accounts stay phone+password). Migration 0060: `call_recorder_devices` +
`call_logs` (`client_id NOT NULL` = the tg-import privacy rule structural;
dedup `(device, phone, started_at)`). `wms/calls/service.ts`: own-account
pairing (a code SIGNS a person — no user picker by design), single-use code,
sha256 token, 410 on revocation (#289); `ingestCalls` answers matched per
call and stores NOTHING for a stranger — the phone mirrors it (a local row
only on `matched:true`, so personal calls exist on neither end);
`callsFor(clientId, viewer)` = the round-21/33 TgViewer verbatim. Routes:
`/api/calls/{pair,logs,audio}` — audio is log-first (bytes only for a known
call, device-scoped find), magic-sniffed, 25 MB, claim-once with
`already:true` on every replay (stops megabyte re-sends). Attachment authz
`call_log` branch ENFORCES from birth (no legacy to break). UI: /profile
«Qo'ng'iroq yozuvi» (mint code / revoke / authed APK download — no public
page, a staff member has a login), `CallsPanel` on client/deal/lead cards
beside the thread (gated `canReadTg`, `<audio preload="none">`), Admin →
Qo'ng'iroq ilovasi publish page. `apps/calls-android` (GSR Qo'ng'iroqlar,
uz+ru): the driver v1.3 skeleton — persisted JobScheduler 15-min job, no
notification EVER (no FGS at all), boot receiver, battery/autostart
checklist + the one step no app can check (the phone's OWN recorder switched
on — Android hands no app the call audio, the design picks up the files the
built-in recorder writes from vendor call-rec folders + a MediaStore «call»
net; generic recordings folders deliberately NOT scanned). Install-day floor
clamps the 24 h re-read overlap (his «ornatilgan kundan»). Found before
shipping: per-call client-book loads (#432's shape, 200×/batch → one ordered
load, oldest code wins per 67b) and a replay-inflated sent counter (~96×/day
→ count only genuinely-new local inserts). e2e m9zj (mint + revoke, leaves
the section bare); 5 integration tests, red-proofs ×2 (client-book gate,
viewer scoping). NOT verifiable here: the APK runs on no machine I have — CI
builds it; the first real paired phone is the proof (watch /profile
lastSeen + docker logs). The deferral arrived the same
evening (#539): his first real call sat on the OLDEST sibling code while he
read the newer card — `callsForCard` now widens the CARD to phone-siblings
(data stays where it landed, the row names its code); the same report
exposed the device-keyed dedup (migration 0061 rekeys to user + cleans the
day-one duplicates) and `findCallForAudio` now scopes by user, or a
re-paired phone's audio would 404 for ever. Local-only e2e note: a SECOND
full run on the same db leaves two in-transit m3 batches whose truck
markers can stack on a warehouse pin and intercept m9c's click — fresh-db
runs (and CI) are green. APK v1.1 the same evening (#549): scoped storage
made the File-API finder answer «nothing» on his Samsung while the files
sat in Recordings/Call — MediaStore-first + resolver streaming, the
privacy fence now folder-says-call OR name-carries-number, and the audio
pass's counters live on the app screen (a silent pass cost the day). The
server was exonerated by scripts/dev-call-audio-probe.mjs — the APK's
exact wire shape, green end-to-end locally. Same night, his ask (#550):
migration 0063 widens the door to OPEN leads — client_id nullable +
lead_id + owner CHECK; ingest matches the book first (oldest code), else
the newest open lead; convertLead re-keys the calls onto the minted code;
`callsForLeadCard` drops the chat resolver's ambiguity refusal (right for
replying, wrong for a log — his lead card sat empty while the client card
played the same recording); app untouched, v1.2 keeps working.

Round 70 — the owner's four items after the merges (#540-544 — renumbered
THRICE: #500-504 collided with round 61, #534-538 with the calls round,
#539-543 with its day-one fixes; every merge re-reads the file's tail). Two
REGRESSIONS from the other session's work: the client book's XLSX had lost
its phone column (`optional` is a rule about a narrow table, not about a
file — `exportColumns` now answers the export's own question, permission
filter unchanged in both branches), and round 55's CHANGELOG heading had
been overwritten so the driver-app entry hung under «kod va bazada hech
narsa o'zgarmadi». REMOVED at his word: inline edit of the lead NAME («nomni
ustiga bosib o'zgartirish … umuman olib tashla») — off the JSX AND out of
`INLINE_LEAD_FIELDS`, since a control removed from a screen while the action
still accepts the field is hidden, not removed; the name is the card's h1 so
nothing is hidden; phone/company/note keep theirs. FIXED, measured on a clone
of his data: the bulk-select freeze — 298 open leads × BOTH board shapes
mounted (`md:hidden` is CSS) = 596 live cards, and a `useState<Set>` in the
parent re-rendered all of them per tick: **135-400 ms → 35-66 ms** (the
33 ms measurement floor). `useSelection()` = a store with per-id
subscriptions (`useSyncExternalStore`, the composer's pattern); the board's
`selection` prop identity never changes so a tick does not reach it; the bar
reads ids at press time. Source-shape tripwire `tests/unit/board-selection.test.ts`
— both versions work, so nothing about behaviour can see it. RULE:
**per-item state over hundreds of live nodes belongs outside the component
that renders them.** STUDIED, no code (his «kodni yozma oldin hammasini
aniqlashtirib ol»): board filters — 383 leads / 1,692 clients, a
four-condition filter with text search + join runs in 0.99 ms, and the
`hodim` filter already works the right way (URL → server query), so the
database is not the question for years; price/kg/kub exist on a DEAL and not
on a lead, so the two boards cannot carry the same filter set. His answers
awaited before building.

Round 71 — his four answers arrived, all built (#545-547). (1) **The lead
took money** («ha pul kerak … hisoblatish bosqichidan keyin bizning
serviceimiz narxi yozilishi kerak va shu narx yutildimi yo'qmi etapiga
o'tadi» — his override of #108): migration **0062** adds (renumbered
twice — 0060 and 0061 both went to the calls work)
`quoted_amount/currency/volume_m3/weight_kg` to `leads`, additive/nullable;
one `quoteValues` helper writes toFixed(2)/(3) so a re-save diffs to
nothing (#503's rule — integration test asserts NO audit row); currency
USD only when priced; the form gained a quote row (`lead-quote-amount`),
the facts rail a read-only line, the CARD a green price line — the one
DELIBERATE break of #517's «null = yesterday's card» stillness, stated in
card-fields.test; «Bitim ochish» on a won lead prefills the deal form,
only when the lead's client matches the preset (#514). (2+3+4) **The
filter panel on BOTH kanbans** (`board-filter.tsx`): manba/dan/gacha/
narx/kub/kg ranges + lenta search; `readBoardFilters` validates
everything out of the URL (#514 — number/date/uuid or dropped);
`leadBoardWhere`/`dealBoardWhere` are the ONE predicate each, consumed by
rows AND closed counts (#513 at design time, red-proven by unsharing);
lenta = EXISTS over crm_activities + the record's own note, deliberately
NOT tg_messages (#383's fence); every combination savable as a round-57
view — ViewBar now on /crm and /bitimlar with a bare-visit default
redirect. MOBILE (his «UI UX ga juda katta etibor»): on phones the panel
is a FIXED bottom sheet above the tab bar; anchored `top-full` it
overflowed the viewport — e2e went green after a z-index fix and only the
360×800 SCREENSHOT showed the apply button below the fold (#547: green
for a robot ≠ reachable for a thumb); chips under the search row remove
one filter each, whole chip = the link. e2e m9zh (3 tests, serial): real
form → price on card → panel narrows → chip restores → saved view →
view deleted as a final TEST. NOTE: this branch's DECISIONS numbers collided twice
(round 61's #500-504, then the calls round's #534-538); rounds 70-71 now
hold **#540-548**.

Round 72 — the owner's refusal of the board chrome (#551-554, «urg'u
kanban view'ga berilsin, qidiruv va hodim filtrini ham panel ichiga tiq,
hamma buttonlarni boshqattdan o'ylab chiq»). Measured first: at 360×800
the first card sat ~1,100 px down. Both boards now carry ONE toolbar row
(title · inline search from md · cross-board door · ⚲ filter with count
badge · 🔖 views · ⋯ · «+» primary) — PageHeader, scope tabs, ViewBar row
and the filter card are GONE from these two pages; q + Meniki/Hammasi
radios (peer-checked) + hodim select live IN the filter panel's one GET
form (#171); chips row (one sideways-scrolling line, SubNav's shape)
includes q/hodim/scope chips. Design judged by 3 adversarial lenses
BEFORE the build — adopted: desktop keeps a visible q input (fold saves
no height there), cross-board door stays visible (m9p presses it), scope
chip (invisible widening = hidden-filter confusion), sticky bf-apply in
the sheet, PopoverRow closing sibling details, clear-link carries scope
(#171, the regression judge's real find). ViewsMenu (boards) vs ViewBar
(lists) share the view-* testid vocabulary as a CONTRACT; card-fields
inside ⋯ is the suite's ONE fold-in-fold, stated. Heights re-derived
(kanban bases 19→12 / 17.5→10 rem; /crm pays SubNav via literal
responsive [--board-extra:…] classes). NEW geometry fence in m9zh reads
--board-extra for the first time (board bottom within [-2,48] px of the
tab bar, width ≤360) — its first run caught the unpaid scope chip at
−28 px. First card now ~290 px. Specs rewritten in the same commit:
m9zg ×5, m9zh-board-filters (views flow + fence), m9zh-card-fields ×7
(board-menu first); m9p untouched (door stayed visible). 1077 + 149
green on a fresh db in CI's order; screenshots at 360×800 and 1280×800.

Round 73 — three more the same evening (#555-557). (1) The CRM SubNav
left the funnel: it renders only inside a `(pages)` route group
(today/dormant/people/settings — URLs unchanged, gates stay in the section
layout); the funnel's ⋯ menu carries those doors; /crm --board-extra fell
back to the deal board's constant. (2) Both boards' cards print
summa · kub · kg as ONE composite line under the money switch; the deal
board's separate `volume` opt-in RETIRED (a switch for a line that always
renders lies) — cookie names for it are dropped, tests rewritten to assert
the absence. (3) The lenta note and the contact log became composer
SHELLS (focus-within ring, `MentionTextarea bare`, 📎 + send on a footer
row); the KIND dropdown became four peer-checked chips. Caught before
shipping: a clipped two-line placeholder (min-h-14) and `border-brand-400`
— a token that does not exist — refused by the tokens tripwire. Same
testids everywhere; m8 untouched. 1077 + 149 green fresh-db CI order.

Round 74 — the capacity round (#559-565, owner: «50 ta user, kuniga 50
qabul, 100 lead, 100 hisoblatish bardosh beradimi va qancha VPS kerak»).
Answered by BUILDING the year on a clone of his data (36,383 leads,
22,401 receipts, 64,920 boxes, 236,765 audit rows = **192 MB**) and
running it. Verdict: every app query under 30 ms (p50 0.2 ms), screens
100-500 ms, and the ceiling is the APP not the database — Next standalone
is ONE Node process, measured 130 % CPU / 742 MB RSS, saturating at ~15
rps against a realistic peak of ~1.5. **VPS answer: 4 vCPU / 8 GB /
400 GB**; DEPLOY.md's «2 GB tavsiya» is wrong and was corrected. What
broke at volume was truthfulness, and four screens were fixed: the funnel
(one 300 cap across all columns took them left-to-right, so columns 2-N
rendered EMPTY at 36k leads — now `row_number() OVER (PARTITION BY
stage_id) <= OPEN_PER_STAGE` plus `openLeadCounts`, the twin of
closedLeadCounts, so the header tells the truth the slice cannot; deal
board same); `listConversations` (a correlated count INSIDE a DISTINCT ON
ran once per MESSAGE — 902 ms at 140k, now 167 ms via round 45's grouped
shape, sorted+sliced BEFORE the follow-up queries, and a ceiling at all);
`/stock` (Σ and row count reduced the 500-row fetch, so at ~700 steady
rows the totals shrank silently and the 10k-cap XLSX disagreed — now one
grouped aggregate over the same predicate, cap stated and raised, the
screen says when the table is a slice); unowned leads (7 % of his real
data, on NO seller's board — «Meniki» now means mine OR unclaimed, counts
followed free through leadBoardWhere per #513). Disk: pgdata+miniodata+
backups share a volume, so a full disk stops postgres AND kills the
backup path the same minute — a `${MINIO_PATH:-…}` compose flag was
written then REVERTED (a bind mount to a missing path refuses to start,
and that bites on deploy morning, #472); the operator procedure went to
DEPLOY.md instead. Red-proofs ×2 (per-stage cap stripped → 2 red;
isNull branch stripped → orphan test red). New `capacity-74` integration
file (7 tests). NOT verifiable here and left for CI/production: the load
numbers came from this 4-vCPU container, so absolute rps on his VPS will
differ — the RATIO (single process = the ceiling) is what transfers.

Round 74b — the owner deleted tap-to-edit (#558, «contactlarni ustiga bosib
o'zgartirish featureni qayerda qoygan bo'lsang hammasini olib tashla»):
`InlineField`, `patchLead`/`patchDeal`/`patchClient` and their three
actions are GONE (deleted, not unreferenced — round 70's rule), the lead
and deal facts render read-only server components, the CLIENT facts block
went entirely (its ✏️ form is always open and printed the same three
fields twice), and the `revision` keys went with them (they existed only
because two writers shared those inputs). New source-shape tripwire
`tests/unit/card-facts.test.ts` — red-proven against the pre-removal tree;
m9ze/m9zf and both inline integration files deleted with their subject.
Values still READ on the cards: round 61's real find was that a phone
number could not be read without opening an editor.

Round 75 — the owner's three home-screen items (#566-569). Designed, then
judged by four adversarial lenses BEFORE any code, and **two of the three
v1 decisions were killed by them** — worth knowing, because both looked
obviously right. (1) «bitim bn crmni ketma ket qoy»: they were ALREADY
neighbours in `sectionSales` and still rendered diagonally, because the
tiles are `grid-cols-2 sm:grid-cols-3` and the two-column row broke
between them — **phone-only**, already correct at three columns. Pair
anchored at index 0 (invariant to the per-viewer filter, NOT to
insertion); sales flow rows reordered to match; `tests/unit/
home-tiles.test.ts` + a browser half in m9p that measures real boxes,
because the unit fence has to name the column counts. (2) «bugun
qongiroq kerak emas»: the NAV entry only — `buildHomeFlow` returns null
for super_admin, so he has never seen `sales-flow-hero`, and a Tile
carries no number while a FlowRow does, so that row is the only place
the waiting-call count exists. Route, permissions, funnel ⋯ door and CRM
section links untouched; STATED to him that the sellers keep it. The
«fold follow-ups into the /bugun strip» compensation was designed and
CUT — `followUps()` has no LIMIT and `/bugun` calls it unscoped for
view_all holders, so mirroring it onto the most-opened screen is #432's
shape. (3) «adminstrativnoedagi klientini glavniga chiqaz»: he had asked
once before and the TILE was moved — the SCREEN still said Administration
in three places, the third of which nobody had noticed (`isActive`
prefix-matched, lighting «Boshqaruv» beside «Mijozlar»). One list,
`NOT_ADMIN_SECTION` in `components/ui/nav-active.ts`, answers all three;
`canClients` in the admin layout deliberately UNTOUCHED. **The route move
to `/mijozlar` was designed and REFUSED**: links.ts bakes `/admin/clients`
into already-delivered Telegram messages so the redirect would be
permanent, ~11 `revalidatePath` targets fail silently when they miss, and
the phone has no address bar (`manifest.ts` standalone). Found on the way
(#569): taking the book off the hub left the logist ONE door, so `/admin`
walks him through it and «← Boshqaruv» became a link to the page he is
standing on — `admin/hub-doors.ts` now holds the doors once and both the
page and the layout ask it. Six red-proofs; the SEVENTH attempt stayed
green with its subject reverted (`toContain('openDoors')` matched the
surviving import line) and was re-anchored on the assignment. No
migration. 1084 unit + 140 e2e on a fresh db in CI's order.

Round 76 — the owner's items 4-5, the funnel card (#570-573). Designed, then
judged by four adversarial lenses; **two of the three v1 decisions were
overturned by measurement**. (4) «etaplar colapse bolsin»: `StageMover` is a
`<details>` whose SUMMARY carries the current-stage chip AND the forward-move
button, so only the jump to a non-adjacent stage folds — the comment that
stood there arguing against a fold is answered, not overruled, and was
rewritten. `preventDefault` on the next button (its click would bubble to the
summary and open the fold under the finger); `key={currentId}` because the
move revalidates SOFTLY and React would keep the reader's `open`. 170 → **74
px**. (5) «umumiy inof … ihcham»: the obvious one-line label/value row was
**measured and REFUSED** — `ru` is default and «СЛЕДУЮЩИЙ КОНТАКТ» wants 165
of 294 px, saving ~24 px and truncating. Height came from removing rows:
`fact-name` (= the h1) and `fact-stage` (= the summary chip) deleted, empty
facts collapsed onto one «To'ldirilmagan: …» line with `fact-phone` exempt
and always printed, `py-1.5` → `py-1`. Facts **474 → 191 px** sparse / 341
filled; lenta **1131 → 752 / 902**, tab bar at 741. `Fact` was the same
component in both cards character-for-character → `components/card-fact.tsx`,
which is how the round's real defect got fixed once: no `overflow-wrap`, so a
token with NO break opportunity (a hyphen-less URL in a note) took the card to
**433 px** and mobile Chrome rescaled the page (#400). **The first red-proof
for that stayed GREEN** — the fixture was a hyphenated e-mail, which browsers
break by themselves; a red proof that will not go red is evidence about the
FIXTURE. Also: the card's stage buttons had awaited `moveLeadAction`'s coded
refusal and dropped it since #512 (now `useMoveErrors`, lifted to
`components/move-errors.ts` so the card does not import `DragBoard`). Stated,
not fixed: `updateLead` writes `stage_id` with no kind check and never clears
`lost_reason` — a second, unguarded stage door. **Correction recorded (#573):
`gsr_dev`'s 383 LEADS are e2e leftovers** (12 name shapes × 27 rows, GS161/
GS252 absent), not his data; the 1,692 clients are real. 1087 unit + 140 e2e
on a fresh db in CI's order; m5 flaked once on ECONNRESET, green alone and on
the full re-run.

Round 77 — the owner's four Telegram items (#574-576). **Audio in**
(#574): `tgMediaPlan` extends the photo planner to voice notes and audio
files — pure, structural, size read before any I/O, unknown size refused;
three traps have tests (gramjs's `document.size` is a **big-integer
OBJECT** and `Number()` on it is NaN, so `NaN <= cap` would have refused
every voice note; a voice note may be labelled octet-stream, so the VOICE
attribute decides; a video note carries an audio attribute too and its own
video attribute excludes it). `attachPhotos` → `attachMedia`, split by
KIND — it sweeps every attachment of a tg_message, so one undivided list
would have drawn an Ogg file as an `<img>`. Player in the bubble
(`preload="none"`), carried to the dock; `tg-import --media` uses the same
planner. Authz unchanged by design: the tg_message branch decides on the
message's owner, so the fence is the conversation, not the file type.
**Queue honesty** (#575, «ocheretda turibti» twice, and the queue was
right both times): ONE `OutboxBubble` computes `outboxLabel` for all three
surfaces (the card panel had its own two-way check and could never say
«stuck»; the dock showed no pending rows at all, so send made the words
vanish), both page surfaces `<AutoRefresh>`, the dock polls its open
thread, and `revalidateChatSurfaces` takes the pathname the person is on
(a lead card's id is the LEAD's). `recordSent`'s swallowed failure — the
ONLY record a text reply has — is now held and retried like `markSent`'s.
TRIPWIRE LESSON: `toContain('AutoRefresh')` passes on a file that imports
and never renders it (#494 from the other side) — the assertion is
`<AutoRefresh` and only then did the strip go red. **Folded managers +
per-manager reading** (#576): `ThreadManagers`, native `<details>`, closed
by default and self-opening when a filter is on; the card pages carry
`?hodim=` and filter in place; selecting is offered only under
`viewer.all` because that is the only case `conversationFor` honours.
No migration. 1082 unit/integration green; m9n/m9r/m9zi green;
screenshots at 360×800 with the fold closed, open, and filtered.

Round 78 — the board cards, the owner's «yomon korinishda … adashmaydigan
tartibli qilib ber» (#577-580). Designed, then judged by FOUR adversarial
lenses before any code — and the lenses plus one measurement killed four of
the five v1 decisions, including my own first fix. THE HEADLINE DEFECT nobody
had named: `nextStage = stages[i + 1]` and every funnel puts LOST after WON,
so **every card in the won column carried a big button reading «Yo'qotildi»**
— suppressed now when the next stage is `lost` (that move demands a typed
reason and was never one-tap), destination drawn as a stage-COLOURED badge in
the vocabulary the strip and headers already use, `aria-label` from the
existing `crm.nextStage`/`deals.nextStage` (all four bundles, referenced
nowhere — zero new keys), tick moved behind a divider at the far end (a bare
checkbox against a stage name read as its caption). ONE VOCABULARY per rank:
identity = the only semibold line, money = the only mono line
(`font-mono … tabular-nums`, never `.num` which forces text-right), everything
descriptive on ONE muted 11px row joined by « · » (`components/board-meta.tsx`,
separator travels with the part that FOLLOWS it so a wrap cannot orphan it).
`text-good` left both cards — it discriminated on the funnel and decorated on
the deal board — so **stage colour is a filled badge, card colour is text and
only ever means urgency**; hence the follow-up date is red/amber/plain against
a `today` the SERVER passes down. DEAL CARD: `{deal.title || deal.clientName}`
retired (one slot, two grammars — a titled deal named no client, an untitled
one named the client twice), and «no price» stopped being said twice in two
colours (money slot = «—», the words belong to the alarm). MEASUREMENT
REFUSED three things: the float→two-column trade made the deal card 139→159
(the column steals 52px from EVERY row, the float only from the first) and is
kept only because rows were removed to pay for it; chips for meta (+7 to +31px
at the real 288px width, and `.chip` already exists as a one-per-row badge);
and `text-xs` on a `.btn`, which is DEAD CSS (measured 15px with, 12px with
`!text-xs`) — **51 live instances across `src/`**, deliberately NOT fixed here
because `text-xs` also sets `line-height` and that half DOES win, so it is not
the zero-pixel change it looks like. New source-shape tripwire
`tests/unit/board-card.test.ts` (9 rules), red-proofs ×4 incl. the browser half
in m8 (move to won → `move-next` count 0 → move back, #154). Also: the phone
toolbar gap 1.5→1 below `sm` because «Воронка» needed 77px of the 74 the title
had — measured, and both titles now fit exactly. Found and fixed en route,
NOT mine: three `crm.integration` tests read `listConversations` unlimited and
went red at 272 stored conversations (round 74's cap) — they now pass their own
limit; CI never sees it on a fresh database (67b). 1113 unit/integration green;
135 e2e pass. **NOT green locally and NOT this round's doing: m9z-nav-progress
fails with this round's changes AND with them stashed** — pre-existing on this
tree, CI is the arbiter (it was green on the merge commit). The four known
photo-path specs (m1×2, m2×1, m9h) fail here as always.

Round 79 — the owner's five card/CRM items (#581-584). (1) **The deal card
re-ranked**: round 78 made the client NAME the identity line — right for a CRM,
wrong here, because his people address cargo by CODE. Client code big + mono,
deal number small beside it, then **tovar nomi**, then money · kub · kg, name
down to the muted line. `listDeals` grew `goods`/`goodsExtra` = the first
`deal_lines.description` (falling back to the title) in ONE grouped query for
the whole board (#432/#526). (2) **The system was quietly discounting**:
`deviation.ts` says `suggestedAmount` is «never a price the system sets by
itself. Deliberately not written anywhere» — true of the database, FALSE of the
screen, because the deal card fed it to the charge box as its default, so cargo
measuring SMALLER than the quote pre-filled a bill lower than the agreed price.
Prefill is the agreed price minus the recorded damage discount; the re-priced
figure is off the screen entirely (a «suggestion» beside the charge box holding
the same number is read as the answer), the % warning stays. (3) The lenta and
contact-log composers turned **brand-RED** on focus (`focus-within:border-brand-500`,
and `--brand-500` is 196 16 16) — now `border-line-strong`. (4) The receipt
picker prints **tovar nomi · m³ · kg** instead of a date, from `receipt_lots`
in one grouped query, Russian name preferred (the Uzbek office reads it).
(5) **Duplicate leads**: `similarLeads` runs BEFORE the write and answers with
NAMES (who, phone, whose) — phone matched on the last NINE digits like the rest
of the app, name only when no phone was typed, **open stages only** (a lost lead
returning IS a new enquiry), never blocks — the same press again creates it and
any edit to name/phone retires the warning. New key `quick.error.duplicate` ×4.
Red-proofs ×2 (open-stage filter, phone branch); 3 new integration tests.
No migration. 1116 unit/integration green; e2e m8/m9zd/m9zg/m9zh/m9n 34 pass.
**m9h fails locally as always** — the picker renders only when an unlinked
receipt exists and m1's photo upload cannot run here (#509's rule); the new
query was verified directly against `gsr_dev` instead. Answered in chat, not
built: how Instagram ads reach the CRM (Meta Lead Ads webhook vs a public form
vs the Telegram bot) — his choice awaited.

Round 78 — the card's two writing surfaces and the history's place
(#585-586; my round number collided with the OTHER session's round 77, and
the DECISIONS numbers with its #574-576 — renumbered on merge, as every
round this week has had to). (1) «crm kartada shu zapis yozish kerak emas,
lenta bor»: the «Записать контакт» form is off the LEAD card. What it
uniquely carried was checked BEFORE it went — `nextActionAt` has always
also lived in the ✏️ form, and `ClientFeed` renders on a lead with no
client — and m8 was rewritten to PROVE it (note on the lenta, follow-up in
✏️, lead still on the call list) rather than to accommodate it. STATED as a
real loss: the four kinds go with it and `crm_activities.kind` is read by
`client-feed.tsx` for the bubble's mark, so everything typed on a lead is
now a note; the chips can move onto the lenta's box on his word. The CLIENT
card keeps its log — he named the CRM card. (2) «istoriya tarix mobileda
eng pastda»: the history sat last in the RAIL, which on a phone is the
MIDDLE of the page, above the lenta. `CardCols` gained a `tail` slot — DOM
order rail → main → tail so the phone needs no rule, desktop places all
three explicitly (`md:col-start-2 md:row-start-2`) so nothing moved there.
Measured at 360: lenta 752 → **628**, history last at 865, document 1022.

**Agreed next (owner, 2026-08-08):** the Telegram ↔ CRM loop, both
directions, his design. (a) A per-account switch «shaxsiy / ish raqami» —
he confirmed the connected accounts are PERSONAL numbers and that both
kinds will exist. (b) An unknown chat (incoming OR outgoing — the listener
already sees both, #315/#476) opens a LEAD: automatic on a work account,
one tap from a tray on a personal one. Schema mirrors the calls round
exactly — `tg_messages.client_id` nullable + `lead_id`, as 0063 did for
`call_logs` — and `convertLead` re-keys chats onto the minted code the way
`rekeyLeadCalls` already does. (c) The reverse lookup he asked for: when a
lead/deal/client is created, check the connected accounts for that phone
and offer «Chatni qo'shish». **Stored as a HASH of the normalised last-9,
with no name** (his choice, my recommendation): the company database must
be able to answer «have we talked to this number» without ever holding a
readable list of an employee's private contacts. Stated to him: coverage is
partial because Telegram hides most numbers, the index needs a nightly
refresh, and a colleague's chat is NAMED but not opened (round 20's fence).

Round 81 — **two live security holes, found by reviewing the ADS design**
(#592-593). Not the ads feature; these were already there. (a) `requestMeta()`
read the LEFTMOST `x-forwarded-for` hop — the one the CALLER writes, since every
proxy appends — and `isRateLimited` counted the **(identifier, ip) PAIR**, so
rotating one header gave every login attempt its own bucket and any staff
password was brute-forceable without limit (~20 people on phone+password,
30-day rolling sessions). The same forged value went into `sessions.ip` and
every audit row. Now `trustedIpFrom` takes the RIGHTMOST entry (the one our own
Caddy appended) and null when there is no header; the limiter counts the
**ACCOUNT** (five/15 min, unescapable) with a twenty-per-address net as a second
layer. Trade stated in the code: five failures lock ONE account for fifteen
minutes whoever caused them — recoverable, unlike an unbounded guess.
(b) `docker-compose.yml` published `3000:3000`, so the identical login form
answered on `http://<vps>:3000` outside TLS and outside the proxy — which is
what made (a) reachable from the open internet. Mapping removed; Caddy reaches
`app:3000` internally. **Takes effect only when the app container is
RECREATED**, so the plaintext door stays open until he deploys. Red-proofs ×2
(restore the pair → the rotating-address test red; restore `[0]` → the header
test red). New `tests/unit/trusted-ip.test.ts` (4) +
`tests/integration/login-lockout.integration.test.ts` (3). No migration.
TEST LESSON: the first fixture minted «victim» and «colleague» from
`Date.now()` alone and got the SAME number twice, so the test asserted the
opposite of its own sentence — a per-run counter beside the clock.
CORRECTION recorded: my design claimed «there is NO shared rate limiter in this
codebase» — `platform/auth/rate-limit.ts` has been one since spec 4.1. That is
the **fifth** false «we lack X» in this programme; the rule stands and I broke
it again: grep before claiming absence.

Round 82 — **the Telegram loop's second half** (#595-597), the three items
round 79 stated and did not build. **Migration 0065**: a `tg_chat_rules` row
may point at a LEAD, the widening 0064 gave `tg_messages` and 0063 gave
`call_logs`; the include CHECK moved with it rather than being dropped.
(1) **«Yangi lid» on the tray** — the answer «this is business, but they are
nobody yet», which is every first-time customer on a PERSONAL number (i.e.
every connected account today). Through `leadForChat`, so #589's do-not-mint-
twice is inherited; owned by the manager whose ACCOUNT it is, never the
presser; the client door clears the lead pointer and the lead door clears the
client one; refused (and not drawn) where Telegram gave no number.
(2) **The lookback** — `TelegramLookback` on the lead, deal and client cards
reads `offerableMatches`: names the MANAGER, a colleague's match is a sentence
and not a button (round 20), renders NOTHING with no match or once somebody
has answered `include`/`exclude` about that chat. `attachChatAction` never
reads `managerUserId` from the form and re-derives the offer for the ACTOR, so
a hand-posted peer id cannot attach a colleague's conversation.
(3) **`tg_peer_index` finally has a producer** — it shipped in 0064 with no
writer, so the lookback's answer was always no. It runs in the LISTENER (only
that process holds a Telegram connection) at start and daily, and the
«not more often than daily» is checked against `max(updated_at)` rather than
trusted to the interval, because the listener restarts on every deploy.
WHERE the lead rule is read is the design (#596): `decideIncoming`, not
`classifyWithRules` — that one answers «whose CLIENT chat is this», the only
question `tg-import` can act on — and BEFORE the classifier, or a lead chat
falls through `not_a_client` back onto the tray. `isSelf` still wins.
**`isClientVerdict` is now exported beside `LiveVerdict`**: `store: true` is a
union of three, `if (!v.store)` narrows away none of it, and #591 was that
exact shape reaching CI in files nobody had touched. Red-proofs ×4 (lead
branch, self guard, the client door's `leadId: null`, the answered filter).
1151 unit/integration + **140 e2e all green** on a fresh db in CI's order —
the four photo-path specs passed here too this time. Screenshots at 360:
tray 3 buttons wrapping to two 36 px rows, lookback panel 155 px, document
360 wide. NOT verifiable here: the listener's index pass and the lead branch
need a real Telegram connection — watch the first one in
`docker compose --profile telegram logs -f tg-listen`. Stated to the owner
and NOT built: pulling a chat's PAST messages when «Yangi lid» is pressed —
attaching is forward-only, exactly as «Bu mijoz» has always been.

Round 87 — **the funnel's second door** (#616-619), chosen as the highest-value
work left after the event-drain lock turned out to be in the OTHER session's
PR #22 (since merged, its migration renumbered to 0066). `moveLead`/`moveDeal` have always
refused a lost stage without a reason and cleared it on the way back out;
`updateLead`/`updateDeal` — the ✏️ form on both cards, with a `<select>` of
every stage — did NEITHER, so an ordinary press could lose a lead with
nobody's reason on it, and a revived lead kept the reason it was lost for and
printed it in red above an open card. Both reproduced BEFORE the fix. One
function now answers for both doors (`crm/stage-law.ts` `stageWrite`), and the
form's refusal needs no second condition anywhere because **the form passes no
reason**. Only on an actual MOVE — an ordinary save on an already-lost record
is neither a refusal nor a wipe, and that third case has its own test.
`formStages` drops lost stages from the four create/edit pickers, KEEPING the
record's own (filtering it out makes the select fall back to its first option,
so Save would silently revive the lead — a worse bug, found while writing it).
**An existing spec went red and that was the proof** (#618): m9v picked the
LAST stage for its rule and every seeded funnel puts lost last, so it had been
exercising the defect since it was written; it chooses by `data-kind` now, and
the rule picker stamps it. Found on the way (#619): m8 invented a funnel column
AND a custom field on every run and removed neither — eight extra columns on
this container's database, which is also why a spec indexing into the stage
list was fragile. Cleanup is a final TEST, not an `afterAll` (round 57's lie).
Red-proofs ×3. No migration. 1224 unit/integration + 145 e2e green on a fresh
db in CI's order, after merging the ads, backup and automation rounds; the
✏️ form verified in a browser at 360. The cleanup test's first locator was `div` soup and passed
ALONE while failing in the full suite — `StageTools` rows carry a testid now.

Round 88 — the loading scanner learns weight (#624-625 — renumbered on merge,
the other session's advert round took #620-623 the same evening, the SIXTH
collision; owner at a truck: «kg
kubi va sredniy vesini ko'rsatishni ixcham qilib»). Every plan row carries a
SECOND muted line `kg · m³ · kg/quti`, and the totals line a fourth figure
`ø` = the average box on board. Second line, not a wider first: measured at
360 the row is 302 px — code 84, goods 177 and already truncating, count 25 —
so three more numbers leave the goods name 43 px and a CRATE row, whose
«goods» is its contents list, nothing. **The divisor is boxes carrying a
weight, never all of them** — an unweighed box adds 0 kg, so counting it makes
the average lighter the worse the data is, and it is also the only count a
QUICK batch has (`doneCount` reads the plan; the ø would have vanished on
exactly the ad-hoc CEO load it is most useful for). Row spacing 1 → 2: a row
is two lines now, and at the old gap the grey weights read as belonging to the
code beneath. **The fourth number is the one that would have rescaled the
page** — the totals row was four un-wrappable spans, 328 px inside a 328 px box
at the fixture's numbers and past the viewport at 12,500 kg / 105 m³, which
makes mobile Chrome zoom the whole page out (#400) on a SCANNING screen where
every tap target then moves. `flex-wrap` + each «·» moved INSIDE the span that
follows it (round 78's rule, so a wrap cannot orphan one); measured realistic
20 px one line, absurd 40 px two lines, document 360 both. LESSON: **measure
the widest value the field can hold, not the value the fixture happens to
have.** m3's e2e asserts both halves; red-proven separately (ø stripped → the
totals assertion red; the row line stripped → `lot-weights` not found). One new
i18n key `loading.kgPerBox` ×4. No migration. 1244 unit/integration + 145 e2e
green on a fresh db in CI's order **after merging main's advert round** —
which is also how the collision was found: GitHub runs no `pull_request` check
at all while a PR conflicts, so the symptom of a stale branch is a PR with NO
check rather than a red one (the recorded rule, hit again).

Round 89 — the Kashgar scanner, and the audit around it (#626-628, owner:
«fura prixod qilishni audit qil qabulda scanner ishlamayabti» → «kamera
ochilyabti lekin qr codelarni oqimayabti» → «menda qr code ishlayabti lekin
qashqar skladchimizda ishlamayabti»). **The third sentence is the whole
diagnosis** — one codebase, two phones, so the difference IS the defect
(#476). `if (DetectorCtor)` tested that `window.BarcodeDetector` EXISTS; on an
Android without Google Play Services it exists, never throws and returns `[]`
for ever, and the zxing fallback was reachable only in the else-branch. Now:
`getSupportedFormats()` (never called before — grep was empty), hand over on
the first throw, and hand over after **25 barren live frames** (~4.5 s) — that
last rule cannot tell "broken" from "not aimed yet" and resolves it toward the
decoder that needs nothing from the platform. zxing's chunk is fetched at
scanner START (these are the OFFLINE screens). Decisions extracted to
`scan/decoder-choice.ts` (#166) + 11 unit tests. **Proven end to end** by
`scripts/dev-scan-decoder-probe.mjs` — a Y4M of a real box's QR through
Chromium's fake camera at the real unload screen, with Kashgar's phone
simulated as a detector that claims `qr_code` and reads nothing;
**red-proven** by raising the threshold to `MAX_SAFE_INTEGER` (166 detect
calls, counter never moved). **Every camera failure was also silent** — one
empty catch made "denied", "camera busy", "insecure origin" and "decoder that
never decodes" the same black square; there is a `cam` state and a sentence
for each now, plus a 12-second "read nothing" hint pointing at manual entry.
The `http://` theory was measured (`isSecureContext:false`, `mediaDevices`
undefined) and **REFUSED as the cause**: the session cookie is Secure in
production, so on a plaintext origin nobody gets past login at all.
**THE AUDIT'S OWN FIND, more expensive than the reported one:** a supplier's
QR (a 45-char tmall URL, which unload queues ON PURPOSE — reality wins) made
`/api/scan/sync` refuse the whole 200-row body, `flushScans` sent the entire
queue at once and threw on any non-200, so the phone's outbox jammed **for
ever** under a **📴 offline banner while online**, the counter kept climbing
green, and `finishUnload` then flagged every unrecorded box
`missing_in_transit` — cargo standing in the warehouse, recorded as lost.
Now: slice at `MAX_PER_SYNC`, **bisect on a 400** so only the truly bad rows
are dropped, never drop on 401/403 (a re-login makes them sendable), and
`isSendableCode` refuses at the door with a sentence. Both scan screens also
stop sitting on «Yuklanmoqda…» for ever — a failed snapshot says why and
offers retry. Deliberately NOT done, stated: widening the sync route's unload
gate to match `/planned`'s read gate (an access change in a bug fix's
clothes). 5 new i18n keys ×4. No migration. 1255 unit/integration + 145 e2e
green on a fresh db in CI's order.

Round 90 — the owner testing as the Kashgar operator (#629-631, «bazi
tovarlarning rasimlar ochmayabti» + «qashqardagi skladchidan tezkor yuklashni
olib tashla»). (1) **A photo belonged to the desk, not the cargo.** The
attachment gate asked `inScope(actor, receipt.warehouseId)`, and a receipt's
warehouse is where the goods were RECEIVED — never where they are. Measured on
his data: of 4,403 goods photos, 737 had moved warehouse and 625 were in
transit or issued, so **1,362 (31 %) could not be opened by the operator
standing next to the carton**. `cargoNearActor` widens to where the cargo IS,
restating `wms/search`'s own rule (the warehouse the box stands in, or the
truck's TWO ends while it stands in none), filtered in SQL because a receipt
can carry hundreds of boxes and a `limit` would answer «not yours» about the
one box that is. NOT a permission change — the same person already saw the
receipt card and the stock row. Red-proven: helper stripped → moved + in-transit
red, «a third warehouse the cargo never touched» still refused. (2) **Quick
loading is now a WAREHOUSE setting** (`warehouses.allows_quick_batch`,
migration **0069**, additive, DEFAULT TRUE — count must reach **70**). Doing it
by role was refused twice over: a role is company-wide (Yiwu would lose it too)
and `batches.depart_close` is also DEPART and CLOSE. Follows
`issues_to_clients`. Four halves pinned by `quick-batch-wire.test.ts`: form
posts it (hidden `off`, #171's fifth), action parses it defaulting true, screen
filters origins, **service refuses anyway** (#531). Destination list untouched.
(3) TEST LESSONS: an unguarded `afterAll` binds undefined ids when `beforeAll`
failed, so vitest shows «UNDEFINED_VALUE» and the real error — a #598 clock
collision — is nowhere on screen; and the counter that fixes #598 must go at
the FRONT of a `slice()`d string or the truncation eats it. 1264
unit/integration + 145 e2e green on a fresh db in CI's order. ONE earlier full
run had a single unidentified failure that did not recur in three later runs;
CI is the arbiter.

Round 91 — the owner testing on real accounts (#637-640). (1) **A seller could
read every client's money.** `sales_manager` holds `finance.view` and
`/finance` ran an UNSCOPED query — every charge, payment, balance and the
company's total debt on a seller's screen — while the same role's other grants
say `clients.view_own` and `reports.own_clients`. `finance/scope.ts`:
`seesAllMoney` = `finance.manage` | `clients.manage`, everybody else carries
`moneyOwnerFilter` = own id; `finance.view` is deliberately NOT on that list,
being the grant that made it a bug. Two answers and no third (#199's shape).
FOUR places, because a scoped list beside an open URL is not scoping: the
balances, the register's rows AND its total, the XLSX (#490 one size up), and
the per-client ledger which `notFound()`s. **Cost stated: 1,402 of his 1,692
active clients carry no sales manager**, so a seller sees only what is
assigned — the deferred access item, which he has now answered. Red-proven.
(2) **Two managers' chats stopped being one.** Interleaving two personal
accounts by `sent_at` shows a conversation that never happened; «Hammasi» is
now `?hodim=all` and the default is `defaultThreadManager` = whoever spoke
most RECENTLY (a supervisor opens a client to read the LIVE conversation),
null when there is nothing to choose between. (3) **Three connected phones
drew three full-width bars** on `/suhbatlar` — one summary line now, detail
one tap away, self-opening ONLY for `signed_out` (not news, a job).
(4) **«Queued» was two waits and neither was a rate limit**: a 3 s poll and a
10 s refresh = up to 13 s of a delivered message looking undelivered. postgres
`NOTIFY`/`LISTEN` on the exported `OUTBOX_CHANNEL` (measured **1-2 ms**;
a naive probe said 2 s, which was the listener's own connect), `MIN_SEND_GAP_MS`
1200 keeps the pacing, the 3 s poll STAYS underneath (a NOTIFY-only listener
loses whatever queued while it was down), screen polls 2 s only while the
queue is non-empty. No migration. 1278 unit/integration + 145 e2e green on a
fresh db in CI's order.

Round 92 — three more the same evening (#641-644). (1) **The facts rail was
painted OVER the history** — and my first measurement said it was not, because
the local card's history is 46 px and can never rise to meet a pinned rail. On
a short lenta with a long history the two overlap by **303 px** and
`elementsFromPoint` returns `lead-facts`; sticky travel is not confined to the
grid row and a positioned element paints over a static sibling. `tail` moved to
`md:col-start-1` (under the lenta); rendering it INSIDE the main cell measured
identical, so the simpler CSS did not decide it. The CLIENT card had both
halves of the same complaint unfixed (history last in the RAIL = middle of the
page on a phone) and moved to the same slot. RULE: **a layout defect needs the
content that provokes it — a fixture that cannot reach the failing geometry is
evidence about the fixture.** `data-cardcols` on all three slots so it can be
measured. (2) **Logout left the app bar for `/profile`** (bar 7→5 controls at
360; language deliberately STAYS on /profile per round 60). Because that page
is now the only door out, its five panel loads each catch and log under
`[profile]` — the name and the button render from the session alone (#472's
morning is exactly when somebody needs to sign in as somebody else).
`nav.logout` reused, no new key. Source-shape tripwire `logout-door.test.ts`.
(3) **The agent Excel groups a plan by the truck that brought the cargo** —
`documents/arrivals.ts`, one sentence: the newest movement, over the lot's
boxes standing there NOW, that moved a box INTO that warehouse; an unload names
the truck. `current_warehouse_id` keeps `batch_departed` out (it stamps the
DESTINATION the day the truck LEAVES); `from IS DISTINCT FROM to` keeps
`plan_approved`/`load_scan`/`crate_packed` out (same warehouse both sides — and
`plan_approved` is NEWER, so without it the sheet names the truck the cargo is
leaving ON: that is the red proof, re-download after approval); the unload set
includes `found_here` (round 89's failed-scanner path) and excludes
`found_at_origin`. One grouped query — 57 ms cold / 11 ms warm on his fullest
warehouse. Blocks with code · date · Σ, oldest truck first, truckless last;
frozen `xSplit`+`ySplit`; headings NOT merged (Excel refuses Sort/Filter over
unequal merges). **Dates print in the WAREHOUSE's zone** — a 07:00 Kashgar
unload is 23:00 UTC the day before, so `docDate(value, timeZone)` now, dd.mm.yyyy
as text (the packing sheet's house rule). Designed and judged by four
adversarial lenses BEFORE any code; that pass produced the `found_here` fix, the
`plan_approved` trap, the timezone, the merge and the reversed English headers.
No migration. 1300 unit/integration + **146 e2e all green** on a fresh db in
CI's order.

Round 92b — **the same adversarial pass, re-run against the SHIPPED branch**
(#645): 35 objections, 26 refuted, and 3 of the 9 survivors were defects
already committed. (a) The arrival query asked where the cargo was STANDING
and `departBatch` NULLS that column — the agent's sheet said «no truck, no
date» about every carton once the truck it describes had left, i.e. a document
that changed its claims on re-download; now `to_status <> 'in_transit'` alone,
with an integration test that departs the batch and re-reads the file.
(b) `foldArrivals` dated a lot from its earliest row of ANY kind, so a
half-walked-in lot printed the truck's code against the walk-in's date and
back-dated the whole block. (c) `groupByArrival` keyed on the JOINED code
list, so a two-truck lot made a THIRD block and one truck's cargo appeared
twice. Also `CardCols`: the tail moved INSIDE the main cell — a grid row of
its own measures identical while the LENTA is taller (the lead card) and opens
**548 px of dead space** when the RAIL is taller (the deal card), y=1129/1723
vs y=597/1191. New `m9zl-card-history.desktop.spec.ts` SWEEPS the scroll and
pads the history first: the broken layout reads zero overlap at rest, so an
at-rest assertion is green on the bug — which is exactly how round 92's first
measurement went wrong. RULE: **a rule that is right about the common case and
silently wrong about the case the business has is the shape all three had.**

Round 93 — his three answers after connecting the sellers (#646-648).
(1) **The tray opened to the hodim**: /suhbatlar/qaysi demanded
`clients.manage` since round 22, so a seller's unknown chats piled up on a
screen only the admin could open. `mayDecideChats` = own connected account
(status <> signed_out) | clients.manage, asked by the screen, the /suhbatlar
door and all THREE actions; row scoping untouched (own rows; admin.settings
= everybody's). Red-proof + 4-entrance source-shape tripwire
`chat-tray-door.test.ts`. (2) **7-day history on connect** (migration
**0070** `history_backfilled_at`, count must reach **71**): the listener's
catch-up machinery pointed at a window — on start with a NULL stamp, walk
dialogs, last `BACKFILL_DAYS=7` capped 500/chat, same decide-and-store path,
stamp only at the END (killed mid-pull = owed again); `saveAccount` clears
the stamp so a reconnect recovers the missed week. `backfillStep`: `openLead`
= STOP (a week of strangers must not become a week of leads in one burst —
he asked for «hozirgi bor clientlari bilan»), client `empty` service row =
SKIP not stop. NOT verifiable here: first real connect watched in tg-listen
logs («ulanish tarixi: N ta suhbatdan M ta xabar olindi»). (3) **Calls
selector** = the thread's `ThreadManagers` fold reused on the calls panel,
`?chodim=` beside `?hodim=` on all three cards, ONE `cardHref` carries the
other filter (#514). Scoping argument differs from round 34's: the fetch is
viewer-scoped FIRST and chips narrow fetched rows, so a hand-typed chodim
can only shrink; red-proof strips the viewer fence in `callsForClients`.
Offered only to viewer.all with >1 taker. STATED, not built: «notanish raqam
tel qilsa lid ochaymi» needs a new calls-APK version (the phone today never
uploads an unmatched call) — its own round. 1318 unit/integration + 146 e2e
green on a fresh db in CI's order.

Round 94 — «javob kutmoqda» stops lying (#649-653, owner: «habar javobsz
qoldi deb warning berishni chatni ichiga kirgandan keyin tohtatish — negaki
klient chatga nuqta qoygandur … javobsz qoldi degan narsa juda yomon
korinyabti»). The mark meant «the newest message came IN» and that sentence
was restated by HAND in four places — `listConversations`, `chatBadges`,
`salesFlowCounts`, `unansweredChats` (#513 broken four ways). One pure
predicate now (`crm/waiting.ts`) with THREE states: **new** (nobody has seen
it — the alarm), **seen** (read, no answer written — «ok» needs nothing),
**answered** (we replied, or a reply is on its way out); `chatNeedsAnswer` is
`new` and nothing else, so the red badge AND the 30-minute Telegram nudge
both narrow. «Seen» is **Telegram's own read receipt**, copied not invented:
`UpdateReadHistoryInbox` (a Raw update — gramjs models only NewMessage and
EditedMessage) → `recordChatRead`, migration **0071** `tg_chat_reads` keyed
(manager, peer). `GREATEST` in both writes, because Telegram redelivers out
of order after a reconnect and a stale update would resurrect a dealt-with
alarm. Our thread screen and the dock mark it too (to him both screens are
the chat) via `markThreadRead`, whose own-account fence is a **WHERE** rather
than a check — a supervisor's glance matches no rows and silences nobody
(red-proven). A POST from an effect, never a write in the server page: App
Router prefetches the thread link from every hover on the list. TWO LIVE
DEFECTS found by writing the predicate down: `tg_outbox` was never consulted,
so a reply typed in the CRM left the alarm up until delivery — for ever while
`tg_sending_enabled` is off, which is how it ships; and `salesFlowCounts`'
hand-written DISTINCT ON had no `client_id IS NOT NULL`, so postgres grouped
every lead-owned chat in the company into ONE phantom «waiting» on the
seller's home. UI measured at 360: «✓ o'qildi» costs **71 px of the client's
NAME** on the row nobody must act on, so below `sm` the tick carries it alone
(#522's idiom) and the name is back at 201 px; the dock shows the alarm only
— less, not different. Red-proofs ×4; 10 integration + 8 unit tests. STATED,
not built: a manager who reads a real question and forgets it now leaves no
alarm — that wants a «remind me» button. Also fixed, not this round's
subject: `m3-planning` asserted `\d{3}` on a batch code that pads to three
and does not cap, and this container's database has run past 999 trucks —
**a long-lived local database is a different oracle, not a worse CI**.


Round 95 — Telegram parity: files, reply quoting, «forwarded from» and
showing a colleague (#654-658, his items 1-5 answered in one message).
Migration **0072** (`reply_to_tg_message_id` on `tg_messages` AND `tg_outbox`,
`fwd_from` on messages). **FILES**: `tgMediaPlan` takes documents — invoice,
spreadsheet, archive, a clip of the pallet — on the photo branch's terms (size
read before any I/O, unknown size refused, 20 MiB), and asks `isStorableType`
(exported from the files service) rather than keeping a second list beside
storage; stickers and round video notes deliberately still stop. Sending
widened too: `queueReply`'s `kind !== 'photo'` refusal is gone, the cap is
asked PER KIND at both doors, and `forceDocument` stops Telegram re-encoding a
PDF into an unnamed picture. **QUOTES**: a plain bigint, never an FK — a reply
can name a message older than the import (the FK would refuse the ROW) and
`purgeExcludedChat` deletes messages while keeping the queue; `attachQuotes`
resolves it in ONE query over the page through the (manager, peer, tg id)
index, and an unresolvable quote renders as an EMPTY strip because «this
answers something» is still the fact. **FORWARDED**: `fwdFromName` reads the
resolved sender, then `fromName`, then `postAuthor` — never a network call —
and returns `''` for «forwarded, source hidden», which the bubble tells apart
from null. **SHARE** (his «boshqa mijozga jonatilmaydi» narrowed it): one
message to one colleague's Telegram with a card link, audited with a new
`share` action; the file is NOT sent, so the attachment gate keeps deciding.
Every refusal re-derived server-side (own-account read, active user, never
yourself). **The bubble stays a SERVER component**: 500 messages × two
controls would be 500 hydration roots, so the buttons are plain markup with
data attributes and the composer + share sheet find them by CAPTURE-phase
delegation, one listener each. Found in the browser, not by a test: the ↩ was
drawn where the composer is not (bridge down) — `canReplyNow` is the one
predicate now and the page passes an empty label; and the share sheet had no
panel at all, since `Overlay` owns the backdrop and nothing else. Red-proofs
×5; 22 unit + 9 integration. Two EXISTING tests rewritten with the reason
recorded — both asserted «a document stays a paperclip / is refused», which is
the behaviour he asked to have removed. 1364 unit/integration + 141 e2e (the
five known local failures) after merging main's round 93.

Round 96 — **taqsimot: per-person rota + routing rules** (#660-661, his
answers 1a/2a/3 the day the first Meta lead landed on an admin: «hamma
sotuvchi, lekin hamma lead bilan ishlamaydi … qaysi lead oqimi bilan kimlar
ishlashi … filterlab taqsimot»). Migration **0073** (count must reach **74**):
`users.inbound_rota` BACKFILLED from the role flag (deploy morning changes
nothing — he then EDITS instead of discovering an empty rotation), plus
`inbound_routes` (sort_order / source_key / keyword / user_ids jsonb /
active / assigned_count). ONE screen `/admin/taqsimot` (gate
`admin.settings.manage`, #170): participants = every active user with a
checkbox (replace-all is sound because no box is disabled, #171), then an
ORDERED rule list — source and/or case-insensitive keyword over name+note,
first match wins, ↑↓ arrows because order IS meaning; a rule names PEOPLE
(validated against `users` — a jsonb list has no FK) and inside its pool the
SAME fewest-first query decides (`nextInboundOwner(pool?)` in
`crm/routing.ts`; the old role-joined copy in inbound.ts is DELETED, as are
the roles-screen checkbox and `setRoleInboundRota` — a control removed from a
screen while the action still accepts it is hidden, not removed; the roles
COLUMN stays, unread). Routes run ONLY for the new-lead branch — client
questions and joined enquiries keep their people. A rule whose members are
ALL deactivated falls back to the general rotation, never to unowned.
`roles.inbound_rota` chore in ADS.md §0 rewritten to the new screen.
Red-proofs ×2 (match stripped → 2 red; person-flag read widened to
`active` → 4 red). TEST LESSON (#661): the fixture's phone builder sliced 14
chars to 13 and cut the only distinguishing digit — every arrival became one
joined-then-capped enquiry and the capped branch's undefined leadId surfaced
as UNDEFINED_VALUE two tests later; and the file now snapshots/clears/restores
pre-existing flagged users, because the flag is GLOBAL where the old role was
file-scoped (#653's oracle). 1389 unit/integration green on this container's
long-lived db; no e2e added — the screen's buttons call exactly the
integration-proven actions (#183: a route is CONFIGURATION, and the round's
cleanup is a final test).

Round 97 — **the tarjimon: forma savollari → lead maydonlari** (#662-663,
owner: «bazan targetda yukingiz bormi, necha kub yokida boshqa har hil
savollar beriladi — qanday qilib leaddagi fieldlarga ulayman?», then «boshla
o'zing to'g'ri deb bilganingni»). Designed, then judged by a THREE-LENS
adversarial workflow BEFORE any code — 20 agents, **15 confirmed findings,
2 refuted**, and the build absorbed every one. Migration **0074** (count must
reach **75**): `lead_field_map` (key UNIQUE → kub/kg/field/note; field FK
CASCADEs — a mapping is derived config and must not 23503 the fields admin),
`lead_intakes.fields` jsonb (capped capture 30×80×300, secret key-names
dropped), `inbound_routes.min_m3/max_m3`. ONE module `crm/field-map.ts`:
pure `parseMeasure` (comma decimal, **refuses ≥100 000** — numeric(12,3)
holds nine digits and a pasted phone number must not abort a landing),
`parseYesNo` (ha/bor/да/是), `applyFieldMap` (inactive-field targets degrade
to note-only), `textVolume` (unit-anchored «25 kub» out of free text — routes
the lead, never fills the card), `seenKeys` (one grouped
jsonb_array_elements). THE BLOCKER, made structural: `record()` runs last, so
structured writes sit in their own catch — a poisoned answer (pattern rule,
overflow) degrades to note-only and the LEDGER ROW still exists, keeping the
replay fence and both caps closed; red-proven by turning the catch into a
rethrow. LIVE pre-existing leak fixed: the plain webhook's body-key secret
(`key`/`google_key` — the documented auth path) fell through to the lenta
note past `refWithoutSecret`'s fence; `SECRET_BODY_KEYS` now sits in the
parser's known-set, red-proven. Both parsers return `fields` PAIRS beside the
unchanged note (the lenta stays the full record; every mapping reversible);
`setFieldValues` grew round 83's `{system: true}` branch; checkbox answers
skip unreadable rather than writing «no». `matchRoute` compares volume as
NUMBERS (drizzle numeric = string, '10'<='9' — listRoutes converts once);
a volume rule skips an arrival whose volume is unknown. Screen: third panel
on /admin/taqsimot (mapped list with ⚠ decay hint, auto-discovered unmapped
keys with samples, manual key row) + min/max kub on the rule form. i18n ×4.
Tests: 21 unit (field-map) + routing volume matrix + webhook leak test + 5
integration (mapped landing beside note lines, poisoned-answer ledger
survival + replay fence, volume routing incl. the /ariza text fallback,
seen/decided keys). Red-proofs ×2. 1400 unit/integration green on fresh
gsr_ci in CI's order.

Round 96 (this session) — the board's own order, and the height it was wasting (#664-668,
owner: «cartni boshqa etapga otkazganda ularni tartibi ozgarib qolyabti qaysi
ketma ketlikda qoysa usha saqlanib qoladgan qilsa boladimi?» → «2 ni qil»
= full drag-to-position, + «etaplarning boyi balandroq bolsin pcda … scroll
chiqib qolyabti yonidan shu korinishi kerak emas»). A column was ordered
`updated_at DESC` (deals `created_at DESC`), so moving A then B put B above A
and an ✏️ edit, an owner change or an automation reshuffled a column nobody
had touched. Migration **0075** `board_order double precision` on BOTH tables
(minted as 0073 and renumbered on merge — the other session took that number
the same day, with the same `when`, so the timestamp moved too),
**backfilled from the order the board showed that day** (`row_number() OVER
(PARTITION BY stage_id …) * 1000`), so the deploy changes nothing visible and
the first drag is the first difference; NULL stays legal and READS as «nobody
placed this» = sorts FIRST = where a new card has always appeared, so a write
path that forgets the column degrades to the old behaviour. A drop takes the
MIDPOINT of its two neighbours (one row per drag, not 4,500). **The per-stage
cap had to learn the same ORDER BY** or a card dragged low VANISHES instead of
sinking — forty fetched by date, a different forty drawn by hand (#513 wearing
a slice's clothes); the closed slice moved too and keeps round 47's promise by
different means (per-column ranks → the top of every closed column, not all of
one). `place` is the DRAG's and nobody else's: the one-tap button, the ⋯ sheet,
bulk, rules and the cargo trigger all pass nothing and get `topOfColumn` = «it
just arrived», so not one existing behaviour moved; the board's `move()` still
refuses a same-column PRESS and allows a same-column DROP because only the drop
carries a landing place. **A pure re-order writes no audit row and emits no
stage event** — it is the sidebar being collapsed, not a fact about the lead
(#502's empty-diff row, and «entered stage X» must not fire on a card that
entered nothing). The arithmetic is PURE (`crm/board-order.ts`, zero imports)
because the browser does it too: a card that snaps back for Uzbekistan's third
of a second reads as a refused drag, so the board keeps an optimistic
`ordering` map filled with the same midpoint the server is about to compute.
`'renumber'` is the server's alone (`renumberColumn`, one UPDATE per stage) and
covers both «gaps exhausted» and «unplaced cards» — one sentence twice. PHONE:
↑ / ↓ in the ⋯ sheet, disabled at the ends (the touch drag stays refused,
#510). HEIGHT, measured before touching it at 1280×800: the board stopped
**67 px** short of the window on /crm and 69 on /bitimlar, 32 px of which is
the layout's `md:pb-8` and needs `md:-mb-8` (the vertical `-mx-4`) to spend
without the page growing a scrollbar (#354) — `10rem`→`6rem` + `-mb-8` =
**588→652** / 540→604, a whole extra funnel card. `.no-scrollbar` on the column
box only (eight bars arriving and leaving between eight columns); it still
scrolls. Red-proofs ×4 (cap ORDER BY, board ORDER BY, `place` ignored, the
browser's `beforeId` dropped → the desktop e2e drag goes red). 9 unit + 10
integration + e2e m9zm (4 mobile) and m9zm-desktop (2, incl. the geometry).
1383 unit/integration + 152 e2e on a fresh-db CI-order run; screenshots at
1280×800 (board, and a drag in flight with the drop line) and 360×800 (the
sheet's ↑↓, document 360 wide).

Round 97 (this session) — the receive screen's photo, and eleven rounds of a believed excuse
(#669-671, owner: «yuk qabul qilganda rasimni kirgizgandan keyin prixodga
ruxsat chiqmayabti»). `browser-image-compression` runs in a Web Worker and the
worker does not CONTAIN the library — it `importScripts` it from
**cdn.jsdelivr.net at runtime, on every photograph**. So `addPhotos` awaits a
57 KB third-party download before compressing a byte, and until it resolves
there is no thumbnail, no error, and a confirm button that stays grey because
`lotsValid()` wants a photo. Measured here (no route to the public internet):
**12.7 s** to fail, then a silent fall-back — FLAT across photo sizes and
barely moved by a 4× CPU throttle, which is what proved it a wait and not a
computation. In Yiwu/Guangzhou/Kashgar, where every receipt is created,
jsDelivr is not reliably reachable at all. Fix = `libURL` → `public/vendor/`
(byte-identical copy, pinned by `tests/unit/vendored-lib.test.ts`, and the
build's service worker PRECACHES it so it works with no network at all):
**0.5 s, zero foreign requests.** Red-proven by deleting the line and watching
both come back. **THE FOUR «known failing» photo specs were this** — dismissed
since round 57 as «no image service in this container», a sentence invented to
explain a red test and then believed because it was written down; all four pass
now (5 local failures → 1). RULE: an explanation for a failing test that nobody
has re-run against the failure is a guess with a citation. Second half, because
a fixed slow path is still a silent one: `busyLots` is a COUNTER per lot (the
📷 takes several files), the tile goes ⏳ and refuses another, the sticky bar
says «Rasm yuborilmoqda…» INSTEAD of «no photo yet» (both leave the button
grey; only one is the operator's to act on), confirm is disabled while anything
is in flight, and the decrement is in `finally` or a refusal leaves the screen
stuck on «working». Also swept: the built client bundle reaches NO other
foreign host (the OSM basemap is already self-hosted). Three new i18n keys ×4.
No migration. **The 43-agent adversarial sweep this round launched confirmed
the diagnosis independently and made it WORSE** (#672): here the connection is
REFUSED, so the library falls back after 12.7 s and merely gets slow — a
connection that HANGS matches neither of `compressOnWebWorker`'s two exits and
there is no timeout in it, so the promise **never resolves** (proven by holding
the route open). That is what a blocked host in China does, and it also
explains «it worked before»: the service worker's StaleWhileRevalidate bucket
matches `/\.(?:js)$/i`, so a phone that had fetched the script once kept
working from cache, and the deploy that reinstalled the worker took the cache
away. Four more fixed from the same sweep: `ensureBucket` latched on SILENCE
(one storage blip after a deploy → every upload skips the check until the
container restarts; it now latches on an ANSWER, any status); a pg-boss hiccup
500'd an upload already committed to storage AND the database (the operator
re-took the photo → two on the receipt); deleting one photo wrote back a
render-time `photoIds` snapshot and took any photo that landed meanwhile;
and the upload had no deadline at ANY layer — survivable while the screen was
silent, not once it shows ⏳ (120 s + a sentence).

Round 98 (part 1) — **the owner's 8-item list, the six unambiguous ones**
(#683 — my draft minted #664 and the OTHER session's board round took
#664-672 first; renumbered TWICE more on merges as its rounds 98-99 took
#673-682; item 4 was its kanban work, untouched
here;
item 8, the sales analytics page + lost-reason dictionary, is part 2, agreed
«dunyo standartlarida hammasini» + reasons picked from a LIST). (1) The
dark-mode invisible chat input was a PHANTOM CLASS: `input-sm` used in four
places, defined nowhere — browser `field` white under inherited dark-mode
ink. Defined now; `style-cascade.test.ts` grew the vocabulary fence (every
used `input-*`/`btn-*`/`chip-*`/`card*`/`label*`/`num`/`section-title` class
must exist in globals.css or print.css), red-proven, and its dry run
correctly found print.css's own `label-frame`/`label-svg`. (2) The bridge
fold no longer self-opens on `signed_out` — his production has one signed-out
manager, so it stood open EVERY visit; the summary line alone carries the red
alarm. (3) `excludedBookMatches` — an excluded chat whose last-nine matches
an active client's `phones` renders «⚠ mijoz kodi: <code>» in the tray's
decided list. (5) `assignReceiptClient` KEEPS `unclaimedMarking` (was
nulled): the box physically says `GS500MANIKEN-AL`, so the label sheet and
the stock table now print the marking first with the client code small
beneath; safe because unclaimed = `clientId IS NULL` everywhere (grepped,
not assumed). (6) `/api/attachments` sends `Content-Disposition`: inline for
pdf/image/audio/video/plain-text (PDF opens in the tab), attachment for the
rest — html/svg/xml deliberately NEVER inline (stored upload must not become
a script on our origin), pinned by `attachment-disposition.test.ts`.
(7) The map's silence after the VPS move = `.data/basemap/corridor.pmtiles`
is per-server and was never fetched on the new box — owner given
`docker compose --profile basemap run --rm basemap`; truck marker redrawn
32px cab-and-trailer; the corridor gained the BETWEEN towns (Dingxi, Shandan,
Jiayuguan, Xingxingxia, Yanqi, Taldyk pass, Kamchik pass) so the mountain
stretches bend like the road. No migration in part 1 — part 2's lost-reason
dictionary mints **0078** (renumbered from 0076 on merge; 0076/0077 are the
other session's client_notices and batch_customs_cleared).

Round 98 (part 2) — **item 8: /crm/tahlil + the lost-reason dictionary**
(#684, owner: «dunyo standartlarida qanday malumotlar tahlili bolsa hammasini
hohlayman va … yopilish sababini listdan belgilaydigan qilishimiz kerak»).
Migration **0078** (minted as 0076 and renumbered on merge, the TENTH
collision; count must reach **79**): `lost_reasons` (label/sort/
active, unique lower(label)) + `closed_at` on leads AND deals, backfilled
from `updated_at` for already-closed cards (approximation, stated).
`closedAtFor` + `reasonAllowed` live in stage-law beside `stageWrite` (a
unit test pins that the law and the stamp agree about what a decision is);
every stage door stamps: moveLead/moveDeal, both ✏️ forms, convertLead —
only on a real MOVE (a drag inside the won column re-orders, never
re-stamps; a revival clears, like the reason). `crm/analytics.ts`
`salesAnalytics` = one Promise.all of grouped queries, TWO CLOCKS (new by
created_at, won/lost by closed_at); `readPeriod` validates `?dan/gacha` out
of the URL (#514), gacha inclusive. Screen: 7-cell scoreboard, per-day
bars, funnel snapshot (deliberately unperioded), sources/sellers tables
(owner NULL = a real «—» row), lost-reason breakdown, deals block; SubNav +
funnel ⋯ under `crm.manage`. THE DICTIONARY: rows edited on /crm/settings
(SourceForm's shape; deactivate is the only removal), offered by the
kanban's `LostReasonDialog` sheet, StageMover and the bulk bar's select;
moveLead/moveDeal REFUSE an unlisted reason once the list exists
(`lost_reason_not_listed`, in useMoveErrors + i18n ×4) — the stored value
stays TEXT (a rename never rewrites a record), and an EMPTY list keeps free
text everywhere, so day one and every pre-dictionary spec behave exactly as
before (zero e2e changes). Red-proofs ×2 (gate stripped → listed-labels
test red; stamp stripped → 2 red). New `tests/unit/stage-law.test.ts` (8) +
`tests/integration/lost-reasons.integration.test.ts` (8, snapshots/clears/
restores the GLOBAL dictionary per #653, analytics fixtures parked in
March 2020). ~26 i18n keys ×4. FOUND BY THE SCREENSHOT, not by any locator:
`Overlay`'s close-on-navigation effect runs once on MOUNT, so a dialog
conditionally rendered already-open closed itself the frame it appeared —
the dialog is now kept mounted and toggled like every other Overlay caller.
1440 unit/integration + **154 e2e all green** on a fresh gsr_ci in CI's
order (vitest, then Playwright without re-seeding); screenshots at 360
(tahlil, settings panel, the dialog over the funnel) and 1280.

Round 99 — **tahlil filtrlari** (#685, owner: «filterlarni maximalna qoyish
mumkun bolgan narsalarga qoyib ber, source sotuvchi va boshqalar»).
Designed, then judged by a THREE-LENS adversarial workflow BEFORE any code
— two blockers absorbed. /crm/tahlil filters: manba + sotuvchi (both with
'none' = the «—» cohort) + narx/kub/kg ranges, ONE GET form (period row
visible, the rest in a badge-counted fold that self-opens when active),
chips row echoing active filters (each chip removes its own; clear keeps
the period), preset/clear/chip/row links ALL via `hrefWith` over
validated-then-reserialized values. `readAnalyticsFilters` in analytics.ts
(#514: hodim/manba = uuid|'none'|dropped — a garbage hodim was a 22P02
500); `AnalyticsFilters` is structurally unable to carry createdFrom/To
(the board's dan/gacha = a created_at range; HERE the period on two
clocks). `leadFilterConds` owner branch is STRICT eq/isNull — deliberately
NOT leadBoardWhere's «mine OR unclaimed» (attribution vs work routing;
comment states it, red-proven by swapping the or() in). Deals: filters AND
onto the OR fragment which now wears its OWN parens — drizzle and() embeds
members verbatim, so the bare fragment rendered `(filter AND open) OR
closed` and the WON cells escaped; the first red-proof asserted the open
cell and stayed GREEN — printing the generated SQL found the truth, and
the test now pins the won cell (#166: a red proof that will not go red is
evidence about the fixture). Under a source filter the deals block hides
with a sentence (a deal has no source; unfiltered numbers read as
filtered). Pickers render HISTORY: listSources(true) + sellers = active
options ∪ data owners (#171 — a value the form cannot render is deleted on
the next submit); source/seller table rows are themselves filter links,
active row highlighted. Swept while in the area, live on the boards since
round 71: date() was regex-only — ?dan=2026-02-30 was a ::date 500 on
/crm and /bitimlar, and in readPeriod V8 ROLLS it to March 2nd (a silently
shifted period, worse than the crash); both round-trip now. Both boards'
hodim gained the uuid format check. Refused with reasons: lost-reason and
stage filters (five of seven cells zero by construction / contradicts the
two-clock design). 10 new unit + 5 integration (fixtures in April 2020 —
March is the lost-reasons file's); red-proofs ×2. No migration.

Round 100 part 1 — the owner's 14-item list, the eight no-question fixes
(#686-691; the list came with his instruction to CONSULT on trade-offs first —
the consultation went out, his answers came back, part 2 holds the agreed
designs). (11) **The board tick never drew**: round 59's `SelectBox` called
`preventDefault` on the checkbox's click, which cancels the browser's
ACTIVATION behaviour — React stored the id, the browser reverted the pixel, and
every count-based assertion stayed green for a year; `stopPropagation` stays
(the card is an anchor), default is the control's, m9zc now asserts
`toBeChecked()` — the only oracle that looks at the pixel (#686). (8) One rule
for whose-cargo cells — `labels/code-identity.ts`, marking big / client code
small — consumed by plan view, plan editor, loading, unload, batch card AND
stock (#687); the pick-search matches both compositions. (6) `BoxIssued`
carries `lots` in the ArrivedLot wire shape (share-of-lot in-tx, one grouped
query) so the client's «yuk berildi» names goods·kg·m³ like the arrival does;
`Array.isArray` keeps years of old events rendering as they did (#688).
(2) `receiptContents()` — ONE grouped query behind the deal card's picker AND
its linked rows. (12) `conversationForLead` + a read-only `leadId` branch on
`TelegramThread`: a lead born from a chat finally shows it; own-account fence
verbatim, used only when no client resolves or a converted lead's bubbles
render twice (#689). (4) History prints NAMES behind recorded ids
(`AUDIT_FIELD_REFS` + `resolveAuditRefs`, uuid-shaped only over a mixed
vocabulary, miss prints raw, id in the tooltip; the new fence found `dealId`
unlabelled on its dry run) (#690). (14) `/admin/clients` pages the RENDER at
120 over a full fetch — SQL OFFSET refused, the in-memory sort would order
each page separately (round 68); `CLIENT_LIST_CAP` deleted, screen and XLSX
finally cover the same set (#691). (9c) The map's warehouse popup links
`/stock?wh=<id>` — `?warehouse=<code>` was silently ignored. No migration.
Red-proofs ×5 by string edit; item 7 (quick-batch error, digest #2832070603)
awaits his server log; item 10 answered in chat (kelganlar is a LEDGER — the
replay fence and the daily caps read it; the screen may get paging later).

Round 100 part 2 — the owner's approved designs (#692-697; his answers 1A /
3-yop / 5A / 9A+9B / 13A). Designed, scouted by five parallel readers, then
judged by a 19-agent adversarial workflow BEFORE any code — **14 confirmed
findings, several of them blockers, every one absorbed.** (3) The deal-card
charge door DELETED (form+action+panel+4 i18n keys); the review's find: the
fallback ledger picker was open-stages-only while cargo triggers auto-win a
deal at handover, so a day-after charge would silently lose its deal —
`ledgerDealsForClient` (open ∪ closed<60d ∪ live deferral) now feeds
/finance/<client>. (1A) clientFeed's cargo branch gains a LATERAL over
receipt_lots (goods ru-preferred · kg · m³ in META — the union is positional
past branch one); notes carry authorId and the reader's OWN notes sit right
(`own ? 'ml-auto bg-brand-50' : TONE[kind]` — REPLACING the tone: two bg
utilities resolve by stylesheet order and warn/10 compiles later, the
appended version was right-aligned but warn-tinted with dead brand CSS);
cargo test mints its OWN client (the shared fixture's exact kind-sequences
were the review's first blocker). (5A) `transitTrucks` in inventory/service:
live-pointer membership, in_transit ONLY («arrived» through the live pointer
shrinks to Σ0 during unload — #440 refused a second time), two-ends scope +
either-end wh filter, SQL-coalesced sums Number()ed, cap 20, zero-box rows
dropped; strip renders between Σ and the table, outside Σ/sort/views/XLSX.
(9a) `snapToRoute` (0.15°, farther = a real detour stays raw) wired into
truck.ts's live branch; `chordDeg` = cos(lat)-weighted pacing IN RADIANS
(the unit test asserts the weight itself — cos40°≈0.766, a radians slip goes
negative); map self-refreshes (AutoRefresh 60s + Leaflet overlays in ONE
LayerGroup so the basemap and zoom stay put); Tianzhu+Artux joined the
spine — Artux pinned at 0.1° (chord passes 0.225° away, red-provable),
Tianzhu deliberately UNPINNED (0.055° from the chord it divides — no honest
threshold sees it; #166 applies to mountain towns). (9b) Migration **0079**
`warehouses.lat/lon` (count must reach **80**): db wins, WAREHOUSE_POINTS
fallback; `coordField` decides emptiness BEFORE coercion (`z.coerce.number('')`
is 0 and 0°N0°E is a real place — the review's Atlantic-warehouse blocker);
form inputs on the capacityM3 template. (13A) `startMenuFor` + merged
`bothKeyboard` (reply keyboards are exclusive); `isCabinetText` (derived from
allLabelVariants — the labels ARE the router #264) lets cabinet buttons
through the staff catch-all BEFORE the «Bajarildi» capture; the three
keyboard-naming replies (lang switch, calc-save, staff-link) now ask
`replyKeyboardFor(chatId)` — the review traced the merged keyboard dying on
the first ordinary press; the /start deep link goes through `linkStaffChat`
(raw UPDATE skipped the holder check; unique-violation vanished into
bot.catch as silence), own-chat re-link stays a re-link. Red-proofs ×7 by
string edit (incl. one that WOULD NOT go red and was rewritten). New tests:
coord-field ×4, tracking-snap ×4, bot-both-modes ×7 (3 source-shape),
transit-strip ×3, feed 1A ×2, staff-bot own-relink, route-shape Artux.
NOT verifiable here: the bot halves against real Telegram (no network) —
watch the first /start of a both-chat in docker logs.

Round 98 (this session) — the customer's two messages, both about Telegram
(#673-678, owner: «har br karobka uchun habar jonatyabti» and «telegram appda
u yuk qaysi etapdaligini korsin … ui uc ham juda tushunarli bolishi kerak»).
(1) **One arrival message per client per TRUCK.** `ingestUnloadScans` walks the
phone's queue one input per TRANSACTION (deliberately — that is what makes the
offline queue replayable) and the client's copy rode `ReadyForPickup` inside
it: one carton = one message, and «accept the rest» feeds one input per short
code, so one press on a 200-box truck was 200. His CHINESE arrival was right
and is the control group (#476) — one per RECEIPT, with the goods. Migration
**0076** `client_notices`: the first landed box CLAIMS the right to speak
(`ON CONFLICT DO NOTHING` on (client, kind, ref), inside the movement's own
transaction — round 83's rule), and the TOTALS are read minutes later when the
truck has been scanned. A row and not a timer, or a deploy in that window loses
the message; 20 min is a CEILING and `finishUnload` releases early. kg/m³ are a
SHARE of the lot; membership through `box_movements` (#440 — the live pointer
red-proves three tests red). The truck is never named: a batch code is the
company's throughput and 20 other customers' dates. `BoxIssued` was the last
sentence on this path hardcoded in Uzbek — now the client dictionary.
(2) **The cabinet timeline**, his nine rungs, DERIVED from
`warehouses.country` + `warehouses.type` + `boxes.status` + the batch's two
ends and the operator's pin (`client-cabinet/stages.ts`) — nothing hunts a
warehouse by name, so a second hub just works. **The ETA needed no
new table** — `tracking/map-data.ts` has held his own per-route hours since the
map shipped (YW→KA 144-168 h, «border 1-3 days», Osh→TAS 36-48) and
`engine.ts` already anchors them to the checkpoint pin; only the map ever asked.
`tracking/eta.ts` is now the ONE assembler (#513) and `truckFor` reads it too.
A date only on a moving rung, only with a route, always a range, always with
its DESTINATION in the sentence, and nothing once the schedule is spent. Raw
box statuses left both surfaces (bot text + Mini App now share one ladder) and
`📍 YW` became `📍 Yiwu`. FOUND BY LOOKING, not by a test (#678): `Intl` prints
a short month in Uzbek as «M08 14» — Chromium ships no Uzbek month names, and
Uzbek is what most of his customers read; the estimate is numeric `dd.MM` now.
Red-proofs ×6. Screenshots at 360×800 in uz and ru, document 360 wide.
(2b, his answer «ha rastamojka tugadi tugmasini qo'sh», #679): «ozbga kirdi»
and «rastamojka» were ONE rung — nothing stamps a cleared declaration and a
stage that advances only when a human remembers is a stage that lies — so the
cost was STATED and he took the trade. Migration **0077**
`batches.customs_cleared_at`, tap on the batch card's customs panel, gate
`ved.docs`, toggles, ✅ on the collapsed FACE (round 43's own lesson, same
panel). A COLUMN and not a fourth `tracking_checkpoint` key: those three are
POSITIONS and re-anchor the map's clock through `CHECKPOINT_SEGMENTS`.
NULL = «nobody has said», so every truck that departed before the deploy keeps
one rung. The stamp splits all THREE in-Uzbekistan branches at once. The action
calls `authorize` so no integration test can press it — four halves pinned in
`customs-cleared-wire.test.ts` (#531's third outing), browser half in m9y which
puts the stamp back (#183). Red-proofs ×2 more. 1456 unit/integration;
152/154 e2e (m9z-nav-progress is the known local red; m9r-dock flaked in the
full run and passes alone).

**Ads → CRM lead intake: DESIGNED and REVIEWED, not yet built.** Three lenses

**Ads → CRM lead intake — SHIPPED in round 83 below; this is the review that
shaped it, kept because every item on it became a rule.** Three lenses
(abuse / regression / product-fit) produced a build plan that kills most of the
v1: the join rule must match on PHONE only (the name branch lets a stranger
write into a real customer's card), every public answer must be ONE constant
string (created/joined/dropped differ = an enumeration oracle over the client
book), both Meta handlers must **404 when unconfigured** (`undefined ===
undefined` fails OPEN), the HMAC must read `await request.text()` (re-serialised
JSON never matches) and never let `timingSafeEqual` throw on a short header,
`createLead` needs a `system` branch (it throws without an actor and
`leads.created_by` is NOT NULL), `addActivity` does NOT touch `updated_at` so a
joined lead would not rise on the board, `followUps` has no `isNull(ownerId)`
branch so an unowned inbound lead sits on nobody's /bugun, the rota belongs on
a `roles.inbound_rota` column rather than `salesManagerOptions()` (which
re-adds deactivated people), and `lead_sources` needs a stable `key` column
because find-or-create by NAME splits `funnelReport` on the first rename.
Owner's answers on record: Instagram IS a business account linked to the
Facebook page; ads run by HIM and by an AGENCY; leads assigned round-robin to
everyone.

Round 83 — **the event-drain lock and reklamadan lead** (#599-604, owner:
«keyingi raundni boshla, 1 va 2 ni ham qil»).

**(1) The drain has a lock.** #594's fix, made: `claimNextEvent()` stamps
`processed_at` inside a `SELECT … FOR UPDATE SKIP LOCKED`, so two overlapping
drains split the work instead of both acting — the per-minute sweep against
the kick every CRM action fires. Red-proof: **1584 recipient rows vs 792
distinct** without it, equal with it. TWO false red proofs first: `InternalNote`
has no recipients so nothing was countable (#494's lesson, third time), and
comparing each event to the FIRST event's count is satisfied by uniform
doubling — the assertion that works is `count(*)` vs `count(DISTINCT …)`.
Trade stated: claim-before-work loses an event if the process dies mid-batch;
marking-after duplicated it every race, and the race is the common case.

**(2) Reklamadan lead — THREE doors, one landing.** Migration **0066**:
`lead_intakes` (channel/external_id/source_key/ref/phone/name/outcome/reason +
UNIQUE (channel, external_id) — Meta re-delivers until it gets a 200),
`lead_sources.key`, `roles.inbound_rota`, `leads.inbound_at`, and
`leads.created_by` + `crm_activities.created_by` DROP NOT NULL (an advert has
no author). `wms/crm/inbound.ts` `landInboundLead` is the ONE landing:
client-book first → the one open lead on that phone within 30 days (joined,
owner untouched) → a new lead; lost leads never joined onto; **phone only,
never name** (`similarLeads`' name branch is right for a person deciding and
catastrophic for a machine). Caps 3/phone/day + 200/source/day, counted over
the ARRIVALS ledger including the dropped ones. **One constant answer** for
every outcome — created/joined/client/capped read identically to the sender —
while INPUT complaints stay specific.
- **Door B `/ariza`** (public group, no session, uz+ru side by side like
  `/driver`): works the minute it deploys, `?manba=` validated against
  `INBOUND_SOURCE_KEYS`, utm kept in `ref`.
- **Door A `/api/leads/meta`**: `metaConfig()` null unless ALL THREE secrets →
  route **404s** (`undefined === undefined` fails open); HMAC over
  `await request.text()` (re-serialised JSON never matches); `timingSafeEqual`
  length-checked first (it THROWS, and a 500 is «send it again» to Meta);
  webhook only ENQUEUES (`JOB_META_LEAD`), the worker reads Graph and gives up
  on a permanent error instead of retrying for ever. Source recorded as `meta`,
  not guessed — the payload does not name the surface (`ad_id` kept in `ref`).
- **Door C bot** `?start=ad_<key>`: `telegram/ad-intake.ts` (30-min in-memory
  visit) → the cabinet's own contact handler lands a stranger and clears the
  visit; an existing client still gets the cabinet.
- **Rota**: `roles.inbound_rota` checkbox on /admin/roles (NO own-role guard —
  unlike `warehouseScoped` it only ever gives its holder more work); fewest
  inbound leads wins, `NULLS FIRST`. **Ships OFF**, so day one every advert
  lead is unowned — hence `followUps` gained `isNull(ownerId)` (round 74's
  «mine OR unclaimed», now on the call list; the CLIENT half deliberately did
  not widen). Every inbound lead is booked for TODAY.
- **`/crm/kelganlar`** (gate `crm.manage`) = the arrivals ledger, in the ⋯ menu
  and the SubNav. Built as a 6-column table and REBUILT as a list: at 360 px
  the phone showed three columns and «what became of it» was off the right
  edge.
- **The timing filter was built and TAKEN OUT** (#599): at 3 s the e2e's own
  submission was eaten and answered «qabul qilindi» with nothing written. A
  junk lead is visible and one tap from lost; a paid enquiry dropped in silence
  is invisible for ever, and a real robot adds a delay in one line.
- **THE DEFECT the browser found** (#600): `clientFeed`'s note branch
  INNER-joined the author, and 0066 made that column nullable — so the advert's
  message vanished from the lenta while ten integration tests, all asking the
  DATABASE, stayed green. **Making a column nullable is a change to every
  reader that joins on it.** Swept: nothing else needs it.
- Two existing tests changed with reasons recorded: `role-home`'s «a stranger
  sees zero» is false by design now (baseline + owned-lead-does-not-move +
  unclaimed-lead-does), and `deal-auto-stage`'s cleanup was leaving **three
  generations of trigger stages** behind when its events delete lost an FK race
  — now one transaction inside a try, because **nothing that can race may stand
  in front of the CONFIGURATION cleanup** (#183).
Setup guide for the owner: **`docs/ADS.md`**. 1173 unit/integration green;
139/143 e2e (the four known photo-path specs; m9z-nav-progress is the
pre-existing local failure recorded in round 78).

Round 84 — the owner's five answers, taken in his order (#605-608).

**Demo data left the production seed entirely** (his report: «productionga
chiqazganimda seed bilan birga ko'chirib qo'yyabti warehouse users va boshqa
hamma demo datalarni»). It sat in `seed.ts` behind `if (seedDemo)`, and
`seed.ts` is what the compose `migrate` service runs on EVERY deploy; the flag
read «the users table is empty», which is true of a real installation exactly
once — the day it is created, which is the day he deployed. Warehouses, the
eleven published-password accounts, the example clients, the §6.9 FX example
and the canonical GS777 receipt are now `scripts/seed-demo.ts`, run only by CI
and the local suite (`pnpm db:seed:demo`); `seed.ts` no longer CONTAINS the
code, so there is no condition left to get wrong. `seed-demo.ts` keeps its own
guard (refuses a database holding any account that is not one of its own;
`SEED_DEMO=1` overrides). The tripwire went from «is the flag wired up» to
reading `seed.ts` as TEXT and refusing the demo password, the demo phones, the
demo warehouse names and the flag itself — red-proven by putting one demo
warehouse back. Verified on a throwaway db: `db:seed` alone leaves 0 users /
0 warehouses / 0 clients / 0 receipts with every reference table filled.
**Consequence caught and fixed in the same round:** that took the only way IN
with it — a fresh install had every role and nobody to sign in as, while
`ops/bootstrap.sh` still printed the demo login. `pnpm create-admin +998… "Ism"`
mints one super_admin and prints a GENERATED password once (an argument lands
in the shell history; a default is a published password in a hat), and refuses
once any account exists.

**The hisoblash CLOCK closed; the bot's 🧮 stayed and got its missing half.**
He first said «hisoblatish degan hamma narsani yop» and then narrowed it: the
bot intake stays, the lead must belong to whoever sent it, and the card must
land on the hisoblatish stage. The clock had had no door since round 46 —
nothing could open a request, so the 5-minute sweep ran over rows nobody could
create and the VED home counted a permanent zero. `calc/service.ts`,
`actions.ts`, `jobs.ts`, both clock-stop hooks, the mute entry and
`calc.integration.test.ts` are deleted; the `calc_requests` TABLE stays (real
rows from before round 46, and a table is never dropped in the release that
stops writing it). VED's hero is now the paperwork queue; `/bugun` left
`flow.hrefs` with its row or the day screen would have vanished from that home.
Of his two asks one was ALREADY true — `landIntake` has always created the lead
under the sender. The stage was not: `crm_calc_stage` / `deal_calc_stage` are
settings with a picker on both funnel-settings screens (not a name the code
hunts for — the funnel is his to rename, `lead_sources`' lesson), empty is the
default and means «do not move», and the move is FORWARD only by sort order
(#392's rule) through `moveLead`/`moveDeal` so audit, stage event and automation
rules all fire. Red-proofs ×2. The settings tripwire caught the two new keys
needing a description in all four bundles.

**One-off scripts go through `migrate`, never `app`** — his
`docker compose run --rm app pnpm demo-users --disable` failed with
`Cannot find module '/app/pnpm'`, because the runner image is the stripped
standalone build with no pnpm, no tsx and no source, so node's entrypoint took
«pnpm» for a filename. DEPLOY.md now says so with the working lines.

**MIGRATION NUMBER COLLISION, the first one** (#605): the other session's
Telegram round and this one both minted **0065**, with the same journal `when`.
Theirs was merged first, so mine renumbered to **0066** — and the local ledger
had to be repaired by hand (drizzle applies anything whose `when` exceeds the
last applied `created_at`, so a rename alone would have re-run mine and skipped
theirs). Rolled my DDL back locally, re-ran both in journal order, 68 rows.
RULE: **before minting a migration, `git fetch origin main` and read the tail of
`_journal.json`** — the DECISIONS numbers have collided four times and now the
migrations have too.

Round 85 — **the off-site backup gets an S3 destination** (#609, owner:
«google drive emas boshqa joy yo'qmi buni zahira olgani» → «1 sen tavsiya
berganingdek» = Contabo Object Storage). `backup/s3.ts`: all four values or
null (a half-configured destination must read as «not configured», not as a
silent failure), `forcePathStyle` mandatory, upload then HEAD to verify the
stored size, paged listing, prune only after a verified upload, `keep <= 0`
refuses to delete anything. S3 WINS when both destinations are configured —
not a fallback chain, because falling through means a night's backup landing
where nobody looks. **THE FIND, from building a stand-in bucket rather than
assuming:** since ~3.729 the AWS SDK sends a stream body as `aws-chunked` with
a trailing CRC32 — no `Content-Length`, 4140 bytes on the wire for 4096 of
dump — which Contabo and other clones REFUSE. `requestChecksumCalculation:
'WHEN_REQUIRED'` fixes it; red-proven by removing the line (3 tests red).
Round 9's Drive path never made one real request, which is why its seven-day
token was learned late. `docs/BACKUP.md` rewritten S3-first, `.env.example`
gained the four keys. 1187 unit/integration green.

Round 86 — **automation rules at full strength** (#610-615, owner: «shuni
maksimalna kuchli funksional qilib ber ozing aytgandek» = the three things
phase 7 deferred). Migration **0067**, all additive: `conditions jsonb`
DEFAULT `[]` (so every rule written before this keeps its meaning),
`stale_days`, two new trigger kinds in the CHECK, and `automation_fires`.
**TIME TRIGGERS** — `lead_stale`/`deal_stale` sweep on a clock, because a
forgotten card produces no event and no event-built trigger could ever reach
it. «Sitting still» is `updated_at` older than N days, deliberately NOT
«entered the stage N days ago» (that needs `audit_log` per card, and the
honest question is «how long since anybody did ANYTHING»). ONE reminder per
SILENCE: `automation_fires` has a unique index on (rule, entity) and the sweep
claims BEFORE it acts, but the claim is an UPSERT re-won when
`fired_at < updated_at` — **which is why no hook anywhere clears anything**,
the record's own timestamp is the fact and every write path already moves it.
Sweep is `20 4-14 * * *` = the Tashkent office day in UTC (a rule can send
Telegram; 04:00 is worse than 09:00), capped `STALE_PER_SWEEP` 200, and there
is deliberately **no prune** — deleting a fire row RE-ARMS its rule.
**CONDITIONS** — `CONDITION_FIELDS` is a curated per-board list and that is
the whole safety (an open field name reads whatever the row carries);
an unknown field is FALSE not skipped, `gt`/`lt` refuse a non-number on either
side, a field the board lacks is ABSENT (absence = «does not apply», null =
«empty»), and a condition on a warehouse-event rule is refused AT THE SAVE.
**PLACEHOLDERS** — `{ism}{kod}{narx}{kub}{kg}{etap}`, the canned-replies
vocabulary extended rather than a second one; unknown left alone, empty value
blanks itself, numbers printed as a person writes them. Both triggers meet in
ONE `applyRuleAction` (the stale path passes `actorId: null` — nobody causes a
silence, and the form hides «whoever did it» for a time trigger);
`ruleNeedsRecord` means the extra query is paid only by rules that filter or
name somebody (#432). **#171's FIFTH appearance and the first where the damage
is silent**: the three condition lists post in parallel and zip by position, so
the valueless row's box is HIDDEN, never `disabled` — red-proven by swapping
one word and reading the rule back as «Сумма больше » with the 500 gone; the
e2e fixture puts the valueless condition FIRST on purpose, because last it
falls off the end where nothing notices. Also found only at 360 px: two selects
side by side clipped «Источни…» then «рав…» → one control per line (#421), and
a greyed value box read as an ordinary empty one → gone rather than dimmed.
Red-proofs ×5 (insert-only claim, no claim at all → 3 red, conditions
unapplied, placeholders unfilled, `hidden`→`disabled`). New: 20 unit + 6
integration + e2e m9v-automation-stale. i18n ×4 (trigger kinds, days, the six
condition operators, seven field names, hints) — the placeholder hint passes
its braces as a runtime VALUE, which sidesteps #520's ICU escape entirely.
1217 unit/integration + 141 e2e on a fresh db in CI's order.

Round 86b — **reklama: hamma platforma** (#620-623 — renumbered on merge,
the other session's round 87 took #616-619 the same day; owner: «reklama ozimizni
qolimizda … tiktok hamma platformalarda berishimiz mumkun … hammasi ozimizni
qolimizda instagram web sayt tiktok youtube hammasi»). Migration **0068**
(`lead_sources.webhook_secret`, the `lead_intakes.channel` CHECK widened to
`webhook`). **THE ANSWER IS MOSTLY NOT CODE:** `/ariza?manba=tiktok` has
worked since round 83 and needs no account, approval or key — it covers
TikTok, YouTube, a website, an Instagram bio, a printed QR. What was missing
was the ADDRESS, so `/crm/kelganlar` grew a directory printing every source's
form link, bot deep link and webhook, each in a `readOnly` input that selects
itself on focus (he pastes these into Google's settings on a phone). Bot name
from the existing cached `getBotUsername()`, not a new env var. **ONE endpoint
for the platforms that post to a URL** — `POST /api/leads/in/<source>`, a
generated secret PER SOURCE, two readers (Google's `user_column_data`, which
is also how a YouTube lead form arrives; and plain `{name,phone,note}` for a
connector or a website). The key is accepted from the BODY as well as a header
because Google's lead form has no way to set one. Meta's rules inherited whole:
404 when the source has no secret and 404 (not 403) on a bad key, never throw
(every platform reads a 500 as «send it again»), one constant answer for every
outcome (#600). **THE LEAK CAUGHT BEFORE SHIPPING:** `ref` stores the sender's
body verbatim and Google puts `google_key` IN it — `refWithoutSecret` drops
key/secret/token case-insensitively, red-proven, then proven over real HTTP.
**Instagram vs Facebook split** was one field: the lead object carries
`platform`, so `fields=…,platform` does what round 83 said needed a second
Graph call; absent stays `meta`. **`funnelReport`'s per-source half had NO
consumer** — computed since the CRM shipped, rendered nowhere, so «which
advert pays» was unanswerable rather than under-answered. Now a block on the
arrivals screen: arrivals (incl. dropped) beside won money (`sum(quoted_amount)`
over WON leads only — a quote on an open lead is a hope, on a lost one a price
somebody refused). Red-proofs ×3 (retired-source door, secret in `ref`,
`timingSafeEqual` length check). 14 unit + 6 integration; `docs/ADS.md` gained
sections 4-6. TEST LESSON: a red proof whose assertion throws before the test's
own restore line leaves CONFIGURATION behind (it deactivated `tiktok` in the
local db) — the restore belongs in `afterAll` (#183, #523's shape). PROBE
LESSON: `psql -tAc` on `UPDATE … RETURNING` prints the command tag too, so the
first curl carried a newline in a header and answered 400. Left as a note, not
fixed: deleting a lead orphans its `crm_activities` (loose `entity_id`, no FK
— #285's shape); the app never hard-deletes a lead, only tests do.
1237 unit/integration + 141 e2e alone; **1244 + 142 merged with round 87**,
both on a fresh db in CI's order.

**Agreed next (owner, 2026-08-01):** the SPEED round — SHIPPED in round 45
above (and continued in round 68 with the phone-side numbers it lacked).

**Agreed next (owner, 2026-07-27):** photos to Drive — ~1–1.5 GB in MinIO,
nothing of it backed up, needs an incremental sync (a full nightly copy fills a
free 15 GB Drive in ten days). **ON HOLD by the owner (2026-07-28: «tohtab
tur»).** His agreed order after that: (5) «mukammal» — phases 4 and 6
SHIPPED (round 16), deal open items SHIPPED (round 17), phase 7 SHIPPED
(round 18), phase 8 SHIPPED (round 19) — **the «mukammal» list is
COMPLETE**. Telegram/CRM queue CLEARED in round 22 (media backfill,
edited messages, excluded-chat purge, listConversations index); left:
Siroj's account (self-served via /suhbatlar/ulash — owner tells him when).

Still queued from the audit: `scripts/import-clients.ts --update` overwriting
corrected data (do NOT run it — blocked on the 17 seller logins).

All numbered phases are shipped (**8** custom entities in round 19 —
deferred inside it: lookup fields at custom entities, Telegram deep links,
per-record chat; **7** automation rules in round 18 — deferred inside it:
time triggers, rule conditions, {placeholders} in texts). Explicitly cut:
formula fields, a visual node editor, an in-app chat, a separate projects
module, an external web form builder. The deal open items (damage discount
form, profit per deal, 50-goods spreadsheet + AI TNVED grouping) shipped in
round 17.

## Owner's outstanding chores

**DONE 2026-08-10:** the VPS move and the deploy — both were the top two on
this list for months, and the whole gap closed in one evening.

**Security, do first — three secrets reached the chat and must be treated as
burned:** the **Telegram bot token** (@BotFather → `/revoke`, new token into
the server `.env`, then `docker compose up -d app`), the **GitHub PAT** he
pasted while cloning (already replaced once during the move; delete the old
one at github.com/settings/tokens if it is still listed), and
`ANTHROPIC_API_KEY`. The GitHub token is stripped from the new server's git
remote already. **The AI round (0079) gives the key a second job**: mint a
NEW key at console.anthropic.com, put it in the server `.env`, and both the
AI assistant and the goods-import/hisoblatish features come alive — until
then every one of them says «sozlanmagan» honestly.

**Then, in order of what it costs him to skip:**

1. **Photos onto a second disk** (`docs/DEPLOY.md`, last section). Round 74
   measured it: the database grows ~0.5 GB a year, photos and call recordings
   tens of GB. They share one disk today, and a full disk stops postgres AND
   kills the backup in the same minute. Do it **before handing out the calls
   APK**, which is what makes recordings arrive in volume.
2. **Switch on the off-site backup** — S3/Contabo Object Storage, four keys in
   `.env`, `docs/BACKUP.md`. Until then the ONLY off-box copy of the business
   is the `gsr2.dump` on his laptop from the move.
3. **`APP_URL=https://gsrwms.uz`** in the server `.env` if it is not there —
   the Mini App button is not offered on anything but public HTTPS (#275).
   Asked in chat, never confirmed.
4. **DONE 2026-08-11: the inbound rota is ON** (he ticked the role checkbox
   in production the day Meta went live). After round 96 deploys, membership
   moves to **Boshqaruv → Arizalar taqsimoti** — migration 0073 carries his
   ticked people across, and the admin should untick THEMSELF there («boyagi
   lead bir admin va sotuvchi roliga tushdi»).
5. **Release both APKs** — driver v1.3 and the first GSR Qo'ng'iroqlar build
   (Actions → its workflow → artifact → its Admin page). The driver fleet is
   still on 1.2 and dies after ~2 h (round 55 fixed it; the fix is unreleased).
6. **Old server: keep for a week, `app` stopped, then take a final dump before
   deleting it.**
7. **DONE 2026-08-11: Instagram/Facebook Lead Ads are LIVE** — page
   subscribed, app published, permanent token. Left in Meta when convenient:
   delete the junk `user`-object webhook subscription and the
   «Greenleaffamily» page's subscription (harmless). The other platforms
   (Google Ads? TikTok? a website form?) still await his answers —
   `/ariza?manba=…` works today with nobody's permission.

**Long-standing, unblocked by the move:** create logins for the 17 sellers,
then re-run `pnpm import-clients --apply --update` · 3 rejected rows · ~19
nameless clients · 2 truncated phones (GS161, GS252) · opening balances ·
confirm person groupings · say which printer model he has.

Deferred access work, still blocked on those logins: scoping clients to their
sales manager (without the logins it hides nearly every client from sales) ·
lead-mutation ownership. (Warehouse scoping as a roles column SHIPPED in round
23; attachment enforce flip SHIPPED in round 30 — `unmapped` stays log-only by
design.)

## How to work here

- Read the surrounding code and match it: comment density, naming, idiom. The
  comments in this codebase say **why**, not what.
- A test that restates the code proves nothing. Extract the predicate and call
  the real function (#166). A test for a fix must be shown to FAIL without it.
- The system is live. Prefer a migration that adds over one that rewrites, and
  never delete a column that holds data in the same release that stops using it.
- Finish the verification loop before saying it works, and say plainly what you
  did not do.
