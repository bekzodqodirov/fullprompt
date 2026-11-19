# The whole sale, door by door — what a human seller does, what a machine could call

Read-only map of `/home/user/fullprompt` on 2026-11-19 (ledger 150, migration 0149). Paths are relative to
`src/modules/` unless they start with `src/` or `scripts/`. «Seat» = the AI's own `users` row
(`settings.agent_seat_user_id`, `platform/settings/agent-seat.ts`); «holder» = `agent_config.owner_user_id`, the
account the AI speaks from. On his server seat = holder = «BEKZOD AI sotuvchisi».

## 0. Five facts that shape every row

1. **Almost every write door needs a USER actor.** `ctx.actorId` null throws: `CrmError('unauthenticated')`
   (`moveLead`, `winLead`, `setLeadOwner`, `setFollowUp`), `CalcError('unauthenticated')` (`openCalcRequest`,
   `recordOffer`, `finishCalcRequest`), `ClientError('validation')` (`createClient`), `FinanceError('unauthenticated')`
   (`addTransaction`), `TaskError('unauthenticated')` (`createTask`), `ArrivalError`, `ApprovalError`, `PromiseError`,
   `IssueError`. The only null-actor doors: `crm/service.ts createLead(…, {system:true})`, `addActivity(…, {system:true})`,
   `crm/inbound.ts landInboundLead` (uses both), `crm/service.ts moveLeadByMachine` (audit `via:'ai'`, actor NULL),
   and the machine press `agent/decide.ts decideDraft(holder, id,'send',{digest,auto:true},{actorId:null})`.
   So today the AI acts **as the seat user** (`landIntake collectedBy: actor.id`, `recordOffer {actorId: o.managerUserId}`).
2. **The machine's reach onto a card is one predicate**: `agent/machine-owner.ts machineMayTouch` — a lead whose owner
   is nobody or the holder; a deal whose owner AND client's seller are nobody or the holder; a client whose seller is
   nobody or the holder. A colleague's card: his ✅ may act, the machine never.
3. **The AI never writes first.** Every draft hangs on an inbound anchor: `agent_drafts.kind ∈ reply|price|hand_back`
   (CHECK), `AGENT_LIMITS.anchorMaxAgeMs` 24 h (`calcAnswerMaxAgeMs` 7 d for a VED-answer reply), send-step finals
   `anchor_gone|anchor_edited|anchor_superseded|anchor_too_old`; the human queue refuses `never_wrote_first`
   (`crm/telegram-send.ts`). Nothing in `src/` or `scripts/` resolves a phone to a Telegram peer
   (no `contacts.ImportContacts` / `ResolvePhone`).
4. **Text only, both ways.** `agent/gramjs-adapter.ts` exposes `history / readHistory / setTyping / markUnread /
   send({peerId, body, randomId, replyTo})` — no file, photo, voice or location send. Inbound media is stored by the
   listener but the model reads only `prompt.ts MEDIA_WORD` («rasm», «fayl: <name>», «ovozli xabar (eshitilmagan)»), and
   the auto gate refuses the whole burst (`media`).
5. **The AI's whole toolset is closed** (`agent/tools.ts TOOL_SPECS`): `cargo_status`, `own_balance`, `kb_search`,
   `cargo_volume`, `yolkira_estimate`, `avia_estimate`, `calc_checklist`, `calc_price` (only while `calcPricing`),
   `compose_reply`. Its actions are three (`ACTION_TYPES`): `calc_submit`, `set_followup`, `mute`. After a reply is
   SENT, `agent/after-sent.ts` may write an offer and move a lead stage. That is everything it can do.

