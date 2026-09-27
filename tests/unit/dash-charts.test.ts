// FIRST: the icon set builds elements at import time (see the fixture).
import '../fixtures/react-global';
import { createElement as h, type ReactElement } from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';
import { AreaLine } from '@/components/charts/area-line';
import { MirrorColumns } from '@/components/charts/mirror-columns';
import { DayColumns } from '@/components/charts/day-columns';
import { MeterRow, meterWidth } from '@/components/charts/meter-row';
import { ScopeTag } from '@/components/charts/scope-tag';
import { StatTile } from '@/components/charts/stat-tile';
import { PlanMeter } from '@/components/charts/plan-meter';
import { AttentionCards, AttentionList, type AttentionRow } from '@/components/charts/attention-list';
import { dayLabel } from '@/components/charts/month-names';
import { tipAria } from '@/components/charts/tip-text';
import { WarehouseFillView } from '@/components/warehouse-fill';

/**
 * The dashboard's visual kit (round B). Two kinds of check, on purpose:
 *
 *  - RENDERED — the components are synchronous server components, so their
 *    markup can be produced here and asked what a reader would see: a loss
 *    month with no blue under it, a partial week that is outlined, a tile
 *    that carries its exact figure. These are the behaviours.
 *  - SOURCE-SHAPE — the rules that no markup can show, because they are about
 *    what Tailwind can SEE (a colour class built at runtime compiles to
 *    nothing) and about what may never appear (`<text>` inside a scaled SVG,
 *    red in the cash chart). Comments are stripped first: several of these
 *    files explain the very words they must not use (#725).
 */

const render = (el: ReactElement) => renderToStaticMarkup(el);
const count = (text: string, re: RegExp) => (text.match(new RegExp(re.source, 'g')) ?? []).length;

const CHARTS = 'src/components/charts';
const NEW_FILES = [
  `${CHARTS}/area-line.tsx`,
  `${CHARTS}/mirror-columns.tsx`,
  `${CHARTS}/day-columns.tsx`,
  `${CHARTS}/meter-row.tsx`,
  `${CHARTS}/scope-tag.tsx`,
  `${CHARTS}/axis.tsx`,
];
const TOUCHED_FILES = [
  ...NEW_FILES,
  `${CHARTS}/stat-tile.tsx`,
  `${CHARTS}/plan-meter.tsx`,
  `${CHARTS}/attention-list.tsx`,
  'src/components/warehouse-fill.tsx',
];

