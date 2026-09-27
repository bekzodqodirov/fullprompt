# Ish joylari — the navigation by job (2026-09-26/27)

The owner's answers to the UX review (canvas «GSR tizimi — qulaylik xaritasi»):
**1a** eight workspaces · **2c** «Tez-tez» = starred AND noticed · **5** the «+ Yangi»
list as drawn · **7a** every report in one «Hisobotlar» · **8b** settings inside
their own workspace · **9a** start with the menu and «+ Yangi» · **6** phone bars:
warehouse = Bosh, Qabul, Sklad + one recommended; logist = Bosh, Sklad,
Mashinalar + one; VED = Bosh, Hisoblash navbati + two.

The measured problem (canvas board 1): the owner's menu was 36 entries in four
groups ordered by when a screen was built; money work lived in 17 places, «where
is the cargo» in 16, a truck in six pages, and 40+ screens were reachable only
from inside another screen.

This file is what SHIPPED (the design was judged by four adversarial lenses
before and during the build; every confirmed finding is folded in below).

## Rules that do not move

1. **No route moves.** Every URL stays where it is — Telegram messages,
   notifications and `links.ts` carry them. Only the MENU changes.
2. **A menu decision is never an access decision.** Every page keeps its own
   gate. A tab is drawn only for somebody that gate admits (a door that bounces
   is worse than no door), and a tab can never be the way somebody reaches a
   page they could not reach before.
3. **Curation only removes.** `MENU_BY_ROLE` still narrows every curated role.
4. **Law 4 / Q19 money sight stays as it is.** `/finance/reestr` carries
   `sight: 'kassa'`, `/reports/landed-cost` `sight: 'results'`; `/admin/tarif`
   is never offered to `ved.docs`. `/upsale` follows its NAV entry and the PAGE
   decides (`upsaleScopeFor`) — a VED who is also a seller has always been
   admitted to his own upsale there; that is the page's rule, not the menu's.

## The model — `src/modules/platform/rbac/workspaces.ts`

`NAV` stays the flat list of top-level destinations (tiles, relevance, the
phone bar). Beside it, `WORKSPACES`: `{ key, icon, tabs, settings?, strip,
entry?, pages? }`, a tab being `{ href, key, need?, roles?, via?, sight?,
group?, claims? }`.

- A tab that IS a NAV entry is visible exactly when `menuItems` says so, and
  may carry no rule of its own (a second rule would be a second, drifting gate).
- Any other tab hangs off NAV entries (`via`) and is visible only when one of
  them is in the viewer's menu AND `need` (every inner list satisfied, each by
  any one code) AND `roles` AND `!moneyHidden(sight)`. `need` restates a page
  gate that lives in `wms`, because platform must not import wms.
- `entry`: where the workspace's menu row goes (Hisobotlar → `/dashboard`, else
  `/reports`), else its first visible tab.
