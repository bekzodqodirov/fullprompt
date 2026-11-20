import { describe, expect, it } from 'vitest';
import { AUTO_REFUSAL_WORDS, AUTO_REFUSALS } from '@/modules/wms/agent/auto-gate';
import { NO_DRAFT_WORDS } from '@/modules/wms/agent/calc-loop';
import { eligibleForRun, type EligibilityFacts } from '@/modules/wms/agent/eligibility';
import { AGENT_LIMITS } from '@/modules/wms/agent/limits';
import { LOOP_NOTICE, loopBucketStart, loopFold, loopSignalKey, loopVerdict, type LoopFacts, type LoopLine } from '@/modules/wms/agent/loop';

/**
 * Stage 1a P2 «Halqa» (docs/ai-toliq/qurish/STAGE-0-1A.md §4.3, J8, J33): the detector that replaced eligibility's
 * `repeat` and the gate's `streak`. Pure: each case hands it the facts `loopFactsFor` would read. The reader corpus
 * (agent-reader-corpus.ts, reader `loop`) holds the both-kinds scripts; this file holds the rules one at a time, each
 * shown red by a paired string edit of the rule it names.
 */

const T0 = Date.parse('2026-11-20T07:00:00Z');
const at = (sec: number) => new Date(T0 + sec * 1000);
const ln = (sec: number, body = ''): LoopLine => ({ at: at(sec), body });

/** A chat: the customer's lines (the last is the anchor), our sends, his newest typing, the reply about to go. */
function facts(over: { lines: LoopLine[]; sends?: LoopLine[]; typingAt?: Date | null; draft?: LoopLine | null }): LoopFacts {
  return {
    anchor: over.lines.at(-1) ?? null,
    inbound: over.lines.slice(0, -1),
    sends: over.sends ?? [],
    typingAt: over.typingAt ?? null,
    draft: over.draft ?? null,
  };
}
const signals = (f: LoopFacts) => [...loopVerdict(f).signals];

