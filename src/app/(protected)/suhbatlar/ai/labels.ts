import type { PriceRefusal } from '@/modules/wms/agent/calc-loop';
import type { AgentConfigRefusal } from '@/modules/wms/agent/config';
import type { DecideRefusal } from '@/modules/wms/agent/decide';
import type { KbRefusal } from '@/modules/wms/agent/kb';
import type { CancelRefusal } from '@/modules/wms/agent/web-thread';
import type { RetireRefusal } from '@/modules/wms/agent/web-kb';
import type { ClearRefusal } from '@/modules/wms/crm/account-guard';
import type { PauseKind } from '@/modules/wms/crm/telegram-guard';

/**
 * Every label `/suhbatlar/ai` builds from a value at RENDER time, as maps
 * typed by the unions they translate (review build-13 (2), #163): a key built
 * at runtime is invisible to `i18n-keys.test.ts`, and a missing one throws in
 * every locale. The compiler makes each map complete over its union, and
 * `tests/unit/agent-web-labels.test.ts` makes every value exist in all four
 * bundles under `agentAi`.
 */

export const AGENT_SECTIONS = ['kutilmoqda', 'savollar', 'bilimlar', 'sozlamalar'] as const;
export type AgentSection = (typeof AGENT_SECTIONS)[number];

export const SECTION_KEYS: Record<AgentSection, string> = {
  kutilmoqda: 'section.kutilmoqda',
  savollar: 'section.savollar',
  bilimlar: 'section.bilimlar',
  sozlamalar: 'section.sozlamalar',
};

export function sectionOf(raw: string | undefined): AgentSection {
  return (AGENT_SECTIONS as readonly string[]).includes(raw ?? '') ? (raw as AgentSection) : 'kutilmoqda';
}

/** Every refusal code an action on the page can return. */
export type AgentErrorCode =
  | DecideRefusal
  | AgentConfigRefusal
  | KbRefusal
  | ClearRefusal
  | CancelRefusal
  | RetireRefusal
  | PriceRefusal
  // `superseded` as the press found it (decide `redraftNewest`) — web-actions `SUPERSEDED_ERROR`.
  | 'superseded_no_draft'
  | 'superseded_edited'
  | 'superseded_edited_no_draft'
  | 'superseded_answered'
  | 'unknown';

export const ERROR_KEYS: Record<AgentErrorCode, string> = {
  // decideDraft / submitOwnText
  not_found: 'errors.not_found',
  not_account_holder: 'errors.not_account_holder',
  agent_off: 'errors.agent_off',
  not_live: 'errors.not_live',
  editing: 'errors.editing',
  stale_card: 'errors.stale_card',
  policy_block: 'errors.policy_block',
  listener_behind: 'errors.listener_behind',
  sending_disabled: 'errors.sending_disabled',
  superseded: 'errors.superseded',
  superseded_no_draft: 'errors.superseded_no_draft',
  superseded_edited: 'errors.superseded_edited',
  superseded_edited_no_draft: 'errors.superseded_edited_no_draft',
  superseded_answered: 'errors.superseded_answered',
  taken_over: 'errors.taken_over',
  budget_spent: 'errors.budget_spent',
  calc_not_queued: 'errors.calc_not_queued',
  calc_in_flight: 'errors.calc_in_flight',
  identity_changed: 'errors.identity_changed',
  window_closed: 'errors.window_closed',
  empty: 'errors.empty',
  // the config's writers
  not_ready: 'errors.not_ready',
  forbidden: 'errors.forbidden',
  auto_not_in_phase1: 'errors.auto_not_in_phase1',
  no_owner: 'errors.no_owner',
  session_not_confirmed: 'errors.session_not_confirmed',
  owner_not_connected: 'errors.owner_not_connected',
  turn_off_first: 'errors.turn_off_first',
  bad_value: 'errors.bad_value',
  // writeKbFact
  money: 'errors.money',
  money_context: 'errors.money_context',
  personal: 'errors.personal',
  too_long: 'errors.too_long',
  scope: 'errors.scope',
  // the pause clear, the cancel, the retire
  not_paused: 'errors.not_paused',
  too_late: 'errors.too_late',
  already_retired: 'errors.already_retired',
  // «💵 Narx yozaman» (calc-loop `priceDraftFromText`) — the bot's refusals,
  // in the page's words, so a price door here can never print a raw code.
  not_linked: 'errors.not_linked',
  bad_number: 'errors.bad_number',
  ambiguous_number: 'errors.ambiguous_number',
  editing_open: 'errors.editing_open',
  no_anchor: 'errors.no_anchor',
  recalculated: 'errors.recalculated',
  unknown: 'errors.unknown',
};

/** The key for any code an action returned — an unknown one reads «unknown», never the raw code. */
export function errorKey(code: string | undefined): string {
  return (ERROR_KEYS as Record<string, string>)[code ?? 'unknown'] ?? ERROR_KEYS.unknown;
}

export const PAUSE_KIND_KEYS: Record<PauseKind, string> = {
  peer_flood: 'pause.peer_flood',
  restricted: 'pause.restricted',
  frozen: 'pause.frozen',
  flood_repeat: 'pause.flood_repeat',
  blocks: 'pause.blocks',
};

/** The 0138 category CHECK, verbatim. */
export const CATEGORY_KEYS: Record<'greeting' | 'status' | 'faq' | 'qualification' | 'price' | 'complaint' | 'other', string> = {
  greeting: 'category.greeting',
  status: 'category.status',
  faq: 'category.faq',
  qualification: 'category.qualification',
  price: 'category.price',
  complaint: 'category.complaint',
  other: 'category.other',
};

export function categoryKey(category: string): string {
  return (CATEGORY_KEYS as Record<string, string>)[category] ?? CATEGORY_KEYS.other;
}

/** The 0138 kb scope and source CHECKs, verbatim. */
export const SCOPE_KEYS: Record<'general' | 'client' | 'lead', string> = {
  general: 'scope.general',
  client: 'scope.client',
  lead: 'scope.lead',
};

export const SOURCE_KEYS: Record<'owner' | 'site' | 'seed' | 'manual', string> = {
  owner: 'source.owner',
  site: 'source.site',
  seed: 'source.seed',
  manual: 'source.manual',
};

export function sourceKey(source: string): string {
  return (SOURCE_KEYS as Record<string, string>)[source] ?? SOURCE_KEYS.manual;
}
