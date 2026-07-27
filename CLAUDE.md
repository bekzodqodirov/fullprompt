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
pnpm lint && pnpm test  # 380 tests
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
- **A disabled checkbox posts nothing**, so on a replace-all form it reads as
  "remove". Re-post locked values as hidden inputs (#171).
- Migrations are hand-written SQL + an entry in `meta/_journal.json`. Drizzle
  wraps **all pending migrations in one transaction**, so `CREATE INDEX
  CONCURRENTLY` is impossible and a failure rolls everything back.

## Where the truth lives

| Question | File |
|---|---|
| Why is it built this way? | `DECISIONS.md` — 183 numbered entries, newest last |
| What shipped and when? | `CHANGELOG.md` — newest first, written in Uzbek for the owner |
| What is a deal? | `docs/DEALS.md` — the agreed spec, not yet built |
| Roadmap / status | `docs/PLAN.md` |
| Deployment | `docs/DEPLOY.md` |

## State — 2026-07-26

Branch `claude/gsr-logistics-wms-phase1-o8h4en`, PR #1, CI green.
**Nothing after M6 has been deployed yet** — phases 0/1/2 are on the branch
waiting for the owner to `git pull` + migrate.

Done in this round:
- **Phase 0** — six live defects repaired (settings page crash, CRM digests
  sending garbage, one bad Telegram chat stalling the queue, a warehouse-scope
  permission hole, `getActor` memoised, custom fields half-saving).
- **Phase 1** — `/admin/roles`: grants are editable data with guardrails (you
  cannot edit the role you hold, cannot grant what you do not hold, cannot
  remove the last person who can manage roles). Migration 0026.
- **Phase 2** — custom fields on every object, filter/sort/XLSX, money + lookup
  + file types, validation rules, conditional visibility. Migration 0027.
  `/admin/fields`.

Phase **3** (tasks + calendar) shipped, followed by an access/clutter pass:
`MENU_BY_ROLE` in `rbac/nav.ts` (what a job NEEDS, distinct from what it may
open — #194), `rbac/scope.ts` (the warehouse filter, #199), per-page admin
guards (#198), card-level scoping (#200) and `canActOnTask` (#201).

Phase **5 (deals / bitim)** shipped: migrations 0030-0031, `wms/deals/**`,
`/bitimlar`, price control from `confirmReceipt`, deferral wired into the
handover gate (#203-#215). Still open inside it: the damage discount form,
profit per deal, the 50-goods spreadsheet + TNVED grouping.

A full 14-subsystem audit ran on 2026-07-26 (30 defects confirmed after
adversarial review, 4 refuted). Its findings are the work queue. The client-area four are DONE (#216-220:
the owner dropdown, the client-book guard, phone search, the honest cap).
Still open, in order: `scripts/import-clients.ts --update` overwriting
corrected data (do NOT run it), `JOB_SEND_TELEGRAM` never scheduled so every
digest waits, voided costs still counted in the P&L, customs documents
emptying during unload, and receipt void with no state guard.

Next, in order: **4** record comments with @mentions →
**6** approval for issuing to a debtor →
**7** automation rules → **8** custom entities.
Explicitly cut: formula fields, a visual node editor, an in-app chat, a
separate projects module, an external web form builder.

## Owner's outstanding chores

Deploy 0/1/2 · merge PR #1 · create logins for the 17 sellers then re-run
`pnpm import-clients --apply --update` · 3 rejected rows · ~19 nameless clients ·
2 truncated phones (GS161, GS252) · opening balances · confirm person groupings ·
`pnpm demo-users --disable` · `ANTHROPIC_API_KEY` on the server.

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
