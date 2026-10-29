import { isAgentSource } from '@/modules/wms/crm/agent-source';
import type { DoorView } from './doors';

/**
 * The doors screen's rows, decided on the SERVER — what is printed AND what is
 * sent. `InboundDoors` is a client component, and Next serialises every prop
 * of one into the page's data: a key the screen only hid behind
 * `canManage` still reached every `crm.manage` holder's browser. Since the
 * agent's key also READS (/api/agent/*: HMACs of every client phone tail, and
 * nine digits are enumerable), that was the client phone book in the page
 * data of whoever the owner lets into the funnel settings (review, sec lens).
 * So the key leaves only for `admin.settings.manage`, and `on` says whether
 * the door is open to everybody else.
 */
export function doorViews(
  rows: { key: string; name: string; secret: string | null }[],
  o: { appUrl: string; botName: string | null; canManage: boolean },
): DoorView[] {
  return rows.map((door) => ({
    key: door.key,
    name: door.name,
    // The agent's door is a machine's: a person reaching it through the form
    // lands under «Sayt» (`formSourceKey`), through the bot under «Boshqa»
    // (`inboundSourceKey`), so a link that looks like a door to it would be
    // one that does not go there.
    formUrl: isAgentSource(door.key) ? null : `${o.appUrl}/ariza?manba=${door.key}`,
    // The bot's third door only exists once the bot has a name to link to.
    botUrl:
      o.botName && !isAgentSource(door.key)
        ? `https://t.me/${o.botName}?start=ad_${door.key}`
        : null,
    webhookUrl: `${o.appUrl}/api/leads/in/${door.key}`,
    on: Boolean(door.secret),
    machine: isAgentSource(door.key),
    secret: o.canManage ? door.secret : null,
    assignUrl: door.key === 'sayt' ? `${o.appUrl}/api/lead/assign` : null,
  }));
}
