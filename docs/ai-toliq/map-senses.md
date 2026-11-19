# AI sotuvchi — SENSES, CHANNELS, MODEL PLUMBING (code map, 2026-11-19)

Read-only map of `/home/user/fullprompt`. Every claim cites `file:function`. Nothing was run but greps, file reads and
`\d` on `gsr_ci`. Figures marked «estimate» are computed from the code's constants, not measured (no key, no Telegram here).

**One-paragraph verdict.** The bytes of what a customer sends (photo, voice note, audio, PDF, Excel, a short video) are
ALREADY stored on the AI seat's chat rows, and three production-grade document readers already exist for the staff side
(photos + PDFs + spreadsheets → structured goods). The AI seller's run is wired to none of them: its model seam cannot
carry an image or a document block, its context reads only `content_type`/`file_name`, a media-only burst produces no
draft at all, and any burst containing media can never go by itself. Eyes are a wiring job (weeks, no new vendor). Ears
(voice notes, call recordings) need an external speech-to-text service — the installed Anthropic SDK has no audio input.
Every channel other than the personal Telegram account and the company bot is lead INTAKE only; there is no WhatsApp,
Instagram DM, e-mail or SMS code. Nothing in the agent can write first: every send needs the customer's own inbound
message as an anchor no older than 24 h (7 days for a VED answer).

---

## 1. Telegram media as stored

### 1.1 What is kept — `src/modules/wms/crm/telegram-import.ts: tgMediaPlan`

Pure, decided from the message object BEFORE any network I/O; unknown size = not fetched.