/** Source with block, JSX and line comments removed. */
function code(path: string): string {
  return readFileSync(path, 'utf8')
    .replace(/\/\*[\s\S]*?\*\//g, '')
    .replace(/^\s*\/\/.*$/gm, '')
    .replace(/\s\/\/ .*$/gm, '');
}

const NAMES = ['Yan', 'Fev', 'Mar', 'Apr', 'May', 'Iyun', 'Iyul', 'Avg', 'Sen', 'Okt', 'Noy', 'Dek'];

describe('the kit is literal and draws no text inside a scaled SVG', () => {
  it('builds no colour class at runtime in any file it touches', () => {
    // `bg-${…}` AND `bg-viz-${…}`: the first version of this pattern knew only
    // the former, and a runtime-built `bg-viz-${tone}` stayed green under it.
    for (const file of TOUCHED_FILES) {
      expect(code(file), file).not.toMatch(/\b(?:bg|text|border|fill|stroke|ring)-[a-z0-9-]*\$\{/);
    }
  });

  it('keeps every tone in a literal Record map', () => {
    const maps: [string, string][] = [
      [`${CHARTS}/area-line.tsx`, 'END_MARK'],
      [`${CHARTS}/mirror-columns.tsx`, 'BAR'],
      [`${CHARTS}/day-columns.tsx`, 'DAY_BAR'],
      [`${CHARTS}/axis.tsx`, 'ANCHOR'],
      [`${CHARTS}/stat-tile.tsx`, 'VALUE_SIZE'],
      [`${CHARTS}/plan-meter.tsx`, 'TRACK'],
      [`${CHARTS}/plan-meter.tsx`, 'TICK'],
      [`${CHARTS}/attention-list.tsx`, 'CARD_BG'],
      [`${CHARTS}/attention-list.tsx`, 'ICON_BG'],
      [`${CHARTS}/attention-list.tsx`, 'WORD'],
      ['src/components/warehouse-fill.tsx', 'BAR'],
      ['src/components/warehouse-fill.tsx', 'INK'],
    ];
    for (const [file, name] of maps) {
      expect(code(file), `${file} ${name}`).toMatch(new RegExp(`const ${name}: Record<[^=]+> = \\{`));
    }
  });

  it('never writes <text> into an SVG', () => {
    for (const file of NEW_FILES) expect(code(file), file).not.toContain('<text');
    const html = render(h(AreaLine, lineProps([10, -5, 20])));
    expect(html).toContain('<svg');
    expect(html).not.toContain('<text');
  });
});

function lineProps(values: number[], extra: Partial<Parameters<typeof AreaLine>[0]> = {}) {
  return {
    points: values.map((value, i) => ({ key: `m${i}`, label: `M${i}`, value })),
    bottom: -100,
    top: 100,
    ticks: [-100, -50, 0, 50, 100],
    partialLast: false,
    tips: values.map((value, i) => `M${i}\n$${value}\tsof`),
    labelled: new Set([0, values.length - 1]),
    endLabel: '$30',
    ariaLabel: 'net profit',
    testid: 'line',
    ...extra,
  };
}

/** The wash's vertices in viewBox units, and where zero is. */
function areaOf(html: string): { zeroY: number; vertices: [number, number][] | null } {
  const zero = /<line[^>]*y1="([-\d.]+)"[^>]*data-zero=""/.exec(html);
  const path = /<path d="([^"]+)"[^>]*data-area=""/.exec(html);
  const vertices = path
    ? path[1]!
        .replace(/^M/, '')
        .replace(/Z$/, '')
        .split('L')
        .map((pair) => pair.split(',').map(Number) as [number, number])
    : null;
  return { zeroY: Number(zero?.[1]), vertices };
}

describe('AreaLine — a loss is drawn as a loss', () => {
  it('draws no wash below the zero line when a month is a loss', () => {
    const html = render(h(AreaLine, lineProps([100, -50, 80, -20, 30])));
    const { zeroY, vertices } = areaOf(html);
    expect(zeroY).toBe(50);
    expect(vertices).not.toBeNull();
    // Every vertex sits ON or ABOVE zero (the viewBox's y grows down)…
    for (const [, y] of vertices!) expect(y).toBeLessThanOrEqual(zeroY + 1e-9);
    // …the profit months are really above it…
    expect(vertices!.filter(([, y]) => y < zeroY - 1).length).toBe(3);
    // …and the cut is at the crossings, not stepped at the next month: 100 →
    // −50 crosses two-thirds of the way along the first segment.
    const x = (i: number) => ((i + 0.5) / 5) * 100;
    const crossing = x(0) + (100 / 150) * (x(1) - x(0));
    expect(vertices!.some(([vx, vy]) => Math.abs(vx - crossing) < 0.01 && vy === zeroY)).toBe(true);
  });

  it('has no wash at all for an all-loss year, and keeps the line', () => {
    const html = render(h(AreaLine, lineProps([-10, -40, -5])));
    expect(areaOf(html).vertices).toBeNull();
    expect(html).toContain('<polyline');
  });

  it('dashes the running month and hollows its point; a finished one is solid', () => {
    const partial = render(h(AreaLine, lineProps([10, 20, 30], { partialLast: true })));
    expect(count(partial, /data-partial=""/)).toBe(1);
    expect(partial).toContain('border-2 border-viz-in bg-surface-raised');
    const whole = render(h(AreaLine, lineProps([10, 20, 30], { partialLast: false })));
    expect(whole).not.toContain('data-partial');
    expect(whole).not.toContain('border-2 border-viz-in');
    expect(whole).toMatch(/rounded-full bg-viz-in"/);
  });

  it('anchors the end label to the right edge so it cannot overhang', () => {
    const html = render(h(AreaLine, lineProps([10, 20, 30], { endLabel: '−$1,234,567' })));
    expect(html).toMatch(/data-end-label=""[^>]*class="[^"]*\bright-0\b/);
    expect(html).toContain('−$1,234,567');
  });

  it('uses the line/zero/grid tokens the design names', () => {
    const html = render(h(AreaLine, lineProps([10, -5, 20])));
    expect(html).toContain('fill-viz-in/10');
    expect(html).toContain('stroke-line-strong');
    expect(html).toContain('class="stroke-line"');
    expect(html).toContain('stroke-viz-in');
    expect(count(html, /vector-effect="non-scaling-stroke"/)).toBeGreaterThanOrEqual(3);
  });
});

