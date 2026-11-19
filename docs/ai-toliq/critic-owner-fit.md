# Critic — the owner and the business (lens over SPEC-TOLIQ-v1.md)

Date 2026-11-19. Read-only; nothing under `/home/user/fullprompt` was touched, nothing was run but `grep`/`sed`.
Read: `SPEC-TOLIQ-v1.md` in full; `design-product.md` in full; `design-operations.md` §1-§7; `design-risk.md` §1-§2,
§3.6-§7; `map-as-built.md` §5-§8; `CHANGELOG.md` 2026-11-13 … 11-18; `docs/AI-SOTUVCHI.md` «Qisqacha», §1-§3, §12-§15,
§17.14, §18.4-§18.7; `DECISIONS.md` #1197, #1800; `agent/seed-kb.ts`, `agent/site-estimate.ts`, `agent/origin.ts`,
`agent/limits.ts`, `agent/prompt.ts` (rules 2, 9, 12), `calc/tariff-seed.ts`, `crm/site-assign-rules.ts`,
`rbac/nav.ts`, the `batches` / `load_plans` tables, `docs/SAYT-TAQSIMOT.md`, `docs/ZAVOD-YOPISH.md`.
Every «the company does X» below names its file. Where I could not ground something I say «unverified».

## 0. Verdict in eight lines

1. **He answers «sen aytgandek».** So the ⭐ set IS the product. Today's ⭐ set silently reverses six recorded rules
   (in his own answers: code, avia address, customs figure, night, «customer is never reminded»; in §18.5:
   discounts) and carries blanks
   («N %», «X kub», «≤ N a day», «<ism>», «how much markup») that «sen aytgandek» cannot fill. Fix: every ⭐ fully
   numbered; every reversal marked «⚠ avvalgi javobingiz: …»; names and numbers asked as three fill-ins, not letters.
