import { splitTags } from '../clients/service';
import { audienceSchema, type Audience } from './service';

type Params = Record<string, string | string[] | undefined>;

const list = (value: string | string[] | undefined) =>
  (Array.isArray(value) ? value : value ? [value] : []).map((v) => v.trim()).filter(Boolean);

/**
 * The broadcast page's audience, read back out of its address bar (`/admin/xabarlar`). Every value is validated
 * (#514): a garbage manager id or language is dropped, never a 500 — and a URL the schema refuses as a whole (a code
 * longer than a code, a hand-edited manager) falls back to every linked chat, as it always has.
 *
 * Except the «Sotuvchisi yo'q mijozlar» tick (stage 1a «Hajm», his 7 b): it is the fence that keeps the one message
 * naming the AI's number away from a seller's own customers (J13), so it survives the fallback — a typo in the codes
 * box widens the audience to every chat no seller answers, never to every seller's customer.
 */
export function audienceFromUrl(params: Params): Audience {
  // Only the tick's own value means yes — anything else is «not asked».
  const noManager = params.sotuvchisiz === '1' ? true : undefined;
  const parsed = audienceSchema.safeParse({
    sectors: list(params.soha),
    cargoKinds: list(params.yuk),
    locales: list(params.til).filter((v) => ['uz', 'ru', 'en'].includes(v)),
    managerId: typeof params.hodim === 'string' && params.hodim ? params.hodim : undefined,
    codes: splitTags(typeof params.kod === 'string' ? params.kod : ''),
    query: typeof params.q === 'string' && params.q.trim() ? params.q.trim().slice(0, 100) : undefined,
    noManager,
  });
  if (parsed.success) return parsed.data;
  return { sectors: [], cargoKinds: [], locales: [], codes: [], ...(noManager ? { noManager } : {}) };
}