describe('every chart band is a button carrying its tip', () => {
  const bandButtons = (html: string) => count(html, /<button type="button" data-tip="[^"]+" aria-label="[^"]+"/);

  it('AreaLine: one per month', () => {
    const html = render(h(AreaLine, lineProps([1, 2, 3, 4, 5])));
    expect(bandButtons(html)).toBe(5);
    expect(html).toContain(`aria-label="${tipAria('M2\n$3\tsof')}"`);
  });

  it('MirrorColumns: one per week', () => {
    expect(bandButtons(render(h(MirrorColumns, mirrorProps())))).toBe(4);
  });

  it('DayColumns: one per day, including a day with nothing', () => {
    const html = render(h(DayColumns, dayProps([3, 0, 5, 0, 2])));
    expect(bandButtons(html)).toBe(5);
    // A zero day has no bar but keeps its band.
    expect(count(html, /data-day-bar=""/)).toBe(3);
  });

  it('tipAria speaks the tip as one line', () => {
    expect(tipAria('27 Sen\n12.4\tm³\n3\tprixod')).toBe('27 Sen · 12.4 m³ · 3 prixod');
    expect(tipAria(undefined)).toBeUndefined();
  });
});

function mirrorProps(extra: Partial<Parameters<typeof MirrorColumns>[0]> = {}) {
  return {
    bands: [
      { key: 'w1', label: '01.07' },
      { key: 'w2', label: '08.07' },
      { key: 'w3', label: '15.07' },
      { key: 'w4', label: 'Bu hafta', partial: true },
    ],
    inflow: [100, 50, 0, 20],
    outflow: [100, 25, 40, 10],
    top: 100,
    ticks: [0, 50, 100],
    tips: ['w1', 'w2', 'w3', 'w4'],
    labelled: new Set([0, 3]),
    netLabel: { index: 2, text: 'sof −$40' },
    testid: 'weeks',
    ...extra,
  };
}

describe('MirrorColumns — in up, out down, one scale, never red', () => {
  it('says «out» in orange and never in the urgency colour', () => {
    const source = code(`${CHARTS}/mirror-columns.tsx`);
    expect(source).not.toMatch(/\bbad\b|\bred\b/);
    const html = render(h(MirrorColumns, mirrorProps()));
    expect(html).toContain('bg-viz-out');
    expect(html).not.toMatch(/-bad\b|\bred\b/);
  });

  it('draws both sides on ONE scale: equal amounts, equal bars', () => {
    const html = render(h(MirrorColumns, mirrorProps()));
    const inH = /data-in=""[^>]*style="height:([\d.]+)%"/.exec(html)?.[1];
    const outH = /data-out=""[^>]*style="height:([\d.]+)%"/.exec(html)?.[1];
    expect(inH).toBe('50');
    expect(outH).toBe('50');
  });

  it('outlines the running week and fills the finished ones', () => {
    const html = render(h(MirrorColumns, mirrorProps()));
    expect(count(html, /border-2 border-viz-in bg-transparent/)).toBe(1);
    expect(count(html, /border-2 border-viz-out bg-transparent/)).toBe(1);
    // Three finished weeks with money in (w3 took nothing in) = two solid in-bars.
    expect(count(html, /data-in=""[^>]*class="[^"]*\bbg-viz-in\b/)).toBe(2);
  });

  it('prints the one net label where it was asked, and nowhere for a bad index', () => {
    expect(count(render(h(MirrorColumns, mirrorProps())), /data-net-label=""/)).toBe(1);
    expect(render(h(MirrorColumns, mirrorProps({ netLabel: { index: 9, text: 'x' } })))).not.toContain(
      'data-net-label',
    );
  });
});

