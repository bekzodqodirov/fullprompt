# To'liq AI sotuvchi — the target product, v1 (the lead's synthesis, BEFORE the critics)

Status: DRAFT for the owner's approval. No code. Synthesised 2026-11-19 from three independent designs
(`design-product.md`, `design-risk.md`, `design-operations.md`) over three maps (`map-as-built.md`,
`map-sale-doors.md`, `map-senses.md`) — all in this folder. Where this file is short, the named design section is the
detail. Where the three designs disagreed, the ruling is marked **RULING**.

## 0. Diagnosis (why it is a «greeting bot» today)

The AI was built as a DRAFT WRITER whose every sentence is searched for danger, and whose release needs 47 conditions
true at once. It rates its own confidence (0.60-0.75 measured) against a 0.80 floor while its own instructions tell it
to rate low; the third reply in a row waits; any photo/file/voice makes the reply wait and the model sees only the
word «rasm»; the prompt forbids choosing the calculation section, opening a code, negotiating, writing first. So only
greetings survive. The flip: **judge ACTIONS by what they can cost, not WORDS and not the model's opinion of itself.**

## 1. The finished product — «AI sotuvchi — alohida hodim»

One Telegram number (the AI seat) that carries a customer from «salom» to a repeat order, 24 h, six languages.
The lifecycle table is `design-product.md` §1 (adopted), with these rulings:

| Stage | AI alone | AI asks (holding line to the customer + a case to the right person) | Human for ever |
|---|---|---|---|
| First contact | answer < 1 min any hour; open lead; fill the card | — | phone calls; cold first messages |
| Qualification | reads photos / invoices / packing lists (photo, PDF, Excel); hears voice notes and repeats figures back before pricing; computes kub from carton sizes; prohibited goods | unreadable twice → asks to type → a person | — |
| Price | truck tariff by density and origin column; avia = kg × rate; always offers podklyuch; sends the VED job with files read into lines; customs ESTIMATE as a range «rasmiy emas» under the evidence rule; VED price + his markup with the PDF offer; quote on the card | rail/container, big cargo, no-tariff destination → collects data, summary to owner | the official customs calculation (VED seal); tariff, markup, discount room |
| Negotiation | value first; discount INSIDE the room via a tool that never shows the floor; alternatives | beyond the room → one-tap card to owner | credit, release on debt, below floor |
| Closing | commitment heard → duplicate-phone check → GS code → lead won, deal opened → code + marking rule + China address verbatim + a paragraph in Chinese for the supplier + company-bot link; expected arrival recorded | — | — |
| Journey | answers «yukim qayerda»; tells only what the company bot does not (departed, delay, cleared); relays bot news to unlinked customers; one event → one message → one channel | «why late» with no data → logist | loss/damage decisions |
| Payment | amount due (proven chat), ways to pay, dated reminders, «to'ladim»+cheque → accountant queue, payment promise | «qarzga bering» → release request to those who may grant | posting money; granting debt |
| Handover | where/when; 5/10-day waiting reminders | off-hours pickup → warehouse | the handover |
| Repeat | «keyingi yuk?» after handover; follow-up cadence on silent quotes; personal re-activation; greetings | — | — |
| Complaints | never silent: apologise without admitting fault, collect facts, open a case, say who looks and by when | owner decides | compensation, refund, legal |

Never, whatever is on: state a number/address/date/code the system did not hand it; claim to be human; touch another
customer's data; write first to someone who never wrote to this number.

## 2. The autonomy model

**Rights per ACTION, four positions** (RULING: the operations design's names):
- **O'zi** — does it; visible in the journal and the report.
- **Nazoratda** («Sinovda») — does it alone at once AND every such act lands in the owner's check list (no waiting).
- **So'rab** — prepares it, one tap sends; the customer gets a holding line meanwhile.
- **Faqat odam** — the AI collects facts and hands over.

**Tiers** (RULING: risk design §3.1): T0 talk · T1 facts out (status, address, table price, estimate, balance) ·
T2 internal reversible work (lead, notes, VED job, expected arrival, tasks) · T3 commitments inside limits (official
price+PDF, discount in room, GS code, win, reminders, writing first) · T4 a person's for ever (below floor, credit,
refund, compensation, complaint resolution, confirming money, cold outreach). The tier comes from what the turn DOES
and CONTAINS, never from the model's own `category` label or `confidence`.

