import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';
import { AVIA_DAYS_DEFAULT } from '@/modules/platform/settings/service';
import { EYE_ONLY_WARNINGS } from '@/modules/wms/agent/auto-gate';
import { customerScriptOf, type AgentContext, type ChatMessage } from '@/modules/wms/agent/context';
import { AGENT_LOCALES, type AgentLocale } from '@/modules/wms/agent/locale';
import { checkAgentReply, type PolicyInput } from '@/modules/wms/agent/policy';
import { customerLocaleOf, glossReadable, memoryFor, type ComposeReply } from '@/modules/wms/agent/run';
import {
  isSystemLine,
  SYSTEM_LINES,
  systemCardLine,
  systemGlossUz,
  systemLocaleOf,
  systemReasonOf,
  systemReasonOfLine,
  systemReplyFor,
  toldInSilence,
  type SystemLine,
} from '@/modules/wms/agent/system-reply';
import { draftWorthy, type BurstMessage } from '@/modules/wms/agent/worthy';

/**
 * The tayyor matn (stage 1a P3, docs/ai-toliq/qurish/STAGE-0-1A.md §4.4, J29): every line, in every language, passes the
 * policy a real run would put it through — on the memory `memoryFor` builds over a chat in that language, the Cyrillic
 * chat with no language and the Pashto burst included (§4.4's finding 3 and the Pashto line's letter count) — with no
 * block and no warning that stops the machine. Which line a burst gets, which language it is said in, and «once per
 * silence» are pure and judged here; the run that writes it is `agent-system-reply.integration.test.ts`.
 */

let seq = 0;
const msg = (body: string, direction: 'in' | 'out' = 'in', media: ChatMessage['media'] = null): ChatMessage => {
  seq += 1;
  return {
    ref: `#${seq}`,
    id: `00000000-0000-4000-8000-${String(seq).padStart(12, '0')}`,
    tgMessageId: BigInt(seq),
    direction,
    media,
    fileName: null,
    sentAt: new Date('2026-11-20T07:00:00Z'),
    autoSent: false,
    editedAt: null,
    body,
  };
};

/** A chat: the customer's earlier lines (the window), then the burst the line answers. */
function chat(window: readonly string[], burst: readonly ChatMessage[], storedLocale: AgentLocale | null = null): AgentContext {
  const earlier = window.map((b) => msg(b));
  const messages = [...earlier, ...burst];
  return {
    managerUserId: 'u',
    peerId: 7123n,
    messages,
    history: messages,
    anchor: messages.at(-1)!,
    burst: [...burst],
    lastOut: null,
    lastQuote: null,
    identity: { clientId: null, leadId: 'l', strength: 'lead', codes: [], customerName: null, managerName: null, cargoAllowed: false },
    storedLocale,
    customerScript: customerScriptOf(messages),
    measures: [],
    openCalcs: [],
    ruleDecision: null,
  };
}

/** What a customer writing in each language wrote before the photo — enough letters to read his language and script. */
const WINDOW: Record<AgentLocale, readonly string[]> = {
  uz: ['Assalomu alaykum', 'Guanchjoudan yuk bor, narxi qancha bo‘ladi?'],
  uz_cyrl: ['Ассалому алайкум', 'Гуанчжоудан юк бор, нархи қанча бўлади?'],
  ru: ['Здравствуйте', 'Есть груз из Гуанчжоу, сколько стоит доставка?'],
  en: ['Hello', 'I have cargo from Guangzhou, how much is the delivery?'],
  fa: ['سلام', 'از گوانگژو بار دارم، هزینه حمل چقدر است؟'],
  zh: ['你好', '我有货从广州发，运费多少钱？'],
};

const usage = { inputTokens: 0, outputTokens: 0, cacheReadTokens: 0, cacheWriteTokens: 0 };

