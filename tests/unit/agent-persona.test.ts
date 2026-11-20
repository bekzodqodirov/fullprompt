import { readFileSync } from 'node:fs';
import ts from 'typescript';
import { describe, expect, it } from 'vitest';
import type { AgentContext, ChatMessage } from '@/modules/wms/agent/context';
import { OWNER_WORD, personaWordsOf } from '@/modules/wms/agent/persona';
import { AI_HONEST_LINE, checkAgentReply, type PolicyInput } from '@/modules/wms/agent/policy';
import { stableHead } from '@/modules/wms/agent/prompt';
import { withBotAnswer, type ComposeReply } from '@/modules/wms/agent/run';

/**
 * Who the AI is (stage 1a P3, §4.4 and §6.1, his answer 1 and 1 b): the persona's name comes from its setting through
 * `stableHead`'s argument and from nowhere else; the person above it is ONE word at every site the model reads (design
 * §11.2 — nobody is named in code, so this file names nobody either); «botmisiz?» is answered by the code on both run
 * paths, even when the model wrote nothing; and the persona's own name is no colleague named.
 */

const head = (persona: string) => stableHead({ styleGuide: null, facts: [], priceArmed: false, calcPricing: false, lessons: [], persona });

/** A file's source with comments taken out (#725: a fence must never match the sentence explaining itself). */
function code(path: string): ts.SourceFile {
  return ts.createSourceFile(path, readFileSync(path, 'utf8'), ts.ScriptTarget.Latest, true);
}

/** Every use of an identifier in a file — imports and its own declaration left out. */
function uses(file: ts.SourceFile, name: string): number {
  let n = 0;
  const walk = (node: ts.Node) => {
    if (ts.isImportDeclaration(node)) return;
    if (ts.isVariableDeclaration(node) && ts.isIdentifier(node.name) && node.name.text === name) return;
    if (ts.isIdentifier(node) && node.text === name) n += 1;
    ts.forEachChild(node, walk);
  };
  walk(file);
  return n;
}

/** Every string a file's code holds — literals and the text of templates — never its comments. */
function strings(file: ts.SourceFile): string[] {
  const out: string[] = [];
  const walk = (node: ts.Node) => {
    if (ts.isStringLiteral(node) || ts.isNoSubstitutionTemplateLiteral(node)) out.push(node.text);
    else if (ts.isTemplateExpression(node)) out.push(node.head.text, ...node.templateSpans.map((s) => s.literal.text));
    ts.forEachChild(node, walk);
  };
  walk(file);
  return out;
}

const AGENT = 'src/modules/wms/agent';

/** The sites that named the owner (§4.4's list, re-counted on this tree): file → uses of `OWNER_WORD`. */
const OWNER_SITES: Record<string, number> = {
  'prompt.ts': 7,
  'tools.ts': 5,
  'owner-answer.ts': 2,
  'lessons.ts': 1,
  'lesson-rules.ts': 1,
  'policy.ts': 1,
};

