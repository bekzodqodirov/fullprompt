/**
 * Which words inside a staff message might be a CODE the free lookup can
 * answer — «GS777 qayerda» must never cost a model call when `botLookup`
 * answers «GS777» for nothing (the review's finding: the owner's own example
 * staff questions were about to become slower and paid).
 *
 * A candidate is a token carrying both a letter and a digit — GS777,
 * YW26-000123, CR-12, a batch code — which is what no ordinary Uzbek word
 * does. Pure, so the routing is testable by table.
 */

const CANDIDATE = /^(?=.*[A-Za-z])(?=.*\d)[A-Za-z0-9-]{3,20}$/;
const MAX_CANDIDATES = 3;

/**
 * One token, asked the bot's own question. Exported because a truck renamed
 * on the road must be a name the bot RECOGNISES as a code
 * (`batches/batch-code.ts` `roadCodeProblem`) — its accept rule is this
 * function, never a restatement of the pattern beside it (#513).
 */
export function isCodeCandidate(token: string): boolean {
  return CANDIDATE.test(token);
}

export function codeCandidates(text: string): string[] {
  const seen = new Set<string>();
  for (const token of text.split(/\s+/)) {
    const clean = token.replace(/[.,!?:;()«»"']/g, '');
    if (isCodeCandidate(clean)) seen.add(clean.toUpperCase());
    if (seen.size >= MAX_CANDIDATES) break;
  }
  return [...seen];
}