**Dials** on one page «AI hodim → Huquqlar»: one row per action (≈ 18 rows, list in `design-operations.md` §3.2 D1-D14
plus status, address, balance, journey news), plus limits: discount room, big-cargo line, estimate mode, markup, avia
rate, cadence steps, payment-reminder days, night rule, per-chat/per-day ceilings, daily dollars, who answers which
topic and the escalation minutes, persona, kill switches (all off / money frozen / writing-first off / one chat off).

**Trust is measured AFTER the act** (he refused a proof gate, #1683): a daily sample of 10 sent messages (👍/👎,
weighted to money actions and to the least-sure turns), customer signals (block, «botmisiz?», complaint word after an
AI message), estimate-vs-seal honesty, VED hand-back share, nightly fact check (every price/address/code/status sent
vs the database at that minute — must be 100 %). **Step-down is automatic and per action** (two confirmed mistakes in
7 days → that one action back to «So'rab»); step-up is always his tap. Account dangers still switch ALL sending off.

**Hand-over** = holding line + a case with a three-line summary and buttons to the RIGHT person + a clock that climbs
to the owner + the AI keeps answering other questions + relays the decision + asks «shu savol yana kelsa?» (📌 rule /
👤 this customer / one-off). Triggers: `design-product.md` §3.5. Take-over 🙋 and give-back «🤖 AI davom etsin» with
an optional instruction: `design-product.md` §3.6.

## 3. The guard — five walls (RULING: adopt `design-risk.md` §3.6, staged)

1. Facts only from tools; closed toolset; identity before cargo/money (exists, kept).
2. **Numbers, addresses, dates, codes, statuses are BLOCKS rendered by the system** from tool results in wording he
   approved once per language; the model writes only the sentences around them; one exact check that the model's own
   sentences carry no digit except the customer's own figures echoed, no currency word, phone, link, code shape or
   address text. This is what lets the ~9 000 lines of word readers go.
3. **The action gate: limits live inside the tools** (the concession tool answers «lowest you may say is $X» — the
   model never sees the floor; the code tool refuses the N+1th code of the day); re-price at the moment of sending.
4. **A second model reads every outgoing message** against a fixed checklist (the eight promise kinds, a claim with no
   block, another customer, language, anger/asks for a person, claims to be human): send / rewrite once / hand over.
   Trigger words become a tripwire to the stronger reviewer, not a block.
5. After sending: nightly fact check, audit sample, customer signals, per-action step-down, withdraw an unread
   message, the existing account brakes.

Staging RULING: stage 1 only DELETES the holds that protect nothing (self-confidence, streak, label category,
«more than one ?», late note, language guess, not_reply, owner_figure, repeat, card-must-ring) and keeps today's
strict money rules as the guard. Walls 2-4 arrive in stage 3, and the word tables are deleted only when the collected
dangerous cases (898 + 303) are all stopped by SOME wall. Delete / keep / dial lists: `design-risk.md` §3.7.

## 4. Structure (blocks) — `design-product.md` §4 is the inventory (exists / change / new)

Senses in (files, photos, voice, cheque screenshots, its own staff inbox as events) · senses out (several messages,
files, pictures, location; the company bot as a second voice) · brain and tools (a conversation engine with a goal,
a sale stage, a stored next step; new read tools: files, CRM card, customer profile, truck plan, customs estimate;
new act tools through the doors a seller uses) · customer memory («mijoz pasporti» + promises ledger) · the guard ·
sender and account protection · supervisor inbox (five exception kinds: Savol, Ruxsat, Shikoyat, Tekshiruv, Signal —
`design-operations.md` §4.2) · reports and the AI's KPI page · test corpus / replay / exam / test chat / versions.

## 5. Channel plan (RULING: `design-risk.md` §4-E)

- The AI number's session: REPLIES to people who wrote first (as today). Never a cold message. Warm follow-ups small.
- **Telegram Business «chatbot» on the same number** as the official reply carrier (Premium on that number; bot may act
  only in chats active in the last 24 h) — to be TRIED on a test phone before he decides (what the customer sees).
  He refused a Business bot once, when the AI lived on his personal account; on a dedicated seat it is re-asked.
- **The company bot**: everything operational and proactive for linked customers; the AI ANSWERS customers who write
  to the bot (today only relayed). Every new customer is linked to the bot at closing.
- A warmed reserve number. Advert forms end with «Telegramda yozing» so the customer writes first.
- Channel hardening comes BEFORE volume proactive messaging.

## 6. Control room, teaching, testing, rollout, pay (RULING: `design-operations.md` §4.2-§4.8 adopted)

Morning report 08:30 (yesterday's numbers, what waits on people, today's proactive plan with one switch) · exception
inbox · journal with 👎/📝 · liveness line + «AI jim» alarm · stop buttons small→big · KPI page against the median
seller · four teaching layers (price rules as SETTINGS, Bilimlar facts with owners and dates, playbooks per
situation, lessons with measured effect) · test tools (replay of real chats in dry mode, the owner's exam set, the
safety corpus, shadow, a test chat, versions with rollback) · rollout rings (staff → new writers → sellerless clients
→ his own customers → colleagues' clients status-only) · the seat is unpaid, out of the rating, with its own line;
its won clients are the company's house account; adopting sellerless clients must not back-date cargo to the seat.

## 7. The road (RULING on order)

| # | Stage | Built | Owner stops doing | Size |
|---|---|---|---|---|
| 0 | Today, no code | settings he can already change (tick Narx/Hisoblatish/VED narxi, markup, «Tarif to'g'ri», confidence 60, AI seat button, AI stages) + measurements (census of real volume, the 11-band chat dump) | — | — |
| 1 | **O'zi gaplashadi** | delete the holds that protect nothing; price/calc/VED-price on by default; seller role with a goal and its own name; «quote freight now, offer podklyuch, send to the VED when the customer wants customs»; 2-3 messages per turn + holding line; per-chat limits as dials; night replies; cards only for exceptions, to a supervisor; morning report + daily sample; liveness alarm | pressing ✅ on almost everything he pressed on 11-15 | M |
| 2 | **Ko'radi va eshitadi** | photos, invoices, PDF, Excel read once and remembered; VED job filled from files; media dead-ends removed; voice via an external speech-to-text after a trial on his real notes, with read-back | answering every chat with a photo, file or voice note | M + M |
| 3 | **So'raydi, lekin kutmaydi + yangi qo'riqchi** | routing questions by topic to VED/logist/accountant/warehouse with clocks; swipe-reply answers relayed; 🙋 with summary and give-back; the rights page; blocks + reviewer + limits ledger + nightly fact check | being the only person the AI can ask | L |
| 4 | **Narxni oxirigacha aytadi** | Kashgar/Horgos columns, avia address from Bilimlar, customs estimate under the evidence rule, PDF offer sent as a file, quotes with validity on the card, big-cargo ping | typing prices, forwarding PDFs, giving the avia address | M-L |
| 5 | **Savdoni yopadi** | commitment detection, duplicate check, GS code, win + deal, address + marking + Chinese paragraph, expected arrival, bot link, customer passport, prixod→deal link | opening codes, sending addresses, filling the CRM | M |
| 6 | **Savdolashadi va pulni eslatadi** | discount tool + room, one-tap cards beyond it, playbooks, amount due + reminders, «to'ladim» → accountant queue, payment promises | answering «qimmat», chasing bills | M |
| 7 | **Xavfsiz kanal** | Business chatbot carrier (if chosen), AI inside the company bot, reserve number, health-tied ramp | fearing one restriction stops sales | M |
| 8 | **O'zi yozadi** | acting follow-ups, journey news, waiting-cargo and after-handover messages, re-activation, Friday/birthday greetings with one approval per campaign | chasing leads, remembering who went quiet | M-L |
| 9 | **Hodim sifatida o'lchanadi** | KPI page vs sellers, weekly self-report, replay lab/exam/versions, pay and rating rules | judging by feeling | M |
| 10 | Other channels | WhatsApp Business / Instagram on the same brain and guard | — | L each |

## 8. Questions for the owner (unified; ⭐ = recommended). Required before stage 1-2: Q1-Q5, Q14-Q17, Q29-Q30.

A. Who it is
1. Whose name: a) «Men Bekzodman» (today) · ⭐ b) its own name, «GSR sotuv menejeri <ism>»; says it is an AI when asked · c) says «AI yordamchiman» in the first message. (He gives the name.)
2. «Botmisiz?»: ⭐ a) honest one line and keeps working · b) silence, a person answers (today).
B. What it does alone
3. Ordinary talk (greeting, questions, standard info, cargo status): ⭐ a) alone, 10 samples a day to check · b) alone after a 2-min hold · c) ✅ each.
4. Table prices (truck, avia): a) alone any size · ⭐ b) alone; big cargo (from 15 kub or $5 000) pings him at once · c) big cargo only him.
5. VED price + markup, and sending the VED job: ⭐ a) both alone · b) price waits · c) both wait. **And the markup: how much, % or $?**
6. Customs ESTIMATE before the VED: a) never · ⭐ b) only goods the VED calculated before, as a range «taxminiy» · c) any goods.
7. Discount alone: a) never · ⭐ b) inside a room he gives (N %, from X kub or repeat customer, once per deal) · c) only on VED-priced jobs out of its own markup. Beyond → one-tap card.
8. GS code: ⭐ a) alone when the customer commits and the phone is known, ≤ N a day · b) one tap · c) only him.
9. Avia address: ⭐ a) typed once into Bilimlar · b) always him.
10. Rail/container: a) refuse · b) he gives a tariff · ⭐ c) AI collects, he prices.
11. Kashgar/Horgos origin; other cities: ⭐ a) the tariff's own columns; delivery only to our Tashkent (and Andijan?) warehouses · b) → VED · c) he gives a table.
12. «Qachon jo'naydi?»: ⭐ a) the next planned truck «reja, va'da emas» · b) only «15-25 kun».
13. Under the minimum (1 kub and 100 kg): a) refuse · ⭐ b) offer avia · c) wait for more cargo.
14. Night 22-08: ⭐ a) answers when the customer writes; never first · b) till 23:00 · c) holds till morning (today).
C. Eyes and ears
15. Files and photos: ⭐ a) read all (≈ $0.1-0.3 a document, daily ceiling) · b) invoices only · c) none.
16. Voice notes: ⭐ a) outside speech-to-text (new key; tried on 20 of his notes; read-back before pricing) · b) ask to type · c) a person.
D. The team
17. Whom it asks: ⭐ a) by topic (VED / logist / accountant / warehouse / him), 30 min → him · b) only him.
18. A colleague's customer on the AI number: a) full service, KPI stays the seller's · ⭐ b) status, addresses, table prices; money and deals to the seller · c) everything to the seller. (RULING: the safer b.)
19. Whose leads: ⭐ a) everyone who writes to its number + the website's Telegram button first; phone-only advert leads stay with sellers.
20. Complaints: ⭐ a) apologise, collect facts, case to him, never money · b) silence + alert.
21. Who may take a chat and write from the AI number: a) only him · ⭐ b) him and named people.
22. KPI/rating: ⭐ a) unpaid, out of the rating, own page · b) in the rating, no pay · c) like a person (today, by accident).
E. Writing first
23. Unanswered quote: ⭐ a) next day, day 3, day 7, then stop · b) once · c) never.
24. Quiet customers 60+ days, greetings: ⭐ a) one personal message a month — via the company bot when linked, from the AI number only to those who wrote to it within 90 days; ≤ 20 a day; campaigns approved once each · b) bot only · c) a list for sellers.
25. Payment: ⭐ a) amount when ready, reminders day 3 and 7, cheque → accountant · b) once · c) accountant only.
F. Account, money, control
26. Carrier: a) session as today · ⭐ b) try Telegram Business chatbot on a test phone, then decide · c) later.
27. AI answers inside the company bot too: ⭐ a) yes · b) no.
28. Reserve number: ⭐ a) yes · b) no.
29. Daily budget: a) $10 · ⭐ b) $25, warning at 80 % · c) none.
30. Checking: ⭐ a) 10 samples every evening the first month, then weekly · b) weekly · c) numbers only.
31. AI quoted too low by mistake: ⭐ a) honour up to $50, correct larger, he is told · b) always correct · c) always honour.
32. Extra services to sell (insurance, repacking, door delivery, payment to suppliers…): a) he gives a list with prices · ⭐ b) only podklyuch/rastamojka/avia for now.
33. Order of stages: ⭐ a) as in §7 · b) his own order.

## 9. Risks — `design-product.md` §7 and `design-risk.md` §7 (adopted, to be told plainly)

Telegram restriction/ban of a user account (cannot be excluded, only made unlikely and cheap) · wrong price · wrong
address/code (the most expensive mistake) · invented promise (moves from «blocked by words» to «very unlikely and
measured») · speech-to-text errors in Uzbek · running cost (today ≈ $5-7/day; target estimate $15-40 on a busy day,
$600-1 200 a month — estimates, the first week's real figures decide) · customers learning it is an AI · prompt
injection through text or files · junk codes and VED load · the team · provider outage · what cannot be proven before
launch (no Telegram and no model key in the build environment).

## 10. Trials before the stage that needs them

Telegram Business behaviour on his number (24-h rule, any «via bot» mark, coexistence with the session) · speech-to-
text quality on 10-20 of his customers' real notes (2-3 providers) · how well the model reads Chinese invoices and
carton photos · his real daily conversation volume (`scripts/agent-census.ts` on the server).
