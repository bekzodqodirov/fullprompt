import { INBOUND_SOURCE_KEYS } from '@/modules/wms/crm/inbound';
import { ArizaForm } from './form';

/**
 * The page an advert points at (owner: «biz endi qanday qilib CRMni instagram
 * va boshqa platformalarga ulaymiz»).
 *
 * The second of the three doors, and the one that needs nothing from anybody
 * else: a Meta lead form has to be approved, connected and kept connected, and
 * the bot needs a chat — this is a link that works the minute it is deployed
 * and works for a channel we have never heard of. `?manba=instagram` names the
 * source; anything unrecognised is recorded and lands under «Boshqa», because
 * a URL parameter that could invent dictionary rows is a way for a stranger to
 * fill the owner's funnel settings with junk (#183).
 *
 * Uzbek and Russian on one line, no switcher — the driver page's decision, for
 * the same reason: one screen, read once, by somebody who will not come back
 * to hunt for a flag icon.
 */

export const dynamic = 'force-dynamic';

export const metadata = {
  title: 'GSR LOGISTICS — ariza',
  description: 'Xitoydan yuk tashish · Доставка грузов из Китая',
};

export default async function ArizaPage({
  searchParams,
}: {
  searchParams: Promise<Record<string, string | string[] | undefined>>;
}) {
  const params = await searchParams;
  const one = (key: string) => {
    const value = params[key];
    return (Array.isArray(value) ? value[0] : value) ?? '';
  };

  const asked = one('manba').toLowerCase();
  const source = (INBOUND_SOURCE_KEYS as readonly string[]).includes(asked) ? asked : 'sayt';

  const utm: Record<string, string> = {};
  for (const key of ['utm_source', 'utm_medium', 'utm_campaign', 'utm_content']) {
    const value = one(key);
    if (value) utm[key] = value.slice(0, 120);
  }

  return (
    <main className="mx-auto flex max-w-md flex-col gap-4 p-5">
      <header className="space-y-1 text-center">
        <h1 className="text-2xl font-bold">GSR LOGISTICS</h1>
        <p className="text-sm text-ink-500">
          Xitoydan O‘zbekistonga yuk tashish
          <br />
          Доставка грузов из Китая в Узбекистан
        </p>
      </header>

      <p className="text-center text-sm">
        Raqamingizni qoldiring — narxini hisoblab, o‘zimiz qo‘ng‘iroq qilamiz.
        <br />
        <span className="text-ink-500">
          Оставьте номер — рассчитаем стоимость и перезвоним сами.
        </span>
      </p>

      <ArizaForm source={source} utm={utm} />
    </main>
  );
}
