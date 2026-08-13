/**
 * Whose cargo a row is, said the way the BOX says it.
 *
 * Cargo received unclaimed carries a hand-written marking (`GS500MANIKEN-AL`),
 * and that marking stays on the carton after the client is found — so every
 * screen a warehouse worker reads against a physical box must lead with the
 * marking and show the claimed client's code small beneath it (round 98).
 * The stock table and the label sheet already did; the plan, loading and
 * unload screens each had their own inline `clientCode ?? marking` — the
 * OPPOSITE precedence, which is exactly what the owner reported: «skladda
 * korinyabti lekin plan berishda unday korinmayabti». One rule, stated once.
 */
export interface CodeIdentity {
  /** What the box physically says — the big mono code. */
  main: string;
  /** The claimed client's code, shown small, when the box says something else. */
  sub: string | null;
}

export function codeIdentity(
  marking: string | null | undefined,
  clientCode: string | null | undefined,
): CodeIdentity {
  return {
    main: marking ?? clientCode ?? '❓',
    sub: marking && clientCode ? clientCode : null,
  };
}
