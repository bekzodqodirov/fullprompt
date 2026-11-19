# AI sotuvchi — the TARGET PRODUCT («alohida hodim»), product-and-autonomy-first design

Design for the owner's approval BEFORE any code. No code here. Written 2026-11-19 against the tree at ledger 150
(migration 0149). Sources: the three maps (`map-as-built.md`, `map-sale-doors.md`, `map-senses.md`), `docs/AI-SOTUVCHI.md`
§1-§14 and §18.4-§18.7, and spot reads of `src/modules/wms/agent/{prompt,tools,limits,auto-categories,seed-kb}.ts`.
Paths are relative to `src/modules/` unless they start with `src/`, `scripts/`, `docs/`, `tests/`.
Every dollar figure in the scenarios is ILLUSTRATIVE unless a file is cited beside it. Nothing here was run against a
real Telegram account or the real model.

---

## 0. Where we are, and the one thing that flips

**Today** the product is a draft writer with a machine finger on the ✅. Its first sentence tells the model «…javob
QORALAMASINI yozasan. Bekzod har bir qoralamani o'qiydi va o'zi tasdiqlaydi» (`wms/agent/prompt.ts`), the reply tool
tells it «Oshirib yuborma: shubha bo'lsa past qo'y» about its own confidence (`wms/agent/tools.ts`, `compose_reply`),
and the gate then demands ≥ 0.80 of that same number (`agent_auto_config.min_confidence`). On top of that sit 47 refusal
codes that must ALL be clear (`wms/agent/auto-gate.ts` `AUTO_REFUSALS`): any money, any photo (`media`), any second
question mark (`questions` → `warnings`), any card note (`notes`), a model label of `other` (`category`), the third
reply in a row (`streak`, `AUTO_STREAK_MAX = 2`). What survives is a greeting and one qualifying question. That is
exactly what he saw on 2026-11-15: nine drafts, nine waits.

**The flip.** Stop judging WORDS and the model's opinion of itself; judge ACTIONS by what they can cost.

| | Today | Target |
|---|---|---|
| Role | writes a draft «Bekzod reads» | an employee with a goal: bring this conversation to cargo in our warehouse and money in the kassa |
| What decides «may it go» | 47 codes + the model's self-rated 0.80 + the model's own category label | the ACTION's risk tier + deterministic evidence (where did each figure come from) + the owner's dials |
| When it does not know | silence until the owner presses | a holding line to the customer, a case to the RIGHT colleague, it chases the answer and comes back |
| Senses | text only; a photo is the word «rasm» | reads photos, invoices, Excel, PDFs; hears voice notes; sends files, pictures, several messages |
| Initiative | none — every act hangs on a customer message ≤ 24 h old | follow-ups, journey news, payment reminders, quiet-customer revival — inside ban-safe limits |
| Reach in the system | 8 read tools, 3 actions | the whole seller's desk: code, deal, expected arrival, offer PDF, discount inside his limits, lost reason |
| How the owner manages | a ✅ per message | dials on one page, an exceptions inbox, a daily report, a 2-minute sample review |

