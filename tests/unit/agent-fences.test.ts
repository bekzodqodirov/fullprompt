import { readdirSync, readFileSync, statSync } from 'node:fs';
import { join } from 'node:path';
import { getTableColumns, getTableName } from 'drizzle-orm';
import { describe, expect, it } from 'vitest';
import * as schema from '@/modules/platform/db/schema';
import { isTelegramMuted, UNMUTABLE_TYPES } from '@/modules/platform/notifications/mutes';
import { AGENT_OPS, buttonsFor, parseCallback } from '@/modules/platform/telegram/staff-bot';
import { PURGED_TABLES } from '@/modules/wms/agent/purge';
import { TOOL_SPECS } from '@/modules/wms/agent/tools';

/**
 * The AI sotuvchi's fences — each derived from the code it guards, so a file
 * or a table added next month is caught the day it lands.
 */

function filesUnder(dir: string): string[] {
  return readdirSync(dir).flatMap((name) => {
    const p = join(dir, name);
    return statSync(p).isDirectory() ? filesUnder(p) : /\.tsx?$/.test(name) ? [p] : [];
  });
}

const strip = (src: string) => src.replace(/\/\*[\s\S]*?\*\//g, '').replace(/(^|[^:])\/\/.*$/gm, '$1');

describe('the agent reads nothing wider than its own chat (review leak-11)', () => {
  const FORBIDDEN = ['platform/ai/tools', 'platform/ai/sql-runner', 'wms/bot/lookup', 'wms/search'];
  const files = filesUnder('src/modules/wms/agent');

  it('no file under wms/agent imports the staff toolset, the SQL runner, the staff lookup or the search', () => {
    expect(files.length).toBeGreaterThan(10);
    for (const file of files) {
      const src = strip(readFileSync(file, 'utf8'));
      for (const bad of FORBIDDEN) {
        const re = new RegExp(`from\\s+['"][^'"]*${bad.replace('/', '\\/')}['"]|import\\(\\s*['"][^'"]*${bad.replace('/', '\\/')}['"]`);
        expect(re.test(src), `${file} imports ${bad}`).toBe(false);
      }
    }
  });

  it('the toolset is the closed list the review agreed', () => {
    expect(TOOL_SPECS.map((t) => t.name).sort()).toEqual(
      // avia_estimate: his 2026-10-24 rate × the customer's kilos (§17.14).
      ['avia_estimate', 'calc_checklist', 'cargo_status', 'cargo_volume', 'compose_reply', 'kb_search', 'own_balance', 'yolkira_estimate'].sort(),
    );
    // compose_reply is the strict terminal one; nothing takes a client id or a code.
    expect(TOOL_SPECS.find((t) => t.name === 'compose_reply')!.strict).toBe(true);
    for (const t of TOOL_SPECS) {
      const props = Object.keys((t.input_schema as { properties: Record<string, unknown> }).properties);
      for (const p of props) expect(/client|code|phone|peer/i.test(p), `${t.name}.${p}`).toBe(false);
    }
  });
});

describe('a purged chat takes every agent copy with it (review leak-9)', () => {
  /** Tables keyed by (account, Telegram person) that the purge treats on purpose elsewhere. */
  const HANDLED_ELSEWHERE: Record<string, string> = {
    tg_messages: 'purgeExcludedChat deletes them itself',
    tg_outbox: 'kept deliberately — a queue record, not the conversation (round 22)',
    tg_chat_rules: 'the exclude decision IS the rule',
    tg_chat_reads: 'a read pointer, no text',
    tg_peer_index: 'a phone hash, no text',
  };

  it('every table with manager_user_id + peer_id is named by the purge or by a reason', () => {
    const keyed: string[] = [];
    for (const value of Object.values(schema)) {
      if (!value || typeof value !== 'object' || !(Symbol.for('drizzle:IsDrizzleTable') in (value as object))) continue;
      const cols = (Object.values(getTableColumns(value as never)) as { name: string }[]).map((c) => c.name);
      if (cols.includes('manager_user_id') && cols.includes('peer_id')) keyed.push(getTableName(value as never));
    }
    expect(keyed).toContain('agent_drafts');
    for (const table of keyed) {
      const named = (PURGED_TABLES as readonly string[]).includes(table) || table in HANDLED_ELSEWHERE;
      expect(named, `${table} is keyed by chat and the purge does not name it`).toBe(true);
    }
  });

  it('every agent card type is blanked by the purge, or is about no chat (review I5)', () => {
    /** Types that name an account or a day, never one customer's chat. */
    const NO_CHAT: Record<string, string> = {
      AgentCapReached: "the day's cap — no customer in it",
      AgentForcedOff: 'the account switched itself off — no customer in it',
      TgAccountPaused: 'the account was limited — no customer in it',
    };
    const src = strip(readFileSync('src/modules/wms/agent/purge.ts', 'utf8'));
    const where = src.slice(src.indexOf('function chatCardsWhere'), src.indexOf('export async function purgeAgentChat'));
    expect(where.length, 're-anchor: chatCardsWhere').toBeGreaterThan(100);
    for (const type of UNMUTABLE_TYPES) {
      const named = where.includes(`'${type}'`) || type in NO_CHAT;
      expect(named, `${type} can quote a chat and the purge does not blank it`).toBe(true);
    }
  });

  it('every AgentNotice writer names the chat by the very key the purge matches a notice by (identity review)', () => {
    const purge = strip(readFileSync('src/modules/wms/agent/purge.ts', 'utf8'));
    const where = purge.slice(purge.indexOf('function chatCardsWhere'), purge.indexOf('export async function purgeAgentChat'));
    const clause = where.slice(where.indexOf("'AgentNotice'"));
    const key = /payload\}->>'([a-zA-Z]+)' = \$\{String\(input\.peerId\)\}/u.exec(clause)?.[1];
    expect(key, 're-anchor: the purge’s AgentNotice clause').toBeTruthy();
    const writers = filesUnder('src').filter((file) => /type:\s*'AgentNotice'/u.test(strip(readFileSync(file, 'utf8'))));
    expect(writers.length, 're-anchor: an AgentNotice writer').toBeGreaterThan(0);
    for (const file of writers) {
      const src = strip(readFileSync(file, 'utf8'));
      for (const at of [...src.matchAll(/type:\s*'AgentNotice'/gu)].map((m) => m.index!)) {
        // The call's own object: from the type to the call's closing «})».
        const call = src.slice(at, src.indexOf('})', at));
        expect(call, `${file}: an AgentNotice without the chat the purge finds it by`).toMatch(
          new RegExp(`extra:\\s*\\{[^}]*\\b${key}:\\s*String\\(`, 'u'),
        );
      }
    }
  });

  it('purgeExcludedChat calls the agent purge before it deletes the messages', () => {
    const src = strip(readFileSync('src/modules/wms/crm/chat-rules.ts', 'utf8'));
    const body = src.slice(src.indexOf('export async function purgeExcludedChat'));
    expect(body.indexOf('purgeAgentChat(')).toBeGreaterThan(0);
    expect(body.indexOf('purgeAgentChat(')).toBeLessThan(body.indexOf('db.delete(tgMessages)'));
  });
});

