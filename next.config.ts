import type { NextConfig } from 'next';
import createNextIntlPlugin from 'next-intl/plugin';
import withSerwistInit from '@serwist/next';

const withNextIntl = createNextIntlPlugin('./src/modules/platform/i18n/request.ts');

const withSerwist = withSerwistInit({
  swSrc: 'src/app/sw.ts',
  swDest: 'public/sw.js',
  disable: process.env.NODE_ENV === 'development',
});

const nextConfig: NextConfig = {
  output: 'standalone',
  serverExternalPackages: ['pg-boss', 'sharp', 'pino', '@node-rs/argon2', 'postgres'],
  images: {
    // All images come from our own storage via signed URLs; no external hosts.
    remotePatterns: [],
  },
};

export default withSerwist(withNextIntl(nextConfig));