| Kind (`TgMediaKind`) | Rule | Cap | Stored as |
|---|---|---|---|
| `photo` (`MessageMediaPhoto`) | `tgPhotoPlan` — biggest `Photo.sizes` | `MAX_TG_PHOTO_BYTES` = 10 MiB | `image/jpeg`, `photo_<msgId>.jpg` |
| `voice` (document + `DocumentAttributeAudio.voice`) | by ATTRIBUTE, not mime; odd mime → `audio/ogg` | `MAX_TG_AUDIO_BYTES` = 20 MiB | `audio/ogg` (Opus in Ogg), `voice_<msgId>.oga` |
| `audio` (audio attr or `audio/*`, no video attr) | mime must be in `PLAYABLE_AUDIO` (ogg, opus, mpeg, mp4, m4a, x-m4a, aac, wav, x-wav, webm) | 20 MiB | declared mime, sender's filename or `audio_<msgId>.<ext>` |
| `file` (everything else) | `resolveContentType` + `isStorableType` (the STORAGE's own list: photos, pdf/xlsx/xls/xlsm/docx/doc/txt/csv/zip/rar/7z, mp4/mov/webm video, audio) | `MAX_TG_FILE_BYTES` = 20 MiB | declared/extension mime, sender's filename or `file_<msgId>` |

**Dropped on purpose** (stay «📎», `has_media = true`, no attachment): stickers (`DocumentAttributeSticker`), round
video notes (`videoAttr.roundMessage`), link previews, anything past its cap, anything of unknown size, any mime
storage refuses. The plan computes `durationSec` for voice/audio, and **nothing stores it** (`saveMediaFor` ignores
it; `tg_messages` has no duration column — `\d tg_messages`).

### 1.2 How bytes are stored — `scripts/tg-listen.ts: saveMediaFor`

- `msg.downloadMedia()` → `saveAttachment({ entityType: 'tg_message', entityId: <tg_messages.id>, fileName, contentType,
  body, uploadedBy: managerUserId }, { thumbnails: 'skip' })`; thumbnails inline with sharp for photos only.
- Called from three places (live handler l.872, catch-up l.2000, connect-time backfill l.2139) — for every listened
  account, the AI seat included, and only for a NEW row.
- Storage driver: `src/modules/platform/files/storage.ts: getStorage` — `S3Driver` when `STORAGE_DRIVER=s3` (MinIO in
  production), else `LocalDriver`. Key = `tg_message/<messageRowId>/<uuid>` (`files/service.ts: saveAttachment`).
- A row exists only for a chat that has an owner: `tg_messages_owner_check CHECK (client_id IS NOT NULL OR lead_id IS
  NOT NULL)` — a stranger's media is stored only once the chat is a lead (work-account switch) or a client.
- The agent's OUTBOUND is text only: `agent_outbox.body` (≤ 4000 chars), sent by raw `messages.SendMessage`
  (`agent/gramjs-adapter.ts`). Only the HUMAN queue can send a file (`tg-listen.ts` l.1747 `client.sendFile`).

### 1.3 Can the agent's context reach those bytes today? — NO

- `src/modules/wms/agent/context.ts: chatMessages` reads `tg_messages.has_media` and then, per media row, ONLY
  `attachments.contentType` and `attachments.fileName` (first attachment by `created_at`). No `attachments.id`, no
  `storage_key`, no bytes. `ChatMessage` carries `media: 'photo'|'voice'|'audio'|'document'|'other'|null` + `fileName`.
- `context.ts: mediaOf` — `image/*` → photo; `audio/*` → voice if the name has «voice» or the mime has «ogg», else
  audio; everything else (PDF, Excel, **a video clip too**) → `document`; `has_media` with no kept file → `other`.
- `src/modules/wms/agent/prompt.ts: MEDIA_WORD` + `chatBlock` — the model is shown the literal words:
  `photo: 'rasm'`, `voice: 'ovozli xabar (eshitilmagan)'`, `audio: 'audio (eshitilmagan)'`, `document: 'fayl'`
  (+ `: <file name ≤ 80 chars>`), `other: 'media'`.
- The model seam cannot carry them even if the context did: `src/modules/platform/ai/model.ts: ModelBlock` is
  `text | tool_use | tool_result | opaque`, and `tool_result.content` is typed `string`. There is no image/document
  member; `realCallModel` maps nothing else.
- What a media burst does today:
  - media with no text at all → `agent/worthy.ts: draftWorthy` returns `{worthy:false, reason:'media_only'}` — **no
    draft, no card, silence**; all-voice → `reason:'voice_only', notice:true` → the owner's card
    «🎤 Mijoz ovozli xabar yubordi — AI eshitmaydi, o'zingiz javob bering.» (`agent/drafts.ts` l.527).
  - media + text → a draft is written from the text alone, and the auto layer refuses it: `agent/auto-gate.ts`
    l.443 `hit.add('media')` (words: «mijoz rasm, ovozli xabar yoki fayl yuborgan»), fed by
    `agent/auto-send.ts: burstHadMedia` (any inbound `has_media` row between our last out line and the anchor).
    Exception: a `calc_submit` draft (`!calc`) — its files go to the VED.
  - a new photo/voice/file after a draft counts as a NEW question (`gramjs-adapter.ts: carriesContent`,
    `outbox-store.ts: keptFileSql`, `send-step` `anchor_superseded`).
- The ONLY consumer of the stored chat files in the agent: `src/modules/wms/agent/calc-files.ts` —
  `chatFilesForJob` (newest `CALC_FILES_MAX` = 10 kept files since the chat's last landed job),
  `copyChatFilesToNote` (bytes COPIED onto the intake note as `crm_activity` attachments so the VED can open them),
  `missingChatFiles` → gate code `calc_file_missing` («mijoz yuborgan fayl saqlanmagan — VED uni ko'rmaydi»).
  This is the exact query a «read this customer's files» tool needs — it already resolves `id, storage_key,
  file_name, content_type` per chat.

---

## 2. Existing model readers of images / PDF / Excel

All are direct `new Anthropic()` calls outside the `callModel` seam, all on `ANALYST_MODEL` (`claude-opus-5`).

### 2.1 `src/modules/wms/calc/intake-ai.ts: analyzeIntake` — the staff bot's «🧮 Hisoblatish» / «🤖 AI rastamojka»

- **Input**: `text` (clipped 20 000 units), `images[]` (jpeg/png/webp, already reduced), `pdf` + `morePdfs[]`,
  `sheets[]` / `contextSheets[]` / `goodsSheetText` (spreadsheets AS TEXT, shared `SHEET_TEXT_BUDGET` = 15 000 chars,
  `deals/goods-file.ts`), `knownGoods`/`codeKnown` (code rows the Excel reader already took, by index).
- **How passed** (`intakeContent`): images first as `{type:'image', source:{type:'base64', media_type, data}}`, then
  PDFs as `{type:'document', source:{type:'base64', media_type:'application/pdf'}}`, then one text block.
- **Caps** (`platform/telegram/calc-intake.ts`, `calc-files.ts`): `MAX_INTAKE_IMAGES` = 12, `MAX_INTAKE_PDFS` = 3,
  `MAX_INTAKE_PDF_BYTES` = 12 MiB total, `MAX_PDF_BYTES` = 10 MiB each; photo reduced by `calc-files.ts:
  reduceForModel` (EXIF rotate, ≤ `MODEL_IMAGE_PX` = 1568 px, JPEG q80, dropped if > 4.5 MB); a model-sized copy is
  cached in storage at `<storageKey>.model.jpg` (`modelCopyKey`, `storeModelCopy`); bytes loaded by
  `loadIntakeFiles` under `INTAKE_FILES_BUDGET_MS` = 30 s.
- **Call shape** (`streamAttempt`): `client.messages.stream`, `max_tokens: INTAKE_MAX_TOKENS` = 32 000 (thinking
  counts inside it), `output_config: { effort: INTAKE_EFFORT = 'medium', format: json_schema FACTS_JSON_SCHEMA }`,
  `maxRetries: 0`, own `AbortController` leash `INTAKE_TIMEOUT_MS` = 150 000 (thread door passes 20 000),
  one own retry only when the call never ran (`retryAfterPause`), a PDF-rejected request retried without the PDFs.
- **Output**: `from_city, to_city, weight_kg (brutto), weight_netto, volume_m3, goods[{name, quantity, weight_kg,
  volume_m3, unit, measure_qty, tnved_code, note}], steps[] (Uzbek, what it did), known_codes[]`.
  A cut answer keeps the goods it completed (`salvageCut`) when the caller passes `salvage: true`.
- **Failures are named** (`AiReadFailure`, `aiFailureOf`): `not_configured`, `nothing_to_read`, `timeout`,
  `truncated`, … — never a throw.
- **Runs as a job**: `platform/telegram/calc-read.ts` — `JOB_CALC_INTAKE_READ = 'calc.intake-read'`, 4 workers
  (`INTAKE_READ_WORKERS`), expiry 300 s, billed to `ai_calc_passes` kind `intake`.
- **Refused before the model**: HEIC, Word (`docx` is a zip), video, archives, the 4th PDF, voice
  (`calc-files.ts` ~l.249).
- NOTE: the web «thread → hisoblatish» door (`calc/from-thread.ts: threadCalcAnalyze`) passes `text` + `fileCount`
  ONLY — no images, no PDFs. So even the staff side reads a customer's CHAT files only when a person forwards them
  to the staff bot.

### 2.2 `src/modules/wms/receipts/tarkib-read-ai.ts: readTarkibDocument` — «🤖 Fayldan to'ldirish»

- ONE file per call, prepared by `receipts/tarkib-file.ts: kindOfAttachment` (from the attachment ROW: kind + size,
  `READ_CAPS` = sheet 15 MB / pdf 10 MB / image 15 MB) and `prepareFile` (PDF signature check; photo reduced to
  ≤ 2000 px and ≤ 4.5 MB — HEIC/HEIF accepted when sharp decodes it; spreadsheet → text, `SHEET_TEXT_BUDGET` 15 000
  chars / `SHEET_TEXT_ROWS` 400, merged cells marked «↑»).
- Call: streamed, `READ_MAX_TOKENS` = 32 000, `READ_EFFORT = 'medium'`, `maxRetries: 0`, `READ_LEASH_MS` = 150 000,
  `output_config.format` = `ANSWER_SCHEMA` → `rows[{name, name_ru, pieces, cartons, gross_kg, net_kg, volume_m3,
  hs_code, unsure}] + totals + document ('packing_list'|'invoice'|'other') + notes`, ≤ 40 rows.
- Failure codes: `ai_refused | ai_truncated | ai_failed | ai_timeout | ai_rejected`; billed through
  `calc/ai-press.ts` (`reservePress` → `settlePress`, `tarkib_ai_daily_limit` = 50, 0 = off, dollars frozen on row).
- **Best fit as an agent TOOL**: takes one stored attachment, answers «what is on this paper» as a table, never
  throws, already wire-tested against the real SDK (`tests/unit/tarkib-read-ai-wire.test.ts`).

### 2.3 Spreadsheet readers with NO model — `src/modules/wms/deals/`

- `goods-file.ts: readGoodsFile(body, contentType)` — XLSX/XLSM (every sheet), Excel 97 `.xls` (own BIFF8 reader
  `xls.ts: readXls`), HTML and SpreadsheetML tables, CSV in cp1251/GBK/UTF-16 (`decodeText`); returns mapped goods
  when a header is found, else sheet text for the model.
- `goods-import.ts: parseGoods` / `detectColumns` — header detection in ru/uz/zh/en, deep headers, label|value
  cards, total/footer rows named (`totalRowOf`), `MAX_GOODS_ROWS` = 500.
- Exact rows, zero tokens: a customer's Excel packing list can be read WITHOUT any model call.

### 2.4 `src/modules/wms/tnved/service.ts: suggestTnved` — one good → TNVED code, optional photo

- `photo?: { data, mediaType }` as one image block; `SUGGEST_MAX_TOKENS` = 16 000; not streamed; timeout 60 s,
  `maxRetries: 1`. Also `proposeGoodsGrouping` (8192 tokens) for the deal import and the VED's ✨.
- Useful for «the customer sent a photo of the product → which code / what is it» — one good at a time.

### 2.5 What could be a TOOL for the AI seller

| Tool idea | Reuse | Gap |
|---|---|---|
| `read_chat_files` → goods table (name, pcs, kg, m³) from the customer's invoice/packing list/photo | `agent/calc-files.ts: chatFilesForJob` (which files) + `tarkib-file.ts: kindOfAttachment/prepareFile` + `tarkib-read-ai.ts: readTarkibDocument`, or `goods-file.ts: readGoodsFile` first for Excel (free) | a ledger kind for it (`ai_calc_passes.kind` CHECK has 7 kinds, none for the agent), a daily cap, a per-chat memo so the same file is not re-read every run, and the policy's «figure source» list must admit figures a file reading produced (today: `tool|kb|customer`) |
| look at a photo inside the run itself | add image/document members to `platform/ai/model.ts: ModelBlock` + `realCallModel`; `calc-files.ts: reduceForModel` + `modelCopyKey` for the bytes | `tool_result.content` is `string`; chat block is one cached text block; `daily_token_cap` counts cache-write tokens |
| product photo → what is it / code | `tnved/service.ts: suggestTnved` | answer is advisory (no `'ai'` source exists for a code — `tests/unit/ai-advisory.test.ts`) |

---

## 3. The AI-VED estimate pipeline — could the AI seller give a customs ESTIMATE itself?

### 3.1 What it computes without a person — `src/modules/wms/calc/prefill.ts: aiPrefill`

A job the bot (or the agent) landed is carried «as far as it honestly can» and then STOPS:

1. **Memory first** — `calc/memory.ts` (no table: the SEALED record itself, `word_similarity` over `name_norm`,
   confirmed groups of sealed requests): supplies TNVED code + baza, never a rate. `prefill-steps.ts: applyMemory`.
2. **Codes** — exact-key TNVED book (`row-coding.ts: codeRows`: row → memory → book → model), model grouping
   `proposeGroups` (ANALYST model).
3. **Rates** — PP-3818 by code, 1 489 seeded rows (`calc/pp3818-rates.json`, `rates-seed.ts`), four duty shapes,
   VAT 12 %, additional duty by certificate, excise, the BHM fee per declaration — all in the pure engine
   `calc/pricing.ts` (`customsFor`, `requestCustomsFor`), which answers `{ok}` or `{ok:false, reason}`, never `$0`.
4. **Bazas** — the quarterly customs IMPORT file: deterministic fill (`saveTable`), and `prefill-ai.ts:
   pickImportRows` where the model picks a ROW INDEX among real declarations (never a price; `baza_source` has no
   `'ai'`).
5. **📊 Medians** — `calc/estimate.ts` + `estimate-read.ts: rowMediansFor`: for a baza-less row, `percentile_disc`
   median of real China declarations of the exact 10-digit code (≥ `FEW` declarations, ±25 % weight band per piece),
   bounded `MAX_ESTIMATE_ROWS` = 40, `ESTIMATE_BUDGET_MS` = 10 s, strictly sequential. Misses are named
   (`MISS_WORDS`: `short_code`, `no_batch`, `no_declarations`, `unit_mismatch`, `few`, `no_band`, …).
6. **Road** — tariff LIST price by zone and whole density (`tariff-read.ts`, `freight-answer.ts`), zone guessed from
   the city for the reply only (`zone-guess.ts`).

Wall clock `PASS_DEADLINE_MS` = 10 min; soft budget `ai_calc_daily_limit` = 200/day (`ai-cost.ts: aiCalcBudgetLeft`).

### 3.2 What the code SAYS about official vs estimate

- `prefill.ts` header: «The request stays in the VED's queue, every group is unconfirmed (which is a seal blocker),
  and the official price is still the seal or the typed «Готово». **Nothing here can price a customer.**»
- `ai-reply.ts: aiVedReplyText`: two totals — «Aniq: $X (N tadan M qator, yig'imsiz)» (a NAMED partial) and
  «Taxminiy ≈ $Y» (whole or absent); the tail line is literally `'⚠️ Rasmiy emas — VED xodimi tasdiqlaydi.'`
  (l.681; same in `prefill-reply.ts` l.198).
- `tests/unit/estimate-wire.test.ts`: the estimate files have no writer, name no model, and **the import direction is
  fenced** — only `estimate-read.ts`, `prefill.ts`, `ai-reply.ts`, `customs/import-median.ts` may import
  `calc/estimate` («no «Готово» default, no hint on narxlar, no seal, no price-channel post»).

### 3.3 How it already meets the AI seller

- An agent-submitted job queues the same pass: `agent/decide.ts` (l.734) `queueCalcPrefill({requestId, staffId,
  section})` with `intakeDoor: null`.
- When the pass speaks, `calc/jobs.ts` (l.473) calls `announceAgentCalcSafe(requestId, 'estimate', { amountText:
  'rastamojka ≈ $…, yo'lkira ≈ $…' })` → the OWNER gets `agent/calc-loop.ts` l.168:
  «🤖 AI-VED taxmini (rasmiy emas) — <kim> … VED javobini kuting yoki shu bilan narx bering.» with `priceable: true`
  (his 💵 door).
- The MACHINE never quotes it: `calc-loop.ts` queues `queueCalcAnswer` only for `event === 'done' || 'sealed'`;
  `agent/calc-price.ts: calcPriceFor` reads the VED's «Готово»/seal amount × his markup and refuses otherwise
  (`answer_noted`, …). Prompt rule 11 (`agent/prompt.ts`): «Rastamojka yoki podklyuch so'ralsa: narx AYTMA».
- The agent's checklist already uses the book: `agent/tools.ts: armedLaws` → `codeRows` (memory → book, no model) +
  `bookLawsFor`, to ask the customer the figure the law pins (m², juft, litr).

### 3.4 Answer

Technically YES — every number is deterministic or a real declaration's, already computed for agent-landed jobs
within minutes, and already reaches the owner. Giving it to the CUSTOMER is a policy decision the code currently
forbids in three places (prefill's header law, the import fence in `estimate-wire.test.ts`, prompt rule 11 +
`calc_price` only on done/sealed). Caveats that would travel with it: it stands on model-proposed TNVED codes nobody
confirmed (`AI_CODE_MARK` «(AI taklifi)»); «Taxminiy» is absent whenever one row cannot be priced; medians need a
customs file uploaded and ≥ FEW declarations of the exact code; a stale quarter is flagged (`staleBaza`,
`oldFileEnd`); the customer's material must first be READ (section 2) — today the agent's `calc_submit` carries only
goods lines the customer TYPED.

---

## 4. Voice

- **Speech-to-text in the repo: NONE.** `grep -rniE "whisper|speech|transcri|stt|deepgram|assemblyai|speechkit|
  ffmpeg"` over `src`, `scripts`, `package.json`, `Dockerfile`: the only hits are the word «transcription» meaning
  table transcription (`intake-ai.ts`, `tarkib-*.ts`). No `call_transcripts` table (`information_schema`), no ffmpeg
  in the image. `docs/AI-SOTUVCHI.md` §3.5 DESIGNS an `agent.transcribe` job and says the STT provider is «oldindan
  tanlanmaydi» (three to be trialled on ten real recordings) — unbuilt.
- **SDK**: `@anthropic-ai/sdk` **0.114.0** (`package.json` `^0.114.0`; `node_modules/.pnpm/@anthropic-ai+sdk@0.114.0…`).
  `resources/messages/messages.d.ts: ContentBlockParam` = `TextBlockParam | ImageBlockParam | DocumentBlockParam |
  SearchResultBlockParam | ThinkingBlockParam | RedactedThinkingBlockParam | ToolUseBlockParam | ToolResultBlockParam |
  ServerToolUseBlockParam | WebSearchToolResultBlockParam | WebFetchToolResultBlockParam | CodeExecution…ResultBlockParam
  | ToolSearchToolResultBlockParam | ContainerUploadBlockParam | MidConversationSystemBlockParam`.
  - Image: `Base64ImageSource.media_type` = `image/jpeg | image/png | image/gif | image/webp`, or `URLImageSource`.
  - Document: `Base64PDFSource` (`application/pdf`), `PlainTextSource`, `ContentBlockSource`, `URLPDFSource`.
  - `ToolResultBlockParam.content` may be `string | Array<TextBlockParam | ImageBlockParam | SearchResultBlockParam |
    DocumentBlockParam | ToolReferenceBlockParam>` — **a tool CAN return an image or a PDF to the model**.
  - **Audio: no input block type.** The only «audio» in the SDK's types is `helpers/beta/mcp.d.ts:
    MCPAudioContentLike`, documented as unsupported («@throws UnsupportedMCPValueError … e.g., 'audio'»).
- **Voice notes as stored**: `audio/ogg` (Opus in an Ogg container), `voice_<msgId>.oga`, ≤ 20 MiB, attachment of
  `tg_message`; duration not stored. Audio files: mp3/m4a/aac/wav/ogg/webm as sent.
- **Call recordings** (`src/modules/wms/calls/service.ts`, `src/app/api/calls/audio/route.ts`): uploaded by the
  phone app `apps/calls-android` minutes after the call, validated by MAGIC (`looksLikeAudio`: AMR `#!AMR`, Ogg
  `OggS`, MP3, WAV `RIFF`, M4A/3GP `ftyp`), `MAX_AUDIO_BYTES` = 25 MiB, stored as `attachments` of
  `entityType: 'call_log'` (default name `call-<startedAt>.m4a`), pointed at by `call_logs.attachment_id`
  (`call_logs`: user_id, client_id|lead_id, direction, phone, started_at, duration_sec). Only calls matching the
  client book or an open lead are stored at all. Played in `CallsPanel`; read by nothing else.

---

## 5. Model plumbing

### 5.1 The seam — `src/modules/platform/ai/model.ts`

- `CallModel = (ModelRequest) => Promise<ModelResponse>`; `realCallModel` = `client.messages.create` (NOT streamed),
  `CALL_TIMEOUT_MS` = 60 000, `maxRetries: 1`.
- Caching: `systemCached` (stable head behind `cache_control: ephemeral`, 5-minute TTL only) and `cache: true` on a
  text block (the agent's opening chat block). No 1-hour TTL anywhere.
- Blocks: text / tool_use / tool_result(string) / opaque (thinking passed back verbatim). No image, no document, no
  `thinking`/`effort`/`output_config` parameter on the seam, `strict` on tools supported.
- Models: `ANALYST_MODEL = 'claude-opus-5'`, `STAFF_MODEL = 'claude-sonnet-5'`.
- Price map `MODEL_USD_PER_MTOK` ($/MTok): opus-5 `{input 5, output 25, cacheRead 0.5, cacheWrite 6.25}`,
  sonnet-5 `{input 2, output 10, cacheRead 0.2, cacheWrite 2.5}`; `approxMicroUsd` returns null for a model with no
  entry (screens then print calls and no dollars).
- `aiConfigured()` = `ANTHROPIC_API_KEY` present.

### 5.2 Which feature uses which model

| Feature | File:function | Model | max_tokens | Stream | Deadline |
|---|---|---|---|---|---|
| **AI sotuvchi run** | `agent/run.ts: runLoop` via `callModel` | sonnet-5 | 1 500 per round, ≤ `maxToolRounds` 6 | no | 60 s/call, `LOOP_WALL_MS` 90 s |
| Staff AI yordamchi | `platform/ai/assistant.ts` | sonnet-5 (opus-5 for analyst roles) | 2 048, `MAX_ROUNDS` 6 | no | 60 s/call, 120 s wall |
| Intake reading | `calc/intake-ai.ts: analyzeIntake` | opus-5 | 32 000, effort medium | yes | 150 s (20 s thread door) |
| Tarkib file reading | `receipts/tarkib-read-ai.ts` | opus-5 | 32 000, effort medium | yes | 150 s |
| TNVED suggestion / grouping | `tnved/service.ts` | opus-5 | 16 000 / 8 192 | no | 60 s |
| Import-row pick | `calc/prefill-ai.ts: pickImportRows` | opus-5 | 4 096 | no | 60 s |
| «Oldingi narx» 🤖 | `finance/similar-ai.ts` | opus-5 | 1 024 | no | 60 s |

### 5.3 Ledgers

- `agent_runs` (0138): trigger (`inbound|owner_edit|calc_answer|hand_back|style`), anchor, attempt, model, four token
  counts (input, output, cache_read, cache_write), `tool_calls jsonb`, duration_ms, outcome
  (`reserved|draft|no_reply|notice|stood_down|refused|capped|error`).
- `ai_calc_passes` (0096+): kind CHECK `intake|grouping|pick|invoice|similar|tnved|tarkib`, model, input/output
  tokens (no cache columns), `outcome`, `cost_usd` frozen for pressed kinds, anchors (request/note/lot/batch).
- `ai_questions` (0080, tokens since 0146): the staff assistant, atomic daily cap `ai_daily_limit` = 40.
- `src/modules/wms/reports/ai-spend.ts`: the 20:00 summary's «🤖 AI» line — three ledgers priced at today's list via
  `approxMicroUsd`, unpriced requests COUNTED and never summed as $0; NOT in any ledger: the deal card's goods-file
  grouping, and agent runs whose chat was purged.

### 5.4 The agent's budgets

- `agent_config.daily_draft_cap` default **150** runs/day; `daily_token_cap` default **3 000 000**
  (`0138_ai_sotuvchi.sql`); editable on the page (`config.ts`, bounds 0..1 000 and 0..50 000 000).
- `agent/today.ts: capReached` — refusals `daily_draft_cap`, `chat_runs` (`runsPerChatPerDay` = 12),
  `daily_token_cap`; tokens counted = `input + output + cache_write` (cache READS are free of the cap).
  Reserved under one advisory lock, failing closed (`run.ts: reserve`).
- Send fuses (`agent/limits.ts: AGENT_LIMITS`): `perHour` 20, `perDay` 80 (editable ≤ 200 / ≤ 100 via
  `agent_send_caps`), `perChatPerDay` 12, `perChatGapMs` 20 s, `sendJitterMs` 10-25 s, `rampDays` 14,
  `maxReplyChars` 700.
- Auto layer (`agent_auto_config`, `\d`): `min_confidence` numeric(3,2) default **0.80**, CHECK 0.50..1.00, editable
  since #1800 (`auto-send.ts: setAutoMinConfidence`); `hold_sec` default 120 (30..600); `per_day` nullable (NULL = no
  daily limit since 0148, else 1..1000); `categories` default `{greeting,qualification,faq,status}` — `price`, `calc`,
  `calc_price` exist and ship UNTICKED.

### 5.5 Cost of one agent run today (estimate from the constants)

Sizes: rules ≈ 6.7k chars (`prompt.ts` l.71-95) + style guide ≤ 1 500 (`style.ts: STYLE_MAX_CHARS`) + general facts
(≤ 60, `kb.ts: generalFacts`) + lessons ≤ 6 000 chars/40 (`lesson-rules.ts`) + tool specs ≈ 5.5k chars →
**≈ 6.5-9k tokens of cached head**. Chat block: a few hundred tokens for a new chat, up to `historyTotalChars`
24 000 ≈ 8k tokens. Output: ≤ 1 500/round, typically 150-250 per tool round and 400-700 for `compose_reply`.

| Run | Arithmetic (sonnet-5) | ≈ $ |
|---|---|---|
| warm head (another run < 5 min ago), 2-3 rounds | head read 8k×0.2 + chat write 1.5k×2.5 + reads + 800 out×10 | **0.015** |
| cold head, 2-3 rounds | write 9.5k×2.5 + read 9.5k×0.2 + 800 out×10 | **0.03-0.04** |
| worst case: 100-message chat, 6 rounds, full outputs | write 16k×2.5 + 5×16k×0.2 + 9k out×10 | **≈ 0.15** |

Matches `docs/AI-SOTUVCHI.md` §18.1's own «about $5-7 a day at 150 runs» (= $0.033-0.047/run). So today's ceiling
is single-digit dollars a day; the cap of 3M counted tokens ≈ $6-10/day at this mix.

### 5.6 What eyes would add (estimate)

Vision tokens ≈ one token per 28×28 px patch (provider cost guide); sonnet-5 takes up to 2576 px / 4 784 tokens an
image.

| Addition | Tokens | $ on sonnet-5 (in the run) | $ on opus-5 (existing readers) |
|---|---|---|---|
| 1 photo reduced to 1568 px (`reduceForModel`) | ≈ 2 350 (4:3) … 3 140 (square) | 0.005-0.006 fresh; 0.0005 per later round if cached | 0.012-0.016 |
| 12 photos (the bot's cap) | ≈ 28-38k | 0.06-0.075 | 0.14-0.19 |
| PDF, per page (text + page image; provider docs' range, not from the repo) | ≈ 1 500-3 000 | 0.003-0.006 | 0.008-0.015 |
| Excel as text (`SHEET_TEXT_BUDGET` 15 000 chars) | ≈ 5k | 0.01 | 0.025 |
| a full `readTarkibDocument`/`analyzeIntake` reading (thinking + JSON out 3-10k tokens at $25/M) | — | — | **≈ 0.10-0.30**, worst case (32k out) ≈ 0.85 |

Consequences: (a) a photo in every round un-cached multiplies by the round count — it must sit before the cache
breakpoint or be read ONCE by a tool and returned as text; (b) `daily_token_cap` counts cache-write tokens, so three
photos add ~7k counted tokens to a run — the cap needs raising or its own image budget; (c) the cheapest design is
«read once, remember»: one reading per stored attachment (opus, ≈ $0.1-0.3) whose TEXT result is cached per
attachment id and shown to every later run for free.

---

## 6. Other channels present in the code

| Channel | Code | Direction | AI seller involved? |
|---|---|---|---|
| **Personal Telegram account (gramjs)** — the AI seat | `scripts/tg-listen.ts`, `wms/crm/telegram-*.ts`, `wms/agent/**` | in + out, text out only | yes — the only one |
| **Company bot** (grammY, Bot API) + Mini App | `platform/telegram/bot.ts`, `client-cabinet.ts`, `wms/client-cabinet/*`, `/cabinet`, `/api/cabinet/*` | in + out; can write FIRST to any chat that pressed /start | **no** — a customer's text/media is relayed to the manager as `ClientBotMessage` (`client-cabinet.ts` l.674, `forwardFrom`); no model reads it |
| Customer pushes via the bot | `client_notices` + `wms/notices/arrival-jobs.ts` (received, arrived, ready, issued, ✅/❌ lot questions) | out | no |
| Bot broadcast | `platform/broadcast/service.ts`, `/admin/xabarlar` (`broadcasts`, `broadcast_recipients`; super_admin, one per chat, batches of 20), birthdays | out | no |
| Staff bot | `platform/telegram/staff-handlers.ts`, `agent-bot.ts` (the owner's cards, ✅/✏️/💵/✍️/📝) | staff only | the owner's control surface |
| Meta Lead Ads webhook | `/api/leads/meta`, `wms/crm/meta-leads.ts`, `meta-jobs.ts` (Graph v21.0, `fields=field_data,created_time,ad_id,form_id,platform`) | in — lead FORM answers only | no; creates a lead via `landInboundLead` |
| Generic lead webhook | `/api/leads/in/[source]`, `wms/crm/inbound-webhook.ts` (per-source secret; Google `user_column_data`, plain JSON) | in | no |
| `/ariza` public form | `src/app/(public)/ariza`, `?manba=` | in | no |
| Bot deep link from an advert | `platform/telegram/ad-intake.ts` (`?start=ad_<key>`) | in | no |
| Website → least-busy manager | `GET /api/lead/assign` (`wms/crm/site-assign*.ts`), listener `siteTagAction`/`landSiteTag` — the site hands the visitor a manager's Telegram @username; the first message lands as a lead, channel `site` | in, then the personal-account chat | indirectly: only if the AI seat's handle is in the rota |
| Client-finding agent feed | `/api/agent/outcomes`, `/api/agent/suppression`, `wms/crm/agent-feed.ts`, source `agent`; `AGENT_LIMITS.agentLeadWindow` | in (leads another service found) | its leads' chats obey the playbook window |
| Calls APK | `apps/calls-android` → `/api/calls/{pair,logs,audio}` | in (log + recording) | no; recordings are played, never transcribed |
| Driver APK | `apps/driver-android` → `/api/track/positions` | GPS only | no |

`lead_intakes.channel` CHECK = `form | meta | telegram | webhook | site`; `INBOUND_SOURCE_KEYS` (`crm/inbound.ts`)
names meta/instagram/facebook/telegram/tiktok/… as SOURCES of a form lead, not as messaging channels.

**Stated plainly — none of these exist in code:** Instagram DM, Facebook Messenger, WhatsApp (the word appears only
in `calc-intake.ts: MESSENGERS`, a parser list for «Sardor WhatsApp +998…» contact lines), e-mail (no SMTP/IMAP/Gmail
dependency or module), SMS, Telegram Business bot mode. `docs/AI-SOTUVCHI.md` §3.1-§3.5 describe WhatsApp Cloud API,
Gmail and call transcription as phases 3-4 of the ORIGINAL vision — design text only.

---

## 7. Proactive sending — can the AI write first?

**No. Nothing in the agent or the listener can start a conversation or follow up on a silent one.**

- Schema: `agent_drafts.anchor_tg_message_id bigint NOT NULL`; `agent_outbox.answers_tg_message_id bigint NOT NULL`;
  `agent_drafts.kind` CHECK `reply | price | hand_back`; `agent_runs.trigger` CHECK `inbound | owner_edit |
  calc_answer | hand_back | style`. There is no «campaign», «follow-up» or «greeting» kind or trigger.
- `agent/send-step.ts: agentSendVerdict` — FINAL refusals that make a first message impossible:
  `anchor_gone` (the stored inbound row is deleted/purged), `anchor_edited`, `anchor_superseded`,
  `anchor_too_old` (`now − anchor.sent_at > anchorMaxAgeMs`), `approval_too_old` (`approvalMaxAgeMs` 6 h),
  **`never_wrote`** (`!f.peerHasWritten` — card words «mijoz bu akkauntga yozmagan»), `human_replied`, `muted`,
  `excluded`, `identity_changed`, plus waits `night` (22:00-08:00, `nightReleaseAt` 08:30), `agent_window`,
  `chat_gap`, `account_gap`, `hour_cap`, `day_cap`, `chat_day_cap`, `flood_wait`.
- Anchor age: `agent/anchor-clock.ts: anchorMaxAgeMsForTrigger` — `anchorMaxAgeMs` = **24 h** for every ordinary
  reply; `calcAnswerMaxAgeMs` = **7 days** only for a reply the owner's side started on a VED answer (his 💵, the
  machine's `calc_answer` reply, `ownerStartedDraft`). Even those anchor on the customer's newest INBOUND line.
- `agent/outbox-store.ts: chatFacts` reads `peer_has_written` (G7 per PEER: an inbound from THIS Telegram user to
  this account) and the anchor's row at every tick; the send steps are verify → read (`ReadHistory` up to the
  anchor) → typing → send (`gramjs-adapter.ts`).
- The HUMAN queue has the same law: `wms/crm/telegram-send.ts: canQueue / canSendNow` → `never_wrote_first`
  («The single most important rule. Unsolicited outbound to somebody who never messaged you is what "report spam" is
  for»).
- The model's `set_followup` action is NOT a message: `agent/decide.ts: runDraftActions` → `crm/service.ts:
  setFollowUp(kind, id, date)` — a date on the lead/client card that puts it on a person's «Bugun qo'ng'iroq» list.
- Planned, unbuilt: «Part 3 — the Friday greeting to quiet customers» (CLAUDE.md, «part 3 next»); grep for
  campaign/follow-up/juma in `wms/agent/**` and `tg-listen.ts` finds only the policy's date words.
- The only code paths that write to a customer FIRST today are the company BOT's (`client_notices` pushes,
  `/admin/xabarlar` broadcast) — and only to chats that pressed /start on the bot.

---

## Reusable today

1. **The bytes are already there** — every photo ≤ 10 MiB, voice/audio ≤ 20 MiB, file ≤ 20 MiB a customer sends the
   AI seat is an `attachments` row of `tg_message` (`tg-listen.ts: saveMediaFor`, `telegram-import.ts: tgMediaPlan`).
2. **«Which files belong to this request»** — `agent/calc-files.ts: chatFilesForJob / missingChatFiles /
   copyChatFilesToNote` (id, storage key, name, type per chat window; the VED already receives the copies).
3. **Photo → model-size JPEG** — `platform/telegram/calc-files.ts: reduceForModel` (1568 px, ≤ 4.5 MB),
   `modelCopyKey/storeModelCopy`; `receipts/tarkib-file.ts: prepareFile` (2000 px, HEIC when decodable).
4. **A single-document reader that never throws** — `receipts/tarkib-read-ai.ts: readTarkibDocument` (PDF, photo,
   spreadsheet-as-text → rows with pcs/cartons/kg/m³/HS code), streamed, 150 s leash, named failures, wire-tested.
5. **The multi-file request reader** — `calc/intake-ai.ts: analyzeIntake` (≤ 12 photos + ≤ 3 PDFs + sheets + text →
   route, brutto, cube, goods with units and codes, Uzbek `steps`), with the cut-salvage and retry rules.
6. **Model-free spreadsheet reading** — `deals/goods-file.ts: readGoodsFile`, `goods-import.ts: parseGoods`,
   `xls.ts: readXls` (XLSX/XLS/HTML/XML/CSV, zero tokens).
7. **Product photo → TNVED** — `tnved/service.ts: suggestTnved`.
8. **The customs estimate machine** — `calc/prefill.ts: aiPrefill` + `pricing.ts` + PP-3818 book + customs import
   file + `estimate.ts` medians + `ai-reply.ts` words; already runs for agent-landed jobs and already reaches the
   owner as «🤖 AI-VED taxmini (rasmiy emas)» (`calc/jobs.ts` → `agent/calc-loop.ts: announceAgentCalc('estimate')`).
9. **Row coding without a model** — `calc/row-coding.ts: codeRows` (sealed memory → book), already used by the
   agent's `calc_checklist` (`agent/tools.ts: armedLaws`).
10. **SDK capability** — `@anthropic-ai/sdk` 0.114.0 accepts image and PDF blocks in user turns AND inside
    `tool_result.content`; structured output (`output_config.format`), `strict` tools and prompt caching are in use.
11. **Billing rails** — `agent_runs` (with cache tokens), `ai_calc_passes` + `calc/ai-press.ts`
    (`reservePress/settlePress`: counted before spending, frozen dollars, 0 = off), `reports/ai-spend.ts`.
12. **A second, compliant outbound channel** — the company bot can write first to linked chats
    (`client_notices`, `platform/broadcast/*`, `platform/telegram/send.ts`); it already relays customer messages
    (`ClientBotMessage`).
13. **Stored call recordings** with client/lead, direction and duration (`call_logs` + `call_log` attachments) —
    raw material for a transcript the day an STT exists.
14. **Lead intake from every advert surface** — Meta webhook, generic webhook, `/ariza`, bot deep link, website
    assign → all land through `crm/inbound.ts: landInboundLead`.

## Missing — must be built or bought (external service)

**Buy (external service):**
1. **Speech-to-text** for voice notes (Ogg/Opus) and call recordings (m4a/AMR/3GP/MP3/WAV), Uzbek + Russian mixed —
   the Anthropic Messages API has no audio input in SDK 0.114.0; no STT, no ffmpeg in the repo or image. Needs a
   provider trial (the spec's own §3.5 plan: ~10 real recordings × 3 providers), a transcript table, a ledger kind,
   and a per-minute budget. Possibly an audio transcode step depending on the provider.
2. **WhatsApp Business (Cloud API)** — a separate number, Meta Business verification, approved templates for
   anything outside the 24-hour window. No code today.
3. **Instagram DM / Messenger** — Meta messaging permissions + app review; today's Meta integration is lead forms
   only (`meta-jobs.ts`).
4. **E-mail / SMS** — no sender, no inbox reader, no `clients.email` column.

**Build (inside this codebase):**
5. **Multimodal blocks in the agent's seam** — `platform/ai/model.ts: ModelBlock` has no image/document member and
   `tool_result.content` is a string; `realCallModel` must map them (the SDK already types them).
6. **Attachment ids in the agent context** — `agent/context.ts: chatMessages` selects only `contentType, fileName`;
   `ChatMessage` needs the attachment id(s), size and kind (and must stop calling a video a «fayl»).
7. **A «read the customer's file/photo» tool** for the run — choice of in-run vision (cheap, sonnet) vs. a call to
   the existing opus readers; a per-attachment result memo («read once»); a ledger kind (the `ai_calc_passes.kind`
   CHECK has none for the agent) and a daily cap; figures from a reading admitted as a policy source
   (`policy.ts` knows `tool | kb | customer`).
8. **The media gates rewritten** — `worthy.ts: draftWorthy` `media_only` (silence) and `voice_only` (notice),
   `auto-gate.ts` `'media'` (any burst with media never goes by itself), `prompt.ts: MEDIA_WORD` «(eshitilmagan)».
9. **Token budget for vision** — `daily_token_cap` (3 000 000, counts cache writes) and `maxTokens: 1_500` /
   `LOOP_WALL_MS` 90 s / `CALL_TIMEOUT_MS` 60 s were sized for text; a document reading inside the run needs the
   streamed 150 s shape or a separate job.
10. **A customer-facing customs estimate** — a deliberate reversal of three fences (`prefill.ts`' «Nothing here can
    price a customer», `estimate-wire.test.ts`' import direction, prompt rule 11 / `calc_price` only on
    done|sealed), plus the customer's goods READ from their files first, plus the words («taxminiy, rasmiy emas»).
11. **Proactive sending** — no draft kind, run trigger, outbox row or send verdict exists without an inbound anchor
    (`answers_tg_message_id NOT NULL`, `never_wrote`, `anchor_too_old` 24 h). A follow-up needs: a new kind/trigger,
    its own anchor rule (e.g. «the customer wrote within N days»), its own daily fuse and opt-out, and a decision on
    WHICH channel carries it (personal account = ban risk; company bot = only linked chats).
12. **Outbound media from the AI seat** — `agent_outbox` is text-only; sending a price list PDF, an address photo or
    a location needs columns + a `SendMedia` step (the human queue's `sendFile` is the precedent; the zametka
    library `staff_notes` holds the company's reusable files).
13. **The company bot as an AI channel** — today a pure relay to the manager (`client-cabinet.ts`
    `ClientBotMessage`); an AI reply there needs a second listener door, identity by linked chat, and its own
    outbox (no gramjs choreography, no ban fuses — different rules).
14. **Voice duration / transcript storage** — `tgMediaPlan` computes `durationSec` and nothing stores it; there is
    no `call_transcripts` / message-transcript table.