/** The policy over a reply, on the memory a real run stores (`policyFor`'s mapping, the world read as empty). */
function judge(ctx: AgentContext, c: ComposeReply) {
  const mem = memoryFor(ctx, { compose: c, tools: [], outcomes: [], usage, aviaDays: AVIA_DAYS_DEFAULT }, [], 'gsr-test');
  const input: PolicyInput = {
    body: c.replyText,
    language: mem.language,
    customerScript: mem.customerScript,
    numberSources: mem.sources,
    removeWhole: [],
    ownCodes: mem.ownCodes,
    bookCodes: new Set(),
    codePrefix: 'GS',
    allowedPhones: mem.allowedPhones,
    allowedUrls: mem.allowedUrls,
    mapUrls: mem.mapUrls,
    askedLocation: mem.askedLocation,
    staffNames: [],
    customerNames: [],
    canary: mem.canary,
    fingerprintPeers: 0,
    urlsToChat7d: 0,
    urlsToday: 0,
    hasEstimate: mem.hasEstimate,
    fromOurWarehouse: mem.fromOurWarehouse === true,
    factNameWords: mem.factNameWords ?? [],
    askedMode: mem.askedMode ?? null,
    hasGloss: mem.hasGloss === true,
    aviaOnly: mem.aviaOnly === true,
    aviaMentioned: mem.aviaMentioned === true,
    quotableHan: mem.quotableHan ?? '',
  };
  const result = checkAgentReply(input);
  const stops = result.warnings.filter((w) => !(EYE_ONLY_WARNINGS as readonly string[]).includes(w.code));
  return { blocks: result.blocks.map((b) => `${b.code}${b.detail ? `:${b.detail}` : ''}`), stops: stops.map((w) => w.code) };
}

const withLine = (base: ComposeReply, line: SystemLine): ComposeReply => ({ ...base, replyText: line.text, glossUz: line.glossUz });

describe('every tayyor matn passes the policy a run puts it through — six languages, three wordings each', () => {
  for (const reason of ['voice', 'media'] as const) {
    for (const locale of AGENT_LOCALES) {
      it(`${reason} · ${locale}: the chat's language is read, and each wording carries no block and no stopping warning`, () => {
        const ctx = chat(WINDOW[locale], [msg('', 'in', reason === 'voice' ? 'voice' : 'photo')]);
        const picked = systemLocaleOf(customerLocaleOf(ctx).locale, ctx.customerScript);
        expect(picked).toBe(locale);
        const base = systemReplyFor({ reason, locale: picked, peerId: ctx.peerId });
        expect(base.language).toBe(locale);
        expect(SYSTEM_LINES[reason][locale]).toHaveLength(3);
        for (const line of SYSTEM_LINES[reason][locale]) {
          expect(judge(ctx, withLine(base, line)), `«${line.text}»`).toEqual({ blocks: [], stops: [] });
        }
      });
    }
  }

  it('a Cyrillic chat that said no language gets the Russian line, and it passes — the Uzbek Latin one would be `wrong_script`', () => {
    const ctx = chat(['5 куб 800 кг'], [msg('', 'in', 'photo')]);
    expect(customerLocaleOf(ctx).locale).toBeNull();
    expect(ctx.customerScript).toBe('cyrillic');
    const picked = systemLocaleOf(customerLocaleOf(ctx).locale, ctx.customerScript);
    expect(picked).toBe('ru');
    const ru = systemReplyFor({ reason: 'media', locale: picked, peerId: ctx.peerId });
    expect(judge(ctx, ru)).toEqual({ blocks: [], stops: [] });
    // The line «else uz» would have sent (§4.4 finding 3), measured: a block, a card with no ✅.
    const uz = systemReplyFor({ reason: 'media', locale: 'uz', peerId: ctx.peerId });
    expect(judge(ctx, uz).blocks.some((b) => b.startsWith('wrong_script'))).toBe(true);
  });

  it('the script decides when nothing else does: Arabic → Persian, Han → Chinese, Latin or nothing → Uzbek', () => {
    expect(systemLocaleOf(null, 'arabic')).toBe('fa');
    expect(systemLocaleOf(null, 'han')).toBe('zh');
    expect(systemLocaleOf(null, 'latin')).toBe('uz');
    expect(systemLocaleOf(null, null)).toBe('uz');
    // A language the customer said wins over the script.
    expect(systemLocaleOf('uz_cyrl', 'cyrillic')).toBe('uz_cyrl');
  });

  it('Pashto: one line in Persian with a SHORT Russian half — Arabic dominant, so it passes against the Pashto burst', () => {
    const ctx = chat([], [msg('ستاسو بار څه وخت راځي')]);
    expect(ctx.customerScript).toBe('arabic');
    const base = systemReplyFor({ reason: 'pashto', locale: 'uz', peerId: ctx.peerId });
    expect(base.language).toBe('fa');
    for (const line of SYSTEM_LINES.pashto) {
      expect(judge(ctx, withLine(base, line)), `«${line.text}»`).toEqual({ blocks: [], stops: [] });
      // The Russian half is there, and the shorter one.
      const [fa, ru] = [(line.text.match(/\p{Script=Arabic}/gu) ?? []).length, (line.text.match(/\p{Script=Cyrillic}/gu) ?? []).length];
      expect(ru).toBeGreaterThan(0);
      expect(fa).toBeGreaterThan(ru);
    }
  });

  it('a Pashto line whose Russian half grew longer than its Persian one is judged Cyrillic — `wrong_script` (the plan\'s measurement)', () => {
    const ctx = chat([], [msg('ستاسو بار څه وخت راځي')]);
    const base = systemReplyFor({ reason: 'pashto', locale: 'fa', peerId: ctx.peerId });
    const long = { ...base, replyText: 'لطفاً به فارسی یا روسی بنویسید. Пожалуйста, напишите на русском или персидском языке.' };
    expect(judge(ctx, long).blocks.some((b) => b.startsWith('wrong_script'))).toBe(true);
  });

  it('Persian, Chinese and English lines carry an Uzbek gloss he can read; Uzbek and Russian ones need none', () => {
    for (const reason of ['voice', 'media'] as const) {
      for (const locale of ['fa', 'zh', 'en'] as const) for (const l of SYSTEM_LINES[reason][locale]) expect(glossReadable(l.glossUz), l.text).toBe(true);
      for (const locale of ['uz', 'uz_cyrl', 'ru'] as const) for (const l of SYSTEM_LINES[reason][locale]) expect(l.glossUz).toBe('');
    }
    for (const l of SYSTEM_LINES.pashto) expect(glossReadable(l.glossUz)).toBe(true);
  });

  it('the media line is neutral (J29): it asks for the information as text, never «kub and kg»', () => {
    for (const locale of AGENT_LOCALES) {
      for (const l of SYSTEM_LINES.media[locale]) expect(l.text).not.toMatch(/kub|куб|cbm|kg|кг|立方|公斤|کیلو|مکعب/iu);
    }
  });

  it('three wordings, one per chat and the same every time (G10 counts identical texts across chats)', () => {
    const pickFor = (peerId: bigint) => systemReplyFor({ reason: 'voice', locale: 'uz', peerId }).replyText;
    expect(pickFor(1001n)).toBe(pickFor(1001n));
    const seen = new Set(Array.from({ length: 40 }, (_, i) => pickFor(BigInt(5000 + i))));
    expect(seen.size).toBe(3);
  });

  it('the reply as the run hands it on: the code\'s `other`, no model rating, no act, nothing for him to answer', () => {
    const c = systemReplyFor({ reason: 'media', locale: 'uz', peerId: 1n });
    expect(c).toMatchObject({ replyNeeded: true, category: 'other', confidence: null, needsOwner: false, actions: [] });
  });
});

