# CHANGELOG

## CRM: leads, the funnel and one place for every conversation (Phase 2.3) — 2026-07-25

Endi CRM ishlaydi — quyida qayerda nima qilishingiz yozilgan.

**📞 CRM (bosh sahifadan)** — ertalab ochasiz: bugun kimga qo'ng'iroq qilish kerak, leadlar va mijozlar bitta ro'yxatda, kechikkanlari sariq chiziq bilan.

**🎯 Voronka** (`/crm/leads`) — amoCRM kabi ustunlar: Yangi → Bog'lanildi → Ma'lumot olindi → Hisoblanilyapti → Narx aytildi → Javob kutilyapti → Sotuv / Yo'qotildi. Har ustunda kartochkalar, pastda esa qaysi manba haqiqiy mijoz berayotgani.

**Lead kartasi** — bosqichni bitta bosishda ko'chirasiz (yo'qotilganda sabab so'raydi), qo'ng'iroqni yozasiz va o'sha zahoti keyingi sanani qo'yasiz, «Mijozga aylantirish» tugmasi kod berib mijoz kartasini ochadi. Lead «Sotuv» ga o'tishi bilan aylantirish paneli o'zi ochiladi.

**😴 Uxlab qolgan mijozlar** — ilgari yuk yuborib, keyin to'xtaganlar. Kunini o'zgartirasiz (60 kun standart).

**👥 Odamlar** — bitta odamning bir nechta kodi (GS777 + GS102). Telefoni bir xil kodlarni sistema o'zi topib taklif qiladi, siz tasdiqlaysiz. Kodlar birlashtirilmaydi — har biri o'z harflari, yuklari va kabineti bilan qoladi.

**⚙️ CRM sozlamalari** — bu yerda CRM sizniki bo'ladi: bosqich qo'shasiz/o'chirasiz/rangini va tartibini o'zgartirasiz, manbalar ro'yxatini yuritasiz, va **o'z maydonlaringizni** qo'shasiz (matn, raqam, sana, tanlov, ko'p tanlov, belgi, telefon, havola) — lead kartasiga ham, mijoz kartasiga ham.

**Mijoz kartasida** — qo'ng'iroqlar tarixi, o'zingiz qo'shgan maydonlar va shu odamning boshqa kodlari.

**Telegram** — har kuni 08:30 «bugun kimga qo'ng'iroq», har dushanba 09:00 uxlab qolganlar. Har kimga o'zinikini: sotuv menejeriga o'z mijozlari, sizga hammasi.

Sotuv menejeri o'z leadlarini yuritadi, lekin voronkani hamma uchun o'zgartira olmaydi — buni e2e test tekshiradi.

Migratsiyalar 0021–0022, 213 test + 16 e2e yashil.


## Management accounting: P&L, cash flow, receivables, profit per batch (Phase 2.4) — 2026-07-25

The money side is now closed: the cargo costs were already in the system, what was missing was everything around them.

**What you can now do**
- **Expense book** (`/accounting/expenses`) — rent, salaries, phone bills, anything. Kind, amount in any currency, date, and optionally which warehouse, which employee and which cash box it was paid from. Nothing is deleted: a mistake is voided with a reason, exactly like the client ledger.
- **Fixed costs as templates** — enter the rent and each salary once, then press "post this month's fixed costs" and review what landed. Deliberately a button, not an automatic job: a silent monthly insert would quietly falsify the P&L of any month where the rent changed or someone left. Pressing it twice cannot double-charge.
- **Expense kinds are yours** (`/accounting/categories`) — nothing hard-coded, as you asked. 13 starter kinds are seeded and you edit the list yourself. One flag matters: untick "Cash" for something that never moves money (depreciation) and it enters the P&L but stays out of the cash flow.
- **Cash boxes and accounts** (`/accounting/accounts`) — your five: China (USD), Uzbekistan cash USD, cash soʻm, card soʻm, company account soʻm. Opening balances entered, so a balance on screen matches what is actually in the box. Moving money between your own accounts is a transfer with two amounts (a CNY box can fund a USD account) and is never counted as income or spending.

**The reports, each downloadable as XLSX**
- **P&L** — one column per month: revenue, cargo costs by type, gross profit with margin, overheads by kind, net profit. Totals also shown in soʻm at today's rate.
- **Cash flow (ДДС)** — money that actually moved, plus what sits in each account right now.
- **Receivables by age** — 0–30 / 31–60 / 61–90 / 90+ days, where a payment settles the OLDEST charge first, so a client who pays every month never appears in the 90+ column just because they have been a client for a year.
- **Profit by batch / client / route** — the report that answers "did that trip earn money?". Unlike the monthly P&L, both sides belong to the batch whatever month they were entered, so a price agreed after the costs were booked does not distort it. The P&L page says so on the page itself.

**Who sees it**: owner and accountant only. A sales manager keeps client balances and cannot reach the company's margin — checked on the pages and on the download links, and an e2e test now holds that line.

**Caught in verification**: the per-batch profit report was returning zeros. Drizzle renders a column name unqualified in a single-table select, so a bare `id` inside the report's correlated subqueries bound to the *subquery's* table instead of the batch — revenue and cost silently came back as 0 and the box count died outright on a type mismatch. Fixed by qualifying every correlated reference, and a test now pins each column of a real batch (2 boxes, 50 kg, $1000 revenue, $400 cost, $600 profit, 60% margin).

- Tax is out of scope on purpose — the accountant runs that separately, so there is no tax line in the P&L.
- Migration 0020, 187 unit/integration + 14 e2e green on a fresh build and a fresh database.


## Telegram messages in each person's own language (part 3 of 3) — 2026-07-25

- **Staff Telegram notifications now follow the recipient**, not a fixed Russian channel language. Every event (receipt confirmed, unidentified cargo, plan approved / changes requested, off-plan load, undocumented transfer, missing in transit, stocktake summary, cargo arrived, handover, backup-restore failure) renders once per reader in their own `users.locale` — a warehouse manager reading Uzbek and an accountant reading English get the same event in their own words.
- **The client-facing drafts stay as they were.** Inside the "cargo arrived" message there are two ready-to-forward texts for the client (uz + ru); the manager copies them to the client, so they follow the CLIENT's language, not the manager's. Translating those into the manager's language would have been the wrong move.
- Tests: a message rendered in English contains no Russian labels (not merely English ones alongside), an Uzbek one uses Uzbek wording, and an unknown locale on a user row never produces the word "undefined" in a message going to a real phone.
- 168 unit/integration + 12 e2e green.
- **Client cabinet bot**: still Uzbek. Clients are Uzbek and there is no per-chat language yet; adding one means storing a language per client and a switch button in the bot. Say the word if a foreign client needs it.


## English in the exports and the paperwork (part 2 of 3) — 2026-07-25

Two different rules, because these files have two different readers.

