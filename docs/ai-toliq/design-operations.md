# AI sotuvchi — «alohida hodim»: the target product, designed from OPERATIONS, LEARNING and the OWNER'S CONTROL

Design only, no code. Written 2026-11-19 from the three maps (`map-as-built.md`, `map-sale-doors.md`,
`map-senses.md`), `docs/AI-SOTUVCHI.md` §1-14 and §18.4-18.6, and the code they cite. Paths are relative to
`src/modules/` unless they start with `scripts/` or `tests/`. «Today:» always means the code as
it stands. Money figures in the scenarios are examples, marked as such.

**The angle of this document.** The other designs start from the product and from the guard. This one starts from
the question the owner will live with every day: *how do I run this thing like I run a seller?* A seller has a job
description, a supervisor, a morning plan, an evening report, numbers he is judged by, somebody he asks when he does
not know, a way to be corrected, a probation period, and pay rules. Today's AI has none of these — it has a ✅ button.

## 0. Why it feels like a greeting bot — and the one idea that replaces it

- Today the AI is a **draft writer**: one customer message → one draft → a card to the account holder → his ✅.
  «O'zi yuborish» is a machine finger on that same ✅, and 47 separate reasons stop the finger
  (`agent/auto-gate.ts` `AUTO_REFUSALS`). On 2026-11-15 the two that stopped all nine replies were `low_confidence`
  (the model is told «Oshirib yuborma: shubha bo'lsa past qo'y» and then must reach 0.80) and `money` / `category`.
- Three structural walls make a real sale impossible even with every box ticked: the third reply in a row always waits
  for a person (`AUTO_STREAK_MAX = 2`), a burst with a photo, file or voice note never goes (`media`), and nothing can
  happen without a fresh customer message (no timer, no event — `agent_runs.trigger` is `inbound | owner_edit |
  calc_answer | hand_back | style`).
- It has no goal, no memory of the customer beyond the last 100 messages, nobody to ask but one person, and nothing
  that connects a conversation to a sale: «nothing links an AI conversation to a won deal, money received or a lost
  lead» (map §6). So it can only be judged by presses, and it can only earn presses.

**The idea that replaces «everything waits for ✅»:** the unit of control stops being *the message* and becomes
*the action*. The owner does not approve sentences; he grants **rights** («o'zi narx aytsin», «o'zi kod ochsin»,
«chegirma — so'rab»), sees **exceptions** only, reads a **report**, and corrects through **teaching**. Everything
below is that operating model.

---

## 1. THE FINISHED PRODUCT in one page

«AI sotuvchi» is one seat in the company: its own Telegram number, its own name in the CRM (lead owner, client's
seller), its own numbers on the board. It sells alone inside limits the owner set, asks the right colleague when it
does not know, and reports like an employee.

| Stage of the sale | The AI does ALONE | It ASKS (whom) | Stays HUMAN for ever |
|---|---|---|---|
| **1. First contact** | Answers within a minute, day or night, in the customer's language (uz, ўз, ru, en, fa, zh). Opens the lead, names the source. Says honestly it is GSR's AI assistant when asked «botmisiz?». | — | Cold first messages to strangers from the personal number (ban law, not a preference). |
| **2. Qualification** | Reads what the customer SENT: product photos, invoice / packing list (PDF, Excel, photo of a paper), voice notes (speech-to-text, then repeats back «to'g'ri tushundimmi: 3 kub, 400 kg, kiyim?»). Collects goods, kub, kg, pieces, origin city, destination, which service (yo'lkira / rastamojka / podklyuch / avia). Keeps a short «mijoz pasporti» so it never asks twice. | Unreadable paper or a voice note it is not sure of → asks the CUSTOMER once; a strange product («buni olib kelsa bo'ladimi?») → the VED on duty. | — |
| **3. Price** | **Yo'lkira** from the company tariff (every origin column the owner filled, the destination he priced), **avia** = kg × the owner's rate, with the two dictated sentences («taxminan», «boj va QQS alohida»). **Rastamojka / podklyuch**: sends a complete job to the VED queue by itself with the customer's files, tells the customer when the answer is due, and when the VED presses «Готово» / «Muhrlash» tells the **official** price = VED figure + the owner's markup. Optionally (owner's dial) a **customs estimate** first, always labelled «taxminiy, rasmiy emas». Records the offer on the card. | Anything the tariff does not cover (rail until a rate is entered, a region with no price, cargo > 100 m³) → owner / VED. | The tariff itself, the markup, the floor, and the official customs calculation (the VED's seal). The AI never sees the floor. |
| **4. Objections, negotiation** | Answers «qimmat», «boshqalar arzon», «o'ylab ko'raman» from playbooks the owner approved. Gives a discount **only inside the ladder he set** (for example: repeat customer, ≥ 5 kub → up to 3 % of the freight) and writes the promise on the card where the person who bills will see it. | Anything above the ladder → the owner, as a one-tap card with the customer's history (shipments, kub this year, how he pays, current debt). | Below-floor prices, credit / «keyin to'layman», refunds, compensation. |
| **5. Closing** | Opens the **mijoz kodi** (GS…), sends the right China warehouse address in Chinese + the marking rule («har bir karobkaga GS1482») as text and as a picture card, records the **kutilayotgan yuk** for that warehouse (cartons, kg, kub, date), wins the lead, opens the deal, invites the customer to the company bot so the automatic «qabul qilindi / yetib keldi» messages reach him. | Large or unusual customers (FTL, ≥ a threshold) → hands to a human seller the owner named. | — |
| **6. The cargo's journey** | Answers «yukim qayerda?» from the system (stage, kg / kub, arrival window). Says what the company bot does NOT say: price reminder, truck departed / at the border / delayed and why (from the logist's note), customs cleared. **One voice per event:** before speaking it checks whether the bot already told this customer (`client_notices`), and never repeats «qabul qilindi», «yetib keldi», «berildi». | «Nega kechikyapti?» with no logist note → the logist; «karobka kam chiqdi» → the warehouse manager. | Resolving a loss or damage claim. |
| **7. Payment and debt** | Tells the customer his own balance when asked (identity proven by phone). Reminds about a due payment with the owner's template, at most twice. Takes «to'ladim» + the cheque photo and puts it in the accountant's queue; confirms to the customer only after the accountant recorded it. | «Pul tushdimi?» → the accountant. A payment promise («juma kuni beraman») → records it and tells the owner / seller. | Recording money in a kassa, releasing cargo with a debt (`issue/approvals.ts`), any deferral. |
| **8. Handover** | Tells where and when to collect (Tashkent warehouse, hours, map), reminds once about cargo waiting 5 / 10 days. | Pick-up outside hours → the warehouse manager. | The handover act and the debt gate at the counter. |
| **9. Repeat business, quiet customers** | After a handover asks about the next shipment. Follows up a quote that got no answer (day 2 and day 6, then stops). On the owner's weekly list writes to customers who went quiet — through the company bot where the customer is linked, from its own number only to people who wrote to it before. | The weekly re-activation list itself is the owner's ✅ (who, how many, which words). | Mass messages from the personal number. |

