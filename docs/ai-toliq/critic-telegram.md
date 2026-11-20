# Critic — Telegram facts and ban risk (lens over SPEC-TOLIQ-v1.md §5, §9, §10, Q23-Q26)

Read: SPEC-TOLIQ-v1.md in full; design-risk.md §4-E, §6 Q16-20, §7; the Business/24-h lines of design-product.md and
design-operations.md; `docs/AI-SOTUVCHI.md` §3.1; `crm/message-flags.ts`. Nothing in `/home/user/fullprompt` was changed.

## 0. How the facts were checked

- **The web WAS reached.** The WebFetch tool could not resolve `core.telegram.org`, `telegram.org`,
  `developers.facebook.com` (outside that tool's allowed hosts), but the session's HTTPS proxy reached them with
  `curl`. Every quote below was read on **2026-11-19** from a downloaded copy kept in
  `(session scratch, not kept) fullai-tgweb/pages/` (`*.html` + `*.txt`).
- The Bot API page read is **Bot API 10.4, dated November 9, 2026**.
- NOT read (HTTP 400 to curl): `business.whatsapp.com/policy`, `whatsapp.com/legal/business-solution-terms`.
- «From memory» notes are labelled; nothing unlabelled below is from memory.

## 1. The ten claims

| # | Claim | Verdict |
|---|---|---|
| 1 | A bot connected to a (Business) account replies on its behalf via Bot API | **CONFIRMED** — introduced Bot API **7.2** (2024-03-31); rights object since **9.0** (2025-04-11) |
| 2 | «only in chats active in the last 24 h» | **CONFIRMED, but the spec's wording is the OLD one** — the rule is about INCOMING messages |
| 3 | Needs Telegram Premium on that number | **CONTRADICTED (outdated since May 2026)** — connecting a bot is free for every user |
| 4 | What the customer sees | **NOT VERIFIABLE from published pages**; evidence points to «the bot's NAME may show on each message» |
| 5 | Files, typing, read, delete, history | files/typing/read/delete/edit **CONFIRMED**; earlier history **no method exists**; no read receipts |
| 6 | Same account also logged in through gramjs | **CONFIRMED that no conflict is published**; interplay undocumented |
| 7 | Telegram's position on automating a user account | published: spam/flood → ban, unofficial clients «under observation», **and an explicit AI/data clause the spec never mentions** |
| 8 | A bot can never write first | **CONFIRMED** |
| 9 | Published bot limits | **CONFIRMED** (1 msg/s per chat, ~30/s bulk, 20/min per group) |
| 10 | WhatsApp 24-h window, templates, verification | window + templates **CONFIRMED**; verification is a scaling path, not an entry gate; **service messages are paid again since 2026-10-01** |

### 1. Business «chatbot» through the Bot API — CONFIRMED
- Changelog, Bot API 7.2, March 31, 2024: «Added the class BusinessConnection and updates about the connection or
  disconnection of the bot to a business account, represented by the field business_connection in the class
  Update.» … «Added the parameter business_connection_id to the methods sendMessage, sendPhoto, sendVideo,
  sendAnimation, sendAudio, sendDocument, sendSticker, sendVideoNote, sendVoice, sendLocation, sendVenue,
  sendContact, sendPoll, sendDice, sendGame, and sendMediaGroup.» «Added the parameter business_connection_id to the
  method sendChatAction.» — https://core.telegram.org/bots/api-changelog
- Bot API 9.0, April 11, 2025: «Added the class BusinessBotRights and replaced the field can_reply with the field
  rights of the type BusinessBotRights in the class BusinessConnection.» «Added the method readBusinessMessage…»
  «Added the method deleteBusinessMessages…» — same page.
- Rights that matter (https://core.telegram.org/bots/api#businessbotrights): `can_reply`, `can_read_messages`
  («can mark incoming private messages as read»), `can_delete_sent_messages`, `can_delete_all_messages`; the rest
  are profile, gifts, Stars, stories (never grant them).
- The BotFather switch is now called **Secretary Mode**; in the app the owner's screen is **Settings > Chat
  Automation** (https://core.telegram.org/bots/features#business-bots, https://telegram.org/faq).
- «Currently just one business bot may be connected to a user account.» —
  https://core.telegram.org/api/bots/connected-business-bots

### 2. The 24-hour rule — exact wording
- `BusinessBotRights.can_reply`: «True, if the bot can send and edit messages in the private chats that **had
  incoming messages in the last 24 hours**» — https://core.telegram.org/bots/api#businessbotrights
- `readBusinessMessage.chat_id`: «The chat must have been active in the last 24 hours.»
- Features page: «Some actions are limited to eligible private chats with recent incoming messages».
- Consequence the spec does not draw: the clock is the CUSTOMER'S last message. The bot's own message does not
  keep the window open (wording says incoming; the exact edge is a trial item).

### 3. Premium — CONTRADICTED (the spec, all three designs and `docs/AI-SOTUVCHI.md` §3.1 are out of date)
- Bot API 10.0, May 8, 2026: «Allowed Business Bots to manage user accounts without a Telegram Premium
  subscription.» — https://core.telegram.org/bots/api-changelog
- Blog, May 7, 2026: «With this update, every Telegram user can connect a bot to their profile — and allow it to
  respond to messages on their behalf.» … «To connect a bot to your profile, go to Settings > Chat Automation.» —
  https://telegram.org/blog/ai-bot-revolution-11-new-features
- «Connecting a business bot does not require Telegram Premium.» — https://core.telegram.org/api/bots/connected-business-bots
- FAQ: «Any user can connect a bot to their profile in Settings > Chat Automation. … Telegram Business users get
  more: their chatbots can manage messages, the profile, stories and the Star balance, with a separate permission
  for each action.» — https://telegram.org/faq. **Unclear from this sentence** whether mark-as-read / delete rights
  need Premium → trial item.
- Still Premium («Telegram Business»): opening hours, location, greeting/away messages, quick replies, business chat
  links — «All listed methods except account.resolveBusinessChatLink require a Telegram Business subscription
  (currently included in Telegram Premium subscriptions).» — https://core.telegram.org/api/business. So design-risk
  §4-E.4 «a Business profile on the seat (hours, location, greeting)» is the part that needs Premium, not the bot.

### 4. What the customer sees — NOT VERIFIABLE from published pages
- Published: `Message.sender_business_bot` — «The bot that actually sent the message on behalf of the business
  account. Available only for outgoing messages sent on behalf of the connected business account.»
  (https://core.telegram.org/bots/api#message); MTProto: «Messages sent by business bots on behalf of the user …
  will have the via_business_connection flag set, indicating that the message was sent by the business bot
  indicated in message.via_bot_id.» (connected-business-bots page); `message.via_business_bot_id` (constructor page).
  None says to WHOM the field is delivered.
- Telegram's own Privacy Policy tells users: «If you message a Business user who connected a chatbot to their
  account, depending on their settings, you may be effectively communicating with a bot» — https://telegram.org/privacy §6.5.1.
- Not a «page», but Telegram's official open-source desktop client: any message that carries `via_business_bot_id`
  is drawn with **the bot's name as its signature** (`msgsigned->author = msgsigned->viaBusinessBot->name()`,
  tdesktop `history/history_item.cpp`). And this project's own listener already assumes the OTHER side receives the
  flag (`crm/message-flags.ts wasAutoSent`: «an answer from their business bot carries via_business_bot_id»).
- **Plan for:** the customer MAY see the bot's name beside every bot-sent message until the trial shows otherwise.
- The OWNER sees: «a quick action bar at the top of each managed chat – tapping on "Manage Bot" will redirect them
  to your bot» (features page), with pause / disconnect per chat (https://core.telegram.org/api/action-bar).

### 5. What a business-connected bot can do
- Files/photos/voice/location/albums: CONFIRMED (7.2 list above). Send limit «up to 50 MB»; download limit: «bots
  can download files of up to 20MB in size» (`getFile`).
- Typing: CONFIRMED (`sendChatAction.business_connection_id`).
- Mark as read: CONFIRMED (`readBusinessMessage`, right `can_read_messages`, 24-h rule).
- Delete own message: CONFIRMED (`deleteBusinessMessages`, right `can_delete_sent_messages`; «A message can only be
  deleted if it was sent less than 48 hours ago»). Edit: inside `can_reply`.
- **Earlier history: no method.** The published list of what a bot may invoke over a connection is
  deleteMessages, editMessage, readHistory (= mark read), sendMedia, sendMessage, sendMultiMedia, setTyping,
  updatePinnedMessage + profile/gift/Stars/story methods — no history fetch
  (https://core.telegram.org/api/bots/connected-business-bots). The Privacy Policy's «access to all messages, media
  and files contained in the private chats you allow it to manage» (§6.5.2) is broader than the API.
- **No read receipts:** the Bot API `Update` has no «customer read it» type (fields list on /bots/api#update).
- Not supported on behalf of a business account: reply keyboards, web_app buttons, cross-chat replies (stated in
  the field descriptions). Inline/URL buttons work.
- Whether the bot is delivered the OWNER'S hand-typed outgoing messages is not stated («New message from a
  connected business account») → trial item (it decides how 🙋 take-over is detected).

### 6. Same account in gramjs at the same time — no published conflict
- «You can log in to Telegram from as many of your devices as you like — all at the same time.» — https://telegram.org/faq
- But: «Due to excessive abuse of the Telegram API, all accounts that log in using unofficial Telegram API clients
  are automatically put under observation to avoid violations of the Terms of Service.» —
  https://core.telegram.org/api/obtaining_api_id. As long as the listener stays logged in (and it must, see §2
  below), the seat stays in that class whatever carries the replies.

### 7. Telegram's stated position on automating a user account
- ToS: «agree not to: Use our service to send spam or scam users.» — https://telegram.org/tos
- «If you use the Telegram API for flooding, spamming, faking subscriber and view counters of channels, you will be
  banned forever.» … «If you didn't violate the Terms of Service but your account does get banned after using the
  API, write to recover@telegram.org» — https://core.telegram.org/api/obtaining_api_id
- API ToS 1.4: forbidden to interfere with basic functionality: «making actions on behalf of the user without the
  user's knowledge and consent, … tampering with the 'read' statuses of messages …, preventing typing statuses from
  being sent/displayed» — https://core.telegram.org/api/terms
- **API ToS 1.5 (missing from the spec):** «you are prohibited from using, accessing or aggregating data obtained
  from the Telegram platform to train, fine-tune or otherwise engage in the development, enhancement or deployment
  of artificial intelligence, machine learning models and similar technologies.»
- **Content Licensing terms:** «Telegram firmly prohibits the scraping, indexing, harvesting, aggregation or use of
  data obtained from its platform to train, fine-tune, validate or otherwise engage in the development, enhancement,
  benchmarking or deployment of artificial intelligence…» with the «limited exception … data required to launch and
  operate a legitimate third-party Telegram Client, Telegram Bot, or Telegram Mini App» —
  https://telegram.org/tos/content-licensing. The same Telegram pages advertise connected bots to «add AI assistants
  that manage their chats» (https://core.telegram.org/api/business#connected-bots).
- What gets an account limited (https://telegram.org/faq_spam): «When users press the 'Report spam' button in a
  chat, they forward these messages to our team of moderators for review. If the moderators decide that the messages
  deserved this, the account becomes limited temporarily.» · «Limited accounts can send messages to people who have
  their number saved as a contact. **You can also always reply to anyone who messages you first.**» · «it really
  doesn't matter what you send, as long as the receivers find it unwelcome … above all, anything related to
  commerce» · «first time … limited for a few days or so. … Repeated offences will result in longer periods … you may
  lose the ability to do so forever.» · wrongly limited → «contact our @SpamBot» · «Some numbers may trigger an
  overly harsh response from our system, either due to their previous owners' activities or due to them being
  certain virtual/VOIP numbers.»
- FAQ: «If your account has been restricted because of reports from other users, your account is frozen. While
  frozen, you can still read your chats, but you cannot send messages or post content. You can appeal the
  restriction directly from the app.»
- First-contact screen: «When someone outside your contacts writes to you for the first time, Telegram shows an
  info page about them — their country, when they joined Telegram and any groups you share … You can block and
  report them from the same screen.» (FAQ; `peerSettings.registration_month`, `phone_country`, `name_change_date`,
  `photo_change_date`.)
- The word «userbot» is on none of these pages: nothing published permits or forbids automating one's own account
  as such. No numeric limits for user accounts are published (only `FLOOD_WAIT_X`,
  https://core.telegram.org/api/errors) — the spec is right that every number is our own fuse. design-risk's
  «younger numbers on a third-party client are limited sooner» is NOT published in that form (label it experience).

### 8. A bot never writes first — CONFIRMED
«Bots can't start conversations with users. A user must either add them to a group or send them a message first.» —
https://core.telegram.org/bots («How Are Bots Different from Users?»). For a business connection the same follows
from `can_reply` (only chats with an incoming message in the last 24 h).

### 9. Bot limits — CONFIRMED (https://core.telegram.org/bots/faq#my-bot-is-hitting-limits-how-do-i-avoid-this)
«In a single chat, avoid sending more than one message per second.» · «In a group, bots are not be able to send
more than 20 messages per minute.» · «For bulk notifications, bots are not able to broadcast more than about 30
messages per second, unless they enable paid broadcasts» (needs 100,000 Stars and 100,000 monthly users — not us).
The company's volume is far below all three. The limits that bite the company bot are not numeric:
Bot Developer ToS 5.2(b) «Your TPA must not harass or spam users with unsolicited messages»; breach → «may terminate
your TPA, your account, or both» (https://telegram.org/tos/bot-developers); and the user's own remedy — «If you
don't want a bot to send you messages, feel free to block it» (FAQ). Nothing is published about limits specific to
business connections (design-risk §4-E.3 «It gives published limits» is unsupported).

### 10. WhatsApp Cloud API (developers.facebook.com/documentation/business-messaging/whatsapp/…)
- Window: «When a WhatsApp user messages you or calls you, a 24-hour timer called a customer service window starts.
  If the user messages or calls you again before the timer expires, the timer resets to 24 hours. Businesses can
  only send non-template messages to users when this window is open. If it is not open, businesses can only send
  template messages to reach out to users.» (/pricing, /messages/send-messages) — CONFIRMED.
- «Template messages are the only type of message that can be sent to WhatsApp users outside of a customer service
  window.» Review «can take up to 24 hours». (/templates/overview) — CONFIRMED.
- Opt-in: «Businesses are required to obtain opt-in before messaging people on WhatsApp.» (/getting-opt-in)
- Verification is NOT an entry gate: «Newly created business portfolios have a messaging limit of 250» (unique
  users per moving 24 h outside the window); raised to 2,000 by «Verify your business» or by volume + quality
  (/messaging-limits). design-product's «Meta business verification» as a dependency is overstated.
- **New, and absent from the spec:** «Meta resumed charging, on a per-message basis, for … Service messages» as of
  October 1, 2026, with «a free tier of 1,000 service messages per month» per number (/pricing). An AI that answers
  in 2-3 messages a turn passes 1,000 quickly.
- General-purpose AI assistants are restricted for «AI Providers» (/pricing/ai-providers); a company answering its
  own customers is the ordinary case — but the Business Solution Terms themselves were NOT read.

## 2. What is wrong in the spec (each with the change)

**B1 (blocker for §5's ruling). The Business carrier moves only the SAFEST traffic and none of the risky.**
It can carry a reply only while the customer's last message is < 24 h old. Everything the spec calls initiative —
Q23 follow-ups (by definition > 24 h after the last incoming), journey news, payment reminders, waiting-cargo
reminders, re-activation, greetings — and also the most valuable reply, the VED price that arrives the next day
(as-built `calcAnswerMaxAgeMs` = 7 days), and the widened reply window (design-risk: 24 h → 7 days) **cannot** go
through it. Replying the same day to someone who wrote first is already what Telegram's own FAQ says a limited
account may always do. → Change §5 bullet 2 from «the official reply carrier» to «an optional add-on for same-day
replies; the session stays for good»; delete «Channel hardening comes BEFORE volume proactive messaging» (it
implies hardening covers proactive — it does not) and replace with «proactive volume grows only as fast as the
share of customers linked to the company bot».

**B2. A customer who wrote yesterday.** With the Business carrier adopted, a per-message ROUTER is mandatory and is
missing from §4/§7: window open (with margin, e.g. ≤ 23 h) → bot; closed → session with its fuses; a send refused
at the edge → session, never dropped. And one rule against a silent bypass: if the owner PAUSED/disconnected the
bot in a chat from Telegram's own action bar, the system must NOT fall back to the session — that pause is a
take-over (🙋). → Add both to §4 «sender» and to stage 7.

**B3. The session can never be retired — say it.** The bot has no history method, no read receipts, no first
message. The 100-message context, «withdraw an UNREAD message» (wall 5), catch-up after downtime and every late
reply need the gramjs listener. So the seat stays «logged in through an unofficial client → under observation».
→ §5 and §9 must state this; stage 7's «owner stops fearing one restriction stops sales» is over-promised —
rewrite as «same-day replies no longer leave from the unofficial client».

**B4. Premium is no longer needed (free since May 2026).** → Fix §5, Q26, design-risk Q16, design-product Q25,
`docs/AI-SOTUVCHI.md` §3.1 («Premium bo'lishi shart»). Consequence for the plan: the TRIAL costs nothing — move it
from §10/stage 7 to **stage 0** (one hour, a spare number, a throwaway bot), because Q1/Q2 (whose name, «botmisiz?»)
depend on what the customer sees (B5).

**B5. The bot's name may be visible to the customer — this couples Q26 to Q1/Q2.** If the trial shows a signature,
the persona «GSR sotuv menejeri <ism>» is contradicted on every message by a bot name, and connecting the COMPANY
cabinet bot (the old §3.1 recommendation) would sign every reply with the cabinet bot's name. → Ask Q26 before
Q1/Q2 are final, or add to Q26: «if the customer sees a bot name — still yes?».

**B6. Published-terms risk is missing from §9 (not the same thing as spam-report risk).** API ToS 1.5 and the
Content Licensing terms name «deployment», «validate», «benchmarking» of AI on data obtained from the platform.
Three places in the spec are touched: the as-built session road itself (data through the API into a model), the
§6 «replay of real chats», «exam set», «test corpus» (literally «validate / benchmarking»), and speech-to-text /
LLM as third parties (Bot Developer ToS 5.4(iv) for a Business bot: «never disclose message contents … to third
parties (including third-party APIs) without the user's authorization»). Enforcement against a small company is
unknown; the text is not. → Add a risk row; note that the connected-bot road is the one Telegram itself describes
for «AI assistants that manage their chats»; keep replay data on the company's own server and say so; the bots
need a privacy policy set in @BotFather (ToS §4: «all TPA must be bound by a privacy policy that is easily
accessible to their users»; Telegram's Standard Policy applies by default and may not fit an AI that sends chats to
outside services).

**B7. «The company bot: no ban risk at all» (design-risk §4-E.3, Q17; spec §5 bullet 3) is overstated.** It has no
report-driven limit like a user account, but it is bound by ToS 5.2(b), and the real cost is the customer's own
block: a customer who blocks the bot over a promotional message also stops receiving «yukingiz keldi». → Reword;
promotional messages through the bot: rare, per-campaign approval, and a «🔕 Bunday xabarlar kerak emas» button so
the customer can refuse offers WITHOUT blocking the bot.

**B8. Q24's ⭐ is nearly empty and partly cold.** The AI number is weeks old: almost no «quiet customer 60+ days»
ever wrote to IT — they wrote to the owner's or a seller's number. For Telegram a message from the seat to them is
a stranger's first message with commerce in it: the exact case of the Spam FAQ, shown with the «joined Telegram
<month>» info page and a report button. → Re-word Q24 (below); the same in §1 «Repeat» row and Part 3's Friday
greeting.

**B9. Linking to the company bot only «at closing» leaves follow-ups with no official road.** Follow-ups are for
leads who did NOT close — they are never linked. → Add a lead-level link EARLIER: the first quote / PDF offer is
handed over through the bot («narx taklifini botda oling» deep link). Then Q23's follow-up has a carrier with no
24-h rule and no account at stake. Design work (the cabinet links CLIENTS by phone today), but it is the only
official write-first road Telegram offers.

**B10. §9's first risk row treats three different states as one.** Limited (spam reports): cannot write first,
**replies to people who wrote keep working** — a reply-only AI is barely touched. Frozen: read-only, appeal «directly
from the app». Banned: number lost, recover@telegram.org. → Rewrite the row with the three states and what the AI
does in each; today's «all sending off» on any restriction is safe but should say that replies may resume after
his «Tekshirdim» when the state is «limited».

**B11. The appeal needs the phone.** A frozen account is appealed from the official app. → Add to §5 hygiene: who
physically holds the AI number's SIM and a phone with the official Telegram app logged in; a real SIM, never a
virtual number (Spam FAQ quote on VOIP numbers) — the same for the reserve.

**B12. The reserve number is over-sold** (design-risk Q20: «A ban then costs an hour, not a week»). Customers hold
the OLD number; the new one cannot write to them first (that is cold outreach from a fresh account — the riskiest
act there is); a number logged into gramjs on takeover day is «under observation» from minute one. → Keep the
reserve, but describe it as continuity of the line: the new number is announced through the company bot, the
website button and the sellers; no promise of «an hour». Telegram publishes nothing on a second number after a
ban for users; for bots ToS 5.2(f) forbids operating «by proxy … to circumvent bans» — do not present the reserve
to him as a way to continue what got the first one limited.

**B13. Failure domains.** One bot per account; breach of the Business terms «may lead to the immediate and
permanent ban of your TPA and your account» (ToS 5.4). → If the Business road is taken: a SEPARATE bot, never the
company cabinet bot (reverses `docs/AI-SOTUVCHI.md` §3.1's recommendation); record which Telegram account owns the
bots in @BotFather — never the AI seat (inference from the quoted clause, labelled as such).

**B14. Rows of §1 with no carrier.** «relays bot news to unlinked customers» (Journey), «dated reminders»
(Payment), «5/10-day waiting reminders» (Handover — today these go to the SELLER, never the customer, 0116),
«keyingi yuk?» (Repeat) are all write-first. For a customer who never wrote to the seat they contradict the
spec's own never-list («write first to someone who never wrote to this number»). → Each row names its carrier:
company bot if linked · AI number only inside a chat the customer opened with it · otherwise a task for a person.

**B15. Stage 1 raises session volume before anything else changes.** 12 → 40 per chat, 2-3 messages per turn,
night replies, and «caps counted per conversation turn» (design-risk 4-E) turns 80 a day into up to ~240 messages
from a young number. Nothing published says where the line is. → Keep the day cap and the 14-day ramp counted in
MESSAGES for the first month; state the ceiling in messages in §7 stage 1.

**B16. Small, concrete.** (a) Proactive sends must treat «this user accepts messages only from contacts/Premium»
and «asks for Stars» as «cannot write → person's task»; never pay Stars automatically (FAQ: Star Messages).
(b) The company bot's `allowed_updates` is an explicit list today — a business bot needs `business_connection`,
`business_message`, `edited_business_message`, `deleted_business_messages` added. (c) The connection id changes
when the owner edits the connection («a new updateBotBusinessConnect update will be emitted with the new
connection_id») — store it per update. (d) Do NOT switch on Telegram's own greeting/away messages on the seat:
they would double the AI's reply. (e) §7 stage 10 «WhatsApp»: add «service messages are charged since 2026-10-01
(1,000 free a month per number), opt-in required, 250 new users a day outside the window until verified».

## 3. Corrected §5 (proposed text)

- **The AI number's own session** — the only road that can do everything (late replies, history, read marks) and
  the only one punished at the ACCOUNT. It stays for good. It replies to people who wrote first; it writes first
  only inside a chat the customer once opened with THIS number, in small counts; never cold.
- **Chat Automation (the former Business chatbot) on the same number — an optional add-on, not a replacement.**
  Free since May 2026. The bot may send only in chats «that had incoming messages in the last 24 hours»: same-day
  replies only; never a first message, a follow-up, or a price that arrives the next day. No history, no read
  receipts. The customer may see the bot's name on each message. Decided after a one-hour trial in stage 0. If
  taken: a separate bot; a router per message; a Telegram-side pause is a take-over, never bypassed.
- **The company bot** — the only road with no window: it may write at any time to people who pressed Start and
  have not blocked it. Operational messages first; offers rare, approved per campaign, with an opt-out button.
  The AI also answers people who write to the bot. Leads are offered the bot at the FIRST QUOTE, clients at closing.
- **Nobody of the above** → a task for a person. The AI number never writes to someone who never wrote to it.
- **Reserve number** — a real SIM, registered and kept alive on an official app; continuity of the line, announced
  through the bot, the site and the sellers.
- **Measured before stage 8:** the share of active customers with a linked bot chat, and how many chats the AI
  number itself holds. Proactive volume follows those two numbers.

## 4. Corrected owner questions

**Q26 (carrier) — ask it in section A, before Q1/Q2.**
«AI javoblari qaysi yo'ldan ketadi? Uchta fakt: (1) bugun — AI raqamining o'z seansi: hamma narsani qila oladi,
lekin Telegram aynan shu yo'lni kuzatadi; (2) Telegramning rasmiy "Chat Automation" yo'li (may 2026 dan bepul,
Premium kerak emas): bot AI raqami nomidan javob beradi, LEKIN faqat mijoz oxirgi 24 soat ichida yozgan chatda —
birinchi bo'lib yoza olmaydi, ertasi kuni keladigan VED narxini ham, eslatmani ham olib bora olmaydi; mijozga har
bir xabarda bot nomi ko'rinishi mumkin; (3) demak u faqat QO'SHIMCHA: o'sha kungi javoblar rasmiy yo'ldan, qolgan
hammasi baribir seansdan yoki kompaniya botidan.»
a) faqat seans, bugungidek · ⭐ b) hozir, bepul, zaxira raqamda 1 soatlik sinov: mijoz telefonida nima ko'rinishini
ko'ramiz, keyin qaror · c) kerak emas.
Follow-up inside b): «Sinovda mijozga bot nomi ko'rinsa — baribir xo'pmi?» a) ha (unda AI ochiq "yordamchi" bo'ladi,
1-savolga bog'liq) · ⭐ b) yo'q, unda seansda qolamiz.

**Q23 (follow-up on an unanswered quote).**
«Narx aytilgan mijoz jim qolsa, AI o'zi yozsinmi? Bilib qo'ying: bu — AI birinchi bo'lib yozishi. Rasmiy yo'l buni
olib bora olmaydi; xabar AI raqamining o'zidan ketadi (har biri mijozga "Spam" bosish imkonini beradi) yoki mijoz
kompaniya botini ishga tushirgan bo'lsa — botdan.»
⭐ a) ikki marta: ertasi ish kuni va 5-7-kuni, keyin butunlay to'xtaydi; faqat kunduzi; kuniga jami 10 tadan
oshmaydi; "yozmang" desa — hech qachon; bitta blok/shikoyat bo'lsa hammaga to'xtaydi; narx taklifi botda
olingan bo'lsa — eslatma botdan ketadi · b) bir marta · c) yozmaydi, sotuvchiga vazifa.
(Was: 1 / 3 / 7 days as ⭐. Three unanswered messages in a row triple the report exposure; add the third touch
after a month with zero blocks.)

**Q24 (quiet customers 60+ days, greetings).**
«Eski mijozlarga AI yozsinmi? Bilib qo'ying: AI raqami yangi — eski mijozlarning deyarli hech biri unga
yozmagan; Telegram uchun bu notanish raqamdan kelgan savdo xabari, raqamlar aynan shuning uchun cheklanadi.
Kompaniya botidan yozish mumkin, lekin mijoz botni bloklasa "yukingiz keldi" xabarlari ham bormay qoladi.»
⭐ a) faqat kompaniya boti orqali, botga ulangan mijozlarga, oyiga 1 martadan ko'p emas, har kampaniyani siz bir
marta tasdiqlaysiz, xabarda "🔕 kerak emas" tugmasi; botga ulanmaganlar — o'z sotuvchisiga ro'yxat; AI raqami
faqat o'ziga oldin yozgan mijozning chatida (90 kun ichida) yozadi · b) a + AI raqami o'zining 90 kundan eski
chatlariga ham (xavfliroq) · c) faqat sotuvchilarga ro'yxat.

**Q25 (payment).**
«To'lovni AI eslatsinmi?» ⭐ a) yuk tayyor bo'lganda summa + 3- va 7-kuni eslatma — botga ulangan mijozga
kompaniya botidan; AI raqamidan faqat mijoz o'zi yozib turgan chatda; ikkalasi ham bo'lmasa — buxgalter/sotuvchiga
vazifa; chek → buxgalter navbati · b) bir marta · c) faqat buxgalter.

**New questions the lens needs:**
- N1. «Narx taklifini (PDF) mijoz kompaniya botidan olsinmi?» ⭐ a) ha — shunda keyingi eslatmalar rasmiy yo'ldan
  ketadi · b) yo'q, AI raqamidan.
- N2. «AI raqamining SIM kartasi va rasmiy Telegram ilovasi kirgan telefon kimda turadi?» (cheklov bo'lsa shikoyat
  faqat shu ilovadan yuboriladi).
- N3. Q28 re-worded: «Zaxira raqam: haqiqiy SIM, oldindan ochilgan. U cheklovdan keyin "bir soatda davom etish"
  emas — yangi raqamni mijozlar bot, sayt va sotuvchilar orqali biladi.» ⭐ a) ha · b) yo'q.

