import type { Metadata, Viewport } from 'next';
import { NextIntlClientProvider } from 'next-intl';
import { getLocale, getMessages } from 'next-intl/server';
import { readTheme } from '@/modules/platform/theme/theme';
import './globals.css';

export const metadata: Metadata = {
  title: 'GSR LOGISTICS',
  description: 'GSR LOGISTICS ERP — WMS',
  manifest: '/manifest.webmanifest',
  appleWebApp: {
    capable: true,
    title: 'GSR LOGISTICS',
    statusBarStyle: 'default',
  },
};

export const viewport: Viewport = {
  width: 'device-width',
  initialScale: 1,
  themeColor: '#b80000',
  // Without this, an installed-PWA iPhone reports safe-area-inset-bottom as 0
  // and every `pb-safe` (tab bar, sheets, the fixed action bars) falls back
  // to its 0.5rem floor — the composer sits ON the home indicator.
  viewportFit: 'cover',
};

export default async function RootLayout({ children }: { children: React.ReactNode }) {
  const locale = await getLocale();
  const messages = await getMessages();
  // Rendered server-side so a dark phone never flashes white first.
  const theme = await readTheme();

  return (
    <html lang={locale} data-theme={theme ?? undefined}>
      <body>
        <NextIntlClientProvider locale={locale} messages={messages}>
          {children}
        </NextIntlClientProvider>
      </body>
    </html>
  );
}
