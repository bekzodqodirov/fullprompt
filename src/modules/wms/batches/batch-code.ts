import { isCodeCandidate } from '../../platform/ai/route-text';
import { parseQuery } from '../search/query';

/**
 * What a truck may be CALLED — pure, so the rename form runs the very rules
 * the service runs and never asks a confirm about a name the server will
 * refuse. Its only imports are the two import-free modules that already
 * decide how a typed code is read (the staff bot's `isCodeCandidate`, ⌘K's
 * `parseQuery`), because the browser loads this file too
 * (tests/unit/batch-code-rules.test.ts pins that).
 */

/** Trimmed, inner spaces collapsed, uppercased — the stored spelling (as ever). */
export function normalizeBatchCode(raw: string): string {
  return raw.trim().replace(/\s+/g, ' ').toUpperCase();
}

/** Before departure: today's free rule, spaces and all. */
export const LOADING_CODE_MIN = 2;
export const LOADING_CODE_MAX = 40;

export function loadingCodeProblem(code: string): 'bad_code' | null {
  return code.length < LOADING_CODE_MIN || code.length > LOADING_CODE_MAX ? 'bad_code' : null;
}

export type RoadCodeProblem =
  | 'code_cyrillic'
  | 'code_chars'
  | 'code_length'
  | 'code_needs_letter'
  | 'code_needs_digit';

/**
 * On the road a name is only worth changing to one the staff bot RECOGNISES
 * as a code — «KA-77 qayerda» must reach the free lookup and never cost a
 * model call — so the accept rule IS the bot's (`isCodeCandidate`), not a
 * restatement of it. Nothing else is demanded: no letter-first clause, so a
 * plate like 01A777BA or a partner's number starting with digits works.
 *
 * What follows the accept is only the DIAGNOSIS, in the order a person most
 * likely meets it. A Cyrillic look-alike first: «КА-77» typed on a Russian
 * layout is pixel-identical to KA-77 and the input's `uppercase` hides it
 * further, so a generic sentence would leave them staring at a correct-
 * looking name. The last line fails closed if the bot's pattern ever grows a
 * clause this list does not name.
 */
export function roadCodeProblem(code: string): RoadCodeProblem | null {
  if (isCodeCandidate(code)) return null;
  if (/[Ѐ-ӿ]/.test(code)) return 'code_cyrillic';
  if (/[^A-Za-z0-9-]/.test(code)) return 'code_chars';
  if (code.length < 3 || code.length > 20) return 'code_length';
  if (!/[A-Za-z]/.test(code)) return 'code_needs_letter';
  if (!/\d/.test(code)) return 'code_needs_digit';
  return 'code_chars';
}

/** The browser's live warning: the one refusal nobody can see on screen. */
export function hasCyrillic(text: string): boolean {
  return /[Ѐ-ӿ]/.test(text);
}

export type CodeShape = 'lot' | 'client' | 'box' | 'crate';

function escapeRe(value: string): string {
  return value.replace(/[.*+?^${}()|[\]\\-]/g, '\\$&');
}

/**
 * A name shaped like something ELSE the system answers to — refused at BOTH
 * stages, because the bot answers box → crate → truck → client and ⌘K sends a
 * lot-shaped query to lots ONLY (search/service.ts), and no minting door
 * (a typed client code, `nextBoxCodes`, `nextCrateCode`) will ever ask the
 * reverse question:
 *  - lot (GS777-A): ⌘K would never find the truck by its own name;
 *  - client (letters then digits, ⌘K's own `clientCode`, or the LIVE
 *    `client_code_prefix` + digits — a prefix ending in a digit included,
 *    round 103): the next client minted with it would be hidden behind the
 *    truck in the bot, which is the bot's commonest lookup;
 *  - box (`{WH}{YY}-000000`) and crate (`CR-`): answered before the truck.
 * `clientPrefix` is null in the browser, which has no settings; the letters-
 * then-digits clause already covers every default prefix.
 */
export function codeShapeProblem(code: string, clientPrefix: string | null): CodeShape | null {
  const upper = code.toUpperCase();
  const parsed = parseQuery(upper);
  if (parsed.lot) return 'lot';
  if (parsed.clientCode) return 'client';
  const prefix = clientPrefix?.trim().toUpperCase();
  if (prefix && new RegExp(`^${escapeRe(prefix)}\\d+$`).test(upper)) return 'client';
  if (/^[A-Z0-9]+\d{2}-\d{6}$/.test(upper)) return 'box';
  if (upper.startsWith('CR-')) return 'crate';
  return null;
}
