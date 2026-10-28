// FIRST: the components compile to the classic `React.createElement`.
import '../fixtures/react-global';
import { readFileSync } from 'node:fs';
import { createElement as h } from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import { createTranslator } from 'next-intl';
import { describe, expect, it } from 'vitest';
import { FeedRow, type FeedMarks } from '@/components/client-feed';
import type { FeedItem } from '@/modules/wms/crm/feed';

/**
 * The lenta's machine-reply chip RENDERED (docs/SAKKIZ-R2.md §9.3, his 2.4 c):
 * a note the machine wrote about a calculation says so — and says when an
 * estimate is inside — without the note being opened, in the uz bundle's own
 * words; a plain note says nothing of the kind.
 *
 * The marks are built from the bundle exactly as the panel builds them, so a
 * key renamed in `messages/uz.json` and not here turns this red instead of
 * printing a key name on every machine note.
 */
const uz = JSON.parse(readFileSync('messages/uz.json', 'utf8'));
const tth = createTranslator({ locale: 'uz', messages: uz, namespace: 'threads' });
const t = createTranslator({ locale: 'uz', messages: uz, namespace: 'crm' });

const marks: FeedMarks = {
  calc: tth('feedCalcThread'),
  telegram: tth('feedViaTelegram'),
  ai: tth('feedAiReply'),
  tariff: tth('feedTariffReply'),
  estimate: tth('feedEstimateReply'),
};

const note = (machineReply: unknown): FeedItem => ({
  id: 'ac-1',
  kind: 'note',
  at: new Date('2026-10-21T09:00:00Z'),
  actor: null,
  body: 'matn',
  meta: {
    kind: 'note',
    authorId: null,
    calcRequestId: null,
    viaTelegram: false,
    files: [],
    machineReply,
  },
});

const render = (item: FeedItem) =>
  renderToStaticMarkup(
    h(FeedRow, {
      item,
      // The panel binds `getTranslations('crm')`; the row only calls it.
      t: t as unknown as Parameters<typeof FeedRow>[0]['t'],
      viewerId: 'someone-else',
      calcHref: null,
      marks,
    }),
  );

const chip = (html: string) =>
  html.match(/data-testid="feed-machine-reply"[^>]*>([^<]*)</)?.[1] ?? null;

describe('a machine’s calculation answer wears its chip on the lenta', () => {
  it('the bundle carries the three words the chip prints', () => {
    // Literals by hand — §10's table — so the words are pinned, not echoed.
    expect(marks.ai).toBe('🤖 AI taxmini · rasmiy emas');
    expect(marks.tariff).toBe('🧮 Tarif bo‘yicha taxmin · rasmiy emas');
    expect(marks.estimate).toBe('📊 Ichida taxmin bor · rasmiy emas — VED tekshiradi');
  });

  it('«ai», «tariff» and «estimate» each print their own words, warn-toned', () => {
    expect(chip(render(note('ai')))).toBe('🤖 AI taxmini · rasmiy emas');
    expect(chip(render(note('tariff')))).toBe('🧮 Tarif bo‘yicha taxmin · rasmiy emas');
    expect(chip(render(note('estimate')))).toBe(
      '📊 Ichida taxmin bor · rasmiy emas — VED tekshiradi',
    );
    // The tone is a literal class (Tailwind compiles only what it can see).
    expect(render(note('estimate'))).toMatch(
      /class="ml-1\.5 font-semibold text-warn" data-testid="feed-machine-reply"/,
    );
  });

  it('a plain note carries no chip — nor does a value the union does not know', () => {
    expect(render(note(null))).not.toContain('feed-machine-reply');
    expect(render(note(undefined))).not.toContain('feed-machine-reply');
    // jsonb hands back plain JSON: an unknown word is no chip, never a blank one.
    expect(render(note('advert'))).not.toContain('feed-machine-reply');
  });

  it('only a note can wear it — a row of another kind never does', () => {
    const cargo: FeedItem = {
      ...note('ai'),
      kind: 'cargo',
      meta: { number: 'R-1', machineReply: 'ai' },
    };
    expect(render(cargo)).not.toContain('feed-machine-reply');
  });
});
