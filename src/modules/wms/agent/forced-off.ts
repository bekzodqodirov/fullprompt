/**
 * Why the MACHINE switched the AI sotuvchi off by itself (config
 * `forceAgentOff`, crm account-alarm `agentOffFor`) — ONE closed list, PURE,
 * so every surface that names the last «off» says the reason that happened
 * (fix pass B, C10): a restriction, a second flood wait in a day, two blocks in
 * a week, Telegram's own service account. «Telegram akkaunti cheklandi» about a
 * customer's block sent him looking for a restriction that did not exist.
 *
 * The callers are typed by it, and the words are Records over it (auto-card
 * `AUTO_DISARM_WORDS`, the page's labels `AUTO_DISARM_KEYS`): a fifth reason is
 * a compile error in both until somebody words it. Nothing here reaches the
 * database — the page's client bundle reads it.
 */
export const FORCED_OFF_REASONS = ['account_paused', 'flood_repeat', 'blocks', 'telegram_notice'] as const;
export type ForcedOffReason = (typeof FORCED_OFF_REASONS)[number];

export function isForcedOffReason(raw: string): raw is ForcedOffReason {
  return (FORCED_OFF_REASONS as readonly string[]).includes(raw);
}

/**
 * The stored `disarm_reason` of a forced off, `forced: <reason>`, as its own
 * kind — `forced_blocks` — or plain `forced` for a tail no list knows (an old
 * row, a test's): said neutrally, never as a restriction.
 */
export function forcedKindOf(reason: string): `forced_${ForcedOffReason}` | 'forced' {
  const tail = reason.slice('forced:'.length).trim();
  return isForcedOffReason(tail) ? `forced_${tail}` : 'forced';
}