What makes this a product and not a bigger bot: **every row has a dial, a number and a person behind it** (§3, §4).

---

## 2. A DAY IN THE LIFE

### 2.1 The owner's day (figures are examples)

- **08:30 — the morning report** (staff bot, one message): «Kecha: 41 suhbat, 38 tasini o'zi yopdi. 9 ta narx
  aytildi, 3 ta hisoblatish VEDga ketdi, 2 ta yangi kod (GS1482, GS1483) — 5,4 kub kutilmoqda. Sizni kutayotgan:
  2 ta ruxsat, 1 ta savol (eng eskisi 14 soat). Bugungi reja: 6 ta eslatma (narxga javob bermaganlar), 2 ta to'lov
  eslatmasi, 1 ta kechikkan mashina xabari. [✅ Boshlayversin] [📋 Ro'yxat] [⏸ Bugun o'zi yozmasin]».
- **During the day — exceptions only.** Not 150 cards: 3-6. Each is one of five kinds and is answered in one tap or
  one sentence: **Savol** (it does not know), **Ruxsat** (above its rights: «GS777 keyingi yukka 5 % so'rayapti —
  ladder 3 %»), **Shikoyat** (handed over, AI silent), **Tekshiruv** (a reply from a right that is on probation),
  **Signal** (Telegram warning, «botmisiz?», a block, the budget). If he does not answer in 15 minutes the card goes
  to his deputy and the customer gets one honest line («aniqlab, yozaman»).
- **Whenever he wants — the journal.** Every conversation the AI handled, readable like a chat, each reply with 👎
  and «📝 Tuzatish». He is not asked to read it; he can.
- **20:00 — the evening line** inside the summary he already gets (`reports/owner-summary.ts`): what the AI sold
  today, what it cost in dollars, what is still waiting on people.
- **Saturday — ten minutes.** «Haftalik tekshiruv»: 15 random conversations, ✅ / ❌ each. The system then says:
  «Narx javoblari: 60 tadan 60 tasi to'g'ri — "Sinovda"dan "O'zi"ga o'tkazaymi?» and «Chegirma: 2 ta xato — "So'rab"ga
  qaytarildi». One tap each.

### 2.2 Scenario A — a new customer, 3 kub of clothes, photos and a voice note (figures are examples)

1. **09:12** Dilshod presses «Telegram» on the website and writes to the AI's number: «Assalomu alaykum» + 4 photos of
   jackets in cartons + a 22-second voice note.
2. **09:13** The AI has looked at the photos (winter jackets, export cartons, a size print on one) and heard the
   voice note. It answers in Uzbek and repeats what it heard, because speech-to-text can be wrong: «Va alaykum
   assalom! To'g'ri tushundimmi: Guanchjoudan, taxminan 3 kub, 400 kg atrofida kurtkalar, rastamojkasi bilan
   kerak?» and asks ONE thing: «Invoys yoki packing list bo'lsa yuboring — aniq hisoblab beraman.»
3. **09:20** Dilshod sends an Excel packing list. The AI reads the rows with no guessing (1 200 dona, 24 karobka,
   412 kg, 2,9 kub) and writes them into the lead's passport.
4. **09:21** Two things at once. To the customer: the truck freight from the tariff («Guanchjou → Toshkent,
   2,9 kub / 412 kg: taxminan $390, 15-25 kun; boj va QQS alohida») and «rastamojka bilan aniq narxni 1 soat ichida
   aytaman». To the VED queue: a complete podklyuch job with the Excel and the photos attached. (If the owner turned
   the «taxminiy boj» dial on and the VED has sealed jackets before: «taxminan $700-800 boj, rasmiy emas».)
5. **10:05** Murod (VED) presses «Готово: $1 150». The AI adds the owner's markup (8 % → $1 242), re-checks the
   figure at the moment of sending, tells the customer, records the offer on the card. Nobody pressed anything.
6. **10:09** «Qimmat-ku, 1100 qiling.» The ladder says: first shipment, under 5 kub → no discount by itself. The AI
   answers from the «qimmat» playbook (what is inside the price, the delivery window) and sends the owner a
   **Ruxsat** card: «Dilshod (yangi, 2,9 kub kiyim) $1 242 → $1 100 so'rayapti. [✅ $1 200] [✏️ boshqa] [❌ yo'q]».
   The owner taps ✅ $1 200 from his car. The AI: «Sizga $1 200 qilib beramiz, shu hafta omborga topshirsangiz.»
7. **10:15** «Mayli.» The AI opens **GS1482**, sends the Guangzhou warehouse address in Chinese with the phone, the
   marking rule and the picture card, asks when the supplier will deliver, records «kutilayotgan yuk: 24 karobka,
   412 kg, 2,9 kub, 24-noyabr» for the Guangzhou warehouse, wins the lead, opens the deal with the price on it, and
   sends the link to the company bot «yukingiz qabul qilinganda shu yerda xabar keladi».
8. **24-noyabr** The warehouse receives 24 cartons. The company bot tells Dilshod (he linked it); the AI says nothing.
   The seat's own «Prixod keldi» event is read by the machine: it links the prixod to the deal and checks the price
   stands. The 20:00 summary carries one line: «🤖 Yangi mijoz GS1482 — 2,9 kub, $1 200, qabul qilindi.»

What the owner did all day for this sale: one tap.

### 2.3 Scenario B — a returning customer: «yukim qayerda?» and a discount

1. **14:02** Sardor (GS777, phone on his card — identity proven) writes: «Yukim qayerda?»
2. **14:02** The AI reads the system: one lot ready in Tashkent for 4 days, one on truck at the border. «Ikkita
   yukingiz bor: 1) 12 karobka Toshkent omborida tayyor, olib ketishingiz mumkin; 2) 30 karobka chegarada,
   26-29 noyabr oralig'ida kutilmoqda. Hisobingizda $340 qarz bor.» (No truck code, no promise of a day.)
3. **14:04** «Nega kechikyapti?» The logist typed a note that morning in the staff bot («📣 AI ga: KA-118
   Irkeshtamda navbat, +2 kun») — the AI uses it: «Chegarada navbat bor, 2 kunga surilgan.» Had there been no note,
   the AI would ask the logist (a card in HIS staff bot, he swipe-replies «navbat, 2 kun»), tell Sardor «aniqlab
   yozaman», and relay the answer in his own words within minutes.
4. **14:06** «Doimiy mijozman, keyingi yukka chegirma qilasizmi?» The AI reads Sardor's record: 12 shipments, 38 kub
   this year, pays within 3 days on average. The ladder allows 3 % of the freight for a repeat customer on ≥ 5 kub.
   «Keyingi yukingiz 5 kubdan ko'p bo'lsa, yo'lkiradan 3 % chegirma qilamiz.» The promise is written on the client
   card («AI va'dasi: keyingi yuk ≥ 5 kub → −3 % yo'lkira, 31-dekabrgacha») so the logist who sets the truck price
   sees it. Sardor asked for 5 %: that would have been a **Ruxsat** card with the same record on it.
