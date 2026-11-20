# Critic — speech-to-text for voice notes (lens: STT) · on SPEC-TOLIQ-v1.md

Date 2026-11-19. Read-only review; nothing in the repo touched.

**How far to trust the numbers below.** Web SEARCH worked; direct page FETCH did not — `platform.openai.com`,
`elevenlabs.io` and `docs.cloud.google.com` are outside this session's allowed network, so no provider page was opened
by me. Every price and language claim is taken from search-result extracts (a mix of official-page snippets and
third-party aggregators). Each cell is marked **[o]** official-page snippet · **[3]** third-party / vendor marketing ·
**[m]** from memory, unverified. Nobody — no vendor, no paper — publishes a number for the thing that matters here:
spontaneous Uzbek + Russian MIXED speech in phone-quality voice notes. Only the trial on his own notes answers that.

---

## 1. Verdict in six lines

1. The spec PROMISES hearing («hears voice notes», §1 Qualification, column «AI alone») before anything is known. It
   must read «hears IF the trial passes; until then and on any failure: asks to type + a card».
2. The cost claim is wrong in both directions: transcription is ~0.2-0.8 cent per 30-s note (not «a cent a note»), and
   the real cost of a voice note is the extra AI reply the read-back needs (1.5-4 cents by the spec's own figure).
3. «A heard figure is repeated back and confirmed before it prices anything» is the right rule and is NOT ENOUGH, and
   as written it has no mechanical home: in today's code a transcript pasted into the message text would make every
   heard figure a «customer-stated» figure and price at once (`agent/tools.ts stated()`, `numbers.ts customerSources`).
4. Vanilla Whisper-family engines are bad at Uzbek (unusable self-hosted; OpenAI's own docs do not list Uzbek).
   The realistic candidates are ElevenLabs Scribe, an Uzbekistan-made service (Aisha / Muxlisa), and Google or Yandex.
5. Self-hosting on the 4 vCPU / 8 GB box is rejected: too slow, wrong quality for mixed speech, and it takes the CPU
   of the ONE Node process that is already the system's ceiling.
6. Q16 hides two owner decisions inside one option: permission to send real customers' voices to several companies
   for a trial, and the fallback rule. It must be split (wording in §8).

---

## 2. Comparison table

Price column: per minute, and what ONE 30-second note costs. «Ogg» = accepts Telegram's Ogg/Opus as-is (the image has
no ffmpeg — `map-senses.md` §4 — so a provider that needs transcoding costs a Dockerfile change).

| Service | Uzbek? | Uzbek+Russian in one note | Ogg/Opus direct | $/min → 30-s note | Where the audio goes | Key from Uzbekistan | Verdict |
|---|---|---|---|---|---|---|---|
| **ElevenLabs Scribe v2** | **Yes** — own Uzbek page; 90+ languages [o]. Vendor WER on read speech: 15.9 % FLEURS / 16.6 % CV (Scribe v1 page) and 3.1 % / 5.5 % (newer page, model unnamed) [3] | Auto-detect; API lets you name other languages expected in the audio («mixed-language audio») [o] — the parameter `secondary_language_codes` is listed for `scribe_v3`, so the trial uses whichever current model takes it; keyterm list (+20 % price) [3] | «all major audio and video formats» [o] | $0.22/h = **$0.0037/min → $0.0018** (as of 2026-10-18; older pages $0.40/h) [3] | US by default; an EU-residency endpoint exists; zero-retention only for enterprise [o/3] | self-serve, card [m] | **TRIAL #1** |
| **Aisha** (aisha.group, UZ) | **Yes**, Uzbek-first; uz / ru / en [o] | Marketed for «conversations that mix Uzbek, Russian and English» — a claim, no benchmark [3] | not seen (docs page not reachable) | **not published**; credit balance, free starter credits [o] | presumably Uzbekistan [m] | self-serve key at space.aisha.group; local payment likely [m] | **TRIAL #2** |
| **Muxlisa AI** (UZINFOCOM, UZ) | **Yes**; updated model 24.04.2026: WER 11.39 % call-centre telephony, 13.42 % YouTube on «an independent benchmark», real audio [o-vendor] | not stated | not seen | **not published** (one page: «per deal») [3] | Uzbekistan (state-owned operator) [m] | contract / request; reachability from a German IP to be checked [m] | **TRIAL #2b** (with Aisha if a key comes in the same week) |
| **OpenAI** (`gpt-transcribe`; `whisper-1`, `gpt-4o-transcribe`, `-mini` are listed for REMOVAL on 2027-02-26 [o]) | **Unclear / probably weak.** The guide points to Whisper's language list; Uzbek is not on the documented «good» list [3/m]; vendor table: Whisper large-v3 96.7 % WER on Uzbek FLEURS [3]; no Uzbek figure for the gpt-4o family | one language per file, auto-detected; a `prompt` can bias vocabulary [m] | **yes** — flac mp3 mp4 mpeg mpga m4a **ogg** wav webm [o]; send the file NAMED `.ogg`, not `.oga` (our stored name is `voice_<id>.oga`) [m] | whisper-1 $0.006; mini ≈ $0.003; gpt-transcribe ≈ **$0.0045/min → $0.002-0.003** [3] | US | Uzbekistan is on the supported-countries list [o]; prepaid by card | **TRIAL #3** as the cheap baseline; expect it to lose on Uzbek |
| **Google Chirp 3** (Cloud STT v2) | **Yes, uz-UZ — PREVIEW** [o] | picks ONE language (pinned, or «auto» = the most prevalent) [o] → the other language's stretch comes out wrong | OGG_OPUS supported [m] | **$0.016/min → $0.008** [o for V2 standard; Chirp-3-specific not confirmed] | region `us` only for Chirp 3 [o] | GCP project + billing + service-account file — heavy for a non-developer [m] | reserve #1 |
| **Gemini** (audio into an LLM) | no speech benchmark; best LLM for Uzbek text per one leaderboard [3]; vendor table: Gemini Flash 2 32 % WER Uzbek FLEURS (old model) [3] | promptable («keep Russian in Cyrillic, digits for numbers») — and can paraphrase, loop or stop early (forum reports) [3] | yes [m] | ≈ $0.001-0.002/min (estimate from token rates) [3/m] | Google | AI-Studio key, easy [m] | optional 4th rider in the trial |
| **Yandex SpeechKit** | **Yes, uz-UZ (Latin) since 2023**, updated 2025 [o] | not stated; Russian is its strongest language [m] | **OggOpus native** [m] | $0.001333 per 15 s ≈ **$0.0053/min → $0.0027**; billed in 15-s blocks, rounded UP [o] | Russia (Kazakhstan region exists; SpeechKit there unverified) | regions RU/KZ; non-residents may open BUSINESS accounts only; RUB/KZT billing [o] — heavy | reserve #2 (his call: audio to Russia) |
| **Azure AI Speech** | **Yes, uz-UZ** for real-time / fast / batch [o] | must PIN a locale: uz-UZ is not in the fast-transcription auto-detect set [o] | Ogg/Opus accepted [m] | fast $0.36/h = $0.006/min; real-time $1/h = $0.0167/min [3] | region of choice (EU possible) | Azure subscription, card — heavy [m] | not shortlisted |
| **AssemblyAI** | Uzbek page exists; Universal-2 «99 languages» [o]; no Uzbek accuracy published | code-switching «across 18 languages» on Universal-3.5 Pro — Uzbek among them unconfirmed [3] | [m] yes | $0.15-0.21/h = $0.0025-0.0035/min [3] | US (EU option [m]) | card | reserve |
| **Soniox** | 60+ languages, Uzbek NOT confirmed (Kazakh is) [3] | native mid-sentence code-switching, language tag per word [o-vendor] | [m] yes | $0.10/h = $0.0017/min [o-vendor] | US | card | check the language list; reserve |
| **Gladia** (France) | Uzbek page exists [o]; Whisper-derived [m] | «code-switching across 100+ languages» [3] | not seen | ≈ $0.61/h (2024 figure) [3] | EU | card | reserve |
| **Deepgram** | **No** — Nova-3 multilingual list has no Uzbek; Kazakh added only 2026-09 [o]; vendor table Nova-2 100 % WER [3] | — | — | — | — | — | **out** |
| **UzbekVoice / Mohirdev** | the search found NO live STT API page [—]; a per-minute API existed [m, unverified]. The UzbekVoice DATASET (~900 h) is what open Uzbek models train on [o] | — | — | unknown | UZ | — | ask locally; not shortlisted blind |
| **«Navoiy»/NavAI, Rubai, UzASR, NVIDIA FastConformer-uz** | open MODELS, not hosted APIs: whisper-medium fine-tune 9.7 % macro-WER (self-reported); rubaistt_v2_medium ≈ 17 %; NVIDIA 16-17 % (read speech); a turbo fine-tune 38-40 % on SPONTANEOUS speech [3] | Uzbek-only fine-tunes; one card says outright «code-switching not trained» [o-card] | n/a | free + your own machine | your server | n/a | see self-hosting |
| **Telegram's own** (`messages.transcribeAudio`, Premium) | undocumented; quality on Uzbek unknown | unknown | it IS the voice note | 0 (Premium fee; the spec §5 already wants Premium on the seat) | never leaves Telegram | — | **free rider in the trial** IF the seat gets Premium; one more automated call on an account that must not be banned; only tg-listen can call it |

### Self-hosting on the Contabo box (4 vCPU, 8 GB, no GPU)

- **Speed** — the only hard number: faster-whisper `small` int8 does 13 min of audio in 1 m 42 s on a desktop
  i7-12700K with 8 threads (≈ 7.6× real time) [README, via mirrors]. Extrapolated to 4 shared VPS cores **[my estimate,
  unverified]**: `small` ≈ 2-3× real time → a 30-s note in **10-15 s**; `medium` ≈ real time → **30-45 s**;
  `large-v3` → **60-100 s**; `large-v3-turbo` ≈ 20-30 s. Whisper encodes a fixed 30-s window, so a 5-s note costs the
  same as a 30-s one. RAM held warm ≈ 1.5 / 3 / 4+ GB.
- **Quality** — vanilla Whisper on Uzbek is unusable (rows above). Uzbek fine-tunes are decent on READ speech, collapse
  on spontaneous speech, and are not trained for Russian or for mixing.
- **Cost to the live system** — measured in this repo (DECISIONS #559-565): the ceiling is the one Node process;
  pinning four cores for a minute per note is paid by every screen. The image is `node:22-slim`: no Python, no ffmpeg.
- **Verdict: no.** Only as a privacy fallback on a SEPARATE machine, and only after an Uzbek+Russian model exists.

---

## 3. Shortlist of three for the trial

1. **ElevenLabs Scribe v2** — the only global service with Uzbek explicitly listed, published Uzbek numbers, a
   mixed-language option, any audio format, a self-serve key, an EU endpoint.
2. **One Uzbekistan-made service — Aisha first** (self-serve key, free credits, uz/ru/en), **Muxlisa beside it** if a
   key arrives in the same week (its published figures are on REAL telephony audio — the closest thing to a voice
   note). Audio stays in the country; payment is local.
3. **OpenAI `gpt-transcribe`** — the baseline: easiest key, cheapest, takes `.ogg` as-is. It is expected to lose on
   Uzbek; it earns its place by showing how much the other two are worth. Do NOT build on `whisper-1` /
   `gpt-4o-transcribe` (removal announced for 2027-02-26).

Riders that cost nothing to add if a key is at hand: **Google** (Chirp 3 `uz-UZ`, or Gemini with a prompt), **Yandex**,
and **Telegram's own transcription** if the seat number gets Premium for the Business-chatbot trial of §5 anyway.

---

## 4. Trial protocol (replaces §10's one line «10-20 notes, 2-3 providers»)

The spec says «10 notes» (risk design), «10-20» (§10) and «20» (Q16). Fix ONE number and a pass bar, or the trial
cannot fail.

**Material — 25 real notes + 4 traps**, taken from the stored attachments (`voice_<msgId>.oga`), never recorded for
the purpose:
- 9 Uzbek · 6 Russian · 6 mixed in one note · 4 hard ones (street/bazaar noise, fast speech, a regional accent);
- at least 15 carry figures (kub, kg, carton sizes, pieces, a price), at least 8 name a place (Ivu, Guanchjou, Foshan,
  Xorgos, Qashqar, Toshkent, Andijon), a few a GS code; lengths spread over 5-60 s, two of 90-120 s; ≥ 12 speakers;
- **traps**: silence, noise only, a one-second «ha», a forwarded note in CHINESE (customers forward suppliers).

**Reference** — one seller listens once and fills a FACT SHEET per note (not a full transcript): goods words · every
number with its unit · every place · the section (yo'lkira / rastamojka bilan) · what the customer wants. ~1 hour.

**Run** — from the PRODUCTION server (`docker compose run --rm migrate …`), not from a laptop in Tashkent: reachability
from a German IP is one of the things being tested. Same bytes to every provider, no transcoding, language left on
auto and — where the service needs it — pinned uz and pinned ru as separate runs.

**Scored twice, blind** (the scorer sees «provider A/B/C»):
- raw transcript against the fact sheet;
- **the facts the AI model extracts from the transcript** against the fact sheet — this is the deciding score: the
  model repairs «uch kub atrofida tort yuz ellik kilo», and what the product uses is the facts, not the words.

| # | Measure | Pass bar |
|---|---|---|
| M1 | notes in which EVERY figure+unit is right (after extraction) | ≥ 90 % of the notes that carry figures (≥ 14 of 15) |
| M2 | a wrong figure delivered as if sure (350 → 35, kub ↔ kg, 15 ↔ 50) | at most 1 in the whole set |
| M3 | places and codes right | ≥ 90 % |
| M4 | goods words found (kurtka, zapchast, игрушки…) | ≥ 85 % |
| M5 | a person reading only the transcript would answer the same thing | ≥ 22 of 25 |
| M6 | traps: text invented from silence / noise / Chinese | **zero** |
| M7 | mixed notes: both languages survive | ≥ 5 of 6 usable |
| M8 | time for a 60-s note from the server, p95 | ≤ 10 s |
| M9 | accepts the `.oga` bytes without conversion; script of the output (Uzbek in Latin? digits or words?) | recorded |
| M10 | real cost per minute and the billing step (15-s blocks?) | recorded |

**Decision.** Nobody passes M1+M2+M6 → Q16 = «ask to type + card», revisit in six months. One passes → that one.
Several → order: privacy (audio stays in UZ/EU) → ease of the key → price.

**Honesty about 25 notes.** 23 right of 25 is «somewhere between 74 % and 99 %». The trial can only THROW OUT bad
providers and rank the rest. The proof is live: voice starts in the spec's own position **«Nazoratda»**, never
«O'zi» — every voice-borne turn lands on the check list — and is promoted by his tap only after ≥ 100 notes with
**≤ 10 % of read-backs corrected by the customer**.

---

## 5. Is the read-back rule enough? No — eight additions

The spec's rule: «a heard figure is repeated back in text and confirmed before it prices anything». Keep it; add:

1. **Give it a mechanical home (blocker).** Today a tool input must be a figure the customer STATED, read from the
   chat text (`tools.ts stated()`, `policy-input.ts customerNumberSources`). If a transcript is written into the
   message body, heard figures become stated figures and the estimate tool prices them at once — the rule is defeated
   with no test red. The spec must say: a transcript is stored BESIDE the message (one row per attachment), its figures
   carry a new origin **`heard`**, and `heard` never satisfies a tool input. Promotion `heard → customer` happens only
   by the confirmation in point 3. Conversely, after «ha» the confirmed figures live in OUR echo, not in his text, so
   without an explicit promotion the tool would refuse for ever — both halves must be designed.
2. **Read back the FACT SHEET, not only figures.** A misheard city picks the wrong tariff column AND the wrong
   warehouse address — the spec's own «most expensive mistake» (§9). A misheard goods word skips the prohibited-goods
   check; a missed «emas / не надо» flips the section. Rule: **every value that feeds a tool or a system block
   (goods, kub, kg, sizes, from, section, a code) is echoed and confirmed** — as ONE system-rendered block
   «Eshitganim: …», which needs a block type of its own in wall 2 (§3.2 lists none for this).
3. **Define «confirmed».** A typed «ha / to'g'ri / да / верно / +», or the customer re-typing the values. A VOICE
   «ha» counts only when its transcript is an affirmative with no number and no negation. A correction makes the typed
   values the customer's own. Silence is never a confirmation; one reminder, then nothing.
4. **Tier by action, like the rest of the spec.** A question with no tool input («yukim qayerda?» in a phone-proven
   chat) is answered at once — no read-back. Price, address, VED job, code, anything T1-with-inputs and above waits
   for the confirmation. A code or a phone HEARD is never a lookup key and never an identity.
5. **Fallbacks, written down.** Empty / low-confidence / implausible speech rate / a known hallucination phrase /
   provider error or > 10 s → «Ovozli xabaringizni yaxshi eshita olmadim, iltimos yozib yuboring» + the card with the
   player. Second failure in the chat → a person (the spec has this). A burst with text AND an unheard voice note must
   SAY the note was not heard: today an all-voice burst is noticed (`worthy.ts voice_only`) and a mixed one is held
   for a person by the `media` gate — the spec deletes that gate, and after it nothing obliges the reply to mention
   the note it could not hear.
6. **Limits as dials (missing from §2's list).** Max length acted on by itself: 120 s (longer → transcript goes to
   the card, the customer is asked for the short version in text). Per chat: ≤ 10 notes an hour. Global: a
   **minutes-per-day budget** (default 120 min, warning at 80 %) — it guards against loops and abuse, not against the
   bill. Prerequisite: the duration is computed and NOT stored today (`tgMediaPlan durationSec`, `map-senses.md` #14) —
   it must be stored before anything can be capped or billed. Audio FILES (a 20-minute mp3) are not voice notes: card
   only.
7. **The transcript is visible and judged.** Under the voice bubble in the CRM thread and on every supervisor card
   («📝 AI eshitgani: …», so a person need not listen); in the journal with a «noto'g'ri eshitdi» 👎; one reading per
   attachment, remembered; deleted with the chat by the existing purge. And a measure the spec's §2 lacks: **share of
   read-backs corrected**, weekly, with the automatic step-down the spec already has per action (above 15 % in 7 days
   → voice back to «yozib yuboring»).
8. **Where stage 2 puts voice is the worst place.** Ears arrive in stage 2, the new guard (blocks + reviewer) in
   stage 3. So transcripts — no punctuation, number WORDS, possibly Uzbek in Cyrillic — would flow into today's word
   readers and language rule, which were measured on typed text only (the reader corpus has no transcript cases; the
   repo's own record lists «Uzbek Cyrillic without ў/қ/ғ/ҳ read as Russian» among the reader finds of part 1). Either
   voice moves behind wall 2, or stage 2
   voice is limited to: transcript → templated read-back → typed confirmation, with the transcript never entering the
   reply-language rule or the figure readers as if it were typed. Add transcript cases to both corpora first.

Also add to §9: prompt injection through a VOICE note (a transcript is the customer's words, never an instruction);
provider outage and model retirement (OpenAI is removing three transcription models on one date) — hence ONE seam
`transcribe()` with the provider behind it, a ledger row per note (minutes, dollars frozen when billed, like the
pressed-AI ledger), and the minutes on the evening AI line.

---

## 6. What to change in the spec, line by line

| Where | Now | Change to |
|---|---|---|
| §1 Qualification, «AI alone» | «hears voice notes and repeats figures back before pricing» | «hears voice notes IF the trial passes (Q16); echoes the whole fact sheet and waits for a typed yes before any price, address or job. Until then, and on any failure: asks to type + card» |
| §2 Dials | no voice dials | add: voice on/off, max seconds, notes per chat per hour, minutes per day, the correction-rate step-down; voice starts «Nazoratda» |
| §2 Trust | five signals | add: share of read-backs corrected by the customer |
| §3 wall 2 | blocks for numbers, addresses, dates, codes, statuses | add the «Eshitganim» block; origin `heard`; promotion rule |
| §7 stage 0 | settings + census | add: the STT trial (needs only keys and 25 notes — start now, it gates nothing else) and a count of voice MINUTES per day (from attachment sizes ≈ 3 KB/s until durations are stored) |
| §7 stage 1 | silent on voice | define it: a voice-only burst gets «yozib yuboring» at once + the card (today: no reply to the customer, only a card — at night that is a dead end until morning) |
| §7 stage 2 | «M + M», eyes and ears together | split 2a eyes / 2b ears; 2b gated on the trial and on point 8 above |
| §8 «Required before stage 1-2» | Q16 as one choice | Q16.1 (trial permission) is needed at stage 0; Q16.2 (fallback) at stage 1 |
| §9 cost | no STT line | the paragraph in §7 below |
| §10 | «10-20 notes (2-3 providers)» | the protocol of §4 with its pass bar |
| design-product Q18 | «roughly a cent a note» | see §7 |
| design-risk Q15 | «about a cent a minute» | true for Google / Azure real-time only; 0.3-0.6 cent for the rest |

---

## 7. The cost claim, corrected

- **Transcription:** $0.0017-0.016 per minute depending on the service → a 30-second note costs **0.15-0.8 cent**
  (ElevenLabs ≈ 0.18, OpenAI ≈ 0.15-0.3, Yandex ≈ 0.27, Google ≈ 0.8); a 60-second note 0.2-1.6 cents. «About a cent
  a note» overstates it 1.2-6×. Local services publish no price.
- **Per month:** nobody has counted voice minutes (durations are not stored). At 30 notes a day ≈ **$1.5-7.5 a
  month**; at 150 a day ≈ **$8-36**. Against the spec's own $600-1 200 a month this is the smallest line there is.
- **What a voice note really costs:** one more AI reply — the read-back — at the spec's own 1.5-4 cents, i.e. 5-20×
  the transcription, plus one round trip of the customer's patience.
- Sentence for the spec: *«Ovozni matnga aylantirish deyarli tekin (30 soniyalik xabar ≈ 0.2-0.8 sent, oyiga bir
  necha dollardan 35 dollargacha); ovozli xabarning asl narxi — AI yana bir marta javob yozishi (1.5-4 sent) va
  mijozdan bitta «ha» kutish.»*

---

## 8. Q16 — proposed wording (Uzbek, as he will read it)

> **16. Ovozli xabarlar.** Hozir AI ovozni eshitmaydi: mijoz ovozli xabar yuborsa, sizga «o'zingiz javob bering»
> degan karta keladi, mijozga esa hech narsa yozilmaydi.
>
> **16.1 Sinov (hozir, kod yozilmasdan).** Mijozlarning 25 ta haqiqiy ovozli xabarini 3 ta xizmatga yuborib
> o'lchaymiz: o'zbekcha, ruscha va aralash gapda raqamlarni (kub, kg, o'lcham), shahar nomlarini va tovar nomini qaysi
> biri to'g'ri yozadi. Xizmatlar: ElevenLabs (Yevropa/AQSH), OpenAI (AQSH), Aisha yoki Muxlisa (O'zbekiston).
> Sinov narxi 1 dollardan kam. Sizdan kerak: 2-3 ta kalit (karta bilan ro'yxatdan o'tish) va bitta sotuvchining 1
> soati — 25 ta xabarni eshitib, ichidagi yuk ma'lumotini yozib beradi.
> ⭐ a) ha, uchalasi bilan · b) faqat O'zbekistondagi xizmat bilan — ovoz chet elga chiqmasin · c) sinov kerak emas,
> AI ovozni eshitmasin.
>
> **16.2 Sinov tugaguncha va AI eshita olmagan har safar.**
> ⭐ a) AI mijozga darhol yozadi: «Ovozli xabaringizni hozir eshita olmayapman, iltimos yozib yuboring» — va sizga
> (yoki navbatchi sotuvchiga) karta boradi · b) AI jim turadi, faqat karta keladi (bugungidek).
>
> **16.3 Sinovdan o'tsa** (kamida 15 ta xabardan 14 tasida hamma raqam to'g'ri, jimjitlikdan gap «to'qimasa»).
> ⭐ a) AI eshitadi va eshitganini YOZMA qaytaradi: «To'g'ri tushundimmi: kurtka, 3 kub, 450 kg, Ivudan,
> rastamojkasi bilan?» — mijoz «ha» deb yozmaguncha narx ham, sklad manzili ham aytilmaydi, VEDga ham ketmaydi.
> 2 daqiqadan uzun yoki tushunarsiz xabarda «yozib yuboring» deydi. Birinchi 100 ta ovozli xabar sizning tekshiruv
> ro'yxatingizga tushadi; bir haftada mijozlar har 100 ta xabardan 15 tasidan ko'pida «yo'q, noto'g'ri» desa, AI o'zi
> «yozib yuboring» ga qaytadi ·
> b) AI eshitadi, lekin ovozdan kelgan har bir javobni odam tasdiqlaydi · c) eshitmaydi (16.2 qoladi).
>
> **Bilib qo'ying.** (1) Ovozli xabar fayli tanlangan kompaniyaning serveriga yuboriladi — mijozning ovozi va aytgan
> gaplari (ismi, telefoni, yuki) o'sha kompaniyada qayta ishlanadi; O'zbekistondagi xizmat tanlansa, mamlakat ichida
> qoladi. (2) Narxi: 30 soniyalik xabar ≈ 0.2-0.8 sent, oyiga bir necha dollardan 35 dollargacha; qimmatrog'i — AI
> ning qo'shimcha bitta javobi (1.5-4 sent). (3) Kunlik chegara: 120 daqiqa ovoz, undan oshsa AI «yozib yuboring»
> deydi. (4) Hech bir xizmat o'zbek-rus aralash gapni kafolatlamaydi — shuning uchun «ha» so'ralmasdan narx aytilmaydi.

