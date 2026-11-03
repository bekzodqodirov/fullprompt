import { describe, expect, it } from 'vitest';
import { censusDays, mediaWord, type CensusMessage } from '@/modules/wms/agent/census';

/**
 * The census counts bursts the way the worker sees them (review fit-14): the
 * customer's messages since our last out row, judged by `draftWorthy`, dated
 * by their last message. A «rahmat» after a statement is not a draft; after a
 * QUESTION it is an answer and is one.
 */

const msg = (peerId: string, direction: 'in' | 'out', body: string | null, day = '2026-10-20', media: string | null = null): CensusMessage => ({
  peerId,
  direction,
  body,
  media,
  day,
});

describe('censusDays', () => {
  it('splits a chat into bursts at our replies and judges each one', () => {
    const days = censusDays([
      msg('1', 'in', 'Salom'),
      msg('1', 'in', 'Yiwudan 3 kub yuk bor, qancha turadi?'),
      msg('1', 'out', 'Assalomu alaykum, aniqlab aytaman.'),
      msg('1', 'in', 'Rahmat'),
    ]);
    expect(days).toEqual([
      { day: '2026-10-20', bursts: 2, worthy: 1, greetingOnly: 0, notWorthy: { closing: 1 } },
    ]);
  });

  it('counts «ok» after OUR question as an answer worth a draft', () => {
    const days = censusDays([msg('1', 'out', 'Ertaga yuborsak bo‘ladimi?'), msg('1', 'in', 'ok')]);
    expect(days[0]).toMatchObject({ bursts: 1, worthy: 1 });
  });

  it('dates a burst by its LAST message, keeps chats apart, and counts the honest refusals', () => {
    const days = censusDays([
      msg('1', 'in', 'Salom', '2026-10-19'),
      msg('1', 'in', 'Yuk qayerda?', '2026-10-20'),
      msg('2', 'in', null, '2026-10-20', 'voice'),
    ]);
    expect(days).toEqual([
      { day: '2026-10-20', bursts: 2, worthy: 1, greetingOnly: 0, notWorthy: { voice_only: 1 } },
    ]);
  });

  it('reads media the way the run’s context does', () => {
    expect(mediaWord(null, null, false)).toBeNull();
    expect(mediaWord(null, null, true)).toBe('other');
    expect(mediaWord('image/jpeg', 'a.jpg', true)).toBe('photo');
    expect(mediaWord('audio/ogg', 'x.oga', true)).toBe('voice');
    expect(mediaWord('application/pdf', 'invoice.pdf', true)).toBe('document');
  });
});