describe('the persona: its name is the setting\'s, through the head\'s argument and nowhere else', () => {
  it('no name — «sotuv menejeri», no «isming»; a name — said once, as given', () => {
    expect(head('')).toContain('kompaniyasining sotuv menejerisan — kompaniyaning AI yordamchisi.');
    expect(head('')).not.toContain('isming');
    const named = head('Zarina Qo‘ziyeva');
    expect(named.split('isming — Zarina Qo‘ziyeva').length).toBe(2);
    expect(named).toContain("O'zingni hech qachon odam dema.");
  });

  it('the head speaks of the AI in its own person, never as somebody\'s draft writer', () => {
    const h = head('');
    expect(h).not.toMatch(/QORALAMA/u);
    expect(h).toMatch(/Maqsading — mijozning yukini biz orqali jo'natishiga yordam berish/u);
  });

  it('no name is written in prompt.ts — the head\'s text holds no capitalised word the argument did not bring', () => {
    // Every name-like word of the head with no persona is a word of the company or the trade, listed by the head itself.
    const first = head('').split('\n')[0]!;
    const capitals = first.match(/\p{Lu}\p{Ll}{2,}/gu) ?? [];
    expect(capitals.every((w) => ['Sen', 'Xitoy', 'Mijozlarga', 'Telegramda', 'Maqsading', 'O\'zbekiston'].includes(w)), capitals.join(',')).toBe(true);
  });
});

describe('the person above the AI: ONE exported word at every site the model reads', () => {
  it('every site interpolates `OWNER_WORD` — counted with TypeScript\'s parser, comments never counted', () => {
    for (const [file, n] of Object.entries(OWNER_SITES)) expect(uses(code(`${AGENT}/${file}`), 'OWNER_WORD'), file).toBe(n);
    expect(Object.values(OWNER_SITES).reduce((a, b) => a + b, 0)).toBe(17);
  });

  it('…and none of those files spells the word itself: an inlined site would leave the count and still read the same', () => {
    for (const file of Object.keys(OWNER_SITES)) {
      const held = strings(code(`${AGENT}/${file}`)).filter((s) => s.toLowerCase().includes(OWNER_WORD));
      expect(held, file).toEqual([]);
    }
  });

  it('the word is a position, never a person: lower case, one word', () => {
    expect(OWNER_WORD).toMatch(/^\p{Ll}+$/u);
  });
});

let seq = 0;
const line = (body: string): ChatMessage => {
  seq += 1;
  return {
    ref: `#${seq}`,
    id: `00000000-0000-4000-8000-${String(seq).padStart(12, '0')}`,
    tgMessageId: BigInt(seq),
    direction: 'in',
    media: null,
    fileName: null,
    sentAt: new Date('2026-11-20T07:00:00Z'),
    autoSent: false,
    editedAt: null,
    body,
  };
};

const ctxOf = (texts: readonly string[], storedLocale: AgentContext['storedLocale'] = null, script: AgentContext['customerScript'] = 'latin') => {
  const messages = texts.map(line);
  return { burst: messages, anchor: messages.at(-1)!, messages, storedLocale, customerScript: script };
};

const compose = (replyText: string, language: ComposeReply['language'] = 'uz', glossUz = ''): ComposeReply => ({
  replyNeeded: replyText !== '',
  replyText,
  language,
  glossUz,
  category: 'faq',
  confidence: 0.9,
  needsOwner: false,
  ownerQuestion: '',
  nextStep: 'wait',
  actions: [],
  usedFactIds: [],
  citedMessageRefs: [],
});

describe('«botmisiz?» answered by the code (his 1 b): `withBotAnswer`', () => {
  it('the honest line goes in front of the reply, once — and marks the reply a tayyor matn', () => {
    const c = withBotAnswer(compose('Yukingiz qayerdan jo‘natiladi?'), ctxOf(['Siz botmisiz? Yuk bor edi']));
    expect(c.replyText).toBe(`${AI_HONEST_LINE.uz.text}\nYukingiz qayerdan jo‘natiladi?`);
    expect(c.honestLine).toBe(true);
    // Run twice: still once.
    expect(withBotAnswer(c, ctxOf(['Siz botmisiz? Yuk bor edi'])).replyText).toBe(c.replyText);
  });

  it('a burst that is ONLY the question: the model\'s «reply_needed=false» becomes the honest line, never `no_reply`', () => {
    const c = withBotAnswer({ ...compose(''), replyNeeded: false }, ctxOf(['Siz botmisiz?']));
    expect(c).toMatchObject({ replyNeeded: true, replyText: AI_HONEST_LINE.uz.text, language: 'uz', honestLine: true });
    // In the chat's own language when it said one; by its script when it did not.
    expect(withBotAnswer({ ...compose(''), replyNeeded: false }, ctxOf(['Вы бот?'], 'ru', 'cyrillic')).replyText).toBe(AI_HONEST_LINE.ru.text);
    const fa = withBotAnswer({ ...compose(''), replyNeeded: false }, ctxOf(['شما ربات هستید؟'], null, 'arabic'));
    expect(fa).toMatchObject({ language: 'fa', replyText: AI_HONEST_LINE.fa.text, glossUz: AI_HONEST_LINE.fa.glossUz });
  });

  it('a Persian reply keeps a gloss that covers the line too; one with no gloss stays without (its own part is unread)', () => {
    const c = withBotAnswer(compose('بار شما از کجاست؟', 'fa', 'Yukingiz qayerdan?'), ctxOf(['شما ربات هستید؟'], 'fa', 'arabic'));
    expect(c.replyText.startsWith(AI_HONEST_LINE.fa.text)).toBe(true);
    expect(c.glossUz).toBe(`${AI_HONEST_LINE.fa.glossUz}\nYukingiz qayerdan?`);
    expect(withBotAnswer(compose('بار شما از کجاست؟', 'fa', ''), ctxOf(['شما ربات هستید؟'], 'fa', 'arabic')).glossUz).toBe('');
  });

  it('no question, no line — boots, Dubai and a robot vacuum are goods (J6)', () => {
    for (const t of ['Ботинки сколько стоит?', 'Yuk Dubaimi?', '扫地机器人5立方多少钱？', 'Narxi qancha?']) {
      const c = compose('Javob');
      expect(withBotAnswer(c, ctxOf([t])), t).toBe(c);
    }
  });

  it('the line passes the policy in every language — no `ai_denial`, no block', () => {
    for (const [l, { text }] of Object.entries(AI_HONEST_LINE)) {
      const r = checkAgentReply({ ...POLICY_BASE, body: text, language: l as ComposeReply['language'], customerScript: l === 'fa' ? 'arabic' : l === 'zh' ? 'han' : l === 'ru' || l === 'uz_cyrl' ? 'cyrillic' : 'latin' });
      expect(r.blocks, `${l} «${text}»`).toEqual([]);
      expect(r.warnings, `${l} «${text}»`).toEqual([]);
    }
  });

  it('both run paths call it on the avia rule\'s draft, before the empty-reply test and before the policy', () => {
    const src = readFileSync(`${AGENT}/run.ts`, 'utf8').replace(/\/\*[\s\S]*?\*\/|\/\/[^\n]*/gu, '');
    for (const fn of ['export async function handleInbound', 'export async function runOwnerTriggered']) {
      const start = src.indexOf(fn);
      const body = src.slice(start, src.indexOf('\nexport ', start + fn.length));
      const at = body.indexOf('withBotAnswer(withAviaRule(withRailRule(loop.compose, ctx), loop, ctx, act), ctx)');
      expect(at, fn).toBeGreaterThan(0);
      expect(at, fn).toBeLessThan(body.indexOf('if (!drafted.replyNeeded && !drafted.needsOwner)'));
      expect(at, fn).toBeLessThan(body.indexOf('await policyFor('));
      // …and the persona's name is read once for that run and handed to the loop.
      expect(body, fn).toMatch(/readAgentPersonaName\(\)/u);
    }
  });
});

const POLICY_BASE: PolicyInput = {
  body: '',
  language: 'uz',
  customerScript: 'latin',
  numberSources: [],
  removeWhole: [],
  ownCodes: [],
  bookCodes: new Set(),
  codePrefix: 'GS',
  allowedPhones: [],
  allowedUrls: [],
  mapUrls: [],
  askedLocation: false,
  staffNames: [],
  customerNames: [],
  canary: 'gsr-test',
  fingerprintPeers: 0,
  urlsToChat7d: 0,
  urlsToday: 0,
  hasEstimate: false,
  fromOurWarehouse: false,
  hasGloss: true,
};

describe('the persona\'s own name is no colleague named (§4.4: the AI seat makes the owner a colleague)', () => {
  const staff = ['Zarina Qo‘ziyeva', 'Bobur Aliyev'];
  const judge = (body: string, personaName?: string) =>
    checkAgentReply({ ...POLICY_BASE, body, staffNames: staff, ...(personaName === undefined ? {} : { personaName }) });

  it('«men … Zarinaman» warns nothing when the persona is Zarina', () => {
    const r = judge('Assalomu alaykum! Men GSR sotuv menejeri Zarinaman. Yukingiz qayerdan?', 'Zarina');
    expect(r.warnings.filter((w) => w.code === 'staff_name')).toEqual([]);
    expect(r.ok).toBe(true);
  });

  it('…with no persona the same word is a colleague\'s and warns, as it always did', () => {
    const r = judge('Assalomu alaykum! Men GSR sotuv menejeri Zarinaman. Yukingiz qayerdan?');
    expect(r.warnings).toContainEqual(expect.objectContaining({ code: 'staff_name' }));
  });

  it('the colleague\'s FULL name still blocks, and any other colleague\'s name still warns', () => {
    expect(judge('Zarina Qo‘ziyeva sizga yozadi.', 'Zarina').blocks).toContainEqual(expect.objectContaining({ code: 'staff_name' }));
    expect(judge('Bobur sizga qo‘ng‘iroq qiladi.', 'Zarina').warnings).toContainEqual(expect.objectContaining({ code: 'staff_name', detail: 'Bobur' }));
  });

  it('the persona\'s words: each word of the name, nothing else', () => {
    expect(personaWordsOf('  Zarina   Qo‘ziyeva ')).toEqual(['Zarina', 'Qo‘ziyeva']);
    expect(personaWordsOf('')).toEqual([]);
  });
});
