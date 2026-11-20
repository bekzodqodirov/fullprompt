# To'liq AI sotuvchi — BUILD PLAN: stage 0 «Bugun, kodsiz», stage 1a «To'siqlar olib tashlanadi», package «Hajm»

## 0. Header
| | |
|---|---|
| Stages | **0** «Bugun, kodsiz» (no product code) · **1a** «To'siqlar olib tashlanadi» · package **«Hajm»** (his 6c and 7b) |
| The owner stops | pressing ✅ on a greeting, an ordinary question, a qualifying question and (once «Narx» is ticked) a table price; finding a customer's photo or voice note met with silence; guessing why a reply waited |
| Size | stage 0: hours of his time + one read-only script · 1a: **S-M** (1-2 weeks with the reviews) · «Hajm»: **S** |
| Depends on | nothing built later. 1a needs stage 0's two counts only to SIZE the claim, not to compile. «Hajm» needs 1a merged (the seat must answer by itself before visitors are sent to it) |
| Read at | HEAD `bdd81f51`, ledger 151 (journal tail `0150_batches_view`, `when` …129); every reference re-checked at `bf37150c` (docs only between the two — «Verified references» at the end). `agent/` = `src/modules/wms/agent/`. Every file:line below was opened at that HEAD; re-read each named function on the tree you start from — where this file and the code disagree, the code wins |
| Contract | `docs/AI-SOTUVCHI-TOLIQ.md` §11 binds. The build contract is `docs/AI-SOTUVCHI-TOLIQ-QURISH.md` (present from `bf37150c`): it wins on process — its §3 (one stage = one branch = one PR = one deploy), §4 (rules no stage may undo), §5 (how a stage is run) |