5. **14:07** «Yangi yuk nima bo'ladi?» — and a new qualification starts on a new deal.
6. **Day +4** the debt is still $340 and the Tashkent cargo is still uncollected: the day's plan in the morning
   report lists one reminder to Sardor; it goes at 10:00 with the owner's template, once.

---

## 3. THE AUTONOMY MODEL — rights per ACTION, not approval per word

### 3.1 Four tiers of action

| Tier | What it is | Examples | Default |
|---|---|---|---|
| **T0 — Gapirish** | Words that carry no commitment: greet, ask, explain from «Bilimlar», tell the customer his own cargo status. | greeting, qualifying question, prohibited goods, transit days, «yukingiz chegarada» | Always alone. Only the guard's factual checks apply (a number must have a source; no other client's data). |
| **T1 — Ichki ish** | Reversible acts inside the system the customer does not see. | open / update a lead, write the passport, set a reminder, send a job to the VED, record «kutilayotgan yuk», ask a colleague, move an open stage | Alone, logged, undoable by a person. |
| **T2 — Pul va va'da** | Customer-visible commitments computed by CODE from the owner's own rules. | truck / avia quote, VED price + markup, customs estimate, China address + marking, opening a GS code, a ladder discount, a payment reminder, a follow-up message | Per-action dial (§3.2). Alone only when its deterministic check passes at the moment of sending (price re-computed, identity proven, the customer wrote recently). |
| **T3 — Faqat odam** | Judgement about money or blame. | below the floor, credit, refund, compensation, a complaint, releasing cargo with a debt, a cold first message | Never. The AI hands over and goes quiet. |

### 3.2 The dials — one page, «AI hodim → Huquqlar»

Each T2 action has one switch with four positions. The owner turns them; nothing else decides.

| Position | Meaning |
|---|---|
| **O'zi** | The AI does it and it appears in the journal. |
| **Sinovda** | The AI does it by itself, AND every such act is put in front of the owner's Saturday check until the number (§3.3) is met. The safe way to open a new right without sitting on a ✅. |
| **So'rab** | The AI prepares it and sends a one-tap **Ruxsat** card; the customer gets a holding line. |
| **Yo'q** | The AI never does it; the conversation goes to a person. |

| # | Action | ⭐ position on day 1 | What the code checks every time (not the model) |
|---|---|---|---|
| D1 | Truck freight from the tariff | O'zi | re-priced at send (`agent/estimate-check.ts` exists), origin and destination priced, minimum 1 kub / 100 kg |
| D2 | Avia price | O'zi | kg × `agent_config.avia_usd_per_kg`; the avia receiving address only once the owner typed it into settings |
| D3 | Send a calculation to the VED | O'zi | checklist complete, files stored, no open job for the same cargo |
| D4 | VED price + markup to the customer | O'zi | `agent/calc-price.ts` (exists): standing, not expired, not discounted, markup confirmed |
| D5 | Customs ESTIMATE before the VED answers | Yo'q (owner's question 23) | only codes the VED has sealed before; printed as a range; never called a price |
| D6 | Tell the customer his own debt | O'zi | identity proven by phone (`chatProof`, exists) |
| D7 | China address + marking rule | O'zi | the address is a stored fact, quoted verbatim |
| D8 | Open a GS code | Sinovda | the customer accepted a price, name + phone present, duplicate-phone check (`quickCreateClientAction` already warns) |
| D9 | Record «kutilayotgan yuk», win the lead, open the deal | O'zi | follows D8 |
| D10 | Discount inside the ladder | So'rab → Sinovda after a month | the ladder's own arithmetic; the promise written on the card |
| D11 | Follow-up to a customer who did not answer a quote | Sinovda | the customer wrote to this number within N days; ≤ 2 per quote; daily cap |
| D12 | Payment reminder | So'rab (a daily list) | debt read from the ledger at send; ≤ 2 per debt |
| D13 | Message to quiet customers | So'rab (a weekly list) | company bot where linked; own number only for people who wrote before |
| D14 | Mark a lead lost («javob bermadi») | O'zi after 2 unanswered follow-ups | a listed reason only |

Other settings on the same page: working hours for initiative (never at night), the per-day ceiling of proactive
messages, the daily budget in dollars, the escalation timer, the supervisor and deputy, which customers the AI serves
(§4.6), the markup, the discount ladder, the kill switch.

### 3.3 How trust is earned and measured — three numbers, shown beside every dial

The existing «80 %» measures how often his ✅ left a draft unchanged (`agent/stats.ts` `agentStats`,
`agent/calibration.ts`). That number dies with the ✅. The finished product measures three things:

1. **«To'g'ri ulushi» per action — the quality number.** Of the acts of this kind that a person CHECKED (the Saturday
   sample, every «Sinovda» act, every 👎 in the journal), the share judged right, as the cautious figure the code
   already computes (one-sided 95 % Wilson lower bound, `calibration.ts`). The bar:
   - talk (T0): lower bound ≥ 0.90 — that is 49 right of 50, or 95 of 100;
   - money (T2): lower bound ≥ 0.95 — that is 60 of 60, or 99 of 100.
   The price itself is not sampled — code computes and re-computes it; what a person judges is whether it was the
   right thing to say to this customer.
2. **Harm signals per 100 conversations — the alarm number.** Blocks, «botmisiz?», «menejer kerak», complaint words,
   a VED hand-back of a job the AI submitted, a prixod that differs from what the AI collected by more than the
   existing deviation threshold. Today these exist as the step-down rule `AUTO_STEP_DOWN` (2 × 👎 in 7 days, a block,
   two «botmisiz» chats → the WHOLE layer disarms); the target counts them per action and per 100 conversations.
3. **The seller's numbers — the business number** (§4.3): answer time, lead → code, kub, money, against the median
   human seller.