2. **The question behind his 11-15 complaint is not on the list.** «Why did it quote the table instead of sending to
   the VED» (#1800, still open with him) was turned into a RULING in stage 1. It is his decision. It must be Q2.
3. **Nine replies a day.** Nothing in the spec says how customers reach +998902405077. An AI that may never write
   first, on a number nobody knows, stays a nine-message product whatever is built. Two questions are missing
   (website share in plain words; do we announce the number), and they belong in the first ten.
4. **Stage 1 as cut is not what he would feel.** A photo-only message is still answered with silence, a voice note
   still with nothing, every new customer still stops at him for the code, and the claim «almost everything he pressed
   on 11-15» was never measured although the rows to measure it are on his server.
5. **The product page promises three things he ruled against** and **omits six things his business does** (factory
   pickup, «Sotib olib berish», the customer's ❌ on a prixod, unclaimed cargo, FTL, the call-back).
6. **Costs:** the three designs differ five-fold on one sale ($0.3-0.8 / $0.5-1.2 / $1.5-3); the spec prints one
   range and a ⭐ budget ($25) below its own «busy day» ($15-40). The real spend is already in his 20:00 message.
7. **«Answer < 1 min any hour»** contradicts the account fuses that stay (20 sends an hour, 10-25 s between sends,
   80 a day, a 14-day ramp — `agent/limits.ts`) once every turn is 2-3 messages.
8. Required-before-stage-1 list (Q1-Q5, Q14-Q17, Q29-Q30) contains three that need no answer (Q3 answered on 11-11,
   Q5 is a setting, Q15 is the lead's) and misses five that do.

---

## A. THE QUESTION LIST

### A.1 Defects of the list as a whole (change before sending anything)

| # | Defect | Change |
|---|---|---|
| a | ⭐ options with blanks: Q1 «<ism>», Q5 «how much», Q7 «N %, from X kub», Q8 «≤ N a day». | Put a concrete number in every ⭐ («3 %», «10 kub», «10 a day»); ask the three things only he can type as FILL-INS above the list: the AI's name, the deputy's name, the markup. |
| b | ⭐ reverses a recorded answer with no warning: Q6 (answer 8 of 10-24: «the AI never prices a calculation itself»), Q8 (10 b: «HE opens the GS code», and §18.5), Q9 (fourth set: «men adres beraman»), Q14 (11-11, 4a: «none at night»), Q7 (§18.5 «discounts … the owner's forever»), Q25 + the Handover row (DECISIONS #1197, his 3a: «the seller hears, the customer never does»), §1 Journey (round C, 09-27: «no new push kinds»). | Each such option gets one line «⚠ avval … degansiz — o'zgartiramizmi?». Where the reversal is costly and not needed to start (Q6, Q7, Q25), the ⭐ becomes «keep your rule for now». |
| c | 33 at once, stage-8 questions beside stage-1 ones. | Two blocks: **10 to start** and **«keyingi bosqichlar — hozir javob bermasangiz ham bo'ladi»**. Two are asked later WITH DATA (A.5). |
| d | Code words he does not use: «carrier», «session», «room», «tool», «evidence rule», «tariff's own columns», «warmed reserve number», «house account». | Rewritten in A.4. |
| e | Questions he already answered are re-asked as if new (Q3, Q10, Q13's minimum, Q20). | Dropped; stated to him in one line each (A.6). |
| f | Q32's examples include «payment to suppliers» — not found anywhere in the repo or in the vendored site facts. The site's extras are: free storage days, insurance, photo report, repacking, door delivery (`seed-kb.ts` header; `docs/AI-SOTUVCHI-REVIEW.md` line 296: «None of these exists in the system»). | Use the grounded list; add the two real services the list forgot (factory pickup, «Sotib olib berish»). |

### A.2 Each of the 33

«His?» = a decision only he can make. «Clear?» = understandable with no code. «⭐ ok?» = defensible to HIM.

| Q | His? | Clear? | ⭐ ok? | Verdict → change |
|---|---|---|---|---|
| 1 name | yes | yes | yes | KEEP, MERGE Q2. Say that the account is already titled «BEKZOD AI sotuvchisi», so option a («Men Bekzodman») contradicts what the customer sees. Add: profile name/photo. ⚠ 11-11 6a. |
| 2 «botmisiz?» | half — honesty is «qoida, savol emas» (docs §12.1) | yes | yes | MERGE into Q1: the only open part is «answers itself» vs «goes to you». |
| 3 ordinary talk | answered 11-11 («ozi javob beraversin … kop kutib qolmasin») | yes | yes | DROP. Lead: alone, hold 0. The «10 samples» half moves to the checking question. |
| 4 table prices | yes | half («15 kub or $5 000» are two rules; the designs disagree $3 000 / $5 000) | half | REWRITE: one unit (kub) + «to'liq mashina (fura)»; LTL/FTL is his own notion (`docs/LTL-FTL.md`). |
| 5 VED price, job, markup | no — boxes and the markup field exist since 11-15; A1/A2 answered | no (three things in one) | — | DROP as a question → stage-0 chore list (tick two boxes, type the markup, «✅ Ustama to'g'ri»). The real question hidden here is MISSING-1. |
| 6 customs estimate | yes | half | **no** | LATER WITH DATA. It tells a customer «$1 150-1 300» before the VED says «$1 480»; reverses answer 8. First show him his own table «AI-VED taxmini vs VED javobi» (both are stored for agent-sent jobs), then ask. ⭐ for now: a) never. |
| 7 discount | yes | no («room», «out of its own markup») | half — blanks | REWRITE with numbers; ⭐ month one = every request is a one-tap card; then a numbered rule. ⚠ §18.5. |
| 8 GS code | yes | yes | half | KEEP, add the «Nazoratda» option (alone, each code shown to him the same minute); number in the ⭐. ⚠ 10 b. Codes are never reused (CLAUDE.md round 103) — a junk code burns a number he cares about («451»). |
| 9 avia address | yes | yes | **unverified premise** | REWRITE. The ⭐ assumes «an address that does not change» (design-product Q9). He chose to give it per cargo («yukini infosini menga bersang men adres beraman»). Ask WHY first. |
| 10 rail | answered 10-24 («Temiryol mendan sorasin narxini») | yes | = his words | DROP; say «o'zgarmaydi». |
| 11 Kashgar/Horgos; other cities | yes | no — two questions, and a false premise | no | SPLIT. «The tariff's own columns»: `kashgar` is seeded, **Horgos has no price row unless he typed one** (`calc/tariff-seed.ts`), and Kashgar is NOT on his address card (`seed-kb.ts china_points@4`: «Qashqar is no longer named»). «(and Andijan?)» is a question inside an option. |
| 12 «qachon jo'naydi» | yes | yes | **unverified** | LATER WITH DATA. A planned date exists only as `load_plans.target_date` (nullable; quick trucks have no plan). Measure how often logists fill it before promising «the plan is in the system». |
| 13 under the minimum | no | yes | yes | DROP. Lead: say the minimum (his rule: 1 kub YOKI 100 kg), offer avia from 1 kg. |
| 14 night | yes | yes | yes | KEEP. ⚠ 11-11 4a. |
| 15 files and photos | no (cost only; staff «Hisoblatish» already sends customers' files to the same AI service) | yes | yes | DROP. Cost goes into the ceiling question. |
| 16 voice | yes | half | see `critic-stt.md` | KEEP, split as that critic says (trial permission / fallback). |
| 17 whom it asks | yes | yes | yes, but 30 vs 15 min undecided | MERGE with Q21 for the start half (supervisor + deputy); topic routing is its own later question with the answer time. ⚠ answer 15 («managers do not see drafts»). |
| 18 colleague's customer | yes | yes | yes | KEEP (start). |
| 19 whose leads | yes | half | **no as written** | REWRITE. «The website's Telegram button first» = sellers get no more site visitors; their pay is KPI on cargo they bring (`staff/kpi-*`). Say it; offer shares. Today the button gives the least-busy person of a team (`docs/SAYT-TAQSIMOT.md`). |
| 20 complaints | no — already the rule (docs §2 «Ohang») | yes | yes | DROP as a question; keep as a stated rule. «By when» needs a time from him → folded into the supervisor question. |
| 21 who may take a chat | yes | yes | yes | MERGE into the supervisor question. |
| 22 KPI/rating | yes | half | yes | KEEP later, MERGE with «whose client is an AI-won customer» and the staff-group congratulation (`docs/JAMOA-GURUHI.md`: every won lead and first prixod is celebrated by name). |
| 23 unanswered quote | yes | yes | half | KEEP later; ⭐ two touches not three. ⚠ docs §13 «mijozga birinchi bo'lib yozish» is on the never list. |
| 24 quiet customers | yes | no (one 45-word option) | half | REWRITE. The company-bot broadcast and birthday list already exist (`/admin/xabarlar`, 0109). ⭐ = bot only. |
| 25 payment reminders | yes | yes | **reverses 3a** | REWRITE, merged with the Handover row's 5/10-day reminders. |
| 26 carrier | yes | **no** | see `critic-telegram.md` | REWRITE in plain words; MERGE Q28. |
| 27 AI inside the company bot | yes | yes | yes | KEEP later; say the «💬 Menejer» messages go to the client's seller today. |
| 28 reserve number | yes | no («warmed») | half | MERGE into Q26; say what it cannot do (it may not write first to anyone). |
| 29 budget | yes | half | **no** — $25 is under the spec's own «busy day $15-40»; a hard stop is the silence he hates; he said «chegara qoyma» | REWRITE: warn level + a far fuse + what happens at the stop. |
| 30 checking | yes | yes | half — «2 minutes» is not honest | KEEP (start); add «your deputy» as an option. |
| 31 quoted too low | yes | yes | yes | KEEP; say it concerns the official price (table prices are «taxminan» already). |
| 32 extra services | yes | half | yes | REWRITE around real services (A.1 f). |
| 33 order | yes | only with the road in front of him | — | KEEP last; offer «kod va manzil oldinroq». |

### A.3 Missing — the build would have to guess

1. **A bare «narxi qancha?»** (kub and kg given, service not named): table figure + offer customs / ask first / always VED.
   His expectation on 11-15 was a VED job; design-operations Q21 had it; the spec dropped it into a ruling.
2. **Supervisor and deputy by name**, and how long a card may wait before it climbs. Today cards go to whoever
   holds the seat's staff-bot link (`map-as-built.md` §5 row 17).
3. **How customers reach the AI number** — the website share in his words, and whether existing customers are told.
   Without it rings 2-4 of the rollout («sellerless clients», «his own customers») are empty: they do not know the number.
4. **«Telefon qiling»** — who calls back, how fast. The spec lists phone calls as «human for ever» and gives no hand-off.
5. **Who gets a hot or big lead** (a named seller, or the taqsimot rota) and whether an AI-won client is ever handed over.
6. **Payment requisites** — may the AI send a card number / bank details. A wrong digit sends money to a stranger;
   `seed-kb.ts payment@1` names the ways and nothing else.
7. **Factory pickup and «Sotib olib berish».** `seed-kb.ts china_warehouse_price@1` says only «zavoddan omborgacha olib
   kelish alohida hisoblanadi»; the website has a third team `buying` («Sotib olib berish», `crm/site-assign-rules.ts`).
   Who prices them, whom the AI hands to, may it ask for the supplier's contact / 1688 link.
8. **Road news unasked** (jo'nadi / kechikmoqda / bojxonadan o'tdi) — a new push kind; he declined new kinds on 09-27.
9. **Default language when the first message shows none** («GS777», «👍»). 1b made that reply wait for ✅; stage 1
   deletes the wait. Lead may decide (customer's language; unclear → Uzbek Latin) — but it must be SAID to him.
10. **Facts to confirm, not letters** (A.6): avia $17/kg while the vendored site table says $9-12/kg and 5-10 days
    (`site-estimate.ts SITE_TARIFF.air`, snapshot 2026-09-08) — a customer who used the site calculator sees both;
    the site table ends 2026-12-31; the Tashkent warehouse's working hours are in no fact; «yakuniy hisob omborda
    o'lchangan kub/kg bo'yicha» is said nowhere although the table price is by density.

### A.4 The final list — 29 questions, in order (English; ⭐ = what «sen aytgandek» builds)

**Fill-ins first (three lines he types):** the AI's name ____ · your deputy ____ · your markup on a VED price ____ (% or $).

**START — needed before stage 1**

1. **Who it is.** The account is already called «BEKZOD AI sotuvchisi».
   a) writes as you, «men Bekzod» (today) · ⭐ b) its own name, «GSR sotuv menejeri ____»; never says it is a person;
   asked «botmisiz?» it answers itself, one honest line («Ha, GSR'ning AI yordamchisiman, kerak bo'lsa menejerni
   chaqiraman»), and goes on · c) as b, and it says «AI yordamchiman» in its first message.
   ⚠ On 11-11 you chose «my name; botmisiz → to me» — that was your own number.
2. **The customer writes «3 kub, 450 kg, narxi qancha?» and does not say whether he needs customs.**
   ⭐ a) it gives the yo'lkira figure at once and asks «rastamojka bilan hisoblab beraymi?» — a «ha» or an invoice
   sends the job to the VED · b) it first asks «faqat yo'lkirami, rastamojka bilanmi?» and prices after the answer ·
   c) no table price, every request goes to the VED.
   (With a, the customer hears the small number first and the full one later. On 15 November no job reached the VED
   because of this rule.)