function dayProps(values: number[], todayIndex: number | null = values.length - 1) {
  return {
    days: values.map((_, i) => ({ key: `2026-09-${String(i + 1).padStart(2, '0')}`, label: `${i + 1} Sen` })),
    values,
    todayIndex,
    top: 10,
    ticks: [0, 5, 10],
    tips: values.map((value, i) => `${i + 1} Sen\n${value}\tm³`),
    labelled: new Set([0, values.length - 1]),
    todayLabel: 'Bugun (hozircha) 2',
    testid: 'days',
  };
}

describe('DayColumns — past days ord2, today ord4, never ord1', () => {
  it('never uses the too-faint first ramp step', () => {
    expect(code(`${CHARTS}/day-columns.tsx`)).not.toContain('ord1');
    expect(render(h(DayColumns, dayProps([3, 4, 5])))).not.toContain('ord1');
  });

  it('draws the past in ord2 and the running day in ord4', () => {
    const html = render(h(DayColumns, dayProps([3, 4, 5])));
    expect(count(html, /bg-viz-ord2/)).toBe(2);
    expect(count(html, /bg-viz-ord4/)).toBe(1);
    expect(html).toContain('Bugun (hozircha) 2');
    // No today in the window: every bar is a past day, and no today label.
    const past = render(h(DayColumns, dayProps([3, 4, 5], null)));
    expect(count(past, /bg-viz-ord2/)).toBe(3);
    expect(past).not.toContain('data-today-label');
  });

  it('anchors the first x label left and the last right', () => {
    const html = render(h(DayColumns, dayProps([1, 2, 3, 4, 5])));
    expect(html).toMatch(/data-x-anchor="start" class="[^"]*\bleft-0\b[^"]*">1 Sen</);
    expect(html).toMatch(/data-x-anchor="end" class="[^"]*\bright-0\b[^"]*">5 Sen</);
  });
});

describe('dayLabel', () => {
  it('prints the day without its leading zero and the bundle month', () => {
    expect(dayLabel(NAMES, '2026-09-27')).toBe('27 Sen');
    expect(dayLabel(NAMES, '2026-01-05')).toBe('5 Yan');
    expect(dayLabel(NAMES, '2026-12-31')).toBe('31 Dek');
  });

  it('hands back what is not a date instead of «NaN undefined»', () => {
    expect(dayLabel(NAMES, 'kecha')).toBe('kecha');
    expect(dayLabel(NAMES, '2026-13-01')).toBe('2026-13-01');
    expect(dayLabel([], '2026-09-27')).toBe('2026-09-27');
  });
});

describe('the ✅ is the bundle’s own, printed once (judge O23)', () => {
  const locales = ['ru', 'uz', 'zh-CN', 'en'];
  const allClear = (locale: string) =>
    (JSON.parse(readFileSync(`messages/${locale}.json`, 'utf8')) as { dashboard: { allClear: string } }).dashboard
      .allClear;

  it('is already in every locale’s sentence (the premise)', () => {
    for (const locale of locales) expect(allClear(locale).startsWith('✅'), locale).toBe(true);
  });

  it('AttentionList prints one tick', () => {
    for (const locale of locales) {
      const html = render(h(AttentionList, { visible: [], hidden: [], moreLabel: '', emptyLabel: allClear(locale) }));
      expect(count(html, /✅/), locale).toBe(1);
    }
  });

  it('AttentionCards prints one tick, in one calm card', () => {
    for (const locale of locales) {
      const html = render(h(AttentionCards, { rows: [], levelLabel: LEVELS, emptyLabel: allClear(locale) }));
      expect(count(html, /✅/), locale).toBe(1);
      expect(html).toContain('bg-good/10');
      expect(html).not.toContain('<a');
    }
  });
});

const LEVELS = { bad: 'Muhim', warn: 'Diqqat', info: 'Ma’lumot' };