describe('platform still reaches wms only by dynamic import', () => {
  it('the static platform → wms imports are exactly the two that predate this round', () => {
    const offenders = filesUnder('src/modules/platform').filter((file) =>
      /^import[^;]*from\s+['"][^'"]*\/wms\//m.test(strip(readFileSync(file, 'utf8'))),
    );
    expect(offenders.map((f) => f.replace(/^src\/modules\/platform\//, '')).sort()).toEqual(
      ['telegram/bot.ts', 'telegram/client-cabinet.ts'].sort(),
    );
  });
});

describe('the agent’s cards cannot be muted (his Q16 ⭐)', () => {
  it('not by name, not by group, not by «all»', () => {
    for (const type of UNMUTABLE_TYPES) {
      expect(isTelegramMuted(['all'], type), type).toBe(false);
      expect(isTelegramMuted([type], type), type).toBe(false);
    }
    // …and everything else still mutes as before.
    expect(isTelegramMuted(['all'], 'TaskAssigned')).toBe(true);
  });
});

describe('the ag: grammar', () => {
  it('parses every op with a uuid, the digest only as eight hex', () => {
    const id = '0f1e2d3c-4b5a-4968-8776-655443322110';
    for (const op of AGENT_OPS) expect(parseCallback(`ag:${op}:${id}`)).toEqual({ kind: 'agent', op, id });
    expect(parseCallback(`ag:s:${id}:a1b2c3d4`)).toEqual({ kind: 'agent', op: 's', id, digest: 'a1b2c3d4' });
    expect(parseCallback(`ag:s:${id}:zzzz`)).toBeNull();
    expect(parseCallback(`ag:q:${id}`)).toBeNull();
    // The old approval grammar is untouched.
    expect(parseCallback(`a:1:${id}`)).toMatchObject({ kind: 'approval' });
  });
});

describe('the stranger and echo cards (review I1)', () => {
  const rule = '0f1e2d3c-4b5a-4968-8776-655443322110';
  const client = '019a2b3c-4d5e-7f00-8a1b-2c3d4e5f6071';

  it('both echo buttons carry the echoed client’s tail, and both parse', () => {
    const rows = buttonsFor('AgentCodeEcho', { ruleId: rule, clientId: client, text: 'x' })!;
    const data = rows.flat().map((b) => ('callback_data' in b ? b.callback_data : ''));
    expect(data).toEqual([`ag:c:${rule}:4e5f6071`, `ag:b:${rule}:4e5f6071`]);
    for (const d of data) expect(parseCallback(d)).toMatchObject({ kind: 'agent', id: rule, digest: '4e5f6071' });
  });

  it('a closed card draws no buttons — not the echo, not the stranger card', () => {
    expect(buttonsFor('AgentCodeEcho', { ruleId: rule, clientId: client, text: 'x', live: false })).toBeNull();
    expect(buttonsFor('AgentStranger', { ruleId: rule, text: 'x', live: false })).toBeNull();
    expect(buttonsFor('AgentStranger', { ruleId: rule, text: 'x' })).not.toBeNull();
  });

  it('a purged calculation answer offers no price — «💵» would arm a wait whose link is gone', () => {
    const answer = { requestId: rule, priceable: true, text: 'x' };
    expect(buttonsFor('AgentCalcAnswered', answer)).not.toBeNull();
    expect(buttonsFor('AgentCalcAnswered', { ...answer, live: false })).toBeNull();
  });
});

describe('a general fact refuses a name by any word of it (review I3)', () => {
  it('«Laylo opa» is Laylo Karimova’s; a bare number, a two-letter word and a stranger are not', async () => {
    const { nameNeedles, personalBits } = await import('@/modules/wms/agent/kb');
    expect(personalBits('Laylo opa, yakshanba dam olamiz.', ['Laylo Karimova'])).toContain('Laylo');
    expect(personalBits('Karimova xonim, dam olamiz.', ['Laylo Karimova'])).toContain('Karimova');
    expect(personalBits('Yakshanba ombor dam oladi.', ['Laylo Karimova', 'Shahzod Aliyev 123456', null])).toEqual([]);
    // The whole name, then its words of three or more characters with a letter
    // (never «Bo», «Li» or «777»); the apostrophe stays inside a name.
    expect(nameNeedles(['Bo Li 777', "O'ktam Ali"])).toEqual(["O'ktam Ali", 'Bo Li 777', "O'ktam", 'Ali']);
    expect(personalBits('ktam yozdi', ["O'ktam"])).toEqual([]);
  });

  it('…and by the name as a customer is actually greeted: a suffix on it, in Cyrillic, with any apostrophe', async () => {
    const { maskForModel, personalBits } = await import('@/modules/wms/agent/kb');
    const names = ['Shahzod Aliyev', 'Laylo Karimova', "O'ktam Xo'jayev", 'Ali Valiyev'];
    // The reviewer's four, each of which a whole-word match let through.
    expect(personalBits('Shahzodjon, yakshanba ombor dam oladi.', names)).toContain('Shahzod');
    expect(personalBits('Layloxon opa, yakshanba ombor dam oladi.', names)).toContain('Laylo');
    expect(personalBits('Шахзод ака, якшанба омбор дам олади.', names)).toContain('Shahzod');
    expect(personalBits('Oʻktam aka, yakshanba ombor dam oladi.', names)).toContain("O'ktam");
    expect(personalBits('Хўжаев ака, дам оламиз.', names)).toContain("Xo'jayev");
    // A three-letter name takes only a name's endings: «Alijon» is Ali, «Alibaba» is not.
    expect(personalBits('Alijon aka, dam olamiz.', names)).toContain('Ali');
    expect(personalBits('Alibaba orqali buyurtma bering.', names)).toEqual([]);
    expect(personalBits('Yakshanba ombor dam oladi.', names)).toEqual([]);
    // The mask covers the word as it was written, suffix and script included.
    expect(maskForModel('Шахзоджон, salom', names)).toBe('[ism], salom');
  });

  it('the 📌 yes is a button on the question with an eight-hex token — the one the parser takes', async () => {
    const src = strip(readFileSync('src/modules/wms/agent/bot-door.ts', 'utf8'));
    expect(src).toMatch(/callback_data: `ag:g:\$\{draftId\}:\$\{token\}`/);
    expect(src).toMatch(/randomBytes\(4\)\.toString\('hex'\)/);
    expect(parseCallback('ag:g:0f1e2d3c-4b5a-4968-8776-655443322110:a1b2c3d4')).toMatchObject({ op: 'g', digest: 'a1b2c3d4' });
  });
});

describe('a code is one token on a carton — never «word + number», never a piece of a link (answers review)', () => {
  it('the company’s own seeded facts carry no personal bit', async () => {
    const { personalBits } = await import('@/modules/wms/agent/kb');
    const { SEED_FACTS } = await import('@/modules/wms/agent/seed-kb');
    for (const key of ['min_shipment@1', 'tashkent_map@1', 'avia@1', 'certificate@1', 'transit@1']) {
      const f = SEED_FACTS.find((s) => s.key === key)!;
      expect(personalBits(`${f.question}\n${f.answer}`), key).toEqual([]);
    }
    expect(personalBits('Avto orqali eng kamida 1 kub yoki 100 kg dan yuk qabul qilamiz.')).toEqual([]);
    expect(personalBits('Xarita: https://yandex.uz/maps/-/CXQr78ni yoki yandex.uz/maps/-/AB12cd')).toEqual([]);
  });

  it('…while a customer’s code is still refused, however it is written and wherever it stands', async () => {
    const { personalBits } = await import('@/modules/wms/agent/kb');
    expect(personalBits('GS555 ning yuki keldi.')).toEqual(['GS555']);
    expect(personalBits('kod: gs555')).toEqual(['GS555']);
    expect(personalBits('(GS-555) yuki')).toEqual(['GS555']);
    expect(personalBits('Ｇｓ５５５ yuki')).toEqual(['GS555']);
    // A link beside it hides nothing outside it.
    expect(personalBits('https://yandex.uz/maps/-/CXQr78ni — GS555 uchun')).toEqual(['GS555']);
  });

  it('writeKbFact is the one writer of a fact — the page’s ✎ included', () => {
    const offenders = filesUnder('src').filter((file) => /\.insert\(\s*kbFacts\s*\)/u.test(strip(readFileSync(file, 'utf8'))));
    expect(offenders).toEqual(['src/modules/wms/agent/kb.ts']);
  });
});

describe('a short reference is taken from the id’s random tail', () => {
  it('two facts minted the same minute (one v7 clock head) get different refs', async () => {
    const { kbRef } = await import('@/modules/wms/agent/kb');
    const a = '019a2b3c-4d5e-7f00-8a1b-2c3d4e5f6071';
    const b = '019a2b3c-4d5e-7f00-9b2c-3d4e5f607182';
    expect(kbRef(a)).not.toBe(kbRef(b));
  });
});