- **Report exports follow the reader.** All ten downloads (landed cost, stock aging, batch register, receipts journal, unclaimed, client history, staff activity, label prints, in transit, stock) now take the locale of whoever pressed the button, so an English-speaking manager gets English column headers and sheet titles — ~55 labels in all four languages.
- **Customs paperwork is bilingual RU/EN and ignores the interface language.** The invoice, packing list, manifest, packing photos, agent file and handover act are read by an Uzbek customs officer and a Chinese forwarding agent, never by the person who clicked download. Letting them follow the interface would let someone working in English hand customs a paper nobody at the border can process. The invoice already carried a few pairs ("Отправитель/Sender:"); this finishes the pattern everywhere.
- **Caught in verification**: a bilingual label was used as an Excel TAB name, and Excel rejects `/` in one — every manifest download answered 500. Sheet names got their own slash-free constants, and two tests now stand where the bug was: one asserting no sheet name carries an illegal character, one generating all five documents end to end.
- Also guarded: every report label exists in every language, and an unknown locale on a user row falls back instead of producing blank headers.
- **Deliberately untouched**: the box and crate stickers. Their Russian words sit in a fixed 100×100 mm layout that I cannot proof-print here, and a longer bilingual string risks clipped text on real labels. Say the word and I will do them with a careful layout pass.
- 167 unit/integration + 12 e2e green.


## English interface (part 1 of 3) — 2026-07-25

- **English joins Russian, Uzbek and Chinese** — all 644 interface strings across 30 areas (receiving, batches, stock, finance, reports, map, admin…). Pick it from the language selector or set it per employee.
- Migration 0019 widens the `users_locale_check` constraint; without it nobody could actually be switched to English. Existing users keep their language — nothing moves by itself.
- **A test now guards all four bundles**: every locale must carry every key, keep the same `{placeholders}`, and not silently ship a Russian string as a translation. next-intl throws at RENDER time on a missing key, so a forgotten translation would otherwise surface as a broken page for whoever uses that language — usually not the person who added it. Verified against deliberately broken bundles: all three checks fire.
- Verified in a browser: 15 screens render English with no client-side errors. 163 unit/integration + 12 e2e green.
- **Still Russian/Uzbek** (parts 2 and 3, next): the customs documents (invoice, packing list, manifest, handover act, report exports) and the Telegram bot.


## The admin nav stays in the admin section — 2026-07-25

- **Owner's report**: "warehouses / clients / employees" sat at the top of the home screen; it should appear only after opening the admin panel. It was rendered by the protected layout, so it followed an admin onto every operational screen. Moved into the admin section's own layout, reachable from the home tile as before.
- **Found while moving it**: the section gate demanded `admin.warehouses.manage`, but the accountant holds `costs.fx.manage` and the home screen offers them the 💱 FX tile — clicking it bounced them straight back home, so an accountant could never open their own exchange-rate page. The gate now admits any admin-section permission and the nav lists only what the person may actually use; the four pages that had been leaning on the old gate (warehouses, clients, users, settings) check `admin.warehouses.manage` themselves, so widening the entrance opened nothing.
- The smoke test now asserts both halves: no nav on an admin's home screen, a nav inside the admin section. 153 unit/integration + 12 e2e green.


## Owner's UI round: archive, foldable panels, manual batch code — 2026-07-25

- **A finished batch used to vanish.** The board rendered only forming/loading/in transit/arrived, so once a truck was unloaded its manifest, costs and history were unreachable. There is now an archive drawer under the board — unloaded/closed/cancelled — searchable by code, plate or driver. Its box count comes from the departure movements, since a finished batch no longer owns any boxes.
- **The batch code can be typed by hand** (owner: the per-warehouse sequence YW-001, YW-002 is not always the number the papers use). A ✏️ next to the code opens an input, the generated code stays the default, and the new one is trimmed, uppercased and checked for collisions case-insensitively. Editable **only before departure**: after that the code is on the invoice, the manifest and whatever the agent already received, and renaming it would leave papers and system disagreeing. The change is audited with the old and new value.
- **Three panels fold away**: the driver pairing code ("it should sit somewhere small where it bothers nobody" — collapsed, with a badge showing the pending code so it stays findable), the VED documents, and — in receiving — the note and extra-cost fields, which belong to a minority of receipts. Photos and file attachments stay open, because those are used on every receipt. A draft that already carries a note or a cost comes back open. Native `<details>`: no client JavaScript, works on the slowest warehouse phone.
- **The draft packing list button is gone** — the photo packing list replaced it in practice. The generator itself stays reachable.
- **The stock table sorts by any column** (code, product, boxes, kg, m³, density, note, warehouse, date), reusing the reports' sort header, with the warehouse filter and search preserved in the link.
- 153 unit/integration + 12 e2e green, verified against a fresh build and a fresh database.


## Unload: accepted cargo stopped disappearing, and "accept everything" exists — 2026-07-25

Owner's report: cargo arrived, boxes were accepted by hand, the counter never moved, and finishing the unload declared the whole truck missing.

- **Root cause: an accepted box fell off the unload screen.** The screen's snapshot selected boxes by `current_batch_id` — which accepting a box CLEARS. So each acceptance removed a box from the list instead of ticking it off: the counter went 0/13 → 0/12 → 0/11, and a page reload showed nothing had been accepted at all. Membership now comes from the departure movement, which is written once and never changes.
- **Second cause: the screen only recognised `in_stock`.** Unloading at a customs or distribution warehouse — which is every Uzbekistan destination — lands cargo in `ready_for_pickup`, so even a correct snapshot would have read as "nothing accepted". The screen now treats anything that is no longer `in_transit` as accepted, whatever the destination type.
- **"Accept everything" is now its own button.** Finishing an unload marks whatever was not accepted as lost — and it was the ONLY one-tap action on the screen, so it got pressed by someone who meant "take it all in". `📥 Hammasini qabul qilish (N ta)` accepts the remaining manifest in one go, through the normal unload path (movements, scan events, ready-for-pickup notices, audit trail identical to a scanned unload; pressing it twice is a no-op). It sits ABOVE the finish button whenever anything is outstanding.
- **Finishing now says what it is about to do**: the batch card shows "Hali qabul qilinmagan: N ta", the finish button steps back to secondary styling while boxes remain, and it asks for confirmation naming the number that will be flagged lost.
- **A box resolved as "found here" lands where a scanned one lands.** It was hardcoded to `in_stock`, so at a distribution warehouse a recovered box stayed invisible to the ready-for-pickup and issue flows.
- Also: the audit page threw `MISSING_MESSAGE` on any `delete` entry (untranslated in all three languages) — added, and an unknown action now falls back to the raw verb instead of taking the page down.
- Five integration cases cover the owner's exact scenario end to end at a distribution destination; the membership one was checked against the old query and fails there. 151 unit/integration + 12 e2e green.


## GSRDriver: battery-first schedule, quiet notification, real setup screen — 2026-07-25

Owner's first field round on the driver app, after it ran on a real phone.

