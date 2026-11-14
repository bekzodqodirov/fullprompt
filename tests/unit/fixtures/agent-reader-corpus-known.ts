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
  // (lg228, lg229 left the list in fix pass 6: «Гуанчжоудан» — a place with an Uzbek case on it — is Uzbek's alone.)
  // A first message that says no language (fix pass 7, the check #4): once the customer has said his language — stored,
  // or confidently in an earlier line of the window — the same lines lean on it and go (lg283-lg286); with nothing at
  // all to lean on, which reply is right cannot be told, and the reply waits for his ✅.
  ['lg287', 'a FIRST message that says no language — a code, a number with its unit, an emoji, a caption, an unmarked line — with nothing stored and nothing said before it in the window: the guess leans on nothing, and the reply is his (fix pass 7, the check #4 — the stated trade)'],
  ['lg288', 'a FIRST message that says no language — a code, a number with its unit, an emoji, a caption, an unmarked line — with nothing stored and nothing said before it in the window: the guess leans on nothing, and the reply is his (fix pass 7, the check #4 — the stated trade)'],
  ['lg289', 'a FIRST message that says no language — a code, a number with its unit, an emoji, a caption, an unmarked line — with nothing stored and nothing said before it in the window: the guess leans on nothing, and the reply is his (fix pass 7, the check #4 — the stated trade)'],
  ['lg290', 'a FIRST message that says no language — a code, a number with its unit, an emoji, a caption, an unmarked line — with nothing stored and nothing said before it in the window: the guess leans on nothing, and the reply is his (fix pass 7, the check #4 — the stated trade)'],
  ['lg291', 'a FIRST message that says no language — a code, a number with its unit, an emoji, a caption, an unmarked line — with nothing stored and nothing said before it in the window: the guess leans on nothing, and the reply is his (fix pass 7, the check #4 — the stated trade)'],
  ['lg292', 'a FIRST message that says no language — a code, a number with its unit, an emoji, a caption, an unmarked line — with nothing stored and nothing said before it in the window: the guess leans on nothing, and the reply is his (fix pass 7, the check #4 — the stated trade)'],
  ['lg293', 'a FIRST message that says no language — a code, a number with its unit, an emoji, a caption, an unmarked line — with nothing stored and nothing said before it in the window: the guess leans on nothing, and the reply is his (fix pass 7, the check #4 — the stated trade)'],
  ['lg294', 'a FIRST message that says no language — a code, a number with its unit, an emoji, a caption, an unmarked line — with nothing stored and nothing said before it in the window: the guess leans on nothing, and the reply is his (fix pass 7, the check #4 — the stated trade)'],
  ['lg295', 'a FIRST message that says no language — a code, a number with its unit, an emoji, a caption, an unmarked line — with nothing stored and nothing said before it in the window: the guess leans on nothing, and the reply is his (fix pass 7, the check #4 — the stated trade)'],
  ['lg296', 'a FIRST message that says no language — a code, a number with its unit, an emoji, a caption, an unmarked line — with nothing stored and nothing said before it in the window: the guess leans on nothing, and the reply is his (fix pass 7, the check #4 — the stated trade)'],
  ['lg297', 'a FIRST message that says no language — a code, a number with its unit, an emoji, a caption, an unmarked line — with nothing stored and nothing said before it in the window: the guess leans on nothing, and the reply is his (fix pass 7, the check #4 — the stated trade)'],
  ['lg298', 'a FIRST message that says no language — a code, a number with its unit, an emoji, a caption, an unmarked line — with nothing stored and nothing said before it in the window: the guess leans on nothing, and the reply is his (fix pass 7, the check #4 — the stated trade)'],
  ['lg299', 'a FIRST message that says no language — a code, a number with its unit, an emoji, a caption, an unmarked line — with nothing stored and nothing said before it in the window: the guess leans on nothing, and the reply is his (fix pass 7, the check #4 — the stated trade)'],
  ['lg300', 'a FIRST message that says no language — a code, a number with its unit, an emoji, a caption, an unmarked line — with nothing stored and nothing said before it in the window: the guess leans on nothing, and the reply is his (fix pass 7, the check #4 — the stated trade)'],
  ['lg378', 'a FIRST message that says no language — a code, a number with its unit, an emoji, a caption, an unmarked line — with nothing stored and nothing said before it in the window: the guess leans on nothing, and the reply is his (fix pass 7, the check #4 — the stated trade)'],

  // ── avia (fix pass 6) ───────────────────────────────────────────────────────────────────────────────────────────
  // A statement naming a Chinese place holds, whatever its verb (the hunt #1): «Ваш груз на складе в Иу» cannot be told
  // from «Ждём ваш груз на складе в Гуанчжоу» or «Отправка груза — в наш офис в Иу» without reading Russian's cases.
  ['av242', 'a statement naming a Chinese place holds: the rule cannot tell where the cargo IS from where it is to GO'],

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