3. **Big cargo.** Table prices go out alone. From what size are you (or a seller you name) told at once?
   a) never · ⭐ b) from 20 kub, or when the customer says «to'liq mashina / fura» — the AI still answers, you get a
   ping · c) from that size the AI gives no price, collects everything and hands over.
4. **Night, 22:00-08:00.** ⭐ a) it answers a customer who writes; it never writes first · b) until 23:00 ·
   c) everything waits for the morning (today). ⚠ On 11-11 you chose «tunda yo'q».
5. **Who receives what the AI cannot decide, and who may write from its number?**
   a) only you · ⭐ b) you and your deputy: a card you have not answered in 15 minutes (09:00-19:00) goes to him too ·
   c) a duty list of sellers.
6. **Visitors who press «Telegram» on the website.** Today the least busy seller gets each one.
   a) as today, the AI gets none · ⭐ b) the AI stands in the same queue as one more seller for two weeks, then you
   decide by the numbers · c) all cargo visitors go to the AI — sellers get none from the site (their KPI is paid on
   the cargo they bring). «Sotib olib berish» visitors stay with people in every case.
7. **Do existing customers learn the AI's number?** (It may never write first from that number.)
   a) no — only new people find it · ⭐ b) customers WITHOUT a seller get one message through the company bot (the
   «Xabarlar» page you have) and the number is added to the address card; sellers' own customers are not told ·
   c) everyone is told.
8. **A colleague's customer writes to the AI number.**
   a) full service; the cargo stays the seller's · ⭐ b) cargo status, addresses, table prices; money, discounts and a
   new deal go to that seller as a card and the answer returns through the AI · c) only «menejeringizga yozing».
9. **Checking it.** ⭐ a) every evening ten of its messages with 👍/👎 for the first month — 5-10 minutes; then
   weekly · b) your deputy does it · c) nobody; only the automatic signals (a block, a complaint word, the price
   re-check). With c nothing measures how often it is right.
10. **Its daily money.** Your 20:00 message already shows what it spent.
    ⭐ a) a warning to you at $15; a full stop only at $50, and then open chats go to people · b) a full stop at $25 ·
    c) no limit. ⚠ You said «chegara qoyma» about the daily count — a stop means silence in the middle of the day.

**LATER — answer now or when its stage comes**

11. **Voice notes** (wording and split: `critic-stt.md` §8): may 20 real notes be sent to 2-3 speech services for a
    trial; and until one passes ⭐ the AI asks the customer to type and you get a card.
