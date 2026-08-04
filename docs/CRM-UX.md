# The Frappe-CRM study and the UX programme

> Owner's ask (2026-08-04): «frappe crm bor shuni organib chiq … men
> hohlayotgan narsa bizning fullprompt repodagi proektimizda frappe-crm dek
> imkoniyatlar shu ishlatish oson UI da bolishini hohlayman» — and, to the
> strategy that answered it: «xop hammasiga roziman … toliq strategiya tuzib
> ol keyin nimani qanday qilishingni menga ayt va tasdiq ol».
>
> **Status: strategy approved by the owner. THREE open questions below still
> await his answers. NO code has been written for this programme yet.**
> A new session picks up at Batch 1 — or wherever CLAUDE.md's State says the
> programme has reached since.

## The verdict, in one paragraph

Frappe CRM is NOT installed and will not be. The studied tree
(`/home/user/frappe-crm` in this workspace: branch `develop` @ `66899bc`,
2025-01-06, `2.0.0-dev`) wants its own stack — Frappe framework v15 on
Python, MariaDB (Postgres unsupported in practice), three Redis roles, a
Node socketio process, gunicorn web workers, background workers and a
scheduler: 8–11 processes and ~1.5–2 GB RSS beside our Next.js + Postgres
on the same VPS. It ships ZERO translation files (English UI; ru/uz/zh
would be a manual translation project). Its permissions are FLAT — every
Sales User reads/edits/deletes every lead and deal; no `if_owner` rows,
`permission_query_conditions` commented out in `hooks.py`. It has none of
our Telegram / warehouse / money spine. **Its license is AGPL-3.0**
(`LICENSE`, `crm/hooks.py: app_license`): we take IDEAS from that repo and
NEVER copy code, markup or CSS out of it into this one. What it does have —
and what this programme ports natively — is a best-in-class ease-of-use
layer: the views engine, inline editing, quick entry, bulk actions, and a
pile of polish.

## What the study established

Three independent inventories (backend data model, frontend UX, docs/stack)
over the whole tree, evidence-backed. The facts that shaped the plan:

**Where fullprompt is already AHEAD — no work needed, and worth telling the
owner when the comparison comes up:**

- Deal money: Frappe's CRM Deal has **no amount field** (only the
  organization's `annual_revenue`); no products, quotes, discounts or
  profit — all delegated to ERPNext. Ours: quoted amount, discount with
  mandatory reason, per-deal profit, debt gate.
- Lost reason: no doctype, no field anywhere in Frappe CRM. Ours is
  mandatory on both leads and deals.
- Custom fields: Frappe CRM consumes them but has **no creator in its UI**
  (Desk only). Ours are edited in the app by the owner.
- Custom entities, automation rules: absent in Frappe CRM (rules exist only
  as a framework doctype reachable from Desk). Ours shipped (phases 7–8).
- Cargo-driven funnel (`deal_stages.cargo_trigger`): nothing comparable.
- Communication: their email + external-app WhatsApp + Twilio vs our deeper
  Telegram (cabinet Mini App, staff bot, AI intake, chat-in-CRM).
- SLA honesty: their SLA clock stops on a MANUAL `communication_status`
  change (self-reported by the agent); our unanswered-chat reminder measures
  real Telegram traffic.
- Reports: their `Dashboard.vue` is an empty stub; no server-side analytics.
- Privacy: our per-manager chat scoping, warehouse scoping, role gates.
- Locales: ours 4, theirs 0. AI: ours real, theirs none.

**Where Frappe CRM is ahead — the gap this programme closes** (each item
verified absent here; see the inventory table below):

1. ONE views engine reused by every list: an always-visible quick-filter
   row, a filter-by-any-field builder (operator + typed value control),
   click-a-cell-to-filter, multi-level sort on any column, column
   add/remove/reorder/rename/drag-resize, group-by.
2. Saved views: tweaks silently persist as your personal default view;
   named views, private/public/pinned, duplicate; pinned views as sidebar
   shortcuts.