English gloss for the lead: 16.1 = permission for the trial and where the audio may go; 16.2 = behaviour until ears
exist and on every failure; 16.3 = behaviour if the trial passes (read-back of the whole fact sheet, typed yes, 2-min
cap, first 100 supervised, automatic step-down). The provider is NOT asked in advance — it is shown to him with the
trial's numbers.

---

## 9. Not verified, and what would verify it

- Every price: open the provider's own pricing page (network allow-list needed for platform.openai.com,
  elevenlabs.io, docs.cloud.google.com, aisha.group, muxlisa.uz, yandex.cloud).
- Aisha and Muxlisa: price per minute, accepted formats, whether the API answers a German IP, where the data sits.
- UzbekVoice/Mohirdev: whether a public STT API still exists — ask locally.
- Soniox, AssemblyAI (code-switching list), Gladia: whether Uzbek is on the list that matters.
- Telegram's own transcription on Uzbek, and how many calls a day an automated Premium account may make.
- Self-hosting speeds on HIS box: an estimate from one desktop benchmark, never measured.
- Uzbekistan's personal-data localisation rule: the whole system already sits in Germany, so STT adds one more
  processor, not a new kind of exposure — a lawyer's question if he wants it answered, not ours.

## Sources (search extracts; pages themselves were not reachable from this session)

