import 'dotenv/config';
import { sql } from 'drizzle-orm';
import { db, pgClient } from '../src/modules/platform/db/client';
import { agentRuns } from '../src/modules/platform/db/schema';
import { ANALYST_MODEL, aiConfigured, realCallModel, type ModelBlock } from '../src/modules/platform/ai/model';
import { tashkentDay, tashkentDayStart } from '../src/modules/platform/time/tashkent';
import { readAgentConfig } from '../src/modules/wms/agent/config';
import { personalBits } from '../src/modules/wms/agent/kb';
import {
  STYLE_MAX_CHARS,
  humanOutBodies,
  knownNamesForMask,
  maskedSample,
  storeStyleProposal,
} from '../src/modules/wms/agent/style';

/**
 * Propose the AI sotuvchi's style guide from HIS OWN messages (spec §17.5,
 * review leak-1) — masked before the model reads a byte: digits → N, codes,
 * phones and links → […], every client and staff name → [ism]. The model
 * writes a short Uzbek guide about HOW he writes, never what he wrote; it
 * lands in `style_guide_proposed`, and only his press on «Suhbatlar → AI
 * sotuvchi → Sozlamalar» makes it the guide the drafts read.
 *
 *   docker compose run --rm migrate pnpm exec tsx scripts/agent-style.ts           # propose and store
 *   docker compose run --rm migrate pnpm exec tsx scripts/agent-style.ts --sample  # print the masked sample only
 *
 * Messages the agent itself sent are never his style (`humanOutBodies`
 * excludes every agent_outbox row). The call is ledgered in agent_runs
 * (trigger 'style'), so it counts against the day's token budget. Not a
 * package.json command on purpose (#1228).
 */

const USAGE = 'usage: pnpm exec tsx scripts/agent-style.ts [--sample]';
const MIN_MESSAGES = 20;

const SYSTEM = [
  "Sen GSR LOGISTICS kompaniyasi rahbarining Telegramdagi yozish uslubini tahlil qilasan.",
  "Senga uning mijozlarga yozgan xabarlari beriladi; ismlar [ism], raqamlar N, kodlar [kod], telefonlar [telefon], havolalar [havola] bilan yashirilgan.",
  `Vazifa: o'zbek tilida, ${STYLE_MAX_CHARS} belgidan oshmaydigan qisqa uslub qo'llanmasi yoz — u qanday salomlashadi, murojaat shakli (siz/sen, aka/opa), gap uzunligi, emoji, qaysi tilda yozadi, qanday xayrlashadi, nimani hech qachon yozmaydi.`,
  "Faqat USLUB: hech qanday fakt, narx, muddat, mijoz, tovar yoki shahar nomini yozma. Misol keltirma. Natijani propose_style vositasi orqali qaytar.",
].join('\n');

async function main(): Promise<number> {
  const args = process.argv.slice(2);
  if (args.some((a) => a !== '--sample')) {
    console.error(USAGE);
    return 2;
  }
  const sampleOnly = args.includes('--sample');
  const config = await readAgentConfig();
  if (!config) {
    console.error('agent_config does not exist yet — run the migrations first (0136).');
    return 1;
  }
  if (!config.ownerUserId) {
    console.error('No agent owner is configured — choose the account on «Suhbatlar → AI sotuvchi → Sozlamalar» first.');
    return 1;
  }
  const [bodies, names] = await Promise.all([humanOutBodies(config.ownerUserId), knownNamesForMask()]);
  const sample = maskedSample(bodies, names);
  console.log(`his messages read: ${bodies.length} · in the masked sample: ${sample.used} (${sample.text.length} chars)`);
  if (sampleOnly) {
    console.log(`\n${sample.text}`);
    return 0;
  }
  if (sample.used < MIN_MESSAGES) {
    console.error(`Too few of his own messages to read a style from (${sample.used} < ${MIN_MESSAGES}).`);
    return 1;
  }
  if (!aiConfigured()) {
    console.error('ANTHROPIC_API_KEY is not set in the server .env — nothing was sent anywhere.');
    return 1;
  }
  const dayStart = tashkentDayStart(tashkentDay()).toISOString();
  const [spent] = await db.execute<{ tokens: string }>(sql`
    SELECT coalesce(sum(input_tokens + output_tokens + cache_write_tokens), 0)::bigint::text AS tokens
      FROM agent_runs WHERE created_at >= ${dayStart}::timestamptz`);
  if (Number(spent?.tokens ?? 0) >= config.dailyTokenCap) {
    console.error("Today's AI token budget is spent — run it tomorrow, or raise the cap on the settings page.");
    return 1;
  }

  const started = Date.now();
  let usage = { inputTokens: 0, outputTokens: 0, cacheReadTokens: 0, cacheWriteTokens: 0 };
  let outcome: 'draft' | 'error' = 'error';
  let error: string | null = null;
  try {
    const res = await realCallModel({
      model: ANALYST_MODEL,
      system: SYSTEM,
      messages: [{ role: 'user', content: [{ type: 'text', text: sample.text }] }],
      tools: [
        {
          name: 'propose_style',
          description: "Uslub qo'llanmasini qaytaradi.",
          input_schema: {
            type: 'object',
            properties: { guide: { type: 'string', description: `O'zbekcha uslub qo'llanmasi, ${STYLE_MAX_CHARS} belgigacha.` } },
            required: ['guide'],
            additionalProperties: false,
          },
          strict: true,
        },
      ],
      maxTokens: 2_000,
    });
    usage = res.usage ?? usage;
    const tool = res.content.find((b): b is Extract<ModelBlock, { type: 'tool_use' }> => b.type === 'tool_use');
    const guide = String(
      tool?.input.guide ??
        res.content
          .filter((b): b is Extract<ModelBlock, { type: 'text' }> => b.type === 'text')
          .map((b) => b.text)
          .join('\n'),
    ).trim();
    if (!guide) throw new Error('the model returned no guide');
    if ([...guide].length > STYLE_MAX_CHARS) throw new Error(`the guide is ${[...guide].length} characters (max ${STYLE_MAX_CHARS}) — run again`);
    // The mask's own check, on what came BACK: a guide must carry nothing personal.
    const lower = guide.toLowerCase();
    const bits = personalBits(guide, names.filter((n) => lower.includes(n.toLowerCase())));
    if (bits.length > 0) throw new Error(`the guide names something personal (${bits.slice(0, 3).join(', ')}) — not stored, run again`);
    await storeStyleProposal(guide);
    outcome = 'draft';
    console.log(`\nProposed style guide (${[...guide].length} chars) — stored for approval on the settings page:\n\n${guide}`);
  } catch (err) {
    error = err instanceof Error ? err.message : String(err);
    console.error(`Not stored: ${error}`);
  } finally {
    await db.insert(agentRuns).values({
      managerUserId: config.ownerUserId,
      peerId: 0n,
      trigger: 'style',
      model: ANALYST_MODEL,
      inputTokens: usage.inputTokens,
      outputTokens: usage.outputTokens,
      cacheReadTokens: usage.cacheReadTokens,
      cacheWriteTokens: usage.cacheWriteTokens,
      durationMs: Date.now() - started,
      outcome,
      error: error ? error.slice(0, 500) : null,
    });
  }
  return outcome === 'draft' ? 0 : 1;
}

main()
  .then((code) => {
    process.exitCode = code;
  })
  .catch((err: unknown) => {
    console.error(err);
    process.exitCode = 1;
  })
  .finally(() => void pgClient.end());