12. **Whom it asks, by topic, and how fast they must answer.** a) only you and the deputy · ⭐ b) customs → the VED on
    duty; where is the truck / why late → logist; «pul tushdimi» → accountant; pickup → the warehouse manager; price,
    discount, complaint → you. Fifteen minutes in working hours, then you. ⚠ Earlier: «drafts are seen by me only».
13. **«Telefon qiling.»** ⭐ a) the AI takes the number and a convenient hour, opens a task for ____ and tells the
    customer «menejerimiz qo'ng'iroq qiladi» · b) the task comes to you · c) the AI gives a phone number (which?).
14. **Client code (GS…) for a new customer who says «jo'nataman».** a) alone · ⭐ b) alone, at most 10 a day, and each
    code is shown to you the same minute for the first two weeks (one tap cancels) · c) one tap from you each time ·
    d) only you (today). ⚠ On 10-24 you said «kodni o'zim ochaman».
15. **Avia address — why do you give it yourself today?** ⭐ a) it is always one address → you type it once into
    «Bilimlar» · b) it depends (city, goods, the flight) → you give the rule · c) keep asking me each time (today).
16. **Cargo that starts in Kashgar or Horgos.** ⭐ a) Kashgar by the second price column already in the system;
    Horgos after you type its prices into «Tarif»; until then to you · b) both always to the VED / you (today).
    And one fact: do we receive cargo in Kashgar now? Your address card names Ivu, Guanchjou (Foshan) and Xorgos only.
17. **City of delivery.** Every price says «Toshkentgacha». ⭐ a) Tashkent only; pickup in Andijan at the same price
    (ha / yo'q?); other cities the customer arranges · b) you give a table of surcharges · c) each to you (today).
18. **Services beyond yo'lkira, rastamojka/podklyuch and avia.** ⭐ a) it sells only those three; for factory pickup
    («zavoddan olib kelish») and «Sotib olib berish» it collects the details (factory address, supplier contact or
    1688 link, ready date) and hands them to ____ · b) you give prices for pickup, crating (yashik) and the website's
    extras (insurance, door delivery, repacking, photo report) and it offers them.
19. **Payment details.** ⭐ a) it names the ways (karta, Click/Payme, naqd, bank) and that payment is in Tashkent
    before pickup; the card number comes from ____ · b) fixed requisites typed once into «Bilimlar», sent unchanged.
20. **It told an official price lower than the right one.** ⭐ a) up to $50 the customer keeps it; above, it corrects
    with an apology; you are told either way · b) always corrects · c) always keeps.
21. **Discount.** ⭐ a) for the first month every request comes to you as one tap ([3 %] [5 %] [yo'q] [o'zim]) ·
    b) alone up to 3 % of the yo'lkira, for a repeat customer or from 10 kub, once per deal · c) alone, only out of
    the amount you add on top of the VED's price. ⚠ Earlier: «chegirma faqat egasi».
22. **A price that got no answer.** ⭐ a) two reminders, day 2 and day 6, then it stops · b) three (day 1, 3, 7) ·
    c) one · d) none. Only to people who wrote to its number; at most 10 a day.
23. **Ready cargo and the money for it.** a) only when the customer asks (your rule of 09-28: «mijozga eslatma
    bormaydi, sotuvchiga boradi») · ⭐ b) the amount is told once when the cargo is ready, through the company bot
    where the customer has it · c) and reminders on day 3 and day 7.
24. **Quiet customers (60+ days), Friday and birthday greetings.** ⭐ a) through the company bot only, each campaign
    approved by you once · b) also from the AI number to people who wrote to it in the last 90 days, at most 20 a
    day · c) a list for sellers to call.
25. **News on the road without being asked** (jo'nadi / chegarada kechikmoqda / bojxonadan o'tdi).
    ⭐ a) none — it answers «yukim qayerda»; the bot's three messages stay · b) only a delay beyond the window it
    gave, once, through the bot · c) all three. ⚠ On 09-27 you chose no new message kinds.
26. **Customers who write into the company bot («💬 Menejer»).** ⭐ a) the AI answers status, addresses and standard
    questions there; the rest goes to the customer's seller as today · b) no.
27. **Protecting the number** (facts: `critic-telegram.md`). a) as today · ⭐ b) we try Telegram's official «chatbot»
    connection on a test phone and show you what the customer sees; then you decide · c) and a second SIM kept
    ready — it cannot write first to your customers, it only shortens the restart.
28. **Customers the AI wins.** ⭐ a) the company's own, served by the AI; no seller's KPI; the AI is outside the
    Saturday rating and the group congratulations, with its own line · b) handed to a seller by turn after the first
    cargo · c) counted like a seller (today, by accident). And: from ____ kub a month or a whole truck → seller ____.
29. **Order of the stages.** ⭐ a) as proposed · b) code and address earlier · c) your order.

### A.5 Asked later, with his own data in front of him (not in this round)

- **Customs estimate to the customer before the VED** (spec Q6) — after a read-only table of «AI-VED taxmini» against
  the VED's answer on his own agent-sent jobs. Until then: never (his answer 8 stands).
- **«Qachon jo'naydi?» from the plan** (spec Q12) — after counting how many plans carry a target date.

### A.6 Not questions

- **The lead decides and tells him in one line each:** ordinary talk goes alone, no hold (Q3) · rail: «sizdan
  so'raydi» stays (Q10) · under 1 kub and 100 kg: says the minimum, offers avia from 1 kg (Q13) · it reads files and
  photos (Q15) · complaints: apologises, collects facts, hands over, never money (Q20) · language unclear → Uzbek
  Latin · never the whole price table, only the customer's own figure.