OpenAI: developers.openai.com/docs/deprecations · developers.openai.com/api/docs/guides/speech-to-text ·
developers.openai.com/api/reference (create transcription) · help.openai.com/en/articles/5347006 ·
costgoat.com/pricing/openai-transcription · developersdigest.tech/blog/whisper-1-gpt-4o-transcribe-deprecation
ElevenLabs: elevenlabs.io/docs/overview/capabilities/speech-to-text · elevenlabs.io/speech-to-text/uzbek ·
artificialanalysis.ai/speech-to-text/models/elevenlabs-scribe-v2 · developersdigest.tech/models/speech/elevenlabs
Google: cloud.google.com/speech-to-text/v2/docs/chirp_3-model · cloud.google.com/speech-to-text/pricing ·
discuss.ai.google.dev (Gemini 2.5 Flash transcription threads)
Azure: learn.microsoft.com/azure/ai-services/speech-service/language-support ·
azure.microsoft.com/pricing/details/cognitive-services/speech-services
Yandex: yandex.cloud/en/docs/speechkit/pricing · yandex.cloud/ru/docs/speechkit/stt/models ·
yandex.cloud/ru/blog/posts/2023/06/speechkit-uzbek-language · yandex.cloud/en/docs/overview/concepts/region
Deepgram: developers.deepgram.com/changelog/2026/9/3 · deepgram.com/changelog/nova-3-multilingual-ga
AssemblyAI: assemblyai.com/languages/uzbek · dupple.com/learn/assemblyai-pricing
Soniox: soniox.com/speech-to-text · soniox.com/speech-to-text/features/language-detection
Gladia: gladia.io/product/languages/uzbek
Uzbekistan: aisha.group/en/speech-to-text-api · aisha.group/llms-api.txt · uzinfocom.uz/en/news/522 (Muxlisa) ·
anhor.uz (speech-tech products on the Uzbek market) · pionero-web.pages.dev
Open models: huggingface.co/BuzzASR/uzbek · huggingface.co/islomov/rubaistt_v2_medium ·
huggingface.co/nvidia/stt_uz_fastconformer_hybrid_large_pc · huggingface.co/rustam1221/UzASR-CTC-600M ·
huggingface.co/baisalovar/Tynda-ASR-uz · friendli.ai/models/navai-uz/whisper-base-uzbek
Self-hosting: pypi.org/project/faster-whisper (README benchmark table)
Telegram: core.telegram.org/api/transcribe · core.telegram.org/method/messages.transcribeAudio
Repo (read-only): src/modules/wms/agent/tools.ts (`stated`), numbers.ts (`SourceOrigin`, `customerSources`),
policy-input.ts, worthy.ts (`voice_only`), crm/telegram-import.ts (`durationSec`), Dockerfile (no ffmpeg),
docs/AI-SOTUVCHI.md §3.5.
