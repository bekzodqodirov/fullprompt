import { describe, expect, it } from 'vitest';
import fs from 'node:fs';
import path from 'node:path';
import {
  colsParam,
  parseCols,
  visibleColumns,
  type ColumnDef,
} from '@/modules/platform/lists/columns';
import {
  canPublishViews,
  normalizeQuery,
  PUBLISH_VIEWS_PERMISSION,
} from '@/modules/platform/lists/query';
import { CLIENT_COLUMNS } from '@/modules/platform/clients/list';
import { STOCK_COLUMNS } from '@/modules/wms/inventory/columns';

/**
 * The list engine's decisions, called as the screens call them.
 *
 * Everything here is pure on purpose: a saved view is a query string and a
 * column choice is a parameter, so the rules that matter can be proven without
 * a database or a browser.
 */

const COLUMNS: ColumnDef[] = [
  { key: 'code', labelKey: 'clients.code', always: true },
  { key: 'name', labelKey: 'clients.name' },
  { key: 'money', labelKey: 'clients.name', permission: 'finance.view' },
  { key: 'noisy', labelKey: 'clients.name', optional: true },
];

const yes = () => true;
const no = () => false;

describe('column choice', () => {
  it('tells "no parameter" from "an empty one"', () => {
    // Not the same thing: no parameter means the screen's defaults, an empty
    // one means the person unticked everything but the mandatory column.
    expect(parseCols(undefined)).toBeNull();
    expect(parseCols('')).toEqual([]);
    expect(parseCols('code,name')).toEqual(['code', 'name']);
    expect(parseCols(['code'])).toEqual(['code']);
  });

  it('shows the defaults when nobody chose — optional columns stay off', () => {
    const shown = visibleColumns(COLUMNS, null, yes).map((column) => column.key);
    expect(shown).toEqual(['code', 'name', 'money']);
  });

  it('never renders a column the viewer may not see, even when the URL asks', () => {
    const shown = visibleColumns(COLUMNS, ['code', 'money'], no).map((column) => column.key);
    expect(shown).toEqual(['code']);
  });

  it('keeps the mandatory column whatever the URL says', () => {
    // A list whose link column can be turned off is a list nobody can leave.
    expect(visibleColumns(COLUMNS, [], yes).map((column) => column.key)).toEqual(['code']);
  });

  it('drops a column that no longer exists rather than refusing to render', () => {
    // A saved view outlives the custom field it names; showing one column too
    // few beats a screen that will not open.
    const shown = visibleColumns(COLUMNS, ['name', 'cf_deleted'], yes).map((column) => column.key);
    expect(shown).toEqual(['code', 'name']);
  });

  it('orders by the screen, not by the URL', () => {
    const shown = visibleColumns(COLUMNS, ['noisy', 'name'], yes).map((column) => column.key);
    expect(shown).toEqual(['code', 'name', 'noisy']);
    expect(colsParam(COLUMNS, visibleColumns(COLUMNS, ['noisy', 'name'], yes))).toBe(
      'code,name,noisy',
    );
  });
});

describe('the query a view stores', () => {
  it('is stable whatever order the params arrived in', () => {
    const a = normalizeQuery({ sort: 'name', q: 'GS7', dir: 'asc' });
    const b = normalizeQuery({ dir: 'asc', q: 'GS7', sort: 'name' });
    expect(a).toBe(b);
    expect(a).toBe('dir=asc&q=GS7&sort=name');
  });

  it('drops empty boxes — an untyped filter is not a filter', () => {
    expect(normalizeQuery({ q: '', sort: 'name' })).toBe('sort=name');
  });

  it('drops the control params, so a view cannot re-save itself', () => {
    expect(normalizeQuery({ q: 'GS7', view: 'abc', makeDefault: 'on' })).toBe('q=GS7');
  });

  it('drops the page — a saved view must not open on the middle of a list', () => {
    expect(normalizeQuery({ q: 'GS7', page: '3' })).toBe('q=GS7');
  });

  it('keeps the column choice, because a view is its columns too', () => {
    expect(normalizeQuery({ cols: 'code,name' })).toBe('cols=code%2Cname');
  });
});

describe('who may publish a view to everyone', () => {
  it('is the settings admin and nobody else (owner, 2026-08-04)', () => {
    expect(canPublishViews(new Set([PUBLISH_VIEWS_PERMISSION]))).toBe(true);
    expect(canPublishViews(new Set(['clients.manage']))).toBe(false);
    expect(canPublishViews(new Set())).toBe(false);
  });

  it('reuses an existing permission — a new one would be ungrantable (#170)', () => {
    const catalog = fs.readFileSync(
      path.join(process.cwd(), 'src/modules/platform/rbac/catalog.ts'),
      'utf8',
    );
    expect(catalog).toContain(PUBLISH_VIEWS_PERMISSION);
  });
});

describe('every column label resolves', () => {
  // The i18n tripwire greps literal t('…') calls and cannot see a label
  // resolved from a descriptor at runtime — and a missing key throws while
  // RENDERING, in every locale (#163). So the descriptors are read here.
  const bundle = JSON.parse(
    fs.readFileSync(path.join(process.cwd(), 'messages/ru.json'), 'utf8'),
  ) as Record<string, Record<string, unknown>>;

  const resolves = (key: string) =>
    key
      .split('.')
      .reduce<unknown>(
        (node, part) => (typeof node === 'object' && node ? (node as never)[part] : undefined),
        bundle,
      ) !== undefined;

  it.each([
    ['clients', CLIENT_COLUMNS],
    ['stock', STOCK_COLUMNS],
  ])('%s', (_screen, columns) => {
    for (const column of columns) {
      // A column is named EITHER by a bundle key or by its own data, never
      // by neither — an unnamed column renders as an empty heading.
      expect(Boolean(column.labelKey) || Boolean(column.label)).toBe(true);
      if (column.labelKey) expect(resolves(column.labelKey), column.labelKey).toBe(true);
    }
  });
});
