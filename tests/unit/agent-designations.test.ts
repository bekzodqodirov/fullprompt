import { existsSync, readdirSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import ts from 'typescript';
import { describe, expect, it } from 'vitest';
import en from '../../messages/en.json';
import ru from '../../messages/ru.json';
import uz from '../../messages/uz.json';
import zh from '../../messages/zh-CN.json';
import { UNMUTABLE_TYPES } from '@/modules/platform/notifications/mutes';
import { NIGHT_SILENT_TYPES } from '@/modules/platform/notifications/night';
import { ROLE_CODES } from '@/modules/platform/rbac/catalog';
import { AGENT_TOPIC_KEYS, AGENT_TOPICS, isAgentTopic } from '@/modules/wms/agent/designations';

/**
 * WHO the machine tells (stage 1a §3.2, design §11.2): one table, two readers, and NOBODY named in code. These are
 * the source-shape halves; the readers' behaviour — the fallback never empty, the rows never falling back, a
 * transaction seeing its own replace-all, one migration behind — is `tests/integration/agent-designations.integration.test.ts`.
 */

const AGENT = 'src/modules/wms/agent';
const parse = (path: string, text = readFileSync(path, 'utf8')) =>
  ts.createSourceFile(path, text, ts.ScriptTarget.Latest, true, ts.ScriptKind.TS);

function visit(node: ts.Node, fn: (n: ts.Node) => void): void {
  fn(node);
  ts.forEachChild(node, (c) => visit(c, fn));
}

/** Every string the code holds — literals and template text; comments are not nodes, so they are never read (#725). */
function stringsOf(source: ts.SourceFile): string[] {
  const out: string[] = [];
  visit(source, (n) => {
    if (ts.isStringLiteral(n) || ts.isNoSubstitutionTemplateLiteral(n)) out.push(n.text);
    else if (ts.isTemplateHead(n) || ts.isTemplateMiddle(n) || ts.isTemplateTail(n)) out.push(n.text);
  });
  return out;
}

/** The demo people's FIRST names (scripts/seed-demo.ts) — the words a person's name in code would most likely be. */
function demoFirstNames(): string[] {
  const source = parse('scripts/seed-demo.ts');
  const roleWords = new Set(ROLE_CODES.flatMap((r) => r.split('_')).concat(['Admin', 'Demo', 'Logist', 'VED', 'Buxgalter', 'Viewer']).map((w) => w.toLowerCase()));
  const names: string[] = [];
  visit(source, (n) => {
    if (ts.isPropertyAssignment(n) && n.name.getText() === 'fullName' && ts.isStringLiteral(n.initializer)) {
      const first = n.initializer.text.split(/[\s(]/u)[0]!;
      if (first && !roleWords.has(first.toLowerCase())) names.push(first);
    }
  });
  return names;
}

const UUID = /[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}/iu;

/** What design §11.2 forbids in one text: a role key, an id, a person's name. */
function namedSomebody(texts: readonly string[], names: readonly string[]): string[] {
  const out: string[] = [];
  for (const text of texts) {
    for (const role of ROLE_CODES) if (new RegExp(`(^|[^a-z_])${role}([^a-z_]|$)`, 'u').test(text)) out.push(`role «${role}» in «${text}»`);
    if (UUID.test(text)) out.push(`an id in «${text}»`);
    for (const name of names) if (new RegExp(`(^|[^\\p{L}])${name}([^\\p{L}]|$)`, 'u').test(text)) out.push(`a name «${name}» in «${text}»`);
  }
  return out;
}

/** The new migration's SQL with its comments out. */
function migrationText(): string {
  const dir = 'src/modules/platform/db/migrations';
  const file = readdirSync(dir).find((f) => /_agent_toliq_1a\.sql$/u.test(f));
  expect(file, 're-anchor: the 1a migration').toBeDefined();
  return readFileSync(join(dir, file!), 'utf8').replace(/--.*$/gmu, '');
}

describe('the topics registry (§3.2)', () => {
  it('stage 1a’s two topics, each with a label and a hint in all four bundles — nothing about people', () => {
    expect(AGENT_TOPIC_KEYS).toEqual(['supervisor', 'big_cargo']);
    for (const bundle of [uz, ru, en, zh] as unknown as { agentAi: Record<string, Record<string, string>> }[]) {
      for (const topic of AGENT_TOPIC_KEYS) {
        const [labelGroup, labelKey] = AGENT_TOPICS[topic].label.split('.') as [string, string];
        const [hintGroup, hintKey] = AGENT_TOPICS[topic].hint.split('.') as [string, string];
        expect(bundle.agentAi[labelGroup]?.[labelKey], topic).toBeTypeOf('string');
        expect(bundle.agentAi[hintGroup]?.[hintKey], topic).toBeTypeOf('string');
      }
    }
    // The pair is «rahbar va o‘rinbosar» on every screen — never «nazoratchi» (contract §4, one word for one thing).
    expect((uz as unknown as { agentAi: { topic: { supervisor: string } } }).agentAi.topic.supervisor).toBe('Rahbar va o‘rinbosar');
  });

  it('a topic the registry does not know is no topic — not even an inherited property name', () => {
    for (const bad of ['', 'nazoratchi', 'callback', 'toString', '__proto__', 'constructor', 'SUPERVISOR']) expect(isAgentTopic(bad), bad).toBe(false);
    for (const topic of AGENT_TOPIC_KEYS) expect(isAgentTopic(topic)).toBe(true);
  });
});

describe('nobody is named in code (design §11.2)', () => {
  // The five files §3.2 names and the liveness alarm (lead, 2026-11-20): those a later package has not written yet
  // join the fence the day they exist.
  const FILES = ['designations.ts', 'signals.ts', 'big-cargo.ts', 'morning.ts', 'sample.ts', 'liveness.ts']
    .map((f) => join(AGENT, f))
    .filter((p) => existsSync(p));
  const names = demoFirstNames();

  it('re-anchors: the designations file is read, and the names list is not empty', () => {
    expect(FILES).toContain(join(AGENT, 'designations.ts'));
    expect(names.length).toBeGreaterThan(3);
  });

  it('no role key, no id and no person’s name in the files that address people, nor in the migration', () => {
    for (const path of FILES) expect(namedSomebody(stringsOf(parse(path)), names), path).toEqual([]);
    expect(namedSomebody([migrationText()], names), 'the 1a migration').toEqual([]);
  });

  it('…and the fence bites: a planted role, id or name is named', () => {
    const planted = parse('x.ts', `const a = ['super_admin']; const b = '0f1e2d3c-4b5a-4968-8776-655443322110'; const c = '${names[0]} aka';`);
    expect(namedSomebody(stringsOf(planted), names)).toHaveLength(3);
    // A comment is not code: the same words there are not read (#725).
    expect(namedSomebody(stringsOf(parse('y.ts', "// super_admin\nconst d = 'ok';")), names)).toEqual([]);
  });

  it('the designations never ask a role themselves: the door is setAgentSeat’s own predicate, the fallback auto-send’s reader', () => {
    const src = readFileSync(join(AGENT, 'designations.ts'), 'utf8');
    const code = stringsOf(parse(join(AGENT, 'designations.ts'))).join('\n');
    expect(code).not.toMatch(/roles/u);
    expect(src).not.toMatch(/\.roles\.includes\(/u);
    // The door: the first thing setDesignations asks.
    const set = src.slice(src.indexOf('export async function setDesignations'));
    expect(set.indexOf('mayGovernAgent(actor)'), 're-anchor: the door').toBeGreaterThan(0);
    expect(set.indexOf('mayGovernAgent(actor)')).toBeLessThan(set.indexOf('isAgentTopic(topic)'));
    // …and setAgentSeat asks the same one; the role key lives inside that predicate and nowhere in setAgentSeat.
    const config = readFileSync(join(AGENT, 'config.ts'), 'utf8');
    const seat = config.slice(config.indexOf('export async function setAgentSeat'), config.indexOf('export async function setCalcOpenLimit'));
    expect(seat).toMatch(/if \(!mayGovernAgent\(actor\)\) throw new AgentConfigError\('forbidden'\);/u);
    expect(seat).not.toMatch(/roles\.includes/u);
    const door = config.slice(config.indexOf('export function mayGovernAgent'));
    expect(door.slice(0, door.indexOf('\n}'))).toContain("actor.roles.includes('super_admin')");
    // The last fallback is the agent's alarm audience, read where its line always lived — stepDown asks the same.
    expect(src).toMatch(/agentAlarmRecipients\(holderId\)/u);
    const auto = readFileSync(join(AGENT, 'auto-send.ts'), 'utf8');
    const step = auto.slice(auto.indexOf('async function stepDown'), auto.indexOf('async function chatOff'));
    expect(step).toMatch(/userIds: await agentAlarmRecipients\(holderId\)/u);
    expect(step).not.toMatch(/usersWithRoles/u);
  });
});

/**
 * `designated()` reads the POOL (its last fallback is `usersWithRoles`, which takes no handle): inside a transaction
 * that is #714's freeze. `tests/unit/tx-pool.test.ts` is the house fence; this one names the rule for this reader,
 * over every file under agent/, so a later stage's caller is told what to do (ask before the transaction opens or
 * after it commits; inside, read `designatedRows(topic, tx)`).
 */
function designatedInsideTransactions(path: string, text?: string): string[] {
  const source = parse(path, text);
  const out: string[] = [];
  visit(source, (n) => {
    if (!ts.isCallExpression(n) || !ts.isPropertyAccessExpression(n.expression) || n.expression.name.text !== 'transaction') return;
    for (const arg of n.arguments) {
      visit(arg, (inner) => {
        if (ts.isCallExpression(inner) && ts.isIdentifier(inner.expression) && ['designated', 'designation'].includes(inner.expression.text)) {
          out.push(`${path}:${source.getLineAndCharacterOfPosition(inner.getStart()).line + 1}`);
        }
      });
    }
  });
  return out;
}

describe('designated() is asked inside no transaction under agent/ (#714)', () => {
  it('no agent file calls it in a transaction body', () => {
    const files = readdirSync(AGENT).filter((f) => f.endsWith('.ts')).map((f) => join(AGENT, f));
    expect(files.length).toBeGreaterThan(20);
    expect(files.flatMap((f) => designatedInsideTransactions(f))).toEqual([]);
  });

  it('…and the scan finds one when it is there — `designatedRows(topic, tx)` is the reader that may stand inside', () => {
    const planted = `async function f() {
      await db.transaction(async (tx) => { const who = await designated('big_cargo'); return who; });
      await db.transaction(async (tx) => designatedRows('supervisor', tx));
    }`;
    expect(designatedInsideTransactions('planted.ts', planted)).toEqual(['planted.ts:2']);
  });
});

describe('the four new cards (K4)', () => {
  it('none can be muted: each reaches only the people he chose, and a muted one is the silent failure', () => {
    for (const type of ['AgentSignal', 'AgentMorning', 'AgentSample', 'AgentLiveness']) expect(UNMUTABLE_TYPES as readonly string[]).toContain(type);
  });

  it('the signal and the sample wait for the morning without a ring; the morning line and the liveness alarm do not (his 4 a)', () => {
    expect(NIGHT_SILENT_TYPES.has('AgentSignal')).toBe(true);
    expect(NIGHT_SILENT_TYPES.has('AgentSample')).toBe(true);
    // The liveness alarm RINGS (customers waiting in working hours); the morning line is scheduled at 08:40.
    expect(NIGHT_SILENT_TYPES.has('AgentLiveness')).toBe(false);
    expect(NIGHT_SILENT_TYPES.has('AgentMorning')).toBe(false);
  });
});