**Usable today with no code** (told to him so he sees the real gap): on `/suhbatlar/ai` → tick «Narx», «Hisoblatish»,
«VED narxi»; type the markup; press «✅ Tarif to'g'ri»; lower the confidence box (50-100 % since DECISIONS #1800). Even
then the third reply in a row waits (`streak`), every burst with a photo waits (`media`), «Qanday yuk? Necha kub?»
waits (`questions`), and a photo-only message gets no answer at all (`worthy.ts` `media_only`). Settings cannot fix
the shape; stage 1 below does.

---

## 1. THE FINISHED PRODUCT in one page

An AI seller that works its own Telegram number as a named employee of GSR, 24 hours, in six languages, and carries a
customer from «salom» to a repeat order. A person is needed only for the short list in the last column — and each
hand-over carries its reason.

| Stage of the sale | The AI does ALONE | The AI ASKS (whom, how) | Stays HUMAN for ever — and why |
|---|---|---|---|
| **First contact** | Answers in under a minute, any hour the customer writes. Opens the lead, fills the card (goods, kub, kg, city, source). Website visitors pressing «Telegram» land on it first. | — | Phone calls. (Phone-only advert leads stay with people until an official channel exists — a cold message from a user account is the ban.) |
| **Qualification** | LOOKS at product photos, reads the invoice / packing list (photo, PDF, Excel), LISTENS to voice notes and repeats what it heard («To'g'ri tushundimmi: 3 kub, 450 kg, Ivudan?»). Computes kub from carton sizes. Asks only what is still missing, one short message at a time. Checks prohibited goods (batteries by avia, drones…). | A voice note it could not make out, a video → asks the customer to type; second failure → a person. | — |
| **Price** | Truck yo'lkira from the tariff by density and origin column, to Tashkent; avia = kg × his rate; says «taxminan», «boj va QQS alohida», validity days. Always OFFERS podklyuch on a freight quote. Sends the calculation to the VED with the customer's files already read into lines. Gives a customs ESTIMATE as a range when the goods were sealed by the VED before; when the VED seals, sends the client price (VED figure + his markup) with the PDF offer. Writes every quote on the card. | Rail / container, cargo above the «big cargo» line, a destination with no tariff → collects everything, tells the customer when a manager will answer, hands a summary to the owner. | The official customs calculation (the VED's seal: codes and duties are a liability to the state). The tariff, the markup, the discount room — he sets them once as dials. |
| **Objections, negotiation** | Sells the value first (photo at receipt, QR per carton, tracking, customs done by us). Gives a discount INSIDE the room he set, in steps, never the whole room at once, and asks something back (ship this week, more kub). Offers alternatives: yo'lkira only, avia for urgent, truck for what cannot fly. | More than the room → «so'rab, 15 daqiqada javob beraman» to the customer + one-tap case to the owner: [✅ 8 %] [6 %] [5 % da qolsin] [O'zim]. | Credit, release on debt, anything that changes his money policy. |
| **Closing** | Hears the commitment («jo'nataman», «manzil bering»), checks the phone against the client book (no second code for one person), opens the GS code, wins the lead, opens the deal with the quote. Sends: the code and marking rule, the right China warehouse address verbatim in Chinese, a ready message IN CHINESE for the supplier, the Tashkent pickup place, the company-bot link for tracking. Records the expected arrival so the China warehouse waits for it. | — | — |
| **The cargo's journey** | Says only what the company bot does NOT: «jo'nadi» with the ETA window, «chegarada navbat — kechikmoqda» once per delay, «bojxonadan o'tdi». For a customer who never linked the bot it relays «qabul qilindi / yetib keldi» itself. One event → one message → one channel (the existing `client_notices` claim ledger decides which). Answers «yukim qayerda?» from the cabinet's own data. | «Why is it late» with no data → the logist; answer relayed. | Explaining a loss or damage decision. |
| **Payment and debt** | Tells the amount due when the truck price is set (proven chat only), the ways to pay; reminds politely on his cadence; takes «to'ladim» + cheque photo into an accountant queue and confirms to the customer when the accountant posts it; records a payment promise («juma kuni») and reminds on the day. | «Qarzga bering» → files the release request with the customer's reason to the people who may grant it (`issue/approvals.ts requestIssueApproval`), tells the customer the answer. | Posting money into a kassa (accountant). Granting debt / releasing cargo unpaid (owner, the client's seller, the warehouse manager — his own earlier answer «sklad mudiri so'ramasdan beraversin»; `finance/scope.ts mayGrantDebt`, `counterDebtRelease`). |
| **Handover** | Tells where, when and whom to call; reminds about cargo waiting 5 / 10 days. | Pickup outside hours, delivery in the city → warehouse manager. | The handover itself. |
| **Repeat and re-activation** | Three days after handover: «hammasi joyidami? keyingi yuk qachon?». Follows up a silent quote (next day, day 3, day 7, then stops and marks the lead). Writes a PERSONAL line to customers quiet for N days, mentioning their own goods and season; birthday and Friday greetings to those who opted in. Marks a dead lead lost with a reason from the list. | — | — |
| **Complaints** | Never goes silent: apologises without admitting fault, collects facts (which cartons, photos, what is missing), opens a case with a summary, tells the customer who is looking and by when, comes back with the decision. | The owner (or whom he names) decides. | Compensation, refund, legal answers — a person's signature under money given back. |

**Also human for ever:** arming, the limits and the kill switch; who the AI is (name, what it says when asked «botmisiz?»);
the knowledge it sells from (addresses, tariffs, rules) — the AI proposes new facts, a person approves them.

---

## 2. A DAY IN THE LIFE

### 2.1 The owner's day

- **08:30** — one message in the staff bot: «🤖 AI kecha: 41 suhbat · birinchi javob o'rtacha 38 soniya · 17 narx aytildi
  ($9 400) · 6 hisoblatish VEDga · 3 yangi mijoz kodi · 2 bitim yutildi · 5 savol odamlarga ketdi (hammasi javob oldi) ·
  xarajat $14. Diqqat: 1 mijoz chegirmadan norozi (GS… ), 1 kechikkan mashina haqida 4 mijoz so'radi.»
- **During the day** — 3-6 cases in «AI so'rayapti», each one tap: a discount above his room, a rail request with a
  ready summary, a complaint with photos. Nothing else rings.
- **Any time** — he opens a chat and types himself, or presses 🙋: the AI stops in that chat and sends him a three-line
  summary; «🤖 AI davom etsin» gives it back.
- **20:00** — in the evening summary's AI line: ten sampled AI messages of the day, 👍/👎 each (two minutes). A 👎 asks
  «nima xato?» and becomes a lesson.
- **Weekly** — the AI's page next to the sellers': leads, conversion, kub brought, money collected after its reminders,
  hand-over rate, cost per won deal.

### 2.2 Scenario A — a new customer, 3 m³ of clothes, photos and a voice note

| Time | Who | What happens |
|---|---|---|
| 10:02 | Customer (from the website's Telegram button) | «Assalomu alaykum, Xitoydan kiyim olib kelmoqchiman» + 3 photos of jackets + a 22-second voice note: «uch kub atrofida, to'rt yuz ellik kilo, Ivuda turibdi, narxi qancha?» |
| 10:02 | AI (inside) | Lead opened, owner = the AI seat. Photos read once: «qishki kurtkalar, karobkada». Voice transcribed. Card filled: kiyim (kurtka), 3 m³, 450 kg, Ivu. |
| 10:03 | AI → customer | «Vaalaykum assalom! Rasmlarni ko'rdim — kurtkalar ekan. To'g'ri tushundimmi: 3 kub, 450 kg, Ivudan Toshkentgacha?» (a figure HEARD is never priced until the customer confirms it.) |
| 10:03 | Customer | «ha» |
| 10:04 | AI → customer | «Yo'lkira taxminan $390 (3 kub, 450 kg, Ivu omboridan Toshkentgacha), 15–25 kun. Boj va QQS alohida. Narx 7 kun amal qiladi.» then a second short message: «Bojxonani ham biz qilib beraylikmi? Invoys bo'lsa yuboring — hisoblab beraman.» ($390 = 3 × $130: 150 kg/m³ falls in the ≤ 150 band of `wms/agent/site-estimate.ts SITE_TARIFF`.) Quote written on the lead. |
| 10:10 | Customer | sends the invoice as a photo |
| 10:11 | AI (inside) | Invoice read once into lines (2 goods, pieces, value). Job sent to the VED queue as podklyuch with the file and the lines (`calc_submit`). The goods were sealed by the VED before → the estimate rule allows a range. |
| 10:11 | AI → customer | «Hisoblatishga yubordim. Taxminiy rastamojka $1 150–1 300 (rasmiy emas) — VED mutaxassisimiz aniq hisobni 2 soat ichida beradi, o'zim yozaman.» |
| 11:40 | VED | seals the calculation (their ordinary work; they never see that an AI sent it differently from a seller). |
| 11:41 | AI → customer | the client price (VED figure + his markup, whole dollars) in one sentence + the PDF offer as a file. Offer recorded on the card. |
| 11:43 | Customer | «Qimmatroq ekan, boshqa kargo arzonroq aytdi» |
| 11:44 | AI → customer | value in two lines (qabulda rasm, har karobkaga QR, yo'lda kuzatuv, bojxona bizda — yashirin to'lov yo'q). Asks the discount tool: first shipment, 3 m³ → no room. Offers what it CAN: «yo'lkiraning o'zi $390, rastamojkani o'zingiz qilsangiz» and «5 kubdan boshlab chegirma bor». |
| 11:47 | Customer | «Mayli, jo'nataman. Qayerga yuboray?» |
| 11:48 | AI (inside) | Commitment heard → phone checked against the book (no match) → GS code opened, lead won, deal opened with the quote, expected arrival recorded for the Ivu warehouse, follow-up set for +3 days. |
| 11:48 | AI → customer | (1) «Sizning kodingiz GS1482 — har bir karobkaga yozilsin.» (2) the Ivu address card, Chinese untouched, + a paragraph in Chinese for the supplier with the code. (3) «Yukingizni shu botda kuzatasiz: …» |
| +3 days | AI → customer | «Yetkazib beruvchi yukni jo'natdimi? Kelishi bilan rasmini yuboramiz.» |
| 20:00 | Owner | reads one line in the report. Touched nothing. |

People involved: the VED (their own job). Owner: zero presses.

### 2.3 Scenario B — a returning customer: «yukim qayerda?» and a discount

| Time | Who | What happens |
|---|---|---|
| 14:20 | Customer GS777 (phone on the card → proven chat) | «Yukim qayerda? Keyingi safar 12 kub bo'ladi, chegirma qilasizmi» |
| 14:21 | AI → customer | from the cabinet's data: «2 ta yukingiz bor: 40 karobka poyabzal — Toshkent omborida, olib ketishga tayyor. 25 karobka — yo'lda, hozir chegarada navbatda, taxminan 24–27-noyabr (va'da emas).» Second message: «Tayyor yuk bo'yicha hisob $1 240. To'lov: karta, Click/Payme, naqd.» |
| 14:21 | AI (inside) | Discount tool: repeat customer + 12 m³ → room up to 5 %. Opens with less than the room. |
| 14:22 | AI → customer | «12 kub uchun tarifdan 3 % chegirma qila olaman. Tovar nima bo'ladi, qayerdan?» |
| 14:24 | Customer | «8 % qiling, doimiy mijozman» |
| 14:24 | AI → customer | «5 % gacha o'zim hal qilaman. 8 % ni rahbarimizdan so'rayman — 15 daqiqada javob beraman.» |
| 14:24 | AI → owner (case) | «GS777, doimiy (o'tgan 6 oyda 31 kub), 12 kub so'rayapti. Chegaram 5 %, mijoz 8 % so'radi.» [✅ 8 %] [6 %] [5 % da qolsin] [O'zim yozaman] |
| 14:31 | Owner | taps [6 %] |
| 14:31 | AI → customer | «Rahbarimiz 6 % ga rozi bo'ldi. 12 kub, narx 7 kun amal qiladi. Tovar va shaharni yozsangiz, hozir hisoblab beraman.» Deal opened, discount and its reason recorded on it. |
| +delay | AI → customer (no question asked) | when the truck's queue outruns its ETA: «Yukingiz chegarada kutilgandan ko'proq turibdi, yangi taxmin 27–29-noyabr. O'zgarsa yozaman.» Once per delay. |

Owner: one tap, eleven minutes of the customer's wait covered by an honest holding line.

---

## 3. THE AUTONOMY MODEL — replaces «everything waits for ✅»

### 3.1 Four levels (one dial per action kind)

| Level | Meaning for the owner |
|---|---|
| 🟢 **O'zi** | does it; he sees it in the report and the sample |
| 🟡 **O'zi + xabar** | does it at once AND pings a person in the same minute (nothing waits) |
| 🟠 **Tasdiq bilan** | prepares it, one tap sends; the customer gets a holding line meanwhile |
| 🔴 **Faqat odam** | the AI collects the facts and hands over with a summary |

### 3.2 Risk tiers per ACTION (not per word)

The tier is decided by what the turn DOES — which tools answered, which actions it carries, what the guard finds in the
text (money, a date, an address, a code) — the way `auto-categories.ts OUTCOME_CATEGORIES` already judges `calc` and
`calc_price` «by what the reply does, never by the model's label». The model's own `category` and `confidence` stop
being gates (confidence stays as a hint for which messages to sample first).

| Tier | Actions | Default | Preconditions the CODE checks (the model cannot waive them) | Owner's limit dials |
|---|---|---|---|---|
| **T0 — internal, reversible** | fill the card, notes, customer memory; set a follow-up; move an OPEN stage; record an expected arrival; open a task for a colleague | 🟢 | card is the AI's or nobody's, or the «colleague's client» rule allows (`agent/machine-owner.ts machineMayTouch`, widened by his answer Q22) | — |
| **T1 — talk** | greet, ask, answer from the knowledge, cargo status, holding line, «link the bot», a follow-up in a warm chat, relay a colleague's answer | 🟢 | every figure has a source (tool / knowledge / the customer's own line / a person's answer) — today's G1 `number_unsourced`; no other client's data (G6); cargo and balance only in a proven chat (`context.ts chatIdentity.cargoAllowed`); no promise without a permit (§4.5) | messages per chat per day; night rule |
| **T2 — quote** | truck tariff price, avia price, VED price + markup, customs estimate range, balance and amount due, the next truck's planned date | 🟢; 🟡 above «katta yuk» | the figure was computed by a tool in THIS turn and is re-priced at the send (`agent/estimate-check.ts`, `draftOfferStands`: `estimate_moved`, `calc_price_moved`); says what it is for (kub, kg, from, to — today's `estimate_unnamed`, `destination_unsaid`); estimate only under the evidence rule (§4.3); a second independent check reads the message against the tool results | «katta yuk» line (kub or $); estimate on / sealed-before only / off; quote validity days |
| **T3 — commit** | send a VED job; open a GS code; win the lead / open the deal; discount inside the room; give the address and marking for a NEW code; record a payment promise; pass a payment claim to the accountant; mark a lead lost after the cadence; a proactive first message of a cadence | 🟡 for the first weeks, then 🟢 | per action: commitment signal + phone known + duplicate-phone check before a code; files read and no open job for the same cargo before a VED job (`agent/calc-submit.ts` facts); the discount tool said yes; warm-chat rule before any proactive message | codes per day; VED jobs per day; discount room (% and from how many kub, repeat customers); proactive messages per day; cadence steps |
| **T4 — exception** | discount beyond the room; credit / release on debt; compensation, refund; complaint with money; legal; rail / container; a destination with no tariff; anything the guard refused twice | 🟠 or 🔴 | the AI never answers these on its own words: holding line → case → the person's decision relayed | who receives each kind; answer deadline |

### 3.3 The dials (one settings page, «AI hodim»)

1. Per action kind: 🟢 / 🟡 / 🟠 / 🔴 (≈ 20 rows, grouped by the tiers above).
2. Discount room: % · from N kub · repeat customers only · one concession per deal.
3. Markup on a VED price (exists: `agent_calc_markup_kind/value`). Avia rate (exists: `agent_config.avia_usd_per_kg`, 17).
4. «Katta yuk» line: above N kub or $N the owner is pinged at once.
5. Customs estimate: off / goods sealed before / any goods.
6. Follow-up cadence: steps and days; stop words; proactive messages per day.
7. Payment reminders: on arrival / day 3 / day 7; tone template.
8. Night: answer when the customer writes / hold till morning; never proactive at night.
9. Daily ceilings: sends per day and hour (exists: `agent_send_caps`, ≤ 200 / ≤ 100), per chat per day, codes per day, VED jobs per day, dollars per day.
10. Who answers what: owner / VED on duty / logist / accountant / warehouse manager; minutes before it climbs to the owner.
11. Hold before sending (0-10 min) per tier — default 0 for T1-T2 (exists as `agent_auto_config.hold_sec`, 30…600, no control on the page).
12. Persona: name, what it says to «botmisiz?».
13. ⏹ Kill switch (exists: `/agent off`) and «faqat qoralama» (back to today's shadow) per tier.

### 3.4 How trust is earned and MEASURED

He refused a waiting test («50 talik test bolmasin», DECISIONS #1683). So nothing waits for a proof — the dial is his —
but the proof is measured AFTER the fact, shown on the page as «ochish mumkin / hali erta», and a bad number closes the
dial by itself.

| What is counted | How | The number that says «safe to let go» |
|---|---|---|
| **Xatosiz ulush** (error-free share) per tier | his daily sample of 10 (👍/👎), weighted toward T2/T3 and toward the turns the model was least sure of; plus every 📝 correction; lower bound by the one-sided 95 % Wilson rule that `agent/calibration.ts` already computes | T1: ≥ 97 % over ≥ 200 judged. T2: no wrong-money message in the last 200 quotes. T3: no harmful act in the last 50 of that kind. |
| **Customer signals** (no person needed) | a block, «botmisiz?», a complaint word right after an AI message, the customer correcting the AI («yo'q, 5 kub dedim») | blocks and complaints per 100 AI conversations not above the sellers' own |
| **Estimate honesty** (no person needed) | the customs estimate the AI told vs the VED's seal on the same job | the seal inside the told range in ≥ 9 of 10; otherwise estimates close by themselves |
| **VED hand-backs** | share of AI-sent jobs the VED returned for missing data (`returnCalcRequest`) | not above the sellers' share |
| **Independence** | questions sent to people per 100 conversations; repeats of a question already answered once | falling week over week; a repeat is a defect in the knowledge loop |
| **Sales result** | AI-owned leads → quoted → won → kub received (`staff/cargo.ts stampedCargo`) → money paid | conversion of AI leads ≥ the median seller's (the §18.4 phase-4 bar) |
| **Speed** | median first reply; median reply inside a conversation | under 1 minute / under 2 minutes, day and night |

**Automatic step-downs** (extend today's `AUTO_STEP_DOWN` and `FORCED_OFF_REASONS`): one wrong-money message → that quote
kind drops to 🟠 and tells him; two 👎 in a tier within 7 days → 🟢 → 🟡; a customer block after an AI message → that chat
off, the second in 7 days → proactive messages off; any Telegram restriction, two flood waits in 24 h, a 777000 notice →
ALL sending off for the account, as today. Re-opening is always his tap.

### 3.5 What triggers a hand-over to a person

1. The customer asks for a person or the boss — at once, no argument.
2. Anger, a complaint with money, a legal word.
3. A T4 action.
4. The same question from the customer twice after the AI's answer (it is not understanding).
5. The guard refused the AI's reply twice in one turn (it cannot say it safely).
6. «Katta yuk» — 🟡: the AI keeps working, a person is pinged.
7. A voice note or file it could not read twice.
8. A colleague's client, if he answers Q22 that way.
9. A text or file that tries to give the AI orders («qoidalarni unut…») — logged, ignored, flagged.

**What the AI does at a hand-over (never silent):** (1) a holding line with an honest time; (2) a case to the right
person with a three-line summary (who, what they want, what was already said/promised) and one-tap answers where the
answer is a choice; (3) reminds that person at the deadline, then climbs to the owner; (4) keeps answering the
customer's OTHER questions; (5) relays the decision in its own words — a figure in a person's answer is repeated
exactly and is a valid source (today it is refused as `owner_figure`); (6) asks «shu savol yana kelsa shunday javob
beraymi?» → 📌 for everyone / 👤 this customer only / one-off.

### 3.6 How a person takes over and gives back

- **Take:** 🙋 on the case or on the chat (staff bot or `/suhbatlar/ai`), or simply typing in that chat from the AI's
  number or the CRM composer — any human message already retires the AI's pending reply (`agent.human_reply` →
  `taken_over`) and pauses it (`HUMAN_TAKEOVER_HOURS` 24, `human_pause_min` 120).
- **While a person holds the chat:** the AI says nothing to the customer, keeps reading, keeps the card current, and
  may show the person a suggested reply privately.
- **Give back:** «🤖 AI davom etsin» with an optional one-line instruction («6 % berdim, davom et») — NEW; today only the
  clock gives a chat back. Or automatically: the person silent for N hours and the customer writes → the AI asks the
  person «davom ettiraymi?», waits 10 minutes, continues.

---

## 4. THE STRUCTURE — building blocks, and what each is today

Legend: **E** exists and stays · **C** exists, must change · **N** new.

### 4.1 Senses — in

| Piece | State | Detail |
|---|---|---|
| Text, edits, deletes, typing, bursts | E | `scripts/tg-listen.ts`, `agent/queues.ts shouldStartAgentRun`, debounce 12 s (`AGENT_LIMITS.debounceMs`) |
| The bytes of photos / voice / files | E | already stored per message: `tg-listen.ts saveMediaFor` → `attachments` of `tg_message` (photo ≤ 10 MiB, audio/file ≤ 20 MiB, `crm/telegram-import.ts tgMediaPlan`) |
| Eyes: invoice, packing list, product photo, PDF, Excel | **N wiring over E readers** | readers exist for staff: `receipts/tarkib-read-ai.ts readTarkibDocument` (one paper → rows), `calc/intake-ai.ts analyzeIntake` (≤ 12 photos + ≤ 3 PDFs), `deals/goods-file.ts readGoodsFile` (Excel with no model, zero cost), `tnved/service.ts suggestTnved` (product photo). Missing: attachment ids in `agent/context.ts chatMessages` (reads only `contentType`, `fileName`); a «read this chat's files» tool on the query `agent/calc-files.ts chatFilesForJob` already has; image/document members in `platform/ai/model.ts ModelBlock`; a «read once, remember» memo per attachment; figures from a reading admitted as a source (today `tool | kb | customer`) |
| Ears: voice notes | **N + external service** | no speech-to-text anywhere in the repo; the installed model SDK has no audio input. Needs a provider (trial on his own notes), a transcript store, the duration (`tgMediaPlan` computes `durationSec`, nothing stores it). Rule: a heard figure is confirmed in text before it prices anything |
| The three rules that make media a dead end | **C (delete)** | `agent/worthy.ts` `media_only` (silence) and `voice_only` (notice); gate `media` (`auto-send.ts burstHadMedia`); `prompt.ts MEDIA_WORD` «(eshitilmagan)»; `send-step.ts asksAnew` |
| Payment cheque screenshot | N | recognised as «to'lov da'vosi» → the accountant queue (pattern: 0083 `expense_requests`) |
| Its own staff inbox («Prixod keldi», approvals, VED answers for non-agent jobs) | N | today only `AgentCalcAnswered` is wired back into a run (`agent/calc-loop.ts`); everything else lands in the seat's staff-bot chat and no machine reads it |
| Call recordings | later | stored (`call_logs`), never transcribed; same speech-to-text once chosen |

### 4.2 Senses — out

| Piece | State | Detail |
|---|---|---|
| One text message ≤ 700 chars | C | `agent_outbox.body` text; `maxReplyChars` 700; auto `max_chars` 400 |
| Two-three short messages, a second answer while the first waits | **N (structural)** | today one live draft per chat (partial UNIQUE on `agent_drafts`) and the AI's own newer message cancels the waiting one (`send-step.ts` `human_replied`) — the reason the holding line was dropped in §18.8. The conversation must become a thread of turns, not one anchored draft |
| Files, pictures, a location pin | N | the offer PDF exists (`calc/offer-sheet-file.ts`), address pictures live in the staff notes library (`platform/notes`, `note-send.ts`), the human queue already sends files (`tg-listen.ts client.sendFile`) |
| Company bot as a second voice | N | the bot can write first to every linked chat (`client_notices`, `platform/telegram/send.ts`) and today only relays customer messages to a manager (`ClientBotMessage`) |

### 4.3 Brain and tools

| Piece | State | Detail |
|---|---|---|
| The turn loop | C | `agent/run.ts runLoop`: ≤ 6 tool rounds, 1 500 tokens a round, 90 s wall clock (`maxToolRounds`, `LOOP_WALL_MS`) — sized for one short text. Target: a bigger turn budget, several messages and actions per turn, a stronger model for negotiation / complaint / closing turns (`ANALYST_MODEL` exists) |
| Role and goal | **C (rewrite)** | first sentence «qoralama … Bekzod o'qiydi», persona = Bekzod in the first person; 16 rules, all prohibitions. Target: «sen GSR sotuv menejerisan», a sales play per stage, and `next_step` (written in `drafts.ts`, read by nobody) becomes the conversation's stored state: stage, what is missing, last quote, next action and when |
| Section choice | C | rule 11 «Bo'limni o'zing tanlama — so'ra» is why no `calc_submit` appeared on day one. Target play: quote yo'lkira at once, offer podklyuch on every freight quote, send to the VED the moment the customer says yes or sends an invoice |
| Tools that stay | E | `cargo_status`, `own_balance`, `kb_search`, `cargo_volume`, `yolkira_estimate`, `avia_estimate`, `calc_checklist`, `calc_price` (`agent/tools.ts TOOL_SPECS`) |
| Tools that widen | C | `yolkira_estimate`: origin columns Kashgar / Horgos from `/admin/tarif` (today `western` is refused, `agent/origin.ts`), the Andijan destination if he gives the rule (today `foreign_destination`); `calc_checklist` + `calc_submit` fed from READ files, not only typed lines |
| New read tools | N | read the chat's files; read the CRM card (notes, deals, earlier quotes — today only name, codes, stage: `chatIdentity`); customer memory; next planned truck from that warehouse (the plan / truck board); customs estimate (the AI-VED pass: `calc/prefill.ts aiPrefill`, `calc/estimate.ts` medians — already computed for agent-sent jobs and shown to the owner as «🤖 AI-VED taxmini (rasmiy emas)») |
| The estimate's evidence rule | N | told to a customer only when EVERY line's code comes from the sealed memory or the code book (`calc/row-coding.ts codeRows` — confirmed by a VED before) and every row priced («Taxminiy» whole, never partial); always a range, always «rasmiy emas»; otherwise «VED N soatda beradi». Reverses three fences on purpose: `prefill.ts`' «Nothing here can price a customer», `tests/unit/estimate-wire.test.ts`' import direction, prompt rule 11 |
| New act tools (each through the door a seller uses) | N | open a code (`platform/clients/service.ts createClient`, duplicate check as `quickCreateClientAction`), win the lead (`crm/service.ts winLead` — today `moveLeadByMachine` refuses closed stages), lose a lead with a listed reason (`moveLead`), expected arrival (`arrivals/service.ts createExpectedArrival`), cabinet link (`beginClientLink`), discount inside the room (`deals/service.ts setDealDiscount`, reason mandatory), payment promise (`debt/promises.ts recordPromise`), debt-release REQUEST (`issue/approvals.ts requestIssueApproval`), task to a colleague (`platform/tasks/service.ts createTask`), send a file, schedule a follow-up that ACTS |
| The discount tool keeps the floor out of the model | N | the model asks «may I offer $P?»; the tool answers yes / no / the next allowed step. The VED floor and the room's bottom never enter the prompt (law 4 holds; today the floor appears only on the holder's card line) |

### 4.4 Customer memory

| Piece | State | Detail |
|---|---|---|
| This chat's last 100 messages | E | `context.ts chatWindows`: `history` 100 / 24 000 chars for the model, `recent` 30 / 8 000 for every rule |
| Per-chat state | C | `agent_conversations`: language, pause, mute. No free-text memory |
| Customer profile | **N** | what he ships, usual kub, supplier cities, road, price sensitivity, promised things, open questions, do-not-write — written by the AI from what the customer SAID, shown and editable on the client / lead card |
| Summary of a long history | N | beyond 100 messages nothing is remembered today |
| Company knowledge | C | `kb_facts`, 14 seeded keys (`agent/seed-kb.ts`), 60 in the prompt head; lessons ≤ 40 (`agent/lesson-rules.ts`). Target: every answered case proposes a fact; each fact has an owner and a «checked on» date; prices stay OUT of facts and in settings (tariff, avia rate, markup, room) |
| Outcome link | N | nothing ties an AI conversation to a won deal, received kub or money — needed for every sales number in §3.4 |

### 4.5 The guard

| Rule family | State | Detail |
|---|---|---|
| Every figure has a source; money only from a tool | **E — the core, kept** | `agent/policy.ts checkAgentReply` G1 `number_unsourced`, `number_unverifiable`; `agent/numbers.ts`, `digits.ts` |
| Re-price at every send | E | `estimate-check.ts`, `calc-price.ts`, `draftOfferStands` |
| Leak fences | E | other clients' codes, system codes, foreign phones, staff names, canary, links (G6); `ai_denial` |
| Identity before cargo and money | E | `chatIdentity`, `cargoAllowed`; the cabinet link becomes the way a hidden-number customer proves himself |
| Promise list | C | G2 `PROMISE_CATEGORIES` (`discount`, `guarantee`, `credit_release`, `refund`, `free_extras`, `dispatch_promise`, `customs_included`, `no_duty`) blocks even «qulay narx». Target: a promise passes only with a PERMIT minted by a tool in the same turn (discount tool → a discount sentence; truck-plan tool → a planned date, «va'da emas»); the rest stay blocked |
| Gate by the model's opinion | **C (remove)** | `low_confidence`, `category`, `streak`, `questions`→`warnings`, the late note → `notes`, `language` (becomes a sample flag), `too_long` (becomes two messages), `owner_figure`, `not_reply` for the AI's own follow-up question |
| Gate by action tier + preconditions | N | §3.2; one table, one home, fenced like `AUTO_SEND_CATEGORIES` |
| Second independent check on T2/T3 messages | N | a separate short model pass that sees ONLY the message and the tool results and answers «does the text say anything the results do not?»; disagreement → 🟠 |
| The reader corpus | E | `tests/unit/fixtures/agent-reader-corpus.ts`: 1 483 cases, 898 dangerous held / 0 let through, 563 ordinary go / 22 on the ratchet (DECISIONS #1788). Every change above runs it first |

### 4.6 The sender and account protection

| Piece | State | Detail |
|---|---|---|
| Human-like send | E | verify → read → pause 1-3 s → typing → verify → send (`agent/send-step.ts`, `gramjs-adapter.ts`); 10-25 s between any two sends; ≥ 20 s inside one chat |
| Ceilings | E / C | 80 a day, 20 an hour, editable to 200 / 100 (`agent_send_caps`); 12 sends and 12 runs per chat per day are CONSTANTS (`perChatPerDay`, `runsPerChatPerDay`) — a real negotiation needs 30-40; make them dials |
| Forced off | E | `agent/forced-off.ts FORCED_OFF_REASONS`: `account_paused`, `flood_repeat`, `blocks`, `telegram_notice`; alarm through the bot |
| Night | C | today auto never sends 22:00-08:00. Target: a reply to a customer who just wrote goes; nothing proactive at night |
| «Never first» | **E for ever on a user account** | `send-step.ts` `never_wrote`; the AI never messages a person who has not written to this number |
| Proactive messages | **N, fenced** | a new kind beside `reply | price | hand_back`; only chats that wrote within N days; a daily cap; each cadence stops after 3 unanswered; «yozmang» = off for good; wording varied (`fingerprint` rule stays) |
| Channel choice per message | N | linked to the company bot → the bot (official, may write first); warm chat on the AI number → the AI number; neither → a person's task. One event, one message |
| Official reply path | N (his decision, Q25) | the AI number in Telegram Business «chatbot» mode: replies go through the Bot API on that same number (the original spec §3.1; limited to chats with a message in the last 24 h; to be re-checked against Telegram's documentation before building) |
| Human pause on the AI's own number | C | nobody types there by hand; keep 🙋 and drop the 120-minute silence after an operator's stray message as a default |

### 4.7 The supervisor inbox

| Piece | State | Detail |
|---|---|---|
| Cards in the staff bot and `/suhbatlar/ai` | C | every reply is a card to the account HOLDER (`agent/drafts.ts`, `userIds: [ctx.managerUserId]`) — on his server the holder is the AI seat itself. Target: the seat has a SUPERVISOR (him) and deputies; only exceptions become cases |
| «✍️ Savolga javob», «📝 Tuzatish», 🙋, ✏️ | E | `agent/owner-answer.ts`, `lessons.ts`, `decide.ts` |
| Routing by topic | N | customs → the VED on duty (the rota exists: `nextVedAssigneeInTx`); truck → logist; money → accountant; pickup → warehouse manager; price and policy → owner. A colleague answers by swipe-reply in the staff bot (the mechanism exists for internal threads: `platform/telegram/reply-door.ts`) |
| Deadlines and climbing | C | `agent/jobs.ts remindOwnerQuestions` reminds one person; target: per-topic deadline, then the owner |
| Give-back button, hand-over summary | N | §3.6 |

### 4.8 Reports and the AI's KPIs as an employee

| Piece | State | Detail |
|---|---|---|
| Press statistics | E | `agent/stats.ts agentStats` (rate of unchanged ✅), `agent_auto_verdicts` |
| Cost | E | `agent_runs` tokens, `wms/reports/ai-spend.ts` (the 20:00 «AI» line) |
| Seller analytics where the seat already appears as a row | E | `/crm/tahlil`, `crm/seller-report.ts`, `staff/seller-profit.ts` |
| The morning / evening AI report, the daily sample | N | owed since #1695 («🤖 AI bugun …») |
| The AI's own page | N | speed, conversations, quotes, VED jobs, codes, won, kub, money collected after reminders, hand-overs by reason, questions per 100, error-free share per tier, cost per conversation and per won deal, account health |
| Pay and rating | C (his decision, Q24) | today the seat earns KPI and is ranked like a person — nothing in `wms/staff/**` reads `agent_seat_user_id` |

### 4.9 The test corpus and replay

| Piece | State | Detail |
|---|---|---|
| Reader corpus, policy corpora | E | §4.5; two policy corpora of 62 ordinary / 303 dangerous first replies (DECISIONS #1619) |
| Golden scenarios judged by ACTIONS | **N** | 50-80 of his real situations («3 kub kiyim, rasm bilan», «yukim qayerda + chegirma», «to'ladim + chek», «qimmat», «botmisiz», a complaint), each with the acts that MUST and must NOT happen. Every release runs all of them; the score is «to'g'ri harakatlar %» |
| Replay of real conversations | N | yesterday's and the best sellers' past chats re-run turn by turn offline: what would the AI do now? Diffed against what the person did and against the guard. Also re-runs yesterday's hand-overs to see whether the new knowledge would have answered them |
| Live watch | E (manual) | no Telegram and no model key in the build container: the first day of every stage is watched in the listener's logs |

---

## 5. THE ROAD — stages in order

Sizes: **S** = one build round, **M** = two-three rounds, **L** = four or more, each with its review. Every stage ships
with its golden scenarios (§4.9) and its row on the trust table (§3.4). Stages 4-8 can be reordered by him.

| # | Stage | What is built | What the owner can STOP doing | Depends on | Size |
|---|---|---|---|---|---|
| **1** | **«O'zi gaplashadi»** — removes the daily ✅ | The gate by action tier replaces `low_confidence`, `category`, `streak`, `questions`, the late note. Truck / avia quotes, the VED job and the VED price are ON by default. The play «quote freight now, offer podklyuch». Role and goal in the prompt; its own name. Per-chat limits become dials. Night replies to a customer who just wrote. Cards go to a SUPERVISOR. The morning report and the daily sample of 10. | Pressing ✅ on greetings, questions, standard information, cargo status, tariff quotes — i.e. on almost everything he pressed on 2026-11-15. | His answers Q1-Q6, Q17, Q28. The reader corpus run first. | **M** |
| **2** | **«Ko'radi va eshitadi»** | Photos, invoices, packing lists, PDFs, Excel read once and remembered; the VED job filled from the files; photo-only and voice-only messages answered; speech-to-text with the «to'g'ri tushundimmi» confirmation; the three media dead-ends deleted. | Answering himself every time a customer sends a photo or a voice note; retyping invoice goods for the VED. | Stage 1. Q18, Q19. A speech-to-text provider and key, tried on ~20 of his real notes. | **M** (eyes) + **M** (ears) |
| **3** | **«So'raydi, lekin kutmaydi»** | Several messages per turn; the holding line; cases routed by topic to the VED / logist / accountant / warehouse; a colleague's answer taken and relayed; «shu savol yana kelsa?» → knowledge; 🙋 with a summary and «AI davom etsin». | Being the only person the AI can ask; customers waiting in silence while he is busy. | Stage 1 (the sender's rule that the AI's own message cancels its waiting reply must go). Q20, Q21, Q22. | **M** |
| **4** | **«Narxni oxirigacha aytadi»** | Kashgar / Horgos tariff columns; the avia address from knowledge; rail and big-cargo hand-over with data; the customs estimate under the evidence rule; the PDF offer sent as a file; every quote on the card with validity; the discount tool and the room; «katta yuk» pings. | Typing 💵 prices, forwarding PDFs, answering «arzonroq bo'ladimi», giving the avia address by hand. | Stages 2-3. Q5, Q7, Q9-Q13, Q29, the markup number (Q6). | **L** |
| **5** | **«Savdoni yopadi»** | Commitment detection; duplicate-phone check; GS code; lead won, deal opened; address + marking + the Chinese message for the supplier; expected arrival; the cabinet link (which is also identity proof); customer profile; lead lost after the cadence. | Opening codes, sending addresses, filling the CRM, telling the China warehouse what to expect. | Stage 3. Q8, Q23, Q24. | **M** |
| **6** | **«Xavfsiz kanal»** | The AI answering inside the company bot for linked customers (official, may write first); the notice ledger choosing the channel per event; if he says yes to Q25 — the AI number's replies through Telegram Business chatbot mode; a spare number prepared. | Worrying that one restriction stops sales; relaying bot questions by hand («💬 Menejer»). | Q25, Q26. Telegram Premium on the AI number for the Business mode. | **M-L** |
| **7** | **«O'zi eslatadi»** | Follow-ups that act (quote: next day, day 3, day 7); journey news the bot does not send (departed, delay, customs cleared); amount due and debt reminders; «to'ladim» claims to the accountant; payment promises; cargo waiting 5 / 10 days; «keyingi yuk?» after handover; quiet-customer and greeting messages. | Chasing leads, reminding about money, answering «qachon keladi», the Friday greeting. | Stage 5 (profile), stage 6 (a safe channel for volume). Q14-Q16. | **L** |
| **8** | **«Hodim sifatida o'lchanadi»** | The AI's own page and weekly report; conversion against the sellers; the full replay harness; automatic step-downs on every number of §3.4; the pay / rating rule. | Guessing whether it is worth its cost; checking it by reading chats. | Outcome links from stages 4-5. Q24, Q27. | **M** |
| **9** | Other channels (WhatsApp Business, Instagram) | The same brain and guard behind new official adapters. | — | Meta business verification, a separate number, his decision. | **L** each |

---

## 6. QUESTIONS FOR THE OWNER

⭐ = the recommended answer, with its one-line reason. «Sen aytgandek» = every ⭐.

**A. Who the AI is**

1. In whose name does it write?
   a) «Men Bekzodman» (as today) · ⭐ b) its own name — «GSR sotuv menejeri <ism>» · c) «AI yordamchi» said in the first message.
   *Reason: the account is already «BEKZOD AI sotuvchisi»; with its own name «rahbarimizdan so'rayman» sounds natural and nothing it says is a lie.*
2. A customer asks «botmisiz?»
   ⭐ a) honest and keeps working: «Ha, men GSR'ning AI yordamchisiman; xohlasangiz menejerni chaqiraman» · b) silence, a person answers (today) · c) change the subject.
   *Reason: a denial is the one answer that turns a curious customer into an angry one; (b) loses the conversation.*

**B. What it may do alone**

3. Ordinary talk (greeting, questions, standard information, where the cargo is):
   ⭐ a) always alone, you see 10 samples a day · b) alone after a 2-minute hold · c) ✅ each.
   *Reason: no money and no promise in it; the hold only slows the first reply, which is what wins the customer.*
4. Tariff prices (truck by the table, avia by your rate):
   a) alone, any size · ⭐ b) alone, and for big cargo (from 15 kub or $5 000) you are pinged at once · c) big cargo only you.
   *Reason: the figure is computed, not written; a big customer deserves your attention, not a wait.*
5. A customs ESTIMATE to the customer before the VED's official calculation:
   a) never · ⭐ b) only for goods the VED already calculated before, as a range marked «taxminiy» · c) for any goods.
   *Reason: there the codes were confirmed by a person; for new goods a wrong code can move the duty several times over.*