describe('AttentionCards', () => {
  const rows: AttentionRow[] = [
    { kind: 'lost', level: 'bad', text: '3 ta karobka yo‘qolgan', value: '$1,200', href: '/reports/lost' },
    { kind: 'unpriced', level: 'warn', text: 'Narxsiz yuk', href: '/finance/narxsiz' },
    { kind: 'approvals', level: 'info', text: 'Ruxsat kutmoqda', href: '/approvals' },
  ];
  const html = render(h(AttentionCards, { rows, levelLabel: LEVELS, emptyLabel: '✅ ok', testid: 'dash-alerts' }));

  it('makes each card ONE link with its own testid and href', () => {
    expect(count(html, /<a /)).toBe(3);
    expect(html).toContain('data-testid="dash-alerts"');
    expect(html).toMatch(/<a [^>]*href="\/reports\/lost"[^>]*data-testid="att-lost"|data-testid="att-lost"[^>]*href/);
    expect(html).toContain('data-testid="att-unpriced"');
    expect(html).toContain('data-testid="att-approvals"');
  });

  it('says the level three ways: icon shape, word, tint', () => {
    const card = (kind: string) => html.slice(html.indexOf(`data-testid="att-${kind}"`)).split('</a>')[0]!;
    expect(card('lost')).toContain('bg-bad/10');
    expect(card('lost')).toContain('rounded-full bg-bad');
    expect(card('lost')).toContain('text-bad');
    expect(card('lost')).toContain('Muhim');
    expect(card('unpriced')).toContain('bg-warn/10');
    expect(card('unpriced')).toContain('rounded-full bg-warn');
    expect(card('unpriced')).toContain('Diqqat');
    expect(card('approvals')).toContain('bg-surface-sunken');
    expect(card('approvals')).toContain('rounded-full bg-ink-400');
    expect(card('approvals')).toContain('text-ink-500');
    // The icon sits in its circle in the surface colour.
    expect(count(html, /<svg[^>]*class="shrink-0 h-4 w-4 text-surface-raised"/)).toBe(3);
    // Warn and bad share the alert glyph; info has a different one.
    const glyph = (kind: string) => /<svg[^>]*>([\s\S]*?)<\/svg>/.exec(card(kind))![1];
    expect(glyph('lost')).toBe(glyph('unpriced'));
    expect(glyph('approvals')).not.toBe(glyph('lost'));
  });

  it('prints the money and clamps the sentence at three lines', () => {
    expect(html).toContain('$1,200');
    expect(count(html, /line-clamp-3/)).toBe(3);
    expect(html).not.toMatch(/\bblock\b[^"]*line-clamp-3|line-clamp-3[^"]*\bblock\b/);
  });

  it('does not widen the level union (judge O24)', () => {
    expect(readFileSync('src/modules/wms/reports/dashboard-math.ts', 'utf8')).toContain(
      "export type AttentionLevel = 'bad' | 'warn' | 'info';",
    );
  });
});

describe('StatTile variants leave every existing tile as it was', () => {
  const base = { href: '/accounting/pnl', label: 'Tushum', value: '$124.5K' };

  it('carries the exact figure as data-value on the value itself', () => {
    const html = render(h(StatTile, { ...base, exact: '124512.37', testid: 'tile-revenue' }));
    expect(html).toMatch(/<p data-value="124512.37" class="[^"]*font-mono[^"]*">\$124.5K<\/p>/);
  });

  it('renders no data-value, no tag row and the old size when none is asked', () => {
    const html = render(h(StatTile, base));
    expect(html).not.toContain('data-value');
    expect(html).not.toContain('flex-wrap');
    expect(html).toContain('text-xl');
    expect(html).not.toContain('text-2xl');
  });

  it('grows to text-2xl on size lg and puts the tag after the label, inside the link', () => {
    const html = render(h(StatTile, { ...base, size: 'lg', tag: h(ScopeTag, { label: 'Hozir' }) }));
    expect(html).toContain('text-2xl');
    expect(html).not.toMatch(/\btext-xl\b/);
    const link = html.slice(html.indexOf('<a '), html.indexOf('</a>'));
    expect(link.indexOf('Tushum')).toBeLessThan(link.indexOf('Hozir'));
  });
});