Why day one looked like «a greeting bot» (each a constant, not a mystery): `agent_auto_config.categories` default
`{greeting,qualification,faq,status}`; `min_confidence` 0.80 (tunable 50..100 since #1800, `setAutoMinConfidence`);
`price`, `calc`, `calc_price` ship UNTICKED; any `needs_owner`, card note, warning, photo/file/voice, `own_balance`
call or unarmed price = his ✅ (`auto-gate.ts AUTO_REFUSALS`: `needs_owner`, `notes`, `warnings`, `media`, `money`,
`category`, `low_confidence` …). And prompt rule 8 sends a plain «yo'lkira» question to `yolkira_estimate` (the
website table); `calc_submit` is told only for rastamojka/podklyuch (rule 11) and only after the customer names the
section («Bo'limni o'zing tanlama — so'ra») — so a truck-freight chat never produces `calc_submit` unless the tool refuses.

## 1. The table

Risk class legend: **R** reversible · **$** money · **C** customer-visible · **I** irreversible / cannot be unsent.

### a) A lead arrives

| # | What the human does today | Service function(s) | Who may call (actor / permission; null actor?) | Does the AI seller reach it | Risk |
|---|---|---|---|---|---|
| a1 | Stranger writes to a seller's connected Telegram. On a WORK number a lead opens by itself; on a personal one the seller answers a tray question («Bu mijoz / Yangi lid / Shaxsiy»). | `scripts/tg-listen.ts handleMessage` → `crm/telegram-live.ts decideIncoming` → `crm/unknown-chat.ts unknownChatAction(verdict, workAccount)` (`open_lead` / `ask` / `skip`) → `crm/chat-lead.ts leadForChat` / `phonelessLeadForChat` (hidden number, `bound_via='work_account'`) → `crm/service.ts createLead` with `ownerId = account's manager`. | Listener process; `createLead` accepts `{system:true}`; here actor falls back to the account's user. No permission. | **Yes, fully** — on the AI's own account (`work_account` on): the lead is the holder's, then `agent/queues.ts shouldStartAgentRun` (live inbound, agent owner's account, row stored) → `agent.inbound` → `agent/run.ts handleInbound`. Personal account: `agent/jobs.ts strangerCards` asks the holder. | R (lead can be lost; «Shaxsiy» purges), not C |
| a2 | Known client writes (phone on a client card). | `crm/telegram-import.ts classifyDialog` (phone match) → `storeIncoming` with `client_id`. | Listener. | **Yes** — `agent/context.ts chatIdentity` resolves client + phone-sibling codes; cargo/balance only when the chat PROVES it (`chatProof`: phone / peer index / linked cabinet → `cargoAllowed`). | R |
| a3 | Website visitor presses «Telegram» on gsrlogistics.uz; the site asks who is least busy; the visitor writes to that manager with a `GSR-…` tag. | `src/app/api/lead/assign` → `crm/site-assign.ts assignForTag` / `pickAssignee` / `roster` (users with `lead_teams`, `canLogInSql`, a reachable handle) → listener `siteTagAction` → `landSiteTag` → `landInboundLead({channel:'site', ownerId: receiver, knownLeadId})`. | Public GET (origin fence `lead_assign_origins`); landing is system. Roster edited on /admin/taqsimot (`admin.settings.manage`). | **Only if the seat is ticked into `users.lead_teams`** and its `tg_accounts.tg_username` is fresh — then it is an ordinary inbound chat. No code names the seat here; nothing stops it being ticked either. | R |
| a4 | Advert lead (Meta, TikTok/Google webhook, `/ariza` form, bot `?start=ad_<key>`): rota gives it to a seller, who is pushed, CALLS or writes first, presses «📞 Bog'landim». | `crm/inbound.ts landInboundLead` (caps `PHONE_CAP_PER_DAY` 3, `SOURCE_CAP_PER_DAY` 200, join window `INBOUND_JOIN_DAYS` 30) → `crm/routing.ts routeInboundOwner` / `nextInboundOwner` (`users.inbound_rota` AND `canLogInSql`) → `crm/inbound-notify.ts announceArrival`; clock `crm/first-contact.ts claimUntouched`, `contactEvidenceSql`. | System door (no actor). Rota membership: `setRotaMembers` (`admin.settings.manage`). | **No.** The lead has a phone and no chat; the AI cannot write first (fact 3). If the seat is ticked on the rota it collects leads nobody contacts, and the 15-min reminder goes to the seat's own staff chat. | First contact = C + I + ban risk (cold message from a user account) |
| a5 | Colleague's «🧮 Hisoblatish» / «🤖 AI rastamojka» in the staff bot for a stranger or a coded client; quick «+» lead. | `calc/intake-land.ts landIntake` → `landCodedRequest` (coded: NEW deal per request) / lead card; `quickCreateLeadAction` → `createLead`. | Staff actor; `crm.leads` for the lead door. | Not the AI's door (it uses the same `landIntake` from its own chat, row b3). | R |
| a6 | Phone call: the calls APK uploads the log + recording for numbers in the book / open leads. | `calls/service.ts ingestCalls`, `callsForCard`. | Paired device of a user. | **No channel** — the seat has no phone line; not applicable. | — |
| a7 | Client-finding agent's prospect (lead source `agent`). | `/api/agent/*`, `crm/agent-feed.ts`, `landInboundLead(channel:'webhook')`. | Webhook secret. | AI may draft when the prospect writes; sends held to `AGENT_LIMITS.agentLeadWindow` (Mon-Sat 10-17); auto refuses `prospect`. | C |

### b) Qualification and the calculation

| # | What the human does today | Service function(s) | Who may call | Does the AI seller reach it | Risk |
|---|---|---|---|---|---|
| b1 | Asks: what goods, kg, m³, from where, which service (yo'lkira / rastamojka / podklyuch). | `calc/intake.ts missingFields`, `lineNeeds`; `calc/intake-manual.ts parseManualFacts`. | Pure. | **Yes** — tool `calc_checklist` (`agent/tools.ts checklist`), `cargo_volume`; auto kind `qualification`. Figures must be the customer's own (`stated()`), newest wins (`newestMeasure`). | R, C |
| b2 | Opens the customer's invoice / packing list / product photo / voice note. In the staff bot the two calc doors READ files: xlsx/xls/csv, PDF, photos. | `calc/intake-ai.ts analyzeIntake({images, pdfs, sheets…})`, `deals/goods-file.ts readGoodsFile`, `platform/telegram/calc-read.ts` (job `calc.intake-read`). No speech-to-text anywhere in the repo. | Staff bot collector (a staff chat). | **No.** The model sees the words «rasm / fayl / ovozli xabar (eshitilmagan)»; auto refuses `media` (`auto-send.ts` reads `tg_messages.has_media` over the burst). Files are only COPIED onto the VED note (`agent/calc-files.ts copyChatFilesToNote`; `calc_file_missing` when a file was not kept). | — (a missing capability) |
| b3 | Sends the job to the VED: card form / chat 🧮 / staff bot. Coded client → a NEW deal per request; stranger → lead card. | `calc/intake-land.ts landIntake({…, collectedBy, client, lead, machine, onCard, intakeDoor})` → `landCodedRequest` / `landOnReturnedCard` → `calc/service.ts openCalcRequest` (rota `nextVedAssigneeInTx`, bound task, `calc/prefill-queue.ts queueCalcPrefill`). Refusals: `too_many_items`, `too_many_open` (`OPEN_CALC_CAP_PEOPLE` 20; seat `OPEN_CALC_CAP_SEAT_DEFAULT` 100 via `platform/settings/calc-cap.ts openCalcCapFor`), `lead_closed`, `note_taken`, `note_foreign`. | `ctx.actorId` required. No permission inside the service; doors gate on `crm.leads` / deal-write. | **Yes** — action `calc_submit` → `agent/decide.ts landCalc` → `landIntake({collectedBy: actor.id, hasCertificate:true, intakeDoor:null})`, linked in `agent_calc_links`. By itself only when auto kind `calc` is ticked (ships unticked) and `agent/calc-submit.ts calcSubmitFacts` is clean: `calc_identity`, `calc_foreign`, `calc_refused`, `calc_recent` (`CALC_RECENT_MS` 14 d), `calc_file_missing`. `run.ts validateActions` drops it when the checklist is incomplete, below the truck minimum, or the chat already has an open calc. | R-ish (a VED job, a new deal for a coded client), costs VED time + an AI-VED call; not C by itself |
| b4 | Reads the machine's unofficial estimate («⚠️ Rasmiy emas») while waiting. | `calc/prefill.ts aiPrefill`, `calc/estimate.ts estimateCustoms`, `calc/ai-reply.ts`, `calc/freight-answer.ts aiFreight`; for an AI job `agent/calc-loop.ts announceAgentCalc(requestId,'estimate')`. | Job `JOB_CALC_PREFILL`; budget `calc/ai-cost.ts aiCalcStanding`. | Holder HEARS it (`AgentCalcAnswered`). The machine may **not** quote it to the customer («never a source the machine may quote», calc-loop.ts head). | $ (unofficial) |
| b5 | VED prices the job: table, codes, bazas, ✅, «Muhrlash» or «Готово» with a figure + internal note; or «Qaytarish» with a reason. | `calc/workspace.ts saveTable`, `confirmGroup`, `sealCalc`, `recalcFromSealed`; `calc/service.ts finishCalcRequest(id, {amountText, note, internalNote}, ctx, sawRev)`, `returnCalcRequest`. | `ved.docs` (`src/app/(protected)/hisoblash/actions.ts`). | **Never** (law 1/4: no `'ai'` rate/baza source; the floor never enters a prompt). The AI only hears the result: `announceAgentCalc` `done|sealed|returned|recalc` → jobs `agent.calc_answer` / `agent.hand_back`. | $ |
| b6 | VED handed back → seller asks the customer the missing thing → resubmits. | `returnCalcRequest` opens a «↩️ Ma'lumot to'ldiring» task; `closeReturnTasks`. | VED / requester. | **Half** — `calc-loop.ts handleHandBack` drafts the question (kind `hand_back`, never auto: gate `not_reply`); the customer's answer lands ON the returned card (`calc-submit.ts handBackLoopOf`: same section, card open, task open, ≤ 14 d). | R, C |
| b7 | Turns the VED figure into a CLIENT price: adds margin, records the offer, gets text + PDF in the staff bot and forwards it. Below the floor needs a reason and an approver. | `calc/workspace.ts recordOffer(anchor {versionId}|{requestId}, {clientPriceUsd, locale, belowFloorReason, mayApprove, expect, push, machine}, ctx)` — refusals `quote_expired`, `superseded`, `answer_expired`, `answer_missing`, `answer_not_usd`, `discounted_no_upsale`, `below_floor_reason_required`, `price_positive`; `releaseOffer`; PDF `calc/offer-sheet-file.ts` + `/api/calc/offer/[offerId]`. | `mayOffer` = `crm.leads`∨`clients.manage` (`calc/upsale-scope.ts`), own card; below floor: `mayApproveBelowFloor` = `finance.reports`. Actor required. | **Yes, two ways.** (1) His 💵: `calc-loop.ts priceDraftFromText` → `price-reply.ts priceReplyText` (deterministic sentence, nothing written on the card). (2) Tool `calc_price` → `agent/calc-price.ts calcPriceFor` + `calc-markup.ts` (settings `agent_calc_markup_kind/value`; empty = no markup); auto kind `calc_price` (unticked) with `markup_unconfirmed`, `calc_price_moved`, `calc_owner_priced`, `calc_person_offer`, `answer_noted`; after the reply REACHED the customer `after-sent.ts offerStep` → `recordOffer({mayApprove:false, push:false, machine:{draftId}}, {actorId: seat})` + `agent_offers` (never commission). **The PDF cannot be sent** (fact 4). Below the floor / a counter-offer: never. | $, C, I |

### c) Freight price sources

| # | What the human does today | Service function(s) | Who may call | Does the AI seller reach it | Risk |
|---|---|---|---|---|---|
| c1 | Quotes truck freight off the website calculator. | `agent/site-estimate.ts SITE_TARIFF` (110…320 $/m³ by density, 0.55 $/kg from 1000 kg/m³, `validThrough` 2026-12-31) + `agent/estimate.ts truckEstimate` (cross-check with /admin/tarif; `YOLKIRA_GUARDS {maxM3:100, maxKg:20000, minTotalUsd:50}`; refusals `size`, `min_total`, `site_refused`, `tariff_mismatch`, `tariff_refused`); minimum `AGENT_LIMITS.minShipment` 1 m³ or 100 kg; `agent/origin.ts quoteOrigin` (`western` = Kashgar/Urumqi/Horgos not priced; `unknown` = ask). | Pure + pooled read. | **Yes** — tool `yolkira_estimate`. By itself only with auto kind `price` ticked: `agent/auto-money.ts` (`estimate_unnamed`, `destination_unsaid`), `destination.ts` (`foreign_destination`), `tariff-watch.ts` (`tariff_unconfirmed`), re-priced at press and send (`estimate_moved`). | $, C, I |
| c2 | VED / admin maintain the real tariff (zones cn, kashgar, horgos); VED gives discounts off it. | `calc/tariff-read.ts tariffFor`, `calc/pricing.ts freightFor`; screen /admin/tarif. | Edit: `admin.dictionaries.manage`. Sellers cannot. | Read only through `truckEstimate` (China column). The Kashgar and Horgos columns are not offered to the AI. | $ |
| c3 | Avia: rate × kg, address given personally. | `agent_config.avia_usd_per_kg` (17) via `agent/config.ts setAviaRate`; `agent/estimate.ts aviaEstimate`; `AGENT_LIMITS.avia {minKg:1, daysMin:2, daysMax:5}`. | Holder / super_admin sets the rate. | **Price yes** (`avia_estimate`); **address never** — policy block `avia_address`, warning `avia_maybe`, forced owner question («Avia: <tovar>, <kg> kg, <qayerdan> — manzilni bering»). | $, C |
| c4 | Rail price. | none. | — | **No door**: prompt rule 10 + `run.ts withRailRule` → `needs_owner`, `worthy.ts RAIL_OWNER_QUESTION`. | $ |
| c5 | Looks up what similar goods were sold for. | `calc_price_book`, `/hisoblash/narxlar`, `calc/history.ts`. | `finance.reports` all / seller own offers. | No. | — |

### d) Winning: code, deal, stages

| # | What the human does today | Service function(s) | Who may call | Does the AI seller reach it | Risk |
|---|---|---|---|---|---|
| d1 | Opens a client code (GS…): the «+» modal or the win dialog. The minter becomes the client's seller. A shell deal opens with it. | `platform/clients/service.ts createClient(input, ctx)` (`code_format`, `code_exists`; `nextClientCode` under an advisory lock; setting `client_code_next`); door `src/app/(protected)/admin/clients/actions.ts quickCreateClientAction` (`duplicateCode` warning, `salesManagerId: actor.id`, `openDealForNewClient`, `staff/celebrate.ts celebrateNewClient`). | `canMintClient` = `clients.manage`∨`crm.leads`. Actor required (`ClientError('validation')`). | **No.** Prompt rule 12: «GS kodni Bekzod o'zi ochadi» → `needs_owner`, «kod ochib bering». docs §18.5 lists it as the owner's «forever». No action type exists. Technically the seat user passes `canMintClient` if it holds `crm.leads`. | **I** (the code goes on cartons and is never reused), sets KPI ownership, posts in the staff group |
| d2 | Wins the lead: «Yutildi» dialog — mint or attach to an existing code (search, name echoed), deals open per SALE. | `crm/service.ts winLead(id, {stageId, attachCode | clientCode, name, salesManagerId, token}, ctx)` → `createClient` → `calc/win-split.ts` + `rekeyLeadCalcJobsTx` → `crm/chat-lead.ts rekeyLeadChats`. Every other door refuses `convert_required`; `lead_about_client`; `client_inactive`. | `crm.leads`; actor required. | **No.** `moveLeadByMachine` refuses a closed target (`target_closed`). Note: a hidden-number lead has no phone → the minted client has `phones: []` → no cabinet link later (row f4). | I ($ follows: KPI, deals) |
| d3 | Works the deal: title, goods lines, quote, stage, discount; links the prixod. | `deals/service.ts createDeal`, `updateDeal`, `moveDeal`, `saveLines`, `linkReceipt`, `setDealDiscount`; cargo moves the stage by itself: `deals/auto-stage.ts` → `applyCargoTrigger` (received / departed / arrived / ready / handed_partial / handed, forward only). | `deals/door.ts canWriteDeal` (`crm.leads`∨`ved.docs`∨`clients.manage`); terms `DEAL_TERMS_PERMISSIONS`. | Only indirectly: a `calc_submit` for a coded client mints a deal (`landCodedRequest`, owner `calcDealOwnerFor`), and `recordOffer` writes the client price on it. No deal stage move, no `linkReceipt`, no lines. | R / $ |
| d4 | Moves the lead along the funnel; «Yo'qotildi» with a reason from the list. | `crm/service.ts moveLead(id, stageId, reason, ctx)` (`reason_required`, `lost_reason_not_listed`, `convert_required`). | `crm.leads`; actor required. | **Open stages only**: `moveLeadByMachine(leadId, 'calc' | 'ai_contacted' | 'ai_quoted', {holderId})` — settings `crm_calc_stage`, `crm_ai_contacted_stage`, `crm_ai_quoted_stage` (all ship empty → `not_configured`); other answers `target_closed`, `current_closed`, `not_mine`, `not_forward`, `lead_gone`. Lost: never. | R |

### e) What the customer must be told to ship

| # | What the human does today | Service function(s) | Who may call | Does the AI seller reach it | Risk |
|---|---|---|---|---|---|
| e1 | Sends the China warehouse address (often as a saved note with a picture) and the marking rule. | Three homes: (1) `agent_kb_facts` seeded by `agent/seed-kb.ts` — `china_points@4`, `china_address_yiwu@1`, `china_address_guangzhou@1`, `china_address_horgos@1`, `tashkent_warehouse@1`, `tashkent_map@1`, `gs_code@1`, `GS_REMINDER`; (2) staff «zametkalar» `platform/notes/service.ts visibleNotes` / `notesByTitle` + `platform/telegram/note-send.ts` (staff bot 📌, text + files); (3) `warehouses.address` (NULL on every row when last read on 2026-09-05; read by `agent/tools.ts ourChinaPlaces` for the origin zone and printed in the `arrived_uz` push). | kb: holder / page; notes: any login, sharing `canShareNotes`. | **Yes, text** — `kb_search` + the cached head (`agent/kb.ts generalFacts`); the Chinese is quoted verbatim (`withoutQuotedHan`). Not from zametkalar (no reader), and no picture/location can be sent. Never for an avia chat. | C |
| e2 | Tells the customer THEIR code to write on every carton. | needs d1 first. | — | Only for an existing coded client (the chat block names the codes); a new customer → owner. | C, I |
| e3 | Prohibited goods, minimum, transit days, how to pay. | kb `prohibited@1`, `min_shipment@1`, `transit@1`, `payment@1`, `avia@1`, `certificate@1`, `china_warehouse_price@1`. | — | **Yes** (auto kind `faq`). | C |

### f) Expected arrival, the prixod, customer pushes

| # | What the human does today | Service function(s) | Who may call | Does the AI seller reach it | Risk |
|---|---|---|---|---|---|
| f1 | Records «kutilayotgan yuk» so the China warehouse expects it (client or marking, boxes, kg, m³, date). | `arrivals/service.ts createExpectedArrival(input, actor: ScopedActor, ctx)` (`wrong_warehouse`, `who_required`); `closeExpectedOnReceipt`; mismatch → `announceArrivalDiff` to the author. | `crm.leads` or `receipts.create` (`src/app/(protected)/arrivals/actions.ts`); actor required. | **No** (no action type). The seat user would pass the gate. | R, internal |
| f2 | Warehouse receives the cargo. | `receipts/service.ts confirmReceipt` (stamps the seller: `staff/stamp.ts stampFor`), `assignReceiptClient`. | `receipts.create` (warehouse, logist office door). | Not a seller's act. | — |
| f3 | Seller gets ONE «Prixod keldi» in the staff bot with «📎 Fayl qo'shish» and «🔗 Bitim biriktirish»; links the deal, adds papers, makes sure a price exists. | `platform/notifications/receipt-arrival.ts`, `receipts/deal-state.ts receiptDealInTx`, `deals/service.ts priceControlOnReceipt`, `linkReceipt`, `platform/telegram/receipt-files-door.ts`. Recipients: the client's seller; admins only when `sellerReach` is `none` / `no_chat`. | Seller of the client. | **No.** With the seat as seller the message lands in the seat's staff-bot chat and no machine reads it; the admin fallback does NOT fire (the seat can log in and has a chat). | R |
| f4 | Customer hears «received / arrived / handed over» from the company bot — only if their chat is linked to the cabinet. For an unlinked customer the seller forwards the ready-made text from his own `ReadyForPickup` message by hand. | `notices/client-claims.ts claimReceivedNotice` / `claimIssuedNotice`, `notices/arrival.ts claimArrivalNotice` (all require `hasLinkedChat`), sweep `notices/arrival-jobs.ts`. Linking: customer `/start` + contact share → `platform/telegram/client-cabinet.ts linkAllClientsForPhone`; staff link code `beginClientLink` (`no_phone` when the card has no number) minted by `createClientCabinetCodeAction` (`clients.manage`). | System. | Automatic for linked customers (section 3). The AI cannot mint a link code, has no kb fact naming the bot, and cannot push to an unlinked customer (fact 3). | C |
| f5 | Answers «yukim keldimi?». | `client-cabinet/service.ts cargoOverview`, `bot-text.ts cargoMessages`. | — | **Yes** — tool `cargo_status` (auto kind `status`, needs the tool to have answered: `status_unbacked`). Refused when the chat is not proven: «raqami kartada yo'q». | C |
| f6 | Customer presses ❌ «Xato bor» on the received goods; the seller sorts it out. | `receipts/client-confirm.ts`, `forwardClientMessage` (dispute relay). | — | No. | C |

### g) Tracking / ETA

| # | What the human does today | Service function(s) | Who may call | Does the AI seller reach it | Risk |
|---|---|---|---|---|---|
| g1 | Looks at /trucks, /map or the staff bot lookup and tells the customer where the truck is and roughly when. | `tracking/eta.ts placeTruck`, `placeDated`, `etaWindow`, `scheduleEstimate` (no date on a generic route or past a held queue — Horgos/Yallama); `client-cabinet/stages.ts cargoStage`, `MILESTONES`; `client-cabinet/map.ts cabinetMap`. Staff read: `bot/lookup.ts botLookup` (NOT customer-safe: any code, batch codes, plates). | Cabinet reads keyed by the server-resolved client. | **Yes** through `cargo_status` only (the cabinet's own text: stage, kg/m³, ETA window). Never a batch code or a date promise (rules 2, 5). A delay explanation («why is it late») has no source → `needs_owner`. | C |

### h) Money

| # | What the human does today | Service function(s) | Who may call | Does the AI seller reach it | Risk |
|---|---|---|---|---|---|
| h1 | Logist / accountant / VED set the truck price (the bill) per client per truck. A seller cannot. | `finance/service.ts addTransaction({type:'charge', batchId})` → `prepareTruckCharges` / `writeTruckCharges`; `addTruckPrices`; refusals `deal_choice_required`, `deals_changed`, `fx_missing`, `future_date`. | `finance.manage` (`src/app/(protected)/finance/actions.ts`); page `finance/pricing-door.ts mayOpenPricing`. | No, and not a seller's act. | $ |
| h2 | Accountant records the customer's payment into a kassa. | `addTransaction({type:'payment', accountId})`; `placePayment`; refusals `account_required`, `account_currency_mismatch`, `no_till_currency`. | `finance.manage`; naming a till `accounting/till-door.ts mayPickTill` (`finance.expenses`). | **No.** A customer's «to'ladim» + screenshot is a media burst (held) and there is no «payment claimed» queue to the accountant. | $, I-ish (void exists) |
| h3 | Tells the customer the balance. | `finance/service.ts clientBalanceUsd`; `client-cabinet/service.ts debtSummary`. | Seller: own clients (`finance/scope.ts mayOpenClientLedger`). | **Yes** — tool `own_balance`; never by itself (`MONEY_TOOLS` → `money`). | $, C |
| h4 | Debt at handover: the warehouse is blocked; the seller (own clients), accountant or admin approves, or grants a deal «muddat», or records the customer's payment promise. | `issue/service.ts issueBoxes` (`debt_block`, `price_block`, `price_elsewhere`, `debt_price_block`, `debt_override_forbidden`, `debt_note_required`); `issue/approvals.ts requestIssueApproval` / `decideIssueApproval`; `deals/service.ts deferPayment(dealId, input, ctx, granter)` (`not_your_client`); `debt/promises.ts recordPromise(input, ctx, actor)` (`no_debt`, `exceeds_debt`, `bad_date`, horizon 90 d). | `finance/scope.ts mayGrantDebt` = `finance.debt_override` + own ledger; counter: `counterDebtRelease`. | **No.** Prompt rule 2 (G2) forbids any credit promise. If the seat is the client's seller, approval pings also reach the seat's staff chat (admins and the accountant get them too, `approvalRecipients`). | $, I |
| h5 | Discount / compensation / refund. | `setDealDiscount`; `finance/compensation.ts`; refund kind. | Terms gate / `finance.manage` / `finance.expenses`. | Never (G2). | $ |
| h6 | What a seller may SEE: own clients' ledgers, client prices, never the VED floor. | `finance/scope.ts seesAllMoney` (`finance.manage`∨`clients.manage`), `moneyOwnerFilter`; `calc/upsale-scope.ts upsaleScopeFor`. | — | The AI sees less than a seller: this chat's balance, the tool's client price. The floor appears only on the HOLDER's card line (`CardMemory.calcLine`). | — |

### i) After-sale

| # | What the human does today | Service function(s) | Who may call | Does the AI seller reach it | Risk |
|---|---|---|---|---|---|
| i1 | Books the next call / reminder on the lead or client. | `crm/service.ts setFollowUp(kind, id, until, ctx & {viewAll})` (`not_yours`), `followUps`; day screen /bugun. | Owner of the card (or `crm.leads.view_all`). | **Writes the date** — action `set_followup` → `decide.ts runDraftActions` → `setFollowUp` under the approver. Nothing ACTS on the date: no proactive message. | R |
| i2 | Gives a colleague a task («call the customs broker», «check this box»). | `platform/tasks/service.ts createTask(input, ctx, making)` (assignee must `canLogIn`; origins `hand|calc|calc_return|promise|automation`). | Any login; actor required. | No. | R |
| i3 | Writes to customers who went quiet (/crm/dormant), greets on birthdays, reminds about cargo waiting 5/10 days, chases a payment promise. | `crm/service.ts dormantClients(days, ownerId)`; `platform/broadcast/birthdays.ts alertBirthdays`; `issue/waiting-alerts.ts`; `debt/promises.ts sweepPromises` — all tell the SELLER, never the customer. | — | **No** (fact 3). Part 3's «Friday greeting» is not built. | C, I, ban risk |
| i4 | Repeat order from an existing client. | b1-b7 again; a coded client gets a new deal per request. | — | **Yes**, as any inbound. | — |
| i5 | Complaint, damage, dispute. | — | — | Draft only: category `complaint` / `needs_owner`; never by itself. | C |
| i6 | Marks a dead lead lost with the reason. | `moveLead` (row d4). | Person. | No. | R |

### j) The seller's pay — what happens when the seller is the seat

| # | Mechanism | Service function(s) | Effect when the seat is the client's `sales_manager_id` / the lead's owner |
|---|---|---|---|
| j1 | Whose cargo a prixod is. | `staff/stamp.ts stampFor` (in `confirmReceipt` / `assignReceiptClient`), `stampUnattributedCargo`. | `receipts.sales_manager_id` = the seat, for good (a later seller change never restamps). |
| j2 | KPI pay by m³/kg bands (LTL only), closed on the 8th. | `staff/kpi-service.ts` over `staff/cargo.ts stampedCargo`, `kpi_rates`, `payKpi`. | **The seat accrues a KPI payable like a person.** Nothing in `wms/staff/**` reads `agent_seat_user_id` (its only readers: `calc-cap.ts`, `agent/after-sent.ts`, `agent/config.ts`, `agent/web-page.ts`). |
| j3 | Upsale commission (client price − VED floor). | `calc/upsale.ts payableOffersSql({machineOffers})`, `upsale-service.ts payUpsale`. | Offers the machine wrote (`agent_offers`) are never paid. An offer a PERSON records on the seat's card is paid to that person. His 💵 writes no offer at all. |
| j4 | Weekly rating, month champion, celebrations in the staff Telegram group. | `staff/rating.ts standingsFor`, `ratingViewFor`; `staff/celebrate.ts celebrateNewClient(minter)`, `celebrateLeadWon(owner)`, `celebrateFirstCargo(stamp)`. | The seat is ranked and praised like a colleague; no exclusion. |
| j5 | Seller report, /crm/tahlil, seller profit. | `crm/seller-report.ts`, `crm/analytics.ts`, `staff/seller-profit.ts`. | The seat appears as a seller row (this is the measurement §18.4 phase 4 wants) — but there is no AI-specific page (response time, auto vs approved, conversion). |
| j6 | Advert rota, website roster, VED/approval/prixod pings. | `routing.ts nextInboundOwner`, `site-assign.ts roster`, `notifications/service.ts buildRecipients`. | All key on «a user who can log in»; the seat is treated as a person and its staff-bot inbox is read only by whoever holds that Telegram account. |

## 2. What an autonomous seller would need that has NO door today

Grouped by what blocks it. «Policy» = the code refuses on purpose (a decision he can reverse); «missing» = nothing exists.

**Senses (missing)**
1. **Read a photo / PDF / Excel the customer sent.** The reader exists for staff (`calc/intake-ai.ts analyzeIntake`,
   `deals/goods-file.ts readGoodsFile`) but the agent run passes no image or document block, and `media` holds the
   reply. Invoices and product photos are the commonest calc material.
2. **Hear a voice note.** No speech-to-text anywhere in the repo.
3. **Send a file, picture or location**: the offer PDF (`calc/offer-sheet-file.ts`), an address card, the Tashkent
   map pin. `gramjs-adapter.ts send` is text only.

**Initiative (missing + policy)**
4. **Write first.** Advert/website-form leads with only a phone (a4), a follow-up that acts on its date (i1), dormant
   customers, payment reminders, «yukingiz keldi» to an unlinked customer, a late-truck warning. Needs a new draft
   kind (CHECK today `reply|price|hand_back`), a phone→peer resolve, and a ban-risk answer (company bot vs the
   personal session; `docs/TELEGRAM-CRM.md` «Ommaviy tarqatma — yo'q»).
5. **Read its own staff inbox.** «Prixod keldi», `UnquotedCargo`, `DealDeviation`, approval requests, VED «Готово»
   for non-agent jobs, task assignments all go to the seat's staff-bot chat as to a person; only `AgentCalcAnswered`
   is wired back into a run.

**Closing the sale (policy; doors exist for a user actor)**
6. **Open the GS code** — `createClient` / `quickCreateClientAction`. Prompt rule 12 + §18.5 say «owner forever».
   Without it the AI can never finish a sale with a NEW customer: it cannot tell them what to write on the cartons.
7. **Win the lead** — `winLead`; `moveLeadByMachine` refuses closed stages. **Lose a lead** — needs a listed reason.
8. **Promise the cargo to the warehouse** — `createExpectedArrival` (no action type).
9. **Link the prixod to its deal / make sure a price exists** — `linkReceipt`, the «Prixod keldi» buttons.
10. **Hand the customer the cabinet** — no kb fact names the company bot; link codes need `clients.manage`; a
    hidden-number lead won by attach/mint has no phone on the card (`no_phone`), so it never gets the automatic pushes.

**Money (policy)**
11. **Quote anything but: the China-column truck table, avia rate × kg, the VED answer + his markup.** No Kashgar /
    Horgos column, no rail, no door delivery or other city (`foreign_destination`), no AI-VED estimate, no price for
    cargo under 1 m³ / 100 kg.
12. **Negotiate**: discount, below-floor (`mayApprove:false`), credit, deferral, payment promise, refund — all G2.
13. **Take a payment claim** («to'ladim» + cheque) to the accountant — no queue exists for customer payments.

**Who it asks (missing)**
14. **Route an unknown question to the right colleague.** Today only the HOLDER answers («✍️ Savolga javob»,
    `decideDraft` refuses `not_account_holder`), the VED only through the calc queue and its hand-back. No door to
    ask the logist (truck delay), the accountant (payment), the warehouse (pickup time) and take THEIR answer back —
    his «sotuvchi javob bersa ushani olsin» is built for one person. `createTask` / `addActivity` + mentions exist as
    plumbing; nothing connects a staff reply to a waiting customer chat.
15. **Colleagues' customers on its number.** `machineMayTouch` stops every act on a card owned by another seller;
    the AI still drafts the reply. No hand-over door («this is Aziz's client → tell Aziz»).

**Being a seat (missing)**
16. **Pay and rating rules for the seat** (j2, j4): excluded from KPI pay and the group rating, or deliberately in?
    Nothing decides; today it is in.
17. **Its own scoreboard**: `agent/stats.ts agentStats` and `calibration.ts` measure presses, not sales (leads owned,
    replied within N minutes, calc sent, quoted, won, m³ brought).
18. **More than one account / an official channel.** One `agent_config` row, one holder; WhatsApp/Instagram/Business
    bot are §18.4 phase 5 and unbuilt.

## 3. Customer-facing messages the system ALREADY sends by itself (company bot)

All through the company Bot API bot (`platform/telegram/send.ts`), in the chat's language
(`chatLocaleFor`; uz / ru / en labels in `platform/telegram/client-labels.ts`), **only to a customer whose chat is
linked** (`client_telegram_links.status='linked'`; `notices/client-claims.ts hasLinkedChat`). An AI seller must not
repeat these, and must know that an UNLINKED customer gets none of them.

**Pushes — `client_notices`, one sweep `notices/arrival-jobs.ts sendDueArrivalNotices` (`PREPARERS`), 5 attempts**

| Kind | Says | Claimed by | Timing / extras |
|---|---|---|---|
| `received_cn` | «📥 Yukingiz omborimizga qabul qilindi» — receipt no., each lot: goods, boxes, kg, m³, total; first lot's photo; «Open» Mini App button | `confirmReceipt`, `assignReceiptClient` (`claimReceivedNotice`) | after `RECEIVED_WINDOW_MINUTES` 10; carries **«✅ To'g'ri / ❌ Xato bor»** (`yt:` buttons) when `clientAskOffer` allows (setting `client_confirm_on_receipt`, default on; covers goods, kg and m³) |
| `lot_ask` | «📋 Yuk ma'lumotini tasdiqlang» — the same question, sent by a person's press «📨 Mijozdan so'rash» | prixod card | at once |
| `lot_reask` | the same question again «ma'lumot yangilandi» | the system, after a re-weigh / count change (`receipts/client-reask.ts`, setting `client_reask_on_reweigh`) | 10 min after the last correction |
| `picked_up` | «zavoddan olindi, omborga yo'lda» | factory trip «Olindi» (`pickups/notice.ts`) | no date, no truck |
| `arrived_uz` | «🇺🇿 Yukingiz yetib keldi» — one per customer per TRUCK: lots, kg/m³ shares, warehouse name + address, cleared / ready-for-pickup line, photo «taken on receipt» | first landed carton (`notices/arrival.ts claimArrivalNotice`) | `ARRIVAL_WINDOW_MINUTES` 20 or «Tushirish tugadi»; never names the truck |
| `issued` | «🤝 Yukingiz berildi» — what was handed, to whom, what is left in stock | the handover (`claimIssuedNotice`) | at once |

**On demand — `platform/telegram/client-cabinet.ts`**
- `/start`: greeting, «Kim sifatida kirasiz?»; contact share → codes linked by phone (`welcome`, `yourCodes`,
  `codeAdded`, `phoneNotFound`, `linkExpired`); `/start <code>` staff-minted link; `?start=ad_<key>` → `adThanks`
  and a lead (`platform/telegram/ad-intake.ts`).
- «📦 Yuklarim»: every lot with its stage (five milestones Xitoy · Tranzit · O'zbekiston · Tayyor · Topshirildi),
  kg/m³, ETA window (`etaTo`), photo buttons (`ph:`). «💰 Balans»: debt/credit per code + recent entries.
  «🗄 Tarix»: handovers of 90 days + payments. «💬 Menejer» / `mg`: the manager's name, phone, «✍️ Telegramda
  yozish» link, or the office. «🌐 Til».
- A customer's own text/photo/file to the bot → forwarded to the manager or office (`forwardClientMessage`,
  staff event `ClientBotMessage`); the customer is told «yetkazildi» (`msgDeliveredManager` / `msgDeliveredOffice`,
  throttled `msgThrottled`).
- ✅/❌ answers: `confirmThanks` / `confirmTellUs` («nima xato — shu yerga yozing») / `confirmStale` / `confirmAlready`.
- Mini App `/cabinet` (`client-cabinet/miniapp.ts`): cargo, balance, history, map of the customer's own cargo.

**Other automatic customer-facing surfaces**
- Public form `/ariza`: one constant «qabul qilindi» for every outcome.
- Admin broadcast `/admin/xabarlar` (`platform/broadcast/service.ts`, super_admin ROLE, manual): one message per chat.

**What the system does NOT tell customers by itself** (today a seller's hand, or nobody): the price / offer (seller
forwards text + PDF), payment due or overdue, a broken payment promise, cargo waiting 5/10 days uncollected,
truck departed / at the border / delayed, customs cleared as its own message, birthday greeting, «we have not heard
from you», the China address and the marking code, and everything to a customer who never linked the bot.