describe('which burst gets which line (§4.4 finding 1)', () => {
  const b = (text: string | null, media: string | null = null): BurstMessage => ({ text, media });
  const reason = (burst: BurstMessage[]) => systemReasonOf(draftWorthy(burst, false), burst);

  it('a photo or a file → the media line; voice notes → the voice line; Pashto → the Pashto line', () => {
    expect(reason([b(null, 'photo')])).toBe('media');
    expect(reason([b(null, 'document')])).toBe('media');
    expect(reason([b(null, 'voice'), b(null, 'voice')])).toBe('voice');
    expect(reason([b(null, 'audio')])).toBe('voice');
    expect(reason([b('ستاسو بار څه وخت راځي')])).toBe('pashto');
  });

  it('a voice note beside a sticker is a voice note (`draftWorthy` calls it media_only), a photo beside a voice note is a photo', () => {
    expect(draftWorthy([b(null, 'voice'), b(null, 'other')], false)).toEqual({ worthy: false, reason: 'media_only' });
    expect(reason([b(null, 'voice'), b(null, 'other')])).toBe('voice');
    expect(reason([b(null, 'voice'), b(null, 'photo')])).toBe('media');
  });

  it('stickers, round videos and files storage refused (`other`) alone get nothing, as today — and a text burst is the model\'s', () => {
    expect(reason([b(null, 'other')])).toBeNull();
    expect(reason([b(null, 'other'), b(null, 'other')])).toBeNull();
    expect(reason([b('Narxi qancha?', 'photo')])).toBeNull();
    expect(reason([b('rahmat')])).toBeNull();
  });
});