describe('the CHAT loop detector (stage 1a P2 «Halqa») — the customer’s chat, never the model’s tool loop of agent-loop.integration', () => {
  describe('same_inbound — the anchor’s words a third time', () => {
    it('the FIRST repeat is answered (an impatient customer); the second stops', () => {
      const sends = [ln(20, 'Assalomu alaykum!')];
      expect(signals(facts({ lines: [ln(0, 'Salom'), ln(300, 'Salom')], sends }))).toEqual([]);
      expect(signals(facts({ lines: [ln(0, 'Salom'), ln(300, 'Salom'), ln(600, 'Salom')], sends }))).toEqual(['same_inbound']);
    });

    it('three caption-less photos in a row are never «the same line again» (the text-less guard)', () => {
      expect(signals(facts({ lines: [ln(0), ln(3), ln(6)] }))).toEqual([]);
    });

    it('…and a caption-less anchor after two equal texts is no repeat of them', () => {
      expect(signals(facts({ lines: [ln(0, 'Mana invoys'), ln(60, 'Mana invoys'), ln(120)] }))).toEqual([]);
    });

    it('«5 kub narxi?» / «7 kub narxi?» / «10 kub narxi?» are three lines — the fold keeps the figures', () => {
      const lines = [ln(0, '5 kub narxi qancha?'), ln(60, '7 kub narxi qancha?'), ln(120, '10 kub narxi qancha?')];
      expect(signals(facts({ lines }))).toEqual([]);
    });

    it('the fold: case and a run of spaces make no other line', () => {
      expect(loopFold('  Xabaringiz   QABUL\tqilindi. ')).toBe('xabaringiz qabul qilindi.');
      const lines = [ln(0, 'Xabaringiz qabul qilindi.'), ln(60, 'xabaringiz  qabul qilindi.'), ln(120, 'XABARINGIZ QABUL QILINDI.')];
      expect(signals(facts({ lines }))).toEqual(['same_inbound']);
    });

    it('an old window clears: the two equal lines more than 30 minutes before the anchor count for nothing', () => {
      const lines = [ln(0, 'Salom'), ln(300, 'Salom'), ln(300 + 30 * 60 + 1, 'Salom')];
      expect(signals(facts({ lines }))).toEqual([]);
      // …while one still inside it counts with the anchor's own.
      expect(signals(facts({ lines: [ln(0, 'Salom'), ln(300, 'Salom'), ln(30 * 60, 'Salom')] }))).toEqual(['same_inbound']);
    });
  });

  describe('fast_peer — answers within 10 s of three DISTINCT sends (J8)', () => {
    const sends = [ln(0, 'Assalomu alaykum!'), ln(30, 'Qayerdan?'), ln(60, 'Necha kub?')];

    it('a responder that stamps a counter: three different lines, a second after each send', () => {
      const lines = [ln(1, 'Ticket #1'), ln(31, 'Ticket #2'), ln(61, 'Ticket #3')];
      expect(signals(facts({ lines, sends }))).toEqual(['fast_peer']);
    });

    it('three quick lines after ONE send are one answer — a person answering in pieces', () => {
      const lines = [ln(4, 'ha'), ln(6, 'Yiwudan'), ln(9, '5 kub 800 kg')];
      expect(signals(facts({ lines, sends: [ln(0, 'Qayerdan va necha kub?')] }))).toEqual([]);
    });

    it('two sends answered fast are not three', () => {
      expect(signals(facts({ lines: [ln(3, 'Yiwu'), ln(33, '5')], sends: sends.slice(0, 2) }))).toEqual([]);
    });

    it('ten seconds is fast, eleven is not', () => {
      expect(signals(facts({ lines: [ln(10, 'a'), ln(40, 'b'), ln(70, 'c')], sends }))).toEqual(['fast_peer']);
      expect(signals(facts({ lines: [ln(10, 'a'), ln(40, 'b'), ln(71, 'c')], sends }))).toEqual([]);
    });

    it('an answer stamped in the very second of the send (Telegram’s whole second, our clock after the RPC) is its answer', () => {
      const ours = [ln(0.8, 'Assalomu alaykum!'), ln(30.8, 'Qayerdan?'), ln(60.8, 'Necha kub?')];
      expect(signals(facts({ lines: [ln(0, 'Avto'), ln(30, 'Avto!'), ln(60, 'Avto!!')], sends: ours }))).toEqual(['fast_peer']);
    });

    it('the person typed: the newest stamp after a send leaves that send — and every one before it — uncounted', () => {
      const lines = [ln(6, 'Yiwudan'), ln(36, '5 kub'), ln(67, '800 kg')];
      // Typing before the last answer only: J8's own case.
      expect(signals(facts({ lines, sends, typingAt: at(63) }))).toEqual([]);
      // Four quick answers, typing before the fourth: the one stamp the listener keeps cannot tell the first three.
      const four = [...sends, ln(90, 'Qachon?')];
      expect(signals(facts({ lines: [...lines.slice(0, 2), ln(66, '800 kg'), ln(97, 'Ertaga')], sends: four, typingAt: at(93) }))).toEqual([]);
    });

    it('…and a stamp older than every send says nothing about the lines after them', () => {
      const lines = [ln(11, 'Auto 1'), ln(41, 'Auto 2'), ln(72, 'Auto 3')];
      const later = [ln(10, 'Salom'), ln(40, 'Qayerdan?'), ln(70, 'Necha kub?')];
      expect(signals(facts({ lines, sends: later, typingAt: at(0) }))).toEqual(['fast_peer']);
    });

    it('slow answers between fast ones do not cancel them', () => {
      const ours = [ln(0, 'a'), ln(30, 'b'), ln(90, 'c'), ln(120, 'd'), ln(200, 'e')];
      const lines = [ln(2, 'A'), ln(55, 'x'), ln(93, 'B'), ln(160, 'y'), ln(204, 'C')];
      expect(signals(facts({ lines, sends: ours }))).toEqual(['fast_peer']);
    });
  });

  describe('own_repeat — the reply about to go, word for word one of our last three sends (the gate)', () => {
    const sends = [ln(15, 'Assalomu alaykum! Qanday yordam bera olaman?')];

    it('the same words stop the machine; folded the same', () => {
      expect(signals(facts({ lines: [ln(60, 'Salom?')], sends, draft: ln(75, 'Assalomu alaykum! Qanday yordam bera olaman?') }))).toEqual(['own_repeat']);
      expect(signals(facts({ lines: [ln(60, 'Salom?')], sends, draft: ln(75, 'assalomu alaykum!  QANDAY yordam bera olaman?') }))).toEqual(['own_repeat']);
    });

    it('the same wording with other figures is another reply', () => {
      const quote = [ln(20, '5 kub, 800 kg yukingiz uchun Toshkentgacha taxminan 960 $.')];
      const draft = ln(80, '7 kub, 900 kg yukingiz uchun Toshkentgacha taxminan 1100 $.');
      expect(signals(facts({ lines: [ln(60, '7 kub 900 kg-chi?')], sends: quote, draft }))).toEqual([]);
    });

    it('our words more than 30 minutes ago, or four sends ago, are not a repeat', () => {
      expect(signals(facts({ lines: [ln(1900, 'Salom')], sends, draft: ln(15 + 30 * 60 + 1, sends[0]!.body) }))).toEqual([]);
      const ours = [ln(0, 'Yana savol bo‘lsa yozing.'), ln(60, 'Qayerdan?'), ln(120, 'Og‘irligi?'), ln(180, 'Hisoblab aytaman.')];
      expect(signals(facts({ lines: [ln(210, 'ok')], sends: ours, draft: ln(230, 'Yana savol bo‘lsa yozing.') }))).toEqual([]);
      expect(signals(facts({ lines: [ln(210, 'ok')], sends: ours, draft: ln(230, 'Qayerdan?') }))).toEqual(['own_repeat']);
    });

    it('eligibility hands no draft — own_repeat is never asked there', () => {
      expect(signals(facts({ lines: [ln(60, 'Salom?')], sends }))).toEqual([]);
    });
  });

  describe('eligibility says `loop`, never `repeat` any more — and the stored word stays readable', () => {
    const now = new Date(T0);
    const f: EligibilityFacts = {
      now,
      agentOn: true,
      sessionConfirmed: true,
      listenerCurrent: true,
      accountPaused: false,
      privateUser: true,
      hasOwner: true,
      ruleExcluded: false,
      peerIsStaff: false,
      muted: false,
      humanActive: false,
      anchorIsNewest: true,
      anchorSentAt: new Date(T0 - 60_000),
      anchorMaxAgeMs: AGENT_LIMITS.anchorMaxAgeMs,
      anchorAutoSent: false,
      lastOutAt: null,
      loop: false,
    };

    it('a loop refuses the run as `loop`', () => {
      expect(eligibleForRun(f)).toEqual({ ok: true });
      expect(eligibleForRun({ ...f, loop: true })).toEqual({ ok: false, reason: 'loop' });
    });

    it('a stored `repeat` still prints its word; `loop` prints the one word', () => {
      expect(NO_DRAFT_WORDS.repeat).toBe('takror xabar');
      expect(NO_DRAFT_WORDS.loop).toBe(AUTO_REFUSAL_WORDS.loop);
    });
  });

  describe('one word for the one loop, and the notice said once per bucket (J33)', () => {
    it('the notice, the gate’s word and the follow-up’s word are «suhbat aylanib qoldi»; the notice is the ruling’s sentence', () => {
      expect(AUTO_REFUSAL_WORDS.loop).toBe('suhbat aylanib qoldi');
      expect(AUTO_REFUSALS as readonly string[]).toContain('loop');
      expect(LOOP_NOTICE).toBe(
        "🔁 Bu suhbat aylanib qoldi (avtojavob bo'lishi mumkin) — AI 30 daqiqa bu chatga javob yozmaydi, o'zingiz qarang.",
      );
    });

    it('the bucket is the anchor’s moment floored to the window — a fixed bucket, never the sliding start', () => {
      expect(loopBucketStart(new Date('2026-11-20T07:29:59.999Z')).toISOString()).toBe('2026-11-20T07:00:00.000Z');
      expect(loopBucketStart(new Date('2026-11-20T07:30:00.000Z')).toISOString()).toBe('2026-11-20T07:30:00.000Z');
      expect(loopSignalKey(77n, new Date('2026-11-20T07:12:00Z'))).toBe('loop:77:2026-11-20T07:00:00.000Z');
      // Two lines of one bucket claim one key.
      expect(loopSignalKey(77n, new Date('2026-11-20T07:01:00Z'))).toBe(loopSignalKey(77n, new Date('2026-11-20T07:28:00Z')));
    });
  });
});