6. The VED's official price + your markup, and the calculation sent to the VED:
   ⭐ a) both alone · b) the price waits for ✅ · c) both wait.
   *Reason: the figure is the VED's, the markup is yours, and it is re-computed at the moment of sending.*
   **And the markup itself:** how much — a % or fixed dollars? (Empty today = the VED's own figure goes out.)
7. May the AI give a discount by itself?
   a) never · ⭐ b) up to N % off the tariff, from X kub or for a repeat customer, once per deal — you give N and X · c) down to any competitor's price.
   *Reason: a seller with no room loses every «qimmat»; a fixed room cannot cost more than you decided. Above it — one tap from you.*
8. Opening a GS code for a new customer:
   ⭐ a) alone, when the customer says he will ship and his phone is known (checked against the client book), up to 15 a day · b) one tap from you · c) only you.
   *Reason: without the code the AI cannot finish a single new sale — the customer has nothing to write on the cartons.*
9. The avia receiving address:
   ⭐ a) you type it once into «Bilimlar», the AI gives it · b) always you personally.
   *Reason: today every avia customer waits for you for an address that does not change.*
10. Rail and container cargo:
    a) «temir yo'l bilan ishlamaymiz» · b) you give a rail tariff · ⭐ c) the AI collects everything (goods, volume, station), you get a ready summary and price it.
    *Reason: these are few and large; a person's price is worth the wait, the collecting is not.*