- **A position every 2 hours instead of every 5 minutes** ("menga aniq hozirgi location kerak emas"). The GPS is no longer registered permanently: an `AlarmManager` wakes the service, it takes ONE fix (up to a 90 s window, stopping early once accuracy is good enough), uploads, and lets the radio sleep until the next slot — the phone spends the trip idle instead of tracking. A cycle that gets nothing (tunnel, garage) retries in 10 minutes rather than waiting out the full interval, and the interval itself is 1 / 2 / 3 hours, switchable on the phone.
- **The battery exemption is now part of the first-run flow, not a button to remember.** Setup walks location → notifications → "always allow" → the system *"let this app run in the background?"* dialog → the vendor auto-start list, one step at a time, and each step is offered once so a refusal cannot loop. It is not cosmetic: without the exemption Android defers the alarm, so the every-2-hours schedule only holds because the app is on the allowlist.
- **The notification stopped narrating.** No more "✅ Hammasi yuborildi" every cycle: the channel is silent and minimum-importance (a new channel id — Android never lowers an existing one), and the text stays empty unless something is actually wrong (no location permission, or a real upload backlog). Android does not allow a foreground service to hide its notification entirely, so the trip name remains.
- **A real screen for the phone**: a green/amber state line, the trip, a setup checklist that stays red per unfinished item with a button that opens exactly that setting, the chosen interval, the last position with its time and coordinates, the next report time, the offline queue, the last error, and "Hozir yuborish" for the warehouse worker who wants to see a dot appear before the truck leaves. It renders in the **phone's own language** — Uzbek, Chinese or Russian — since the driver in China is the one who reads it for the next six days.
- **Server side follows the new rhythm**: a fix counts as real for 8 hours instead of 90 minutes (2-3 h reporting + a missed cycle + a dead zone), otherwise every genuine position would have been drawn as stale and handed back to the estimate. Ages are shown in hours once minutes stop being the honest unit, and the map/batch texts say the location updates every 2-3 hours so nobody reads a still dot as a fault. 146 unit/integration green.


## GSRDriver — Android app for drivers (phase B) — 2026-07-25

- **The app the warehouse worker installs on the driver's phone** while the truck is being loaded: type the trip's 6-character code once, grant the permissions (the worker does it, not the driver), hand the phone back. From then on the phone reports its position by itself.
- **Works on ANY Android phone**: location comes from the framework's own `LocationManager`, not Google's fused provider — most Chinese phones (Huawei above all) ship without Google services, and the driver's own phone is whatever it is. No third-party networking library either; the whole app is Kotlin + the Android SDK.
- **Built for the corridor's dead zones**: a fix every ~5 minutes (or 250 m) goes into a local SQLite queue and is deleted only once the server has accepted it, so a week without signal loses nothing. A truck restart brings tracking back by itself (boot receiver), and Android killing the service is answered with an automatic restart.
- **Stops itself when the trip ends**: the server answers "trip finished" once the batch is closed and the app clears the token and shuts down — nobody is tracked outside a trip.
- **The screen is written for the warehouse worker**: status in Uzbek ("✅ Kuzatuv ishlayapti", "📦 Yuborilmagan nuqtalar: 12", "⚠️ «Doim ruxsat» berilmagan"), plus a one-tap shortcut to the battery settings — the Chinese-OEM battery killer is the single most common reason tracking goes silent, so it gets its own button and a hint.
- **Distribution without a store**: GitHub Actions builds the APK on every change (`apps/driver-android/`); download it from the run's artifacts and install it directly. No Play Console, no review, no $25 — and it works in China where Play does not exist. `apps/driver-android/README.md` documents the whole setup in Uzbek.

## Driver tracking — server side (phase A) — 2026-07-25

Owner's flow: at loading the warehouse worker takes the driver's phone, installs the app and grants the permissions himself, then sends the truck off. Android phones stream real positions; iPhone / HarmonyOS stay on the logist's manual updates plus the schedule estimate.

- **Pairing is per TRIP, not per driver**: the batch card gained a "📲 Haydovchi telefoni" panel that mints a single-use 6-character code (ambiguous letters excluded — it is read off a screen). The app sends the code once and gets a trip token back; the code is burned immediately, so a screenshot of it is worthless. Tracking ends by itself when the batch is closed — the server answers "trip finished" and the app stops.
- **Position ingest** accepts a whole queue of fixes at once (the corridor is full of dead zones, so the phone stores and flushes on reconnect) and ignores duplicates from a re-flush. Every device shows its last-seen time and fix count on the batch card; the code can be revoked at any moment.
- **The map now prefers reality**: a fix newer than 90 minutes replaces the estimated dot and the truck panel says "🟢 Real position · N minutes ago"; an older one falls back to the schedule with "🟡 Estimated · last real signal N minutes ago". Manual pins by the logist count as positions too, which is exactly the iPhone/HarmonyOS path.
- Migration 0018 (`driver_devices`, `driver_positions`); tokens are stored hashed like session tokens and never leave the server; 10 integration cases cover single-use pairing, re-flush deduplication, revoked/finished-trip rejection and freshness. 145 unit/integration + 12 e2e green.
- Next: the Android app itself (`apps/driver-android/`, built into an APK by CI) against this API.

## Demo accounts stop coming back — 2026-07-25

- **The seed no longer re-creates demo data on a live system.** It runs on every deploy (that is how new permissions reach the roles), and it used to re-insert any demo user/client/warehouse that was missing — so an account the owner deleted, with the published `demo1234` password, reappeared on the next update. Demo users, demo clients, demo warehouses, the example FX rates and the canonical GS777 receipt are now seeded **only into an empty database** (the bootstrap that gives a fresh install someone to log in as). `SEED_DEMO=1` forces them back for test environments.
- Reference data — permissions, roles, role grants, settings, currencies, cost types, truck presets, the product dictionary — still refreshes on every run, unchanged.
- **`pnpm demo-users`** retires the accounts an existing server already carries: it reports every demo phone still present and, with `--disable`, deactivates the ones that STILL HAVE the demo password (login blocked, live sessions dropped). An account whose password was changed is in real use and is never touched, and the last active super admin is always kept with a warning to change its password.
- Verified end to end on scratch databases: fresh DB → demo seeded; existing DB → deleted demo account stays deleted while grants still refresh; `SEED_DEMO=1` → restored. A unit test pins the gating so it cannot be undone by accident.
- `docs/UPDATE.md` (production update runbook) documents the step.

## Receiving: an unknown code no longer offers a look-alike client — 2026-07-25

- **Owner's report**: typing GS500 (a code that does not exist) during receiving offered **GS300**, and the "unknown cargo" path disappeared behind that suggestion.
- **Search fixed**: digits in a client code are meaningful — GS500 and GS300 are different customers, but trigram similarity happily matched them. A query containing digits now matches codes literally (exact / prefix / substring); fuzzy matching is kept for names and for digit-free code typos, so `gs777` → GS777, `777` → GS777 and a misspelled client name still work, while GS500 simply finds nothing.
- **"Unknown cargo" is always reachable**: it is now the last row of the suggestion list (after the real matches, never before them, and deliberately unlabelled with the typed code so it cannot be mistaken for one), and the big button below appears whenever the list is empty.
- **Race removed**: that button used to flash up with the typed code for a moment BEFORE the lookup answered — a fast tap on an existing code filed the receipt as unclaimed. It now waits for the search to finish before claiming a code is unknown.
- Client search extracted into one module used by the receiving, issue and finance screens alike, with a DB-level suite (unknown code → nothing, exact/lowercase/partial, name typos, inactive clients hidden). 132 unit/integration + 12 e2e green; the e2e receiving flow now asserts the unclaimed path stays reachable for a look-alike code.

