/**
 * The ORDINARY corpus cases the readers still get wrong (agent-reader-corpus.ts) — each held for his ✅ (or made his
 * question) where it should go, and each kept that way on purpose: freeing it would open a dangerous case, or would
 * need grammar no rule here reads reliably. They run as `it.fails`: a change that makes one go turns it RED until its
 * id leaves this list, so the list can only shrink and nothing on it is forgotten. A DANGEROUS case never goes on it —
 * the runner refuses one — and a case that newly fails is a regression, never a line here.
 */
export const KNOWN_HELD: ReadonlyMap<string, string> = new Map<string, string>([
  // ── language (fix pass 4) ───────────────────────────────────────────────────────────────────────────────────────
  // An English greeting over words that mark no language leans English and stays a GUESS: English goes only on a
  // confident one (spec §4), and «Hello» + «5 cbm, 800 kg» cannot tell an English customer from an Uzbek one who says
  // «Hello» — so the English reply waits for his ✅ (and the Uzbek one is refused: lg006, dangerous, holds).
  ['lg221', 'an English greeting over unmarked words: an unconfident guess; English goes only on a confident one'],
  ['lg224', 'an English greeting over unmarked words: an unconfident guess; English goes only on a confident one'],
  // A Russian greeting over unmarked Cyrillic, first contact (nothing stored): the guess leans Russian, and the rule
  // cannot tell an Uzbek on a Russian keyboard from a Russian customer — the Uzbek reply waits. In a chat stored Uzbek
  // Cyrillic the same lines go (lg211, lg212).
  ['lg228', 'a Russian greeting over unmarked Cyrillic with nothing stored leans Russian; the Uzbek reply waits'],
  ['lg229', 'a Russian greeting over unmarked Cyrillic with nothing stored leans Russian; the Uzbek reply waits'],

  // ── money: another reader's rule ────────────────────────────────────────────────────────────────────────────────
  // G2 (policy, the company's payment rule) reads «оплата по прибытии» without «до получения» as a credit promise
  // (`promise:credit_release`): the currency reader passes it; the policy's own rule holds it.
  ['mn211', 'G2 reads «оплата по прибытии» with no «до получения» as credit — the policy’s payment rule, not this reader'],

  // ── han: the machine presses no Chinese numeral run (0148 fix, by design) ───────────────────────────────────────
  // G1 keeps his ✅ on these (hg201, hg203 go); the press refuses `numeral_unread` on any run it kept, because a
  // character is a word as often as a number and the reader cannot tell «十点» (ten o’clock) from «十» (ten).
  ['hn220', 'numeral_unread: the machine presses no Chinese numeral run — «早上十点» is ten o’clock and a run all the same'],
  ['hn221', 'numeral_unread: the machine presses no Chinese numeral run — «晚上十点» is ten o’clock and a run all the same'],
  ['hn222', 'numeral_unread: the machine presses no Chinese numeral run — «三家» counts factories and is a run all the same'],
]);