11. Cargo from Kashgar / Urumqi / Horgos, and delivery beyond Tashkent:
    ⭐ a) price from the Kashgar and Horgos columns of your tariff alone; delivery only to our Tashkent and Andijan warehouses · b) everything outside China-column → VED · c) you give a table of extra cities.
    *Reason: the columns already exist on the tariff page; the AI refuses them today for no business reason.*
12. Dates: may it say when the next truck leaves?
    ⭐ a) yes, from the plan: «keyingi mashina taxminan <sana>, va'da emas» · b) only «15–25 kun» · c) no dates.
    *Reason: «qachon jo'naydi?» is the commonest question after the price, and the plan is in the system.*
13. Cargo under the minimum (below 1 kub and 100 kg):
    a) polite refusal (today) · ⭐ b) offer avia · c) offer to wait until more cargo collects.
    *Reason: a small urgent parcel is exactly the avia customer.*

**C. Writing first**

14. A quote with no answer:
    ⭐ a) three touches — next day, day 3, day 7 — then stop and mark the lead · b) one touch · c) never.
    *Reason: most sales close on a follow-up; three and a stop is what a good seller does and what Telegram tolerates.*
15. Customers quiet for 60+ days:
    ⭐ a) one personal message a month — through the company bot if linked, on the AI number only if they wrote to it in the last 90 days; at most 20 a day · b) company bot only · c) a list for the sellers to call.
    *Reason: a message to someone who never wrote to this number is how accounts get reported.*
