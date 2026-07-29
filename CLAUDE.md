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
| Why is it built this way? | `DECISIONS.md` — 301 numbered entries, newest last |
| What shipped and when? | `CHANGELOG.md` — newest first, written in Uzbek for the owner |
| What is a deal? | `docs/DEALS.md` — the agreed spec, not yet built |
| Roadmap / status | `docs/PLAN.md` |
| Deployment | `docs/DEPLOY.md` |
| Client chat into the CRM | `docs/TELEGRAM-CRM.md` |

## State — 2026-07-29

Branch `claude/gsr-logistics-wms-phase1-o8h4en`, PR #1, CI green.
747 unit/integration + 89 e2e, verified in CI's order on a fresh database.
Latest migration: **0046** (`automation_rules`).

Phases **0/1/2/3/4/5/6/7** shipped (roles, custom fields, tasks+calendar, deals),
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

**Agreed next (owner, 2026-07-27):** photos to Drive — ~1–1.5 GB in MinIO,
nothing of it backed up, needs an incremental sync (a full nightly copy fills a
free 15 GB Drive in ten days). **ON HOLD by the owner (2026-07-28: «tohtab
tur»).** His agreed order after that: (5) — phases 4 and 6 SHIPPED (round
16), deal open items SHIPPED (round 17), phase 7 SHIPPED (round 18);
remaining: phase 8 — «mukammal». Telegram/CRM still queued: tg-import media backfill,
edited-message updates, deleting excluded chats' old rows,
`listConversations` index, Siroj's account (owner decides when).

Explicitly parked by the owner: crate loading is not to be touched further.

Still queued from the audit: `scripts/import-clients.ts --update` overwriting
corrected data (do NOT run it — blocked on the 17 seller logins).

Later phases: **8** custom entities (**7** automation rules shipped in
round 18 — deferred inside it: time triggers, rule conditions,
{placeholders} in texts). Explicitly cut:
formula fields, a visual node editor, an in-app chat, a separate projects
module, an external web form builder. The deal open items (damage discount
form, profit per deal, 50-goods spreadsheet + AI TNVED grouping) shipped in
round 17.

## Owner's outstanding chores

**Deploy the branch** (migrations up to 0046 — back up first; the compose
change recreates the postgres container, ~5-15 s outage: off-hours, run
`free -h` first and halve the tuned values on a 2 GB box) · set
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
