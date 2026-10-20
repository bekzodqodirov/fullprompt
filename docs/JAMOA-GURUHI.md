# Jamoa guruhi — tabriklar va shanba reytingi

Agreed 2026-10-20. Migration **0134** `staff_group` — the ledger must reach **135**.

## His words

> telegram botni gurux chat groupga qoshsa tgda. client code ochilganda cklient code ochgan odamni qutlab
> hammani oldida maqtaydigan gift jonatish kerak telgam gruppada yokida lead yutilganda. va hafta ohirida har
> shanba soat 18:00 da hodimlar reytingi korsatilishi kerak kim necha kub necha kg yuk olib kelgani. systemada
> gemification qoyishimiza kk. haftalik raytinglar kim kop yuk olib kelishga undashimiz kerak.

His answers to the ten questions: **«3. 2 3 gif yuklab qoyaylik zerkarli bolmasin tabriklash ham / qolgani sen
aytkandek bolsin»**. So 3 = several uploaded GIFs that take turns, AND the congratulation sentences rotate too.
Every other question is its ⭐:

| # | Question | Answer |
|---|---|---|
| 1 | What is celebrated | a ⭐ all three: a client code minted, a lead won, a new client's FIRST prixod |
| 2 | Client code in the post | a ⭐ yes, the code only (never the name, the phone or money) |
| 3 | The «gift» | **2–3 uploaded GIFs in rotation + rotating sentences** |
| 4 | The rating's window | a ⭐ Saturday 18:00 → Saturday 18:00 (seven days exactly) |
| 5 | Ranked by | a ⭐ kub (the KPI's unit), kg beside |
| 6 | Who is listed | a ⭐ everyone who brought cargo, in order; the rest only as a count |
| 7 | Admins in the rating | a ⭐ yes, by the stamp, like the KPI |
| 8 | Team weekly goal | a ⭐ yes, typed on the panel |
| 9 | Month champion | a ⭐ yes, on the 8th (the KPI month's close) |
| 10 | Warehouse staff rating | a ⭐ not now |

Also from the proposal, agreed with «qolgani sen aytkandek»: the /reyting screen and the bot's «/reyting».

## What it is

- **The group is a ROW** (`staff_group_chats`, the one with `active_from`), never a setting — the price
  channel's reason (0128): /admin/settings would be a door around the adoption rule.
- **Adoption** (`decideGroupAdoption`): the owner (a linked colleague with `admin.settings.manage`) adds the bot
  to a group → it becomes THE group. A colleague's group is recorded and offered on the panel. A stranger's
  group writes nothing. A known group hears every later change (a kick clears it). A group that becomes a
  supergroup is followed — by the migration message or by a send refused with the new id.
- **The bot never reads the group.** `registerStaffGroup` sits right after the price channel and before every
  command; after its two membership handlers a swallow ends every other update from a group or supergroup.
  This also closes a hazard that existed before the round: `/start` in a group would have posted the entry
  keyboard into it, and `/start <code>` would have linked the GROUP as a staff chat.
- **One claim per thing said** (`staff_group_posts.dedupe_key`): `client:<id>`, `won:<lead>`,
  `first_cargo:<client>`, `rating:<saturday>`, `champion:<YYYY-MM>`. With no group connected the claim is
  written `skipped/no_group`, so connecting later floods nothing. The drain is a pg-boss job (kicked at once,
  swept every minute); an answer that may already have published (timeout, reset, 502/504) is `failed` and
  only a person's «Qayta yuborish» re-sends it (#48's rule).
- **The GIFs** are ordinary `attachments` of type `staff_group_media` under one fixed id (so the off-site copy
  covers them), uploaded on the panel by the settings admin only, played with `sendAnimation` (GIF/MP4) or
  `sendPhoto`. The least recently shown goes next (`staff_group_media.last_used_at`); Telegram's file id is
  cached, typed by the method. A refused picture sends the words alone.
- **The sentences** rotate by the number of posts of that kind so far (five for a code, five for a win, four
  for a first cargo), so two in a row never read the same.
- **Who is praised**: the minter for a code (his «client code ochgan odamni»), the lead's owner for a win, the
  receipt's seller stamp for a first cargo. A tappable mention only when the person has a linked staff chat
  (Telegram shows `tg://user?id=` only for someone who contacted the bot); else the name in bold.
- **Where they are heard**: the code at the two APP doors only (beside round 111's deal, never in
  `createClient` — the import would post 1,700 times, and `winLead` mints a client that is celebrated as the
  WIN); the win from `LeadStageChanged` (every stage door announces it); the first cargo from
  `ReceiptConfirmed`. Both events through the event drain's dynamic-import slot, fenced.
- **The rating** reads the KPI's own `stampedCargo` (receipt stamp, carton grain, `received_at`) — no second
  aggregate, so the post, /reyting, /hodimlar and the profile cannot disagree. Window = the latest Saturday
  18:00 in Tashkent and seven days back; Saturday 18:00 sharp belongs to the NEXT week. Ranked kub → kg → name;
  equal kub and kg share a place. The post: the podium with mentions, the rest by name (20 at most, then a
  count), each person's ▲▼ against their own previous week, the team total against last week, the team goal
  with a bar, 🔥 streaks (two or more consecutive POSTED first places), ⭐ personal records (after two posted
  weeks), the unstamped cargo and the count of sellers with nothing. No money anywhere. The standings it posted
  are stored on the row, so streaks and records read what people SAW.
- **The champion** posts the previous Tashkent month on the 8th at 18:00 — the day the KPI month closes.
- **Crons** (UTC): `'0 13 * * 6'` and `'0 13 8 * *'`. Night posts (22:00–08:00) arrive silently.
- **Screens**: `/admin/jamoa-guruhi` (admin.settings.manage; hub door) and `/reyting` (any login; the profile's
  door). Bot: `/reyting` (own place + podium, private chat only).

## Stated, not built

- A prixod's cargo claimed later (an unclaimed marking given its client) is not a «first cargo» event.
- A post is not edited after the fact: a back-dated prixod can move the screen's numbers after Saturday; the
  post says «18:00 holati».
- Group privacy mode (BotFather) is irrelevant by construction — the bot reads nothing there.
- Real Telegram gifts (Stars) — offered as a later option.
- A warehouse-staff rating — his 10a «not now».