## Auto client code follows the MAIN sequence again — 2026-07-25

- **Owner's report**: codes run GS1…GS425, but a few one-off manual codes exist (GS777, GS5564, GS5909); asking the system to assign a code produced **GS5910** instead of **GS426** — plain "biggest + 1" was dragged along by the outliers.
- **New rule**: the existing numbers are split into groups (a jump of more than 50 starts a new group), the **biggest group is the main sequence**, and the next code is the first free number above it. Isolated special codes form their own one-member groups and are stepped over — until the sequence genuinely grows up to them, at which point it simply continues past. Scattered codes with no real sequence keep the old "biggest + 1" behaviour, and gaps left by voided codes are never re-issued.
- Hardened along the way (found by an adversarial review of the first attempt): a prefix that itself ends in a digit no longer corrupts the extracted number; a prefix containing regex characters is matched literally; a lowercase `client_code_prefix` setting no longer generates codes the database rejects; absurd/overflowing numbers can no longer hang the generator while it holds the sequence lock; and two managers saving the same manual code at the same moment now get a clean "code already exists" instead of an error page.
- 14 unit cases (including the owner's exact dataset and the 100-start variant) + a DB-level suite covering the prefix edge cases. 126 unit/integration + 12 e2e green.

## Real basemap for the tracking map (self-hosted, China-safe) — 2026-07-25

- **The /map schematic upgrades to a REAL zoomable map** (owner's ask for an external map): Leaflet renders a self-hosted OpenStreetMap extract (PMTiles vector tiles) covering the whole corridor (UZ + KG + all of China). Why not Yandex/Baidu: Baidu requires a Chinese-ID developer account and barely covers Uzbekistan; Yandex is unreliable behind the GFW. Hosting the map data ourselves gives the same look with guaranteed China performance and zero runtime dependency on anyone.
- **One-time server step**: `bash ops/fetch-basemap.sh` downloads a ~30-80 MB corridor extract into `.data/basemap/` (docker volume added); until then the map page keeps the schematic SVG with a gray hint — nothing breaks, both modes share the same trucks/warehouses/popups.
- Waypoints refactored to real lon/lat (single source for both renderers); `/api/basemap/corridor.pmtiles` serves the file with proper HTTP Range support (the PMTiles reader fetches byte ranges) — unit-tested including 206/416 edges.
- 110 unit/integration + 12 e2e green (CI exercises the SVG fallback path).

## 🗺 Tracking map: approximate truck positions + warehouse stock — 2026-07-24

- **New "Xarita" page** (home → info tiles): a self-drawn SVG of the whole corridor (Guangzhou/Yiwu → Urumqi → Kashgar → Irkeshtam → Osh → Andijan → Tashkent) — deliberately NO external map tiles, so it opens instantly in China and adds zero dependencies (owner-approved tradeoff).
- **Trucks on the map**: every in-transit batch is placed along its route by the owner's typical timings (YW→KA 6-7 d, GZ→KA 5-6 d, KA→UZ: to border → 1-3 d border queue → 2 d Kyrgyzstan → UZ leg), pulsing amber; red when the schedule says it should already have arrived. Tap a truck → batch code, phase ("Chegarada navbatda"), ETA range, progress bar, per-client contents, link to the batch.
- **Warehouses on the map**: 🏭 icons with live stock badges; tap → per-client stock chips + link to the stock browser.
- **Manual position pins** (the honesty mechanism — this is a simulation, not GPS): the batch card gains "📍 Mashina qayerda?" buttons — 🛃 at the border / 🇰🇬 in Kyrgyzstan / 🇺🇿 in Uzbekistan. One tap re-anchors the map estimate from that moment (audited, tap again to clear). The map header always says positions are approximate.
- Estimator is a pure unit-tested engine (segment schedules, stationary border wait, checkpoint re-anchoring, overdue detection); migration 0017 (`batches.tracking_checkpoint`); map assertions added to the m3 e2e flow. 105 unit/integration + 12 e2e green.

## One phone = all codes: cabinet multi-code round — 2026-07-24

- **New-client save lands on the client CARD**, not the list (owner: "after Сохранить everything vanishes — can't tell what code the system assigned"). The assigned code is in the heading, and the Telegram-cabinet block is right there for the next step. Client edits land on the card too.
- **One verified phone connects EVERY code of that person** (owner: one customer holds 777, 555, 444, 333): the client taps ONE link, confirms their phone once, and all active client codes registered under that number join the chat together — the welcome message lists them all.
- **New codes join automatically**: when staff opens another code for an already-verified person (same phone on the card), it appears in their cabinet by itself with a "🔗 yangi kod qo'shildi" ping — no new link ceremony.
- Phone verification stays (it is exactly what catches the wrong-recipient case from the last incident) — but it now runs ONCE per person, not once per code.
- In the bot every code shows separately under 📦/💰/🗄 — a multi-code client scrolls through each code's cargo and balance.
- e2e: m5 spec no longer trips over accumulated unclaimed stock rows (picks a real GS client row).


## Cabinet linking is now phone-verified — 2026-07-24

- **Owner's incident**: a cabinet link minted for one client was sent to a different person, who tapped it and instantly saw the other client's cargo and debt. Root cause: the link was a bearer token — whoever tapped it got linked, identity unchecked.
- **Now linking is two-step**: tapping the link reveals NOTHING — the bot first asks the person to share their own phone number via Telegram's contact button (spoof-proof: a forwarded stranger's contact card is detected and rejected). The number is matched against the client card's registered phones (digit-normalized, so +998 90 175-78-00 and 998901757800 match) and only then does the cabinet open.
- **On mismatch**: the link is burned immediately, the person sees a neutral "contact your manager" (no client data), and the staff member who minted the link gets a 🚨 Telegram alert to check who they sent it to.
- A client with NO phone on file can't be verified — the bot tells the person to contact the manager, the staff member gets a prompt to fill the phone in (the link survives for a retry after that).
- The admin card now shows the client code right next to each pending link — the incident started as a wrong-tab mix-up between two same-named clients.
- Phone-matching unit suite + reworked linking integration tests (97 unit/integration + 12 e2e green). Also fixed the second e2e code-collision flake (client code now uses the full run id).

## Quick-batch loading: pick the box, don't type the code — 2026-07-24

- **⚡ Quick (plan-less) batches**: the loading screen's manual button becomes "📦 Skladdan tanlab yuklash" — it opens the origin warehouse's loadable stock (in_stock / ready_for_pickup, grouped by client-letter with product names and crate badges). Tap a box → loaded; the sheet stays open so several boxes go in a row, and loaded ones drop off the list instantly (owner's request: no code typing).
- A search field (code / client / marking / product) appears on lists longer than 8 — for both the quick-batch stock list and the planned batches' sticker-lost list.
- Typing the code by hand still works as a fallback; everything is recorded as a `manual / sticker_lost` scan exactly as before.
- e2e flake fixed: the M0 smoke test's generated warehouse code collided with leftovers of earlier runs — now uses the full 6-digit run id.

## Phase 2.2 — Telegram client cabinet — 2026-07-24

- **Clients get their own cabinet in the SAME bot** (owner's spec): staff opens Admin → Client → "🤖 Telegram kabinet", mints a one-time deep link and sends it to the client; the client taps it and gets a persistent uz-language menu.
- **📦 Yuklarim** — active cargo grouped by lot (letter, product zh/ru, per-status counts: skladda / yo'lda 🚛 / olib ketishga tayyor ✅, warehouse codes) with 📷 buttons that send the lot's photos (server thumbnails, ownership re-checked on every tap).
- **💰 Balans** — the Phase 2.1 ledger balance ("qarzingiz: $X" or "qarzingiz yo'q ✅") plus the last 5 charges/payments — old delivered-cargo debt included (owner explicit).
- **🗄 Tarix** — already-issued cargo history.
- **Auto-messages to the client's own chat** (best-effort, uz): cargo arrived at the UZ warehouse (owner's Q5 wording — "rasmiylashtiruv tugagach olib ketish vaqtini kelishamiz") and cargo issued (receiver name, boxes left).
- One chat can hold several clients (broker case); codes are single-use; staff can revoke a link any time and access ends immediately; linking/revoking is audited. Migration 0016; cabinet integration suite (90 unit/integration + 12 e2e green).

## Phase 2.1 — Finance: client ledger, batch pricing, debt gate — 2026-07-24

- **💰 Finance section** (`/finance`, home tile for finance roles): every client with money activity, charges/payments/balance in USD, debtors first and in red; client page shows the full ledger (who entered what, when, against which batch) with void-with-reason for mistakes (audited, struck-through in history — never deleted).
- **No tariffs by design** (owner's rule): the price of every shipment is whatever the sales manager and the client agreed — the ledger records **charges** (agreed prices) and **payments** (cash 💵 / card 💳 / bank transfer 🏦, owner accepts all three) in any currency. Amounts convert to USD at the dated FX rate **frozen at entry time** — later rate edits never move settled money. A currency with no rate at all is refused with a pointer to the FX page.
- **Batch pricing page** (`/batches/[id]/pricing`, batch card → "💰"): after customs, the VED manager and accountant see each client on the batch (boxes / kg / m³), enter the negotiated amount, and it lands in the client's ledger as a charge tied to that batch (owner's flow: "yangi yuki rastamojkadan keyin tayyor bo'lganda VED menejer va buxgalter narxlarni belgilab chiqishadi").
- **Debt gate on issue** (owner's rule: "manager ruxsati bilan yuklar beriladi"): the issue screen shows the client's debt up front; a debtor's cargo is blocked at confirm unless someone holding the new `finance.debt_override` permission ticks "manager allowed" (recorded on the handover + audit). Operators can't override — managers, sales managers, accountants and admins can (adjustable per role in admin, as all grants are).
- New permissions `finance.manage` (accountant, VED manager, admins), `finance.view`, `finance.debt_override`; migration 0015 (`client_transactions`); integration suite for conversion/balance/void + the debt gate (84 unit/integration + 12 e2e green).

## Phase 1.5 — AI ТНВЭД assistant (memory-first) — 2026-07-24

- **🏷 ТНВЭД page per batch** (VED-doc card → "ТНВЭД"): one row per product with photo, code input and a 🤖 button — the AI (Claude) suggests a 10-digit UZ customs code from the product name (zh/ru) + photo, tuned to be duty-optimal but customs-defensible, with a confidence note and reasoning. "Suggest for all empty" fills the gaps in one tap.
- **Memory-first** (owner's rule): every SAVED code lands in `tnved_assignments` keyed by the normalized product name — known products pre-fill instantly and the AI is only asked about products never seen before. The human always confirms; AI output is a draft.
- **Invoice prefill**: the ka23 INVOICE & PACKING LIST now fills its ТНВЭД column from the memory (still editable in Excel); unknown products stay blank as before.
- Requires `ANTHROPIC_API_KEY` in `.env` (documented in `.env.example`); without it the page still works with manual entry + memory, and the 🤖 button explains what's missing.
- Migration 0014; audited saves; unit tests for the key/code helpers (76 total).

## Feedback round 8 — Depart for loaders, iPhone scan feedback, photo packing list — 2026-07-24

- **"Отправить" now visible to the loading warehouse too** (owner's request): anyone who can load (`scan.load`) at the origin warehouse can send the truck off — behind a confirmation dialog for everyone ("after this the load list locks"). Closing/arrival stays manager-only.
- **Scan counter goes live across phones**: every 15-second sync now also pulls the server's view of the batch, so boxes scanned on ANOTHER phone (or an earlier session) count without refreshing the page. Union-merge keeps local unsynced scans visible.
- **iPhone scan feedback**: iOS has no vibration API — every scan verdict now also beeps (WebAudio: high blip = ok, low buzz = duplicate/error), armed on the first touch as iOS requires. Shared module used by loading, unloading, inventory and issue screens; the issue screen also buzzes on unknown/duplicate codes instead of silently ignoring them.
- **Packing list with photos** (owner's request): new "⬇️ 📷 Packing (фото)" on the batch card — one row per loaded lot (code, product zh/ru, boxes, kg, m³) with every lot photo embedded, built from load scans so it works after unload/close too.
- **Stock page bug (owner's report: "13 boxes at TAS1 but stock shows nothing")**: boxes unloaded at a customs/distribution warehouse become `ready_for_pickup` and vanished from the stock browser/stock XLSX, which filtered `in_stock` only. Stock now shows everything physically on the shelf (in_stock / planned / loading / ready_for_pickup) with per-box status chips.
- **Planned (Phase 1.5)**: AI ТНВЭД assistant — suggests the customs code from product name+photo, remembers every confirmed assignment and reuses it without calling the AI again; VED manager confirms (PLAN.md).

## Feedback round 7 — Sticker product names, departed-batch view — 2026-07-24

- **Sticker bug fixed: product name now actually prints** (owner's report). The PDF library's font subsetter silently emitted broken CJK fonts — 化妆品 came out as empty squares (or nothing at all on thermal printers) on box labels, crate labels and the handover act. Fonts are now subsetted with HarfBuzz (`subset-font`) to exactly the characters each document uses: both 中文 and русский names print, and label PDFs stay small (DECISIONS #103).
- **Departed batch: sending warehouse keeps a read-only view** (owner's request): the batch card gained a collapsible "🧾 Loaded boxes" list built from load scan events — box codes grouped by client-letter — so the origin operator can always see exactly WHAT left, even after unload/close. No actions — view only.
- Owner's question about photo size answered in-app: photos are already compressed on the phone before upload (≤1600 px, ~0.3 MB, web worker) at all three upload points, and lists serve server-generated thumbnails.

## Deploy kit — probniy server in one command — 2026-07-24

- `docker-compose.yml`: one-shot **migrate+seed service** (the app previously started against an empty DB with no admin user), optional **Caddy HTTPS profile** (`DOMAIN=… docker compose --profile https up -d`) — phones need a secure context for the camera scanner.
- **`.dockerignore` added** — `.env` secrets and `.data` (dumps, photos) no longer leak into the image (`COPY . .` was copying them).
- **`ops/bootstrap.sh`**: fresh Ubuntu VPS → running stack in one command (installs Docker, generates `.env` with random secrets, build, health-wait, prints the URL and demo login).
- **`docs/DEPLOY.md`** (uz): the owner's 10-minute path — buy a HK/SG VPS, clone, run the script; or hand Claude SSH access and skip even that.

## M6 part 7 (final) — Digest polish, restore fire drill, runbook — 2026-07-24

**M6 closes with this release — all Phase 1 milestones (M0–M6) are done.**

- **Per-user Telegram mutes** (spec §11): profile page gained a 🔕 card — mute everything, or just the daily digest / alerts / operational messages. The in-app bell still shows everything; muted sends are recorded as `muted by user` (migration 0013, DECISIONS #100).
- **Admin → Notifications**: Telegram delivery journal with a problems-first filter (retrying errors, muted/unlinked recipients) and a 7-day status summary — spec §11's "failures visible in admin".
- **Weekly backup fire drill**: new `db.restore_test` job (Sunday 04:00 Tashkent) + `pnpm restore-test` — restores the latest dump into a scratch DB, sanity-checks the six core tables, drops it, and alerts admins in Telegram if anything fails (DECISIONS #101). Verified against a real dump.
- **README rewritten as an ops runbook**: production start rules (standalone only), update procedure, job schedule table, backup/restore commands, Telegram bot setup, troubleshooting; `.env.example` documents `BACKUP_DIR`/`BACKUP_RETENTION_DAYS`.
- **Performance pass**: first-load JS measured at 104 kB shared / ≤150 kB worst route — within the 3G budget; dashboards intentionally stay chart-lib-free (DECISIONS #101).
- Tests: 74 unit/integration (+6 mute-logic) + 12 e2e — full regression green.

## M6 part 6 — Whole-app UI/UX sweep — 2026-07-23

Full-project audit (every page + shared component) against the owner's "find and fix the UX shortcomings" request:

- **Home screen regrouped**: big tiles for daily operations (receive / batches / plans / issue / crates / inventory), small tiles for info (stock, receipts, unclaimed, search, dashboard, reports, pipeline) and management (FX, trucks, admin) — section headers in all three languages.
- **No more dead ends**: friendly error page (😵 + retry + home instead of the raw Next.js digest screen) and 404 page; every detail page (receipt, batch, box, crate, plan) and all 8 report pages got a "← back to list" link.
- **Destructive-action safety**: deleting a receiving lot that already has data asks for confirmation; photo/attachment delete errors now surface instead of failing silently (receive wizard, return-to-sender, cost panel void).
- **Touch targets**: tiny ✕/🗑 icons enlarged to ≥28 px hit areas (lightbox, gallery, attachments, clear-client); small box-pick buttons in crate builder and issue screen brought up to comfortable tap size.
- **Scanner ergonomics**: manual code inputs autofocus + uppercase on load/unload/inventory screens; inventory scans now vibrate + flash like the other scan modes.
- **Feedback everywhere**: pending states on assign-client and photo uploads ('…' + disabled), stale-fetch guards (AbortController) in crate builder and issue screen so slow responses can't overwrite fresh lists.
- **Consistency**: bare "—" placeholders replaced with a proper localized empty state on plans/crates/transit/unclaimed/pipeline/stock and admin lists; audit page no longer crashes on a malformed date filter; stock page uses locale-aware number formatting.
- **Fixed en route**: a route-transition skeleton (`loading.tsx`) added early in this sweep silently broke every server-action redirect/refresh (crate dissolve, box lost/found) — root-caused and removed (DECISIONS #98). Full suite back to green: 68 unit/integration + 12 e2e.

## M6 part 5 — All nine reports + sorting — 2026-07-23

- **§13 report set complete** (all with audited XLSX): + receipts journal (7/30/90-day filter, operator column), unclaimed cargo (7/14-day colors), client cargo history (search by code → per-lot journey: batches ridden, in stock / in transit / ready / issued), staff activity (receipts/edits/prints/scans per user per day, last 14 days), label print log; in-transit XLSX added to the existing view.
- **Sortable columns** (owner request #13): clickable headers on stock-aging, batch register, receipts journal and unclaimed tables — sort lives in the URL so it composes with filters (DECISIONS #96).
- **Dashboard cost-hygiene warning**: batches departed > 3 days with zero cost entries (spec 6.9) in the attention card (DECISIONS #97).
- Management-only reports (landed cost, client history, staff activity, label prints) gated by `reports.all_warehouses`.

## M6 part 4 — Inventory mode — 2026-07-23

- **📋 Inventory (stocktake) mode** (owner's request, home tile for scan-capable staff): pick a warehouse → scan everything (camera/HID/manual; a crate QR counts all its boxes) with a live X/Y counter → results screen. Boxes recorded elsewhere but scanned here move to this warehouse on submit (`inventory_found` correcting movement; issued/void boxes are listed but never auto-moved). Unscanned boxes become `lost` only when TICKED by a warehouse manager (`receipts.void` gate — operators see the list read-only). The full summary (scanned / moved / lost) goes to admins+logists via Telegram (`InventoryCompleted`). Runs parallel to normal operations (DECISIONS #93).
- **Aging colors 7/14** per the owner: stock/aging report days turn yellow at 7, red at 14 (DECISIONS #94).
- Landed cost confirmed management-only (DECISIONS #95).
- Tests: 68 unit/integration (+ inventory reconciliation: found-here move, manager gate, no-op/skip cases) + 12 e2e.

## M6 part 3 — Dashboard + first reports — 2026-07-23

- **📊 /dashboard** (role-aware, §13): warehouse fill bars (moved here from the home screen per the owner), stock per warehouse (boxes/kg/m³), in-transit batches, last-24h receipts, and an "attention" card — unclaimed, stale stock (> `stale_stock_days`), missing-in-transit and undocumented-transfer counts. Admin/logist/VED/accountant see all warehouses; warehouse staff their own; sales managers land on the pipeline.
- **📑 /reports hub** + the owner's top-3 reports, each with an audited XLSX export:
  1. **Landed cost by client** (`reports.all_warehouses` only): Σ USD per client, drill into per-lot breakdown with $/box.
  2. **Stock & aging**: every lot in stock with boxes/kg/m³/density and days-in-warehouse, oldest first (>14 d orange, >30 d red).
  3. **Batch register**: route, status, departed date, loaded/short-loaded/added-on-spot deviations, kg/m³, costs USD and $/kg (costs hidden from warehouse-scoped staff).
- Home screen: fill card removed, 📊 Dashboard tile added.
- Shared report read-model module (`wms/reports/queries`) reused by pages, XLSX and the dashboard.

## M6 part 2 — Real invoice, capacity, backups (+ owner answers) — 2026-07-23

- **INVOICE & PACKING LIST now mirrors the owner's real ka23 file**: combined sheet with Invoice №/date/container, Sender/Seller/Consignee, transport/delivery-terms/customs-post — all six requisites are editable settings (`ved_*`) with defaults taken from the uploaded document; ТНВЭД column present (VED fills codes+prices), live amount/total formulas (DECISIONS #89).
- **Warehouse capacity indicator**: `capacity_m3` on the warehouse admin form; home screen shows a fill bar per warehouse — yellow from 60%, red + 🚨 from 80% (owner's thresholds, DECISIONS #90).
- **Backups**: nightly 02:00 Tashkent `pg_dump` to `.data/backups` with 30-day retention + manual `pnpm backup` (owner: local disk for now, DECISIONS #91).
- **Loading screen shows crate contents** (owner's request): crated boxes group under `🧰 CR-…` with a "GS777-A 化妆品 · …" summary so the operator scans the crate instead of hunting boxes; sticker-lost list shows the crate chip per box.
- **Vehicle panel collapses to one line** once filled (owner's request) — ✏️ expands it back.
- Plan editor: origin switch now clears the stock list instantly + aborts stale fetches — typed counts can no longer vanish mid-entry (this was also an e2e flake, DECISIONS #92).
- Owner's answers recorded: FX stays manual; dashboard order approved; report priority = landed cost → stock/aging → batch register; inventory runs parallel to operations.

## M6 part 1 — Costing core (W9) — 2026-07-23

- **Allocation engine** (pure, tests-first): all five bases (weight/volume/chargeable/boxes/direct-to-client), 4-dp shares with drift absorbed by the last box; §6.9 worked example passes as a unit test AND as a full two-leg integration test (acceptance test 16): box P rides two batches → landed cost = Σ per-leg shares, each converted at that entry's dated rate; rate edit recomputes; void removes the share.
- **FX rates** (migration 0012, replaces the unused M0 pair-based placeholder): USD-base dated manual rates, `/admin/fx` page (`costs.fx.manage`), rate edits enqueue a per-currency recompute. Currencies with no rate leave entries visibly "no rate" instead of guessing (DECISIONS #86).
- **Cost capture (W9)**: 💰 panel on the batch card (freight/agent/customs…, `costs.enter_batch`) and the receipt page (`costs.enter_receipt`) — type, amount+currency, dated, allocation basis, void with reason; batch card shows Σ USD + unit cost per kg / m³ of the departed load.
- **Materialized `cost_allocations`** rebuilt idempotently by a pg-boss job on entry create/void, FX edit and batch depart (DECISIONS #87–88).
- **Box card shows landed cost** with a per-entry breakdown (receipt/batch/crate share) for cost/report roles.
- Migration 0012 also adds `warehouses.capacity_m3` (fill indicator lands with the M6 dashboards).
- Seed: dated CNY/UZS rates for the worked example. Tests: 65 unit/integration + 12 e2e.

## Feedback round 5 (owner testing) — 2026-07-23

- **Unclaimed labels print the marking**: sticker shows `444-A` (whatever is written on the box) as the dominant code with a small `#UNKNOWN` flag; `#UNKNOWN` alone only when no marking was captured (DECISIONS #82).
- **Per-letter sticker printing**: the after-confirm screen offers a 🖨 button per letter (A, B, C…) next to "print all".
- **Plan editor**: live average density (Ø kg/m³) in the totals bar; place count shown when crates are selected (`Σ 12 📦 · 5 joy`).
- **Truck presets are owner-managed** (`/trucks`, linked via ⚙️ from the plan editor): add/edit/hide with audit — no more seed-only trucks (DECISIONS #84).
- **Crate = one place in a plan** (migration 0011): crated boxes leave loose availability; the editor lists each active crate as a single tickable unit; approval reserves the crate's exact boxes so scanning the crate QR at loading matches the plan (DECISIONS #83).
- **Agent Excel**: ALL lot photos embedded side by side after the data columns (was: single photo in column A).
- **Vehicle info editable until batch close** — wrong plate/driver fixable after departure (DECISIONS #85).
- Planned for M6 (owner's questions): warehouse capacity indicator with red fill warning, inventory/stocktake mode with reconciliation, sortable table columns (PLAN.md M6 #11–13).
- Tests: 59 unit/integration (+ crate-planning lifecycle) + 12 e2e.

## Bugfix round 4 (owner testing) — 2026-07-23

- **File attach fixed**: the upload whitelist was too narrow — now accepts TXT/CSV/ZIP/RAR/7z/GIF/HEIC and MP4/MOV/WebM video (photos ≤15 MB, files ≤25 MB, video ≤60 MB), with an extension fallback for files the browser sends without a content type (common on Windows). Rejections now show the real reason ("type not supported" / "too large") in the operator's language instead of a generic "upload failed".
- **Delete wrongly-added photos/files**: ✕ badge on every thumb/file chip in the receiving screen (lot photos, general photos, receipt files), on the receipt page galleries and attachments panel (for users who can edit). New `DELETE /api/attachments/[id]` — allowed for the uploader and `receipts.edit` holders; removes bytes + thumbnails and writes an audit entry.
- **"Warehouse out of scope" crash fixed**: a stale localStorage draft (same browser, different account) kept a warehouse the operator wasn't assigned to; the confirm action then threw an unhandled AuthError and crashed the page with a digest. The restored draft now snaps back to an allowed warehouse, the action returns a translated error instead of throwing, and a warehouse-scoped operator never sees the all-warehouses fallback (zero assignments → clear "no warehouse assigned" message).
- **Save feedback**: lot edit now collapses on success and shows ✅ Saved (+ label reprint hints); vehicle info form shows a pending state and ✅ Saved on the button (was a silent server action).
- Tests: 57 unit/integration (+ attachment lifecycle, content-type fallback) + 12 e2e.

## M5 — Export & UZ side — 2026-07-23

- **VED documents (W6)**: invoice + packing-list DRAFT XLSX from the actual manifest (blank price column with live amount formulas; company header from settings — real requisites still needed from the owner), "sent to agent" flag with date on the batch card.
- **UZ arrival**: unloading at a customs/distribution warehouse puts cargo straight into `ready_for_pickup`; per-client `ReadyForPickup` Telegram to the sales manager including ready-to-forward client message drafts in uz + ru (cautious "being cleared" wording per the owner's answer).
- **Issue mode (W7)** 🤝: warehouse + client → issuable boxes grouped by lot → tap or scan out → receiver name/phone + "no debt" checkbox (record-only) → partial pickup leaves the rest; handover record + `BoxIssued` notify with remaining count; **handover act PDF**.
- **Quick batch** ⚡: plan-less internal transfers from the batch board — load scanning accepts any loose box at the origin without the not-on-plan ceremony.
- **Sales pipeline view** 📈: per-client counts across in stock → in transit → ready → issued (managers see own clients).
- Home tiles: issue + pipeline are live; no "coming soon" buttons remain.
- Migration 0009 (handovers: nullable receipt, client_id, debt_ok). Tests: 51 unit/integration + 12 e2e (full export chain: plan→load→depart→customs unload→ready→issue→act PDF). DECISIONS #76–81.

## M4 — Transfer receiving — 2026-07-23

- **Unload mode (W5)**: same scanner core + offline outbox as loading; first scan marks the batch `arrived`; on-manifest boxes land `in_stock` at the destination; crate scans fan out; sticker-lost manual entry from the un-unloaded list.
- **Auto-transfer** (edge case 4, reality wins): a known box NOT on the manifest is accepted and moved to THIS warehouse regardless of its recorded location — flagged `undocumented_transfer`, correcting movement, instant logist Telegram. Unknown QR → red toast with a link to the unclaimed intake.
- **Finish unload**: never-scanned manifest boxes flagged `missing_in_transit` + alert; batch card shows them with manager resolutions "found at origin" (back to origin stock) / "found here"; batch → `unloaded` → `closed`.
- **/transit report** (KA hub v1): in-transit/arrived batches + every missing-in-transit box, linked from the batch board.
- Notification rules + Telegram texts for `UndocumentedTransfer` / `MissingInTransit`.
- Tests: 49 unit/integration (+ unload reconciliation, auto-transfer, resolutions, close) + 11 e2e including the full phone round-trip plan→load→depart→unload→close. DECISIONS #71–75.

## M3 — Load planning & scanning — 2026-07-23

- **Plan editor (W3)**: pick origin→dest + truck preset, tick lots from FIFO-sorted stock with photos and days-in-stock, partial box counts, live kg/m³ gauges that go red over capacity but never block; submit creates an immutable version for the agent.
- **Agent loop** (owner's rule: agent stays outside the system): Excel with embedded photo thumbnails per line; the logist records the verdict — changes_requested reopens the editor for v2, approved creates the batch (`YW-001` per-WH sequence) and reserves the lowest-seq boxes as `planned` (no double-planning).
- **Batch card & board**: kanban (forming/loading/in transit/arrived), vehicle info (plate, driver, phone), finish-loading deviation summary (short-loaded boxes revert to stock), depart → everything `in_transit` + `BatchDeparted`, actual-manifest XLSX (fact, not plan — per-box sheet with crate + on-spot flags, per-lot summary).
- **Loading mode (W4)**: camera scanning (native BarcodeDetector, @zxing fallback) + USB/BT HID scanners; <300 ms local verdicts from a cached batch snapshot; big running counter + per-lot progress; duplicate soft-warning; **not-on-plan red screen** with "load anyway + reason" → flagged + instant Telegram to logists; **sticker-lost** manual entry from the unscanned list; **offline outbox** in IndexedDB with idempotent sync and a visible online/offline/pending banner.
- Notifications: PlanApproved / PlanChangesRequested / not-on-plan alerts → logists+admins.
- Seed: two real truck presets. Deferred (recorded in DECISIONS #68–70): SSE live-push, reprint offer in sticker-lost flow, presets admin CRUD.
- Tests: 47 unit/integration (plan lifecycle, double-plan guard, scan idempotency/replay, crate fan-out, finish/depart) + 10 e2e including the full phone lifecycle plan→verdict loop→approve→load→depart→manifest.

## M2 — Stock ops: crates, lost/void, WH-move, unclaimed return, digests, XLSX — 2026-07-23

- **Crates (yashik/karkas, W2)**: schema + `CR-{WH}{YY}-{00000}` codes; mobile builder — pick warehouse + client, tick whole lots or individual boxes, mandatory "Logist approved" checkbox, optional measured dims/weight + note + crating cost (stored scope=crate under the `crating` type, carried to the client for M6 allocation); one-client-per-crate enforced with clear errors (unclaimed cannot be crated); crate label PDF (dominant client code, ЯЩИК/КАРКАС marker, contents A×10-style summary, QR = crate code); crate detail with contents, measurements-after-packing form, photos, dissolve (audited); crate-resolution service ready as the shared primitive for M3–M5 scan modes.
- **Box lost/void/found**: manager-only (`receipts.void` holders) with mandatory reason; lost boxes can be marked found (back to stock, owner's decision); boxes in an active crate must be un-crated first; full movement trail.
- **Wrong-warehouse fix**: manager moves a whole receipt between warehouses with correcting movements — only while everything is still in stock and un-crated; UI prompts a label reprint afterwards.
- **Unclaimed return-to-sender**: whole receipt handed over at once; receiver name + phone mandatory, note/photo optional; boxes → issued (`returned_to_sender`) with a handover record; audited + event.
- **Daily digest**: one consolidated Telegram/in-app message at 09:00 Tashkent to logist + admins — unclaimed cargo older than `unclaimed_aging_days`, stale stock older than `stale_stock_days`, grouped per warehouse; suppressed when empty.
- **Stock XLSX export** from the stock browser with the current filter applied (download-only for now); exports audit-logged.
- Migrations 0006 (crates, handovers, boxes.crate_id FK) + 0007 (cost_entries scope=crate); new home tile 🧰; long home-tile labels now wrap at 360px.
- Tests: +8 integration (crate lifecycle incl. idempotent create, cross-client/unclaimed rejection, crating cost row, lost→found transitions, move guards, return idempotency, digest run) and +4 e2e (crate build→label→dissolve on a phone, lost→found, unclaimed return, XLSX download): 42 unit/integration + 9 e2e, all green.

## Status sync + hygiene sweep — 2026-07-23

- Docs brought up to date with the three feedback rounds: DECISIONS #48–55 recorded (per-lot note removed from intake, ru display-only, single total cost under "other", general box photos as a first-class concept, direct attachment streaming, LightboxImg standard, no photo-required indicator, dual rendering scoped to product lines only); PLAN.md M1/M2/M6 tasks annotated as-built; ARCHITECTURE.md attachment-read path corrected; open questions Q1/Q2 marked answered.
- Cleanup found by a full audit: removed ghost `note` fields from the wizard draft (a stale localStorage draft could silently submit text the operator can no longer see), pruned 21 orphaned i18n keys from all three locales, localized the last hardcoded placeholder (lot editor note).
- Tests caught up with the recent features: the receipt e2e now also uploads a general box photo, enters the single total cost, and asserts the cost + photos on the receipt detail, the stock table (product + amber general photo), and the tap-to-zoom lightbox open/close; the hardcoded debounce sleep replaced with a deterministic response wait; e2e serialized (shared DB/sequencer); CI seeds before vitest.

## Receipt header panel rework — 2026-07-23

- The receipt-info panel is now compact: client row, then one line with the source note + a SINGLE total-cost amount+currency (no more per-type cost rows — stored under the "other" cost type), then two small buttons (📷 general box photos, 📎 files) with thumbnails inline. No stacked label-above-field blocks.
- Removed the photo-required warning icon from product lines (the confirm button staying disabled is the signal).

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
