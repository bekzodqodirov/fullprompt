import { readdirSync, readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';
import { estimateUnnamed, saysTashkent, type StoredEstimate } from '@/modules/wms/agent/auto-money';
import type { NumberSource } from '@/modules/wms/agent/numbers';

/**
 * The full AI seller, part 1 — the fences migration 0148 needs, and the pure money facts the auto layer reads off
 * a reply (spec SPEC-P1-v2 §1.1, §1.8, §6). Each fence is DERIVED from the files it guards, so a kind, a table or
 * a migration added next month is caught the day it lands.
 */

const MIGRATIONS = 'src/modules/platform/db/migrations';
const strip = (src: string) => src.replace(/\/\*[\s\S]*?\*\//g, '').replace(/(^|[^:])\/\/.*$/gm, '$1');

/** The kinds named by a CHECK's IN (…) list, in a SQL text or a drizzle `sql` template. */
function inList(text: string): string[] {
  return [...text.matchAll(/'([a-z_]+)'/gu)].map((m) => m[1]!);
}

describe('the bot’s waits: the union, the schema and the last migration that re-makes the CHECK say the same kinds (spec §6)', () => {
  // A durable wait whose kind the CHECK refuses is swallowed with one warning (waits.ts `queueWrite`): green in
  // every test, lost at the next deploy. So the three must agree, read off the files themselves.
  const files = readdirSync(MIGRATIONS)
    .filter((f) => /^\d{4}_.*\.sql$/u.test(f))
    .sort();
  const remakes = files.filter((f) => /ADD CONSTRAINT "telegram_chat_waits_kind_check"|CONSTRAINT "telegram_chat_waits_kind_check" CHECK/u.test(readFileSync(`${MIGRATIONS}/${f}`, 'utf8')));
  const last = remakes.at(-1)!;
  const lastSql = readFileSync(`${MIGRATIONS}/${last}`, 'utf8');
  const checkSql = lastSql.slice(lastSql.lastIndexOf('"telegram_chat_waits_kind_check" CHECK'));
  const migrationKinds = inList(checkSql.slice(0, checkSql.indexOf(');') + 2));

  const waits = strip(readFileSync('src/modules/platform/telegram/waits.ts', 'utf8'));
  const union = waits.slice(waits.indexOf('export type WaitKind'), waits.indexOf(';', waits.indexOf('export type WaitKind')));
  const unionKinds = inList(union);

  const schema = readFileSync('src/modules/platform/db/schema/platform.ts', 'utf8');
  const schemaKinds = inList(/'telegram_chat_waits_kind_check',\s*sql`([^`]*)`/u.exec(schema)?.[1] ?? '');

  // The LAST re-maker, whichever it is — found, never named (tests/unit/receipt-arrival.test.ts's rule): the other
  // session re-made this CHECK in 0141 and again in 0146, and its next wait kind must not turn this file red while
  // the three derived equalities below still hold. What 0148 owes is that it re-makes the CHECK at all — a last
  // re-maker BEFORE it would mean its two waits are in no CHECK — and that the last one still names them.
  it('0148 re-makes the CHECK, and the last migration to re-make it — 0148 or a later one — names the two new waits', () => {
    expect(remakes).toContain('0148_agent_full_p1.sql');
    expect(last >= '0148_agent_full_p1.sql').toBe(true);
    expect(migrationKinds).toEqual(expect.arrayContaining(['agent_answer', 'agent_lesson']));
  });

  it('…the WaitKind union holds exactly those kinds', () => {
    expect([...unionKinds].sort()).toEqual([...migrationKinds].sort());
  });

  it('…and so does the drizzle mirror', () => {
    expect([...schemaKinds].sort()).toEqual([...migrationKinds].sort());
  });

  it('…and every one-text wait the agent arms is a kind the CHECK admits', () => {
    const bot = readFileSync('src/modules/platform/telegram/agent-bot.ts', 'utf8');
    const agentWaits = inList(bot.slice(bot.indexOf('const AGENT_WAITS'), bot.indexOf('as const', bot.indexOf('const AGENT_WAITS'))));
    expect(agentWaits.length).toBeGreaterThan(0);
    for (const kind of agentWaits) expect(migrationKinds, kind).toContain(kind);
  });
});

describe('0148 adds no column to anything that existed (0138’s rule, spec §5.2)', () => {
  const src = readFileSync(`${MIGRATIONS}/0148_agent_full_p1.sql`, 'utf8');

  it('no ADD COLUMN anywhere — a whole-row reader one migration behind names exactly what it named', () => {
    expect(src).not.toMatch(/ADD\s+COLUMN/iu);
  });

  // Found by its TAG, never by «the last two»: the next migration must not turn this red (the other
  // session took 0146 and 0147 while this round was being built — the thirty-eighth collision).
  it('the journal carries it as the 148th, one tick after 0147', () => {
    const journal = JSON.parse(readFileSync(`${MIGRATIONS}/meta/_journal.json`, 'utf8')) as { entries: { idx: number; tag: string; when: number }[] };
    const at = journal.entries.findIndex((e) => e.tag === '0148_agent_full_p1');
    const mine = journal.entries[at];
    const prev = journal.entries[at - 1];
    expect(mine).toMatchObject({ idx: 148, tag: '0148_agent_full_p1' });
    expect(prev).toMatchObject({ idx: 147, tag: '0147_prixod_javoblar' });
    expect(mine!.when).toBe(prev!.when + 1);
  });

  it('the stored kinds are left as they were — «Narx» ships unticked (spec §1.5)', () => {
    expect(src).not.toMatch(/UPDATE\s+"agent_auto_config"\s+SET\s+"categories"/iu);
  });
});

/** The yo'lkira tool's sources as a run stores them: the customer's measures first, then the tool's (memoryFor). */
const SOURCES: NumberSource[] = [
  { value: 5, kind: 'measure', label: 'mijoz #1', origin: 'customer' },
  { value: 800, kind: 'measure', label: 'mijoz #1', origin: 'customer' },
  { value: 960, kind: 'money', label: "yo'lkira (sayt kalkulyatori)", origin: 'tool', tool: 'yolkira_estimate', currency: 'USD', role: 'total' },
  { value: 192, kind: 'money', label: "yo'lkira tarifi (sayt)", origin: 'tool', tool: 'yolkira_estimate', currency: 'USD', role: 'rate' },
  { value: 5, kind: 'measure', label: 'mijoz #1', origin: 'tool', tool: 'yolkira_estimate' },
  { value: 800, kind: 'measure', label: 'mijoz #1', origin: 'tool', tool: 'yolkira_estimate' },
];
const TRUCK: StoredEstimate = { tool: 'yolkira_estimate', kg: 800, m3: 5, zone: 'cn', day: '2026-11-11', total: 960, rate: 192, unit: 'm3' };
const AVIA: StoredEstimate = { tool: 'avia_estimate', kg: 30, m3: null, zone: null, day: '2026-11-11', total: 510, rate: 17, unit: 'kg' };
const AVIA_SOURCES: NumberSource[] = [
  { value: 30, kind: 'measure', label: 'mijoz #1', origin: 'customer' },
  { value: 510, kind: 'money', label: 'avia (tarif × kg)', origin: 'tool', tool: 'avia_estimate', currency: 'USD', role: 'total' },
  { value: 17, kind: 'money', label: 'avia tarifi', origin: 'tool', tool: 'avia_estimate', currency: 'USD', role: 'rate' },
];

describe('`estimate_unnamed` — the price restates the load it priced (spec §1.1)', () => {
  const unnamed = (body: string, estimates: StoredEstimate[] = [TRUCK], sources = SOURCES) => estimateUnnamed(body, { sources, estimates });

  it('the money sentence carrying the call’s kub and kg names it', () => {
    expect(unnamed('5 kub, 800 kg yukingiz uchun Toshkentgacha taxminan 960 $.')).toBe(false);
    expect(unnamed('Toshkentgacha taxminan 960 $ — 5 kub va 800 kg uchun.')).toBe(false);
    // The rate in the same sentence as the load.
    expect(unnamed('5 kub, 800 kg: har kub uchun 192 $, jami taxminan 960 $.')).toBe(false);
    // A decimal point is no sentence's end.
    const half: StoredEstimate = { ...TRUCK, m3: 1.5, kg: 300, total: 240 };
    const halfSources: NumberSource[] = [
      { value: 1.5, kind: 'measure', label: 'mijoz #1', origin: 'customer' },
      { value: 300, kind: 'measure', label: 'mijoz #1', origin: 'customer' },
      { value: 240, kind: 'money', label: "yo'lkira", origin: 'tool', tool: 'yolkira_estimate', currency: 'USD', role: 'total' },
    ];
    expect(unnamed('1.5 kub, 300 kg uchun taxminan 240 $.', [half], halfSources)).toBe(false);
  });

  it('a price with no load beside it is unnamed — in a two-load chat it reads as the price of everything', () => {
    expect(unnamed('Yukingiz taxminan 960 $ bo‘ladi.')).toBe(true);
    // Half the load: the cubes without the kilos, the kilos without the cubes.
    expect(unnamed('5 kub yukingiz uchun taxminan 960 $.')).toBe(true);
    expect(unnamed('800 kg yukingiz uchun taxminan 960 $.')).toBe(true);
    // The load said, then the price in the NEXT sentence.
    expect(unnamed('5 kub, 800 kg yukingizni hisobladim. Taxminan 960 $ bo‘ladi.')).toBe(true);
  });

  it('two loads priced: each price beside its own load — another load’s kilos name nothing', () => {
    const second: StoredEstimate = { ...TRUCK, kg: 2000, m3: 10, total: 1700, rate: 170 };
    const both = [
      ...SOURCES,
      { value: 10, kind: 'measure' as const, label: 'mijoz #2', origin: 'customer' as const },
      { value: 2000, kind: 'measure' as const, label: 'mijoz #2', origin: 'customer' as const },
      { value: 1700, kind: 'money' as const, label: "yo'lkira", origin: 'tool' as const, tool: 'yolkira_estimate', currency: 'USD' as const, role: 'total' as const },
    ];
    expect(unnamed('5 kub, 800 kg uchun taxminan 960 $. 10 kub, 2000 kg uchun taxminan 1700 $.', [TRUCK, second], both)).toBe(false);
    expect(unnamed('10 kub, 2000 kg uchun taxminan 960 $.', [TRUCK, second], both)).toBe(true);
  });

  it('the flight names its kilos alone', () => {
    expect(unnamed('30 kg yukingiz uchun Toshkentgacha avia taxminan 510 $.', [AVIA], AVIA_SOURCES)).toBe(false);
    expect(unnamed('Avia taxminan 510 $ bo‘ladi.', [AVIA], AVIA_SOURCES)).toBe(true);
  });

  it('no stored estimates: not asked here (the gate refuses such a draft `money` on its own)', () => {
    expect(unnamed('Yukingiz taxminan 960 $ bo‘ladi.', [])).toBe(false);
  });
});

describe('`destination_unsaid` reads «to Tashkent» in the six languages (spec §1.8)', () => {
  it.each([
    'Toshkentgacha taxminan 960 $',
    'Toshkent shahrigacha taxminan 960 $',
    'Toshkentga yetkazish taxminan 960 $',
    'Тошкентгача тахминан 960 $',
    'до Ташкента примерно 960 $',
    'до г. Ташкента примерно 960 $',
    'About $960 to Tashkent',
    '运到塔什干大约960美元',
    'تا تاشکند حدود ۹۶۰ دلار',
  ])('«%s» says it', (body) => {
    expect(saysTashkent(body)).toBe(true);
  });

  it.each(['Taxminan 960 $', 'Andijongacha taxminan 960 $', 'Toshkentdan Andijonga taxminan 960 $', 'Ташкентский склад', 'Tashkentbound'])(
    '«%s» does not',
    (body) => {
      expect(saysTashkent(body)).toBe(false);
    },
  );
});