**What the numbers do.** He refused a proof gate once («50 talik test bo'lmasin») and that stays his right: a dial
moves the moment he turns it. The numbers do two things only: the system **proposes** a promotion when a bar is met
(«Sinovda» → «O'zi»), and it **demotes by itself** — two confirmed mistakes in 7 days on a money action put that ONE
action back to «So'rab» with an alarm, without switching the whole AI off.

### 3.4 What makes the AI hand a conversation to a person

Deterministic triggers (code, not the model's mood): the customer asks for a person; a complaint, anger, a threat or a
legal word (the prompt's rule 13 today); a T3 topic; the same question failed twice; a language it may not write
(Pashto today → owner's choice); a card owned by a colleague (`agent/machine-owner.ts` `machineMayTouch`); cargo above
the «katta mijoz» threshold; an exception nobody answered within the long timer; any Telegram danger sign
(`agent/forced-off.ts`); the day's budget spent.

### 3.5 How a person takes over and gives back

- **Take:** «🙋 Olaman» on the conversation (card, journal or CRM thread). The AI goes silent in that chat at once and
  the person receives the passport: who, what cargo, what was quoted, what was promised, what the customer last asked.
- **Where the person writes:** in the SAME chat — from the CRM thread, as the AI's number (today a reply can leave
  only from one's own connected account, `crm/telegram-send.ts`; the target adds «may write from the AI number» as a
  right the owner grants by name). The customer never has to move to another chat.
- **Give back:** «🤖 AI davom ettirsin», with an optional note the AI must obey («5 % va'da qildim, narx $1 180»).
  If the person writes nothing for N hours (setting; today the pause is 120 minutes after a person's message and 24 h
  after 🙋), the AI asks him once «davom ettiraymi?» instead of silently resuming.
- **Seller's own customers:** a colleague's client who writes to the AI number gets status and general answers; any
  price or promise goes to that seller as a card, and the answer comes back through the AI.

---

## 4. THE STRUCTURE — building blocks

### 4.1 The blocks, and what each is today

| Block | Exists today | Change | New |
|---|---|---|---|
| **Senses — in** | Text; the bytes of every photo ≤ 10 MiB, voice / file ≤ 20 MiB are already stored (`scripts/tg-listen.ts` `saveMediaFor`). Three staff-side readers of photos / PDF / Excel (`calc/intake-ai.ts`, `receipts/tarkib-read-ai.ts`, `deals/goods-file.ts`). | The model seam carries no image or document (`platform/ai/model.ts` `ModelBlock`); the context reads only a file's type and name; `media_only` = silence, gate `media`. | A «read the customer's files» step, read once per file and remembered. Speech-to-text (external service). The seat's own staff inbox as events («Prixod keldi», VED answer, approval pings) — today these land in a chat no machine reads. |
| **Senses — out** | One text message ≤ 700 chars (`agent/gramjs-adapter.ts`). | Several messages in a turn; today the AI's own second message cancels its first (`human_replied`). | Sending a picture card, a PDF offer, a location; the company bot as a second voice for linked customers. |
| **Brain and tools** | Loop of ≤ 6 rounds, 9 tools (`agent/tools.ts` `TOOL_SPECS`), 3 actions (`calc_submit`, `set_followup`, `mute`). | The prompt's first sentence («qoralama … Bekzod o'qiydi») becomes a seller's job description with a goal; `next_step` (written, read by nobody) becomes the plan; limits 12 runs / 12 sends per chat per day become settings. | Tools: read files, read the customer's card and history, the truck board + logist notes, ask a colleague, open a code, record expected cargo, ladder check, payment claim, customs estimate. |
| **Customer memory** | The last 100 messages of this chat; the chat's language; facts the owner pinned «faqat shu mijoz». | — | **Mijoz pasporti**: goods, sizes, service, quotes given, promises made, next step and its date, who was asked — written by the AI, readable and editable by people on the card. A promises ledger the billing people see. |
| **The guard** | Number sourcing (G1), leak fences, promise categories (G2), price re-computed at every press and send, identity proof, 1 483-case reader corpus. | The self-reported confidence gate, the streak, «more than one ?», the late note stop being machine stops; warnings split into «for his eye» and «stop». Decisions move from 47 reasons on a sentence to one permit per action (§3.2). | The ladder and the price settings as sources the guard trusts. |
| **Sender and account protection** | Read → typing → send choreography, hour / day caps, night, flood and restriction alarms, forced-off (`agent/limits.ts`, `agent/forced-off.ts`, `crm/account-guard.ts`). | Caps sized for conversations instead of single replies. | Initiative with its own fuses; a second, official channel so the number is not the only door. |
| **Supervisor inbox** | Cards to the account holder only (`AgentDraft`, `AgentNotice`, `AgentCalcAnswered`); a 30-minute reminder (`agent/jobs.ts` `OWNER_QUESTION_WAIT_MS`). | A card per reply → a card per **exception**; «the holder» → the **supervisor and deputy** the owner names. | Five typed exceptions, routing by topic to the right colleague, timers, escalation, the journal (§4.2, §4.7). |
| **Reports and KPIs** | Press statistics (`agentStats`), the auto panel (last 20 sent), the dollar line on the 20:00 summary (`reports/ai-spend.ts`), the seat as an ordinary seller row in `/crm/tahlil` and the seller report. | — | The conversation → sale link, the AI's KPI page, the morning report, the evening line, the weekly review (§4.3). |
| **Test corpus / replay** | Reader corpus (898 dangerous held / 0 let through), policy corpora (62 ordinary, 303 dangerous), `scripts/agent-calibration.ts`, `scripts/agent-census.ts`; the run accepts a stand-in model (`run.ts` `deps.callModel`). | — | Replay of real past conversations, the owner's exam set, shadow comparison, a test chat, versions with one-tap rollback (§4.5). |
| **Initiative (triggers)** | Reaction only. `set_followup` writes a date for a HUMAN's call list. | — | Timers (quote unanswered, date reached, debt due) and events (prixod, truck delay, VED answer, handover) start a run. |
| **Seat and pay** | `agent_seat_user_id` (`platform/settings/agent-seat.ts`), `machineMayTouch`, machine offers never earn commission (`calc/upsale.ts` `payableOffersSql({machineOffers})`). | The seat is ranked, praised and accrues KPI like a person — nothing in `wms/staff/**` reads the seat. | Pay and ownership rules (§4.8). |

### 4.2 The control room — how the owner runs it

**(a) The morning report, 08:30** — yesterday in numbers (§4.3), what waits on people and how long, and **today's
plan**: the proactive messages the AI intends to send, grouped (follow-ups, payment reminders, delay notices,
quiet-customer greetings) with one switch for the day. The plan is the only place initiative needs a human.
*Exists:* the 08:00 task digest and the 20:00 summary job. *New:* the AI section and the plan.

**(b) The exception inbox** — one queue, five kinds, each with an owner, a clock and a fallback:

| Kind | Goes to | Answered by | If nobody answers |
|---|---|---|---|
| **Savol** — the AI does not know | the colleague whose topic it is (§4.7) | a swipe-reply in the staff bot, in plain words | 15 min → the next person; the customer has a holding line |
| **Ruxsat** — above its rights | the supervisor | one tap (✅ / ✏️ another figure / ❌) | 15 min → deputy; 2 h → «menejer bog'lanadi», conversation handed over |
| **Shikoyat** — handed over | supervisor + the client's seller | 🙋, then a person writes | reminder every 30 min in working hours; never auto-closed |
| **Tekshiruv** — an act of a right «Sinovda» | supervisor, silently (no sound) | ✅ / ❌ whenever he likes | nothing waits on it — the act already happened |
| **Signal** — Telegram warning, block, «botmisiz?», budget, AI silent | supervisor + every super_admin, through the BOT | «Tekshirdim» | stays red on the page |

Every answered Savol ends with «📌 Umumiy qoida / 👤 Faqat shu mijoz / ⏱ Bir martalik» so the same question is not
asked twice (today this exists for the owner's own answers only).

**(c) The journal** — every conversation the AI touched: the chat, what it did (tools, acts), which right allowed
it, what it cost. Each reply has 👎 (counts in §3.3, and switches nothing off by itself unless the bar is crossed) and
«📝 Tuzatish» (a lesson). Filter: «pul aytilgan», «chegirma», «odamga o'tgan», «👎».

**(d) Liveness.** On his server the AI once wrote nothing for over two weeks (29 October → 14 November) under the
word «ishlayapti» — the owner account was signed out (DECISIONS #1789). The control room therefore carries one health
line computed from facts, not from a status flag: «oxirgi mijoz xabari 3 daqiqa oldin, oxirgi javob 2 daqiqa oldin».
Customers waiting more than 10 minutes in working hours with no reply and no exception = a Signal to the supervisor
through the bot, and those chats go to the human «javob kutmoqda» list (`crm/unanswered.ts` exists — today its
`ClientWaiting` reminder goes to «the manager whose account holds the chat», which on the AI number is the AI itself).

**(e) Stop buttons, from small to big:** this chat (🙋 / mute) → this right (dial to «So'rab») → initiative off
(«bugun o'zi yozmasin») → the whole AI (`/agent off`, exists, within a minute).

### 4.3 The AI's KPIs as an employee

One page, «AI hodim → Ko'rsatkichlar», the same shape as a seller's row so the two can be compared.

| Group | Number | Source today |
|---|---|---|
| **Work** | conversations handled; first-answer time (median, and share under 2 minutes); share closed with no person involved; exceptions per 100 conversations, by kind | new (the conversation record); the first-contact clock exists for leads (`crm/first-contact.ts`, `crm/analytics.ts` `firstContactBySeller`) |
| **Funnel** | new leads → qualified (kub + kg known) → quoted (table / avia / VED) → code opened → first prixod → paid; conversion at each step; lost, by reason | `/crm/tahlil` already counts by seller (`crm/analytics.ts`); the «AI birinchi javob berdi» / «AI narx aytdi» stages exist (`moveLeadByMachine`) |
| **Result** | kub and kg brought (LTL / FTL apart), money invoiced and received, repeat shipments of its clients | `staff/cargo.ts` `stampedCargo`, `crm/seller-report.ts`, `staff/seller-profit.ts` — the seat is already a seller row there |
| **Quality** | «to'g'ri ulushi» per action (§3.3), 👎, harm signals per 100, VED hand-backs of its jobs, quote-vs-prixod deviation | `agent_auto_verdicts` feedback exists; the rest new |
| **Cost** | dollars per day, per conversation, per won client; speech-to-text minutes | `agent_runs` tokens, `reports/ai-spend.ts` |
| **Against people** | the same funnel and answer time for the median human seller | exists per seller |

The missing piece that makes all of it possible is small: one record per sales conversation (who, which lead /
client, when it started, the furthest stage reached, how it ended) — the passport's header.

### 4.4 Teaching it — four layers, each with its own screen and its own owner

| Layer | What it is | Who writes it | Today | Target |
|---|---|---|---|---|
| **Narx qoidalari** | Numbers the AI may say: tariff by origin and destination, avia rate, rail rate, minimums, the markup, the discount ladder, payment terms — each with «amal qiladi: …dan …gacha». | Owner / admin, as typed settings. | The China truck table (ends 2026-12-31, `agent/site-estimate.ts`), avia $17 / kg, the VED markup (ships empty). A money figure is REFUSED as knowledge or as a lesson (`kb.ts` `moneyIn`, `lessons.ts`) — rightly: a price must be a setting code can re-check, never a sentence. | The missing columns and the ladder; the guard treats these settings as number sources. |
| **Bilimlar** | Facts with no money: addresses, hours, prohibited goods, documents, how to pay. | Owner; VED for customs facts, logist for transit facts (each inside his topic), listed weekly to the owner. | 14 seeded facts, the «Bilimlar» tab, owner-only. | Topic owners; «eskirgan» date on a fact; a fact unused for 90 days is offered for retirement. Operational notes with an expiry («KA-118 +2 kun») typed by the logist in the staff bot. |
| **Ssenariylar (playbooks)** | How to behave in a situation: first contact, «qimmat», a competitor's price, silence after a quote, a late truck, a debt, a complaint, a returning customer. Goal, steps, what it may offer, when to hand over, two example replies. | Drafted from the company's real chats, corrected and approved by the owner. | Nothing — 16 prohibitions in the prompt (`agent/prompt.ts`), no objective. | Eight playbooks to start, each versioned and measured by its own conversion. |
| **Saboqlar (lessons)** | One-line corrections after a mistake. | Owner / supervisor from any reply («📝 Tuzatish»). | Exists: ≤ 40 lessons, ≤ 500 chars each, every chat, never above a rule. Each draft already stores which lessons it was written under. | A lesson names its situation; shows its effect («shu saboqdan keyin: 12 tadan 12 tasi to'g'ri»); the weekly review proposes ≤ 5 new lessons from the owner's own rewrites and 👎 (designed in the original §7.2, never built). |

What «learning» will honestly be: the model does not change by itself. It gets better because rules, facts,
playbooks and lessons accumulate **and each is measured** — a lesson that made nothing better is retired.

### 4.5 Testing a change before a customer sees it — «Sinov maydoni»

| Tool | What it answers | How |
|---|---|---|
| **Replay («Qayta o'ynash»)** | «What would the AI have done in our real past conversations?» | Real chats from the last months are cut at each customer message; the AI answers in a dry mode — nothing sent, nothing written to the CRM. (Today the run already accepts a stand-in model, `agent/run.ts` `deps.callModel`, and the census script already cuts stored chats into customer bursts, `agent/census.ts`; the dry mode itself is new.) Output per turn: what it would say and do, whether its rights would let it go alone, and next to it what the human actually wrote. Summary in his language: «200 ta navbatdan 171 tasi o'zi ketardi, 22 tasi sizdan so'rardi, 7 tasi odamga o'tardi». |
| **Imtihon (the exam)** | «Did this change make anything worse?» | 100-150 turns the owner graded once (✅ / ❌ + a word). Every change — a lesson, a playbook, a price rule, a new model version — runs the exam first and shows «+3 yaxshilandi, 0 yomonlashdi» before «✅ Yoqish». A new 👎 from real life becomes an exam case, so the same mistake cannot return unseen. |
| **Xavfsizlik to'plami** | «Can a dangerous sentence get out?» | The existing reader corpus and policy corpora (developer-side, zero tolerance: a dangerous case that passes blocks the release). Stays as is and grows. |
| **Soya (shadow)** | «How does the new version behave on today's live traffic?» | For a day the new version answers in parallel, unseen; the differences from what was really sent are listed for the owner. Used for playbooks and model changes, not for a one-line lesson. |
| **Sinov suhbati** | «Let me try it myself.» | A test chat on the page (and a test Telegram account marked as such): the owner or a seller plays a customer, sees the reply, what the AI looked up, and which right it used. Writes nothing to the CRM or the numbers. |
| **Versiya** | «Take me back to yesterday.» | Every change to rules, facts, playbooks, lessons, dials and the model is a numbered version; the journal shows which version wrote each reply; one tap returns to the previous one. |

### 4.6 Gradual rollout — who it talks to first

| Ring | Who | Why this order | Lever that exists today |
|---|---|---|---|
| 0 | Staff phones and the test chat | no customer at risk | today a staff peer is excluded (`staff_peer`) — becomes the test ring |
| 1 | New people who write to the AI number: the website's «Telegram» button, adverts that link to Telegram | no old relationship to damage; this is where a one-minute answer wins | the website roster (`crm/site-assign.ts` `roster`, `users.lead_teams`) — tick the seat, start with a share |
| 2 | Clients with no seller (1 402 of 1 692 active clients had none when last counted, 2026-08) | nobody serves them today | `machineMayTouch` already admits a card whose seller is nobody |
| 3 | The owner's own existing customers on that number | he can judge every answer | — |
| 4 | Colleagues' clients: status and general answers only; price → their seller | protects each seller's relationship | `calc_foreign` exists as a refusal; becomes a hand-off |
| 5 | Night and weekend cover on sellers' own numbers | every seller must agree; each number carries its own ban risk | not built |

Inside a ring the dials are the same page, so the owner can run ring 1 at «O'zi» and ring 3 at «So'rab».
Advert leads that leave only a phone (Meta forms) cannot be written to first from a personal number — the cure is on
the advert side: the thank-you screen says «Telegramda yozing» with the AI number's link, so the customer writes first.

### 4.7 The staff beside it — who it asks, how they answer

| The AI needs | It asks | How it reaches them | Built on |
|---|---|---|---|
| A customs price / «can this be imported?» / a certificate | the VED on duty (the existing rota) | a calculation job, or a Savol card | `calc/service.ts` `nextVedAssigneeInTx`; the VED's «Готово» already returns to the AI (`agent/calc-loop.ts`) |
| Where a truck is, when one leaves, why one is late | the logist | Savol card; or the logist's own note «📣 AI ga» ahead of the question | `tracking/eta.ts`, the truck board; the note is new |
| Did the cargo arrive, a carton count, a photo, pick-up hours | the manager of that warehouse | Savol card | staff-bot cargo threads (`inventory/stands.ts` decides which warehouse) |
| Did a payment arrive, a balance dispute, a «to'ladim» cheque | the accountant | a payment-claim queue | the «rasxod xabari» queue is the pattern (`expense_requests`: one press claims it) |
| A discount, an exception, a complaint | the supervisor (owner / deputy) | Ruxsat / Shikoyat card | today's card |
| Anything about a colleague's client | that client's seller | card with the passport | `clients.sales_manager_id` |

- **How a colleague answers:** he swipe-replies to the card in the staff bot, in his own words. The bot already knows
  how to route a reply to the exact question it answers without trusting anything typed (`platform/telegram/
  reply-door.ts` resolves the reply to the person's own notification). The AI rewrites the answer for the customer,
  the guard checks it, it goes. A figure in a colleague's answer is accepted as a source only inside his role (the
  accountant's balance, the logist's days) — a PRICE still travels only through the offer door.
- **How colleagues are not drowned:** a per-person cap of open AI questions, working hours respected, the same
  question from two customers asked once, and the weekly report shows each person's count and median answer time —
  the questions asked most often are next week's «Bilimlar».
- **What colleagues receive from the AI unasked:** a complete job for the VED (files attached, checklist full — its
  hand-back rate is a KPI), «kutilayotgan yuk» for the warehouse, payment claims for the accountant, warm customers
  for sellers with the passport attached.

### 4.8 Pay rules and ownership — the AI as a non-paid seat

Today the seat is treated exactly as a person: cargo of its clients is stamped to it (`staff/stamp.ts` `stampFor`),
so it accrues a KPI payable (`staff/kpi-service.ts`), is ranked in the Saturday rating (`staff/rating.ts`
`standingsFor`) and praised in the staff group (`staff/celebrate.ts`). Only its machine-written offers are excluded
from commission. The finished rules:

- **No money, ever.** The seat has no KPI payable, no upsale, no salary line; `/hodimlar` shows it as «🤖 AI — to'lov
  yo'q». Its cargo is still stamped to it, because that stamp is how its result is measured.
- **Out of the race, on the board.** The rating ranks people only; the AI's week is one separate line under it («🤖
  AI: 14,2 kub, 6 yangi mijoz») — the same treatment the rating already gives FTL cargo.
- **Whose client is a customer the AI won?** Default: the AI's (the company's house account) — it keeps serving the
  repeat business, and nobody is paid for it. Above the «katta mijoz» threshold the owner hands the client to a
  seller; cargo received AFTER the hand-over counts for that seller (the stamp never moves old cargo — existing rule).
- **No cherry-picking.** A lead the AI qualified and quoted that a seller takes over before the win: the first
  shipment stays on the AI's line; the seller earns from the second.
- **Adopting sellerless clients must not rewrite history.** Today naming the first seller of a sellerless client
  back-dates that client's unstamped cargo to him (`stampUnattributedCargo`). For the seat this must be switched off,
  or the AI's first week would show months of other people's kub.
- **The seat's mailbox.** Everything the system sends «to the client's seller» (prixod arrived, price missing, debt
  approval, deviation) must reach either the machine as an event or the supervisor as a card — never a chat nobody
  reads. Debt approvals are T3: they go to the supervisor.

---

## 5. THE ROAD — stages in order

Each stage is usable on its own and ends with a replay report on his real chats before it is switched on.

| # | Stage | What is built | What the owner can STOP doing | Depends on | Size |
|---|---|---|---|---|---|
| **1** | **Qo'lni bo'shatish** — ordinary conversation goes by itself | The seller's job description instead of «qoralama»; rights per action (D1-D4, D6, D7 on); the self-confidence gate, the 2-in-a-row streak, «more than one ?», the late note removed as machine stops; several messages per turn; per-chat limits as settings; cards only for exceptions, sent to the supervisor and deputy; the journal with 👎; the health line and the «AI silent» alarm; the evening line; the first replay report. | Pressing ✅ on greetings, questions, standard answers, cargo status, table prices, VED prices. From a card for every reply to a handful of exceptions a day. | his answers 1-7, 12, 15, 21, 29, 30 | M |
| **2** | **Ko'z** — it sees what customers send | Photos, PDF, Excel read once per file and remembered; the passport; the VED receives the files with the job (exists). | Opening every photo and invoice himself; «media» stops holding anything. | 1 | M |
| **3** | **Hamkasblar** — it asks the right person | Savol routing by topic, swipe-reply answers, timers and escalation, the holding line, the logist's «📣 AI ga» notes, answers → knowledge, 🙋 inside the same chat from the CRM and «AI davom ettirsin». | Being the only person the AI can ask; relaying colleagues' answers by hand. | 1; answers 8, 9, 19 | M |
| **4** | **Sotuvni yopish** — code, address, deal | Open a GS code, address + marking as text and picture, «kutilayotgan yuk», win + deal, the company-bot invitation, the seat's mailbox as events (prixod → link, price check). Optional: customs estimate. | Opening codes, sending addresses, linking prixods for AI customers. | 1, 2; answers 20-23 | M |
| **5** | **O'zi yozadi** — initiative | Timers and events as triggers; follow-up of quotes, payment reminders, uncollected cargo, delay notices, the weekly quiet-customer list; the morning plan; «one voice per event» with the company bot. | Chasing quotes and debts; remembering who went quiet. | 1, 3; answers 24-26 | M |
| **6** | **Savdolashish** — negotiation inside limits | The discount ladder, eight playbooks, the promises ledger on the card, Ruxsat cards with the customer's record. | Answering every «qimmat» himself. | 1, 4; answer 28 | S-M |
| **7** | **Nazorat xonasi to'liq** | The KPI page against sellers, the Saturday check, promotion proposals and automatic demotion, the exam, shadow, the test chat, versions and rollback, pay and rating rules for the seat. | Judging the AI by feeling. | data from 1-6; answers 5-7, 10, 11, 16-18 | M |
| **8** | **Quloq** — voice | Speech-to-text for voice notes with read-back; a trial of providers on 10-20 of his real notes first. Call recordings later, for knowledge only. Can start beside stage 2 the day he chooses a provider. | Listening to voice notes for the AI. | 2; answer 27; a new key | M + a service |
| **9** | **Rasmiy kanal va kengayish** | The company bot as an AI channel for linked customers; a Telegram Business or WhatsApp line; a second seat; night cover on sellers' numbers. | Depending on one personal number. | 1-7 | L |

Stage 1 is first because it removes the daily pain he described — and it is mostly *removing* stops and re-pointing
cards, not building.

---

## 6. QUESTIONS FOR THE OWNER

⭐ = the recommendation, with its one-line reason. Unanswered questions will be built as ⭐.

**Running it**

1. **Who supervises the AI (receives its exceptions)?** a) only you · ⭐ b) you, and one deputy you name when you do
   not answer in time · c) a duty rota of sellers. — *One person is a single point of failure the day you fly.*
2. **How long may a customer wait for a person's answer before the card goes to the deputy and the customer hears
   «aniqlab yozaman»?** a) 5 min · ⭐ b) 15 min · c) 30 min (today's reminder). — *Long enough for one tap, short
   enough that the customer is still in the chat.*
3. **Reports:** ⭐ a) 08:30 morning report with the day's plan + a line in the 20:00 summary · b) only the 20:00
   line · c) weekly only. — *The plan is the one place its initiative needs your eye.*
