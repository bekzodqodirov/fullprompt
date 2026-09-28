import { existsSync, globSync, readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';
import { ROLE_MATRIX } from '@/modules/platform/rbac/catalog';
import {
  clientBookBack,
  mayOpenClientCard,
  mayOpenMyClients,
} from '@/modules/platform/clients/card-door';
import {
  mayOpenClientLedger,
  mayReadLedgers,
  ownsLedger,
  seesAllMoney,
} from '@/modules/wms/finance/scope';
import { clientTabHref, clientTabsFor } from '@/modules/wms/client-card/tabs';

/**
 * The client card and its «Pul» tab (the owner's 4a, docs/CARD-TABS.md):
 * «Mijozning hisob varag'i mijoz kartasiga «Pul» bo'limi bo'lib kirsinmi? Kim
 * pulni ko'radi, degan ruxsatlar o'zgarmaydi.»
 *
 * The behaviour half calls the real predicates over EVERY seeded role, because
 * who sees money is a property of a matrix he edits with checkboxes (#792),
 * and anchors each answer on a literal table — never on the code it tests
 * (#166). The source half pins the wiring no render test can see: which door
 * each page asks, in which ORDER, and that no lenta can be drawn without a
 * money answer.
 */

/** Comments out, so a fence cannot match the sentence explaining it (#725). */
const read = (path: string) =>
  readFileSync(path, 'utf8')
    .replace(/\/\*[\s\S]*?\*\//g, '')
    .replace(/(^|[^:])\/\/.*$/gm, '$1');

const ME = 'u-me';
const MATRIX: Record<string, readonly string[]> = ROLE_MATRIX;
const actorWith = (grants: readonly string[]) => ({ id: ME, permissions: new Set(grants) });

const CLIENTS = {
  own: { salesManagerId: ME },
  other: { salesManagerId: 'u-colleague' },
  unowned: { salesManagerId: null },
} as const;
type Whose = keyof typeof CLIENTS;

/**
 * What every seeded role is answered, written down from the owner's rules
 * and not from the functions: the card is the client book's administrator's
 * and the sellers'; a ledger is the money readers', whole-company for
 * `finance.manage`/`clients.manage` and own-clients-only for a seller.
 * A role added to ROLE_MATRIX turns this red until somebody decides it.
 */
const EXPECTED: Record<string, { card: boolean; yuklar: boolean; ledger: Whose[] }> = {
  super_admin: { card: true, yuklar: true, ledger: ['own', 'other', 'unowned'] },
  admin: { card: true, yuklar: true, ledger: ['own', 'other', 'unowned'] },
  logist: { card: true, yuklar: true, ledger: ['own', 'other', 'unowned'] },
  ved_manager: { card: false, yuklar: false, ledger: ['own', 'other', 'unowned'] },
  warehouse_manager: { card: false, yuklar: false, ledger: [] },
  warehouse_operator: { card: false, yuklar: false, ledger: [] },
  sales_manager: { card: true, yuklar: true, ledger: ['own'] },
  accountant: { card: false, yuklar: false, ledger: ['own', 'other', 'unowned'] },
  viewer: { card: false, yuklar: false, ledger: [] },
};

/** The combinations the owner is known to hold or could invent on /admin/roles. */
const INVENTED: [string, string[]][] = [
  ['admin + sales (his own «bir admin va sotuvchi»)', [...MATRIX.admin!, ...MATRIX.sales_manager!]],
  ['ved + sales, both hats', [...MATRIX.ved_manager!, ...MATRIX.sales_manager!]],
  ['a seller helper: crm.leads only', ['crm.leads']],
  ['the book admin without money: clients.manage only', ['clients.manage']],
  ['own clients with the money grant, no funnel', ['clients.view_own', 'finance.view']],
  ['a kassir: finance.view only', ['finance.view']],
];

const PEOPLE: [string, ReturnType<typeof actorWith>][] = [
  ...Object.keys(MATRIX).map((role): [string, ReturnType<typeof actorWith>] => [role, actorWith(MATRIX[role]!)]),
  ...INVENTED.map(([name, grants]): [string, ReturnType<typeof actorWith>] => [name, actorWith(grants)]),
];

/**
 * The ledger page's two questions exactly as it asks them — first a redirect
 * for whoever reads no ledgers at all, then, after the lookup, a 404 for a
 * ledger outside the reader's book.
 */
function ledgerPage(actor: ReturnType<typeof actorWith>, client: { salesManagerId: string | null }) {
  if (!mayReadLedgers(actor)) return 'redirect';
  if (!ownsLedger(actor, client)) return 'notFound';
  return 'open';
}

/** The pre-4a rules, as the two pages wrote them the day before (round 91). */
const has = (actor: ReturnType<typeof actorWith>, code: string) => actor.permissions.has(code);
const moneyReader = (a: ReturnType<typeof actorWith>) => has(a, 'finance.view') || has(a, 'finance.manage');
const wholeBook = (a: ReturnType<typeof actorWith>) => has(a, 'finance.manage') || has(a, 'clients.manage');
const oldCardMoney = (a: ReturnType<typeof actorWith>, c: { salesManagerId: string | null }) =>
  moneyReader(a) && (wholeBook(a) || c.salesManagerId === a.id);
const oldLedgerOpens = (a: ReturnType<typeof actorWith>, c: { salesManagerId: string | null }) =>
  moneyReader(a) && !(!wholeBook(a) && c.salesManagerId !== a.id);
const oldCardDoor = (a: ReturnType<typeof actorWith>) =>
  has(a, 'clients.manage') || has(a, 'clients.view_own') || has(a, 'crm.leads');
/** The lenta panel's own gate — who reads the lenta at all (unchanged). */
const lentaReader = (a: ReturnType<typeof actorWith>) => has(a, 'crm.leads') || has(a, 'clients.manage');

describe('the doors, over every seeded role', () => {
  it('decides every role the matrix ships', () => {
    expect(Object.keys(MATRIX).sort()).toEqual(Object.keys(EXPECTED).sort());
  });

  for (const role of Object.keys(EXPECTED)) {
    it(`${role}: the card and the ledgers it opens`, () => {
      const actor = actorWith(MATRIX[role] ?? []);
      const want = EXPECTED[role]!;
      expect(mayOpenClientCard(actor)).toBe(want.card);
      for (const whose of Object.keys(CLIENTS) as Whose[]) {
        expect(mayOpenClientLedger(actor, CLIENTS[whose]), whose).toBe(want.ledger.includes(whose));
        // The strip's own answer is the table's, tab by tab.
        const tabs = clientTabsFor(actor, CLIENTS[whose]);
        expect(tabs.includes('umumiy'), `${whose} umumiy`).toBe(want.card);
        expect(tabs.includes('yuklar'), `${whose} yuklar`).toBe(want.yuklar);
        expect(tabs.includes('pul'), `${whose} pul`).toBe(want.ledger.includes(whose));
      }
    });
  }

  it('«Yuklar» is the card’s own door, for every seeded role and every invented one', () => {
    // Not a copy of the door: the tab is the card's cargo block given room
    // (the design's default for the owner's open question), so whoever may
    // read «Umumiy» reads «Yuklar» and nobody else does.
    for (const [name, actor] of PEOPLE) {
      for (const whose of Object.keys(CLIENTS) as Whose[]) {
        expect(clientTabsFor(actor, CLIENTS[whose]).includes('yuklar'), `${name}:${whose}`).toBe(
          mayOpenClientCard(actor),
        );
      }
    }
  });

  it('each tab lives at the URL its page serves — none moved', () => {
    expect(clientTabHref('umumiy', 'c1')).toBe('/admin/clients/c1');
    expect(clientTabHref('yuklar', 'c1')).toBe('/admin/clients/c1/yuklar');
    expect(clientTabHref('pul', 'c1')).toBe('/finance/c1');
  });

  it('the strip is drawn where there are two tabs or more: every card reader, with «Pul» only on a ledger they own', () => {
    const drawn: string[] = [];
    for (const role of Object.keys(MATRIX)) {
      const actor = actorWith(MATRIX[role]!);
      for (const whose of Object.keys(CLIENTS) as Whose[]) {
        const tabs = clientTabsFor(actor, CLIENTS[whose]);
        if (tabs.length >= 2) drawn.push(`${role}:${whose}=${tabs.join('+')}`);
      }
    }
    // Written down, not derived: a seller on a colleague's client now gets
    // «Umumiy · Yuklar» and no «Pul»; the accountant and the VED — one tab,
    // the ledger — get no strip at all.
    expect(drawn.sort()).toEqual(
      [
        'super_admin:own=umumiy+yuklar+pul', 'super_admin:other=umumiy+yuklar+pul', 'super_admin:unowned=umumiy+yuklar+pul',
        'admin:own=umumiy+yuklar+pul', 'admin:other=umumiy+yuklar+pul', 'admin:unowned=umumiy+yuklar+pul',
        'logist:own=umumiy+yuklar+pul', 'logist:other=umumiy+yuklar+pul', 'logist:unowned=umumiy+yuklar+pul',
        'sales_manager:own=umumiy+yuklar+pul', 'sales_manager:other=umumiy+yuklar', 'sales_manager:unowned=umumiy+yuklar',
      ].sort(),
    );
  });
});

describe('who sees money does not change (4a)', () => {
  for (const [name, actor] of PEOPLE) {
    it(`${name}: the card's money is the ledger's door, and both are what they were`, () => {
      for (const whose of Object.keys(CLIENTS) as Whose[]) {
        const client = CLIENTS[whose];
        const cardMoney = mayOpenClientLedger(actor, client);
        // The card prints money exactly where the ledger opens…
        expect(cardMoney, whose).toBe(ledgerPage(actor, client) === 'open');
        // …which is where the card printed it, and the ledger opened, before.
        expect(cardMoney, whose).toBe(oldCardMoney(actor, client));
        expect(ledgerPage(actor, client) === 'open', whose).toBe(oldLedgerOpens(actor, client));
        // The composite is its two halves and nothing else.
        expect(cardMoney, whose).toBe(mayReadLedgers(actor) && ownsLedger(actor, client));
      }
      expect(mayOpenClientCard(actor)).toBe(oldCardDoor(actor));
    });
  }

  it('a refusal before the lookup never depends on the client — the URL answers nothing about existence', () => {
    for (const [, actor] of PEOPLE) {
      const answers = (Object.keys(CLIENTS) as Whose[]).map((whose) => ledgerPage(actor, CLIENTS[whose]));
      // Either everybody's ledger redirects, or none does.
      expect(new Set(answers.map((a) => a === 'redirect')).size).toBe(1);
    }
  });

  it('a whole-ledger reader owns every ledger; a seller owns only their own', () => {
    for (const [, actor] of PEOPLE) {
      if (seesAllMoney(actor)) {
        for (const whose of Object.keys(CLIENTS) as Whose[]) expect(ownsLedger(actor, CLIENTS[whose])).toBe(true);
      } else {
        expect(ownsLedger(actor, CLIENTS.own)).toBe(true);
        expect(ownsLedger(actor, CLIENTS.other)).toBe(false);
        expect(ownsLedger(actor, CLIENTS.unowned)).toBe(false);
      }
    }
  });

  it('the lenta stops showing money to exactly the seller on somebody else’s client, and to nobody else a seeded role holds', () => {
    // Before, the lenta printed money to every reader of the lenta. Now it
    // asks the ledger's door; the difference is the leak, and it is exactly
    // this list among the seeded roles.
    const lost: string[] = [];
    for (const role of Object.keys(MATRIX)) {
      const actor = actorWith(MATRIX[role]!);
      for (const whose of Object.keys(CLIENTS) as Whose[]) {
        const before = lentaReader(actor);
        const after = lentaReader(actor) && mayOpenClientLedger(actor, CLIENTS[whose]);
        if (before && !after) lost.push(`${role}:${whose}`);
        // Nobody GAINS money on the lenta.
        expect(after && !before, `${role}:${whose}`).toBe(false);
      }
    }
    expect(lost.sort()).toEqual(['sales_manager:other', 'sales_manager:unowned']);
  });
});

describe('the way back never bounces', () => {
  for (const [name, actor] of PEOPLE) {
    it(`${name}: «←» on «Umumiy» points at a list page this person opens`, () => {
      const back = clientBookBack(actor);
      if (back === '/admin/clients') {
        // The list page's own gate, under the admin layout's client half.
        expect(has(actor, 'clients.manage')).toBe(true);
        expect(mayOpenClientCard(actor)).toBe(true);
      } else if (back === '/my-clients') {
        expect(mayOpenMyClients(actor)).toBe(true);
      } else {
        expect(has(actor, 'clients.manage')).toBe(false);
        expect(mayOpenMyClients(actor)).toBe(false);
      }
    });
  }

  it('every seeded role that is shown the strip has a way back on BOTH tabs, so switching never moves it', () => {
    for (const role of Object.keys(MATRIX)) {
      const actor = actorWith(MATRIX[role]!);
      if (!mayOpenClientCard(actor)) continue;
      const striped = (Object.keys(CLIENTS) as Whose[]).some((whose) => mayOpenClientLedger(actor, CLIENTS[whose]));
      // «Pul»'s way back is /finance, whose door every ledger reader passed.
      if (striped) expect(clientBookBack(actor), role).not.toBeNull();
    }
  });
});

describe('the pages ask the doors, in the right order', () => {
  const LEDGER = read('src/app/(protected)/finance/[clientId]/page.tsx');
  const CARD = read('src/app/(protected)/admin/clients/[id]/page.tsx');
  const SHELL = read('src/components/client-card.tsx');

  it('the ledger redirects on mayReadLedgers BEFORE the lookup and 404s on ownsLedger AFTER it', () => {
    const door = LEDGER.indexOf("if (!mayReadLedgers(actor)) redirect('/');");
    const lookup = LEDGER.indexOf('db.query.clients.findFirst(');
    const owns = LEDGER.indexOf('if (!ownsLedger(actor, client)) notFound();');
    expect(door).toBeGreaterThan(0);
    expect(lookup).toBeGreaterThan(door);
    expect(owns).toBeGreaterThan(lookup);
    // After the lookup nothing may answer with a different word than «not
    // found» — a redirect there would tell a seller the client exists.
    expect(LEDGER.slice(lookup)).not.toContain('redirect(');
    // And the one-boolean shortcut is not how this page asks.
    expect(LEDGER).not.toContain('mayOpenClientLedger');
  });

  it('the card asks the «Umumiy» door before its lookup, and prints money on the «Pul» door', () => {
    const door = CARD.indexOf("if (!mayOpenClientCard(actor)) redirect('/');");
    expect(door).toBeGreaterThan(0);
    expect(CARD.indexOf('db.query.clients.findFirst(')).toBeGreaterThan(door);
    expect(CARD).toContain('const canSeeMoney = mayOpenClientLedger(actor, client);');
    // The card's «where is it now» line links to its own «Yuklar» tab — the
    // same door this page asked, so the link never bounces.
    expect(CARD).toMatch(
      /<CargoSummary\s+clientId=\{client\.id\}\s+money=\{canSeeMoney\}\s+yuklarHref=\{`\/admin\/clients\/\$\{client\.id\}\/yuklar`\}\s*\/>/,
    );
    // The ledger links it only for a reader the card's door admits.
    expect(LEDGER).toMatch(/yuklarHref=\{mayOpenClientCard\(actor\) \? `\/admin\/clients\/\$\{clientId\}\/yuklar` : null\}/);
    expect(CARD).not.toContain('seesAllMoney');
  });

  it('the admin layout’s client half is the card’s own door', () => {
    expect(read('src/app/(protected)/admin/layout.tsx')).toContain('const canClients = mayOpenClientCard(actor);');
  });

  it('the pages the way back points at ask the functions that chose them', () => {
    expect(read('src/app/(protected)/finance/page.tsx')).toContain("if (!mayReadLedgers(actor)) redirect('/');");
    expect(read('src/app/(protected)/my-clients/page.tsx')).toContain("if (!mayOpenMyClients(actor)) redirect('/');");
  });

  it('both tabs render the one shell, each naming itself', () => {
    expect(CARD).toContain('<ClientCard client={client} active="umumiy">');
    expect(LEDGER).toContain('<ClientCard client={client} active="pul">');
    // The shell is the page's one h1: neither body draws its own any more.
    expect(CARD).not.toContain('<h1');
    expect(LEDGER).not.toContain('<h1');
    expect(LEDGER).not.toContain('BackLink');
    expect(SHELL.match(/<h1/g)).toHaveLength(1);
    // The code is printed once in the shell (m9h reads it strictly).
    expect(SHELL.match(/>\{client\.clientCode\}</g)).toHaveLength(1);
    // One copy chip on the page, and it is the shell's.
    expect(CARD).not.toContain('<CopyChip');
    expect(SHELL.match(/<CopyChip/g)).toHaveLength(1);
  });

  it('the strip is plain links, drawn when two doors or more admit, each asked of its page’s own door', () => {
    expect(SHELL).toContain('const tabs = clientTabsFor(actor, client);');
    expect(SHELL).toContain('const strip = tabs.length >= 2;');
    expect(SHELL).toMatch(/\{strip && \(\s*<nav/);
    // A column count built at runtime is a class Tailwind never compiled.
    expect(SHELL).toContain("const STRIP_COLS: Record<number, string> = { 2: 'grid-cols-2', 3: 'grid-cols-3' };");
    expect(SHELL).not.toMatch(/grid-cols-\$\{/);
    expect(SHELL).toContain("aria-current={lit ? 'page' : undefined}");
    // Nothing a spec presses as «the card's first button», nothing sticky,
    // no CardCols (m9zl measures the first rail), no truck link (m9 reads the
    // ledger's first /batches/ link).
    expect(SHELL).not.toMatch(/<form|<button|btn-danger|btn-primary|sticky|CardCols|\/batches\//);
  });

  it('the badge reads the balance the ledger reads, once per request — and only when «Pul» is drawn', () => {
    expect(SHELL).toMatch(/export const clientBalanceOnce = cache\(\(clientId: string\) => clientBalanceUsd\(clientId\)\)/);
    // A seller on a colleague's client gets a strip now («Umumiy · Yuklar»),
    // and a loader never READS what its viewer cannot see (CARD-TABS rule 3;
    // the tab's judge, finding 7).
    expect(SHELL).toContain("const pul = tabs.includes('pul');");
    expect(SHELL).toContain('const balance = strip && pul ? await clientBalanceOnce(client.id) : 0;');
    expect(SHELL.match(/clientBalanceOnce\(/g)).toHaveLength(1);
    expect(LEDGER).toContain('clientBalanceOnce(clientId),');
    expect(LEDGER).not.toContain('clientBalanceUsd(');
  });
});

describe('no lenta without a money answer', () => {
  const FEED = read('src/modules/wms/crm/feed.ts');
  const PANEL = read('src/components/client-feed.tsx');
  const files = globSync('src/**/*.{ts,tsx}');

  /** The text of each call/element that starts at `needle`, to its balanced end. */
  function sites(source: string, needle: RegExp, open: string, close: string): string[] {
    const out: string[] = [];
    for (const match of source.matchAll(needle)) {
      let depth = 0;
      let at = source.indexOf(open, match.index!);
      for (; at < source.length; at++) {
        if (source[at] === open) depth += 1;
        if (source[at] === close) depth -= 1;
        if (depth === 0) break;
      }
      out.push(source.slice(match.index!, at + 1));
    }
    return out;
  }

  it('the option is REQUIRED on the query and on the panel — an optional one fails open', () => {
    expect(FEED).toMatch(/export interface FeedOptions \{[^}]*\bmoney: boolean;/);
    expect(FEED).not.toMatch(/\bmoney\?:/);
    expect(FEED).toContain('export async function clientFeed(clientId: string | null, opts: FeedOptions)');
    expect(FEED).toContain("opts: Pick<FeedOptions, 'money'>");
    expect(PANEL).toMatch(/\bmoney: boolean;/);
    expect(PANEL).not.toMatch(/\bmoney\?:/);
    expect(PANEL).not.toMatch(/\bmoney = (true|false)/);
  });

  it('a «no» takes the money branch out of the statement, not out of the rows', () => {
    expect(FEED).toMatch(/const money = opts\.money\s*\?\s*sql`[\s\S]*FROM client_transactions t[\s\S]*`\s*:\s*sql``;/);
    // The only place the query names the table is inside that branch.
    const body = FEED.slice(FEED.indexOf('export async function clientFeed('), FEED.indexOf('export async function clientFeedHasAnything('));
    expect(body.match(/client_transactions/g)).toHaveLength(1);
  });

  it('every <ClientFeed in src passes money= from the ledger’s door', () => {
    const elements: [string, string][] = [];
    for (const file of files) {
      const source = read(file);
      for (const element of sites(source, /<ClientFeed\b/g, '<', '>')) elements.push([file, element]);
    }
    // The three cards — the fence has something to hold.
    expect(elements.map(([file]) => file).sort()).toEqual(
      [
        'src/app/(protected)/admin/clients/[id]/page.tsx',
        'src/app/(protected)/bitimlar/[id]/page.tsx',
        'src/app/(protected)/crm/leads/[id]/page.tsx',
      ].sort(),
    );
    for (const [file, element] of elements) {
      expect(element, file).toMatch(/\bmoney=\{/);
      expect(element, file).not.toMatch(/\bmoney=\{\s*true\s*\}/);
      // The value is the ledger's door for that card's client.
      expect(read(file), file).toMatch(/mayOpenClientLedger\(actor, /);
    }
  });

  it('every clientFeed( / clientFeedHasAnything( call in src passes money', () => {
    const calls: [string, string][] = [];
    for (const file of files) {
      const source = read(file);
      for (const call of sites(source, /(?<!function )\bclientFeed(?:HasAnything)?\(/g, '(', ')')) calls.push([file, call]);
    }
    expect(calls.length).toBeGreaterThan(0);
    for (const [file, call] of calls) expect(call, file).toMatch(/[{,]\s*money\s*[:,}]/);
  });
});

describe('«Yuklar» — the card’s cargo tab (docs/CARD-TABS.md)', () => {
  const PAGE = read('src/app/(protected)/admin/clients/[id]/yuklar/page.tsx');

  it('asks the card’s own door BEFORE the lookup, and answers «not found» after it', () => {
    const door = PAGE.indexOf("if (!mayOpenClientCard(actor)) redirect('/');");
    const lookup = PAGE.indexOf('await clientHeadOnce(id)');
    const missing = PAGE.indexOf('if (!client) notFound();');
    expect(door).toBeGreaterThan(0);
    expect(lookup).toBeGreaterThan(door);
    expect(missing).toBeGreaterThan(lookup);
    // After the lookup nothing may answer in a different word (CARD-TABS (R)).
    expect(PAGE.slice(lookup)).not.toContain('redirect(');
  });

  it('renders the one shell and names itself', () => {
    expect(PAGE).toContain('<ClientCard client={client} active="yuklar">');
    expect(PAGE).not.toContain('<h1');
  });

  it('has no segment loading.tsx (#98)', () => {
    expect(existsSync('src/app/(protected)/admin/clients/[id]/yuklar/page.tsx')).toBe(true);
    expect(existsSync('src/app/(protected)/admin/clients/[id]/yuklar/loading.tsx')).toBe(false);
  });

  /**
   * The tab carries NO money — not drawn, not read. A fence on «imports
   * nothing from finance/» stays green with the ledger's balance rendered,
   * because `clientBalanceOnce` is exported from the card SHELL, not from
   * finance/ (the tab's judge, finding 6). So the fence names the money
   * identifiers themselves, over every file the tab's body is made of.
   */
  it('reads no money anywhere in its body', () => {
    const BODY = [
      'src/app/(protected)/admin/clients/[id]/yuklar/page.tsx',
      'src/components/client-cargo-now.tsx',
      'src/components/client-cargo-history.tsx',
      'src/modules/wms/inventory/client-cargo-now.ts',
      'src/modules/wms/inventory/client-cargo-fold.ts',
    ];
    const MONEY = [
      'clientBalanceOnce',
      'clientBalanceUsd',
      'clientCargo(',
      'mayOpenClientLedger',
      'clientLedger',
      'client_transactions',
      'clientTransactions',
      'amountUsd',
    ];
    for (const file of BODY) {
      const source = read(file);
      for (const name of MONEY) expect(source, `${file} names ${name}`).not.toContain(name);
      expect(source, `${file} imports from finance/`).not.toMatch(/from '[^']*\/finance\//);
    }
  });
});
