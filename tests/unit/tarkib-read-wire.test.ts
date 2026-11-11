import { readdirSync, readFileSync, statSync } from 'node:fs';
import { join } from 'node:path';
import { createTranslator } from 'next-intl';
import { afterEach, describe, expect, it, vi } from 'vitest';
import {
  cachedRead,
  forgetRead,
  READ_DEADLINE_MS,
  requestTarkibRead,
  storeRead,
  type StoredRead,
} from '@/app/(protected)/receipts/[id]/tarkib-read-dialog';
import { COOLING_MS, ReadCooling, TARKIB_READ_ERRORS } from '@/modules/wms/receipts/tarkib-read';
import { READ_LEASH_MS } from '@/modules/wms/receipts/tarkib-read-ai';
import { isProposalWarning, type TarkibProposal } from '@/modules/wms/receipts/tarkib-proposal';

/**
 * «🤖 Fayldan to'ldirish» — the wiring no behaviour test can see
 * (docs/TARKIB-TAKLIFLAR.md §3).
 *
 *  1. WORDS. Every code a reading can answer has its OWN sentence in the
 *     editor's one refusal map, in all four staff locales — without it the
 *     map's default says «Ma'lumot to'liq emas» about a file that is merely
 *     too large. Anchored on the route's own list (`TARKIB_READ_ERRORS`,
 *     which the compiler keeps complete), never on the bundles: comparing
 *     bundles to each other cannot see a key missing from all four (#163).
 *     And every `tarkib.read.*` sentence FORMATS — a stray brace throws at
 *     render in every locale, and existence is not validity (#520).
 *  2. NEVER A WRITER, and ONE adapter over the spreadsheet readers another
 *     round is rewriting.
 *  3. THE ORDER of the doors: each before the one that costs more.
 *  4. The browser's own halves: the deadline outlasts the server's leash,
 *     the dialog is not closed by a stray tap, the reading is kept by its
 *     document.
 */