4. **Do you want to see every reply it sends?** ⭐ a) no — a journal on the page, only exceptions in Telegram ·
   b) a silent copy of every reply · c) as today (a card for each). — *Cards for everything is the problem you
   reported.*
5. **Weekly quality check (15 random conversations, about 10 minutes):** ⭐ a) you, on Saturday, for the first
   month, then the deputy · b) the deputy from the start · c) none. — *It is the only measure of quality once the ✅
   is gone.*
6. **Opening a new right:** a) only after the system's number is met · ⭐ b) you turn any dial whenever you like; the
   number is shown beside it and the system only proposes · c) the system promotes by itself. — *You already said
   «50 talik test bo'lmasin»; the number informs, you decide.*
7. **Taking a right back:** ⭐ a) automatically after 2 confirmed mistakes in 7 days on a money action — that one
   action returns to «So'rab», the rest keeps working · b) after 1 mistake · c) never automatically. — *Today one
   👎 pair switches the whole AI's self-sending off; that is too blunt.*

**Teaching and testing**

8. **Who may teach it?** a) only you · ⭐ b) you; the VED for customs facts and the logist for transit facts, each in
   his own topic, with a weekly list to you · c) every employee. — *They know those answers better, and you still
   see everything.*
9. **A colleague answered the AI's question — does the answer become permanent knowledge?** ⭐ a) the AI asks the
   answerer «umumiy qoida / faqat shu mijoz / bir martalik» and you get the week's list · b) it always asks you ·
   c) never. — *Otherwise the same question comes back every day.*
