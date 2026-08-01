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
828 unit/integration + 93 e2e, verified in CI's order on a fresh database.
Latest migration: **0054** (`partners`).

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

**Agreed next (owner, 2026-08-01):** the SPEED round — measure before
guessing. Server is 8 GB, so the pg tuning is innocent. Plan: postgres
`log_min_duration_statement`, per-page render timing, and a navigation
progress indicator (there is none, and a Germany→Uzbekistan round trip
plus SSR means every tap has ~half a second of dead screen).

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

**Deploy the branch** (migrations up to 0052 — back up first; the compose
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
sales) · lead-mutation ownership. (Warehouse scoping as a roles column
SHIPPED in round 23; attachment enforce flip SHIPPED in round 30 —
`unmapped` stays log-only by design.)

## How to work here

- Read the surrounding code and match it: comment density, naming, idiom. The
  comments in this codebase say **why**, not what.
- A test that restates the code proves nothing. Extract the predicate and call
  the real function (#166). A test for a fix must be shown to FAIL without it.
- The system is live. Prefer a migration that adds over one that rewrites, and
  never delete a column that holds data in the same release that stops using it.
- Finish the verification loop before saying it works, and say plainly what you
  did not do.
