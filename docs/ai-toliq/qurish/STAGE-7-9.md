# To'liq AI sotuvchi — BUILD PLAN: stage 7 «Xavfsiz kanal», stage 8 «O'zi yozadi», stage 9 «Hodim sifatida o'lchanadi» (+ one paragraph on 10)

Read at HEAD **`bf37150c`**, ledger 151 (journal tail `0150_batches_view`). `agent/` = `src/modules/wms/agent/`. Every `file:line` below was opened at that HEAD; **six stages will have moved the tree before stage 7 starts** — re-read each named function on the tree you start from, and where this file and the code disagree, the code wins. Markers **⟨1a⟩ ⟨1b⟩ ⟨2⟩ ⟨3a⟩ ⟨3b⟩** = shipped by that stage's plan (`qurish/STAGE-*.md`): use ITS names as built. **`qurish/STAGE-4-6.md` and `COVERAGE.md` were ABSENT at this HEAD**; what this file needs from stages 4-6 is three contracts, marked ⟨4⟩ ⟨5⟩ ⟨6⟩: (i) ⟨4⟩ **the quote record** — one row per price TOLD to a customer: which chat and card, kind (table / avia / VED), when, valid until, the message that carried it, the carrier; (ii) ⟨5⟩ **`agent_won_ownership`** (⟨1c⟩'s key) with its three values and its screen; (iii) ⟨6⟩ the position of `tell_balance` and the «amount once» push through the bot. If a stage built them otherwise, re-fit the plan, never the code. **Since then `qurish/STAGE-4-6.md` and `qurish/COVERAGE.md` were written, and the conformance pass re-fitted this file to them («Conformance» at the end):** (i) ⟨4⟩ = table `agent_quotes` + `agent/quotes.ts` (`recordToldQuote`, `standingQuoteFor`); kinds `table | avia | calc | owner`; it carries `draft_id` / `outbox_id` and a `carrier` column BORN with the table (`seat`; `bot` reserved for §A11-2 b — no stage adds a column to it later); (ii) ⟨5⟩ = `agent_won_ownership` + **`staff/seat-mode.ts`** (`seatMode()`, `seatOutOfPay()`, `seatExcludedSql(col)`), which under `company` / `handover` ALREADY takes the seat out of `kpiSellerIds` / `kpiPayableAll` / `payKpi` (refusal `not_payable`) and `ratingViewFor` — it is the ONE home of «who the seat is and how it is counted»: stage 7 adds `seatUserIds()` to it (§A4.4), stage 9 adds the `pay` answer (§C4.0, §C4.3), and `payKpi` keeps ONE refusal code, `not_payable`; (iii) ⟨6⟩ = rights row `tell_balance` (⟨3b⟩'s key, «So'rab» until stage 6), which he sets to **«Nazoratda»**, plus the setting `client_ready_amount` and the notice kind `ready_amount` — so the bot tells a balance when that row is `ozi` OR `nazoratda`, the same rule this plan applies to every other action (§A4.2).
One stage = one branch = one PR = one deploy = his confirmation (`docs/AI-SOTUVCHI-TOLIQ-QURISH.md` §3, §5). No model identifier in a tracked file («tez daraja» / «og'ir daraja»); no person's name, id or role key in code, seed or migration — people come from ⟨1a⟩'s designation table (`agent_designations`) by its two readers (lead ruling R2): `designated(topic)` — with the fallback chain down to the supervisor pair — for a SIGNAL, an alarm or a report; `designatedRows(topic, handle)` — the topic's own rows with their rank, no fallback — for a DOOR (⟨1b⟩ `maySpeakForSeat`, `mayApproveKnowledge`, ⟨5⟩ `actsForSeat`) and for the seat's mail, so an empty table never widens a door; a door a table below words as «super_admin, as `setAgentSeat`» means the predicate ⟨1a⟩ extracts from that function, CALLED — no role key is typed into a new file; a right's position is saved only through ⟨1b⟩'s `setActionRight` (lead ruling R7), never by a migration or a deploy; no dollar ceiling (10 c); no Telegram Business / Chat Automation (12 a). Migrations are numbered «the next after the journal's tail» on the day the kernel is cut (#1040; fetch main first).

---

# PART A — STAGE 7 «Xavfsiz kanal»

## A0. Header
| | |
|---|---|
| The owner stops | his sellers being pinged for every «yukim qayerda / manzil / ish vaqti» a customer types into the company bot; reading ONE alarm text for three different Telegram states and guessing what to do; having no second line prepared |
| Size | **M** (1-2 weeks): a kernel + four packages. His 12 a removed the «official road» half (business updates, a per-message router, two carriers on one account) |
| Depends on | ⟨3b⟩'s PR-A in mode `live` (blocks, approved texts, the release verdict, the rights page) — the bot answers ONLY through them. NONE of ⟨3b⟩'s demolition PRs i-v is needed and none is assumed: whichever steps are retired on the day, a bot turn is judged by the same old rules as a seat turn; ⟨3a⟩ (complaint tripwire, topics); ⟨1a⟩ (`designated`, `client_ai_contact`, `seatCandidate`, `agent_samples`, `morning.ts`); ⟨1b⟩ (the act registry, parts). NOT on 4-6, except that `tell_balance` is answered in the bot only once stage 6 is live and HE has set that right to «Nazoratda» or «O'zi» |

## A1. Behaviour, before → after
| Who | Before (HEAD) | After |
|---|---|---|
| Customer, LINKED chat in the company bot, types «yukim qayerda?» | every text → relayed to the seller, answer «✅ Xabaringiz menejeringizga yetkazildi: …» (`platform/telegram/client-cabinet.ts:598`, `:1300`), then a person's time | status, our addresses and standard questions are answered by the AI in ~15-40 s, from the same tools and blocks as on the AI number, with a button «💬 Menejerga yozish»; everything else is relayed exactly as today |
| Customer, photo / file / voice, or anything after «❌ Xato bor» | relayed | relayed, unchanged — the AI never touches it |
| Customer, chat not linked | /start flow, advert intake | unchanged |
| Owner | any restriction → one text «Telegram … akkauntini chekladi» (`crm/account-alarm.ts:40`); no reserve; `started_at` never resets, so a new number would start at the full cap (`limits.ts:182`) | the alarm names the state (cheklangan / muzlatilgan / bloklangan) and the steps on the phone that holds the SIM; a «Zaxira raqam» panel with its health; one guarded door «Zaxira raqamga o'tish»; bot answers in the evening sample and the morning line |
| Sellers | every bot message of their client | only what the AI did not answer, with one closed reason line («🤖 AI javob bermadi: narx so'radi») |

## A2. His answers that bind, and what stays FORBIDDEN
- Neither answer of this stage reverses an earlier one of his. **28 a** «In the company bot («💬 Menejer») the AI answers status, addresses and standard questions; the rest goes to the customer's seller as today.» **30 a** «A reserve number is prepared (a real SIM).» **SIM** «The seat's SIM and phone are with him» — in code this is the designation topic `seat_phone`, never a name.
- **12 a** — the session only: no business connection, no `business_*` update types, no second bot. `bot.ts:168` `allowed_updates` stays `DEFAULT_UPDATE_TYPES + chat_member`.
- **8 b** / **25 b ⚠** (he saw it): a colleague's customer gets status and addresses; money goes to the seller; the balance alone only in a phone-proven chat — a linked bot chat IS phone-proven (§A5). **7 b**: where a seller-less client sees the AI number (⟨1a⟩). **5 b**, **§11.2**: every «who» is a designation. **10 c**: no dollar stop.
- **FORBIDDEN in stage 7:** a price of any kind in the bot (table, avia, VED), a calculation job, a code, a discount, any promise class, a file reading, a holding line («so'rab beraman» — in the bot the relay IS the hand-over), a first message from the bot or the seat (stage 8), an `agent_outbox` row for a bot send (§A3), bot lines in `tg_messages`, the reserve writing first to anybody, an automatic switch to the reserve, Telegram's own greeting / away messages on either number, any dollar ceiling.

## A3. Data — ONE migration, additive, tag `agent_channel`
**Why the bot gets its own tables.** In a private chat the bot's chat id IS the person's Telegram id — the code already leans on it (`context.ts:240-249`: a linked cabinet proves a seat chat by `telegram_chat_id = peer_id`). So a bot row stored under (holder, peer) in 0138's tables would sit beside the seat's chat with the same person, and the seat's send step would read it: `outbox-store.ts:205-244` builds `human_replied` / `own_sent` from `agent_outbox.tg_message_id` per (manager, peer), a bot message id restarts at 1 in every chat, and the seat is a young account with small ids — a human's message could be forgiven as «ours». Bot sends therefore NEVER enter `agent_outbox`, `agent_drafts`, `tg_messages`; only `agent_runs` is shared (one meter, one token fuse), under its own trigger.

| Table (names grepped free at HEAD) | Columns that matter | Notes |
|---|---|---|
| `agent_channel_messages` | `id`; `carrier` CHECK IN (`bot`); `chat_id bigint`; `direction` CHECK IN (`in`,`out`); `tg_message_id bigint`; `client_id uuid NOT NULL REFERENCES clients`; `kind` CHECK IN (`text`,`media`); `body` ≤ 4000; `turn_id`, `part_no`; `relayed_at`; `sent_at`; UNIQUE (`carrier`,`chat_id`,`tg_message_id`) | the transcript. `client_id NOT NULL` is the tg-import privacy rule: only a linked client's chat is kept. A media line stores its caption and the fact «relayed», never bytes |
| `agent_channel_turns` | `id`; `carrier`; `chat_id`; `client_id`; `anchor_tg_message_id bigint NOT NULL`; `run_id REFERENCES agent_runs`; `outcome` CHECK IN (`answered`,`relayed`,`skipped`); `reasons text[]`; `parts jsonb`; `policy jsonb`; `locale`; `sample_day date`, `sample_mark` CHECK NULL or IN (`good`,`bad`), `marked_by`, `marked_at` (paired); `created_at`; UNIQUE (`carrier`,`chat_id`,`anchor_tg_message_id`) | one row per burst the AI looked at — the bot's «draft + verdict». The sample marks live here because ⟨1a⟩ `agent_samples`' key is (day, draft) |
| `agent_channel_chats` | PK (`carrier`,`chat_id`); `relay_until timestamptz`; `ai_off_at`, `ai_off_reason`; `updated_at` | per-chat state: «a person has it» and a per-chat off |
| `agent_accounts` | `manager_user_id uuid PK REFERENCES users`; `role` CHECK IN (`main`,`reserve`,`retired`) with a partial UNIQUE on `role = 'reserve'`; `ramp_started_at`; `ramp_per_day smallint`; `state` CHECK NULL or IN (`limited`,`frozen`,`banned`); `state_set_by`, `state_set_at`; `write_first_off_until date`; `phone_checked_at`; `retired_at` | the seat's accounts as rows chosen on a screen. The migration inserts NO row; a missing row reads «main, ramp = `agent_config.started_at`», i.e. today |
| ⟨3b⟩ `agent_turn_blocks`, `agent_action_uses`, `agent_reviews`, `agent_fact_checks` | + nullable `channel_turn_id REFERENCES agent_channel_turns ON DELETE CASCADE`; each table's ONE named `<table>_anchor_check` re-made to «exactly one of draft (or outbox row) / channel turn (/ exam)», plus a new partial UNIQUE for the channel anchor — ⟨3b⟩ writes its anchors as one named CHECK over a nullable column for exactly this (`STAGE-3B.md` §3.1), so no NOT NULL is dropped and no existing UNIQUE is re-made | ⟨3b⟩'s own young tables — never 0138's hot ones. Re-read their definitions as built first; if 3b shipped a NOT NULL anchor instead, this is the one place a second re-make is unavoidable |

**CHECK re-made:** `agent_runs_trigger_check` — at HEAD `IN ('inbound','owner_edit','calc_answer','hand_back','style')` (`schema/agent.ts:145`, 0138); ⟨1b⟩ re-makes it ONCE with `case_answer`, `replay` and its reserved values, **`channel`** among them (`STAGE-1B-1C.md` §3.2) — so stage 7 is the first WRITER of `channel` (take it off ⟨1b⟩'s reserved list in the same commit) and re-makes the CHECK only if 1b as built left the value out; then derive the full list from the LAST migration that re-made it (the house test pattern of `tests/unit/ai-press.test.ts`). **CHECKs read and left:** `tg_account_guard_kind_check` (`paused_kind IN ('peer_flood','restricted','frozen','flood_repeat','blocks')`, `schema/agent.ts:391`, 0138:286) — the three states are his reading and live in `agent_accounts.state`; `agent_drafts_kind_check`, `agent_outbox_status_check` — untouched. **No new column on any 0138 table.** The four `channel_turn_id` columns ARE new columns on tables every release reads: this release keeps them SQL-only (raw SQL / `to_jsonb(x)->>'channel_turn_id'` behind the probe) and declares them in drizzle one release later.
**Probe** `agentChannelReady()` in `agent/config.ts` beside `agentFullP2Ready` (`:172`): `to_regclass` of the four tables + `agent_action_uses.channel_turn_id` in `pg_attribute`. **Behind:** the bot relays everything as today; the alarm prints today's words; the reserve panel and the door are not drawn; `rampStartFor` answers `agent_config.started_at`.
**Purge:** `agent_channel_*` are keyed by chat, not (manager, peer), so `tests/unit/agent-fences.test.ts` does not see them — add `purgeChannelChat(carrier, chatId)` (called when the chat's last link is revoked and when an admin unlinks) and a twin fence that derives every table carrying (`carrier`,`chat_id`).
**Settings** (`platform/settings/service.ts` `SETTING_DEFAULTS`, validator, own-door entry, description ×4):
| Key | Default | Meaning |
|---|---|---|
| `agent_bot_ai` | `off` | `off` \| `on` — the AI answers in the company bot. Its OWN switch: it does not read `agent_config.mode`, so a restricted seat does not silence the bot (that is the stage's point) |
| `agent_bot_relay_hold_min` | `120` | after a relay, the chat is «with a person»: everything is relayed for this long (mirrors `human_pause_min`) |
| `agent_bot_wait_sec` | `40` | the run's wall clock; past it the burst is relayed |
New ⟨1a⟩ designation topics (registry keys + four i18n strings, no migration): `seat_phone` («AI raqami SIM va telefoni kimda»), `reserve_phone`.

## A4. Code
### A4.0 Kernel K (the lead, one commit)
| File | Today (as read) | Change |
|---|---|---|
| the migration, `platform/db/schema/agent.ts`, `agent/config.ts` | — | §A3 |
| `agent/channel.ts` (new) | `loadContext(managerUserId, peerId, anchor)` reads `tg_messages` directly (`context.ts:688`, `:449`) | the ONE home of «a carrier»: `Carrier = 'seat' \| 'bot'`; `ChatSource {messages(), identity(), locale()}`; `seatSource(manager, peer)` wraps today's readers byte for byte; `botSource(chatId)` reads `agent_channel_messages` + `client_notices` rows of the chat's clients as system lines («[tizim: yuk qabul qilindi xabari yuborilgan]» — so the AI never repeats a push); `CHANNEL_LIMITS` (answers per chat per day 20, parts 2, gap 1.2 s) — the parts of a bot turn are min(2, ⟨1b⟩ `agent_turn_max_parts`), and EVERY message counts (lead ruling R6): a cabinet block is one, the model's prose one; the «— GSR AI yordamchisi 🤖» signature is a line of the last part, never a message of its own |
| ⟨3b⟩ release pipeline | built around a draft | split into a PURE `releaseTurn(turn, profile, facts)` and two persistence adapters (draft/outbox · channel turn). No rule changes; the seat's path must render byte-identical (a render test pins it) |
| `agent/queues.ts` | zero imports; the listener reads it | `JOB_AGENT_CHANNEL = 'agent.channel_inbound'` (`retryLimit: 0`) — zero imports stays true |
| `platform/notifications/mutes.ts:331` | `UNMUTABLE_TYPES` holds `TgAccountPaused`, `AgentForcedOff` | + `AgentAccountState` (§A4.3) |

### A4.1 P1 «Bot suhbati» — the seam in the cabinet, the job, the fail-safe (owns `client-cabinet.ts`, new `agent/channel-door.ts`, `agent/channel-run.ts`)
| Where | Today | Change |
|---|---|---|
| `client-cabinet.ts:1300` `bot.on('message:text')` | `forwardClientMessage` → `ackDue` → `acknowledge` | first `takeForAi(...)` by DYNAMIC import (platform never imports wms — the file's own `cabinetReads()` idiom). `'taken'` → `sendTyping` (`send.ts:564`) and return: no forward, no ack. `'relay'` → today's code, untouched |
| `takeForAi` (cheap, no model) | — | all must hold, else `'relay'`: probe ready; `agent_bot_ai = 'on'`; `aiConfigured()`; `clientsForChat` non-empty and `staffForChat` null (the two reads `forwardClientMessage` makes at `:615`, `:617`); no live ❌ context (`disputeOf`, `:566` — export a read); `relay_until` passed; chat not AI-off; text ≤ 1000 chars; under `CHANNEL_LIMITS`; not a redelivery (`readyKey(() => onceKey.message(chatId, messageId, 'channel_ai'))`, `platform/telegram/once.ts:52`, `:64` — `'channel_ai'` is a NEW member of the closed `OnceEffect` union, `once.ts:31`). Then: INSERT the line (ON CONFLICT DO NOTHING) and enqueue `JOB_AGENT_CHANNEL` (`startAfter` 8 s, id `ch:<chat>:<message>`) |
| `client-cabinet.ts:1320` (media, location, sticker) | forwarded | forwarded as today; the transcript gets one `media` line marked relayed, so the next text burst knows a person already holds the file |
| `handleChannelInbound` (the app's worker, never the poller — #706) | — | stand down unless this is the chat's newest inbound; code tripwires over the burst → relay: ⟨1a⟩ `complaintIn`, «menejer / odam / operator» words, ⟨1a⟩ loop; reserve an `agent_runs` row (`trigger 'channel'`, `manager_user_id` = the holder, else the seat — none of either → relay) under `capReached` (`today.ts`); `runLoop` (`run.ts:193`) with the bot profile (§A6); `releaseTurn(turn, 'bot')`; **answered** → `sendTextBriefRetry` (`send.ts:345`) per part, HTML only through `h()`, out lines + turn + ledger rows written after Telegram's `ok`; **anything else** — a hold, a tool refusal, the model's «odam kerak», an error, the wall clock, a 403 — → `relayBurst(reason)`: `forwardClientMessage` for each line of the burst (its own once-keys make a replay free), the existing ack, `relay_until = now + hold` |
| `agent/jobs.ts` `agentSweep` (`:367`) | — | one step, the net: an inbound transcript line older than 120 s with no turn and no `relayed_at` → `relayBurst('late')`. A customer is never left with silence because a job died |
| `forwardStaffText` (`wms/client-cabinet/bot-text.ts`) | codes, name, text | + optional `aiReason` line from a closed map `CHANNEL_RELAY_WORDS: Record<RelayReason, string>` (never the model's words, never a figure) |
| «💬 Menejer» (`:1103`, `mg` `:1177`), `ClientBotMessage` | prints the manager's contact; the relay's notification type | unchanged — the relay stays the one road to a person |
| new callback `ai:m:<turn tail>` beside `mg` (`:1177`) — `ai:` is free at HEAD (grep of `src/`; the staff parser's `a:` wants `[01]` after the colon and `ag:` a letter and a uuid, so `ai:m:` falls through to the cabinet) | — | «💬 Menejerga yozish» under an AI answer: relays that turn's burst, sets the hold, answers the press once. A derived fence: every `callback_data` the cabinet builds is one its handlers parse |

### A4.2 P2 «Bot javobi» — the profile and the records (owns `agent/channel-profile.ts`, the ledgers' second anchor, ⟨1a⟩ `sample.ts` / `morning.ts`)
- **`BOT_CHANNEL_ACTIONS`** — the allow-list of ⟨3b⟩ rights keys a bot turn may exercise: `talk`, `say_ai`, `quote_fact`, `tell_status`, `tell_china_address`, `tell_tashkent_address`, and `tell_balance`. A turn is released only when EVERY part's action is on the list, its position is `ozi` or `nazoratda` — ONE rule for all seven, the balance too (25 b: «alone when the customer asks, in a phone-proven chat»; a linked bot chat is phone-proven, §A5; stage 6 has him set `tell_balance` to «Nazoratda», so «only at `ozi`» would never have come true) — and `releaseTurn` returned zero holds. A `nazoratda` answer given in the bot lands in the evening sample like one given on the seat. `sorab` / `odam` / any other action → relay (in the bot the seller is the person asked — there is no ✅ card path here by design).
- **Tools offered** (`toolSpecsFor`, `tools.ts:256` gains `profile`): `cargo_status`, `kb_search`, ⟨3b⟩ `receiving_address` (the ONLY road of our China address — `tell_china_address` is on the allow-list above, and ⟨3b⟩ takes the receiving facts out of `kb_search`, `STAGE-3B.md` §4.2; in the bot its system question «avto yoki avia?» is one Bot-API part, a typed «avto» releases the `address_cn` block, and «avia» — or any doubt — is a RELAY to the seller with the closed reason: the avia address is never a tayyor matn, here or on the seat, 17 c), `own_balance` (only with `tell_balance` at `ozi` or `nazoratda`), `compose_reply`, and ⟨1b⟩ act `relay_to_seller` (new registry entry, position fixed `ozi`: «bu savol menejerniki»). NOT offered: both estimates, `cargo_volume`, `calc_checklist`, `calc_price`, `open_code`, `ask_owner`, every ⟨2⟩ reading tool.
- **Status and balance are the cabinet's own blocks**: `cargoMessages` / `balanceMessages` (`bot-text.ts:181`, `:293`) in the chat's stored bot language (`chatLocaleFor`: uz / ru / en) — the «📦 Yuklarim» button and the AI must never print two different numbers for one lot. A ⟨3b⟩ block with no approved text in that language → relay.
- **Records**: `agent_action_uses`, `agent_turn_blocks`, `agent_reviews` rows under `channel_turn_id`; ⟨3b⟩ nightly comparison and per-action step-down read both anchors (a wrong address said in the bot steps `tell_china_address` down for BOTH carriers — one right, one ledger). ⟨1a⟩ `sample.ts` picks from both sources (the bot's marks on the turn row); ⟨1a⟩ `morning.ts` gains «Botda: 23 savoldan 15 tasiga AI javob berdi; 8 tasi sotuvchiga o'tdi (3 narx, 2 rasm, …)».
- **Bill**: `agent_runs` — already inside the 20:00 line (`reports/ai-spend.ts:226`) and the token fuse (`today.ts`). `dayRunCounts` counts `trigger = 'inbound'` for the run caps (`today.ts`), so bot runs do not spend the seat's `daily_draft_cap`; they have `CHANNEL_LIMITS`.

### A4.3 P3 «Raqam holati» — the three restriction states (owns `crm/account-alarm.ts` words, new `agent/account-state.ts`, a page panel)
What the code knows today: a SEND that answers `PEER_FLOOD` / `USER_RESTRICTED` / `FROZEN_*` pauses the whole account, human replies included (`crm/telegram-guard.ts:39-43`, `account-guard.ts:55`), switches the agent off (`forceAgentOff`, `config.ts:828`) and raises ONE alarm; only «Tekshirdim, qayta yoqish» clears it (`account-guard.ts:193`); a dead session signs the account out (`tgErrorKind` `kind: 'session'`). That stays — it is the safe floor. Added:
| State (Telegram's own, `critic-telegram.md` §1.7) | How the system learns | By itself | What he does, on the phone that holds the SIM | Keeps working |
|---|---|---|---|---|
| **Cheklangan** (spam reports: cannot write first; «can always reply to anyone who messages you first») | pause kind `peer_flood` / `restricted`, or he sets it after reading @SpamBot | as today: every send stops, AI off; ⟨8⟩ initiative off; ⟨1a⟩ `seatCandidate` says no → site visitors go to the roster; `managersFor` (⟨1a⟩ branch) shows the office, not the seat | Telegram → @SpamBot → reads the end date; on the page picks «Cheklangan», types the date, presses «Tekshirdim» and switches the AI on again (it was forced off, as today); replies resume, `write_first_off_until` = that date + 7 days and ⟨8⟩'s switch stays his to turn on | the bot's AI and pushes; sellers; after his press — replies |
| **Muzlatilgan** (read-only; appeal «directly from the app») | pause kind `frozen` | same; the page says «yozib bo'lmaydi» and hides «Tekshirdim» behind a confirm | appeals from the official app's banner; waits, or opens «Zaxira raqamga o'tish» | the bot; sellers; the listener still READS |
| **Bloklangan** (number lost / session dead) | account `signed_out` | AI off; the reserve door is offered in the alarm | writes to Telegram's recovery address from the app's own notice; switches to the reserve | the bot; sellers |
**A stated stub, so stage 7 leans on nothing stage 8 builds:** when this ships there is no write-first at all. `write_first_off_until` is WRITTEN here and has no reader until stage 8's `firstSendVerdict` (`write_first_off`); «⟨8⟩ initiative off» in the table is the line stage 8 adds to that row, not a call stage 7 makes.
`setAccountState(actor, accountId, state, until?)` — holder or super_admin (`clearAccountPause`'s own rule); audited; `AgentAccountState` alarm per recipient to `designated('seat_phone')` ∪ the supervisor pair, through the BOT (an alarm about the seat never rides the seat — round 49's rule). UNVERIFIED: which error a spam-limited account gets on a REPLY — the code treats every `PEER_FLOOD` as account-wide; if a reply meets it again after his press, the pause returns (the existing first-pause logic).

### A4.4 P4 «Zaxira» — the reserve number (owns `agent/accounts.ts`, the page panel, `limits.ts dailySendCeiling`'s caller)
- **A real SIM, never a virtual number** (Telegram's spam page: some virtual / VOIP numbers «trigger an overly harsh response»), registered on the official app on a phone HE keeps. **What the system stores:** the reserve's `tg_accounts` row — phone, the encrypted session, status, verified @username, `last_seen_at` — exactly as for any connected account, plus one `agent_accounts` row (`role 'reserve'`, `phone_checked_at`). Nothing else: no SIM data, no 2FA password, no login code.
- **Why it is a second user:** `tg_accounts.manager_user_id` is UNIQUE and so is `tg_phone` (`schema/wms.ts:2574`, `:2582`); `/suhbatlar/ulash` connects only the signed-in person's own account; `tg_messages` is unique on (manager, peer, message id) (`:2520`), and two accounts' id spaces under one user would collide. So the reserve is connected under its own `users` row, chosen as the reserve on the page (super_admin; a connected «Ish raqami» account that is not the holder).
- **What it can do while prepared:** stay signed in and be listened to (health line: session alive, handle fresh, «oxirgi tekshiruv N kun oldin»). **What it cannot:** speak (the agent's holder is the main seat — `shouldStartAgentRun`, `queues.ts:166`); write first to anybody, ever (`never_wrote`, `send-step.ts:215`); carry the old number's chats; switch itself on.
- **The door «Zaxira raqamga o'tish»** (super_admin; one confirm that prints the consequences): preconditions as data — reserve connected, «Ish raqami», handle verified ≤ 1 h, listener current (`listenerIsCurrent`, `account-guard.ts:169`). Then, through the EXISTING doors in order, never a new writer of `agent_config`: mode `off` → `setAgentOwner(reserve)` (`config.ts:450`: disarms auto, clears the session confirmation) → `setAgentSeat(reserve)` (`:623`) → `agent_accounts`: old row `retired`, new row `main` with `ramp_started_at = now()`. He then confirms the session and switches on and arms himself — two presses that are deliberately his.
- **The ramp per account:** `rampStartFor(holder)` = that account's `ramp_started_at`, else `agent_config.started_at`. For an account with no history `dailySendCeiling` gives ONE send a day for 14 days (`limits.ts:182-189`, #1790) — useless for a line that only answers; so an account switched to by this door takes `ramp_per_day` (setting-typed at the switch, default 20, bounded by the effective day cap) for its first 14 days. Replies only; nothing else changes in `limits.ts`.
- **Succession:** `seatUserIds()` = the current seat ∪ `retired` accounts' users — asked by `machineMayTouch` (`machine-owner.ts`), so cards the old seat owned are not «a colleague's» to the new one, and by stage 9's KPI. **Its home is ⟨5⟩'s `staff/seat-mode.ts`** (the ONE module that says who the seat is and how it is counted — `seatMode()`'s `seatId` becomes «the first of `seatUserIds()`»), reading `agent_accounts` behind this stage's probe (behind → the one seat of `agentSeatUserId`, as today); `agent/accounts.ts` owns the accounts' rows and the door, never a second «who is the seat». **Three earlier pieces know only ONE seat and must learn the set in this stage, or the switch breaks them in silence** (ownership is not rewritten, so every client the OLD seat won keeps it as `sales_manager_id`): (a) ⟨1c⟩'s `readdress` (`platform/notifications/seat-mail.ts`) re-addresses a recipient that IS `agentSeatUserId()` — after the door «Prixod keldi» for those clients would go to the retired seat's user, a mailbox nobody reads; it must treat every id of `seatUserIds()` as the seat (platform reaches the set as it reaches the designation — by dynamic import, on the caller's handle; cheap-first stays: no import while no `agent_accounts` row is `retired`); (b) ⟨5⟩'s `actsForSeat` hands the doors «the SEAT's id in place of the actor's» — it must hand the id the CARD names when that id is in the set, or the pair cannot refile a retired seat's client; (c) ⟨5⟩'s `seatExcludedSql(col)` / `seatOutOfPay()` compare with one `seatId` — under `company` the retired seat's cargo would re-enter the ranking and its KPI would become payable: both become set-valued (`= ANY`). ⟨1b⟩'s `maySpeakForSeat(actor, managerUserId)` stays «the CURRENT holder only» (nobody writes from a retired number). Ownership rows and prixod stamps are NOT rewritten (`staff/stamp.ts`: a stamp never moves). ⟨1b⟩ `agent_conversation_record`, the chat's `locale` and `muted_at` are copied to the new (manager, peer) for peers the old seat knew — the passport follows the person; drafts, cases and history do not.
- **How customers learn the number:** nobody is written to from it. The site button (⟨1a⟩ `seatCandidate` reads the seat's verified handle), `managersFor` for seller-less clients (⟨1a⟩), and ONE bot message to linked clients who wrote to the old number, sent by him on «Xabar yuborish» (`platform/broadcast/service.ts`, `mayBroadcast`) with a new audience tick «AI raqamiga yozganlar».

## A5. Doors and sight
| Thing | Who | Predicate |
|---|---|---|
| `agent_bot_ai`, the relay hold | super_admin | as `setAgentSeat` |
| account state, «Tekshirdim» | the account's holder or super_admin | `clearAccountPause`'s rule (`account-guard.ts:203`) |
| choose / switch to the reserve | the super_admin ROLE | `setAgentOwner`'s gate |
| bot turns in the sample and the journal | ⟨1b⟩ `maySpeakForSeat` to mark; `mayRunAgent` to read | — |
**Identity = the chat link.** A link exists only after the chat shared its own Telegram-verified number and that number is on the card (`beginClientLink` → `ask_phone` → `completeClientLink`, `client-cabinet.ts:305-342`; a contact that does not match revokes the link, `:472`). So cargo and balance may be told for the chat's LINKED codes and no others; one chat with several codes (444 / 555 / 777) gets the cabinet's own per-code block. A chat that is also staff is never the AI's (`staffForChat`). **Law 4:** no price is said in the bot at all; the relay copy carries the customer's words and the closed reason — never a figure the AI computed; the seller's copy is today's. The VED can read no bot transcript (no screen is added for it).

## A6. Prompt, policy and gate
- **Prompt:** `stableHead` (`prompt.ts:56`) gains a REQUIRED `profile: 'seat' | 'bot'`. Bot head, proposed: «Sen GSR LOGISTICS botidagi AI yordamchisan. Mijoz allaqachon tanilgan (kodi bog'langan). Faqat uch narsaga javob berasan: yuk holati (cargo_status), bizning manzillar va Bilimlardagi oddiy savollar. Narx, hisob-kitob, chegirma, shikoyat, fayl, kod — seniki emas: relay_to_seller. Bilmasang — relay_to_seller. O'zingni odam dema.» A second cached head; the seat's head is untouched.
- **Guard:** `releaseTurn` exactly as ⟨3b⟩ `live`, plus the allow-list — which means BOTH guards: the old policy (`checkTurn` → `checkAgentReply`) blocks a bot turn for every code whose step is not in `agent_guard_retired`, exactly as on the seat; the bot profile never reads a word rule as gone and adds no retirement of its own. Not asked in the bot (and why — these five are facts of the SEAT's send path in the old GATE, not word rules or readers): `language` (the chat's language is the customer's stored choice), `night` (a bot answering at night rings nobody — relays still obey staff quiet hours), `media` (media never reaches a run), the 2-minute hold (no price act exists here), `human_active` (see below). Kept: every block/permit rule, `ai_denial`, `complaint`, ⟨1a⟩ loop, the reviewer (fail-closed → relay).
- **«A person answered» is not visible in the bot.** On the seat an OUT row with no `agent_outbox` row means a person typed (`queues.ts:166-181` → `agent.human_reply` → `taken_over` + the 120-minute pause). The bot's chat has no such signal: sellers answer in their own Telegram or by phone. So the bot's rule is the mirror image — the RELAY is the hand-over, and the hold after it (`relay_until`) is the pause; the ❌ context (`DISPUTE_CONTEXT_MS`, `client-cabinet.ts:556`) is always a person's.
- **Corpora:** `agent-reader-corpus.test.ts` and `agent-policy-first-reply.test.ts` — untouched and green (no reader changes). The 303 (`docs/ai-toliq/corpora/customer-safety/*.json`, ⟨1a⟩ K1's fixture): run every case through `releaseTurn(…, 'bot')` — **all 303 must end `relayed`**; a case the bot profile would answer is a finding to bring to him. No known case is expected to change.
- **Wording (propose to him):** under an AI answer, once per day per chat: «— GSR AI yordamchisi 🤖» · button «💬 Menejerga yozish» · toast «Xabaringiz menejeringizga yetkazildi.» · alarms: «⚠️ Telegram AI raqamini CHEKLADI. Hozir bu raqamdan hech narsa ketmayapti. SIM turgan telefonda @SpamBot'ga yozing, cheklov tugash sanasini ko'ring, so'ng saytda «Raqam holati»da "Cheklangan"ni tanlab sanani yozing va «Tekshirdim»ni bosing — AI yana JAVOB bera boshlaydi, o'zi birinchi yozmaydi.» · «⛔ Telegram AI raqamini MUZLATDI — yozib bo'lmaydi. Telegram ilovasidagi "Appeal" orqali murojaat qiling. Mijozlar hozir botdan va sotuvchilardan javob olyapti.» · «🚫 AI raqami yopilgan. «Zaxira raqamga o'tish» tayyor.» · the switch confirm: «Zaxira raqamga o'tasizmi? Eski suhbatlar ko'chmaydi. Yangi raqam hech kimga birinchi yozmaydi — mijozlar uni bot, sayt va sotuvchilardan biladi. Birinchi 14 kun kuniga ko'pi bilan {N} ta javob.»

## A7. Tests (each shown RED by a paired string edit — never `git checkout`, #430)
| Test | Proves | Red proof |
|---|---|---|
| unit `agent-channel-profile.test.ts` | each allowed action passes and each other one relays; `sorab` and `odam` relay for every action; `tell_balance` at `ozi` / `nazoratda` answers and at `sorab` relays; the 303 all relay | add `tell_table_price` to the list → the price cases answer |
| integration `agent-channel.integration.test.ts` (transport stub `__setTelegramTransport`, `send.ts:44`; stand-in model `deps.callModel`) | a linked chat's status question → one Bot API send, no forward, no ack; a price question → forward + ack + hold; during the hold everything forwards; a media burst never starts a run; a redelivered update neither re-runs nor re-forwards; a dead job → the sweep relays; an unlinked or staff chat → today's path; one migration behind → today's path | drop the hold check → the second line is answered; drop the once-key → two runs; drop the sweep step → silence |
| unit `agent-channel-isolation.test.ts` (source-shape, TypeScript's parser, comments stripped — #725) | no file under `agent/channel*` or the bot path writes `agentOutbox`, `agentDrafts` or `tgMessages`; `client-cabinet.ts` reaches wms only by dynamic import | add one `insert(agentOutbox)` → red |
| unit `agent-account-state.test.ts`, integration `agent-reserve.integration.test.ts` | the state words are a Record over the union; limited + «Tekshirdim» resumes replies and keeps write-first off; the door refuses each missing precondition; after it the old seat's lead is the machine's (`seatUserIds`), the ramp is the typed number and not 80, nothing is sent from the reserve before he switches on; **after it a prixod of a client the OLD seat won still reaches both ranks of the pair through the drain (⟨1c⟩'s `agent-seat-mail` re-run with a retired seat), the deputy can still refile it, and under `company` the retired seat's cargo is neither ranked nor payable** | remove `retired` from `seatUserIds` → `calc_foreign`; read `started_at` → the full cap; leave `readdress` on the single seat → the prixod message lands in the retired user's mailbox |
| fences | `agent-fences` + the new channel purge fence; `cabinet-bot-wiring`, `cabinet-dispatch-order` (the AI is never awaited on the poller); `notification-mutes`; `locales`, `i18n-keys`; `migration-journal`; `tx-pool` | — |
| e2e | NEW spec `m9zzzr-ai-kanal` (the existing `m9zzzg-ai-sotuvchi` is NOT extended — it runs before every AI stage's spec and what it left behind would be their input, #154): the bot switch, «Raqam holati», «Zaxira raqam» panels at 360 px in `ru`, settings put back as a final TEST (#183); `m9k-cabinet` untouched and green. **Naming, said once for the three parts (lead ruling R4):** the AI specs run in STAGE order after the directory's last file (`m9zzzj-sotuvchi-yuk` at HEAD) — 1b+1c `m9zzzk-ai-suhbat` · 2 `m9zzzl-ai-koradi` · 3a `m9zzzm-ai-quti` · 3b `m9zzzn-ai-huquqlar` · 4 `m9zzzo-ai-narx` · 5 `m9zzzp-ai-yopish` · 6 `m9zzzq-ai-pul` · 7 `m9zzzr-ai-kanal` · 8 `m9zzzs-ai-birinchi` · 9 `m9zzzt-ai-olchov`. The names are proposals — on the day take the next free prefix after the directory's last file and keep stage order | — |
**Only on his server** (no Telegram, no model key here): with `agent_bot_ai` on, a staff phone linked as a test client asks «yukim qayerda» in the bot and gets the same lines «📦 Yuklarim» prints; asks a price and sees today's «yetkazildi»; the seller's copy carries the reason. He checks «Kunlik tekshiruv» that evening. The reserve: he connects it, the panel turns green; the door is NOT pressed as a test (it changes the live line).

## A8. Order of work
K → **P1** and **P3** in parallel worktrees (4 CPUs = two at a time; name the base commit) → **P2** (needs P1) → **P4** (needs P3). Cherry-pick P1, P2, P3, P4. `client-cabinet.ts` is P1's alone; `account-alarm.ts` is P3's. Judge before code with a send lens («can a bot line reach the seat's tables?») and a silence lens («which path ends with the customer hearing nothing?»). Ritual in CI's order on a fresh database; `pnpm typecheck`; the three corpora before and after.

## A9. Deploy
Ledger = the journal's length (read it). **Rebuild tg-listen**: `outbox-store.ts` (the listener's) imports `account-alarm.ts` (`:6`) and reads the ramp — re-check the closure with `tests/unit/tg-listen-agent-wire.test.ts`. No script through `migrate`. He touches: «Kim javob beradi» → `seat_phone`; registers the reserve SIM on the official app (name, photo, @username, 2-step password he keeps), connects it at «Telegram ulash» under its own login, marks «Ish raqami», picks it as the reserve; leaves `agent_bot_ai` OFF for a day, then on. First morning: the line «Botda: …». Rollback: revert the code; the tables are ignored, `agent_bot_ai` unread; a run row with `trigger 'channel'` is inert to old code. After the door has been pressed there is no code rollback of the SWITCH — it is undone by the same door.

## A10. Risks, traps, stated-not-built
- The seller hears a relayed question up to ~1 minute later than today (debounce + run). A wrong status to the RIGHT person is possible only through the cabinet's own block — the same text the button prints.
- A customer who gets an AI answer and a seller's answer to the same question: the hold limits it, nothing removes it. Customers can block the bot — then «yukingiz keldi» stops too (`critic-telegram.md` B7); the AI never initiates here.
- The reserve is continuity, not immunity: connected through the same unofficial client it is «under observation» from day one; presented to him as «a line to answer on», never as a way to go on doing what limited the first (bot ToS 5.2(f) is about bots; nothing is published for users — UNVERIFIED). UNVERIFIED: whether a session that only listens counts as activity against Telegram's inactivity self-destruct; hence «oxirgi tekshiruv» and a monthly reminder to open the app.
- Traps: a `values([])` on an empty burst; the ack sent before the run declined (never — the ack is the relay's); a second `stableHead` profile doubling the cache write; `agent_runs.manager_user_id NOT NULL` with no holder; the stale-button case of `ai:m:` after a purge (answer in words).
- **Stated, not built:** prices in the bot (question 2); a lead (unlinked chat) served by the AI in the bot; reading a file sent to the bot; the Mini App as a chat; a staff screen for bot transcripts; an automatic switch to the reserve; migrating chats between numbers.

## A11. Questions for the owner (Uzbek; ⭐ = what is built meanwhile)
1. **Botdagi AI o'zini kim deb tanishtiradi?** ⭐ a) ismsiz — «GSR AI yordamchisi» · b) AI raqamidagi ism bilan.
2. **Botda jadval narxi.** ⭐ a) yo'q — narx so'ralsa sotuvchiga o'tadi (28-javobingiz: holat, manzil, oddiy savollar) · b) ha, jadval narxini botda ham aytadi.
3. **Zaxira raqamni tizimga ulash.** ⭐ a) hozir ulab qo'yamiz, AI unda o'chiq turadi · b) faqat telefonda turadi, kerak bo'lganda ulaymiz. ⚠ a) da raqam Telegramga hozirdan «norasmiy dastur orqali kirgan» bo'lib ko'rinadi.
4. **Zaxiraga o'tilganda birinchi 14 kun kuniga nechta javob?** ⭐ a) 20 · b) 40 · c) o'zingiz yozasiz.
5. **Zaxiraga o'tilganda eski AI raqamiga yozgan mijozlarga botdan bitta xabar.** ⭐ a) ha, matnini siz tasdiqlaysiz · b) yo'q.
6. **AI javob bermay sotuvchiga o'tkazganda sababi yozilsinmi?** ⭐ a) ha, qisqa («narx so'radi») · b) yo'q, bugungidek.
7. **«Hammasini to'xtatish» tugmasi botdagi AIni ham o'chirsinmi?** ⭐ a) ha · b) yo'q, bot alohida.

---

# PART B — STAGE 8 «O'zi yozadi»

## B0. Header
| | |
|---|---|
| The owner stops | remembering who was quoted and went silent; writing «Juma muborak» by hand; and — the reverse — wondering each morning what the AI will send unasked |
| Size | **M-L** (2-3 weeks): the riskiest act for the account; the reviews will outlast the build |
| Depends on | ⟨4⟩ the quote record; ⟨3b⟩ rights rows `followup`, `greeting` (today «Faqat odam») and the stop button «birinchi bo'lib yozish» (`agent_stop_first`, `STAGE-3B.md` §3.3 — it ships `true` = stopped and has no reader until this stage); ⟨1b⟩ reserved triggers `followup` / `campaign`, draft kinds `followup` / `greeting`, outbox `part_kind 'first'`; ⟨1a⟩ `morning.ts`, `agent_work_hours` / `agent_work_days`; stage 7 (`agent_accounts.write_first_off_until`, the bot as a carrier with no window) |

## B1. Behaviour, before → after
| Who | Before | After |
|---|---|---|
| Customer quoted a price who goes silent | nothing, ever (`map-as-built.md` §5 row 3) | one reminder the next working day, one on day 5-7, in daytime, in their own words' topic, with no figure; then silence for good. «Yozmang» → never again, and a system line says so |
| Customer who wrote to the AI number in the last 90 days and is quiet | nothing | at most one greeting a month, on a Friday afternoon, written for that person |
| Every other linked client | nothing | the same greeting through the company bot, at most monthly, with «🔕 Bunday xabarlar kerak emas» |
| Anybody who never wrote to the AI number | nothing | nothing from the AI number — by schema and by the send step |
| Owner | — | approves each campaign ONCE; at 08:40 reads «Bugungi reja» with one switch; hears at once when the AI stopped itself |
| Sellers | follow-up dates on their call list (`set_followup`) | unchanged |

## B2. His answers that bind, and what stays FORBIDDEN
- **24 a ⚠** (reverses «AI birinchi yozmaydi», TELEGRAM-CRM.md:313-316 — he saw the ⚠): «two reminders (next working day, day 5-7), then it stops; daytime only; 10 a day in all; "yozmang" = never again; one block stops them for everybody»; from the bot when the quote was taken there (`critic-telegram.md` Q23).
- **26 a ⚠** (weakens his own «3 … juma kuni soat 2 da tabrik» of SPEC-P3: weekly → monthly per customer — the question carried the ⚠ on the page): «from the AI number only to people who wrote to it in the last 90 days (≤ 10 a day shared with Q24, a text per person, once a month per customer); everybody else through the company bot with a "🔕 kerak emas" button; each campaign approved once»; Friday from 14:00 Tashkent, at scattered times (SPEC-P3 §0).
- **27 a**: no road news unasked. **4 a**: never first at night. **12 a**, **10 c**. **§11.2**: who is told when the AI stops = `designated('supervisor')`.
- **FORBIDDEN:** a first message to a peer with no inbound line on THIS account (schema + send step, §B3); a figure, date, price, discount, deadline or question-that-needs-an-answer in any write-first text; a third reminder; a reminder about an expired, superseded or person-owned quote; any «mashina jo'nadi / chegarada / kechikdi» message from either carrier (27 a) and any new `client_notices` push kind for it; payment reminders (⟨6⟩'s single «amount once» is not this stage); a custom campaign from the AI number; a campaign with no stored approval; raising the shared 10; contacts import or phone → peer resolution (`map-sale-doors.md` §0.3: none exists — keep it so); the reserve number writing first.

## B3. Data — ONE migration, additive, tag `agent_first`
| Table (names grepped free) | Columns that matter | Notes |
|---|---|---|
| `agent_first_plans` | `id`; `kind` CHECK IN (`quote_reminder`,`greeting`); `step smallint`; `carrier` CHECK IN (`seat`,`bot`); `tg_user_id bigint NOT NULL` (the person: the seat's peer id and the bot's chat id are the same number); `manager_user_id` (seat rows); `client_id`, `lead_id` with CHECK one NOT NULL; `quote_id` (⟨4⟩; CHECK NOT NULL for a reminder); `campaign_id` (CHECK NOT NULL for a greeting); **`anchor_tg_message_id bigint`, CHECK `carrier = 'bot' OR anchor_tg_message_id IS NOT NULL`**; `day date` (Tashkent); `due_at`; `month date`; `status` CHECK IN (`planned`,`drafted`,`sent`,`skipped`,`cancelled`,`failed`); `skip_reason`; `draft_id UNIQUE REFERENCES agent_drafts ON DELETE CASCADE`; `bot_message_id`; `answered_at`; UNIQUE (`quote_id`,`step`); partial UNIQUE (`tg_user_id`,`month`) WHERE `kind = 'greeting'` | the plan IS the claim. «Once a month per customer» across both carriers and all campaigns is the unique index, not a count. Seat rows hold text about a customer's chat → named in `purgeAgentChat` (`purge.ts:33`) |
| `agent_campaigns` | `id`; `kind` CHECK IN (`friday`,`custom`); `title`; `rule jsonb`; `bot_texts jsonb` (per language, 2-3 variants); `approved_by`, `approved_at` (paired CHECK); `paused_at`, `pause_reason`; `created_by` | the migration inserts NO row; the Friday definition is a code default that becomes a row at HIS approval |
| `agent_contact_stops` | `tg_user_id bigint`, `scope` CHECK IN (`all`,`greetings`), PK (`tg_user_id`,`scope`); `client_id`, `lead_id`; `source` CHECK IN (`words`,`block`,`button`,`person`); `said text` ≤ 200; `created_at`; `lifted_by`, `lifted_at` | keyed by PERSON, so it holds on the seat, in the bot and on a reserve. A chat purge blanks `said` and KEEPS the row (a do-not-contact outlives the chat) — a named exception in the purge fence |
**The never-wrote fence, in the schema.** ⟨1b⟩ made `agent_drafts.anchor_tg_message_id` and `agent_outbox.answers_tg_message_id` nullable for the reserved kinds (HEAD: both NOT NULL, `schema/agent.ts:182`, `:265`). **Stage 8 does not use that allowance on the seat:** every write-first draft and outbox row carries the peer's newest INBOUND line as its anchor. Then the existing fences hold by construction and unchanged — `anchor_gone` (`send-step.ts:197`), `anchor_superseded` («the customer wrote since» = the reminder is moot, `:209`), `human_replied` («a person wrote since», `:199`), `never_wrote` (`:215`) — and the plan's CHECK refuses a seat row with no anchor. A draft of kind `followup` / `greeting` without a plan row is refused at the send (`plan_missing`, fail closed).
**CHECKs:** none re-made if ⟨1b⟩ reserved `followup`, `greeting`, `campaign`, `first` as its plan says — verify on the tree; otherwise re-make each from the last migration that did. `client_notices`: NO new kind (27 a; the fence of §B7 pins `SWEPT_NOTICE_KINDS`, `arrival-jobs.ts:214`). **SQL-only:** none (no column on an old table). **Probe** `agentFirstReady()`: the three tables. **Behind:** no plan is made, the morning plan line and the page section are absent, the stop-word reader still mutes the chat the old way (`agent_conversations.muted_at`), a 🔕 press answers «hozircha ishlamayapti».
**Settings:** `agent_first_per_day` `10` (0-10; 0 = off) — reminders + greetings from the AI number, per Tashkent day · `agent_first_window` `10:00-18:00` (working days of ⟨1b⟩ `agent_work_days`). The master switch is ⟨3b⟩'s stop button «birinchi bo'lib yozish» — the setting `agent_stop_first` (`true` = the AI writes first to nobody), ONE key under ONE label on every screen; this stage mints no `agent_initiative` beside it (only if ⟨3b⟩ as built has no such key does this stage add it, under ⟨3b⟩'s name) — read through ONE home `initiativeAllowed()`; it ships OFF and `followup` / `greeting` keep their ⟨3b⟩ position «Faqat odam» until he sets them. Constants he fixed live in `agent/limits.ts` `FIRST_LIMITS` (one home): reminder days `[1, [5, 7]]`, wrote-within 90 days, quiet 7 days, greeting once per month, Friday 14:00-17:30, gap between two write-first sends ≥ 7 min.

## B4. Code
### B4.0 Kernel K
| File | Change |
|---|---|
| migration, schema, probe, settings, `FIRST_LIMITS` | §B3 |
| `agent/first.ts` (new, pure) | `firstSendVerdict(row, facts)` beside `agentSendVerdict` (`send-step.ts:185`): everything that function refuses, PLUS finals `initiative_off`, `stopped`, `wrote_too_long_ago` (> 90 days; replaces `anchor_too_old`'s 24 h for these rows only, through `anchor-clock.ts`), `quote_gone`, `plan_expired` (today's window closed — never carried to tomorrow; replaces the 6-hour approval age), `plan_missing`, `write_first_off` (stage 7's date); waits `first_window`, `first_gap`, `first_day_cap`. `carrierFor(plan)`; `scatter(day, n, seed)` |
| `agent/contact-stops.ts` (new) | the ONE home of «may anything unasked reach this person»: `stoppedSql(tgUserId, kind)`, `stopPerson(…)`, `liftStop(…)`. Replies are never asked |
| `tests/unit/fixtures/agent-first-corpus.ts` + its test | written BEFORE the readers (§B6) |

### B4.1 P1 «To'xtash» — opt-out and automatic stops (owns `contact-stops.ts`, `agent/stop-words.ts`, the listener hook, the cabinet callback)
- **`stopWordsIn(burst)`** — a closed six-language list over the CUSTOMER's lines, code and never the model (critic-guard C.6.7): «menga yozmang», «boshqa yozmang», «bezovta qilmang», «не пишите», «отстаньте», «хватит писать», «stop», «unsubscribe», 别再发, «دیگر پیام ندهید», and «yozmang» / «не пиши» as a whole message. NOT a hit: «narxini kamaytirib yozmang», «xato yozmang» (the policy already met these, `policy.ts:867`). A hit → `stopPerson(scope 'all', source 'words')`, the chat's ⟨3b⟩ `mute_chat` is NOT implied (replies continue), and one system reply (§B6). **A seam with ⟨3b⟩'s right `mute_chat`** («Yozmang» degan mijozni o'chirish, which its question 6 may put at «O'zi»): until this stage the model answers «yozmang» by proposing that act, and a muted chat gets NO replies. From this stage the words are code's — so the prompt's rule for «yozmang» stops proposing `mute_chat` in the same commit (the act stays for the pair's button and for abuse); otherwise one sentence of a customer stops the unasked messages AND, through the model, the answers, and §B7's «still answers their next question» is false wherever that right stands at «O'zi». A false hit costs a reminder; a miss can cost the account — the list leans wide.
- **A block**: `outbox-store.ts:637-641` already sees `USER_IS_BLOCKED` on a send and counts two in seven days to switch the agent off (`account-alarm.ts:181`). Added before that count: the person is stopped (`source 'block'`), and **if the blocked row is a write-first one, or the chat received a write-first message in the last 14 days, initiative goes OFF for everybody** (24 a) — replies continue; alarm to `designated('supervisor')`. A block is learned only when we next try to send (Telegram tells nobody) — say so.
- **Other automatic stops** (each a closed reason, each an alarm, each lifted only by his press): any account pause or flood on a write-first send; Telegram's service notice (already forces everything off); two `stopWords` hits within 7 days on chats that received a write-first message; in the bot — three «bot was blocked» answers in one campaign run pauses that campaign.
- **«🔕»**: inline button on every bot greeting, callback `nb:g` in `client-cabinet.ts` beside `mg` → `stopPerson(scope 'greetings', source 'button')`, the keyboard is removed, a toast. Operational pushes are untouched. `nb:` is free at HEAD (the cabinet's handlers are `lang:`, `ph:`, `mg`, `yt:` — `client-cabinet.ts:1127-1204`; the staff parser's `n:` forms are `new|save|cancel|share`, `p<digits>` or a uuid, so `nb:g` falls through to the cabinet), and stage 7's derived cabinet fence («every `callback_data` the cabinet builds is one its handlers parse», §A4.1) is widened to it in the same commit.

### B4.2 P2 «Eslatma» — the silent quote (owns `agent/reminders.ts`, the planner step, the `followup` run)
- **Planner** (pg-boss `'30 3 * * *'` = 08:30 Tashkent, before ⟨1a⟩'s 08:40 line): for each ⟨4⟩ quote that still STANDS — not expired at the due moment, not superseded, its card open, no code or deal since, told by the machine (never his 💵, never a seller's offer: `calc_person_offer`'s rule), the customer silent since, no person's line since, no open case or complaint, chat not muted / excluded / a prospect / a stranger, person not stopped — plan step 1 on the next working day (≥ 20 h after the quote) and step 2 on a scattered working day 5-7; `due_at` scattered inside the window. A colleague's customer is planned only if the QUOTE was the AI's (question 2).
- **Carrier** (`carrierFor`): `bot` when the quote record says it was told in the bot (possible only if A11-2 is answered b) or when the seat cannot write (account state, `write_first_off_until`) and the person has a linked chat; else `seat`. A bot reminder is one `sendText` with an approved per-language text and no window.
- **The run** (`trigger 'followup'`, the fast tier, one round), started by the minute sweep (`agentSweep`) for a plan whose `due_at` has passed — `planned` → `drafted` by compare-and-set, so two sweeps draft once: the prompt gets the quote's GOODS words and the chat's last lines, never the figure; output through `releaseTurn` with the first-message profile (§B6); the row is born with `part_kind 'first'`, anchor = the newest inbound. A write-first turn is exactly ONE message whatever `agent_turn_max_parts` says (R6 counts messages; here the count is fixed at one — no holding line, no second part, nothing appended by code). Position `nazoratda` → it goes and lands in the check list; `sorab` → a card per message; `odam` → nothing is planned.
- **The listener**: `runAgentStep` asks `firstSendVerdict` for a `first` row; choreography = typing → send, with NO `ReadHistory` (there is nothing new to read, and marking an old chat read at 11:00 is itself a signal). Counted in the ordinary hour and day caps AND in `first_day_cap`.
- An answer is an ordinary inbound run; the plan stores `answered_at` (stage 9's measure). `set_followup` (`decide.ts:1380`) stays a date for a PERSON's call list — unchanged.

### B4.3 P3 «Juma» — the greeting (owns `agent/campaigns.ts`, the Friday planner, `platform/broadcast` keyboard)
- **Approval once**: page section «Kampaniyalar» shows the default definition (who, how many, the bot texts per language, three example AI-number texts) → «✅ Tasdiqlash» writes the `agent_campaigns` row (the supervisor only — ⟨1b⟩ `mayApproveKnowledge`'s rule, never the deputy). Editing the bot text un-approves it.
- **Friday planner** (inside the 08:30 step on Fridays): seat candidates = peers with an inbound on this account in 90 days, quiet ≥ 7 days, card the seat's or nobody's (`machineMayTouch`), language uz / uz_cyrl / ru / fa, not stopped in either scope, no open VED job or case («we owe them an answer, not a greeting»), not a lost lead, no greeting this month, the last two greetings not both unanswered. **Order**: reminders take the day's slots first; greetings fill the rest by longest-since-greeted; who does not fit waits for next Friday (the plan line says how many). `due_at` scattered 14:00-17:30, ≥ 7 min apart.
- **Bot side**: linked clients not planned on the seat, greetings not stopped, none this month → one `broadcasts` row per language (`createBroadcast`, `broadcast/service.ts:129`, author = the campaign's approver) with the approved text and the 🔕 keyboard — `runBroadcast` (`broadcast/send.ts:38`) gains an optional `replyMarkup`; plan rows `carrier 'bot'` are the monthly claim.
- **The seat's text** (`trigger 'campaign'`): the person's name and the chat's last topic in; ≤ 200 chars; first-message profile.

### B4.4 P4 «Reja» — the plan in the morning line, the switch, the page
⟨1a⟩ `morning.ts` gains: «📅 Bugungi reja: 4 ta eslatma, 6 ta juma tabrigi — AI raqamidan; 212 ta tabrik — botdan. Navbatda: 23 kishi.» with ONE button «⏸ Bugun o'zi yozmasin» (the pair, `maySpeakForSeat`; a STAFF-bot callback, and ⟨1a⟩'s morning line carries links only — so it is an op of ⟨3a⟩'s grammar, `aq:fd:<uuid>`, `fd` free against 3a's six and stages 5-6's nine, the uuid being any of today's `planned` rows as the day's handle — the service re-derives the Tashkent day itself; ⟨3a⟩'s `agent-inbox-callbacks.test.ts` must read `morning.ts`) → today's `planned` rows become `skipped: day_off`; nothing is carried over. Page section «O'zi yozish»: the switch, today's plan (per recipient through ⟨1b⟩ `cardSightFor` — a VED-sight reader sees no amount), the stops list with «olib tashlash», the last 30 days as counts (sent · answered · stopped · blocked). Sent write-first messages enter ⟨1a⟩'s sample FIRST (they are the riskiest act).

## B5. Doors and sight
| Thing | Who | Predicate |
|---|---|---|
| approve / edit a campaign | the designated supervisor (holder when it is a person's own account) | ⟨1b⟩ `mayApproveKnowledge` |
| the day's switch, a 👎 on a sent message | the pair | ⟨1b⟩ `maySpeakForSeat` |
| turn initiative back on after an automatic stop; lift a stop; `agent_first_per_day` | the super_admin ROLE | as `setAgentSeat` |
| positions of `followup`, `greeting` | ⟨3b⟩ rights page gate | saved by ⟨1b⟩ `setActionRight` (R7). This stage widens `RightSpec.allowed` for both from «Faqat odam» to `sorab` and `nazoratda`; the plan builds NO `ozi` branch (§B4.2 names what `nazoratda`, `sorab` and `odam` do — a write-first message is always in the sample) |
**Identity:** a write-first row dies on `identity_changed` like any reply (`send-step.ts`). **Law 4:** no write-first text holds a figure, so nothing can leak; the plan list shows a quote's amount (a CLIENT price) to no reader of sight `none` — ⟨4⟩'s rule for the block «🤖 AI aytgan narx» and §B4.4's own sentence; this line said «only to `all`» and the two disagreed. A colleague's customer never receives a greeting from the AI number (the bot greets them as «GSR»).

## B6. Prompt, policy and gate
- **First-message profile** of `releaseTurn` — stricter than a reply: zero digits and zero spelled numerals in ANY script (`digits.ts` readers, reused read-only); no currency word; no promise class with or without a permit; no question mark in a greeting, at most one in a reminder; no link; no «oxirgi», «bugun tugaydi», «shoshiling» pressure words (closed list); ≤ 200 chars; the reviewer fail-closed. Never rests on the reviewer alone.
- **The fingerprint fuse.** `textFingerprint` (`policy.ts:2718`) folds case, digits and spacing and CUTS the customer's names — so «Assalomu alaykum, {ism}! Juma muborak!» is one fingerprint for everybody. For write-first rows G10 (`policy.ts:2861`: > 3 other peers in 24 h) becomes **zero tolerance over 30 days**: a text whose fingerprint equals any other write-first text sent from the seat to another person → one regeneration, then the plan is `skipped: same_text`. Bot texts are identical by design and are exempt (a bot is not judged like a person).
- **Prompts** (two short heads, cached): reminder — «Mijozga narx aytilgan, javob yo'q. BITTA qisqa xabar: salom, qaysi yuk haqida gap borganini o'z so'zlari bilan eslat, savol bo'lsa yozishini ayt. Narx, son, muddat, chegirma YOZMA. Bosim qilma.»; greeting — «Juma tabrigi: shu mijozga, uning tilida va yozuvida, iliq va qisqa. Savdo taklifi, narx, savol YOZMA.»
- **System lines (propose):** to «yozmang» — «Tushunarli, bezovta qilmayman. Savolingiz bo'lsa o'zingiz yozing — javob beraman.» · 🔕 toast — «Tushunarli. Tabrik xabarlari endi kelmaydi; yukingiz haqidagi xabarlar kelaveradi.» · bot greeting — «Juma muborak! GSR LOGISTICS jamoasi sizga tinchlik va baraka tilaydi. 🤲» · stop alarm — «⏹ AI o'zi yozishni to'xtatdi: mijoz bloklagan. Javob berish davom etyapti. Qayta yoqish — faqat sizning tugmangiz.» · approval card — «🕌 Juma tabrigi — bir marta tasdiqlaysiz. AI raqamidan: oxirgi 90 kunda yozgan, 7 kundan beri jim mijozlarga, har biriga alohida matn, kuniga ko'pi bilan {N} ta (eslatmalar bilan birga), har mijozga oyda 1 marta. Qolganlarga botdan: «…».»
- **Corpora:** the reader corpus gains reader `contact_stop` (DANGEROUS = a stop phrase missed; ordinary false hits may sit on the ratchet) — run the WHOLE corpus before and after (#1783). `agent-first-corpus`: ≥ 60 reminder / greeting texts labelled by hand, not by the code (a price, a date, «50% chegirma», a pressure word, a second question → held; plain ones → go). The 303 through the first-message profile: all held. `agent-policy-first-reply.test.ts` untouched. **Expected to change:** tests pinning `never_wrote` and `anchor_too_old` for EVERY row gain the `first` case (`agent-send-step.test.ts`); `docs/TELEGRAM-CRM.md`'s «Ommaviy tarqatma — yo'q» and «robot o'zi yozmaydi» are rewritten in the same PR to what he chose.

## B7. Tests (RED by paired string edit)
| Test | Proves | Red proof |
|---|---|---|
| unit `agent-first-verdict.test.ts` | each final and wait of `firstSendVerdict` on both sides; a peer with no inbound is `never_wrote`; 91 days → `wrote_too_long_ago`; the 11th row waits to tomorrow… and tomorrow is `plan_expired`; Friday 13:59 / 14:00 / 17:31 (fake clock) | drop the 90-day line; make the cap 11; carry the plan over |
| unit `agent-first-fences.test.ts` (source-shape) | no file but the two planners inserts `agent_first_plans`; every plan writer passes an anchor for `seat`; `SWEPT_NOTICE_KINDS` is exactly today's set plus ⟨6⟩'s; no import of a contacts or phone-resolve API anywhere under `src/`, `scripts/` | add a seventh notice kind; insert a plan in a third file |
| integration `agent-first.integration.test.ts` | a standing quote → two plans, no third; the customer's line cancels the pending one (`anchor_superseded`); a person's line too; an expired quote plans nothing; «yozmang» stops this person on the seat AND in the bot and still answers their next question; a block switches initiative off for everybody and replies go on; the monthly unique refuses a second greeting; the plan CHECK refuses a seat row with no anchor (raw INSERT); one migration behind nothing is planned | make the stop check per chat instead of per person; remove the block hook; drop the CHECK |
| unit `agent-first-fingerprint.test.ts` | two greetings that differ only by the name are ONE fingerprint → the second is skipped | compare with G10's «> 3» |
| integration `broadcast` (extend), `cabinet-bot` (extend) | the keyboard is sent; `nb:g` writes the stop and removes the keyboard; three blocks pause the campaign | — |
| corpora + fences | `agent-reader-corpus`, `agent-first-corpus`, `agent-fences` (purge, with the named exception), `tg-listen-agent-wire`, `locales`, `i18n-keys`, `migration-journal` | — |
| e2e | `m9zzzs-ai-birinchi` (stage 8's place on the ladder, §A7 — the plan had no browser spec for two new page sections): «Kampaniyalar» and «O'zi yozish» at 360 px in `ru` (`documentElement.clientWidth`); a seller is refused; the campaign's approval and the stop «birinchi bo'lib yozish» are put back in a final TEST (#183 — an approved campaign left behind PLANS greetings for every later spec's chats) | — |
**Only on his server:** the first week runs with BOTH actions at «So'rab» on staff phones' chats only (a card per message, he reads the real texts); then «Nazoratda». He checks: the 08:40 plan, the count on the page against what left the phone, a reminder's two steps on one test chat, «yozmang» on a test chat, 🔕 on his own bot chat.

## B8. Order of work
K (the corpus first) → **P1** (nothing else may ship without it) → **P2** and **P3** in parallel → **P4**. Judge before code with the account lens («what does Telegram see?»), the silence lens («which stop can fail to stop?») and the owner's eye. Rebuild and re-run the listener tests after every touch of `send-step.ts` / `outbox-store.ts`. A fixture's «next working day» stands on a fixed clock, never the real one (#1063, #1790).

## B9. Deploy
Ledger = the journal's length. **tg-listen MUST be rebuilt** (the first-row verdict and the block hook run there) — an old listener meeting a `first` row must refuse it: prove with the wire test before the deploy. No script. He touches, in order: «Kampaniyalar» → reads and approves «Juma tabrigi»; the rights page → `followup`, `greeting` to «So'rab»; the stop «birinchi bo'lib yozish» lifted; a week later «Nazoratda». First morning: «Bugungi reja: …». Rollback: switch initiative off (one press), then revert; planned rows are inert to old code; `agent_contact_stops` must NOT be dropped — the old code simply does not write first.

## B10. Risks, traps, stated-not-built
- **A spam report is invisible.** Telegram tells nobody; a block is learned only at the next send. The fuses are small counts, daytime, per-person texts, and stopping on the first sign — not knowledge. Say it to him in these words.
- The seat is weeks old: «wrote to it in 90 days» is a small set (count it with ⟨1a⟩'s `agent-stage0.ts audience` before promising numbers); most greetings will go through the bot, where a block costs that customer's «yukingiz keldi».
- A reminder goes to somebody who answered by PHONE: nothing in the chat says so. Only a seller's or his line in the chat, a code, or a stage move cancels it (stated).
- Traps: «next working day» computed on UTC; a Friday holiday; two planners racing (the unique indexes are the claim — keep them); a plan drafted at 17:58 and sent at 18:03 (`plan_expired`, never tomorrow); the stop reader fed OUR lines; a greeting to a chat where the customer's last line was a complaint.
- **Stated, not built:** payment reminders; «keyingi yuk?» as a first message; road news (27 a); a third touch; custom campaigns from the AI number; A/B of texts; detecting a report; un-stopping by the customer's own «yozavering».

## B11. Questions for the owner
1. **«Yozmang» va «🔕» qamrovi.** ⭐ a) «yozmang» / blok — hech qachon hech narsa so'ralmagan holda yozilmaydi (AI raqamidan ham, botdan ham; o'z savoliga javob va o'z yuki haqidagi xabarlar qoladi); «🔕» — faqat tabriklar to'xtaydi · b) ikkalasi ham hammasini to'xtatadi.
2. **Hamkasbingiz mijozi** (AI raqamiga yozgan): ⭐ a) eslatma — faqat narxni AI aytgan bo'lsa; tabrik — AI raqamidan emas, botdan · b) ularga AI umuman birinchi yozmaydi.
3. **Tabrik tillari.** ⭐ a) o'zbek, rus, fors · b) + ingliz. (Xitoycha — hech qachon.)
4. **Botdan tabrik.** ⭐ a) botga ulangan hamma mijozga, oyiga bir marta · b) faqat sotuvchisi yo'q mijozlarga · c) botdan umuman yo'q.
5. **Boshlanishi.** ⭐ a) birinchi hafta har bir xabar sizga karta bo'lib keladi (faqat sinov chatlari), keyin o'zi ketadi va kechki tekshiruvda ko'rinadi · b) darhol o'zi.
6. **Juma kuni 10 tadan oshsa.** ⭐ a) avval eslatmalar, qolgan joyga tabriklar, sig'maganlar keyingi jumaga · b) avval tabriklar.
7. **Ish kunlari** («ertasi ish kuni» uchun). ⭐ a) dushanba-shanba · b) yakshanba ham.
8. **Boshqa kampaniyalar** (Navro'z, hayit). ⭐ a) faqat botdan, har birini alohida tasdiqlaysiz · b) AI raqamidan ham, juma qoidasi bilan.

---

# PART C — STAGE 9 «Hodim sifatida o'lchanadi»

## C0. Header
| | |
|---|---|
| The owner stops | judging the AI by the cards he happened to read; asking «u nima foyda keltiryapti?» with no screen to answer it; finding a «To'lash» button beside a machine on /hodimlar |
| Size | **M** (1-2 weeks); mostly reads. The replay lab and the exam are ⟨1b⟩'s and ⟨3b⟩'s — only the version stamp is left here |
| Depends on | ⟨1b⟩ (cases, record, `agent_replays`), ⟨3a⟩ (topics and clocks), ⟨3b⟩ (`agent_action_uses`, `agent_fact_checks`), ⟨4⟩ quotes, ⟨5⟩ `agent_won_ownership`, stage 7 (`seatUserIds`, bot turns), stage 8 (plans) — each number is drawn only when its source exists |

## C1. Behaviour, before → after
| Who | Before (HEAD) | After |
|---|---|---|
| Customer | — | nothing changes |
| Owner | press statistics (`agent/stats.ts:90`), the last 20 auto sends, the dollar line at 20:00; the seat as an ordinary seller row in /crm/tahlil, the seller report, /hodimlar and the Saturday rating | one page «AI hodim → Ko'rsatkichlar» in a seller's shape; a Monday message «AI hodim, o'tgan hafta»; the seat's pay line says what it is |
| Accountant / staff | a KPI payable accrues to the seat like to a person (`kpi-service.ts:237`; nothing under `wms/staff/**` reads the seat) | the same number, labelled; whether it is PAID follows his answer (§C11-1) |

## C2. His answers that bind, and what stays FORBIDDEN
- **31 c + note**: «AI-won customers are counted like a seller's — as today — and this is a setting: company-owned / handed to a seller after the first cargo / counted like a seller. So the seat STAYS in KPI, the rating and the congratulations until he switches it.» (§11 withdraws design §6's «out of pay and rating from 1a».) Stage 9 changes NONE of that by default.
- **9 a**: the 👍/👎 sample is the quality signal — the page says plainly when nobody marked it. **10 c**: cost is shown, nothing stops on it. **§11.2**: who receives the report = `designated('supervisor')`.
- **FORBIDDEN:** taking the seat out of KPI, the rating or the congratulations by default or by migration; a percentage over a handful of cases; the model grading itself (its `confidence` is never a KPI); a number shown to a VED that holds a client price, or to a seller that holds a floor; a «one-tap rollback» of the prompt (not built — say so); moving a prixod stamp (`staff/stamp.ts`: never).

## C3. Data — ONE small migration, additive, tag `agent_measure`
| Table | Columns | Notes |
|---|---|---|
| `agent_weekly_reports` | `week date PK` (the Monday, Tashkent); `facts jsonb`; `sent_at`; `created_at` | the numbers he was SHOWN. Week-over-week reads stored facts, never a recomputation (a late prixod would move last week's number — `staff_group_posts.standings` is the precedent) |
| `agent_versions` | `id serial PK`; `digest text UNIQUE`; `parts jsonb` (digests of: the prompt head, lessons, general knowledge, rights positions, tier names); `first_seen_at` | written lazily by a run that meets a new digest; the draft / turn keeps the id in its existing `policy` jsonb — no column on a hot table |
No CHECK is re-made; no SQL-only column. **Probe** `agentMeasureReady()`: behind → the page draws from live reads with no deltas and no version split; the Monday job does nothing. **Settings:** `agent_seat_pay` — `pay` \| `shown` (§C4.3; default = today's behaviour until he answers §C11-1). The ownership setting itself is ⟨5⟩'s.

## C4. Code
### C4.0 Kernel K
`agent/kpi.ts` (new): pure assemblers over rows — `conversationsOf`, `firstAnswerOf`, `funnelOf`, `qualityOf`, `costOf` — and ONE reader `agentKpi(period, sight)`; `MIN_N = 20` (one home): a ratio or a median with fewer cases is returned as `{n, value: null}` and drawn «kam ma'lumot: 7 ta». **No new «seat-counting» file**: ⟨5⟩'s `staff/seat-mode.ts` is the ONE predicate pay, rating and congratulations ask about the seat — it already holds `seatMode()`, `seatOutOfPay()`, `seatExcludedSql(col)` and, from stage 7, `seatUserIds()`. Stage 9 EXTENDS it with the `pay` answer: `seatCounting()` → `{ownership, pay}` there (`pay` read from `agent_seat_pay`), and `seatOutOfPay()` answers true for `company` / `handover` (⟨5⟩) OR `pay = 'shown'` (here). (An earlier draft of this plan put a second home at `agent/seat-counting.ts`; a file under `agent/` imported by `wms/staff/**` would also have been the first such import — at HEAD nothing under `wms/staff/` reads the seat.)

### C4.1 P1 «Ko'rsatkichlar» — the page (`/suhbatlar/ai/korsatkichlar`, a tab of ⟨3b⟩'s «AI hodim»)
| Group | Number | Source (as read at HEAD unless marked) | Measurable at the real volume? |
|---|---|---|---|
| Ish | conversations (a chat-day with ≥ 1 customer line and ≥ 1 of our sends); first-answer time (median + share ≤ 2 min) | `tg_messages` ⋈ `agent_outbox.sent_at`; bot: stage 7 turns | counts from day one; the median from 20 conversations — per WEEK, never per day (the measured day had nine replies) |
| Ish | closed with no person; hand-overs by topic; a person's answer time | `agent_auto_verdicts.state`, ⟨1b⟩ `agent_cases`, ⟨3a⟩ topics | counts; shares only ≥ 20 |
| Voronka | new leads → kub and kg known → quoted → code → first prixod → paid | leads owned by `seatUserIds()` (`leads.owner_id`, `closed_at`), ⟨4⟩ quotes, receipts stamped to the seat (`staff/cargo.ts:116`), the FIFO paid reader (`finance/paid-cartons.ts`) | COUNTS for months; a conversion percent only from 30 leads in the step, with n beside it |
| Natija | kub / kg, LTL and FTL apart; first-contact clock against people | `stampedCargo` (`staff/cargo.ts:116`), `firstContactBySeller` (`crm/analytics.ts:342`) | yes — the same reader as a seller's row, so the two cannot disagree |
| Sifat | 👍 / 👎 and how many samples were left unmarked; confirmed mistakes by action; VED hand-backs of its jobs; quote-vs-prixod deviation | ⟨1a⟩ `agent_samples` (+ stage 7 turn marks), ⟨3b⟩ `agent_action_uses.mistake_*`, `agent_calc_links` ⋈ returned requests, the existing deviation reader | 👍 share only over MARKED samples, with «belgilanmagan: N»; mistakes as a list, never a rate |
| O'zi yozish | reminders sent → answered → won; greetings sent → answered; stops, blocks | stage 8 `agent_first_plans`, `agent_contact_stops` | counts |
| Xarajat | dollars a week; per conversation; per won client | `aiSpend` (`reports/ai-spend.ts:226`) — unpriced rows counted, never a $0 | per conversation from 20; «per won client» only as «$ ÷ N» with N printed |
| Odamlar bilan | the median seller's same numbers | the existing per-seller readers | shown only where both sides have n ≥ 20 |
Period = week / month (the `/crm/tahlil` period reader, `readPeriod`, `crm/analytics.ts:714`); from the day the seat first spoke. Money cells behind `companyMoneySight`; everything else behind `mayRunAgent`.

### C4.2 P2 «Haftalik hisobot» (`agent/weekly.ts`; pg-boss `'10 4 * * 1'` = Monday 09:10 Tashkent)
Builds last week's facts ONCE, stores `agent_weekly_reports`, sends ONE message per recipient to `designated('supervisor')` (claimed by the row; text per recipient — money lines only for `companyMoneySight`). The message is the page's numbers, with last week's stored value in brackets and every thin number marked.

### C4.3 P3 «To'lov qoidasi» — the seat on /hodimlar, in the rating, in the congratulations
What is true at HEAD: a prixod is stamped to the client's seller on its receipt day (`staff/stamp.ts:31`); the seat accrues a KPI line and a payable like anyone (`kpi-service.ts:237`, `:273`); `payKpi` (`:297`) writes an expense from a till to that «seller»; the rating ranks it (`rating.ts:61`); the staff group praises it (`celebrate.ts:53`, `:81`, `:184`). The payable is read by /hodimlar alone (`hodimlar/page.tsx:208-209`; grep finds no other reader) — it is in no balance sheet. Under each ⟨5⟩ ownership value, what stage 9 makes pay and rating READ:
| `agent_won_ownership` | Stamp of a new prixod | KPI line | Rating / congratulations | /hodimlar |
|---|---|---|---|---|
| `seller` (default, his 31 c) | the seat | accrues, as today | ranked and praised, as today | the seat's card, labelled «🤖 AI o'rni»; the pay control per `agent_seat_pay` |
| `company` | the seat (the stamp is how its result is measured) | computed, shown as «AI keltirgan», never payable | out of the ranking — one separate line under it, like FTL's; congratulations name «AI» with no hero mention | no pay control |
| `handover` | the seat for the first prixod, then the person he handed the client to (the stamp follows the client's seller on the receipt day — the existing rule) | the seat's first cargo as `company`; the rest is the person's ordinary KPI | the person is ranked for what is his | the person's card |
**«Pay» for a machine** — `agent_seat_pay`: `pay` = today (the button stands; pressing it writes an expense in the seat's name — money leaving a till to nobody) · `shown` = the line reads «KPI hisoblandi: $… — AI o'rni, to'lanmaydi», the button is not drawn AND `payKpi` refuses in the SERVICE with ⟨5⟩'s code **`not_payable`** — the one refusal `seatOutOfPay()` already raises under `company` / `handover`; this stage adds no second code (a button off a screen whose action still answers is hidden, not removed, #531). The KPI months of the seat are then never «paid», so the LTL/FTL freeze (`staff/kpi-lock.ts`) never locks its cargo — stated. Nothing is flipped by migration: the setting ships as `pay` and moves on his word.

### C4.4 P4 «Versiya» — what is left of the lab
⟨1b⟩ shipped the dry replay (`agent_replays`, `scripts/agent-replay.ts`, the «Sinov» tab); ⟨3b⟩ the exam and the shadow. Left here: the version stamp of §C3 — the page splits a period «v14 dan beri» and the journal shows which version wrote a reply. A change of lessons, knowledge or rights is undone on its own screen; a prompt or tier change is a deploy. No rollback button.

## C5. Doors and sight
| Thing | Who | Predicate |
|---|---|---|
| the KPI page, the weekly message | `mayRunAgent` (`config.ts:314`) to read; recipients = `designated('supervisor')` | — |
| money cells (invoiced, received, profit by stamp, dollars spent) | company money readers | `companyMoneySight` (`finance/scope.ts`) |
| the seat's KPI line and pay control | `maySeeStaffMoney` / `mayPayCommission` (`staff/door.ts:30-34`) | unchanged doors |
| `agent_seat_pay` | the super_admin ROLE | as `setAgentSeat` |
**Law 4:** the funnel counts quotes, never their amounts, for a reader without company money sight; no VED figure and no floor appears on the page at all (the «quote vs prixod» line is a count of deviations, with the amounts only on the existing finance screens). **Identity:** not touched.

## C6. Prompt, policy and gate
Nothing changes in the prompt, the policy or the gate. The three corpora must be byte-for-byte green; **no case is expected to change**. The only «guard» of this stage is on the numbers themselves: `MIN_N`, n printed beside every share, machine presses never counted in the «unchanged» rate (`stats.ts` already keeps `autoSent` apart — the gate never grades itself), the sample's 👍 share over marked rows only.

## C7. Tests (RED by paired string edit)
| Test | Proves | Red proof |
|---|---|---|
| unit `agent-kpi.test.ts` | each assembler on literal rows; n = 19 → null, n = 20 → a value; a chat-day with only our line is no conversation; the funnel steps are nested (a later step never exceeds an earlier one) | set `MIN_N` to 1; count a chat-day by our sends |
| integration `agent-kpi.integration.test.ts` | the page's kub equals `stampedCargo` for the same user and window (a second surface computed a DIFFERENT way — #1114's lesson); a retired seat's cargo is the AI's; a reader without money sight gets no money key at all (structural, like `SearchHit`) | drop `retired` from `seatUserIds`; return the amount unconditionally |
| integration `agent-weekly.integration.test.ts` | one report per week however often the job runs; the bracketed value is the STORED one after a late prixod moved the live number; per-recipient text | recompute last week live |
| integration `staff-pay` (extend), unit `staff-rating` (extend) | `shown`: `payKpi` refuses `not_payable`, the page draws no control, the number is unchanged; `pay`: exactly today; `company`: the seat leaves the ranking and gets its line, people's ranks are those of a run without it | remove the service refusal → the hand-posted pay succeeds |
| fences | `login-person-fence`, `receipt-stamp-wire`, `manager-stamp-wire` (no stamp writer added), `locales`, `i18n-keys`, `migration-journal` | — |
| e2e | NEW spec `m9zzzt-ai-olchov` (stage 9's place on the ladder, §A7; neither `m9zzzg-ai-sotuvchi` nor `m9zzs-hodimlar` is extended — both run before the AI stages' specs): the tab renders at 360 px in `ru` with a thin-data card; /hodimlar draws the seat's card in both pay modes, the setting put back as a final TEST. `m9zzs-hodimlar` stays green unedited | — |
**Only on his server:** the first Monday message against the page; the page's kub against the seat's row on /crm/tahlil; `/api/version` (a mostly-read stage — the count alone proves little).

## C8. Order of work
K → **P1** and **P3** in parallel → **P2** (needs P1's assemblers) → **P4**. P3 touches `wms/staff/**` and `hodimlar/*` only through `seatCounting()`; the stamp writers are not opened. Review as built with the numbers lens («which number can be right and still mislead?») and the regression lens over pay.

## C9. Deploy
Ledger = the journal's length; tg-listen NOT rebuilt (nothing in its closure); no script. He touches nothing to start: the tab appears, the first report comes the next Monday. Then he answers §C11-1 and sets `agent_seat_pay` himself. Rollback: revert; the two tables are ignored.

## C10. Risks, traps, stated-not-built — and how he reads each number
| Number | Read it as | When it moves |
|---|---|---|
| Suhbatlar, birinchi javob | how much work reached it and how fast | slower → the listener, the caps or a wait rule; look at the morning line's reasons |
| O'zi yopgan / odamga o'tgan | how often it needed a person, and for what | one topic growing → that topic's knowledge or right, not «the AI got worse» |
| Voronka | counts of real customers at each step | a step with small n is a list of people, not a rate — open it |
| 👍 / 👎, belgilanmagan | his own verdicts; unmarked = NO signal | «belgilanmagan» high → the quality number means nothing that week |
| Xarajat | the bill; nothing stops on it (10 c) | per-conversation cost doubling → a setting changed (the tier, the reviewer) |
- Risks: small numbers read as trends; the seat's kub looks large beside people's because it never sleeps (it is ranked with them by his 31 c); a `shown` seat changes what the accountant sees — tell her first; a version digest that changes on every lesson makes «since v…» windows short.
- Traps: Tashkent week boundaries (`platform/time/tashkent.ts`, never UTC); a ratio over a LEFT JOIN that turns «no data» into 0; `percentile_cont` over an interval returns text (the analytics file's own note); a fixture user deleted instead of deactivated (audit FK).
- **Stated, not built:** playbook-level conversion; a per-lesson effect («shu saboqdan keyin»); a rollback button; pay rules for a human seller who takes over an AI lead (⟨5⟩'s `handover` covers the client, not the commission); speech minutes (⟨2⟩'s own meter).

## C11. Questions for the owner (⭐ = recommended; until answered, today's behaviour stands)
1. **AI o'rnining KPI puli.** ⭐ a) hisoblanadi va ko'rinadi, lekin to'lanmaydi («To'lash» tugmasi bo'lmaydi) — ⚠ bu 31-javobingizdagi «bugungidek» ning PUL qismini o'zgartiradi: AI KPI va reytingda qoladi, tabriklanadi, faqat to'lov tugmasi yo'qoladi · b) bugungidek tugma turadi, hech kim bosmaydi · c) rahbarga (siz belgilagan odamga) to'lanadi. (31 c-javobingiz «sotuvchidek hisoblansin» edi — bu savol faqat PUL haqida. Siz a) ni ANIQ tanlamaguningizcha b) — bugungi holat — turadi: «sen aytgandek» degan javob bu savolda a) ni yoqmaydi.)
2. **Haftalik hisobot.** ⭐ a) dushanba 09:10, faqat sizga va o'rinbosaringizga · b) jamoa guruhiga ham (pulsiz) · c) kerak emas, sahifaning o'zi yetadi.
3. **Kam ma'lumotli foizlar.** ⭐ a) 20 tadan kam bo'lsa foiz ko'rsatilmaydi, faqat son · b) baribir ko'rsatilsin.
4. **Versiya.** ⭐ a) faqat belgi («qaysi sozlamalar bilan yozilgan») · b) kerak emas.

---

# PART D — STAGE 10 «Boshqa kanallar» (one paragraph; NOT planned here)

WhatsApp Business (Cloud API) and Instagram DM are **L each** and are not among the things his 32 answers ordered beyond «the order of §7» — nothing is built without a new «ha». What stage 7 leaves for them is the seam: `agent/channel.ts` (`Carrier`, `ChatSource`, the draft-agnostic `releaseTurn`) and the `agent_channel_*` tables, whose `carrier` CHECK gains a value per channel. What no stage built and each needs: an inbound webhook and a sender (no code exists — `lead_intakes.channel` knows `form | meta | telegram | webhook | site`, and the Meta integration is lead FORMS only, `wms/crm/meta-leads.ts`); identity (WhatsApp hands a verified phone → `activeClientsByPhone`; Instagram hands none → a lead, never cargo or money); and the platform's own law, read 2026-11-19 (`critic-telegram.md` §1.10): free-form replies only inside 24 hours of the customer's last message, approved templates outside it (review up to 24 h), opt-in required, service messages charged again since 2026-10-01 with 1 000 free a month per number, 250 new users a day outside the window until the business is verified — so stage 8's write-first rules do NOT transfer; they must be re-derived per channel. A separate number, never the AI seat's. Questions to ask him when the time comes: which number, who registers the Meta business, which of the bot profile's three answers (status, addresses, standard questions) the channel starts with.

## Verified references

Checked at HEAD **`bf37150c`** (journal tail `0150_batches_view`, 151 SQL files) by a reference verifier, no code run. **86 `file:line` references, each opened, and about 85 named things** (functions, constants, constraints, settings homes, test and e2e files, docs sections, DECISIONS numbers, cron expressions) grepped and read. Names marked ⟨1a⟩ ⟨1b⟩ ⟨2⟩ ⟨3a⟩ ⟨3b⟩ ⟨4⟩ ⟨5⟩ ⟨6⟩ were checked against the other plan files only (plans, not code). Everything not listed below was found as written — including both ramp claims (`agent_config.started_at` is stamped once, `config.ts:429`, so a switched number would start at the full cap; and a fresh `ramp_started_at` gives one send a day, `limits.ts:182-189`).

Corrections made (old → new):
- Header: «`qurish/STAGE-4-6.md` … ABSENT at this HEAD» → it exists now (`COVERAGE.md` still does not). The header now names what 4-6 PLANS for the three contracts and the three places this file must be re-fitted: (i) `agent_quotes` has no carrier column (needed for a bot-told quote, §A11-2 b / §B4.2); (ii) ⟨5⟩ already plans the home `staff/seat-mode.ts` and already takes the seat out of the pay and rating readers under `company` / `handover` — so §C4.0's `agent/seat-counting.ts` and §C4.3 must extend it, not be a second home, and `payKpi` keeps ONE refusal code (`machine_seat` here, `not_payable` there); (iii) ⟨6⟩ plans `tell_balance` at `nazoratda`, so «only at `ozi`» (§A0, §A4.2) never becomes true as planned — his call. **Steps re-thought:** C4.0 and C4.3 carry a re-fit note; nothing else moved.
- §A4.1: `sendTyping` (`send.ts:563`) → `:564`; `onceKey.message(…, 'channel_ai')` → `'channel_ai'` is a NEW member of the closed `OnceEffect` union (`once.ts:31`), `readyKey` is `:64`.

Flags: no model identifier («tez daraja» / «og'ir daraja» only), no person's name, no user id, no role key written as code content, no literal migration number. `seat_phone` / `reserve_phone` are designation topics, as the plan says.

Still `UNVERIFIED` (kept): which error a spam-limited account gets on a REPLY; whether a listening-only session counts as activity for Telegram's inactivity rule; that nothing is published about user-account automation limits beyond `critic-telegram.md` §1.7.

## Conformance

Checked against design §11, the contract's §4 and the other six plans (`qurish/COVERAGE.md` holds the trace).
No answer of his was contradicted. What was changed, and why:

1. **Header, §A0, §A4.2, §A7 — the balance in the bot.** «Only while `tell_balance` is `ozi`» could never come
   true: stage 6 has him set that right to «Nazoratda» (and ⟨3b⟩'s table said a third thing). The bot now releases
   an allowed action at `ozi` OR `nazoratda` — one rule for all seven, his 25 b included (a linked bot chat is
   phone-proven). The header's «decide with him» is gone: it follows from 25 b and 28 a.
2. **§A4.4, §C4.0, §C4.3, §C7 — ONE home of «who the seat is and how it is counted».** This plan carried a second
   home (`agent/seat-counting.ts`) beside ⟨5⟩'s `staff/seat-mode.ts`, and a second refusal code (`machine_seat`)
   beside `not_payable`; its own header said «re-fit» and the body had not been. `seatUserIds()` (stage 7) and
   the `pay` answer (stage 9) now extend ⟨5⟩'s module, and `payKpi` keeps `not_payable`.
3. **§A3 — two CHECKs not re-made twice.** `agent_runs_trigger_check` gets `channel` from ⟨1b⟩'s one migration
   (stage 7 is its first writer); the second anchor on ⟨3b⟩'s four tables re-makes one named CHECK each, which ⟨3b⟩
   now writes for this. `agent_quotes.carrier` is born in stage 4.
4. **§A4.3 — a stated stub** where stage 7's text leaned on stage 8 (`write_first_off_until` has no reader until 8).
5. **§B0, §B3, §B9 — one master switch for writing first.** Stage 8 named it «o'zi yozish» and offered a second
   key (`agent_initiative`); it is ⟨3b⟩'s stop button «birinchi bo'lib yozish», `agent_stop_first`.
6. **§C11 Q1 — «nazoratchiga» → «rahbarga»** (the pair is «rahbar va o'rinbosar» in every plan).

Confirmed, unchanged: the session only — no business connection, no `business_*` update, no second bot (12 a);
the AI in the company bot answers status, addresses and standard questions and relays the rest, with no price
(28 a) and no bot line ever in the seat's tables; a real reserve SIM that writes first to nobody and never
switches itself on (30 a); two reminders on a silent quote and then silence, 10 a day shared, «yozmang» for
good, one block stops write-first for everybody (24 a); the greeting from the seat only to people who wrote to it
in 90 days, once a month, everybody else through the bot with «🔕», each campaign approved once (26 a); no
road news unasked (27 a — fenced on `SWEPT_NOTICE_KINDS`); the seat stays in KPI, rating and congratulations —
`agent_seat_pay` ships `pay` and no migration flips anything (31 c); cost is shown and nothing stops on it
(10 c); every recipient is `designated(…)` (`seat_phone`, `supervisor`) — nobody named in code; law 4 — no figure
in a write-first text, no client price to a VED-sight reader, no floor on the KPI page; no reader of the three
corpora changes; three additive migrations (one per stage), each with its probe (`agentChannelReady`, `agentFirstReady`,
`agentMeasureReady`), each «next after the journal's tail».

## Seam check

2026-11-20 — the seams of this plan with the other later plans (`STAGE-3A.md`, `STAGE-3B.md`, `STAGE-4-6.md`,
`STAGE-7-9.md`) and with what `STAGE-1B-1C.md` mints and reserves, written to the lead's rulings R1-R9 of the same
day. Docs only — nothing was run. Each numbered step below was appended as it was finished; a step that is missing
was not reached.

**1. Rulings R1, R4, R5, R6, R7 (and R2 where a door reads the pair) — done.**
- **R4.** Stage 7 and stage 9 proposed to EXTEND `m9zzzg-ai-sotuvchi` (and `m9zzs-hodimlar`) — both run before the
  AI stages' specs, so their leftovers would be those specs' input. Now three NEW specs on the ladder:
  `m9zzzr-ai-kanal` (§A7), `m9zzzs-ai-birinchi` (§B7 — stage 8 had no browser spec at all for two new page
  sections; one row added), `m9zzzt-ai-olchov` (§C7). The ladder and the «proposals» sentence stand once, in §A7.
- **R2 / R7 / role keys.** The header sentence now names both designation readers, says what «super_admin, as
  `setAgentSeat`» in the door tables means (the extracted predicate, called) and that a position is saved only
  through `setActionRight`. §B5: the two write-first rights are widened to `sorab` / `nazoratda` — the plan builds
  no `ozi` branch and now says so.
- **R6.** §A4.0: a bot turn's parts are min(2, `agent_turn_max_parts`), every message counted. §B4.2: a
  write-first turn is exactly one message.
- **R5.** Nothing to change: the bot's status and balance are the cabinet's own renderers in the chat's stored
  language, and stage 8's texts are prose (checked as today, plus the first-message profile).
- **R1.** No sentence here re-addresses mail. But stage 7's succession breaks 1c's rule silently — see step 3's
  note on §A4.4 (written into the plan): after the reserve door, clients the OLD seat won keep it as their seller,
  and `readdress` / `actsForSeat` know only the CURRENT seat.

**2. One name for one thing (`COVERAGE.md` §C.7) — checked, nothing to rename.** `tell_balance` in the bot at
`ozi` OR `nazoratda` (header, §A0, §A4.2, §A7); `staff/seat-mode.ts` the one home, `not_payable` the one refusal
(§A4.4, §C4.0, §C4.3, §C7); the write-first switch is `agent_stop_first` (§B0, §B3, §B9); `agent_quotes.carrier`
born in stage 4 (header, §B4.2); «rahbar va o'rinbosar» (§C11). `agent/seat-counting.ts`, `machine_seat`,
`agent_initiative`, «nazoratchiga» stand only in sentences that say they are retired. One thing the names hid —
the seat is ONE id in three earlier pieces and a SET after this stage's reserve door — is written into §A4.4
(`readdress`, `actsForSeat`, `seatExcludedSql` / `seatOutOfPay`) with a test row and a red proof.

**3. Reserved CHECK values — every value this plan writes into a constraint ⟨1b⟩ re-makes is reserved there, in
the same spelling** (`STAGE-1B-1C.md` §3.1-§3.2, `COVERAGE.md` §C.5 read side by side with this file).
- Stage 7: `agent_runs.trigger = 'channel'` (reserved, first writer 7 ✓ — §A3 already says «re-make only if 1b
  as built left it out, from the LAST migration that re-made it»). `telegram_once`: the new effect `'channel_ai'`
  fits the key CHECK at HEAD (`^(m|q):[^:]+:[^:]+:[a-z_]+$`, 0130:25) — no re-make.
- Stage 8: triggers `followup`, `campaign`; draft kinds `followup`, `greeting`; outbox `part_kind 'first'` — all
  reserved with «first writer 8» ✓, and 1b's two anchor CHECKs already admit them (stage 8 still carries an
  anchor on the seat, §B3). `reminder` (reserved, no writer) is not written — a reminder's draft kind is
  `followup`.
- Stage 9: nothing.
- NOT CHECK values, but ⟨1b⟩'s rule «members of `agent.event`, never a new queue»: §A4.0 mints
  `agent.channel_inbound`. Left for the lead — it is the bot's twin of `agent.inbound` (a model run with a
  debounce and its own job id), so a stated exception reads better than a member; say which in 1b's row.
- The four `<table>_anchor_check` re-makes of §A3 are ⟨3b⟩'s tables, not 1b's — `STAGE-3B.md` §3.1 writes each
  as one named CHECK for exactly this.

**4. Rights and topics (the two tables are in `STAGE-3B.md` «Seam check» 4).**
- Rights: the bot's seven allow-listed actions are all ⟨3b⟩ keys, read and never widened here; `relay_to_seller`
  is this plan's one new act (fixed `ozi`, §C.3 ✓); `followup` / `greeting` are widened to `sorab` / `nazoratda`
  (§B5 — §C.3 says «8 widens» and not to what); stage 9 mints none. No section of this file writes a position:
  §B9's «the rights page → `followup`, `greeting` to «So'rab»» is HIS step, saved by `setActionRight`.
- Topics: `seat_phone` (§A4.3's alarm) ✓ §A.3. **`reserve_phone` is minted in §A3 and read by nothing in this
  file** — §A.3 lists it with fallback «the pair». Left for the lead: give the alarm's audience that topic once
  the reserve is `main`, or do not mint it.

**5. Stages 7-9 lean on ⟨3b⟩'s PR-A only.**
- §A0 said «⟨3b⟩ in `live`» — a MODE of PR-A, but readable as «after the demolition». Now: PR-A in `live`; none of
  PRs i-v needed or assumed. §A6: «`releaseTurn` exactly as ⟨3b⟩ `live`» now says what that is — both guards, the
  old policy deciding every code whose step is not retired; the five codes the bot does not ask (`language`,
  `night`, `media`, the 2-minute hold, `human_active`) are named as gate facts of the seat's send path, not word
  rules — so «not asked» retires nothing.
- Stage 8's first-message profile reuses `digits.ts` readers that ⟨3b⟩ lists under «never» deleted (§7.3 last
  row) ✓; `textFingerprint` (G10) is `keep` ✓; `stopWordsIn` is a NEW reader with its own corpus rows.
- Stage 9 reads ledgers of PR-A (`agent_action_uses`, `agent_fact_checks`) and no guard code.

**6. Law 4 and his answers — every sentence found, fixed in place.**
- (b) **17 c in the bot.** `tell_china_address` is on the bot's allow-list, but the tool list had no
  `receiving_address` — so the only way the bot's AI could say our China address was `kb_search`'s verbatim fact,
  with no road question and no flight refusal. §A4.2 now offers ⟨3b⟩'s tool (road question as one Bot-API part;
  «avia» or any doubt = a relay to the seller), and `STAGE-3B.md` §4.2 takes the receiving facts out of
  `kb_search`.
- (b) **31 c — §C11 question 1.** Its ⭐ (a) «hisoblanadi, lekin to'lanmaydi» changes the PAY half of «counted like
  a seller's — as today» and carried no ⚠; a bare «sen aytgandek» would have built it. The option now carries the
  ⚠ and the question says a bare «sen aytgandek» leaves today's behaviour (`pay`).
- (a) **§B5 against §B4.4** — who sees a quote's amount on the plan list: «only `all`» vs «not a VED-sight
  reader». One rule now (never sight `none`, ⟨4⟩'s rule for the same number).
- **§B4.1 against ⟨3b⟩'s `mute_chat`** — «yozmang» would stop the replies too wherever that right stands at
  «O'zi»; the prompt's rule changes in the same commit (written into §B4.1 and into `STAGE-3B.md` §6.3).
- Checked and left: no price of any kind in the bot (§A2); the relay copy holds the customer's words and a closed
  reason, never a computed figure (§A5); no bot transcript screen for the VED; no figure in any write-first text
  (§B2, §B6); the KPI page's funnel counts quotes and shows amounts only behind `companyMoneySight` (§C5); 10 c
  (cost shown, `agent_first_per_day` and `CHANNEL_LIMITS` are counts); 12 a (§A2: `allowed_updates` unchanged, no
  second bot); 19 c / 23 c / 29 b not touched; `agent_seat_pay` ships `pay`, `agent_won_ownership` stays ⟨5⟩'s.

**7. Callback prefixes.** Stage 7 `ai:m:<turn tail>` and stage 8 `nb:g` are CABINET callbacks, free at HEAD and
not matched by the staff parser (checked against `parseCallback`'s regexes); §A4.1 already demanded a derived
cabinet fence and §B4.1 now says it is widened to `nb:`. One STAFF-side button had no grammar — the morning
line's «⏸ Bugun o'zi yozmasin» (§B4.4): `aq:fd`, an op of ⟨3a⟩'s grammar. Stage 9 mints none. The whole map:
`ag:<letter>` — spent: twenty letters at HEAD, the last six (`d i m o q w`) ⟨1b⟩'s; no later stage may take a letter · `ar:` — stage 2 · `aq:<two letters>:<uuid>[:<8hex>]` — minted by ⟨3a⟩, ops `nm gb ex sc cx ak` (3a), `kt kw kr ky kn` (5), `da db dn dw` (6), `fd` (8) · `ai:` — stage 7, CABINET side · `nb:` — stage 8, CABINET side · ⟨3b⟩, 4 and 9 mint none.