10. **Past chats for testing (replay): may the AI be tested on the stored chats of your sellers' connected accounts
    as well as yours?** ⭐ a) yes, all connected accounts · b) only yours and the AI number's · c) none. — *More
    real situations; nothing is sent to any customer and nothing leaves the system beyond the AI service used today.*
11. **The exam: will you grade about 100 past answers once (✅ / ❌, about an hour)?** ⭐ a) yes, you · b) your
    deputy · c) skip — automatic checks only. — *Your taste is the standard; without it «better» has no meaning.*

**Who it serves**

12. **Who first?** ⭐ a) only new people who write to the AI number, for two weeks; then clients with no seller ·
    b) everyone who writes to that number from day one · c) only customers you pick by hand. — *New people have no
    old relationship to damage.*
13. **Website visitors pressing «Telegram»: what share goes to the AI number?** ⭐ a) 25 %, raised weekly by the
    numbers · b) 50 % · c) all · d) none. — *A controlled comparison against your sellers on the same traffic.*
14. **Advert leads that leave only a phone number:** a) sellers call, as today · ⭐ b) the advert's thank-you screen
    gets «Telegramda yozing» with the AI number, so the customer writes first · c) the AI writes first from its
    number. — *A first message from a personal number to a stranger is what gets numbers banned.*
