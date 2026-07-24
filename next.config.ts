import type { NextConfig } from 'next';
import createNextIntlPlugin from 'next-intl/plugin';
import withSerwistInit from '@serwist/next';

const withNextIntl = createNextIntlPlugin('./src/modules/platform/i18n/request.ts');

const withSerwist = withSerwistInit({
  swSrc: 'src/app/sw.ts',
  swDest: 'public/sw.js',
  disable: process.env.NODE_ENV === 'development',
});

// Native/node-only packages that must never enter a webpack bundle.
// `serverExternalPackages` covers most cases, but the dev-mode
// instrumentation compile ignores it, so they are ALSO added as explicit
// webpack externals for server bundles below.
const NODE_ONLY_PACKAGES = [
  'pg-boss',
  'sharp',
  'pino',
  '@node-rs/argon2',
  'postgres',
  'pg',
  'pg-native',
  'grammy',
  // Loads a wasm binary (harfbuzz) — webpack must not try to parse it.
  'subset-font',
  'harfbuzzjs',
];

const nextConfig: NextConfig = {
  output: 'standalone',
  serverExternalPackages: NODE_ONLY_PACKAGES,
  webpack: (config, { isServer }) => {
    if (isServer) {
      config.externals = [
        ...(Array.isArray(config.externals) ? config.externals : [config.externals]),
        ...NODE_ONLY_PACKAGES.map((pkg) => ({ [pkg]: `commonjs ${pkg}` })),
      ];
    }
    return config;
  },
  images: {
    // All images come from our own storage via signed URLs; no external hosts.
    remotePatterns: [],
  },
};

export default withSerwist(withNextIntl(nextConfig));