- `pages`: belongs here, is no tab — the strip shows, nothing is lit, nothing
  counted (`/crm/today`, off every menu by the owner's word in round 75).
- `placementOf(pathname, workspaces)`: the LONGEST segment-boundary prefix over
  every tab, setting, claim and page — `/accounting/pnl` is Hisobotlar,
  `/accounting` is Pul, `/admin/clients/<id>` is Savdo, `/boxes/<id>` is Sklad.
- `BORROWED_ADMIN_PAGES` (every `/admin/*` href a job workspace owns) IS
  `NOT_ADMIN_SECTION` now: no «← Boshqaruv», «Boshqaruv» not lit.

Fences: `tests/unit/workspaces.test.ts` (every NAV entry in exactly one
workspace; every page gate written down and every shipped role + seven invented
combinations walked through it with the REAL wms predicates; the four bars;
placement; the /admin union) and `tests/e2e/m9zz-ish-joylari.desktop.spec.ts`
(logs in as all nine demo people, harvests every link the menu DRAWS, and asks
the server for each — a redirect fails it; a control proves it can see one).

## The eight workspaces (+ Boshqaruv)

| Workspace | Tabs (in order) | ⚙ |
|---|---|---|
| **Bosh sahifa** | `/` (no strip) | — |
| **Mening kunim** | `/bugun`, `/kalendar`, `/approvals`, `/zametkalar`, `/ai` | — |
| **Sklad** | `/stock` (+ claims `/boxes`), `/receive`, `/receipts`, `/unclaimed`, `/issue`, `/crates`, `/inventory` | — |
| **Yo'l va partiyalar** | `/batches`, `/plans`, `/trucks`, `/map`, `/zavod`, `/arrivals` | `/zavod/zavodlar`, `/admin/trucks` |
| **Mijozlar va savdo** | `/bitimlar`, `/crm`, `/admin/clients`, `/suhbatlar`, `/my-clients`, `/crm/dormant`, `/crm/kelganlar`, `/crm/people`, `/admin/xabarlar` (super_admin ROLE) · page `/crm/today` | `/crm/settings`, `/bitimlar/etaplar`, `/suhbatlar/shablonlar`, `/suhbatlar/ulash`, `/admin/taqsimot` |
| **Hisoblash (VED)** | `/hisoblash`, `/hisoblash/tarix`, `/hisoblash/narxlar` | `/hisoblash/lugatlar`, `/admin/tarif`, `/admin/bojxona-import` |
| **Pul** | `/accounting`, `/accounting/expenses`, `/finance`, `/kontragentlar`, `/accounting/accounts`, `/accounting/xarajat-kassa`, `/admin/fx`, `/finance/narxsiz`, `/finance/reestr`, `/upsale` | `/accounting/categories`, `/admin/cost-types`, `/admin/partner-types` |
| **Hisobotlar** (grouped) | Biznes: `/dashboard` · Moliya: pnl, cashflow, balance, receivables, profit, kurs-farqi, reja, `/reports/landed-cost` · Savdo: `/crm/tahlil`, `/reports/sotuvchilar`, `/pipeline`, `/reports/client-history` · Yuk: `/reports`, stock-aging, batches, receipts-journal, unclaimed, yuk-xavfi, `/transit` (via `/trucks`/`/reports`, so a packer gains no workspace) · Xodimlar: vazifalar, staff-activity, label-prints · VED: `/hisoblash/nazorat` | — |
| **Boshqaruv** | `/admin` hub: warehouses, users, settings, roles, fields, driver-app, calls-app, rules, audit, anulirovka, notifications (no strip — the hub is its navigation) | — |

Also changed with it: the hub lost the eight doors that moved; NAV `/admin` is
the union of the doors that remain (pinned), so the accountant and the logist —
whose only doors moved — are no longer offered an `/admin` that sends them home;
`admin/layout.tsx` admits `plans.manage` and `admin.settings.manage` (a role the
owner invents with only those is offered the page by its workspace);
NAV `/kontragentlar` asks the page's own `seesAllMoney` grants (the fence found
it offering the seller's `finance.view` a page that bounced).

## The shell

- **Sidebar** (desktop): «Tez-tez» (only when non-empty) · «Ish joylari» · a
  divider · «Boshqaruv». The workspace row is lit with `aria-current="true"`;
  the page's own tab carries `"page"` (m9p counts exactly one). Labels wrap
  instead of truncating.
- **Strip** (`ws-tabs`, `components/ui/ws-tabs.tsx`), rendered ONCE by the
  layout. Not drawn on the home, on Boshqaruv, in focus modes, or in a
  workspace that offers this person one page. On a PHONE only on a workspace's
  list page (a card, a thread and the two boards own the phone); from `md` on
  every page, and what does not fit folds into «Yana ▾» with the lit page kept
  in view. Hisobotlar's groups are a `<select>` that switches the row in place
  (no navigation, no visit). ⚙ at the end lists the settings. It costs
  `--ws-strip` (41 px), which the desktop board and the chat thread pay.
- **••• sheet**: «Tez-tez» (minus what is already on the bar) · the workspaces
  as 44 px cards · the pages of the workspace this screen belongs to as chips.
- **Home tiles**: the NAV entries grouped by workspace (`homeTileGroups`), the
  Bitimlar/CRM pair still at index 0 of its group.

## «Tez-tez» (2c) — migration 0111 `nav_usage`

`(user_id, href)` PK, `starred`, `starred_at`, `score`, `last_at`.
- **Noticed**: the strip posts `/api/nav/visit {href}` (keepalive, from an
  effect — a prefetch never counts) for the active TAB; the route re-derives the
  offered set and refuses anything else with a constant 204. Score decays in
  SQL with a 14-day half-life. At most **3** noticed rows, only pages at
  **≥ 2.5** (≈ three recent visits), drawn in the MENU's order, not the score's.
- **Stars**: ☆ on the strip (never on a workspace's own first page), at most
  **8**, kept in the order given; unstarring is an UPDATE (a forged href mints
  nothing).
- The block is always the intersection with what the menu offers this render.
- `NAV_AUTO=off` under Playwright: one worker drives the same demo accounts
  through every spec, and a menu that learns from the previous spec is state
  left for the next (#183). The automatic half is proven in
  `tests/integration/nav-usage.integration.test.ts` with users of its own.

## «+ Yangi» (5)

The two inline kinds stay first (the panel still opens on the lead's name box —
round 60 — and every `quick-*` testid is unchanged); below them the doors, each
offered only where its destination is in the menu AND its screen lets the
person write: Prixod → `/receive`; Bitim → `/bitimlar/new`; To'lov
(`finance.manage`) → search a client → `/finance/<id>`; Xarajat →
`/accounting/expenses#yangi-xarajat`; Hisoblatish (`crm.leads` |
`clients.manage` — asking is the seller's move) → search a lead or deal →
`<card>?yangi=hisob#hisoblatish` (the calc panel opens); Vazifa →
`/bugun?yangi=vazifa#yangi-vazifa`. The pickers use the global search, whose
answer is already scoped to the person.

**2026-09-27, QR-siz round (his Q9 b):** the logist's menu gained `/receive` —
he enters a prixod FROM THE OFFICE off the floor's photos, naming who
physically received it and the real day (up to seven days back). So «Prixod»
is in his «+ Yangi» too. Only that screen: the crate list stays out (a pallet
is made from the prixod card or the stock row) and his phone bar is unchanged.

## Phone bars (6)

| Role | Bar |
|---|---|
| warehouse_operator / manager | `/`, `/receive`, `/stock`, `/batches` — at a warehouse that `issues_to_clients` (Tashkent, Andijan): `/`, `/receive`, `/stock`, `/issue` |
| logist | `/`, `/stock`, `/trucks`, `/plans` (unchanged when `/receive` joined his menu — see below) |
| ved_manager | `/`, `/hisoblash`, `/batches`, `/bitimlar` (his home's two rows; the chats are the header's 💬) |
| others | unchanged |