- **Chores for him, as a numbered step list (today, no code):** tick «Narx», «Hisoblatish», «VED narxi»; type the
  markup and press «✅ Ustama to'g'ri»; press «✅ Tarif to'g'ri»; press «Bu akkaunt — AI sotuvchi»; choose the two AI
  stages in «CRM → Sozlamalar»; give the AI account a @username and tick it in the website teams; read the 14
  «Bilimlar» facts once; add the Tashkent warehouse hours; say which is right — avia $17/kg (his) or the site's
  $9-12/kg; the 2027 tariff (the site table ends 31.12.2026); the advert thank-you screen «Telegramda yozing» (his
  agency's work, not a product feature — spec §5 lists it as if built).

---

## B. PRODUCT PAGE CHECK (spec §1)

### B.1 Promised against a rule he set — re-ask or remove

| Row | What the page promises | His rule | Change |
|---|---|---|---|
| Handover | «5/10-day waiting reminders» in «AI alone» | DECISIONS #1197, his 3a: uncollected cargo — «the seller hears, the customer never does» | Remove from «alone»; A.4 Q23. |
| Journey | tells «departed, delay, cleared» unasked | round C (09-27): standard variant, «no new push kinds»; round 98: he complained of a message per carton | Move to «if he says so»; A.4 Q25. Default: only answers. |
| Price | «customs ESTIMATE as a range» in «AI alone» | answer 8 (10-24): the AI never prices a calculation itself | Move out of the page's «alone» column until A.5. |
| Closing | «GS code → lead won, deal opened» in «AI alone», «Human for ever: —» | 10 b and §18.5: code, win and loss are his | Keep as the target, but the cell must read «alone IF he answers Q14»; the page is shown to him as a finished product. |
| Negotiation | discount inside a room | §18.5; prompt rule 2 | Same: conditional on Q21. |
| First contact | «answer < 1 min any hour» | 11-11 4a (no night), and the fuses | See D-1. |
| Repeat | «personal re-activation; greetings» in «AI alone», column «asks: —» | Q24 itself asks for one approval per campaign | The table and the question disagree; put the approval in the «asks» column. |
| §2 hand-over | cards «to the RIGHT person» | answer 15 (drafts are his only); law 4 (the VED never sees a client price) | Say that a card to the VED carries the customer's question and never the client price. |

### B.2 Promised, but the business or the system does not do it as stated

- **«Expected arrival recorded [so the China warehouse waits for it]»** — the list is not in the warehouse menus any
  more (round 47 took «kutilayotgan yuklar» off the warehouse home and both warehouse menus; among the curated menus
  of `rbac/nav.ts` only the logist's and the seller's carry `/arrivals`). And a promise's difference is reported to
  its AUTHOR (round 12, batch 2) — the seat, a chat no
  person reads. Say «the logist sees it», and route the seat's notifications to the supervisor from the same stage.
- **«"Qarzga bering" → release request to those who may grant»** via `issue/approvals.ts` — that request is made at
  the counter for one client and one warehouse and lives 24 hours (`debt_approval_ttl_hours`). Filed from a chat days
  before pickup it expires unused. Change: the AI hands the request to the client's seller / him as a case.
- **«"To'ladim" + cheque → accountant queue»** — no such queue exists (only the pattern, `expense_requests`). It is a
  new daily duty for the accountant; say so, and ask the accountant, not only him.
- **«Kashgar/Horgos columns»** (stage 4) — Horgos has no prices until he types them; Kashgar has prices and no
  receiving address on his card.
- **«The next planned truck»** — exists only where a plan with a target date exists (A.5).
- **«Handover: where/when»** — «when» has no fact (no working hours in `seed-kb.ts`).
- **«Complaints: say who looks and by when»**, and the holding lines «15 daqiqada javob beraman» (design-product) —
  a time promised by the AI and kept by a person. Without a deputy it is the invented promise the guard forbids.
  Holding lines name no minutes unless Q5 gave a deputy.
- **«Ways to pay»** — the ways are a fact; requisites are not (Q19).
- **From stage 5 the seat is the client's seller**, so everything the system sends «to the client's seller» goes to a
  mailbox nobody reads: «Prixod keldi» with its two buttons, the client's ❌, the price-missing and deviation alerts,
  the 5/10-day wait, the first-cargo congratulation in the staff group, and KPI accrual. The spec mentions «staff
  inbox as events» in §4 and gives it no stage. It must ship in the SAME stage as the code opening.

### B.3 Missing — what a strong seller in THIS business does (each from the repo)

1. **Factory pickup** (`docs/ZAVOD-YOPISH.md`, `pickups`; fact `china_warehouse_price@1`). The seller says «zavoddan
   ham olib kelamiz», takes the factory address, contact and ready date, and gives them to the logist. Not on the page.
2. **«Sotib olib berish»** — the website's third team (`LEAD_TEAMS`). A visitor from that button can land on an AI
   that has no fact, tool or rule about it. At minimum: recognise, collect, hand to a named person.
3. **The customer's own ❌ on a prixod** (`docs/TARKIB-TAKLIFLAR.md` T2, `docs/PRIXOD-XABARI.md` A,
   `docs/PRIXOD-JAVOBLAR.md` 1b). After «❌ Xato bor» the customer is told to write — to whom? For an AI-won client
   that is the AI. design-risk had this row; the spec dropped it.
4. **Unclaimed cargo** («mening yukim kodsiz kelibdi»): cargo is claimed by the marking text (`/unclaimed`,
   `assignReceiptClient`). The AI should take the marking and a photo and hand to the warehouse. Not on the page.
5. **FTL** (`docs/LTL-FTL.md`): a whole-truck enquiry is another product (outside KPI, priced by a person). «Big
   cargo» on the page is a size line only; a seller asks «to'liq mashinami?».
6. **The call-back** (A.3-4). His sellers call; the calls app exists. The page has «phone calls — human» and no bridge.
7. **Customs through the client's own firm** («mijoz o'z firmasi bilan», batch and receipt level). A seller asks
   «rastamojkani o'zingiz qilasizmi?»; the page's «always offers podklyuch» has no branch for «no, my own broker».
