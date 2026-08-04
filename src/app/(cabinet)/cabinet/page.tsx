import { CabinetApp } from '@/components/cabinet-app';

/**
 * The client's Mini App.
 *
 * Nothing is rendered on the server: the identity lives in the `initData`
 * Telegram hands to the BROWSER, so the page has to be a client component that
 * reads it and asks for the data with it. Server-rendering here would mean
 * either a session cookie (a second credential to keep) or trusting a client
 * id in a URL, which is the hole this whole design avoids.
 */
export const dynamic = 'force-dynamic';

export default function CabinetPage() {
  return <CabinetApp />;
}
