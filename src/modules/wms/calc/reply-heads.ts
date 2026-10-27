/**
 * The first characters of every message the machine writes about a
 * calculation, and of the VED's line inside one (docs/SAKKIZ-R2.md K3).
 *
 * A leaf with no imports, because these strings have two kinds of reader: the
 * module that WRITES the reply, and the lenta chip that RECOGNISES a machine
 * note by how it starts (round 2's P4). A heading spelled in one file and
 * matched in another drifts the day somebody rewords it, and the chip then
 * says nothing about a note it used to name (#513).
 */

/** The customs (and podklyuch) reply — `aiVedReplyText`'s heading. */
export const AI_REPLY_HEAD = '🤖 AI-VED';
/** The yolkira reply — answered from the tariff table, no model (his 2.5 b). */
export const TARIFF_REPLY_HEAD = '🧮 Yo‘lkira';

export type MachineReplyKind = 'ai' | 'tariff';

/** Keyed by kind, so a third kind with no heading is a compile error. */
export const MACHINE_REPLY_HEADS: Readonly<Record<MachineReplyKind, string>> = {
  ai: AI_REPLY_HEAD,
  tariff: TARIFF_REPLY_HEAD,
};

/** The first characters of the lenta's VED line (§2.6) — written by P1, read by P4's chip. */
export const VED_ESTIMATE_MARK = '🔎 VED uchun:';