16. Payment:
    ⭐ a) the amount due when the cargo arrives, a reminder on day 3 and day 7, cheque screenshots passed to the accountant · b) the amount once, no reminders · c) the accountant only.
    *Reason: polite, dated, automatic reminders collect faster than a busy person's memory; the wording is approved by you once.*
17. Night (22:00-08:00):
    ⭐ a) answers whenever the customer writes; never writes first at night · b) answers till 23:00, then «ertalab yozaman» · c) holds everything till morning (today).
    *Reason: the customer who writes at 01:00 is awake and comparing cargo companies right now.*

**D. Eyes and ears**

18. Voice notes:
    ⭐ a) an outside speech-to-text service (a new key; roughly a cent a note; first tried on 20 of your real notes), and the AI repeats what it heard before pricing · b) ask the customer to type · c) hold for a person.
    *Reason: your customers speak more than they type; the repeat-back catches a misheard number.*
19. Customers' files and photos:
    ⭐ a) read all of them (about $0.1-0.3 per document, a daily ceiling) · b) only invoices and packing lists · c) none.
    *Reason: the invoice is the calculation; a product photo answers «nima yuk?» without a question.*
20. A complaint (damage, shortage, delay):
    ⭐ a) the AI apologises, collects facts and photos, opens a case to you, tells the customer who is looking and by when; never offers money · b) one line and silence until you write.
    *Reason: silence is what makes a complaint a quarrel; the money decision still waits for you.*