You, the session building this, are the lead: branch from a fresh `origin/main`, read the tails of the migration
journal and of `DECISIONS.md` before you mint anything, talk to the owner in Uzbek plain text. No model identifier in a
tracked file («tez daraja» / «og'ir daraja»); no person's name, id or role key in code — people are picked on a screen (§3.2).

## 1. Behaviour, before → after

| Who | Before (HEAD) | After 1a |
|---|---|---|
| Customer, text only | the reply goes alone only when ~30 conditions hold; the model's own rating < the floor stops it; the 3rd machine reply in a row waits; nothing by itself 22:00-08:00 | ordinary talk goes at once, day and night (fresh inbound only); a table price goes 2 minutes after its card; 3rd, 4th… replies go until the LOOP detector trips |
| Customer, photo / file / voice only | `media_only` → no draft, no card, silence; `voice_only` → a notice to him, nothing to the customer (`worthy.ts:96-99` in `draftWorthy`, `run.ts:474-493`) | one honest system sentence («…yozib yuboring»), once per silence; he gets the card |
| Customer «3 kub 450 kg, narxi qancha?» | truck table figure; nothing ever offers customs; a VED job only if the customer names it (prompt rules 8, 11) | table figure at once + one offer sentence; «ha» → checklist → VED job (his 2a) |
| Customer «botmisiz?» | no draft, a notice to him (`worthy.ts` `bot_question`) | one honest system line, then the answer to the rest (his 1b) |
| Owner | a card per draft, each ringing; `/suhbatlar/ai` shows the last 20 with codes' words | cards of replies that went alone arrive SILENT; a morning line names every held reply and why; ten sent replies to mark each evening; a ping on cargo ≥ 20 kub or «fura» |
| Staff | nobody but the account holder hears anything | whoever HE designates for «big cargo» gets the ping (no customer text in it); nothing else changes |
| Website visitor («Hajm») | least-busy ticked seller | a setting may send every cargo visitor to the seat; any reason the seat cannot take one → the old roster |

## 2. His answers that bind, and what stays forbidden

`docs/AI-SOTUVCHI-TOLIQ.md` §11.1 rows, as rules of THIS plan:

- **name** «the persona is "GSR sotuv menejeri <ism>"; it never says it is a person» — the name is a setting, never a string in code. **1 b ⚠** (reverses 11-11 «botmisiz → to me», he saw it): asked, it answers ITSELF with one honest line and goes on.
- **2 a**: a bare price question with kub and kg → table figure at once, then «rastamojka bilan hisoblab beraymi?»; «ha» or an invoice → the VED job.
- **3 b + note**: ≥ 20 kub, or «to'liq mashina / fura» → the AI still answers and a signal goes; **who receives it and the threshold are chosen in the system** (§11.2). The 100 m³ / 20 t tool ceiling stays.
- **4 a ⚠** (reverses «tunda yo'q»): at night it answers a customer who writes, never first; cards to colleagues wait. **11 a ⚠**: talk at once; a price (table or VED) waits 2 minutes with ⏸.
- **5 b**: only he and his deputy write from the number — 1a builds the PAIR as data (§3.2), NOT the 15-minute climb and NOT a second presser (stage 1b/3a). **9 a**: ten of its messages with 👍/👎 every evening for the first month, then weekly — smallest form here.
- **10 c**: no daily money limit; the meter and the 20:00 line stay; nothing stops on dollars (§4.6 for the token/run fuses).
- **13 a**: until a speech service passes the trial the customer is told «ovozni hozir eshita olmayapman, yozib yuboring» and he gets a card.
- **31 c + note**: the seat STAYS in KPI, rating and congratulations; §6's «out of pay from 1a» is withdrawn. Its three-mode setting is NOT built here: ⟨1c⟩ mints the key `agent_won_ownership` with the one honoured value `seller` (= today), stage 5 builds the other two and the screen (`STAGE-4-6.md` §5.4 P5) — do not touch `staff/`, `staff-group`, `kpi-*`.
- **6 c**, **7 b**: package «Hajm» (§4.7). **12 a**: the session only — nothing here may name Telegram Business or Chat Automation.
- §8 «decided without a question» that land here: the two-in-a-row rule goes and a loop detector replaces it (⚠ shown on the page); no language shown → Uzbek Latin; `language` strict on money messages; ANY figure in his answer still comes back as a card; his own typing still pauses the AI; Pashto → one line asking for Russian or Persian.

**FORBIDDEN in these stages** (each is somebody's later stage or his for ever): a GS code, a won/lost stage, a deal;
the avia address; a rail price; a discount or any G2 promise class; relaying a colleague's or his figure without his
✅ (`owner_figure`, `not_reply` stay); a second message per turn or a holding line; a first message to anybody;
reading a photo, a file or a voice note; a card to anyone but the account holder; a second person pressing ✅; any
dollar ceiling; deleting a word table or a reader (`policy.ts`, `numbers.ts`, `digits.ts`, `locale.ts`,
`destination.ts`, `auto-money.ts` keep every rule — this plan adds CONSTANTS to `policy.ts` and changes no check);
a migration that flips a stored tick; raising `perChatPerDay` / `runsPerChatPerDay` (§4.6).

## 3. Data
### 3.1 One migration, additive — «the next after the journal's tail», tag `agent_toliq_1a`

Hand-written SQL + a journal entry whose `when` is the tail's + 1 (`tests/unit/migration-journal.test.ts`). It creates
three tables and **re-makes NO constraint and adds NO column to an existing table** (so it is not one-way, unlike
0148). CHECKs read and deliberately left as they are:

| Constraint (current definition, as read) | Why 1a does not touch it |
|---|---|
| `agent_auto_config_hold_check CHECK ("hold_sec" BETWEEN 30 AND 600)` (0145) | the price hold stays this column; the talk hold (0) is a settings key |
| `agent_auto_verdicts_feedback_check CHECK ("feedback" IS NULL OR "feedback" IN ('bad'))` + `…_feedback_sent_check ("feedback" IS NULL OR "state" = 'pressed')` (0145) | 👍 lives in `agent_samples`; 👎 keeps writing here through `autoFeedback` |
| `agent_auto_config_categories_check` — last re-made by 0149: the seven of `auto-categories.ts`, `cardinality >= 1` | the stored row is his; the gate stops READING the four ordinary ones (§6.2) |
| `agent_auto_config_confidence_check CHECK ("min_confidence" >= 0.5 AND "min_confidence" <= 1)` (0145) | the column stays, unread by the gate (never drop a column in the release that stops using it) |
| `agent_runs_trigger_check` (inbound, owner_edit, calc_answer, hand_back, style), `agent_drafts_kind_check` (reply, price, hand_back) | a system reply is trigger `inbound`, kind `reply`. The ONE big CHECK migration of TOLIQ §4 is stage 1b's |

```
agent_designations   topic text NOT NULL, user_id uuid NOT NULL REFERENCES users(id) ON DELETE CASCADE,
                     rank smallint NOT NULL DEFAULT 1, created_by uuid REFERENCES users(id), created_at timestamptz DEFAULT now(),
                     PRIMARY KEY (topic, user_id),
                     CHECK (topic ~ '^[a-z][a-z0-9_]{1,39}$'), CHECK (rank BETWEEN 1 AND 9)
agent_signals        id uuid PK, topic text NOT NULL, manager_user_id uuid NOT NULL REFERENCES users(id), peer_id bigint NOT NULL,
                     lead_id uuid, client_id uuid, facts jsonb NOT NULL DEFAULT '{}', dedupe_key text NOT NULL UNIQUE, created_at
agent_samples        day date NOT NULL, draft_id uuid NOT NULL REFERENCES agent_drafts(id) ON DELETE CASCADE,
                     manager_user_id uuid NOT NULL, peer_id bigint NOT NULL, pos smallint NOT NULL,
                     mark text, marked_by uuid REFERENCES users(id), marked_at timestamptz,
                     PRIMARY KEY (day, draft_id), CHECK (mark IS NULL OR mark IN ('good','bad')), CHECK ((mark IS NULL) = (marked_at IS NULL))
```

`topic` is a SHAPE check, never an enum: a later stage adds a topic with a key in the code registry (§3.2) and four
i18n strings — no migration. `agent_signals` and `agent_samples` are keyed by (manager, peer): add both to
`PURGED_TABLES` and `purgeAgentChat` (`agent/purge.ts:33`, `:143`) or `tests/unit/agent-fences.test.ts` goes red.
`lead_id` / `client_id` carry no FK on purpose (#285's shape). Declared in `platform/db/schema/agent.ts`.

**Probe** `agentToliq1aReady()` in `agent/config.ts` beside `agentFullP2Ready` (`:172`), same idiom (cached TRUE only,
`__forget…` / `__pretend…Behind` twins): `to_regclass` of the three tables. One migration behind: `designated()` answers
its last fallback (§3.2), no signal is sent (no row to claim it once — fail quiet, logged), the evening sample and its
line are skipped, the page draws neither new section. Everything else in 1a is code and settings and works without it.

### 3.2 The designation table (§11.2) — ONE home `agent/designations.ts` (new)

- `AGENT_TOPICS` — the code registry: `supervisor` («Rahbar va o'rinbosar»: rank 1 = he, rank 2 = his deputy, his
  5 b) and `big_cargo` («Katta yuk signali», his 3 b). Later stages add KEYS to this registry and nothing else —
  the table, its name and its shape are 1a's for good (`qurish/COVERAGE.md` §C.1): 3a `callback`, `pickup`, `buying`,
  `card_number`, `customs`, `logistics`, `money`, `warehouse` · 5 `big_customer`, `handover_seller` · 6
  `payment_claims`, `debt_request` · 7 `seat_phone`, `reserve_phone`. A key and a label key, nothing about people; a
  stored row whose topic is not in the registry is ignored. The owner-facing word for the `supervisor` pair is
  «rahbar va o'rinbosar» in every plan and every screen — never «nazoratchi», which reads as the position «Nazoratda».
- `designated(topic, handle?)` → people who can log in (`canLogInSql`, `platform/users/login.ts` — the
  `login-person-fence` allows no bare `users.active` read), by rank then name. **Fallback chain, never «nobody»:**
  the topic's rows → `supervisor`'s rows → the people today's agent alarms already reach (the account holder plus
  whoever the EXISTING alarm line names — `auto-send.ts:1267`, `usersWithRoles(…)` inside `stepDown`). **§11.2
  binds the fallback too: `designations.ts` writes no role key, no user id and no name of its own** — extract that
  existing line into ONE exported reader (`agentAlarmRecipients(holderId)` — a NEW name, exported from
  `auto-send.ts` where the line already lives, so the literal that is there moves nowhere and none is added; NOT
  from `config.ts`, which is in the listener's import closure (§9) and must not gain the notifications service) and
  call it; the door below likewise CALLS the existing predicate of `setAgentSeat` (`config.ts:623`), it does not
  restate a role. A source-shape test holds it (§7).
- `setDesignations(actor, topic, userIds[], ctx)` — replace-all per topic in one tx, audited. Door: the `super_admin`
  ROLE (the `setAgentSeat` precedent, `config.ts:623`); read: `mayRunAgent`.
- Screen: `/suhbatlar/ai` → new section «Kim javob beradi» (`agentAi.section.kimga`): one block per registry topic,
  a multi-select of staff, the rank by order, and beside each chosen person what `reachOf` would say today —
  «Telegram ulanmagan» for a person with no linked staff chat (a designated person who cannot be reached is the
  silent failure of `critic-feasibility.md` §C stage 3). An empty topic prints «belgilanmagan — hozir sizga keladi».

### 3.3 Settings keys (`platform/settings/service.ts` `SETTING_DEFAULTS` `:13`; each needs a doc comment, a validator in `SETTING_VALIDATORS` `:386`, an `OWN_DOOR_KEYS` entry `:412`, and `settings.descriptions.<key>` in all four bundles — `tests/unit/locales.test.ts:178-207`)

As read: `OWN_DOOR_KEYS` admits only the page values `'agentAi' | 'crmSettings'` (`OWN_DOOR_PAGES`, `:423`; the words are
`settings.ownDoorPage.<value>` in the bundles). `lead_assign_ai` lives on `/admin/taqsimot`, so it needs a THIRD page
value there (new) or the generic `/admin/settings` form would store it verbatim. The AI seat itself is NOT a
`SETTING_DEFAULTS` key (`platform/settings/agent-seat.ts:18` `AGENT_SEAT_KEY`, read raw by `agentSeatUserId(handle)`).

| Key | Default | Meaning | Door / page |
|---|---|---|---|
| `agent_persona_name` | `''` | the persona's name; empty = «GSR sotuv menejeri» with no name. ≤ 40 letters and spaces | super_admin, `/suhbatlar/ai` |
| `agent_talk_hold_sec` | `0` | hold of a talk reply (his 11 a). 0-600 | `mayTuneAuto` (`auto-send.ts:1435` — module-private today, like `mayArmAuto` `:1444`: put the writer beside it or export it) |
| `agent_night_prices` | `'table'` | `none` \| `table` \| `all` — which price classes may go 22:00-08:00 (§6.2, question 1) | `mayTuneAuto` |
| `agent_big_cargo_m3` | `20` | the big-cargo line; 0 = no size signal. 0-200 | super_admin |
| `agent_big_cargo_words` | `true` | «fura / to'liq mashina» alone also signals | super_admin |
| `lead_assign_ai` | `'off'` | `off` \| `all` — website cargo visitors to the seat (§4.7) | `/admin/taqsimot`, its own gate |
| `client_ai_contact` | `false` | show the AI number to clients with no seller (§4.7) | super_admin, `/suhbatlar/ai` |

The price hold stays `agent_auto_config.hold_sec` (default 120; no box today — P1 adds one, bounds 30-600). A key read
inside a transaction is read with `tx.execute` on that transaction, never `getSetting` (#714, `tests/unit/tx-pool.test.ts`).

## 4. Code
### 4.0 Stage 0 — no product code

**(a) His chores, in his words** (send as is; every name below was found in `messages/uz.json` → `agentAi.*`, `crm.*`,
`ws.*`, `routing.site.*`). Page: «Mijozlar va savdo → AI sotuvchi» → bo'lim «Sozlamalar».

1. «O'zi yuborish» → «Qaysi javoblar o'zi ketadi»: **«Narx»**, **«Hisoblatish (VEDga)»**, **«VED narxi (ustama bilan)»** ni belgilang → «Saqlash».
2. «VED javobiga ustama»: «Ustama (foiz yoki $; bo'sh — ustamasiz)» ga yozing yoki bo'sh qoldiring → «Saqlash» → **«✅ Ustama to'g'ri»**.
3. «Xitoy tarifi…» satri ostidagi **«✅ Tarif to'g'ri»** ni bosing.
4. «AI o'rni» → **«Bu akkaunt — AI sotuvchi»**.
5. «AI ishonchi kamida (%)» → **60** yozing (1a chiqquncha kerak; 1a dan keyin bu katak yo'qoladi).
6. «Mijozlar va savdo → CRM sozlamalari» → «AI sotuvchining bosqichlari»: **«AI birinchi javob berdi»** va **«AI narx aytdi»** uchun bosqich tanlang.
7. AI raqamining telefonida Telegram → Sozlamalar → foydalanuvchi nomi (@username) qo'ying. Keyin «Arizalar taqsimoti» → «Saytdan so'rovlar»da AI akkaunti yonida «@… · Telegram ulangan» chiqqanini tekshiring.
8. «Bilimlar» → «Umumiy bilim qo'shish» → «Javob — AI mijozga aynan shuni aytadi» ga Toshkent skladining ish vaqtini yozing → «Qo'shish».
9. «Hisoblash (VED) → Yo'lkira tarifi» → «Yiwu / Guangzhou → Toshkent» ustuni: 2027-yil narxi boshqa bo'lsa, «Amal qila boshlagan sana» = 01.01.2027 bilan yangi qator yozing → AI sahifasiga qaytib yana «✅ Tarif to'g'ri». (31.12.2026 dan keyin AI narxni shu ustundan oladi.)
10. Tekshiring: «Telegram ulash»da AI raqami **«Ish raqami»**, AI sahifasida «O'zi yuborishni yoqish» bosilgan.

UNVERIFIED: that a fact holding clock times («9:00-18:00») is quotable — a knowledge fact's bare figure vouches only for
a plain figure (#1610, P8). Before sending him step 8, run a reply quoting his sentence through `checkAgentReply` in a
scratch test with the fact in the run's memory, and give him a wording that passes G1.

**(b) Measurements** — ONE read-only script `scripts/agent-stage0.ts` with four subcommands, run as
`docker compose run --rm migrate pnpm exec tsx scripts/agent-stage0.ts <cmd> [--days N] [--day YYYY-MM-DD]` (never a
`package.json` command, #1228; precedents: `scripts/agent-census.ts`, `scripts/agent-calibration.ts`). The whole run
sits in ONE transaction opened with `SET TRANSACTION READ ONLY` — a bug cannot write — and its first output line says
«READ-ONLY, hech narsa yozilmadi». Helpers stay in the script and import only pure functions (`draftWorthy` — `agent/worthy.ts:91`; `mediaWord` — `agent/census.ts:96`, the census script's own helper).

| Cmd | Reads | Prints |
|---|---|---|
| `verdicts` (default `--day 2026-11-15`) | `agent_auto_verdicts` ⋈ `agent_drafts` (`policy.warnings` codes, `policy.notes`, `category`, `language`, `policy.memory.customerLocale`) ⋈ `agent_runs.tool_calls`; the `agent_auto_config`, `agent_send_caps`, `agent_config` rows as stored | the stored reason histogram; then per draft the reasons LEFT once 1a's retired/relaxed ones are removed (`low_confidence`; `streak`; `category` unless the label is `complaint`; `warnings` when every code is `questions`; `notes` when the only note starts «⏱ Mijoz»; `night` and `language` for a money-free, action-free draft by §6.2's rule) → «o'zi ketardi» / «baribir kutardi: …»; his stored ticks and floors. This is the «9 tadan nechta» number of the page |
| `media` | `tg_messages` of the holder ⋈ first attachment (the census query) | per Tashkent day and in total: bursts, bursts with a photo / a file / a voice note, media-ONLY bursts, and the same for the FIRST burst of each chat |
| `audience` | distinct peers with ≥ 1 inbound on the holder's account | clients / leads; with a seller / with none; wrote in the last 30 / 90 days; phone on the card or not; chats where our side wrote first |
| `volume` | `tg_messages`, `agent_runs`, `agent_outbox`, `agent_auto_verdicts` | per day: inbound lines, bursts, runs by outcome, `capped` rows by reason, drafts, machine presses, sends by status, distinct chats, turns per chat (median, max), peak hour, tokens and `approxMicroUsd` |

**(c) The speech trial (his 13 a)** — protocol `docs/ai-toliq/critic-stt.md` §4, unchanged: 25 real notes + 4 traps
picked from stored `voice_<msgId>.oga` attachments; one seller fills a fact sheet per note (~1 hour); run from the
PRODUCTION server through `migrate` (reachability from there is part of the test); the same bytes, untranscoded, to
three services (his list: ElevenLabs, OpenAI, one made in Uzbekistan); scored blind twice — the transcript, and the
facts the fast tier extracts from it — against M1-M10; pass = M1 ≥ 14 of 15, M2 ≤ 1, M6 = 0. `scripts/stt-trial.ts`
reads a JSON list of attachment ids, streams from `getStorage()`, prints transcripts and timings; it writes nothing to
the database or storage. Keys are typed by HIM into the server `.env` — never chat, repo or commit. UNVERIFIED:
outbound reach from his server to each provider. He sees the result as a table; nothing is built on it before stage 2.

### 4.1 Kernel K (the lead, first, one commit) — what every package compiles against

| # | File | Today (as read) | Change |
|---|---|---|---|
| K1 | `tests/unit/fixtures/agent-customer-safety/*.json` + `tests/unit/agent-customer-safety.test.ts` (new) | the 303 dangerous first replies exist only in `docs/ai-toliq/corpora/customer-safety/cases*.json` (151+88+14+15+14+21 = 303; fields `id, lang, cat, reply`, some `chatLang` (cases.json), `gloss`, `tool`) | copy them in; run each through the corpus harness's `pressedReasons` (`tests/unit/fixtures/agent-reader-corpus-eval.ts:200`, module-private today; export a `(lang, reply, outcomes?)` entry beside `explain`, `:336`) on **HEAD's rules, before any change**, and commit a snapshot `…-walls.ts`: per case, every reason that held it. UNVERIFIED that all 303 hold at HEAD under THIS harness (#1619 measured them with a scratch one): a case HEAD does not hold is listed as open with its reason, and that list may only shrink. This is `critic-guard.md` §C.2 step 1 and the oracle of §6.3 |
| K2 | migration, `schema/agent.ts`, `config.ts` probe | — | §3.1 |
| K3 | `settings/service.ts`, four bundles | — | §3.3 |
| K4 | `agent/designations.ts`; `notifications/mutes.ts:331` `UNMUTABLE_TYPES`; `notifications/night.ts:28` | cards go to `[managerUserId]` only (`drafts.ts:391`, `:542`) | §3.2; three new types `AgentSignal`, `AgentMorning`, `AgentSample` — all UNMUTABLE (they reach only people he chose; a muted one is the silent failure), `AgentSignal` and `AgentSample` night-silent (`NIGHT_SILENT_TYPES`), `AgentMorning` never sent at night. **Two derived fences in `tests/unit/agent-fences.test.ts` bite here (as read):** `:157` — every `UNMUTABLE_TYPES` member must be named in `purge.ts` `chatCardsWhere` or in the test's own `NO_CHAT` map with its reason (`AgentMorning` and `AgentSample` hold counts and a link → `NO_CHAT`; `AgentSignal` names a lead → blank it in `chatCardsWhere`); `:174` — every `AgentNotice` writer must carry `extra: { peerId: String(…) }` (P2's loop notice is one) |
| K5 | `agent/types.ts:70` `DraftPolicyJson.notes: string[]` | notes are untyped strings; the gate counts them (`auto-gate.ts:372`) | add `noteCodes?: NoteCode[]`, parallel to `notes`; every writer pushes its code: `run.ts:551-568` (incl. `settleCalcPrices` `:1783` and `lateNote` — `card.ts`, the «⏱ Mijoz …» line), `:1673-1705` (inside `validateActions`, `:1654`), `:1951-1959`, `:2005`, `calc-submit.ts:156-163`, `calc-loop.ts:1027`. Codes: `late`, `calc_below_minimum` (the truck-minimum note, `run.ts:1673` — found by the reference check, it was missing from this list), `calc_incomplete`, `calc_open`, `followup_bad`, `rail`, `tariff_mismatch`, `calc_price_unsaid`, `calc_price_many`, `answer_still_his`, `calc_recent`, `calc_file`, `price_only_customer`. Grep `notes.push(` / `notes.unshift(` / `notes:` under `agent/` again on your tree — a writer with no code is a machine stop. A draft stored before 1a has notes and no codes → reads as a machine stop (fails closed) |
| K6 | `agent/auto-gate.ts` `AutoGateInput` (`:226`) | `draft.warnings: number`, `draft.notes: number`, `streak: number`, `config.minConfidence` | `draft.warningCodes: string[]`, `draft.noteCodes: string[] \| null`, `draft.systemAck: boolean`, `loop: boolean`, `complaint: boolean`, `nightPrices`, drop `streak` and `minConfidence`; export `autoClassOf(input): 'talk' \| 'price' \| 'calc_price' \| 'calc'` (from `moneyVerdict` and `isCalcSubmitOnly`), `EYE_ONLY_WARNINGS = ['questions']`, `EYE_ONLY_NOTES = ['late']`, `RETIRED_REFUSAL_WORDS` (`low_confidence`, `streak`, `category` — words only, so stored rows keep printing through `auto-card.ts:67-84`). Packages fill the readers |

### 4.2 P1 «To'siq» — the gate, the hold, the press (owns `auto-gate.ts`, `auto-send.ts`, `auto-card.ts`, the auto panel of `agent-ui.tsx` / `page.tsx`, `decide.ts:1086`)

| Where | Today | Change |
|---|---|---|
| `auto-gate.ts:445` | `confidence === null \|\| < minConfidence` → `low_confidence` | deleted. `confidence` is still stored on the draft and the verdict row (the sample weights by it). Remove the page box (`agent-ui.tsx` `AutoConfidenceForm`, `:932`), `setAutoMinConfidence` (`auto-send.ts:1581`), its web action `agentAutoMinConfidenceAction` (`web-actions.ts:454`) and keys (`agentAi.autoConfidenceLabel`; the `{confidence}` part of `agentAi.autoNumbers` / `autoNumbersNoCap`, drawn at `page.tsx:863-865`) — a control off the screen whose action still answers is hidden, not removed |
| `:371` / `decide.ts:1086` | any warning refuses (`warnings`; at the press `auto_warning`) | only codes outside `EYE_ONLY_WARNINGS` refuse — ONE exported predicate asked at both places. `avia_maybe`, short `fingerprint`, one-word `staff_name` keep stopping; a NEW warning code stops until somebody lists it |
| `:372` | any note refuses | only codes outside `EYE_ONLY_NOTES` |
| `:424-434` | the label must be one of `LABEL_CATEGORIES` AND ticked → `category` | the label is free; new refusal **`complaint`** when the label is `complaint` OR `input.complaint` (P3's reader). The four ordinary ticks are no longer read and leave the page; `setAutoCategories` (`:1509`) always stores them and adds what he ticks of the three (the CHECK wants ≥ 1). `status_unbacked` (`:437`) stays on the label |
| `:438`, `:531` `languageAdmits` | one rule for every reply | §6.2 — today's rule for every class but `talk`; a talk rule beside it |
| `:443` | `media` | unchanged, except never asked of `draft.systemAck` |
| `:456` | night at the send moment OR at the card's arrival → `night` | asked only of a night-BARRED class (§6.2). The pump's own rule is untouched (`send-step.ts:664` `releaseAt`: at night an approval goes only when the customer wrote ≤ 2 h ago — that IS «javob beradi, birinchi yozmaydi») |
| `:457`, `:224`, `auto-send.ts:259` `autoStreak` | 2 machine replies in a row | deleted with its reader; `loop` (P2) takes its slot in `AUTO_REFUSALS` |
| `auto-send.ts:573` `autoPlanFor` (`:580`) | `dueAt = now + config.holdSec` for every reply | `holdSecFor(class)`: `talk` → `agent_talk_hold_sec`; every other class → `config.holdSec`. Store nothing new: the press recomputes the class from fresh facts |
| `:851` `pressOne` (the rang rule `:875-879`, the hold `:888-895`) | no press until the card has been on his screen a whole hold; a copy that did not RING → `night` (`copyRang`, `:649` — a copy sent with `payload.silent` never «rang») | with hold 0 neither is asked; a night-admitted price counts its hold from the card landing, rung or not |
| `:667` `countdownMayRide` | a countdown rides only a copy that rang within one hold | a hold of 0 «does not count down»: it rides any copy, as every plain card does — or each talk reply mints its own card |
| new `pressNow(draftId, now)` | the minute sweep alone presses (`jobs.ts:543`) | claims that ONE row when it is due and runs `pressOne`; `run.ts` calls it after `writeDraft` inside its own try/catch. The sweep stays the net |
| `drafts.ts:391` | every card rings by day | `silent: true` in the card's payload when the plan is eligible with hold 0 (`sendsSilently` already honours it) — only what waits for him rings |
| `auto-send.ts:1318` `autoFeedback` | the holder alone | holder, or a super_admin while `holderIsSeat` — the `mayArmAuto` rule (`:1444`); the sample's 👎 calls it |
| `:1375` `autoStepDownOnBotQuestion`, `AUTO_STEP_DOWN.botQuestionChatsToDisarm` | «botmisiz?» after a machine reply → chat off 30 days, 2 chats → disarm | deleted (his 1 b: it is answered now). The 👎 and block step-downs stay |

### 4.3 P2 «Halqa» — ONE loop detector (new `agent/loop.ts`; owns `eligibility.ts` and `eligibilityFacts` in `run.ts:301-391`)

Replaces `repeat` (`eligibility.ts:83`, fed by `run.ts:389`: the anchor equals one of the peer's previous three lines →
no draft, no word to anybody) and `streak`. Pure `loopVerdict(facts)`, facts from ONE statement over the chat's last
`LOOP_WINDOW_MS` (30 min; constants in `limits.ts`, one home):

| Signal | Rule | Where asked |
|---|---|---|
| `same_inbound` | the anchor's folded text (`textFingerprint`, `policy.ts:2718`, read-only) equals **two or more** earlier inbound lines of the window — the FIRST repeat is answered (an impatient customer), the second stops | eligibility |
| `fast_peer` | three inbound lines in the window, each ≤ 10 s after one of OUR machine sends (the 5-second `echo` clause stays for the single case) | eligibility |
| `own_repeat` | the draft's fingerprint equals one of our last three machine sends to this chat in the window | the gate (it needs the body) |

Eligibility refuses with `loop` (`repeat` stays readable in old `agent_runs` rows) and — unlike today — says so ONCE: an
`AgentNotice` claimed by an `agent_signals` row keyed `loop:<peer>:<window start>` («🔁 Bu suhbat aylanib qoldi (avtojavob
bo'lishi mumkin) — AI to'xtadi, o'zingiz qarang.», no customer text). The gate's `loop` leaves a card. Stateless.

### 4.4 P3 «Ovoz» — persona, the Q2 rule, system replies (owns `prompt.ts`, `tools.ts` texts, `worthy.ts`, new `agent/system-reply.ts`, `agent/complaint.ts`, the worthy branch of `run.ts:475-493`)

- **System replies** (`system-reply.ts`): `SYSTEM_LINES: Record<'voice' | 'media' | 'pashto', Record<AgentLocale, {text, glossUz}>>`
  and `systemReplyFor(ctx, reason)`. In `handleInbound`, a burst `draftWorthy` calls `voice_only`, `pashto`, or
  `media_only` with at least one KEPT photo or file (a sticker-only burst stays skipped — as read, `context.ts:492`:
  a kept file is a burst line whose `media` is `'photo'` or `'document'`; a `has_media` line with no stored
  attachment — a sticker, a round video, a file storage refused — reads `'other'`, and a video FILE reads
  `'document'`) no longer ends there: eligibility (`eligibleForRun`) → `reserve` (`run.ts:399`; a zero-token `inbound` run — the caps and
  the ledger count it like any run) → a `ComposeReply` made by CODE (no model call) → `memoryFor` / `policyFor` on it
  as on any reply → `writeDraft` with `policy.system = reason` and the auto plan. Language: the chat's stored locale,
  else `uz`; Pashto: the line is said in Persian and Russian together. **Once per silence**: when our last out line
  in the chat is itself a system line, the burst is skipped as today. Three wordings per line, picked by a hash of
  the peer (G10 counts identical text). The owner's notice (`drafts.ts:526` `NOTICE_WORDS`) becomes the draft's own
  card with a note. Not armed, or held by any rule → an ordinary card for his ✅: still better than silence.
- **«Botmisiz?»** leaves `draftWorthy`'s notice list (`worthy.ts:95`): the run goes on, and `withBotAnswer(compose, ctx)`
  — beside `withRailRule` (`run.ts:1569`) on BOTH run paths — prepends `AI_HONEST_LINE[language]` when the burst asks
  (`asksIfBot`). Code says it, so it is said; `ai_denial` (`policy.ts:1827`) still reads the whole text.
- **Complaint tripwire** (`complaint.ts`, `complaintIn(texts)`): a closed six-language list over the CUSTOMER's
  burst — «menejer kerak», «rahbaringiz bilan», «shikoyat», «pulimni qaytaring», «aldadingiz», «sudga», жалоба,
  «верните деньги», «позовите менеджера», refund, «real person», 投诉, 退款, شکایت. A hit → gate `complaint`.
  A false hit costs one card; it is a new free-text reader, so it gets corpus cases of both kinds (§6.3).
- **Prompt** — §6.1. **Owner's name out of code**: 18 runtime strings hold it today (`prompt.ts:71, 73, 74, 82, 85, 87,
  91` — the style heading — `, 167`; `tools.ts:224, 394, 636, 672, 674`; `owner-answer.ts:95-96`; `lessons.ts:539`;
  `lesson-rules.ts:30` — the lessons block's heading; `policy.ts:2818`; grep the name case-insensitively under
  `agent/` on your tree, comments excepted) — each becomes «rahbar». A persona may carry the owner's own name; left
  as they are, the prompt calls the model its own boss.
- **The persona's name and `staff_name` (found by the reference check — a step of P3, not a new rule):**
  `policyFor` hands `checkAgentReply` the names of every colleague who can log in EXCEPT the account's own user and
  the chat's manager (`policy-input.ts:133` `staffNamesExcept`); `staffNameHits` (`policy.ts:2462-2480`) BLOCKS on a
  colleague's whole name and WARNS on any one word of it. When the holder is the AI seat, the owner is a colleague —
  so a persona named after a real staff member makes every «men … <ism>man» a `staff_name` warning, and 1a keeps
  `staff_name` a machine stop (§4.2): the AI's own introduction would wait for a ✅ every time. Pass the persona word
  to `policyFor` and leave it out of the colleague list for that ONE word only (the `customerNames` / `factNameWords`
  exemptions at `policy.ts:2841` are the model), with a test both ways: the persona's first name goes; the same
  colleague's FULL name, and any other colleague's name, still stop. Never by adding `staff_name` to `EYE_ONLY_WARNINGS`.

### 4.5 P4 «Signal» — big cargo, the morning line, the sample (new `agent/big-cargo.ts`, `signals.ts`, `morning.ts`, `sample.ts`; two schedules in `jobs.ts`; two page sections)

- **Big cargo** — pure `bigCargoOf(ctx, outcomes, settings)`: the newest stated volume (`newestMeasure`, `tools.ts:296`,
  or a priced estimate's `m3`) ≥ `agent_big_cargo_m3`, or (`agent_big_cargo_words`) `saysFullTruck(burst)` — «fura»,
  «to'liq mashina», «фура», «полная машина», «full truck», FTL, 整车, 整柜, «کامیون کامل». Called in `handleInbound` AFTER
  `writeDraft`, in its own try/catch (a signal never costs a draft). `sendSignal` claims `agent_signals` with
  `big_cargo:<peer>:<Tashkent ISO week>` (one per chat per week), then `notifyStaffTelegram` to `designated('big_cargo')`.
  Text **per recipient**: «🚛 Katta yuk: 24 kub · 5 200 kg · AI javob berdi.» for everybody; the lead's name and
  `/crm/<id>` only for a recipient who may read that lead (the board's own rule — the permission
  `crm.leads.view_all`, asked through the board's EXISTING predicate; never a role restated here); NEVER the
  customer's words or phone (round 20: a chat is private to its account).
  **His 4 a («cards to colleagues wait for the morning»):** `AgentSignal` is night-silent — the house's own meaning of
  «waits for the morning» (`notifications/night.ts`: delivered with no ring, read in the morning). That is all 1a
  has; from 3a a colleague's copy rides `notify_after` (the next working minute) like every colleague card
  (`STAGE-3A.md` §4.1) — which of the two he wants is the question «Tungi kartalar hamkasblarga» in
  `qurish/COVERAGE.md` («Still to ask him»).
- **Morning line** — `morningFacts(day)` + pure `morningLine(facts)`; schedule `'40 3 * * *'` (08:40 Tashkent) to
  `designated('supervisor')`. Yesterday (Tashkent): reply drafts, how many the machine pressed, and the rest grouped by
  ONE reason each — a draft with several is counted under its FIRST in `AUTO_REFUSALS` order — through one word map
  `MORNING_WORDS` (the page's nouns: «rasm yoki fayl», «narx — "Narx" belgilanmagan», «savol sizga», «shikoyat»,
  «til aniq emas», «halqa», «tun»…); then no-draft bursts from `agent_runs` (`refused` / `capped` by `error`), cap
  hits by name, and unmarked samples older than 48 h. Shape: «🌅 AI sotuvchi, kecha: 14 javobdan 11 tasi o'zi ketdi.
  3 tasi sizni kutdi: 2 — rasm yoki fayl, 1 — kod so'radi. Javobsiz: 0. Belgilanmagan tekshiruv: 10 ta.» Counts only,
  never a customer's text (leak-13).
- **Sample (9 a, smallest form)** — schedule `'10 15 * * *'` (20:10): pick ≤ 10 of the day's machine-pressed replies
  whose outbox row is `sent`: money replies first, then lowest stored `confidence`, then by a hash of (day, id);
  insert `agent_samples`; ONE `AgentSample` line («🔎 Bugungi tekshiruv: 10 ta javob — 5 daqiqa» + the page link, which
  the drain turns into «↗️ Ochish»). Page section «Kunlik tekshiruv»: each row = the customer's line, the reply,
  «👍 To'g'ri» / «👎 Xato edi». 👍 writes `mark = 'good'`; 👎 writes `bad` AND calls `autoFeedback` (the same counter:
  that chat off 30 days, two in seven days disarm — the confirm text already says so). Daily while the first sample
  is < 30 days old, then Fridays only (derived from `min(day)`; no setting). Door: P1's widened one.

### 4.6 His 10 c and the fuses in `agent/limits.ts` — KEEP, do not raise, make loud

| Fuse | Value, where | Ruling |
|---|---|---|
| dollars | no ceiling exists; the 20:00 line (`reports/ai-spend.ts`) is a meter | nothing to build; add none |
| `daily_token_cap` | 3 000 000, `agent_config`, box «Kuniga tokenlar» (`today.ts:67` `capReached`) | it is the one fuse that reads as a money stop. KEEP — it is what bounds a runaway loop when no dollar limit exists — but re-word its hint and its notice (`drafts.ts:550` `notifyCapReached`) from «byudjet» to «xato halqasidan himoya; pul chegarasi emas, xohlasangiz oshiring», and the morning line names every day it tripped. No migration raises his stored number |
| `daily_draft_cap` | 150 runs, box «AI kuniga ishga tushishi» | same; after stage 0's `volume` tell him the number to type (≥ 3× the measured peak day) |
| `runsPerChatPerDay` 12, `perChatPerDay` 12 | constants (`limits.ts:60-62`); the second is read by the LISTENER's send step | UNCHANGED in 1a. They are the only thing that ends a robot-to-robot chat if the new detector misses, and making the second a setting means a new reader in the listener. The morning line counts `chat_runs` hits so the number that moves them to 1b is his own |
| `perHour` 20 / `perDay` 80 | `agent_send_caps`, boxes exist (≤ 100 / ≤ 200) | his to raise; say so before «Hajm» is flipped |

### 4.7 P5 «Hajm»

- **6 c — `lead_assign_ai`** in `assignForTag` (`crm/site-assign.ts:265`), after the existing-tag branch and before
  `pickAssignee`: when the mode is `all` and the team is not `buying`, ask `seatCandidate(tx, now)` — ONE statement on
  the transaction (the 400 ms `statement_timeout` and the `lead_assign` advisory lock are already set at `:270-271`; #714): the holder is the seat (`agent_seat_user_id` — `holderIsSeat(tx)` / `agentSeatUserId(tx)` in `platform/settings/agent-seat.ts` take the transaction as their handle), `agent_config.mode = 'shadow'`
  with the session confirmed, the auto layer armed, the account not paused and its pump stamp fresh
  (`tg_account_guard`), a VERIFIED handle read ≤ 1 h ago with the bridge live (`reachableAt`'s rule,
  `site-assign-rules.ts:182` — never a typed handle), today's AI sends (`OUTBOX_GOING`) at least 10 under the effective
  day cap, and `aiConfigured()`. Yes → the offer row is the seat's (`capturable: true`, `ranking: {ai: true}`); **any no → the old
  roster, unchanged** — the site is never told «nobody» because of the AI. `buying` never reaches this branch.
  Panel (`admin/taqsimot/site-panel.tsx`): a two-way choice «Yuk bo'yicha so'rovlar: sotuvchilarga / AI sotuvchiga»
  and, when on, one line of truth: «AI hozir qabul qiladi» or «AI hozir qabul qila olmaydi (<sabab>) — so'rovlar
  sotuvchilarga boryapti». (Option b of his Q6 needs no code: tick the seat as a person on the same panel.)
  **When to flip — recommend to him: not before stage 2.** The visitor's first message is the site's text line, which
  1a answers; the second is usually a photo or an invoice, which 1a can only answer «yozib yuboring», and a committed
  visitor still stops at him for the code (1c). Earliest honest moment: a week of morning lines after 1a, stage 0's
  `media` share in hand, and «Kuniga ko'pi bilan» raised to the site's volume. The flip is his tick, not a deploy.
- **7 b — one message through the company bot**: `platform/broadcast/service.ts:30` `audienceSchema` gains
  `noManager: boolean` → `c.sales_manager_id IS NULL` in `audienceChats` (`:60`); the composer
  (`admin/xabarlar/composer.tsx`) gains the tick «Sotuvchisi yo'q mijozlar». He sends it himself on «Mijozlar va savdo
  → Xabar yuborish» (`mayBroadcast`: super_admin). Proposed text: «Assalomu alaykum! GSR LOGISTICS'da savollaringizga
  tez javob beradigan yangi raqam ochildi: @<username> (GSR sotuv menejeri <ism>). Narx, yuk holati va manzillar
  bo'yicha shu raqamga yozishingiz mumkin.» — plus the Russian twin (the audience's `locales` filter splits them).
- **Where such a client sees the number**: ONE read, `managersFor` (`client-cabinet/service.ts:1102`) — it feeds the
  bot's «💬 Menejer», the Mini App contact card and the pushes' `mg` door. With `client_ai_contact` on, a client whose
  `sales_manager_id` is NULL (or names a person who can no longer log in) gets the seat: name «GSR sotuv menejeri
  <ism>», no phone, `https://t.me/<verified fresh handle>`; no verified fresh handle → the office contact as today.
  A client WITH a seller never sees it (his «sotuvchilarning o'z mijozlariga aytilmaydi»).

## 5. Doors and sight

| Thing | Who | Predicate |
|---|---|---|
| ✅ / ✏️ / ❌ / 🙋 / ✍️ on any card | the account holder alone — unchanged | `decide.ts:960`, `:1421` (`not_account_holder`); his answer 15 |
| the machine's press | nobody (`actorId: null`, `via: 'auto'`) | `pressOne`; gate re-judged on fresh facts |
| hold, night setting, kinds | holder or super_admin | `mayTuneAuto` |
| persona, big-cargo line, designations, `client_ai_contact` | the super_admin ROLE | as `setAgentSeat` |
| sample 👍/👎, `autoFeedback` | holder, or super_admin while the holder is the seat | `mayArmAuto`'s rule |
| «Kim javob beradi», «Kunlik tekshiruv» sections | `mayRunAgent` to read | `config.ts:314` |
| a big-cargo signal | the people he designated | text per recipient (§4.5) |

Law 4: nothing in 1a shows a price to the VED or a floor to a seller — the signal carries kub and kg, never a price;
the holder's `calcLine` (`types.ts` `CardMemory`) still reaches the holder only. Identity: untouched — `cargoAllowed`
(`context.ts` `chatIdentity`) still decides cargo and balance; a system reply states no cargo, money or code. A reply
that called `own_balance` is still `money` and still his (25 b is a later stage). A colleague's customer on the seat
(his 8 b): table prices already go; the seller's price outranking the table is NOT built here.

## 6. Prompt, policy and gate
### 6.1 `agent/prompt.ts` `stableHead` (`:56`) — ONE cache write on deploy day

| Rule | Today | 1a |
|---|---|---|
| head `:71` | «…rahbari <ism>ning shaxsiy Telegram akkauntidagi … QORALAMASINI yozasan … uning nomidan» | «Sen GSR LOGISTICS … sotuv menejeri<, ism>san — kompaniyaning AI yordamchisi. Mijozlarga Telegramda o'zing javob yozasan, birinchi shaxsda. O'zingni hech qachon odam dema. Maqsading — mijozning yukini biz orqali jo'natishiga yordam berish: har javob keyingi qadamni aytsin.» `persona` is a REQUIRED input of `stableHead` (the `priceArmed` precedent), read once per run from `agent_persona_name` |
| 8 `:81` (yo'lkira → `yolkira_estimate`) | prices, hedge, exclusion sentence | + «Narxni aytgandan keyin, shu chatda hali so'ramagan bo'lsang va ochiq hisoblatish bo'lmasa, aynan shu jumlani qo'sh: «<CUSTOMS_OFFER_SENTENCE>»» |
| 11 `:84` (customs → `calc_checklist` → `actions: calc_submit`) | «bo'limni aytmagan bo'lsa — so'ra, o'zing tanlama» | + «Shu taklifingga mijoz "ha" desa yoki invoys yuborsa — bo'lim podklyuch, so'rama: calc_checklist(section="podklyuch")». The tool's `section === ''` answer (`tools.ts:693`) stays for every other case |
| 1, 9, 12, 14, style heading, `:167` | the owner by name | «rahbar»; rule 12's logic unchanged (the code is his until 1c) |
| new 17 | — | «"Botmisiz?" savoliga javobni tizim o'zi qo'shadi — bu haqda yozma, savolning qolganiga javob ber.» |
| new 18 | — | «[rasm], [fayl], [ovozli xabar] — ularni ocholmaysan. Ochgandek gapirma; kerak bo'lsa "hozircha ocha olmayman, yozib yuboring" de.» |

The VED path, unchanged and named for the builder: `calc_checklist` (`tools.ts:690`) → complete → the model puts
`calc_submit` in `compose_reply.actions` (`tools.ts:218`) → `validateActions` (`run.ts:1654`) → gate class `calc` (tick
«Hisoblatish») → the press → `decideDraft` → `landCalc` (`decide.ts:515`, `:1186`) → `landIntake`
(`calc/intake-land.ts:449`). An invoice FILE rides to the VED on the note (`calc-files.ts`) but fills no checklist line
in 1a — the customer is still asked the goods and one measure per line.

Exact words (constants in `policy.ts` beside `EXCLUSION_SENTENCE`, six languages; fa / zh carry a stored Uzbek gloss):
- `CUSTOMS_OFFER_SENTENCE.uz` «Xohlasangiz, rastamojkani ham alohida hisoblab beraymi?» · ru «Если нужно, отдельно посчитаю и растаможку — посчитать?» — the word «alohida / отдельно» is deliberate: G11 demands that every clause naming customs say «apart» (`policy.ts:1908-1922`), and «с растаможкой» is a `customs_included` promise (`:1066`). UNVERIFIED until the test of §7 runs: if a language cannot pass, change the WORDING, never the check.
- `AI_HONEST_LINE.uz` «Ha, men GSRning AI yordamchisiman; kerak bo'lsa menejerni chaqiraman.»
- `SYSTEM_LINES.voice.uz` «Ovozli xabaringizni hozir eshita olmayapman — iltimos, yozib yuboring.» · `.media.uz` «Faylni oldim, lekin hozircha ocha olmayapman. Iltimos, yuk nomi, hajmi (kub) va og'irligini (kg) yozib yuboring.» · `.pashto` fa «لطفاً به فارسی یا روسی بنویسید.» + ru «Пожалуйста, напишите на русском или персидском.»

### 6.2 The gate, rule by rule (`AUTO_REFUSALS`, `auto-gate.ts:37-91`)

| Code | 1a | Why |
|---|---|---|
| `low_confidence` | LEAVES | a self-report the tool text tells the model to keep low (`tools.ts:224`); the model's real «I do not know» is `needs_owner`, which stays |
| `warnings`, `notes` | TYPED (§4.1 K5-K6, §4.2) | `questions` and the late note free a reply; every other code stops as before |
| `category` | → `complaint` | the label no longer admits; the complaint label and the tripwire deny |
| `streak` (+ eligibility `repeat`) | → `loop` | §4.3 |
| `night` | by class | barred: `calc` always (a VED job at night rings a colleague — «kartalar ertalab»); `calc_price` unless `agent_night_prices = 'all'` (his SPEC-P2 Q9 «faqat kunduzi» was never re-asked — question 1); `price` only when `'none'`; `talk` never |
| `language` | `talk`: relaxed · every other class: today's `languageAdmits`, byte for byte | talk admits: a confident read of that very language; an unconfident read of uz / uz_cyrl / ru in any of those three; NO language shown (`locale === null`) → `uz` only (a Cyrillic «5 куб 800 кг» is answered in a Cyrillic language, which this does not admit — today's one press, question 7). Still held for talk: a confident mismatch, en / fa / zh without a confident read, no stored guess |
| `media` | stays (not asked of a system reply) | eyes are stage 2 |
| `not_armed`, `agent_off`, `not_pending`, `blocked`, `actions`, `not_reply`, `owner_figure`, `owner_personal`, `answer_stale`, `needs_owner`, `status_unbacked`, every money and calc code (`money`, `money_unread`, `numeral_unread`, `estimate_unnamed`, `estimate_moved`, `tariff_unconfirmed`, `foreign_destination`, `destination_unsaid`, `markup_unconfirmed`, `calc_price_moved`, `calc_owner_priced`, `calc_person_offer`, `calc_identity`, `calc_foreign`, `calc_refused`, `calc_recent`, `calc_file_missing`), `too_long`, `stranger`, `prospect`, `chat_off`, `human_active`, `chat_muted`, `not_work_account`, `daily_cap`, `budget_spent`, `sending_disabled`, `listener_behind` | STAY, untouched | `critic-guard.md` §D.1; his Q2 a ⭐ of SPEC-P1; «o'zim yozgan chatda AI jim» |

`policy.ts`: no check changes. `eligibility.ts`: `repeat` → `loop`; `human_active` untouched.

### 6.3 Corpora and fences that stay green, and what is EXPECTED to change

- `tests/unit/agent-reader-corpus.test.ts` (fixtures `agent-reader-corpus.ts` — 1,483 cases at this HEAD, readers
  `avia`, `destination`, `language`, `owner_figure`, `money`, `han`, `han_g1`, `lesson`, `phone` — `-eval.ts`, ratchet
  `-known.ts` `KNOWN_HELD`): **no existing case changes its expectation.** The `language` reader is judged today on a
  money-free `faq` draft (`-eval.ts` `eligibleInput()`, `:116` — a literal `AutoGateInput` that K6's new field shape
  forces you to edit, see below) — 1a relaxes exactly that shape, so the eval's `language()` (`:264`) must
  judge on the admitted truck quote that `destination()` (`:235`) already builds. That move is the decision
  «`language` stays strict on money messages» written into the oracle; every `LANGUAGE_DANGEROUS` row then holds as
  before. ADD a reader `language_talk` (the same inputs on a talk draft) with a per-row label written by hand from
  §6.2's table — never computed by the code under test — and readers `complaint` and `full_truck` with both kinds.
  The ratchet may only shrink. `owner_figure`, `money`, `han`, `han_g1`, `avia`, `destination`, `lesson`, `phone`: untouched.
- `tests/unit/agent-policy-first-reply.test.ts`: every VERDICT untouched and green — 1a changes no policy check; if
  one moves, a check moved. As read, the file is NOT untouchable: it builds two `AutoGateInput` literals (`:1979`,
  `:2075` — `minConfidence`, `warnings: 0`, `notes: 0`, `streak: 0`), so K6's type change stops `pnpm typecheck` there
  until their FIELDS are re-shaped. A mechanical edit of the two fixtures, never of an expectation.
- The 303 (`agent-customer-safety.test.ts`, K1): **none newly goes.** Each case must still be held by a reason 1a keeps;
  a case whose K1 snapshot shows ONLY `warnings:questions`, `low_confidence`, `category` or `language` as its wall is a
  finding to bring to him before the code that frees it merges.
- Tests that pin what 1a removes are REWRITTEN, each with the reason in its title: `agent-auto-gate.test.ts` and
  `agent-auto.integration.test.ts` (streak, confidence, category, night, bot-question step-down),
  `agent-full-p2-price.integration.test.ts` and `agent-owner-answer.integration.test.ts` (the streak «pinned as his
  rule»), `agent-auto-card.test.ts` (words), e2e `m9zzzg-ai-sotuvchi` (the two tests that read the confidence box:
  `:107` «the owner is offered the page…» at `:146-147`, and `:265` «the holder is offered «O'zi yuborish»…» at
  `:285-287`), and the ten unit files that call `stableHead(` (`agent-answers`, `agent-answers-third`,
  `agent-china-addresses`, `agent-full-p1-price`, `agent-full-p2-after-sent`, `agent-full-p2-price`, `agent-lessons`,
  `agent-owner-answer`, `agent-policy-brain-fix`, `agent-policy-first-reply`). Every other literal `AutoGateInput`
  is re-shaped mechanically for K6 (grep `streak:` under `tests/`): `tests/unit/agent-full-p2-price.test.ts:162` and
  the corpus eval's `eligibleInput()` beside the files above.

## 7. Tests to write (each shown RED by a paired string edit — never `git checkout`, #430)

| Test | Proves | Red proof (strip → what fails) |
|---|---|---|
| unit `agent-toliq-1a-gate.test.ts` | each row of §6.2 on BOTH sides: confidence 0.3 goes; `questions` goes and `avia_maybe` stops; the late note goes and `calc_open` stops; a pre-1a draft with notes and no codes stops; label `other` goes, `complaint` and a tripwire hit stop; night × class × setting | put `low_confidence` back → the 0.3 case; empty `EYE_ONLY_NOTES` → the late note; drop the complaint clause → both complaint cases; make `calc` night-free → the VED-at-night case |
| unit `agent-loop.test.ts` | first repeat answered, second stopped; three fast lines; `own_repeat`; an old window clears | `>= 2` → `>= 1` (the first repeat stops); drop `own_repeat` |
| unit `agent-system-reply.test.ts` | every line × six languages passes `checkAgentReply` with zero blocks and zero machine-stop warnings on a real run's memory; fa / zh carry a gloss; once per silence | blank one gloss → `gloss_missing`; remove the «last out is a system line» check → a second ack |
| unit `agent-customs-offer.test.ts` | a real truck quote + the offer passes in six languages; «Rastamojka bilan 390 $», «rastamojka ham shu narxda — hisoblab beraymi?» still block | replace «alohida» in the constant → blocked |
| unit `agent-persona.test.ts` (source-shape + render) | `stableHead` prints the persona from its argument ('' and a fixture word) and nowhere else; the 18 owner sites (§4.4) interpolate ONE exported word (counted with TypeScript's parser, comments stripped — #725), so no test holds a person's name either; `withBotAnswer` prepends once; the persona word alone does not warn `staff_name` when a colleague carries it, while that colleague's full name and any other colleague's name still stop (§4.4) | inline one site's word → the count drops; drop the prepend; drop the persona exemption → the self-introduction warns |
| unit `agent-designations.test.ts` + integration | the fallback chain never answers empty; a leaver is skipped; replace-all; an unknown topic is ignored; the door is `setAgentSeat`'s own; **source-shape (TypeScript's parser, comments stripped — #725): `designations.ts`, `signals.ts`, `big-cargo.ts`, `morning.ts`, `sample.ts` and the migration hold no role-key string, no uuid literal and no person's name (§11.2)** | remove the last fallback → «nobody»; write a role key into `designations.ts` → the shape test |
| unit `agent-big-cargo.test.ts`, `agent-morning.test.ts`, `agent-sample.test.ts` | thresholds and words; one signal per chat per week; the per-recipient text never holds a customer line; the line's counts add up to the drafts; first-reason grouping; pick order money → low confidence | drop the dedupe key; count every reason → the sum breaks |
| integration `agent-toliq-1a.integration.test.ts` | a talk draft is due at once and `pressNow` presses it with no card on screen; a price waits its hold and needs the card; a silent card for hold 0; a media-only burst → a system draft → pressed; night: talk goes, `calc` waits; one migration behind (`__pretend…Behind`) nothing throws | restore the card requirement for hold 0 → the talk press defers |
| integration `site-assign` (extend), `broadcast` (extend), `client-cabinet` managers | mode `all`: cargo → seat, `buying` → roster; each single reason the seat cannot take one → roster; `noManager` audience; a sellerless client sees the seat only with the setting and a fresh verified handle | drop one clause of `seatCandidate` at a time |
| fences | `tx-pool` (the setting read on the tx), `agent-fences` (purge), `locales` + `i18n-keys` (new keys ×4), `migration-journal`, `tg-listen-agent-wire` | — |
| e2e | `m9zzzg-ai-sotuvchi`: the three kind boxes, the two hold boxes, «Kim javob beradi» saved and put back as a final TEST (#183), «Kunlik tekshiruv» renders; `m9zz-sayt-taqsimot`: the choice and its truth line; both at 360 px in `ru` | — |

**Only provable on his server** (no Telegram and no model key here): that the model follows rules 8/11/17/18 — the
first «narxi qancha?» with kub and kg after the deploy must show the offer sentence, and the first «ha» must land a
job in the VED's queue (he checks «Hisoblash (VED) → Navbat»); a photo-only message from a staff phone must get the
system line within ~1-2 minutes; the morning line at 08:40. Watch `docker compose logs app | grep '\[agent\]'`.

## 8. Order of work
1. **S0** (any time, first): `scripts/agent-stage0.ts`, `scripts/stt-trial.ts`; send him the chores of §4.0 and the questions of §11.
2. **K** — K1 FIRST and alone (the snapshot must be of HEAD's rules), then K2-K6. Gates after K: `pnpm typecheck`, `pnpm lint`, the three corpora.
3. Worktrees off K, in parallel (4 CPUs = two at a time): **P1** → **P2** → **P3** → **P4**; **P5** any time after K. Name the base commit to every agent (a worktree starts at the last merge); keep `.claude/worktrees` out of `eslint .`.
4. Cherry-pick in that order. `run.ts` is touched by K (note codes), P2 (`eligibilityFacts`), P3 (the worthy branch, `withBotAnswer`) and P4 (one call after `writeDraft`) — four regions; `auto-send.ts` is P1's (P3 only deletes the call at `run.ts:484`). **P1 and P2 are ONE deploy, never two** (contract §4, binding): P1 deletes `streak` and P2 deletes `repeat` and builds the loop detector — a branch that carries P1 without P2 has no rule at all against a robot-to-robot chat, so the PR is not opened until both are picked and `agent-loop.test.ts` is green on the merged tree.
5. Review as built (gate / customer-safety / regression lenses, a refuter per finding), fix, then the house ritual in CI's order on a fresh database: seed once → vitest → build with the 3 GB heap → Playwright without re-seeding; `fuser -k 3000/tcp` first; `DATABASE_URL` set for every local vitest run. Run the whole reader corpus BEFORE and after any touch of `auto-gate.ts` / `locale.ts`.
6. `git fetch origin main` before the last gate; renumber the migration and the DECISIONS entries to the tails you find.

## 9. Deploy
- Ledger: the journal's length (one more than before — read it, never carry a number); `/api/version` must read
  today. The day after, `agent-stage0.ts volume --days 7` through `migrate` is the before/after.
- tg-listen: **rebuild it in this deploy.** The design changes nothing the listener is MEANT to do, but as read its
  import closure (the `agent/` imports of `scripts/tg-listen.ts`, `:104-153`: `config`, `queues`, `send-step`,
  `outbox-store`, `gramjs-adapter`, `worthy`, `listener-hooks`, `peer-pulls`, `settle-hooks` — and through them
  `limits`, `anchor-clock`, `send-caps`, `send-window`, and `context` by dynamic import) holds three files 1a edits:
  `config.ts` (the probe), `worthy.ts` (P3) and `limits.ts` (P2's loop constants). `tests/unit/tg-listen-agent-wire.test.ts`
  pins the ORDER of the pump's calls in that script — it does not list the closure; read the imports.
- He touches, in order: «Kim javob beradi» (himself and his deputy under «Rahbar va o'rinbosar», whoever hears «Katta yuk»);
  «AI ismi»; the two hold boxes and the night choice if he wants other than the defaults. NOTHING is flipped for him:
  the three kind ticks are his from stage 0, and the four ordinary ones simply leave the page.
- First morning: at 08:40 the line of §4.5; during the day silent cards for what went alone, ringing ones for what
  waits; at 20:10 «Bugungi tekshiruv». «Hajm» stays `off` until he flips it.
- Rollback: revert the code. The three tables and the settings rows are ignored by the old code; stored reasons
  `loop` / `complaint` print «sababi noma'lum» there; nothing is one-way.

## 10. Risks, traps, stated-not-built

- **The prompt cannot be run here.** Rules 8/11 are words to a model; the gate does not check that the offer was made
  or that «ha» became a job. The first live day is the test (§7). Do not claim «VEDga boradi» to him before it is seen.
- **Talk now goes with no ⏸ and, at night, with nobody awake.** Behind it stand the unchanged policy, the complaint
  deny, the loop detector and tomorrow's sample. A dead staff bot no longer stops talk («no card, no press» did).
  UNVERIFIED how the 0115 watch reports a dead staff bot when that bot is the carrier — read it before promising an alarm.
- **Relaxed talk language sends some replies in the wrong one of uz / uz_cyrl / ru** (#1786's shapes without a price).
  It is the decision of §8; the sample shows them. Money messages are as strict as today.
- A system line is the same text to many chats: short and figure-free it is G10's WARNING, not its block
  (`sameTextWarnChars`), and `fingerprint` is not eye-only — past three other chats in 24 h the next photo-only
  customer gets a card, not the line. Deliberate (ban-6); three wordings soften it; the morning line counts it.
- `countdownMayRide` with a hold of 0, `pressNow` racing the sweep (the claim is `FOR UPDATE SKIP LOCKED` — keep it),
  a settings read inside `assignForTag`'s transaction, a `values([])` on an empty designation list, a Suspense
  boundary around the new action buttons (#1242), a fixture user deleted instead of deactivated (audit FK).
- A website visitor's lead is the seat's: every «to the lead's owner» notice then reaches the seat's mailbox — which
  on his server is his own phone today (UNVERIFIED) and is nobody's the day the seat's staff chat is unlinked.
- **Stated, not built here:** the 15-minute climb to the deputy and a second presser (1b/3a); several messages and
  the holding line (1b); the Q31 setting; per-chat caps as settings; `hand_back` and `price` kinds going alone;
  a dead-card alarm; reading any file; the seller's price outranking the table (8 b); the balance going alone (25 b);
  «3-5 kun» for avia (§11.3 of the design, open); the offer sentence is not enforced by code.

## 11. Questions the builder must still ask him (Uzbek, numbered; ⭐ = what is built meanwhile)

1. **Tunda narx.** Mijoz tunda narx so'rasa: ⭐ a) jadval narxi 2 daqiqadan keyin o'zi ketadi, VED narxi ertalabni kutadi · b) hech qanday narx tunda ketmaydi · c) VED narxi ham ketadi (⚠ avval VED narxi uchun «faqat kunduzi» degansiz).
2. **«Hisoblatishga yubordim».** Bu javob (VEDga ish tushadi): ⭐ a) narx kabi 2 daqiqa kutadi · b) darhol ketadi.
3. **«Fura» so'zi.** Hajm aytilmagan, lekin mijoz «fura» yoki «to'liq mashina» desa ham signal kelsinmi: ⭐ a) ha, bir chatdan haftasiga bir marta · b) faqat 20 kubdan (⚠ 3-javobingiz «20 kubdan YOKI fura desa» edi). **Javob berilgan (3 b) — so'ralmaydi, a) quriladi**; `agent_big_cargo_words` sozlamasi yoqilgan holda chiqadi, o'chirish — o'zining tugmasi.
   *(For the builder: the ONE list to send him is `qurish/COVERAGE.md` «Still to ask him» — it merges this plan's questions with the other six and leaves out the ones his 32 answers already settle.)*
4. **Kunlik tekshiruv qayerda.** ⭐ a) sahifada, Telegramga bitta eslatma · b) Telegramda o'nta alohida xabar, tugmalari bilan.
5. **Saytdagi «Umumiy» so'rovlar** (6-javobingiz yuk haqida edi): ⭐ a) ular ham AIga · b) odamlarda qoladi. Va qachon yoqamiz: ⭐ a) 2-bosqichdan keyin (AI rasm va faylni o'qiy boshlaganda) · b) 1a dan bir hafta keyin · c) darhol. ⚠ 6-javobingiz «saytdan kelganlar hammasi AIga» edi — bu savol uni o'zgartirmaydi, faqat QACHON yoqilishini so'raydi: a) tanlansa, o'sha kungacha saytdan kelganlar bugungidek sotuvchilarga boradi; tugmani xohlagan kuni o'zingiz yoqasiz.
6. **Sotuvchisi yo'q mijozlarga xabar matni** (§4.7) — shu matn ketadimi, va unda «AI yordamchi» deb yozilsinmi: ⭐ a) faqat ism bilan (so'rasa, o'zi aytadi) · b) ochiq yoziladi.
7. **Kirillcha, tili ko'rinmagan birinchi xabar** («5 куб 800 кг»): ⭐ a) bugungidek bitta ✅ingizni kutadi · b) ruscha javob o'zi ketadi.
8. **Fors va xitoy tilidagi tayyor matnlar** — o'qiy olmaysiz: ⭐ a) o'zbekcha tarjimasini ko'rib bir marta tasdiqlaysiz · b) bu ikki tilda tayyor matn ketmaydi, sizga karta keladi.

## Verified references

Checked at HEAD `bf37150c` (the plan was read at `bdd81f51`; only `docs/` differs between the two). About 230
things this file names as EXISTING were grepped and their lines opened: ~135 `file:line` references under
`src/modules/wms/agent/` and the platform, 7 CHECK constraints (0138, 0145, 0148, 0149), the tables and columns of
§3-§4, 5 existing settings keys, the ~30 screen and button names of §4.0 (`messages/uz.json`), 18 test files and
fences, 2 scripts, 7 document sections, 12 DECISIONS numbers and the customer-safety corpus counts. No model
identifier, no person's name and no literal number for the NEW migration is in this file. Everything not listed
below stood as written.

Corrections made (old → new):

1. Header: «`AI-SOTUVCHI-TOLIQ-QURISH.md` … is ABSENT at this HEAD» → the contract exists from `bf37150c`; it wins on process.
2. §1: `worthy.ts:91`, `run.ts:475` → `worthy.ts:96-99` (inside `draftWorthy`, `:91`), `run.ts:474-493`.
3. §3.3: added what `OWN_DOOR_KEYS` really admits (two page values, `OWN_DOOR_PAGES` `:423`) — `lead_assign_ai` on
   `/admin/taqsimot` needs a third; the seat key is not a `SETTING_DEFAULTS` key; `mayTuneAuto` / `mayArmAuto` are module-private.
4. §4.0: `mediaWord` is `agent/census.ts:96` (the plan did not say where).
5. K1: corpus fields — added `chatLang`; `pressedReasons` is module-private, `explain` is at `:336`.
6. K4: added the two derived fences the new notification types meet (`agent-fences.test.ts:157` `NO_CHAT` /
   `chatCardsWhere`; `:174` an `AgentNotice` writer must carry `extra.peerId`) — the plan named neither.
7. K5: note writers `:1661-1705` → `:1673-1705`; **one note writer was missing from the code list** — the
   truck-minimum note at `run.ts:1673` (code `calc_below_minimum` added). Without it that note would have read
   «no code» = a machine stop, by this plan's own fail-closed rule.
8. P1: named what «the box, its web action and keys» are (`AutoConfidenceForm`, `agentAutoMinConfidenceAction`,
   `agentAi.autoConfidenceLabel`, the `{confidence}` part of `autoNumbers*`); `pressOne` `(:891)` → the rang rule
   `:875-879` and the hold `:888-895`, with `copyRang` `:649`.
9. P3: «a KEPT photo or file» → the code's terms (`context.ts:492`: `media` `'photo'` / `'document'`; an unkept
   medium reads `'other'`); `reserve` is `run.ts:399`.
10. P3: «16 runtime strings hold the owner's name» → **18** (`prompt.ts:91` and `lesson-rules.ts:30` were missing);
    §7's test row follows.
11. P3 — **a step re-thought**: the plan treated the persona's name as a prompt change only. As read
    (`policy-input.ts:133`, `policy.ts:2462-2480`), a persona carrying a real colleague's first name warns
    `staff_name` on every self-introduction once the holder is the seat, and 1a keeps `staff_name` a machine stop.
    A persona-word exemption in `policyFor` and its test were added to P3 and to §7.
12. §4.7: `seatCandidate` — the 400 ms budget and the lock already exist at `site-assign.ts:270-271`; the seat readers take the transaction.
13. §6.2: the STAY row now names every `AUTO_REFUSALS` member it covers (`not_armed`, `agent_off`, `not_pending`,
    `blocked`, `actions` and the money/calc codes were implied, not listed).
14. §6.3: `eligibleInput()` `:117` → `:116`; `destination()` `:233` → `:235`; the reader list gains `han_g1`;
    the corpus size at this HEAD is written down (1,483).
15. §6.3 — **a claim rewritten**: «`agent-policy-first-reply.test.ts`: untouched» → its verdicts are untouched,
    but the file builds two `AutoGateInput` literals (`:1979`, `:2075`) that K6's type change breaks under
    `pnpm typecheck`; the same holds for `tests/unit/agent-full-p2-price.test.ts:162` and the corpus eval's
    `eligibleInput()`. Listed as mechanical edits.
16. §6.3: e2e «owner tunes the boxes» is no test title → the two tests that read the confidence box (`:107`, `:265`).
17. §9 — **a claim rewritten**: «`tg-listen-agent-wire.test.ts` names [the import closure]» is false (it pins the
    pump's call order). The closure is the script's own imports; it holds `config.ts`, `worthy.ts` and `limits.ts`,
    all edited by 1a, so the deploy step is now «rebuild tg-listen», not «rebuild if…».

Not resolved here (left marked `UNVERIFIED:` in the text): whether a fact holding clock times passes G1; that all
303 dangerous cases hold under the corpus harness (K1 measures it); outbound reach to the speech providers; how
the 0115 watch reports a dead staff bot; whose phone the seat's staff chat is on his server.

## Conformance

Checked against design §11 (his answers), the contract's §4 and the other six plans; the trace of every answer is
`qurish/COVERAGE.md`. Nothing here contradicted an answer. What was changed, and why:

1. **§3.2 — one word for the pair.** The `supervisor` topic's label «Nazoratchi va o'rinbosar» → **«Rahbar va
   o'rinbosar»** (also §9). «Nazoratchi» read as the position «Nazoratda», and five plans used three different words
   for the same two people. The KEY stays `supervisor`.
2. **§3.2 — the registry's whole future is written down.** The list of later topics named 3a's eight only; stages 5,
   6 and 7 add six more (`big_customer`, `handover_seller`, `payment_claims`, `debt_request`, `seat_phone`,
   `reserve_phone`). One table from 1a, extended by registry keys — no later plan may create a second «who» table.
3. **§3.2, §4.5, §7 — §11.2 applied to the fallback itself.** The last fallback and the lead-sight rule were written
   as «the `super_admin` ROLE»: a role key the builder would have typed into new source. They now CALL the existing
   reader / predicate (one exported `agentAlarmRecipients`, extracted from the line that already holds the literal),
   and the designation test gained a source-shape clause: no role key, uuid or name in the five new files or the
   migration.
4. **§4.5 — his 4 a stated for the signal.** «Cards to colleagues wait for the morning» was not said for the
   big-cargo signal; in 1a it is night-silent (the house's meaning of «waits»), and the stricter «deliver at the next
   working minute» is 3a's — the difference is a question in COVERAGE, not a silent choice.
5. **§8 — `streak` and `repeat` leave only WITH the loop detector** (a binding correction): P1 and P2 are one
   deploy; the PR does not open with one of them.
6. **§2 — Q31's key** is named where it is minted (⟨1c⟩, value `seller`) and where its three modes are built (5).
7. **§11 Q5 — a ⚠ line.** The ⭐ («switch the site's visitors to the AI after stage 2») delays his 6 c; the
   question now says so in his language, as the contract demands of any ⭐ that touches an answer.
8. **§11 Q8 — «tayyor jumla» → «tayyor matn»** (the one word for a fixed, approved text in every plan).
9. **§11 Q3 — a question his 3 b already answers** («20 kub, or when the customer says fura»): marked «so'ralmaydi»;
   its option b would have reversed part of that answer without a ⚠.

Confirmed, unchanged: no word rule or reader is deleted (K1 commits the 303 before any change); `language` stays
strict on every money class; `owner_figure`, `owner_personal`, `answer_stale`, the `complaint` label and
`human_active` stay; nothing stops on dollars and no dollar ceiling is proposed (§4.6); nothing names Telegram
Business; the migration flips no stored tick, is numbered «next after the journal's tail» and has its probe
(`agentToliq1aReady`); `staff/`, the KPI and the rating are untouched (31 c).