## 5. Corrected risk rows (§9)

| Risk | What is published | What limits it | What remains |
|---|---|---|---|
| The AI number is LIMITED after «Spam» reports | Limited accounts «can also always reply to anyone who messages you first»; first time «a few days», repeated — longer, up to for ever | never cold; write-first small and only in the customer's own chat with this number; first block stops write-first for all | write-first from this number is lost for the period; replies continue |
| The AI number is FROZEN or BANNED | Frozen = read-only, appeal from the app; API misuse = «banned forever»; unofficial clients «under observation»; no thresholds published | the fuses; the phone and SIM at hand for the appeal; the company bot and the sellers as the other roads; a reserve line | cannot be excluded; customers must learn another number through the bot/site/people |
| Telegram's terms on AI and platform data | API ToS 1.5; Content Licensing terms («deployment», «validate», «benchmarking») | the connected-bot road is the one Telegram describes for AI assistants; data kept on the company's server; privacy policy on the bots | the session road and the replay lab stand on the weakest ground in the text; enforcement unknown |
| Customers block the company bot | «feel free to block it»; ToS 5.2(b) unsolicited messages | offers rare, approved, with an opt-out button | a blocked bot also stops «yukingiz keldi» for that customer |
| The bot's name is visible on AI replies (Business road) | not stated; the official desktop client draws it when the flag is present | the trial; a neutral bot name; honest persona (Q1) | if visible, «a named employee» and «via bot» cannot both be true |