8. **The Mini App** as the answer to «rasmini ko'rsating», «qancha qarzim bor», «qayerda»: the customer's own
   cabinet shows photos, balance, the five steps and the map. Linking the bot is also the only identity proof for a
   hidden phone number — on a new AI number that is most writers. The page mentions the bot only at closing.
9. **«Can this be imported?»** for a product not on the prohibited list → the VED on duty (design-operations row 2).
   The page says «prohibited goods» only.
10. **Crating (yashik)** for fragile goods — the system builds crates and books their cost; whether customers are
    charged is unverified → Q18.

---

## C. THE TWO SCENARIOS (chat scripts for the page)

Real: the tariff arithmetic (`site-estimate.ts SITE_TARIFF`), the sentences «taxminan», «15-25 kun», «boj va QQS
kirmaydi», «zavoddan omborgacha … alohida», the Ivu address and reminder, the Tashkent contact, the ways to pay
(`seed-kb.ts`). **ILLUSTRATIVE:** the AI's name, every VED figure and markup, the code number, the cargo and the
balance of GS777, the discount rule, all times.

### C.1 Yangi mijoz — rasm va ovozli xabar bilan (the finished product, after stages 1-5)

1. **Mijoz:** «Assalomu alaykum. Xitoydan kurtka olib kelmoqchiman» + 3 ta rasm + 🎤 0:22
   *[lead opens by itself. Photos read once: winter jackets in cartons. Voice → text: «uch kub atrofida, to'rt yuz
   ellik kilo, Ivuda turibdi». A heard figure prices nothing yet.]*
2. **AI:** «Vaalaykum assalom! Men GSR LOGISTICS sotuv menejeri ____man. Rasmlarni ko'rdim — kurtkalar ekan. Ovozli
   xabaringizdan shunday tushundim: 3 kub, 450 kg, yuk Ivuda. To'g'rimi?»
3. **Mijoz:** «ha togri. narxi qancha boladi»
   *[confirmed in text → table: 450 ÷ 3 = 150 kg/kub → the «150 gacha» band = $130/kub → 3 × 130 = $390. The price
   sentence is written by the system, not by the model. The quote is saved on the lead.]*
4. **AI:** «Yo'lkira taxminan $390 — 3 kub, 450 kg, Ivudagi ombordan Toshkentgacha, mashinada 15-25 kun (taxmin,
   va'da emas). Boj va QQS bu narxga kirmaydi. Zavoddan omborgacha olib kelish alohida hisoblanadi.»
   **AI:** «Rastamojkasini ham biz qilib beraylikmi? Invoys bo'lsa tashlang — hisoblatib beraman.»
5. **Mijoz:** 📎 invoys.xlsx «mana. rastamojka bilan qancha chiqadi»
   *[the Excel is read row by row with no model. A complete job goes to the VED queue with the file. The AI says no
   customs figure of its own.]*