const strip = (src: string) => src.replace(/\{\/\*[\s\S]*?\*\/\}/g, '').replace(/\/\*[\s\S]*?\*\//g, '').replace(/(^|[^:])\/\/.*$/gm, '$1');
const read = (path: string) => strip(readFileSync(path, 'utf8'));

const PANEL = 'src/app/(protected)/receipts/[id]/composition-panel.tsx';
const DIALOG = 'src/app/(protected)/receipts/[id]/tarkib-read-dialog.tsx';
const ROUTE = 'src/app/api/tarkib/read/route.ts';
const SERVICE = 'src/modules/wms/receipts/tarkib-read.ts';
const READER = 'src/modules/wms/receipts/tarkib-read-ai.ts';
const ADAPTER = 'src/modules/wms/receipts/tarkib-file.ts';
const PROPOSAL = 'src/modules/wms/receipts/tarkib-proposal.ts';
const T1_FILES = [PANEL, DIALOG, ROUTE, SERVICE, READER, ADAPTER, PROPOSAL];

const LOCALES = ['ru', 'uz', 'zh-CN', 'en'] as const;
type Tree = { [key: string]: string | Tree };
const bundles = Object.fromEntries(
  LOCALES.map((l) => [l, JSON.parse(readFileSync(`messages/${l}.json`, 'utf8')) as { tarkib: Tree }]),
) as Record<(typeof LOCALES)[number], { tarkib: Tree }>;
const lookup = (tree: Tree, path: string): string | Tree | undefined =>
  path.split('.').reduce<string | Tree | undefined>((node, part) => (node === undefined || typeof node === 'string' ? undefined : node[part]), tree);

/** Codes that only the route's handler or the browser can produce — worded in the same map. */
const ROUTE_ONLY = ['unauthorized'];
const BROWSER_ONLY = ['read_deadline', 'read_offline'];
const ALL_CODES = [...TARKIB_READ_ERRORS, ...ROUTE_ONLY, ...BROWSER_ONLY];

describe('every code a reading can answer has its own words', () => {
  const panel = read(PANEL);
  const map = panel.slice(panel.indexOf('function useRefusalText()'), panel.indexOf('export function CompositionPanel('));

  /** The translation key `case '<code>':` returns — the literal inside its own branch. */
  function keyOf(code: string): string | null {
    const at = map.indexOf(`case '${code}':`);
    if (at < 0) return null;
    const rest = map.slice(at + `case '${code}':`.length);
    const end = rest.search(/\bcase '|\bdefault:/);
    const branch = end < 0 ? rest : rest.slice(0, end);
    return /\bt\('([\w.]+)'/.exec(branch)?.[1] ?? null;
  }

  it('the list is the one the test thinks it is: 23 codes of the service, 1 of the route, 2 of the browser', () => {
    expect(TARKIB_READ_ERRORS).toHaveLength(23);
    expect(new Set(ALL_CODES).size).toBe(26);
    // The route answers nothing the list does not hold, and the browser's two are its own.
    const route = read(ROUTE);
    expect([...route.matchAll(/error: '(\w+)'/g)].map((m) => m[1]).sort()).toEqual(['failed', 'unauthorized']);
    const dialog = read(DIALOG);
    expect([...new Set([...dialog.matchAll(/error: (?:[^,}]*\? )?'(\w+)'(?: : '(\w+)')?/g)].flatMap((m) => [m[1], m[2]].filter(Boolean)))].sort()).toEqual(
      ['failed', 'read_deadline', 'read_offline', 'unauthorized'],
    );
  });

  it.each(ALL_CODES)('%s: a `case` of its own, a key of its own, in all four bundles', (code) => {
    const key = keyOf(code);
    expect(key, `no case '${code}' in useRefusalText — it would read «Ma'lumot to'liq emas»`).not.toBeNull();
    for (const locale of LOCALES) {
      expect(typeof lookup(bundles[locale].tarkib, key!), `${locale}: tarkib.${key}`).toBe('string');
    }
  });

  it('no two codes share a sentence, and none borrows the map’s default', () => {
    const keys = ALL_CODES.map((code) => keyOf(code));
    expect(new Set(keys).size).toBe(keys.length);
    expect(keys).not.toContain('errors.validation');
  });

  it('the save’s own doors keep the save’s own words; everything else is the reading’s', () => {
    const shared = ['forbidden', 'receipt_not_confirmed', 'document_not_on_receipt', 'document_is_photo', 'server_behind'];
    for (const code of ALL_CODES) {
      expect(keyOf(code), code).toBe(shared.includes(code) ? `errors.${code}` : `read.errors.${code}`);
    }
  });

  it('the reading never answers in a code that is ANOTHER door’s words — the upload’s above all', () => {
    for (const taken of ['too_large', 'unsupported_type', 'upload_failed', 'uploading', 'in_use', 'remove_failed', 'busy', 'validation']) {
      expect(ALL_CODES, taken).not.toContain(taken);
      // …and that door's case is still there, saying its own thing.
      expect(map, taken === 'validation' ? 'default' : taken).toContain(taken === 'validation' ? "t('errors.validation')" : `case '${taken}':`);
    }
  });

  it('`read_no_goods` carries the model’s own sentence about the paper, and a refusal its day’s count', () => {
    expect(map).toContain("return r.detail ? `${t('read.errors.read_no_goods')} — ${r.detail}` : t('read.errors.read_no_goods');");
    expect(panel).toContain('setRefusal({ error: answer.error, detail: answer.detail, today: answer.today })');
    expect(panel).toContain('{refusal.today && <ReadTodayLine today={refusal.today} />}');
  });
});

describe('every `tarkib.read` sentence formats, in every locale', () => {
  const SAMPLE: Record<string, string | number> = {
    n: 7,
    minutes: 12,
    used: 3,
    limit: 50,
    usd: '0.42',
    name: 'Клавиатура',
    names: 'Мышь, Коврик',
    have: 19,
    add: 2,
    field: 'kg',
    value: '37.8',
    shown: 40,
    total: 47,
    sum: '1020.000',
  };
  const flatten = (tree: Tree, prefix = ''): [string, string][] =>
    Object.entries(tree).flatMap(([key, value]) =>
      typeof value === 'string' ? ([[prefix + key, value]] as [string, string][]) : flatten(value, `${prefix}${key}.`),
    );

  it.each(LOCALES)('%s', (locale) => {
    const t = createTranslator({
      locale,
      messages: bundles[locale] as never,
      namespace: 'tarkib',
      onError: (error) => {
        throw error;
      },
    }) as unknown as (key: string, values: Record<string, string | number>) => string;
    const keys = flatten(bundles[locale].tarkib.read as Tree, 'read.');
    expect(keys.length).toBeGreaterThan(70);
    for (const [key, text] of keys) {
      const placeholders = [...text.matchAll(/\{([a-zA-Z0-9_]+)\}/g)].map((m) => m[1]!);
      for (const p of placeholders) expect(SAMPLE[p], `${locale}: ${key} uses {${p}}`).toBeDefined();
      const out = t(key, SAMPLE);
      expect(out, `${locale}: ${key}`).not.toContain(key);
      // Every placeholder was FILLED — a quoted brace would print it literally.
      expect(out, `${locale}: ${key}`).not.toMatch(/\{[a-zA-Z0-9_]+\}/);
      for (const p of placeholders) expect(out, `${locale}: ${key} / ${p}`).toContain(String(SAMPLE[p]));
    }
  });
});

describe('it is never a writer, and one adapter stands over the spreadsheet readers', () => {
  it('the route, the service, the reader and the adapter name no writer of anything but the bill line', () => {
    for (const path of [ROUTE, SERVICE, READER, ADAPTER, PROPOSAL]) {
      const src = read(path);
      for (const writer of [
        'saveComposition',
        'clearComposition',
        'setLineCodes',
        'saveTnved',
        'writeAudit',
        'lotCompositions',
        'lotCompositionLines',
        'tnvedAssignments',
        '.insert(',
        '.update(',
        '.transaction(',
        'INSERT INTO',
        'UPDATE ',
        'DELETE FROM',
      ]) {
        expect(src, `${path} names ${writer}`).not.toContain(writer);
      }
      // A database delete — not the cooling map's own `Map.delete`.
      expect(src, `${path} deletes rows`).not.toMatch(/\b(?:db|tx)\s*\.\s*delete\(/);
    }
    // Its one write is its own bill line, through the ledger's two doors.
    const service = read(SERVICE);
    expect(service).toContain("reservePress({ kind: 'tarkib', staffId: actor.id, lotId, batchId: null })");
    expect(service.match(/settlePress\(/g)).toHaveLength(2);
  });

  it('the dialog and the editor write nothing either: «Qo‘llash» sets the editor’s lines and stops', () => {
    const dialog = read(DIALOG);
    expect(dialog).not.toMatch(/saveLotCompositionAction|clearLotCompositionAction|composition-actions/);
    const panel = read(PANEL);
    const apply = panel.slice(panel.indexOf('function applyRead('), panel.indexOf('async function save()'));
    expect(apply).toContain('setLines(next);');
    expect(apply).not.toMatch(/saveLotCompositionAction|save\(\)|setMode\(/);
    // The one save is still the editor's own, behind the same parse and sums as before.
    expect(panel.match(/saveLotCompositionAction\(/g)).toHaveLength(1);
    const save = panel.slice(panel.indexOf('async function save()'), panel.indexOf('async function clear()'));
    expect(save.indexOf('parseDraft(posted)')).toBeGreaterThan(-1);
    expect(save.indexOf('checkSums(parsed.lines, totals)')).toBeGreaterThan(save.indexOf('parseDraft(posted)'));
    expect(save.indexOf('saveLotCompositionAction(')).toBeGreaterThan(save.indexOf('checkSums(parsed.lines, totals)'));
  });

  it('ONLY the adapter imports the spreadsheet readers — and only their low-level «bytes → rows» exports', () => {
    const walk = (dir: string, out: string[] = []): string[] => {
      for (const name of readdirSync(dir)) {
        const path = join(dir, name);
        if (statSync(path).isDirectory()) walk(path, out);
        else if (/\.(ts|tsx)$/.test(name)) out.push(path);
      }
      return out;
    };
    const scanned = [...walk('src/modules/wms/receipts'), ...walk('src/app/(protected)/receipts'), ...walk('src/app/api/tarkib')];
    expect(scanned.length).toBeGreaterThan(20);
    // The three reader modules, by name: the prixod's other files import the
    // deals SERVICE for their own reasons, which is not this rule's business.
    const importing = scanned.filter((path) => /from '[^']*\/deals\/(?:goods-file|goods-import|xls)'/.test(read(path)));
    expect(importing).toEqual([ADAPTER]);
    const adapter = read(ADAPTER);
    const imports = [...adapter.matchAll(/import \{([^}]*)\} from '\.\.\/deals\/([\w-]+)'/g)].map((m) => ({
      from: m[2]!,
      names: m[1]!
        .split(',')
        .map((n) => n.trim())
        .filter(Boolean)
        .sort(),
    }));
    expect(imports).toEqual([
      { from: 'goods-file', names: ['csvRows', 'decodeText', 'workbookSheets'] },
      {
        from: 'xls',
        names: ['MAX_MARKUP_CHARS', 'htmlTableSheets', 'isCompoundFile', 'markupOf', 'readXls', 'spreadsheetMlSheets', 'type SheetRows'],
      },
    ]);
    // The parser another round is rewriting is named nowhere in the feature.
    for (const path of T1_FILES) {
      expect(read(path), path).not.toMatch(/parseGoods|readGoodsFile|detectColumns|goods-import|intake-ai|analyzeIntake/);
    }
  });

  it('no model identifier is written in the feature — the constant only', () => {
    for (const path of T1_FILES) {
      expect(readFileSync(path, 'utf8'), path).not.toMatch(/claude-|opus|sonnet|haiku/i);
    }
    expect(read(READER)).toContain('model: ANALYST_MODEL,');
  });
});

describe('every door before any spend — the order', () => {
  it('the save’s door → the document → its kind from the row → the key → cooling → the bytes → the file → the ledger → the model → the settle', () => {
    const service = read(SERVICE);
    const body = service.slice(service.indexOf('export async function readTarkibFile('));
    const steps = [
      'isUuidShaped(lotId)',
      'compositionDoor(actor, lotId, { requireConfirmed: true })',
      ".from(attachments)",
      "file.entityType !== 'receipt' || file.entityId !== door.lot.receiptId",
      'isPaperDocument(file, door.receipt)',
      'kindOfAttachment(file)',
      'aiConfigured()',
      'cooling.left(file.id)',
      'getStorage().get(file.storageKey)',
      'prepareFile(kind.kind, body, file)',
      'reservePress(',
      'readTarkibDocument(',
      'settlePress(pass.id, { outcome, usage: read.usage })',
      'buildProposal(',
    ];
    const at = steps.map((step) => body.indexOf(step));
    expect(at.every((i) => i > -1), JSON.stringify(steps.filter((_, i) => at[i]! < 0))).toBe(true);
    expect([...at].sort((a, b) => a - b)).toEqual(at);
    // The storage read is deadlined, and a thrown reading still closes its ledger row.
    expect(body).toContain('readWithin(getStorage().get(file.storageKey), FILE_READ_MS)');
    expect(body).toMatch(/catch \(err\) \{\s*await settlePress\(pass\.id, \{ outcome: 'no_answer' \}\);\s*throw err;/);
    // Cooling starts for the two «too much for one reading» endings and no other.
    expect(body).toContain("if (read.code === 'ai_timeout' || read.code === 'ai_truncated') cooling.start(file.id);");
  });

  it('the route hands the service the session’s actor and answers every refusal 200 with no-store', () => {
    const route = read(ROUTE);
    expect(route).toContain('const actor = await getActor();');
    expect(route).toContain("if (!actor) return NextResponse.json({ ok: false, error: 'unauthorized' }, { status: 401, headers: NO_STORE });");
    expect(route).toContain("const NO_STORE = { 'Cache-Control': 'private, no-store' };");
    expect(route.match(/headers: NO_STORE/g)).toHaveLength(3);
    expect(route).not.toMatch(/'use server'/);
  });
});

describe('a document cools off after a reading that ran out of time or of room', () => {
  it('ten minutes, per document — and the map forgets what has cooled', () => {
    expect(COOLING_MS).toBe(10 * 60_000);
    const cooling = new ReadCooling();
    const t0 = 1_800_000_000_000;
    expect(cooling.left('a', t0)).toBe(0);
    cooling.start('a', t0);
    expect(cooling.left('a', t0)).toBe(COOLING_MS);
    expect(cooling.left('a', t0 + COOLING_MS - 1)).toBe(1);
    expect(cooling.left('b', t0 + 5)).toBe(0);
    expect(cooling.left('a', t0 + COOLING_MS)).toBe(0);
    // Read again after it cooled and timed out again: ten minutes from THEN.
    cooling.start('a', t0 + COOLING_MS + 60_000);
    expect(cooling.left('a', t0 + COOLING_MS + 60_000)).toBe(COOLING_MS);
    // Swept on the way in: a thousand cooled documents are not kept for ever.
    const many = new ReadCooling(1000);
    for (let i = 0; i < 1000; i += 1) many.start(`d${i}`, t0);
    many.start('last', t0 + 5000);
    expect((many as unknown as { until: Map<string, number> }).until.size).toBe(1);
  });
});

describe('the browser’s half', () => {
  const proposal: TarkibProposal = {
    rows: [{ name: 'Мышь', nameRu: null, pieces: '10', cartons: '1', kg: '5.000', m3: '0.1000', tnved: '', notes: [], unsure: null }],
    weightKind: 'gross',
    fileTotals: null,
    document: 'packing_list',
    warnings: [],
    notes: null,
    lotsOnReceipt: 1,
  };
  const stored = (at: number): StoredRead => ({ attachmentId: 'att-1', fileName: 'p.xlsx', at, proposal, today: null });

  function fakeStorage() {
    const map = new Map<string, string>();
    return {
      map,
      getItem: (key: string) => map.get(key) ?? null,
      setItem: (key: string, value: string) => void map.set(key, value),
      removeItem: (key: string) => void map.delete(key),
    };
  }

  afterEach(() => {
    vi.unstubAllGlobals();
  });

  it('the browser waits LONGER than the server’s leash — a paid answer must not arrive to nobody', () => {
    expect(READ_LEASH_MS).toBe(150_000);
    expect(READ_DEADLINE_MS).toBe(165_000);
    expect(READ_DEADLINE_MS).toBeGreaterThan(READ_LEASH_MS);
  });

  it('a reading is kept by its DOCUMENT for thirty minutes — and not a minute longer, nor across a change of shape', () => {
    const storage = fakeStorage();
    vi.stubGlobal('window', { sessionStorage: storage });
    const t0 = 1_800_000_000_000;
    storeRead(stored(t0));
    expect([...storage.map.keys()]).toEqual(['tarkib-read:att-1']);
    expect(cachedRead('att-1', t0 + 29 * 60_000)).toEqual(stored(t0));
    expect(cachedRead('att-2', t0)).toBeNull();
    // Past the half hour it is gone — and removed, not merely skipped.
    expect(cachedRead('att-1', t0 + 30 * 60_000 + 1)).toBeNull();
    expect(storage.map.size).toBe(0);
    // An entry of another shape (an older build's) is no reading.
    storage.map.set('tarkib-read:att-1', JSON.stringify({ v: 0, at: t0, proposal }));
    expect(cachedRead('att-1', t0)).toBeNull();
    storage.map.set('tarkib-read:att-1', JSON.stringify({ v: 1, at: t0, proposal: { rows: 'none' } }));
    expect(cachedRead('att-1', t0)).toBeNull();
    storage.map.set('tarkib-read:att-1', '{not json');
    expect(cachedRead('att-1', t0)).toBeNull();
    storeRead(stored(t0));
    forgetRead('att-1');
    expect(cachedRead('att-1', t0)).toBeNull();
  });

  it('a private window’s storage THROWS: nothing is kept, and nothing breaks', () => {
    const boom = () => {
      throw new Error('SecurityError');
    };
    vi.stubGlobal('window', { sessionStorage: { getItem: boom, setItem: boom, removeItem: boom } });
    expect(() => storeRead(stored(1))).not.toThrow();
    expect(cachedRead('att-1')).toBeNull();
    expect(() => forgetRead('att-1')).not.toThrow();
  });

  it('the request never throws: every ending is a code the editor has words for', async () => {
    vi.stubGlobal('window', { setTimeout, clearTimeout });
    const answerWith = (status: number, body: unknown) =>
      vi.stubGlobal('fetch', async () => ({ status, json: async () => (body instanceof Error ? Promise.reject(body) : body) }));

    answerWith(200, { ok: true, proposal, today: { used: 1, limit: 50, usd: null, usd30: null, unpriced: null } });
    expect(await requestTarkibRead('lot', 'att')).toMatchObject({ ok: true, proposal });
    answerWith(200, { ok: false, error: 'ai_limit', today: { used: 50, limit: 50, usd: null, usd30: null, unpriced: null } });
    expect(await requestTarkibRead('lot', 'att')).toMatchObject({ ok: false, error: 'ai_limit', today: { used: 50 } });
    answerWith(401, { ok: false, error: 'unauthorized' });
    expect(await requestTarkibRead('lot', 'att')).toEqual({ ok: false, error: 'unauthorized' });
    // A proxy's error page, an answer of another shape: «failed», never a throw.
    answerWith(502, new SyntaxError('Unexpected token <'));
    expect(await requestTarkibRead('lot', 'att')).toEqual({ ok: false, error: 'failed' });
    answerWith(200, { ok: true, proposal: {} });
    expect(await requestTarkibRead('lot', 'att')).toEqual({ ok: false, error: 'failed' });
    answerWith(401, new SyntaxError('login page'));
    expect(await requestTarkibRead('lot', 'att')).toEqual({ ok: false, error: 'unauthorized' });
    // The network is gone.
    vi.stubGlobal('fetch', async () => {
      throw new TypeError('Failed to fetch');
    });
    expect(await requestTarkibRead('lot', 'att')).toEqual({ ok: false, error: 'read_offline' });
  });

  it('…and the deadline ends the wait with its own word', async () => {
    vi.stubGlobal('window', { setTimeout, clearTimeout });
    let sent: { method?: string; body?: string } = {};
    vi.stubGlobal(
      'fetch',
      (_url: string, init: { method: string; body: string; signal: AbortSignal }) =>
        new Promise((_resolve, reject) => {
          sent = init;
          init.signal.addEventListener('abort', () => reject(new DOMException('aborted', 'AbortError')));
        }),
    );
    const started = Date.now();
    expect(await requestTarkibRead('lot-1', 'att-1', 30)).toEqual({ ok: false, error: 'read_deadline' });
    expect(Date.now() - started).toBeLessThan(3000);
    // What it posted: the two ids and nothing else — the bytes stay on the server.
    expect(sent.method).toBe('POST');
    expect(JSON.parse(sent.body!)).toEqual({ lotId: 'lot-1', attachmentId: 'att-1' });
  });

  it('a stray tap does not close a paid reading: only a navigation closes the dialog from outside, and it is kept MOUNTED', () => {
    const dialog = read(DIALOG);
    expect(dialog).toMatch(/onClose=\{\(reason\) => \{\s*if \(reason === 'route'\) onClose\(\);\s*return false;\s*\}\}/);
    expect(dialog).toContain('open={open && read !== null}');
    // The key is on the BODY — on the Overlay it would remount it open.
    expect(dialog).toMatch(/<ReadBody\s+key=\{read\.at\}/);
    expect(dialog).not.toMatch(/<Overlay\s+key=/);
    const panel = read(PANEL);
    expect(panel).toMatch(/<TarkibReadDialog\s+open=\{readOpen\}/);
    expect(panel).not.toMatch(/&&\s*\(?\s*<TarkibReadDialog/);
    // «Qayta o'qish» is a new bill line: asked first.
    expect(dialog).toContain("if (window.confirm(t('read.againConfirm'))) onAgain();");
  });

  it('the button reads the CHOSEN chip, shows a kept reading instead of paying again, and always comes back', () => {
    const panel = read(PANEL);
    expect(panel).toContain('const chosen = doc !== null ? (docs.find((d) => d.id === doc) ?? null) : null;');
    expect(panel).toContain('disabled={chosen === null || reading || uploading > 0 || pending}');
    const fn = panel.slice(panel.indexOf('async function readDocument('), panel.indexOf('function applyRead('));
    expect(fn.indexOf('cachedRead(target.id)')).toBeGreaterThan(-1);
    expect(fn.indexOf('cachedRead(target.id)')).toBeLessThan(fn.indexOf('requestTarkibRead(lotId, target.id)'));
    // Kept even when the editor has gone; the button re-enables in `finally`.
    expect(fn.indexOf('storeRead(stored);')).toBeLessThan(fn.indexOf('if (alive.current) {'));
    expect(fn).toMatch(/finally \{[\s\S]*if \(alive\.current\) setReading\(false\);/);
    // Apply cites the file that was read while its chip is drawn, and the notice stays until «Saqlash».
    const apply = panel.slice(panel.indexOf('function applyRead('), panel.indexOf('async function save()'));
    expect(apply).toContain('if (docs.some((d) => d.id === read.attachmentId)) setDoc(read.attachmentId);');
    expect(apply).toContain('setFilled({');
    expect(panel).toContain('data-testid="tarkib-filled"');
    // A saved reading is forgotten only on a prixod of ONE lot.
    expect(panel).toContain('if (filled?.single) forgetRead(filled.attachmentId);');
  });

  it('a photographed packing list is uploaded from the editor at document grade — every other caller keeps the default', () => {
    const panel = read(PANEL);
    expect(panel).toContain("const DOCUMENT_PHOTO = { maxSizeMB: 1, maxWidthOrHeight: 2000 } as const;");
    expect(panel).toContain("uploadAttachmentFile(file, 'receipt', receiptId, DOCUMENT_PHOTO)");
    expect(read('src/components/attachments-panel.tsx')).toContain('uploadAttachmentFile(file, entityType, entityId)');
    expect(read('src/components/upload-attachment.ts')).toContain('const body = isImage ? await compressPhoto(file, photo) : file;');
  });

  it('a warning that came back out of the draft is worded only when this build knows it', () => {
    expect(isProposalWarning({ code: 'text_cut' })).toBe(true);
    expect(isProposalWarning({ code: 'rows_cut', params: { shown: 40, total: 47 } })).toBe(true);
    expect(isProposalWarning({ code: 'totals_differ', params: { field: 'kg', sum: '1', total: '2' } })).toBe(true);
    for (const bad of [null, 'text_cut', {}, { code: 'rows_cut' }, { code: 'rows_cut', params: { shown: '40', total: 47 } }, { code: 'totals_differ', params: { field: 'usd', sum: '1', total: '2' } }, { code: 'tomorrow' }]) {
      expect(isProposalWarning(bad), JSON.stringify(bad)).toBe(false);
    }
    expect(read(PANEL)).toContain('warnings: saved.filled.warnings.filter(isProposalWarning),');
  });
});