## 6. The trial (replaces the first line of §10; stage 0, free, about an hour)

Spare real SIM (not the AI seat first), a throwaway bot with Secretary Mode, a second phone as a customer who is
NOT a contact. Record with screenshots:
1. Customer's view of a bot-sent message on Android, iOS, Desktop: any name, signature, label; anything on the profile.
2. Owner's view: the action bar, the signature.
3. gramjs on the same account: does it receive the bot-sent message, with `viaBusinessBotId`, and is its id the
   Bot API `message_id` (echo identity — the as-built echo fence depends on it).
4. Is the bot delivered the owner's hand-typed messages (take-over detection)?
5. The 24-h edge: send at 23 h 59 and 24 h 01 after the customer's last message; the exact error; does the bot's
   own message extend the window (expected: no).
6. Which rights the «Chat Automation» screen offers WITHOUT Premium (reply / mark read / delete).
7. Pause in one chat from the action bar: what the bot gets, what gramjs sees (`peerSettings.business_bot_paused`).
8. «yozmoqda» and read ticks through the bot, as the customer sees them.
9. Files: customer sends a 15 MB PDF and a voice note (download ≤ 20 MB); the bot sends a PDF.
10. Editing the connection changes the connection id.

## 7. Not verified — say so to the owner

What the customer sees (4) · whether the bot's own message extends the window · read/delete rights without Premium ·
any numeric limit for user accounts or for business connections (none is published) · whether Telegram treats a
re-activation message into an OLD chat differently from a first message (the Spam FAQ speaks only of who «messages
you first») · WhatsApp's Business Messaging Policy and Solution Terms (pages refused the fetch).