3. Bulk actions: checkbox select → bulk edit / assign / delete / convert;
   plus export of the CURRENT view (columns + filters + sort) to XLSX/CSV.
4. Quick entry: create modals reachable everywhere (list header, kanban
   column «+» prefilled with that column's stage).
5. True inline editing on the record page: side-panel fields look like text,
   autosave on click-edit; the layouts themselves are drag-editable in-app.
6. Kanban: card + column drag-and-drop, per-column colour, card-field
   customization, per-column counts and per-column Load More, engagement
   counters (emails/notes/tasks/comments) on cards.
7. Dark mode via semantic tokens (`data-theme` flip on `<html>`).
8. Email templates with Jinja placeholders → maps to Telegram canned
   replies for us.
9. Polish: relative time + absolute-date tooltip everywhere, avatar stacks,
   a favorites/like column, composer drafts surviving reload, per-tab empty
   states with a CTA, one consistent «Not Saved» dirty badge.

**Frappe weaknesses we will not import:** no global search / command
palette (ours will exceed it), no onboarding, SLA elapsed-time loops
per-second in Python, `scheduler_events` fully commented out (their invite
expiry is dead code), PostHog telemetry on by default.

## Verified inventory (2026-08-04) — what exists here already

| Fact | Where |
|---|---|
| Global search EXISTS: client code/name, box short code, receipt no, product zh/ru, combined `gs777-a` | `src/app/(protected)/search/page.tsx`, linked from `(protected)/layout.tsx` app bar. MISSING: leads, deals, batches, kontragent, phone-number lookup, Ctrl+K palette |
| Stage colours EXIST, user-editable, 7-colour fixed palette | `crm/stage-color.ts` (`STAGE_CLASS`), `lead_stages.color` / `deal_stages.color` + DB CHECK, pickers in `crm/settings/forms.tsx` and `bitimlar/etaplar/stage-form.tsx` |
| Kanban deliberately refuses drag today | `components/kanban.tsx` (`draggable={false}` + `onDragStart` preventDefault); owner refused TOUCH drag twice (round 14). Batch 4 adds POINTER-FINE-ONLY DnD; move buttons stay |
| `leads.ownerId` AND `deals.ownerId` exist, indexed | `platform/db/schema/wms.ts` — bulk-assign has its columns |
| `lost_reason` on leads AND deals, mandatory via UI | schema + stage movers |
| XLSX builder + route pattern to extend | `wms/accounting/xlsx.ts`, `/api/clients/xlsx`, `/api/accounting/[kind]` |
| Custom-field columns/filters on lists (phase 2) | `/admin/clients`, `/o` lists |
| Composers unified (the place a template picker plugs in) | `components/composer.ts` (round 14) |
| **Dark mode EXISTS and is complete** — `data-theme` on `:root` over CSS-variable tokens, cookie-read on the server so the first HTML is already themed (no flash), system preference when no cookie, sun/moon toggle in the app bar, and every `(print)` route pinned light on purpose | `src/app/globals.css` (`:root[data-theme='dark']` + `prefers-color-scheme` block), `platform/theme/theme.ts` + `actions.ts`, `components/ui/theme-toggle.tsx`, `(protected)/layout.tsx`, `(print)/print.css` |
| Column sort primitive EXISTS: `SortTh` (URL `?sort=&dir=`, preserves other params) + in-memory `sortRows` with an allow-list; used on clients, `/o`, `/stock` and four reports | `src/components/sort-th.tsx` and its callers |
| ABSENT, verified by grep: saved views, per-user column choice, quick-filter rows on most lists, bulk/multi-select actions, quick-create modals (only full-page `new` routes), inline click-to-edit, Telegram canned replies, kanban board filters. In-app bell and email are ABSENT BY DECISION (Telegram-only, #375 / round 25) | — |

## The programme — five batches, in order

Every batch is independently shippable and independently deployable.
Sizes are honest guesses in this codebase's «rounds».

### Batch 1 — Lists — **PART 1 SHIPPED (round 57)**

Shipped: the engine (`platform/lists/` — `columns.ts`, `query.ts`,
`service.ts`, `actions.ts`; `components/list/view-bar.tsx` +
`column-picker.tsx`; migration 0058) on `/admin/clients` (views + column
picker + view-aware XLSX), `/stock` (same) and `/o/<code>` (views only).
**Still to do in part 2:** `/arrivals` (has no searchParams at all today) and
`/batches` (a board — needs a table view beside it, not instead of it), then
`/kontragentlar` and the finance registers. Quick-filter ROWS beyond what each
screen already has are part 2 as well.

The original scope, for reference:

Owner-visible: quick-filter row (hodim / etap / sklad / date range as fits
each list) · sort by any column header · column chooser incl. custom
fields · personal saved views (named; pinned; PUBLIC gated per Q1) ·
«Excel» button exporting the CURRENT view — exactly the visible filters +
columns.

**CHANGED IN ROUND 57, deliberately: the last list state does NOT
auto-persist.** Frappe silently saves an unnamed default view on every
tweak; here you press ★ on a saved view instead. Two reasons, both
practical: a silent write on every list PAGE VIEW makes reading a list a
database write, and an implicitly stored filter is state one e2e spec
leaves for the next (#154/#183 — this suite runs one worker over one
database, and the redirect would follow the seeded user across specs).
One deliberate press buys predictability; the owner was told.

Scope v1: `/admin/clients`, `/arrivals`, `/batches`, `/stock`; then the
same shared engine spreads to `/o` lists, `/kontragentlar`, finance
registers. One engine, many doors — do not fork per screen.

Anchors: new table for saved views (next free migration — 0058 as of this
writing; check `meta/_journal.json`). Filters/sort/columns ride the URL
(shareable), a saved view is a named bundle of them. Export extends the
existing xlsx route pattern and carries the viewer's rbac scope — NEVER a
raw table dump: money columns only under `finance.view`, warehouse scope
applies (`rbac/scope.ts`).

Guardrails: a PUBLIC saved view is CONFIGURATION in e2e terms (#183) — any
spec that creates one deletes it; screenshot pass at 360×800 (the filter
row is exactly the kind of thing that rescales a phone page, #400).

### Batch 2 — Speed — **(a) SHIPPED (round 58); (b) and (c) next**

Shipped in (a): `wms/search/{query,service}.ts` (pure parse + one scoped
service), `/api/search`, `components/search-palette.tsx` (⌘K + the app-bar
icon), `/search` rewritten onto the same function. The scoping the old page
never had is the load-bearing part — see DECISIONS #492.

Still to build: **(b) quick-create modals** and **(c) bulk actions**. Notes
gathered while reading, so the next session does not re-learn them: three of
the four create forms REDIRECT on success (`createLeadAction`,
`createDealAction`, `createClientAction`) which is wrong for "create and
stay" — only the task form is already modal-ready; all four are uncontrolled
`defaultValue` forms, so a refusal inside a modal blanks what was typed
unless they are made controlled (#377/#419/#466). Leads and deals live on
KANBAN boards, not lists — bulk selection lands on the cards
(`cardTestId` `lead-card` / `deal-card`), and `crates/new/crate-builder.tsx`
is the existing multi-select pattern to copy. A bulk stage move must be ONE
`run(...)` wrapping a loop over `moveLead`/`moveDeal` (one authorize, one
revalidate, one event kick), never a bare UPDATE.

The original scope of (a): extend `/search` with leads (name/phone), deals (code/title),
batches (code), kontragent, and phone-number → client; add a Ctrl+K
overlay (desktop) and the app-bar icon opening the same thing (mobile),
debounced live results. THE RULE (round 36, the bot's law): search returns
only what the actor already may see — reuse the `inScope` discipline of
`wms/bot/lookup.ts`; balance/money lines only under `finance.view`.

(b) Quick-create: app-bar «+» → modal for new lead / deal / task / client,
permission-filtered; kanban column «+» prefilled with that stage. Reuse
the existing form components inside a dialog; a refused save must hold its
inputs (#377/#419/#466 — the house rule; React form Actions reset fields).

(c) Bulk actions: leads (assign owner · move stage · mark lost WITH
mandatory reason per Q2), deals (move stage), tasks (complete/reassign),
export selection. Stage moves go through `moveLead`/`moveDeal` one by one
so audit + `LeadStageChanged`/`DealStageChanged` + phase-7 rules fire
(round 26: EVERY stage write path emits) — never a bare UPDATE.

### Batch 3 — Card ease (~1–2 rounds)

Inline click-to-edit on the facts rails of client/lead/deal cards: click a
field → in-place control → autosave on blur/Enter → toast; a refusal
renders the reason AND keeps the typed value. Permissions and audit
exactly as today's forms. Lenta polish: consecutive field-change rows
collapse («+N o'zgarish», expandable); relative time + absolute tooltip.

### Batch 4 — Kanban (~1 round)

Desktop-only card DnD via `(pointer: fine)` (the `components/composer.ts`
detection pattern); touch keeps the move buttons — the owner refused touch
drag twice and chose this split explicitly. Optimistic move, revert +
reason on refusal; writes through `moveLead`/`moveDeal`. Card-field config
(summa, kub, hodim, 💬 badge) per user. Board quick filters (hodim +
text). Column colours already exist — do not rebuild them.

### Batch 5 — Polish (~1 round)

**Dark mode is NOT in this batch — it already shipped** (see the inventory
table). Telegram canned replies: shared (admin-managed) +
personal (per Q3), `{ism}` / `{kod}` placeholders filled from the thread's
client, a picker button in ALL composers (they are already unified).
Empty states with a CTA; composer drafts to localStorage; a favorites
star on clients/deals (sorts them first); a funnel-velocity report —
time-in-stage read from `audit_log` (the data is already being written).

## Cross-cutting rules (every batch)

- The system is LIVE: additive migrations only; each batch deployable alone.
- Every new string ×4 locales (ru / uz / zh-CN / en) — the i18n-keys
  tripwire enforces it.
- Every new screen/control is screenshot-verified at 360×800 logged in AS
  the relevant role (rounds 42/43/46 discipline).
- rbac everywhere: search results, exports, bulk targets and quick-create
  options are filtered by the actor's scope, and each guard is red-proven
  (#166 — strip the guard by string edit, watch the test go red, never
  `git checkout` to restore).
- New colours = literal Tailwind classes in a lookup map (the `STAGE_CLASS`
  pattern) — runtime-built class names do not compile.
- e2e: state a spec leaves behind is the next spec's input (#154);
  configuration (a public view, a shared template, a favorite) is worse
  than data (#183).
- The Frappe repo is a reference for BEHAVIOUR only. Never copy code,
  markup or CSS out of it (AGPL). When in doubt: describe the behaviour in
  words, close the file, implement.

## The three questions — ANSWERED 2026-08-04 («tavsiyalaring bo'yicha boshla»)

The owner accepted all three recommendations, so these are now spec:

1. **Publishing a saved view to everyone is admin-only.** Anyone may save
   and pin their own; making one visible to the whole company needs
   `admin.settings.manage` (no new permission — #170's rule).
2. **Bulk «mark lost» exists for leads**, with ONE reason typed for the
   whole selection and written onto every row (a lost without a reason is
   refused, as the single-row path already refuses it).
3. **Canned replies come in two kinds**: shared (admin-managed, everyone
   sees them) and personal (each manager's own, nobody else's).

## Out of scope — stated to the owner and accepted

Installing Frappe CRM itself; email integration; Twilio/telephony;
WhatsApp; the ERPNext bridge; an in-app notification bell (Telegram stays —
his round-25 decision); onboarding tours. Revisitable only on his word.
