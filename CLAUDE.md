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
- **A disabled checkbox posts nothing**, so on a replace-all form it reads as
  "remove". Re-post locked values as hidden inputs (#171).
- Migrations are hand-written SQL + an entry in `meta/_journal.json`. Drizzle
  wraps **all pending migrations in one transaction**, so `CREATE INDEX
  CONCURRENTLY` is impossible and a failure rolls everything back.

## Where the truth lives

| Question | File |
|---|---|
| Why is it built this way? | `DECISIONS.md` — 288 numbered entries, newest last |
| What shipped and when? | `CHANGELOG.md` — newest first, written in Uzbek for the owner |
| What is a deal? | `docs/DEALS.md` — the agreed spec, not yet built |
| Roadmap / status | `docs/PLAN.md` |
| Deployment | `docs/DEPLOY.md` |

## State — 2026-07-27

Branch `claude/gsr-logistics-wms-phase1-o8h4en`, PR #1, CI green.
473 unit/integration + 63 e2e, verified in CI's order on a fresh database.

Phases **0/1/2/3/5** shipped (roles, custom fields, tasks+calendar, deals),
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
  the plan goes with the batch, the driver's phone is revoked.

**Agreed next (owner, 2026-07-27):** photos to Drive — ~1–1.5 GB in MinIO,
nothing of it backed up, needs an incremental sync (a full nightly copy fills a
free 15 GB Drive in ten days).

Explicitly parked by the owner: crate loading is not to be touched further.

Still queued from the audit: `scripts/import-clients.ts --update` overwriting
corrected data (do NOT run it), voided costs counted in the P&L, customs
documents emptying during unload, receipt void with no state guard, checkbox
custom field always saving "no", payments not assignable to a cash box,
handover act truncating at 33 boxes, `/pipeline` with no permission check,
`/api/health` claiming to check MinIO and pg-boss while running only
`select 1`, Postgres on stock defaults.

Later phases: **4** comments with @mentions → **6** approval for issuing to a
debtor → **7** automation rules → **8** custom entities. Explicitly cut:
formula fields, a visual node editor, an in-app chat, a separate projects
module, an external web form builder. Open inside deals: the damage discount
form, profit per deal, the 50-goods spreadsheet + TNVED grouping.

## Owner's outstanding chores

**Deploy the branch** (migrations 0032 and 0033 — back up first) · set
**`APP_URL=https://gsrwms.uz`** in the server `.env` (the Mini App button is not
offered on anything but public HTTPS, #275) · **revoke the bot token he pasted
in chat** and rotate `ANTHROPIC_API_KEY` · merge
PR #1 · **switch on the Drive backup** (`docs/BACKUP.md`, ~15 min — publish the
app BEFORE minting the token or it dies after 7 days) · create logins for the
17 sellers then re-run `pnpm import-clients --apply --update` · 3 rejected rows ·
~19 nameless clients · 2 truncated phones (GS161, GS252) · opening balances ·
confirm person groupings · `pnpm demo-users --disable` ·
say which printer model he has.

Deferred access work, blocked on the chores above: scoping clients to their
sales manager (needs the 17 logins first, or it hides nearly every client from
sales) · warehouse scoping as a `roles` COLUMN rather than two hard-coded role
names, so an invented warehouse role is not born unscoped · attachment
authorization (log-only mode first) · lead-mutation ownership.

## How to work here

- Read the surrounding code and match it: comment density, naming, idiom. The
  comments in this codebase say **why**, not what.
- A test that restates the code proves nothing. Extract the predicate and call
  the real function (#166). A test for a fix must be shown to FAIL without it.
- The system is live. Prefer a migration that adds over one that rewrites, and
  never delete a column that holds data in the same release that stops using it.
- Finish the verification loop before saying it works, and say plainly what you
  did not do.