15. **A colleague's client writes to the AI number:** ⭐ a) the AI answers status and general questions; price and
    promises go to that seller and come back through the AI · b) the AI serves him fully · c) the AI only says
    «menejeringizga yozing». — *Protects the seller's relationship without leaving the customer unanswered.*

**The seat among the staff**

16. **KPI and rating:** ⭐ a) the AI is never paid and never ranked; its week is one separate line under the rating ·
    b) it is not shown to the staff at all · c) it is ranked with the sellers. — *Visible but not a competitor for
    their prize.*
17. **A customer the AI won — whose client is he?** a) the AI's, for good · b) handed to a seller after the first
    shipment, by turn · ⭐ c) the AI's, except customers above a size you set (for example ≥ 10 kub a month or a
    whole truck), whom you give to a seller. — *The AI should sell alone; big customers deserve a person.*
18. **A seller takes over a lead the AI already qualified and quoted — whose is the first shipment?** a) the
    seller's, with full KPI · ⭐ b) the AI's line; the seller earns from the second shipment · c) half. — *Nobody
    skims the warm leads.*
19. **How does a person take over a conversation?** ⭐ a) he continues in the same chat from the CRM, as the AI
    number, and gives it back with one button · b) the AI gives the customer the seller's Telegram and steps out ·
    c) only you may take over. — *The customer never changes chats.*

**Rights (the limits its control model needs)**

20. **The client code (GS…):** ⭐ a) the AI opens it once the customer agreed to a price and gave a name and phone;
    the first two weeks every code is shown to you afterwards · b) it asks you each time (one tap) · c) never. —
    *Without the code it cannot tell a new customer what to write on the cartons — the sale stops at you.*
21. **A customer asks «narxi qancha?» and does not say which service:** ⭐ a) it gives the truck freight at once and
    offers «rastamojka bilan hisoblab beraymi?» — a yes or an invoice sends the job to the VED · b) it always asks
    first · c) it always sends to the VED. — *This is why no calculation went to the VED on 15 November.*