describe('once per silence', () => {
  it('our last line IS a tayyor matn — any of them, folded — and an ordinary line is not', () => {
    for (const l of [...Object.values(SYSTEM_LINES.voice).flat(), ...Object.values(SYSTEM_LINES.media).flat(), ...SYSTEM_LINES.pashto]) {
      expect(isSystemLine(l.text), l.text).toBe(true);
      expect(isSystemLine(`  ${l.text.toUpperCase()}\n`), l.text).toBe(true);
    }
    expect(isSystemLine('Assalomu alaykum! Qanday yordam bera olaman?')).toBe(false);
    expect(isSystemLine(`${SYSTEM_LINES.voice.uz[0]!.text} Narxi 800 $.`)).toBe(false);
    expect(isSystemLine(null)).toBe(false);
  });

  it('which line was said, per kind, since the silence began — read back to our first line that is not one (fix review N2)', () => {
    const media = SYSTEM_LINES.media.ru[1]!.text;
    const voice = SYSTEM_LINES.voice.uz[2]!.text;
    const pashto = SYSTEM_LINES.pashto[0]!.text;
    expect(systemReasonOfLine(media)).toBe('media');
    expect(systemReasonOfLine(voice)).toBe('voice');
    expect(systemReasonOfLine(pashto)).toBe('pashto');
    expect(systemReasonOfLine('Narxi qancha?')).toBeNull();
    // Our media line, then a photo: the media line is said, nothing else.
    expect([...toldInSilence([msg(media, 'out'), msg('', 'in', 'photo')])]).toEqual(['media']);
    // Media, then a voice line, then a photo: both said — the walk does not stop at the newest line.
    expect(new Set(toldInSilence([msg(media, 'out'), msg('', 'in', 'voice'), msg(voice, 'out'), msg('', 'in', 'photo')]))).toEqual(
      new Set(['media', 'voice']),
    );
    // A reply of ours ends the silence: the media line before it was another silence's.
    expect(toldInSilence([msg(media, 'out'), msg('3 kub', 'in'), msg('Qayerdan?', 'out'), msg('', 'in', 'photo')]).size).toBe(0);
    expect(toldInSilence([msg('', 'in', 'photo')]).size).toBe(0);
  });
});

describe('the card says what the customer sent and that the code answered (J33) — in Uzbek, «ketdi» only once it went', () => {
  it('waiting and sent', () => {
    expect(systemCardLine('voice', false, systemGlossUz('voice'))).toBe(
      `🎤 Mijoz ovozli xabar yubordi — javob — tayyor matn: «${systemGlossUz('voice')}»`,
    );
    expect(systemCardLine('media', true, systemGlossUz('media'))).toBe(`📎 Mijoz rasm yoki fayl yubordi — tayyor matn ketdi: «${systemGlossUz('media')}»`);
    expect(systemCardLine('pashto', true, systemGlossUz('pashto'))).toContain('🌐 Mijoz pushtu tilida yozdi — tayyor matn ketdi');
    for (const r of ['voice', 'media', 'pashto'] as const) expect(systemCardLine(r, false, systemGlossUz(r))).not.toContain('AI');
  });
});

describe('J10: the tayyor matn is written where the model\'s reply is — ONE draft writer in the inbound run', () => {
  it('handleInbound writes once, after the system branch has joined the model\'s', () => {
    const src = readFileSync('src/modules/wms/agent/run.ts', 'utf8').replace(/\/\*[\s\S]*?\*\/|\/\/[^\n]*/gu, '');
    const start = src.indexOf('export async function handleInbound');
    const body = src.slice(start, src.indexOf('\nexport ', start + 10));
    // The one write: `writeDraft` here, or stage 1a P1's `writeReply` (write, then the press of a reply that goes at
    // once) once the two packages meet — either way ONE call, so the tayyor matn is pressed where the model's reply is.
    const WRITE = /\bwrite(?:Draft|Reply)\(/gu;
    expect(body.match(WRITE)?.length).toBe(1);
    // The code's reply and the model's are one `loop` before anything judges them.
    expect(body).toMatch(/const loop = system\s*\?\s*systemLoop\(ctx, system\)\s*:\s*await runLoop\(/u);
    expect(body.indexOf('systemLoop(')).toBeLessThan(body.indexOf('await policyFor('));
    expect(body.indexOf('await policyFor(')).toBeLessThan(body.search(WRITE));
  });
});