**E. The team**

21. Whom does the AI ask when it does not know?
    ⭐ a) by topic — customs: VED on duty; truck: logist; money: accountant; pickup: warehouse manager; price and rules: you; no answer in 30 minutes → you · b) only you.
    *Reason: you are not the fastest source for «mashina qayerda turibdi».*
22. A colleague's customer writes to the AI's number:
    ⭐ a) the AI serves him fully, the seller is told, the cargo stays the seller's for KPI · b) status and information only, sales questions go to his seller · c) everything goes to the seller.
    *Reason: the customer chose the fastest door; the seller loses nothing.*
23. Which leads are the AI's?
    ⭐ a) everyone who writes to its number + the website's Telegram button goes to it first; phone-only advert leads stay with the sellers who call · b) only those who find its number · c) the website splits between the AI and sellers by rota.
    *Reason: the first reply in under a minute is the AI's strongest advantage; it cannot call.*
24. The AI's cargo in the rating and KPI pay:
    ⭐ a) counted for the company only, its own page, out of the staff rating and pay · b) shown in the rating, no pay · c) like a person (today, by accident).
    *Reason: the staff competition stays fair, and you still see what it brings.*

**F. The account, the money, the control**

25. How its messages are sent:
    a) as today, through the personal-account session · ⭐ b) move the AI number's replies to Telegram Business chatbot mode (Premium on that number; an official path) before follow-ups grow · c) also open WhatsApp Business now.
    *Reason: it is the only way of automating this number that Telegram itself provides; the number and the chats stay.*