22. **Prices outside the China table (Kashgar / Urumqi / Horgos origin, rail, delivery to other cities):** ⭐ a) you
    fill those columns once in settings and it quotes them · b) it sends each to you · c) it sends each to the VED.
    — *A price must be a setting the code can re-check, not a sentence.*
23. **Its own customs estimate before the VED answers:** a) never · b) yes, for any goods, as a range marked
    «taxminiy, rasmiy emas» · ⭐ c) only for goods the VED has already sealed before, as a range. — *An estimate on
    codes nobody ever confirmed is the likeliest wrong number.*
24. **Reminding about a debt:** ⭐ a) by your template on the due day and 3 days later, then it stops and tells you ·
    b) only when the customer asks about money · c) never. — *Polite, bounded, and the list is in your morning
    report.*
25. **Writing first to someone who went silent after a quote:** ⭐ a) on day 2 and day 6, only to people who wrote to
    that number in the last 14 days, at most 10 a day · b) once only · c) never. — *The cheapest sales you are
    losing today; the fuse keeps the number safe.*
26. **Quiet customers (no cargo for 60 days):** ⭐ a) a weekly list you approve; sent through the company bot where
    the customer is linked · b) from the AI number too · c) none. — *The bot may write first; a personal number may
    not.*
27. **Voice notes:** ⭐ a) an outside speech-to-text service (a new key, a small cost per minute; the audio leaves
    the server) and the AI repeats back what it heard · b) it asks the customer to write · c) a person listens. —
    *Your customers talk more than they type.*
28. **Discount:** a) never by itself · ⭐ b) a ladder with your numbers (repeat customer / size → up to N % of the
    freight), asked from you one tap at a time for the first month · c) always ask. — *The ladder is your rule; the
    AI only does the arithmetic.*
29. **«Botmisiz?» and its name:** ⭐ a) honest when asked («GSR ning AI yordamchisiman, kerak bo'lsa menejerni
    chaqiraman»), under a name you choose, not in your first person · b) it says so in its first message · c) the
    question goes to a person. — *It is «alohida hodim» now; speaking as you from another account is the lie most
    likely to be discovered.*
30. **Its own daily budget:** a) $10 · ⭐ b) $25 · c) $50 — and at the ceiling open conversations go to people. —
    *Enough for roughly 40 full sales conversations and 60 short ones with files; you see the figure every evening.*

---

## 7. RISKS — stated honestly, and what limits each

| Risk | How bad | What limits it |
|---|---|---|
| **The Telegram number is restricted or banned.** It is a user account driven by a program; Telegram never says where its line is. | The AI's channel stops; history with those customers is on that number. | It only answers people who wrote first; initiative only inside a window after the customer's own message, with a small daily cap; the read → typing → send rhythm, hour and day caps, night rule and the automatic stop on any warning stay (all exist). Proactive volume goes through the company bot. Stage 9 adds an official channel so the number is not the only door. This risk shrinks; it does not reach zero. |
| **A wrong price.** | Money and trust. | A price is never the model's words: code computes it from the owner's settings and re-computes it at the moment of sending (exists); every quote is on the card; the VED's seal stays the only official customs price; an estimate is a range with its label. What remains: a wrong setting — every price setting carries its dates and shows on the page when it was last confirmed. |
| **A wrong address or marking.** | Cargo goes to the wrong place — the most expensive mistake here. | Addresses are stored facts quoted verbatim, never composed; the avia address only after the owner typed it; the code is read from the system, never typed by the model; the picture card is a fixed file. |
| **An invented promise** (a date, a discount, «boj yo'q»). | A claim later. | Promise words stay blocked unless they come from a right (the ladder, the arrival window from the system); every promise it makes is written on the card; the Saturday sample looks for exactly these. |
| **Speech-to-text errors in Uzbek / mixed Uzbek-Russian.** | A wrong kub or kg. | The AI repeats back every figure it heard and waits for «ha»; a figure from a voice note alone cannot produce a price until it is confirmed in text or by a document; providers are tried on his own recordings before one is chosen. |
| **Running cost.** Today ≈ 1.5-4 cents a reply (the spec's own figure: $5-7 a day at 150 replies); a full sales conversation with files ≈ 30-80 cents (an estimate from the code's own sizes, not a measurement); voice adds a per-minute fee to be measured in the provider trial. | Tens of dollars a day at full volume. | A daily ceiling in dollars, a per-conversation ceiling, files read once and remembered, the figure in every evening summary, cost per won client on the KPI page. |
| **Customers discover it is an AI.** | Some will refuse to talk to it; a discovered lie is worse. | It never denies (exists as a block, `ai_denial`); honest answer and a person one tap away; its own name instead of the owner's first person; «menejer kerak» always works. |
| **Silent death** — it stops and nobody notices (it happened for 17 days). | Customers unanswered under a green word. | The health line from facts, the «AI silent» alarm through the bot, unanswered chats falling into the human list (§4.2 d). |
| **The owner or the staff are flooded with its questions.** | They stop answering; the AI stalls. | Five kinds, caps per person, one question for many customers, escalation timers, and the weekly list of top questions turned into knowledge. |
| **Teaching makes it worse** — a lesson that contradicts another, forty lessons nobody remembers. | Quality drifts with no visible cause. | Every change runs the exam first, has a version and a measured effect, and can be rolled back in one tap; unused lessons and facts are retired. |
| **Staff feel replaced or game the numbers.** | Sellers ignore its questions or take its warm leads. | It is outside pay and the ranking; the hand-over rule (question 18); each person's answer time on the weekly report; it also feeds them (big customers, complete VED jobs). |
| **A new model version behaves differently.** | Yesterday's safe behaviour changes overnight. | The model is part of the version; a change runs the exam and a day of shadow before it is live. |

---

## Appendix — today's stops, and where each goes in this model

| Today's stop | Becomes |
|---|---|
| `low_confidence` (0.80 of a number the model is told to keep low) | deleted; replaced by the per-action checks (§3.2) and the measured numbers (§3.3) |
| `streak` (`AUTO_STREAK_MAX = 2`), `chat_runs` 12, `perChatPerDay` 12 | settings sized for a conversation; the account's hour / day caps stay |
| `media`, `media_only`, `voice_only` | stage 2 (eyes) and stage 8 (ears) |
| `category` by the model's own label; `complaint` / `other` never | the action decides; complaint = hand-over (T3) |
| `money`, `price` / `calc` / `calc_price` boxes | dials D1-D6 |
| `needs_owner` → a card to the holder | a typed exception to the right person, with a clock |
| `warnings`, `notes` lumped (`questions`, the late note) | split: «for his eye» in the journal, «stop» only for real rules |
| `owner_figure` (any digit in his answer returns to him) | a figure answered by the right role is a source; a price still goes through the offer door |
| rule 12 «GS kodni Bekzod o'zi ochadi», §18.5 «owner's forever» list | dials D8-D10 — his decision again (questions 20, 28) |
| `never_wrote`, `anchor_too_old` 24 h, `night`, hour / day caps, forced-off | kept — these are the ban protection |
| number sourcing (G1), other-client fences (G6), re-price at press and send, identity proof | kept unchanged — the core of the guard |