6. **AI:** «Rahmat, invoysni oldim. Bojxona mutaxassisimizga hisoblatishga yubordim — javob kelishi bilan o'zim
   yozaman.»
   *[later the VED presses «Готово». The system adds the owner's markup, rounds up to a whole dollar and computes it
   again at the second of sending. The AI never sees the VED's own figure.]*
7. **AI:** «Hisob tayyor: rastamojka va yo'lkira bilan jami $1 600, Toshkentgacha. Taklifni fayl qilib yubordim.» 📎 PDF
8. **Mijoz:** «mayli jonataman. qayerga yuboray»
   **AI:** «Kod ochishim uchun telefon raqamingizni yozib yuboring.» — **Mijoz:** «90 000 00 00»
   *[phone checked against the client book — no match → code opened (alone, or one tap from the owner: his Q14) →
   lead won, deal opened with the price.]*
9. **AI:** «Kodingiz: GS1482. Har bir karobkaga shu kod yozilsin.»
   **AI:** «Ivu (YW) qabul ombori: 浙江省 义乌市 稠江街道 荷花南街 2255号，周先生，小周 13429089596. Yuklaringizni
   joʻnatishdan oldin GS kodini (markirovka) yozishni unutmang. 发货前请不要忘记标注GS编码（唛头）。»
   *[the address is copied whole from «Bilimlar»; not one character is the model's.]*
10. **AI:** «Yukingiz omborga kelganda rasmi bilan xabar shu botdan keladi: [kompaniya boti]. To'lov — yuk Toshkentga
    kelganda, olib ketishdan oldin, so'mda.»
    *[owner: nothing pressed, or one tap for the code. 20:00: «🤖 Yangi mijoz GS1482 — 3 kub kurtka».]*

Note for the page: steps 1-2 need stage 2 (eyes and, if the trial passes, ears); step 6-7 work today when the boxes
are ticked; steps 8-9 are stage 5. Show him which lines exist TODAY — it is more than he thinks, and less than the page.

### C.2 Doimiy mijoz — «yukim qayerda» va chegirma

1. **Mijoz (GS777):** «salom yukim qayerda? keyingi safar 12 kub olib kelaman, chegirma qilasizmi»
   *[his phone is on the client card and visible in Telegram → cargo and balance may be told. Hidden number → the AI
   first asks him to open the company bot, which proves the phone.]*
2. **AI:** «Assalomu alaykum! Ikkita yukingiz bor: 1) 40 karobka poyabzal — Toshkentda, olib ketishga tayyor.
   2) 25 karobka — Tranzitda, Toshkentga taxminan 24.11-27.11 (taxmin, va'da emas).»
   *[the same five steps and the same window the Mini App shows; no truck code, no plate.]*
3. **AI:** «Tayyor yuk bo'yicha hisobingiz: $1 240. To'lov yukni olishdan oldin, so'mda, to'lov kunidagi kurs
   bo'yicha: karta, Click/Payme yoki naqd.»
   **AI:** «Keyingi 12 kub necha kg bo'ladi, qayerdan?»
4. **Mijoz:** «2100 kg, guanchjoudan. 8 foiz qilib bering doimiy mijozman»
   *[table: 2 100 ÷ 12 = 175 kg/kub → the «200 gacha» band = $160/kub → 12 × 160 = $1 920. The owner's rule
   (illustrative): a repeat customer from 10 kub — up to 5 % alone. 8 % is above it.]*
5. **AI:** «12 kub, 2 100 kg, Guanchjou omboridan Toshkentgacha yo'lkira taxminan $1 920. Boj va QQS bu narxga
   kirmaydi.»
6. **AI:** «5 % gacha chegirmani o'zim qila olaman. 8 % ni rahbarimizdan so'radim — javobini shu yerda yozaman.»
   *[card to the owner: «GS777 — doimiy mijoz, shu yil 31 kub. 12 kub, $1 920. 8 % so'rayapti, AI chegarasi 5 %.»
   [8 %] [6 %] [5 %] [O'zim yozaman]. No minutes are promised to the customer.]*
7. *[the owner taps [6 %] seven minutes later.]*
   **AI:** «Rahbarimiz 6 % ga rozi bo'ldi: 12 kub uchun taxminan $1 805.»
   *[1 920 − 6 % = 1 804.80, rounded up. The discount and its reason are written on the new deal, where the logist
   who prices the truck sees them. TO CONFIRM with him before it is ever said: «yakuniy hisob omborda o'lchangan kub
   va kg bo'yicha».]*
8. **Mijoz:** «rahmat. tayyorini ertaga olib ketaman»
9. **AI:** «Xo'p. Toshkentdagi sklad — Chuqursoy sklad. Yukni olish bo'yicha: Umriddin, +998 95 018 30 33.»

Note for the page: steps 1-3 and 9 work with stage 1 (status and standard facts; the balance going alone is his
Q23). Steps 4-7 are stage 6. Under «sen aytgandek» with A.4's ⭐ the first month has no «5 % alone» line — step 6 is
then only the card.

---

## D. HONESTY CHECK

| # | The spec / designs say | Why it is more certain than it can be | The honest sentence |
|---|---|---|---|
| 1 | §1 «answer < 1 min any hour» | The account fuses stay: 12 s gathering, 10-25 s between any two sends, 20 s inside a chat, **20 sends an hour and 80 a day** by default, less in the first 14 days (`agent/limits.ts`). Stage 1 makes a turn 2-3 messages, so about 7-10 answered turns an hour. | «Odatda 1-2 daqiqada. Bir vaqtda ko'p mijoz yozsa, akkauntni himoya qiluvchi chegara (soatiga 20 ta xabar; siz 100 gacha ko'tara olasiz) sababli ba'zilari kutadi.» |
| 2 | §9 «today ≈ $5-7/day; target $15-40 on a busy day, $600-1 200 a month» | «Today» assumes 150 turns; his measured day had nine replies. One sale costs $0.3-0.8 (operations), $0.5-1.2 (product) or $1.5-3 (risk) — a five-fold spread the spec hides; only the highest of the three (risk) counts the second model that re-reads every message, which the spec adopts. | «Bugun haqiqiy xarajat 20:00 xabaringizda turibdi — kuniga 9 ta javobda bu sentlar. To'liq sotuv suhbati 0,3 dan 3 dollargacha bo'lishi mumkin; aniq raqamni birinchi haftaning o'zi aytadi. Kuniga 40 ta to'liq suhbatda oyiga 400-3 000 dollar oralig'i — hozircha bundan aniq ayta olmaymiz.» |
| 3 | Q29 ⭐ «$25, warning at 80 %» | Below the spec's own busy day; a hard stop is the silence he complained of. | A.4 Q10. |
| 4 | §9 «ban … only made unlikely and cheap» | Not cheap: customers hold THIS number; a reserve number may write to none of them first (`never_wrote` is kept «for ever»); only bot-linked customers stay reachable. And the plan itself raises sending (2-3 messages a turn, nights, follow-ups). «Warmed» is undefined. | «Raqam cheklansa, shu raqamdagi sotuv to'xtaydi. Ikkinchi raqam mijozlarga birinchi bo'lib yoza olmaydi — ularga faqat kompaniya boti orqali yetamiz. Shuning uchun har bir yangi mijoz botga ulanadi. AI qancha ko'p va qancha tez-tez o'zi yozsa, xavf shuncha ortadi.» |
| 5 | §1 «hears voice notes», Q16 «≈ a cent a note» | Nothing in the repo hears; Uzbek-Russian mixed speech is untested; see `critic-stt.md`. | «Ovozli xabarni sizning 20 ta haqiqiy xabaringizda sinovdan o'tsa eshitadi. O'tmasa — mijozdan yozishni so'raydi.» |
| 6 | §1 «reads photos / invoices …», «computes kub from carton sizes» | §10 itself lists «how well the model reads Chinese invoices and carton photos» as untried. Kub from sizes exists only for TYPED sizes. | «Excelni aniq o'qiydi. Rasm va PDFni o'qiydi, lekin xitoycha invoysda xato qilishi mumkin — shuning uchun o'qiganini mijozga qaytarib aytadi va VED tekshiradi.» |
| 7 | design-product «a 2-minute sample»; Q30 | Ten messages cannot be judged without their chats: 5-10 minutes. And every trust number and every step-down («two CONFIRMED mistakes») needs someone to confirm. | «Kuniga 5-10 daqiqa. Hech kim qaramasa, AI qanchalik to'g'ri ishlayotganini faqat bloklar va shikoyatlar ko'rsatadi.» |
| 8 | §7 sizes «M», «L» | Never defined in the spec; the designs define them differently (2-3 build rounds / 1-2 weeks). The record: part 1 took eight fix passes and two extra checks; each reader round found its own regressions. Stage 3 hides a rewrite of the guard inside a stage named for something else. | Give weeks as a range and say what can slip: «1-bosqich: 1-2 hafta. 3-bosqichning qo'riqchi qismi eng xavflisi va sizga ko'rinmaydigani — uni alohida ko'rsatamiz.» Split stage 3 into «hamkasblardan so'raydi» (he feels it) and «yangi qo'riqchi» (he does not). |
| 9 | §2 «nightly fact check … must be 100 %» | A check after sending cannot «must». | «Har kecha yuborilgan narx, manzil, kod va holat bazaga solishtiriladi; har bir farq ertalab sizga nomi bilan keladi.» |
| 10 | §3 «this is what lets the ~9 000 lines of word readers go»; «898 + 303 all stopped by SOME wall» | The cases were collected against word readers; the second model's catch rate is unknown and «will not be 100 %» (design-risk §7). | «Yangi qo'riqchi va'dani so'z bo'yicha emas, ma'no bo'yicha ushlaydi. U ba'zan o'tkazib yuboradi — qanchasini yig'ilgan 1 200 ta xavfli javobda o'lchab, sizga aytamiz; eski qoidalar shu son ma'qul bo'lgandagina o'chiriladi.» |
| 11 | §1 «six languages» | English, Persian and Chinese go alone only when the language is clear; Chinese numerals are unreadable to the guard; wrong-language sends are still owed (CHANGELOG 1b «Hali qolgani»). | «O'zbek va rus — ishonchli. Ingliz, fors, xitoy — ishlaydi, xato ko'proq, shubhali javob sizga keladi.» |
| 12 | §7 stage 1 «pressing ✅ on almost everything he pressed on 11-15» | Unmeasured. All nine carried the confidence hold, but beside it `money`, `warnings`, `notes`, `needs_owner` (#1800) — and stage 1 keeps the strict money rules. | Run a read-only re-count of the stored verdicts under stage-1 rules on his server first; then say «9 tadan N tasi o'zi ketardi». |
| 13 | §1 «one event → one message → one channel» | True for the bot's pushes (their ledger exists); the AI number's messages are in no such ledger today. | «Bot aytgan xabarni AI takrorlamaydi — buni qurish kerak, hozir yo'q.» |
| 14 | §2 holding line + «a clock that climbs to the owner»; design-product «15 daqiqada javob beraman» | The clock ends at one person. | No minutes in a holding line; «rahbarimizdan so'radim, javobini shu yerda yozaman». |
| 15 | §6 «KPI page against the median seller», trust bars «≥ 200 judged», «last 200 quotes» | At nine replies a day 200 judged messages are a month away and a comparison with sellers means nothing. | «Hozirgi hajmda bu raqamlar bir-ikki oydan keyin ma'noli bo'ladi. Avval hajm kerak (6- va 7-savol).» |
| 16 | §5 «Advert forms end with "Telegramda yozing"»; §7 stage 0 «settings he can already change» | Written as product; they are his (and his agency's) chores, and stage 1's effect depends on them. | A numbered step list sent to him today (A.6), and stage 1 makes the defaults ON so it does not depend on the list. |

---

## E. THE FIRST STAGE

**Would he feel stage 1 the next morning? Partly — and only if three things outside the code happen.**

What he would feel: no ✅ on a text-only greeting, question, standard fact, table price; replies at night; its own
name instead of «men Bekzod»; a morning message instead of cards.

What he would still be annoyed by, in the order he would meet it:

1. **A customer sends only a photo — silence. Only a voice note — nothing.** Stage 1 leaves `media_only`,
   `voice_only` and the `media` hold for stage 2. In cargo, product photos and voice notes open most conversations
   (unmeasured — the census has not run). To him this is the greeting bot, unchanged.
2. **«Mayli, jo'nataman» → the sale stops at him** for the code until stage 5 — the fifth stage. «O'zi sotuv qilsin»
   means closing; the page should not make him wait four stages for it.
3. **Avia address, rail, Andijan or any other city, Kashgar/Horgos** — still his cards (stage 4).
4. **Every «bilmayman» is still his card alone** (routing is stage 3); with no deputy the holding line has no end.
5. **A hidden-number customer asking «yukim qayerda»** — unproven chat, a card. On a new number that is most people.
6. **Whether the VED job goes at all** is a change of the prompt, and the model cannot be run in the build
   environment: the first live day is the test, in front of customers.
7. **Nine conversations a day.** A perfect stage 1 is nine messages he does not press.
8. If the stage-0 chores are not done (markup empty, «Tarif to'g'ri» unpressed, seat button, AI stages), the first
   price still waits and he will read it as «nothing changed».

Change the spec:

- **Stage 0 is done WITH him this week**, as the numbered list of A.6, before any build; and two read-only counts on
  his server: the stored verdicts re-judged under stage-1 rules (honesty D-12) and the share of customer bursts that
  carry a photo, file or voice note. The second number decides the cut of stage 1.
- **Cut stage 1 in two.** **1a (days): «to'siqlar olib tashlanadi»** — the deleted holds, the three kinds on by
  default, the name and the seller's role, his answer to Q2, and an HONEST reply to a media-only message («rasmni
  oldim; hozircha kub va kg ni yozib yuborsangiz, narxini aytaman» — or the photo/Excel/PDF reading itself, since the
  readers exist) so that nothing a customer sends is met with silence. **1b:** several messages per turn, the
  holding line, the supervisor and deputy, limits as dials, night, the liveness alarm. As written, stage 1 is sold
  as «mostly removing stops» (design-operations) and sized S-M (design-risk), but it carries the structural
  multi-message change that design-product placed in stage 3 because the sender must be rebuilt for it — the part he
  would feel is hostage to the part that is hard.
- **Bring the one-tap code forward**: «So'rab» for the GS code and the address-with-code message right after 1a.
  One tap from him closes a sale; today it is a card, a code typed by hand and an address pasted by hand.
- **The morning message is how he feels it.** It must say, in his words: «Kecha 14 javobdan 11 tasi o'zi ketdi.
  3 tasi sizni kutdi: 2 tasi rasm, 1 tasi kod so'radi.» Every held reply with its reason — that line shows him the
  road shrinking, and tells us which stage to build next.
- **One day on staff phones first** (operations ring 0) — not a proof gate, not his ✅: the first live look at a
  prompt nobody could run before.
