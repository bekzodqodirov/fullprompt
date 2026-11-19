/**
 * The 🆕 «Yangi mijozga» tick as the person just pressed it, until the round
 * trip lands (review CUST-9) — pure and import-free, so the rule the box draws
 * is provable without a browser.
 *
 * A press is tied to the row's REVISION it was made against (`updated_at`),
 * never to the boolean (review W-2): every writer of the flag moves the
 * revision in the same statement (the tick, the share move that clears it), so
 * the success refresh, an unshare, a re-share and a colleague's write each
 * retire the press, while a refusal deletes it at once. Keyed on the boolean,
 * a press left over from a success came back to life the moment the server's
 * value returned to what it had been pressed against — the box showed TICKED
 * on a note the new-client card no longer carries.
 */
export interface FlagPress {
  want: boolean;
  /** The row's revision the press was made against. */
  at: string;
}

export function flagShown(note: { forNewClient: boolean; updatedAt: string }, press: FlagPress | undefined): boolean {
  return press && press.at === note.updatedAt ? press.want : note.forNewClient;
}
