import { draftWorthy, type BurstMessage } from './worthy';

/**
 * How many drafts the pilot WOULD produce (review fit-14, his Q17 ⭐) —
 * counted before anything is switched on, from what his account already
 * stores. The listener's stranger counters are in memory and tg_messages
 * holds only client and lead chats, so the honest measure is: the customer
 * bursts of the last days, split by the same `draftWorthy` the worker asks,
 * plus the distinct strangers the tray holds. Pure here; the script reads.
 */

export interface CensusMessage {
  peerId: string;
  direction: 'in' | 'out';
  body: string | null;
  /** 'photo' | 'voice' | 'audio' | 'document' | 'other' — as the context would read it; null = text only. */
  media: string | null;
  /** The Tashkent day the message was sent, `YYYY-MM-DD`. */
  day: string;
}

export interface CensusDay {
  day: string;
  bursts: number;
  worthy: number;
  greetingOnly: number;
  /** `draftWorthy`'s refusals, by reason (closing, media_only, voice_only, pashto, bot_question). */
  notWorthy: Record<string, number>;
}

/** «?» at the end of our last message — then a customer's «ok» is an ANSWER. */
function asks(body: string | null): boolean {
  return /[?؟？]\s*$/u.test((body ?? '').trim());
}

/**
 * Split each chat into bursts — the customer's messages since our last out
 * row, the run's own unit (context.ts `loadContext`) — and judge each one,
 * dated by its LAST message. `messages` must be in time order per chat.
 */
export function censusDays(messages: readonly CensusMessage[]): CensusDay[] {
  const days = new Map<string, CensusDay>();
  const dayOf = (day: string) => {
    let d = days.get(day);
    if (!d) {
      d = { day, bursts: 0, worthy: 0, greetingOnly: 0, notWorthy: {} };
      days.set(day, d);
    }
    return d;
  };
  const byPeer = new Map<string, CensusMessage[]>();
  for (const m of messages) {
    const list = byPeer.get(m.peerId) ?? [];
    list.push(m);
    byPeer.set(m.peerId, list);
  }
  for (const list of byPeer.values()) {
    let burst: CensusMessage[] = [];
    let lastOut: CensusMessage | null = null;
    const close = () => {
      if (burst.length === 0) return;
      const verdict = draftWorthy(
        burst.map((m): BurstMessage => ({ text: m.body, media: m.media })),
        lastOut ? asks(lastOut.body) : false,
      );
      const d = dayOf(burst[burst.length - 1]!.day);
      d.bursts += 1;
      if (verdict.worthy) {
        d.worthy += 1;
        if (verdict.greetingOnly) d.greetingOnly += 1;
      } else {
        d.notWorthy[verdict.reason] = (d.notWorthy[verdict.reason] ?? 0) + 1;
      }
      burst = [];
    };
    for (const m of list) {
      if (m.direction === 'out') {
        close();
        lastOut = m;
      } else {
        burst.push(m);
      }
    }
    close();
  }
  return [...days.values()].sort((a, b) => a.day.localeCompare(b.day));
}

/** The context's own media words for an attachment (context.ts `mediaOf`, restated: that one is private). */
export function mediaWord(contentType: string | null, fileName: string | null, hasMedia: boolean): string | null {
  if (!hasMedia) return null;
  if (!contentType) return 'other';
  if (contentType.startsWith('image/')) return 'photo';
  if (contentType.startsWith('audio/')) return /voice/iu.test(fileName ?? '') || contentType.includes('ogg') ? 'voice' : 'audio';
  return 'document';
}