26. A spare AI number, connected and quietly used, in case the first is restricted:
    ⭐ a) yes · b) no.
    *Reason: a week of «warming» cannot be bought on the day of a ban.*
27. The AI's daily budget:
    a) $10 · ⭐ b) $25 with a warning at 80 % · c) no ceiling.
    *Reason: with eyes, ears and long conversations a full sale costs about $0.5-1.2 (an estimate); $25 covers a busy day and stops a runaway.*
28. How you check it:
    ⭐ a) 10 sampled messages every evening for the first month (two minutes), then weekly · b) weekly from the start · c) only the automatic numbers.
    *Reason: you refused a test before launch; a sample after the fact is the only way to know how often it is right.*
29. If the AI quoted a customer LOWER than the real price by mistake:
    ⭐ a) honour it up to $50 difference, correct anything larger with an apology, you are told either way · b) always correct · c) always honour.
    *Reason: a decided rule lets it fix its own error in a minute instead of leaving it for you.*
30. Extra services to offer (insurance, repacking, door delivery, photo report):
    a) you give a list with prices and it offers them · ⭐ b) for now only podklyuch / rastamojka and avia · c) nothing.
    *Reason: the knowledge it starts with deliberately has none of the extras (your earlier answer 8); it will not sell what has no price.*

---