describe('PlanMeter thick', () => {
  const progress = { pct: 40, pace: 0.5, behind: true, done: false };
  it('is h-1 by default and h-2.5 when thick', () => {
    expect(render(h(PlanMeter, { progress }))).toMatch(/class="relative rounded-full bg-viz-in\/15 h-1 /);
    expect(render(h(PlanMeter, { progress, thick: true }))).toMatch(/class="relative rounded-full bg-viz-in\/15 h-2\.5 /);
  });
});

describe('ScopeTag is neutral (judge O21)', () => {
  it('never wears the brand tint', () => {
    expect(code(`${CHARTS}/scope-tag.tsx`)).not.toContain('chip-brand');
    const html = render(h(ScopeTag, { label: 'Butun kompaniya', testid: 'scope' }));
    expect(html).toContain('chip-neutral');
    expect(html).toContain('whitespace-nowrap');
    expect(html).toContain('Butun kompaniya');
  });
});

describe('MeterRow', () => {
  it('draws no bar when the share is unknown — unknown is not zero', () => {
    const html = render(h(MeterRow, { label: 'B-00121', value: '—', pct: null, barClass: 'bg-viz-in' }));
    expect(html).not.toContain('data-meter');
    expect(html).not.toContain('<a');
  });

  it('draws the caller’s class at the clamped width and links when asked', () => {
    const html = render(
      h(MeterRow, { href: '/batches/1', label: 'B-00121', value: '62%', pct: 62, barClass: 'bg-warn', testid: 'r' }),
    );
    expect(html).toMatch(/<a [^>]*href="\/batches\/1"/);
    expect(html).toContain('class="block h-full rounded-full bg-warn" style="width:62%"');
    expect(html).toContain('min-w-0 truncate');
    expect(html).toContain('whitespace-nowrap');
  });

  it('meterWidth: null stays null, 0 is an empty track, a sliver is visible, the top is 100', () => {
    expect(meterWidth(null)).toBeNull();
    expect(meterWidth(Number.NaN)).toBeNull();
    expect(meterWidth(0)).toBe(0);
    expect(meterWidth(-5)).toBe(0);
    expect(meterWidth(0.4)).toBe(2);
    expect(meterWidth(55)).toBe(55);
    expect(meterWidth(140)).toBe(100);
  });
});

describe('WarehouseFillRows stacked', () => {
  const labels = { noCapacity: 'sig‘im kiritilmagan', oldestTitle: 't', daysShort: 'kun', oldestNote: 'n' };
  const row = (code: string, pct: number | null, oldestDays: number | null = 12) => ({
    id: `id-${code}`,
    code,
    capacityM3: pct === null ? null : 100,
    occupiedM3: 42,
    pct,
    oldestDays,
    staleCount: 0,
  });
  const view = (layout: 'row' | 'stacked', rows = [row('YW', 59), row('GZ', 60), row('TAS', 80), row('AND', null)]) =>
    render(h(WarehouseFillView, { rows, staleDays: 30, canEditCapacity: true, layout, labels }));

  it('puts the code and figure on line 1 and the bar alone on its own full-width line', () => {
    const html = view('stacked');
    expect(html).toContain('data-layout="stacked"');
    expect(count(html, /data-testid="wh-fill-row"/)).toBe(4);
    expect(html).toMatch(
      /<div class="flex items-baseline justify-between gap-2"><span class="min-w-0 truncate[^"]*">YW<\/span><span class="shrink-0 whitespace-nowrap[^"]*">42 m³ · 59%<\/span><\/div><div class="flex min-w-0"><div class="h-3 min-w-0 flex-1[^"]*" data-testid="wh-fill-bar">/,
    );
    // No capacity: the sentence takes the bar's line, as a link for an editor.
    expect(html).toMatch(/<div class="flex min-w-0"><span [^>]*data-testid="wh-fill-nocap"><a [^>]*href="\/admin\/warehouses\/id-AND"/);
    expect(count(html, /data-testid="wh-fill-age"/)).toBe(4);
  });

  it('keeps the 60/80 thresholds and the literal colours in both layouts', () => {
    for (const layout of ['row', 'stacked'] as const) {
      const html = view(layout);
      const bar = (code: string) =>
        /data-testid="wh-fill-bar"><div class="h-full (bg-[a-z]+)"/.exec(html.slice(html.indexOf(`>${code}<`)))![1];
      expect(bar('YW'), layout).toBe('bg-good');
      expect(bar('GZ'), layout).toBe('bg-warn');
      expect(bar('TAS'), layout).toBe('bg-bad');
    }
  });

  it('leaves the one-line row as it was', () => {
    const html = view('row');
    expect(html).toContain('data-layout="row"');
    expect(html).toMatch(/<div class="flex items-center gap-2 text-xs" data-testid="wh-fill-row"><span class="w-14 shrink-0/);
  });
});