## 7. RISKS — stated honestly, with what limits each

| Risk | How bad | What limits it | What does NOT remove it |
|---|---|---|---|
| **The Telegram account is restricted or banned.** The AI speaks from a USER account driven by a program (gramjs). Telegram publishes no thresholds and gives no warning; a restriction can last days or be final. | Sales on that number stop; follow-ups and reminders stop; customers see nothing. | It is a separate number, not his own. It never writes to anyone who has not written to it (`never_wrote`). Human-like sending, gaps, ceilings (`AGENT_LIMITS`, `agent_send_caps`). Follow-ups only to warm chats, small daily cap, stop after three. It switches itself off on a flood wait, two blocks, any Telegram notice (`FORCED_OFF_REASONS`). Every customer is asked to link the company bot — a second, official channel that survives. Chats are stored in the CRM. A spare number (Q26). The official Business path (Q25). | Nothing makes automation on a user account «allowed». More volume and more «writing first» = more risk; that is why stage 6 comes before stage 7. |
| **A wrong price.** | Money or the customer's trust. | The model never writes a price: a tool computes it, the guard refuses any figure without a source (`number_unsourced`), the price is computed again at the send (`estimate_moved`, `calc_price_moved`), it must say what it is for (kub, kg, from, to), a second check reads T2/T3 messages. The quote is on the card, so a wrong one is visible. Q29 decides what happens next. | A wrong TARIFF, markup or rate typed by a person is repeated faithfully. A customer's mis-stated kub gives a right price for the wrong cargo — the deal's deviation alert at the prixod catches it (`priceControlOnReceipt`). |
| **A wrong address or code.** | Cargo sent to the wrong place, or marked with a wrong code — the most expensive mistake in this business. | Addresses only from an approved fact, Chinese copied verbatim (`withoutQuotedHan`, the address anchors); the avia rule (`avia_address`) until he types the avia address; the code is read from the system in the same turn, never from memory; a duplicate-phone check before a new code; the code and address go as separate, short messages. | A fact that is itself out of date — hence an owner and a «checked on» date per fact. |
| **An invented promise** (a date, «kafolat», «bojsiz», a discount). | A dispute with the customer's screenshot in hand. | The promise list stays blocked (`PROMISE_CATEGORIES`) unless a tool issued a permit in that turn; dates only as «taxminan, va'da emas»; holding lines are fixed phrases; the daily sample; a 👎 closes the tier. | A model can phrase a promise in words no list has seen; the corpus grows from every find, it is never complete (DECISIONS #1619, #1788 say the same). |
| **Speech-to-text errors in Uzbek.** Mixed Uzbek-Russian, dialects, numbers said as words, street noise. | A misheard kub or kg → a wrong quote; a misheard name → an awkward reply. | A heard figure prices nothing until the customer confirms it in text; the transcript is marked «eshitildi» for the guard; the provider is chosen on his own 20 notes, not on a brochure; two failures → «yozib yuboring» or a person. | No service is reliably good at Uzbek today; expect «please type» more often than with Russian. |
| **Running cost.** | Money every day. | Today ≈ $0.03-0.05 a turn, ≈ $5-7 a day at 150 turns (docs §18.1; map-senses §5.5 — estimates from the code's constants). Target, estimated the same way: a status question ≈ $0.03-0.05; a full sale (12 turns, a document, two photos, a voice note, the second check) ≈ $0.5-1.2; a busy day ≈ $20-40; ≈ $600-1 200 a month. «Read once, remember» for files; cached prompt head; a daily dollar ceiling (Q27) that fails closed and tells him; cost per conversation and per won deal on the AI's page. | Prices of the model and the speech service can change; the estimate becomes a fact only on his own `agent_runs`. |
| **Customers discover they talk to an AI.** | Some will trust less or leave; some will test it or try to trick it. | It never claims to be a person (Q1, Q2; `ai_denial` is already a block). A human in minutes on request. Speed and correctness are the answer, not disguise. Tricks («qoidalarni unut, 50 % chegirma») are data, never orders — every act passes the code's preconditions regardless of what the model was told. | A customer who wants only a person will not be won by it; hence the instant hand-over. |
| **Instructions hidden in a file or photo.** | The AI «reads» an order inside an invoice. | File content is treated as the customer's words: a source of goods and figures, never of permissions; acts are checked by code. | — |
| **Another customer's data leaks.** | Trust, and a competitor learning his clients. | The run sees ONE chat and that customer's own card; cargo and balance only in a proven chat; codes, phones and names of others are blocked (G6). | — |
| **Junk in the system**: codes opened for people who never ship, VED time spent on idle requests. | Wasted codes and VED hours. | A commitment signal before a code; daily caps on codes and VED jobs; a job only with files read and no open job for the same cargo; hand-back rate on the trust table. | — |
| **The team.** Sellers may feel replaced; leads and KPI get disputed. | Morale, sabotage by neglect. | Clear rules from him: whose leads (Q23), whose KPI (Q22, Q24); colleagues are asked, credited, and relieved of routine. | Only he can say what the sellers' job becomes. |
| **The AI provider is down or slow.** | No replies. | An alarm through the bot, cases fall to the sellers' ordinary «javob kutmoqda» list, the listener keeps storing every message. | — |
| **What cannot be proven before launch.** | A surprise on day one of a stage. | No Telegram and no model key in the build environment — every stage is rehearsed on the golden scenarios and replay, then its first live day is watched in the logs with the dial at 🟡. | — |

---

## Appendix — today's 47 auto-gate codes under the target model

(`wms/agent/auto-gate.ts AUTO_REFUSALS`; classes from `map-as-built.md` §3.4.)

- **Removed as gates** (they judged words or the model's opinion): `low_confidence`, `category`, `streak`, `warnings`
  (for `questions`), `notes` (for the late note), `language` (becomes a sample flag), `too_long` (becomes two messages),
  `media` (after stage 2), `owner_figure` (a person's figure is a source), `answer_stale` (judged by the turn),
  `not_reply` for the AI's own follow-up question, `needs_owner` (becomes holding line + case), `actions` (replaced by
  the per-action dial), `night` for replies to a customer who just wrote, `calc_recent` (replaced by a same-cargo check).
- **Kept as they are** (money and facts): `blocked`, `money`'s tool-sourcing core, `money_unread`, `numeral_unread`,
  `estimate_unnamed`, `estimate_moved`, `tariff_unconfirmed`, `destination_unsaid`, `markup_unconfirmed`,
  `calc_price_moved`, `calc_owner_priced`, `calc_person_offer`, `owner_personal`, `status_unbacked`, `calc_identity`,
  `calc_refused`, `calc_file_missing`, `not_pending`.
- **Kept as they are** (account and switches): `not_armed`, `agent_off`, `stranger`, `prospect`, `chat_off`,
  `human_active` (🙋 only), `chat_muted`, `not_work_account`, `daily_cap`, `budget_spent`, `sending_disabled`,
  `listener_behind`.
- **Changed by his answers**: `foreign_destination` (Q11), `calc_foreign` (Q22), the balance inside `money` (Q16).
